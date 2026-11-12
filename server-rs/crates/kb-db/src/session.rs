//! A unit of work on the database, with the transaction rules the Python server had.
//!
//! SQLAlchemy's session over the SQLite driver reads without a transaction and opens one at the first statement
//! that writes; everything after that, reads included, runs inside it until `commit` or `rollback`. `Session` does
//! the same on every engine: a read before the first write goes straight to the pool, the first write begins a
//! transaction (so a writer waits for SQLite's write lock instead of failing on a stale read snapshot), and dropping
//! a session with an open transaction rolls it back.
//!
//! On PostgreSQL and MySQL a commit that wrote something also adds one row to the change log, in the same
//! transaction, which is how the board hears about changes another process made (`changes`).

use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, DbErr, EntityTrait, ExecResult,
    PrimaryKeyTrait, QueryResult, QuerySelect, Statement, TransactionTrait,
};
use tokio::sync::Mutex;

use crate::changes;

/// `async with async_session() as session`.
pub struct Session {
    conn: DatabaseConnection,
    txn: Mutex<Option<DatabaseTransaction>>,
    wrote: AtomicBool,
    memo: StdMutex<HashMap<String, Arc<dyn Any + Send + Sync>>>,
}

/// Whether a statement only reads (it does not need a transaction of its own).
fn reads_only(sql: &str) -> bool {
    let head = sql.trim_start().trim_start_matches('(').trim_start();
    let word: String = head.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_uppercase();
    match word.as_str() {
        "SELECT" | "VALUES" | "EXPLAIN" | "SHOW" | "DESCRIBE" => true,
        // a PRAGMA that sets something still needs no transaction
        "PRAGMA" => true,
        // WITH ... SELECT reads; WITH ... INSERT/UPDATE/DELETE writes
        "WITH" => {
            let upper = head.to_ascii_uppercase();
            !(upper.contains("INSERT ") || upper.contains("UPDATE ") || upper.contains("DELETE "))
        }
        _ => false,
    }
}

impl Session {
    /// A session on `conn` (use `kb_db::session()` for the database in use).
    pub fn new(conn: DatabaseConnection) -> Self {
        Self { conn, txn: Mutex::new(None), wrote: AtomicBool::new(false), memo: StdMutex::new(HashMap::new()) }
    }

    /// The pool this session runs on.
    pub fn connection(&self) -> &DatabaseConnection {
        &self.conn
    }

    /// Whether this session runs on a SQLite file.
    pub fn is_sqlite(&self) -> bool {
        self.conn.get_database_backend() == DbBackend::Sqlite
    }

    /// The engine as the Python code names it: "sqlite", "postgresql" or "mysql".
    pub fn dialect(&self) -> &'static str {
        dialect_name(self.conn.get_database_backend())
    }

    /// `await session.commit()`: make what this session wrote permanent. A session that wrote nothing does nothing.
    pub async fn commit(&self) -> Result<(), DbErr> {
        self.forget();
        let txn = self.txn.lock().await.take();
        let wrote = self.wrote.swap(false, Ordering::SeqCst);
        if let Some(txn) = txn {
            if wrote && txn.get_database_backend() != DbBackend::Sqlite {
                changes::mark(&txn).await?;
            }
            txn.commit().await?;
        }
        Ok(())
    }

    /// `await session.rollback()`: undo what this session wrote since the last commit.
    pub async fn rollback(&self) -> Result<(), DbErr> {
        self.forget();
        let txn = self.txn.lock().await.take();
        self.wrote.store(false, Ordering::SeqCst);
        if let Some(txn) = txn {
            txn.rollback().await?;
        }
        Ok(())
    }

    /// What a caller keeps in the session's `info` (SQLAlchemy's `session.info`): an answer that is the same until the
    /// session writes, a commit or a rollback, after which it is read again. `None` when nothing is kept under `key`.
    pub fn memo_get<T: Any + Send + Sync>(&self, key: &str) -> Option<Arc<T>> {
        let kept = self.memo.lock().ok()?.get(key).cloned()?;
        kept.downcast::<T>().ok()
    }

    /// Keep `value` under `key` until the session writes, commits or rolls back (see `memo_get`).
    pub fn memo_set<T: Any + Send + Sync>(&self, key: &str, value: T) -> Arc<T> {
        let kept = Arc::new(value);
        if let Ok(mut memo) = self.memo.lock() {
            memo.insert(key.to_string(), kept.clone());
        }
        kept
    }

    /// Drop everything kept with `memo_set`.
    fn forget(&self) {
        if let Ok(mut memo) = self.memo.lock() {
            memo.clear();
        }
    }

    /// A statement that writes is about to run: what was read before is no longer known to be current.
    fn wrote_something(&self) {
        self.wrote.store(true, Ordering::SeqCst);
        self.forget();
    }

    /// Whether a transaction is open (something was written and not yet committed).
    pub async fn in_transaction(&self) -> bool {
        self.txn.lock().await.is_some()
    }

    /// Open the transaction now, before the first write (to read and then write under one lock).
    pub async fn begin(&self) -> Result<(), DbErr> {
        let mut guard = self.txn.lock().await;
        if guard.is_none() {
            *guard = Some(self.conn.begin().await?);
        }
        Ok(())
    }

    /// A row, read after the database's write lock is taken, for a change of it (`tickets._for_edit`).
    ///
    /// A row that keeps lists as JSON text is changed by rewriting the whole list: two writers that read the row
    /// before either wrote would each write their list and the second would drop what the first added. Taking the
    /// lock first puts them in line, so the second reads the row once the first has committed. SQLite: the database's
    /// write lock (the equivalent of `BEGIN IMMEDIATE`; skipped when this transaction has written already, as it
    /// holds the lock). PostgreSQL and MySQL: `SELECT ... FOR UPDATE`, which reads the row afresh whatever this
    /// transaction read before. The transaction stays open until `commit` / `rollback`; on SQLite it is closed
    /// again when the row does not exist, so that the next writer can come in.
    pub async fn read_for_edit<E, K>(&self, id: K) -> Result<Option<E::Model>, DbErr>
    where
        E: EntityTrait,
        K: Into<<E::PrimaryKey as PrimaryKeyTrait>::ValueType>,
    {
        if self.is_sqlite() {
            let mut began = false;
            {
                let mut guard = self.txn.lock().await;
                if guard.is_none() {
                    *guard = Some(self.conn.begin().await?);
                    began = true;
                }
                if began || !self.wrote.load(Ordering::SeqCst) {
                    // `BEGIN IMMEDIATE` cannot follow the driver's own `BEGIN`: a statement that writes nothing
                    // takes the same lock (SQLite waits for it, up to the busy timeout).
                    let table = E::default().table_name().to_owned();
                    if let Some(txn) = guard.as_ref() {
                        txn.execute_unprepared(&format!("DELETE FROM \"{table}\" WHERE 0")).await?;
                    }
                }
            }
            let found = E::find_by_id(id).one(self).await?;
            if found.is_none() && began {
                self.rollback().await?;
            }
            return Ok(found);
        }
        self.begin().await?;
        E::find_by_id(id).lock_exclusive().one(self).await
    }

    /// `async with session.begin_nested():` run `work` in a savepoint of this session's transaction (which it opens
    /// if needed). When `work` fails, what it wrote is undone and the rest of the transaction is kept; when it
    /// succeeds, its writes join the transaction. The error of `work` is given back either way.
    pub async fn nested<T, E, F>(&self, work: F) -> Result<Result<T, E>, DbErr>
    where
        F: std::future::Future<Output = Result<T, E>>,
    {
        let name = format!("kb_sp_{}", NEXT_SAVEPOINT.fetch_add(1, Ordering::SeqCst));
        self.savepoint_statement(&format!("SAVEPOINT {name}")).await?;
        let outcome = work.await;
        match &outcome {
            Ok(_) => self.savepoint_statement(&format!("RELEASE SAVEPOINT {name}")).await?,
            Err(_) => self.savepoint_statement(&format!("ROLLBACK TO SAVEPOINT {name}")).await?,
        }
        Ok(outcome)
    }

    /// A statement about a savepoint, in the transaction (opened if needed) and without counting as a write.
    async fn savepoint_statement(&self, sql: &str) -> Result<(), DbErr> {
        let mut guard = self.txn.lock().await;
        if guard.is_none() {
            *guard = Some(self.conn.begin().await?);
        }
        match guard.as_ref() {
            Some(txn) => txn.execute_unprepared(sql).await.map(|_| ()),
            None => Ok(()),
        }
    }
}

/// The number of the next savepoint (names are unique within the process, so nested ones never collide).
static NEXT_SAVEPOINT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The engine as the Python code names it.
pub fn dialect_name(backend: DbBackend) -> &'static str {
    match backend {
        DbBackend::Sqlite => "sqlite",
        DbBackend::Postgres => "postgresql",
        DbBackend::MySql => "mysql",
        _ => "sqlite",
    }
}

#[async_trait::async_trait]
impl ConnectionTrait for Session {
    fn get_database_backend(&self) -> DbBackend {
        self.conn.get_database_backend()
    }

    async fn execute_raw(&self, stmt: Statement) -> Result<ExecResult, DbErr> {
        let mut guard = self.txn.lock().await;
        if reads_only(&stmt.sql) {
            return match guard.as_ref() {
                Some(txn) => txn.execute_raw(stmt).await,
                None => self.conn.execute_raw(stmt).await,
            };
        }
        if guard.is_none() {
            *guard = Some(self.conn.begin().await?);
        }
        self.wrote_something();
        match guard.as_ref() {
            Some(txn) => txn.execute_raw(stmt).await,
            None => self.conn.execute_raw(stmt).await,
        }
    }

    async fn execute_unprepared(&self, sql: &str) -> Result<ExecResult, DbErr> {
        let mut guard = self.txn.lock().await;
        if reads_only(sql) {
            return match guard.as_ref() {
                Some(txn) => txn.execute_unprepared(sql).await,
                None => self.conn.execute_unprepared(sql).await,
            };
        }
        if guard.is_none() {
            *guard = Some(self.conn.begin().await?);
        }
        self.wrote_something();
        match guard.as_ref() {
            Some(txn) => txn.execute_unprepared(sql).await,
            None => self.conn.execute_unprepared(sql).await,
        }
    }

    async fn query_one_raw(&self, stmt: Statement) -> Result<Option<QueryResult>, DbErr> {
        let mut guard = self.txn.lock().await;
        if !reads_only(&stmt.sql) {
            // INSERT / UPDATE / DELETE ... RETURNING
            if guard.is_none() {
                *guard = Some(self.conn.begin().await?);
            }
            self.wrote_something();
        }
        match guard.as_ref() {
            Some(txn) => txn.query_one_raw(stmt).await,
            None => self.conn.query_one_raw(stmt).await,
        }
    }

    async fn query_all_raw(&self, stmt: Statement) -> Result<Vec<QueryResult>, DbErr> {
        let mut guard = self.txn.lock().await;
        if !reads_only(&stmt.sql) {
            if guard.is_none() {
                *guard = Some(self.conn.begin().await?);
            }
            self.wrote_something();
        }
        match guard.as_ref() {
            Some(txn) => txn.query_all_raw(stmt).await,
            None => self.conn.query_all_raw(stmt).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::reads_only;

    #[test]
    fn tells_reads_from_writes() {
        assert!(reads_only("SELECT 1"));
        assert!(reads_only("  select * from t"));
        assert!(reads_only("PRAGMA data_version"));
        assert!(reads_only("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!reads_only("INSERT INTO t VALUES (1) RETURNING id"));
        assert!(!reads_only("UPDATE t SET a = 1"));
        assert!(!reads_only("DELETE FROM t"));
        assert!(!reads_only("CREATE TABLE t (a)"));
        assert!(!reads_only("WITH x AS (SELECT 1) DELETE FROM t"));
    }
}
