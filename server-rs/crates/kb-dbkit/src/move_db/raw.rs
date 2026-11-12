//! Reading any table of any engine as plain values, and the source's snapshot connection.
//!
//! The Python code read and wrote rows through SQLAlchemy's generic rows and reflected the live database through its
//! inspector. Here a row is a `Vec<Cell>` decoded from the driver's row by the type each value arrives with, and the
//! reflection is the engine's own catalog (`sqlite_master` / `PRAGMA`, `information_schema`, `pg_catalog`).

use std::time::Duration;

use futures::StreamExt;
use futures::stream::BoxStream;
use kb_db::schema::SchemaState;
use kb_db::sea_orm::sqlx::mysql::{MySqlConnection, MySqlRow};
use kb_db::sea_orm::sqlx::postgres::{PgConnection, PgRow};
use kb_db::sea_orm::sqlx::sqlite::{SqliteConnection, SqliteRow};
use kb_db::sea_orm::sqlx::{
    self, AssertSqlSafe, ConnectOptions as _, Connection as _, Decode, Row as _, TypeInfo as _, ValueRef as _,
};
use kb_db::sea_orm::{ConnectionTrait, DbBackend, DbErr, QueryResult, Value as DbValue};
use kb_db::targets::{self, ConnectionOptions, Target};
use kb_db::{changes, sql};

use super::errors::db_err;
use super::values::Cell;

/// How long a new connection may take (the Python drivers' `timeout=10` / `connect_timeout=10`).
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

fn decode_error(err: sqlx::error::BoxDynError) -> sqlx::Error {
    sqlx::Error::Decode(err)
}

/// A value of the float type MySQL calls FLOAT, as the Python driver read it: the server sent it as text with six
/// significant digits (`0.1`, not the `0.10000000149011612` the four bytes hold).
pub(crate) fn mysql_float(value: f32) -> f64 {
    if !value.is_finite() {
        return f64::from(value);
    }
    format!("{:.5e}", f64::from(value)).parse().unwrap_or(f64::from(value))
}

/// A DECIMAL (what MySQL's SUM gives) as a number.
fn decimal(text: &str) -> Cell {
    match text.parse::<i64>() {
        Ok(i) => Cell::Int(i),
        Err(_) => text.parse::<f64>().map(Cell::Float).unwrap_or_else(|_| Cell::Text(text.to_string())),
    }
}

/// One row of a SQLite result. SQLite types each value, not each column: a text column can hold a number.
pub(crate) fn sqlite_cells(row: &SqliteRow) -> Result<Vec<Cell>, sqlx::Error> {
    let mut out = Vec::with_capacity(row.len());
    for i in 0..row.len() {
        let value = row.try_get_raw(i)?;
        if value.is_null() {
            out.push(Cell::Null);
            continue;
        }
        let name = value.type_info().name().to_string();
        out.push(match name.as_str() {
            "INTEGER" | "BOOLEAN" => Cell::Int(<i64 as Decode<sqlx::Sqlite>>::decode(value).map_err(decode_error)?),
            "REAL" | "NUMERIC" => Cell::Float(<f64 as Decode<sqlx::Sqlite>>::decode(value).map_err(decode_error)?),
            "BLOB" => Cell::Bytes(<Vec<u8> as Decode<sqlx::Sqlite>>::decode(value).map_err(decode_error)?),
            _ => Cell::Text(<String as Decode<sqlx::Sqlite>>::decode(value).map_err(decode_error)?),
        });
    }
    Ok(out)
}

/// One row of a PostgreSQL result.
pub(crate) fn pg_cells(row: &PgRow) -> Result<Vec<Cell>, sqlx::Error> {
    let mut out = Vec::with_capacity(row.len());
    for i in 0..row.len() {
        let value = row.try_get_raw(i)?;
        if value.is_null() {
            out.push(Cell::Null);
            continue;
        }
        let name = value.type_info().name().to_string();
        out.push(match name.as_str() {
            "BOOL" => Cell::Bool(<bool as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?),
            "INT2" => Cell::Int(i64::from(<i16 as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?)),
            "INT4" => Cell::Int(i64::from(<i32 as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?)),
            "INT8" => Cell::Int(<i64 as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?),
            "FLOAT4" => Cell::Float(f64::from(<f32 as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?)),
            "FLOAT8" => Cell::Float(<f64 as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?),
            "BYTEA" => Cell::Bytes(<Vec<u8> as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?),
            _ => Cell::Text(<String as Decode<sqlx::Postgres>>::decode(value).map_err(decode_error)?),
        });
    }
    Ok(out)
}

/// One row of a MySQL / MariaDB result.
pub(crate) fn mysql_cells(row: &MySqlRow) -> Result<Vec<Cell>, sqlx::Error> {
    let mut out = Vec::with_capacity(row.len());
    for i in 0..row.len() {
        let value = row.try_get_raw(i)?;
        if value.is_null() {
            out.push(Cell::Null);
            continue;
        }
        let name = value.type_info().name().to_string();
        out.push(match name.as_str() {
            // TINYINT(1) is how MySQL keeps a boolean; SQLAlchemy's Boolean read it as one
            "BOOLEAN" => Cell::Bool(<i64 as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)? != 0),
            "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => {
                Cell::Int(<i64 as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)?)
            }
            "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
                let n = <u64 as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)?;
                i64::try_from(n).map(Cell::Int).unwrap_or(Cell::Float(n as f64))
            }
            "FLOAT" => Cell::Float(mysql_float(<f32 as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)?)),
            "DOUBLE" => Cell::Float(<f64 as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)?),
            "DECIMAL" => decimal(&String::from_utf8_lossy(
                &<Vec<u8> as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)?,
            )),
            "BIT" | "GEOMETRY" => Cell::Bytes(<Vec<u8> as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)?),
            // The driver names a text column with a binary collation (the board's utf8mb4_bin) as it names bytes
            // (VARBINARY, LONGBLOB): what reads as text is text.
            _ => match String::from_utf8(<Vec<u8> as Decode<sqlx::MySql>>::decode(value).map_err(decode_error)?) {
                Ok(text) => Cell::Text(text),
                Err(bytes) => Cell::Bytes(bytes.into_bytes()),
            },
        });
    }
    Ok(out)
}

/// One row that a SeaORM connection returned.
pub(crate) fn result_cells(row: &QueryResult) -> Result<Vec<Cell>, DbErr> {
    if let Some(row) = row.try_as_sqlite_row() {
        return sqlite_cells(row).map_err(db_err);
    }
    if let Some(row) = row.try_as_pg_row() {
        return pg_cells(row).map_err(db_err);
    }
    if let Some(row) = row.try_as_mysql_row() {
        return mysql_cells(row).map_err(db_err);
    }
    Err(DbErr::Custom("a row of an unknown driver".into()))
}

/// Something rows can be read from: the source's snapshot, or a connection or transaction on the target.
#[async_trait::async_trait]
pub(crate) trait Reader: Send {
    /// The engine.
    fn backend(&self) -> DbBackend;

    /// Run a statement written with `?` placeholders and return its rows.
    async fn rows(&mut self, sql: &str, params: Vec<DbValue>) -> Result<Vec<Vec<Cell>>, DbErr>;

    /// The first value of the first row (`.scalar()`): `Cell::Null` when there is no row.
    async fn scalar(&mut self, sql: &str, params: Vec<DbValue>) -> Result<Cell, DbErr> {
        Ok(self
            .rows(sql, params)
            .await?
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().next())
            .unwrap_or(Cell::Null))
    }
}

/// A SeaORM connection or transaction as a `Reader`.
pub(crate) struct Sea<'a, C: ConnectionTrait>(pub &'a C);

#[async_trait::async_trait]
impl<C: ConnectionTrait + Sync> Reader for Sea<'_, C> {
    fn backend(&self) -> DbBackend {
        self.0.get_database_backend()
    }

    async fn rows(&mut self, sql: &str, params: Vec<DbValue>) -> Result<Vec<Vec<Cell>>, DbErr> {
        let rows = self.0.query_all_raw(sql::statement(self.backend(), sql, params)).await?;
        rows.iter().map(result_cells).collect()
    }
}

/// `engine.connect()` for one connection of our own, outside any pool: a server that is away is an error at once
/// (a pool would wait and try again), and the connection is closed, not reused, when it is dropped.
pub(crate) enum Direct {
    Sqlite(SqliteConnection),
    Postgres(PgConnection),
    MySql(MySqlConnection),
}

impl Direct {
    /// Open a connection to `target` with the settings `targets::make_engine` gives the connections of its pool.
    pub(crate) async fn connect(target: &Target, role: &str) -> Result<Direct, DbErr> {
        let opened = async {
            Ok::<Direct, sqlx::Error>(match targets::connection_options(target, Some(role)) {
                ConnectionOptions::Postgres(options) => {
                    Direct::Postgres(options.disable_statement_logging().connect().await?)
                }
                ConnectionOptions::MySql(options) => {
                    let mut conn = options.disable_statement_logging().connect().await?;
                    // Each statement sees what was committed before it, as on PostgreSQL (the pool's setting)
                    sqlx::raw_sql("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED").execute(&mut conn).await?;
                    Direct::MySql(conn)
                }
                ConnectionOptions::Sqlite(options) => {
                    Direct::Sqlite(options.disable_statement_logging().connect().await?)
                }
            })
        };
        let failed = |err: sqlx::Error| DbErr::Conn(kb_db::sea_orm::RuntimeErr::SqlxError(std::sync::Arc::new(err)));
        match tokio::time::timeout(CONNECT_TIMEOUT, opened).await {
            Ok(conn) => conn.map_err(failed),
            Err(_) => Err(failed(sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout")))),
        }
    }

    /// Run statements that return nothing, as they are written (no parameters).
    pub(crate) async fn execute(&mut self, statement: &str) -> Result<(), DbErr> {
        let query = sqlx::raw_sql(AssertSqlSafe(statement.to_string()));
        match self {
            Direct::Sqlite(c) => query.execute(c).await.map(|_| ()),
            Direct::Postgres(c) => query.execute(c).await.map(|_| ()),
            Direct::MySql(c) => query.execute(c).await.map(|_| ()),
        }
        .map_err(db_err)
    }

    /// The rows of a statement as they arrive (a whole table is never held in memory).
    pub(crate) fn stream(&mut self, statement: &str) -> BoxStream<'_, Result<Vec<Cell>, DbErr>> {
        let query = AssertSqlSafe(statement.to_string());
        match self {
            Direct::Sqlite(c) => sqlx::query(query)
                .persistent(false)
                .fetch(c)
                .map(|row| row.and_then(|row| sqlite_cells(&row)).map_err(db_err))
                .boxed(),
            Direct::Postgres(c) => sqlx::query(query)
                .persistent(false)
                .fetch(c)
                .map(|row| row.and_then(|row| pg_cells(&row)).map_err(db_err))
                .boxed(),
            Direct::MySql(c) => sqlx::query(query)
                .persistent(false)
                .fetch(c)
                .map(|row| row.and_then(|row| mysql_cells(&row)).map_err(db_err))
                .boxed(),
        }
    }

    /// Close the connection (an open transaction is rolled back by the server).
    pub(crate) async fn close(self) {
        let _ = match self {
            Direct::Sqlite(c) => c.close().await,
            Direct::Postgres(c) => c.close().await,
            Direct::MySql(c) => c.close().await,
        };
    }
}

macro_rules! bound {
    ($db:ty, $conn:expr, $sql:expr, $params:expr, $cells:expr) => {{
        let mut query = sqlx::query::<$db>(AssertSqlSafe($sql)).persistent(false);
        for param in $params {
            query = match param {
                DbValue::Bool(v) => query.bind(v),
                DbValue::BigInt(v) => query.bind(v),
                DbValue::Int(v) => query.bind(v),
                DbValue::Double(v) => query.bind(v),
                DbValue::String(v) => query.bind(v),
                DbValue::Bytes(v) => query.bind(v),
                other => query.bind(other.to_string()),
            };
        }
        let rows = query.fetch_all($conn).await?;
        rows.iter().map($cells).collect::<Result<Vec<_>, sqlx::Error>>()
    }};
}

#[async_trait::async_trait]
impl Reader for Direct {
    fn backend(&self) -> DbBackend {
        match self {
            Direct::Sqlite(_) => DbBackend::Sqlite,
            Direct::Postgres(_) => DbBackend::Postgres,
            Direct::MySql(_) => DbBackend::MySql,
        }
    }

    async fn rows(&mut self, statement: &str, params: Vec<DbValue>) -> Result<Vec<Vec<Cell>>, DbErr> {
        let statement = sql::placeholders(self.backend(), statement);
        let found: Result<Vec<Vec<Cell>>, sqlx::Error> = async {
            match self {
                Direct::Sqlite(c) => bound!(sqlx::Sqlite, &mut *c, statement, params, sqlite_cells),
                Direct::Postgres(c) => bound!(sqlx::Postgres, &mut *c, statement, params, pg_cells),
                Direct::MySql(c) => bound!(sqlx::MySql, &mut *c, statement, params, mysql_cells),
            }
        }
        .await;
        found.map_err(db_err)
    }
}

/// `_snapshot(engine)`: a connection that reads one consistent moment of the source until it is closed.
pub(crate) async fn snapshot(source: &Target) -> Result<Direct, DbErr> {
    let mut conn = Direct::connect(source, "copy").await?;
    match conn.backend() {
        // a read transaction: later commits by the board are not seen
        DbBackend::Sqlite => conn.execute("BEGIN").await?,
        DbBackend::Postgres => conn.execute("BEGIN ISOLATION LEVEL REPEATABLE READ").await?,
        _ => {
            conn.execute("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ").await?;
            conn.execute("START TRANSACTION").await?;
        }
    }
    Ok(conn)
}

// ---------------------------------------------------------------------------
// What a live database holds (the Python code asked SQLAlchemy's inspector)
// ---------------------------------------------------------------------------

/// A name as the engine quotes it.
pub(crate) fn quote(backend: DbBackend, name: &str) -> String {
    if backend == DbBackend::MySql { format!("`{name}`") } else { format!("\"{name}\"") }
}

/// `inspect(conn).get_table_names()`: the tables of the database (on SQLite the FTS tables and their shadow tables
/// too).
pub(crate) async fn table_names<R: Reader + ?Sized>(reader: &mut R) -> Result<Vec<String>, DbErr> {
    let query = match reader.backend() {
        DbBackend::Postgres => {
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"
        }
        DbBackend::MySql => {
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name"
        }
        _ => {
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite~_%' ESCAPE '~' ORDER BY name"
        }
    };
    let rows = reader.rows(query, Vec::new()).await?;
    Ok(rows.into_iter().filter_map(|row| row.into_iter().next()).map(|name| name.py_str()).collect())
}

/// `database.schema_state` on any connection: what a database holds.
pub(crate) async fn schema_state<R: Reader + ?Sized>(reader: &mut R) -> Result<SchemaState, DbErr> {
    let mut names = table_names(reader).await?;
    names.retain(|n| n != changes::TABLE);
    if names.is_empty() {
        return Ok(SchemaState { state: "empty", revision: None, tables: 0 });
    }
    if !names.iter().any(|n| n == "alembic_version") {
        return Ok(SchemaState { state: "foreign", revision: None, tables: names.len() });
    }
    let revs = reader.rows("SELECT version_num FROM alembic_version", Vec::new()).await?;
    let revision = revs.into_iter().next().and_then(|row| row.into_iter().next()).map(|v| v.py_str());
    Ok(SchemaState { state: "board", revision, tables: names.len() - 1 })
}

/// The state as the API gives it.
pub(crate) fn state_json(state: &SchemaState) -> serde_json::Value {
    serde_json::json!({"state": state.state, "revision": state.revision, "tables": state.tables})
}

/// `SELECT count(*) FROM table`.
pub(crate) async fn count<R: Reader + ?Sized>(reader: &mut R, table: &str) -> Result<i64, DbErr> {
    let statement = format!("SELECT count(*) FROM {}", quote(reader.backend(), table));
    Ok(reader.scalar(&statement, Vec::new()).await?.as_i64().unwrap_or(0))
}

/// The type of a column as SQLAlchemy's inspector printed it ("VARCHAR", "INTEGER", "VARCHAR(255)", "LONGTEXT",
/// "DOUBLE PRECISION"); `None` when the column is not there.
pub(crate) async fn column_type<R: Reader + ?Sized>(
    reader: &mut R,
    table: &str,
    column: &str,
) -> Result<Option<String>, DbErr> {
    match reader.backend() {
        DbBackend::Postgres => {
            let rows = reader
                .rows(
                    "SELECT data_type, character_maximum_length FROM information_schema.columns \
                     WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?",
                    vec![table.into(), column.into()],
                )
                .await?;
            Ok(rows.into_iter().next().map(|row| {
                let data_type = row.first().map(Cell::py_str).unwrap_or_default();
                let length = row.get(1).and_then(Cell::as_i64);
                let name = match data_type.as_str() {
                    "character varying" => "VARCHAR".to_string(),
                    "character" => "CHAR".to_string(),
                    "timestamp without time zone" => "TIMESTAMP".to_string(),
                    other => other.to_uppercase(),
                };
                match length {
                    Some(n) => format!("{name}({n})"),
                    None => name,
                }
            }))
        }
        DbBackend::MySql => {
            let rows = reader
                .rows(
                    "SELECT column_type FROM information_schema.columns \
                     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
                    vec![table.into(), column.into()],
                )
                .await?;
            Ok(rows.into_iter().next().and_then(|row| row.into_iter().next()).map(|kind| {
                let upper = kind.py_str().to_uppercase();
                // SQLAlchemy names MySQL's INT "INTEGER"
                match upper.strip_prefix("INT") {
                    Some(rest) if rest.is_empty() || rest.starts_with('(') || rest.starts_with(' ') => {
                        format!("INTEGER{rest}")
                    }
                    _ => upper,
                }
            }))
        }
        _ => {
            let rows = reader.rows(&format!("PRAGMA table_info(\"{table}\")"), Vec::new()).await?;
            Ok(rows
                .into_iter()
                .find(|row| row.get(1).and_then(Cell::as_str) == Some(column))
                .map(|row| row.get(2).map(Cell::py_str).unwrap_or_default().to_uppercase()))
        }
    }
}

/// (nullable, default, indexes) of a column: what a statement that redefines it must keep. Indexes are written
/// "name (a, b)" with " unique" after a unique one; the primary key's own index is not listed.
pub(crate) async fn column_facts<R: Reader + ?Sized>(
    reader: &mut R,
    table: &str,
    column: &str,
) -> Result<(Option<bool>, Option<String>, Vec<String>), DbErr> {
    let mut found: Vec<(String, Vec<String>, bool)> = Vec::new();
    let col: Option<(bool, Option<String>)>;
    match reader.backend() {
        DbBackend::Postgres => {
            let rows = reader
                .rows(
                    "SELECT i.relname, ix.indisunique, a.attname FROM pg_index ix \
                     JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid \
                     JOIN pg_namespace n ON n.oid = t.relnamespace \
                     JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
                     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
                     WHERE n.nspname = current_schema() AND t.relname = ? AND NOT ix.indisprimary \
                     ORDER BY i.relname, k.ord",
                    vec![table.into()],
                )
                .await?;
            for row in rows {
                let name = row.first().map(Cell::py_str).unwrap_or_default();
                let unique = matches!(row.get(1), Some(Cell::Bool(true)));
                let part = row.get(2).map(Cell::py_str).unwrap_or_default();
                match found.last_mut() {
                    Some(last) if last.0 == name => last.1.push(part),
                    _ => found.push((name, vec![part], unique)),
                }
            }
            let rows = reader
                .rows(
                    "SELECT is_nullable, column_default FROM information_schema.columns \
                     WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?",
                    vec![table.into(), column.into()],
                )
                .await?;
            col = rows.into_iter().next().map(|row| {
                (
                    row.first().and_then(Cell::as_str) == Some("YES"),
                    row.get(1).filter(|d| !d.is_null()).map(Cell::py_str),
                )
            });
        }
        DbBackend::MySql => {
            let rows = reader
                .rows(
                    "SELECT index_name, non_unique, column_name FROM information_schema.statistics \
                     WHERE table_schema = DATABASE() AND table_name = ? AND index_name <> 'PRIMARY' \
                     ORDER BY index_name, seq_in_index",
                    vec![table.into()],
                )
                .await?;
            for row in rows {
                let name = row.first().map(Cell::py_str).unwrap_or_default();
                let unique = row.get(1).and_then(Cell::as_i64) == Some(0);
                let part = row.get(2).map(Cell::py_str).unwrap_or_default();
                match found.last_mut() {
                    Some(last) if last.0 == name => last.1.push(part),
                    _ => found.push((name, vec![part], unique)),
                }
            }
            let rows = reader
                .rows(
                    "SELECT is_nullable, column_default FROM information_schema.columns \
                     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
                    vec![table.into(), column.into()],
                )
                .await?;
            col = rows.into_iter().next().map(|row| {
                (
                    row.first().and_then(Cell::as_str) == Some("YES"),
                    row.get(1).filter(|d| !d.is_null()).map(Cell::py_str),
                )
            });
        }
        _ => {
            let listed = reader.rows(&format!("PRAGMA index_list(\"{table}\")"), Vec::new()).await?;
            for row in listed {
                let name = row.get(1).map(Cell::py_str).unwrap_or_default();
                // the index SQLite makes for a PRIMARY KEY or UNIQUE constraint is not one SQLAlchemy lists
                if name.starts_with("sqlite_autoindex") {
                    continue;
                }
                let unique = row.get(2).and_then(Cell::as_i64) == Some(1);
                let parts = reader.rows(&format!("PRAGMA index_info(\"{name}\")"), Vec::new()).await?;
                let parts = parts.into_iter().filter_map(|p| p.get(2).map(Cell::py_str)).collect();
                found.push((name, parts, unique));
            }
            found.sort_by(|a, b| a.0.cmp(&b.0));
            let rows = reader.rows(&format!("PRAGMA table_info(\"{table}\")"), Vec::new()).await?;
            col = rows.into_iter().find(|row| row.get(1).and_then(Cell::as_str) == Some(column)).map(|row| {
                (row.get(3).and_then(Cell::as_i64) == Some(0), row.get(4).filter(|d| !d.is_null()).map(Cell::py_str))
            });
        }
    }
    let indexes = found
        .into_iter()
        .filter(|(_, parts, _)| parts.iter().any(|p| p == column))
        .map(|(name, parts, unique)| format!("{name} ({}){}", parts.join(", "), if unique { " unique" } else { "" }))
        .collect();
    Ok(match col {
        None => (None, None, indexes),
        Some((nullable, default)) => (Some(nullable), default, indexes),
    })
}

/// "SQLite 3.45.1", "PostgreSQL 16.4", "MariaDB 10.11.6": the engine and version of a database
/// (`_target_version(engine)`).
pub(crate) async fn server_version<R: Reader + ?Sized>(reader: &mut R) -> String {
    let (name, version) = match reader.backend() {
        DbBackend::Postgres => (
            "PostgreSQL",
            reader.scalar("SHOW server_version", Vec::new()).await.map(|v| v.py_str()).unwrap_or_default(),
        ),
        DbBackend::MySql => {
            let version = reader.scalar("SELECT VERSION()", Vec::new()).await.map(|v| v.py_str()).unwrap_or_default();
            (if version.to_lowercase().contains("mariadb") { "MariaDB" } else { "MySQL" }, version)
        }
        _ => (
            "SQLite",
            reader.scalar("SELECT sqlite_version()", Vec::new()).await.map(|v| v.py_str()).unwrap_or_default(),
        ),
    };
    let numbers: Vec<String> = version_tuple(&version).iter().take(3).map(u64::to_string).collect();
    format!("{name} {}", numbers.join(".")).trim().to_string()
}

/// `_version_tuple(text)`: the leading numbers of a version ("10.11.6-MariaDB-1" is 10, 11, 6).
pub(crate) fn version_tuple(text: &str) -> Vec<u64> {
    let mut nums = Vec::new();
    // PostgreSQL adds the build after a space ("16.4 (Debian 16.4-1)")
    let head = text.split('-').next().unwrap_or("").split(' ').next().unwrap_or("");
    for part in head.split('.') {
        let digits: String = part.chars().filter(char::is_ascii_digit).collect();
        if digits.is_empty() {
            break;
        }
        nums.push(digits.parse().unwrap_or(0));
    }
    nums
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mysql_float_is_read_with_six_digits_as_the_python_driver_read_it() {
        assert_eq!(mysql_float(0.1), 0.1);
        assert_eq!(mysql_float(1.5), 1.5);
        assert_eq!(mysql_float(1.234_567_9), 1.23457);
        assert_eq!(mysql_float(16_777_217.0), 16_777_200.0);
        assert_eq!(mysql_float(3.40282e38), 3.40282e38);
        assert_eq!(mysql_float(-0.0), 0.0);
    }

    #[test]
    fn versions_are_read_up_to_the_first_word() {
        assert_eq!(version_tuple("10.11.6-MariaDB-1:10.11.6+maria~ubu2204"), vec![10, 11, 6]);
        assert_eq!(version_tuple("16.4 (Debian 16.4-1.pgdg120+1)"), vec![16, 4]);
        assert_eq!(version_tuple("8.0.36"), vec![8, 0, 36]);
        assert_eq!(version_tuple("3.45.1"), vec![3, 45, 1]);
        assert_eq!(version_tuple("devel"), Vec::<u64>::new());
    }
}
