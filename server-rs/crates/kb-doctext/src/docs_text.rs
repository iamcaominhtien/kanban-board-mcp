//! `services/docs_text.py`.
//!
//! Only `DocsError` is ported so far (`docs_access` raises it); the rest of the file (references, links, anchors,
//! slugs) is ported with the Docs area.

use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

/// Domain error carrying an HTTP status and a machine-readable code.
#[derive(Debug, Clone, PartialEq)]
pub struct DocsError {
    /// HTTP status to return.
    pub status: u16,
    /// Short machine-readable code.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
    /// Extra fields merged into the error response.
    pub extra: Map<String, Value>,
}

impl DocsError {
    /// `DocsError(status, code, message)`.
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self { status, code: code.to_string(), message: message.into(), extra: Map::new() }
    }

    /// `DocsError(status, code, message, key=value)`: one more extra field.
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.extra.insert(key.to_string(), value.into());
        self
    }
}

impl std::fmt::Display for DocsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DocsError {}

/// What a Docs service function fails with: the `DocsError` it raised, or a database call that failed (an
/// unhandled exception in Python, a 500).
#[derive(Debug)]
pub enum Error {
    /// `raise DocsError(...)`.
    Docs(DocsError),
    /// The database call failed.
    Db(DbErr),
}

impl From<DocsError> for Error {
    fn from(err: DocsError) -> Self {
        Error::Docs(err)
    }
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Docs(err) => err.fmt(f),
            Error::Db(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

/// What a Docs service function returns.
pub type DocsResult<T> = Result<T, Error>;
