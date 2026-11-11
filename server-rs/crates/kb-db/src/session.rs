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

use std::sync::atomic::{AtomicBool, Ordering};

use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, DbErr, ExecResult,
    QueryResult, Statement, TransactionTrait,
};
use tokio::sync::Mutex;

use crate::changes;

/// `async with async_session() as session`.
pub struct Session {
    conn: DatabaseConnection,
    txn: Mutex<Option<DatabaseTransaction>>,
    wrote: AtomicBool,
}

/// Whether a statement only reads (it does not need a transaction of its own).
fn reads_only(sql: &str) -> bool {
    let head = sql.trim_start().trim_start_matches('(').trim_start();
    let word: String = head
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
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
        Self {
            conn,
            txn: Mutex::new(None),
            wrote: AtomicBool::new(false),
        }
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
        let txn = self.txn.lock().await.take();
        self.wrote.store(false, Ordering::SeqCst);
        if let Some(txn) = txn {
            txn.rollback().await?;
        }
        Ok(())
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
}

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
        self.wrote.store(true, Ordering::SeqCst);
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
        self.wrote.store(true, Ordering::SeqCst);
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
            self.wrote.store(true, Ordering::SeqCst);
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
            self.wrote.store(true, Ordering::SeqCst);
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
