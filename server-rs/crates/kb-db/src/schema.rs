//! The schema: what a database holds, making the tables on an empty one, and which migrations this app knows.
//!
//! The schema is the one the Python server's Alembic chain left at its head, kept as SQL per engine in `schema/`.
//! The database stays stamped in `alembic_version` with the same revision ids, so a database can go back to a 4.x
//! app, and the migration runner continues the same chain.

use std::sync::LazyLock;

use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};

use crate::{changes, sql};

const SQLITE_SCHEMA: &str = include_str!("../schema/sqlite.sql");
const POSTGRES_SCHEMA: &str = include_str!("../schema/postgres.sql");
const MYSQL_SCHEMA: &str = include_str!("../schema/mysql.sql");
const REVISIONS: &str = include_str!("../schema/revisions.txt");

/// One migration of the chain: its id and the ids it follows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub id: &'static str,
    pub down: Vec<&'static str>,
    pub file: &'static str,
}

/// Every migration this app knows, oldest first.
pub static CHAIN: LazyLock<Vec<Revision>> = LazyLock::new(|| {
    REVISIONS
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.split_whitespace();
            let id = parts.next().unwrap_or("");
            let down = parts.next().unwrap_or("-");
            let file = parts.next().unwrap_or("");
            Revision {
                id,
                down: if down == "-" {
                    Vec::new()
                } else {
                    down.split(',').collect()
                },
                file,
            }
        })
        .collect()
});

/// Databases made by pre-release builds are stamped with a migration that was later removed from the chain. Each
/// such revision maps to the nearest revision that still exists, which has the same schema minus what the removed
/// one added (extra, unused columns are harmless).
pub const LEGACY_REVISIONS: [(&str, &str); 1] = [
    // "add_idea_board_fields" (April 2026 baseline) added board/idea_* columns to ticket; Idea Space moved to its
    // own idea_ticket table (f1a2b3c4d5e6), whose parent is this one.
    ("f6a7b8c9d0e1", "1e1bb4aa5fa4"),
];

/// The newest migration this app knows.
pub fn head_revision() -> &'static str {
    CHAIN.last().map(|r| r.id).unwrap_or("")
}

/// Whether this app knows the migration `rev` (a database stamped with one it does not was made by a newer app).
pub fn known_revision(rev: &str) -> bool {
    CHAIN.iter().any(|r| r.id == rev) || LEGACY_REVISIONS.iter().any(|(old, _)| *old == rev)
}

/// What a database holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaState {
    /// "empty" | "board" | "foreign".
    pub state: &'static str,
    pub revision: Option<String>,
    /// Number of tables (app tables only for "board": the change log and `alembic_version` are left out).
    pub tables: usize,
}

/// The tables of the database in use (base tables; on SQLite the FTS tables and their shadow tables too, as
/// SQLAlchemy's inspector lists them).
pub async fn table_names<C: ConnectionTrait>(conn: &C) -> Result<Vec<String>, DbErr> {
    let backend = conn.get_database_backend();
    let query = match backend {
        DbBackend::Postgres => {
            "SELECT table_name AS name FROM information_schema.tables \
             WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
        }
        DbBackend::MySql => {
            "SELECT table_name AS name FROM information_schema.tables \
             WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"
        }
        _ => "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    };
    let rows = conn
        .query_all_raw(Statement::from_string(backend, query))
        .await?;
    let mut names = Vec::with_capacity(rows.len());
    for row in rows {
        names.push(row.try_get::<String>("", "name")?);
    }
    Ok(names)
}

/// Whether a table exists.
pub async fn has_table<C: ConnectionTrait>(conn: &C, name: &str) -> Result<bool, DbErr> {
    Ok(table_names(conn).await?.iter().any(|n| n == name))
}

/// The revisions the database is stamped with (normally one).
pub async fn current_revisions<C: ConnectionTrait>(conn: &C) -> Result<Vec<String>, DbErr> {
    let backend = conn.get_database_backend();
    let rows = conn
        .query_all_raw(Statement::from_string(
            backend,
            "SELECT version_num FROM alembic_version",
        ))
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(row.try_get::<String>("", "version_num")?);
    }
    Ok(out)
}

/// What a database holds: `{"state": "empty" | "board" | "foreign", "revision", "tables"}`.
pub async fn schema_state<C: ConnectionTrait>(conn: &C) -> Result<SchemaState, DbErr> {
    let mut names = table_names(conn).await?;
    names.retain(|n| n != changes::TABLE);
    if names.is_empty() {
        return Ok(SchemaState {
            state: "empty",
            revision: None,
            tables: 0,
        });
    }
    if !names.iter().any(|n| n == "alembic_version") {
        return Ok(SchemaState {
            state: "foreign",
            revision: None,
            tables: names.len(),
        });
    }
    let revision = current_revisions(conn).await?.into_iter().next();
    Ok(SchemaState {
        state: "board",
        revision,
        tables: names.len() - 1,
    })
}

fn statements(schema: &'static str) -> impl Iterator<Item = &'static str> {
    schema
        .split(";\n\n")
        .map(|chunk| chunk.trim().trim_end_matches(';').trim())
        .filter(|chunk| {
            // a chunk that is only comment lines is the file's header
            chunk
                .lines()
                .any(|line| !line.trim().is_empty() && !line.trim_start().starts_with("--"))
        })
}

/// Make the app's tables on an empty database and stamp it at the newest migration. Links between tables are not
/// enforced by the database on any engine.
pub async fn create_schema<C: ConnectionTrait>(conn: &C) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let schema = match backend {
        DbBackend::Postgres => POSTGRES_SCHEMA,
        DbBackend::MySql => MYSQL_SCHEMA,
        _ => SQLITE_SCHEMA,
    };
    let mut has_version_table = false;
    for statement in statements(schema) {
        // the comment line above the first statement of a file
        let statement: String = statement
            .lines()
            .filter(|line| !line.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");
        if statement.contains("alembic_version") {
            has_version_table = true;
        }
        conn.execute_unprepared(&statement).await?;
    }
    if !has_version_table {
        conn.execute_unprepared(
            "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, \
             CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))",
        )
        .await?;
    }
    if backend == DbBackend::Sqlite {
        // the SQLite chain made this row in a migration; on a server database it is made on first use
        conn.execute_unprepared("INSERT INTO idea_counter (id, counter) VALUES (1, 0)")
            .await?;
    } else {
        changes::create(conn).await?;
    }
    conn.execute_raw(sql::statement(
        backend,
        "INSERT INTO alembic_version (version_num) VALUES (?)",
        [head_revision().into()],
    ))
    .await?;
    Ok(())
}

/// Re-stamp a database left by a pre-release build (`LEGACY_REVISIONS`).
pub async fn restamp_legacy_revision<C: ConnectionTrait>(conn: &C) -> Result<(), DbErr> {
    if !has_table(conn, "alembic_version").await? {
        return Ok(());
    }
    let backend = conn.get_database_backend();
    let current = current_revisions(conn).await?;
    for (old, new) in LEGACY_REVISIONS {
        if current.iter().any(|c| c == old) {
            conn.execute_raw(sql::statement(
                backend,
                "UPDATE alembic_version SET version_num = ? WHERE version_num = ?",
                [new.into(), old.into()],
            ))
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chain_ends_at_the_snapshot_head() {
        assert_eq!(CHAIN.len(), 80);
        assert_eq!(head_revision(), include_str!("../schema/head.txt").trim());
        assert!(known_revision("551353060a20"));
        assert!(known_revision("f6a7b8c9d0e1"));
        assert!(!known_revision("0123456789ab"));
        // every revision but the first follows one that exists
        for rev in CHAIN.iter().skip(1) {
            assert!(
                !rev.down.is_empty() && rev.down.iter().all(|d| CHAIN.iter().any(|r| r.id == *d)),
                "{rev:?}"
            );
        }
    }

    #[test]
    fn the_snapshots_split_into_statements() {
        assert_eq!(
            statements(SQLITE_SCHEMA)
                .filter(|s| s.contains("CREATE TABLE"))
                .count(),
            78
        );
        assert_eq!(
            statements(SQLITE_SCHEMA)
                .filter(|s| s.contains("CREATE VIRTUAL TABLE"))
                .count(),
            3
        );
        assert_eq!(
            statements(POSTGRES_SCHEMA)
                .filter(|s| s.contains("CREATE TABLE"))
                .count(),
            78
        );
        assert_eq!(
            statements(MYSQL_SCHEMA)
                .filter(|s| s.contains("CREATE TABLE"))
                .count(),
            78
        );
    }
}
