//! What a move fails with, in words the person and the AI can use (never the row's values).

use std::sync::LazyLock;

use kb_db::sea_orm::sqlx;
use kb_db::sea_orm::sqlx::mysql::MySqlDatabaseError;
use kb_db::sea_orm::sqlx::sqlite::SqliteError;
use kb_db::sea_orm::{DbErr, RuntimeErr};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

/// The move cannot go on; `code` says why: same | source | target_not_empty | newer | unreachable.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct MoveError {
    pub code: &'static str,
    pub message: String,
    /// What else the caller may show (`table`, `revision`, `head`, `state`...).
    pub info: Map<String, Value>,
}

impl MoveError {
    /// Say what and why.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), info: Map::new() }
    }

    /// The same error with one more fact.
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.info.insert(key.into(), value.into());
        self
    }
}

/// Where and why a copy stopped (design D4): what the board knows, without the row's values.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Stop {
    pub table: String,
    /// 1-based position of the row that would not go in.
    pub row: i64,
    /// Rows of that table that went in before it (rolled back with the table).
    pub copied: i64,
    pub total: i64,
    pub tables_done: usize,
    pub tables_total: usize,
    pub error: String,
    pub code: String,
    pub column: Option<String>,
    pub value_length: Option<usize>,
    pub value_null: bool,
    pub source_type: Option<String>,
    pub target_type: Option<String>,
    pub source_engine: String,
    pub target_engine: String,
    pub target_version: String,
    pub target_nullable: Option<bool>,
    pub target_default: Option<String>,
    /// Indexes on the column ("ix_x (a, b) unique").
    pub target_indexes: Vec<String>,
}

impl Stop {
    /// For the API and the AI bundle.
    pub fn as_dict(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// What a step of a move fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `MoveError`.
    #[error(transparent)]
    Move(#[from] MoveError),
    /// `CopyStopped`: a value would not go in; the stop says where.
    #[error("{}", .0.error)]
    Stopped(Box<Stop>),
    /// A database error (`DBAPIError` and the like).
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Other(err.to_string())
    }
}

/// A driver error as the database calls return it.
pub(crate) fn db_err(err: sqlx::Error) -> DbErr {
    DbErr::Query(RuntimeErr::SqlxError(std::sync::Arc::new(err)))
}

/// The driver's error inside a database error.
pub(crate) fn sqlx_of(err: &DbErr) -> Option<&sqlx::Error> {
    match err {
        DbErr::Conn(RuntimeErr::SqlxError(e))
        | DbErr::Exec(RuntimeErr::SqlxError(e))
        | DbErr::Query(RuntimeErr::SqlxError(e)) => Some(e.as_ref()),
        _ => None,
    }
}

/// (message, code) as the Python drivers gave them: the server's own words and its SQLSTATE (PostgreSQL) or error
/// number (MySQL / MariaDB); SQLite has no code.
pub(crate) fn raw_error(err: &DbErr) -> (String, String) {
    match sqlx_of(err) {
        Some(sqlx::Error::Database(db)) => {
            if let Some(mysql) = db.try_downcast_ref::<MySqlDatabaseError>() {
                return (mysql.message().to_string(), mysql.number().to_string());
            }
            if db.try_downcast_ref::<SqliteError>().is_some() {
                return (db.message().to_string(), String::new());
            }
            (db.message().to_string(), db.code().map(|c| c.into_owned()).unwrap_or_default())
        }
        Some(other) => (other.to_string(), String::new()),
        None => (err.to_string(), String::new()),
    }
}

/// `message[:400]` after the cuts `clean_error` makes.
fn clean_message(message: &str) -> String {
    let message = message.split('\n').next().unwrap_or("");
    let message = message.split("[SQL:").next().unwrap_or("");
    let message = message.split("DETAIL:").next().unwrap_or("");
    kb_base::pytext::strip(message).chars().take(400).collect()
}

/// (message, code) without the SQL, the parameters or PostgreSQL's DETAIL line (which quotes the row).
pub fn clean_error(err: &DbErr) -> (String, String) {
    let (message, code) = raw_error(err);
    (clean_message(&message), code)
}

/// `clean_error` for anything a move fails with.
pub fn clean_any(err: &Error) -> (String, String) {
    match err {
        Error::Db(db) => clean_error(db),
        other => (clean_message(&other.to_string()), String::new()),
    }
}

/// `clean_error` for an error that is only text and a code (how a test names a driver error).
pub fn clean_text(message: &str, code: &str) -> (String, String) {
    (clean_message(message), code.to_string())
}

static COLUMN_PATTERNS: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    let build = |pattern: &str| Regex::new(pattern).expect("a pattern written in the code compiles");
    [
        build(r#"for column [`'"]?(?:[\w]+[`'"]?\.[`'"]?)*(\w+)[`'"]?"#),
        build(r#"null value in column "(\w+)""#),
        build(r"Column '(\w+)' cannot be null"),
        build(r#"column "(\w+)""#),
    ]
});

/// `_error_column(message)`: the column an error message names.
pub fn error_column(message: &str) -> Option<String> {
    COLUMN_PATTERNS.iter().find_map(|pattern| pattern.captures(message).map(|m| m[1].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_errors_never_carry_the_row() {
        let (message, code) = clean_text(
            "null value in column \"title\" of relation \"ticket\" violates not-null constraint\n\
             DETAIL:  Failing row contains (KB-1, secret text).",
            "23502",
        );
        assert!(!message.contains("secret"));
        assert_eq!(code, "23502");
        assert_eq!(error_column(&message).as_deref(), Some("title"));
    }

    #[test]
    fn the_column_is_read_from_each_engines_words() {
        assert_eq!(error_column("Data too long for column 'name' at row 1").as_deref(), Some("name"));
        assert_eq!(error_column("Column 'title' cannot be null").as_deref(), Some("title"));
        assert_eq!(error_column("Incorrect integer value: 'x' for column `db`.`t`.`n` at row 1").as_deref(), Some("n"));
        assert_eq!(
            error_column("column \"n\" is of type integer but expression is of type text").as_deref(),
            Some("n")
        );
        assert_eq!(error_column("NOT NULL constraint failed: ticket.title"), None);
    }
}
