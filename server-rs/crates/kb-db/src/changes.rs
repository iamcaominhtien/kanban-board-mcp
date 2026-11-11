//! How the board hears about changes another process made, on PostgreSQL and MySQL.
//!
//! On SQLite the board reads `PRAGMA data_version` (`database::watch_database`). A server database has nothing like
//! it, so every write transaction of every app process adds one row to `kanban_change` (in the same transaction, so
//! it is there exactly when the change is): who wrote. The board polls the newest row written by another process,
//! which is an index lookup on a table kept to about a thousand rows. Appending, rather than bumping one counter
//! row, means two writers never wait on each other's lock.
//!
//! The table is not one of the entities: it is not data, it is not copied or exported, and SQLite never has it.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, Statement, TransactionTrait};

use crate::targets;

pub const TABLE: &str = "kanban_change";
pub const KEEP_ROWS: i64 = 1000;

fn origin() -> String {
    targets::PROCESS_TOKEN.chars().take(32).collect()
}

/// Make the table when it is missing (server databases only).
pub async fn create<C: ConnectionTrait>(conn: &C) -> Result<(), DbErr> {
    let sql = match conn.get_database_backend() {
        DbBackend::Postgres => {
            "CREATE TABLE IF NOT EXISTS kanban_change (id BIGSERIAL NOT NULL, origin VARCHAR(32) NOT NULL, \
             at FLOAT NOT NULL, PRIMARY KEY (id))"
        }
        DbBackend::MySql => {
            "CREATE TABLE IF NOT EXISTS kanban_change (id BIGINT NOT NULL AUTO_INCREMENT, origin VARCHAR(32) NOT NULL, \
             at FLOAT NOT NULL, PRIMARY KEY (id))"
        }
        _ => return Ok(()),
    };
    conn.execute_unprepared(sql).await.map(|_| ())
}

/// Note, inside the transaction that is about to commit, that this process wrote.
pub async fn mark<C: ConnectionTrait>(conn: &C) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let sql = match backend {
        DbBackend::Postgres => "INSERT INTO kanban_change (origin, at) VALUES ($1, $2)",
        DbBackend::MySql => "INSERT INTO kanban_change (origin, at) VALUES (?, ?)",
        _ => return Ok(()),
    };
    conn.execute_raw(Statement::from_sql_and_values(
        backend,
        sql,
        [origin().into(), kb_base::time::epoch().into()],
    ))
    .await
    .map(|_| ())
}

/// The id of the newest change another process wrote (0 when none).
pub async fn latest_from_others<C: ConnectionTrait>(conn: &C) -> Result<i64, DbErr> {
    let backend = conn.get_database_backend();
    let sql = match backend {
        DbBackend::Postgres => "SELECT max(id) AS newest FROM kanban_change WHERE origin != $1",
        _ => "SELECT max(id) AS newest FROM kanban_change WHERE origin != ?",
    };
    let row = conn
        .query_one_raw(Statement::from_sql_and_values(
            backend,
            sql,
            [origin().into()],
        ))
        .await?;
    Ok(row
        .and_then(|r| r.try_get::<Option<i64>>("", "newest").ok().flatten())
        .unwrap_or(0))
}

/// Keep only the newest rows; nobody reads further back.
pub async fn trim(conn: &DatabaseConnection) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let txn = conn.begin().await?;
    let row = txn
        .query_one_raw(Statement::from_string(
            backend,
            "SELECT max(id) AS newest FROM kanban_change",
        ))
        .await?;
    let newest = row
        .and_then(|r| r.try_get::<Option<i64>>("", "newest").ok().flatten())
        .unwrap_or(0);
    if newest != 0 {
        let sql = match backend {
            DbBackend::Postgres => "DELETE FROM kanban_change WHERE id < $1",
            _ => "DELETE FROM kanban_change WHERE id < ?",
        };
        txn.execute_raw(Statement::from_sql_and_values(
            backend,
            sql,
            [(newest - KEEP_ROWS).into()],
        ))
        .await?;
    }
    txn.commit().await
}
