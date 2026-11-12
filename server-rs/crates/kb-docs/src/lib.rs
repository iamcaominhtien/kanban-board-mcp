//! The Docs space: a tree of Markdown pages per project with versions, drafts, links between pages and to tickets,
//! the Recycle Bin and full-text search (`services/docs.py`, `docs_search.py`, `docs_work.py`, `api/docs.py`).
//!
//! Part 1 of the port. Comments (`docs_comments.py`) and imports (`docs_import.py`) come in part 2; the places
//! where this half calls them are the hooks in [`hooks`].

pub mod api;
pub mod docs;
pub mod docs_search;
pub mod docs_work;
pub mod hooks;
pub mod schemas;
pub mod util;

use kb_db::sea_orm::DbErr;
use kb_doctext::docs_text::DocsError;

/// What a function of this crate fails with.
#[derive(Debug)]
pub enum Error {
    /// `raise DocsError(...)`.
    Docs(DocsError),
    /// `ValueError(message)` (the router of `docs_work.assign_page` answers 422).
    Value(String),
    /// The database call failed.
    Db(DbErr),
    /// Any other exception nothing catches: a 500.
    Other(String),
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

impl From<kb_doctext::docs_text::Error> for Error {
    fn from(err: kb_doctext::docs_text::Error) -> Self {
        match err {
            kb_doctext::docs_text::Error::Docs(e) => Error::Docs(e),
            kb_doctext::docs_text::Error::Db(e) => Error::Db(e),
        }
    }
}

impl From<kb_draw::Error> for Error {
    fn from(err: kb_draw::Error) -> Self {
        match err {
            kb_draw::Error::Docs(e) => Error::Docs(e),
            kb_draw::Error::Db(e) => Error::Db(e),
            kb_draw::Error::Value(m) => Error::Other(m),
            kb_draw::Error::Io(e) => Error::Other(e.to_string()),
        }
    }
}

impl From<kb_notify::NotifyError> for Error {
    fn from(err: kb_notify::NotifyError) -> Self {
        Error::Other(err.to_string())
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Docs(e) => e.fmt(f),
            Error::Value(m) | Error::Other(m) => f.write_str(m),
            Error::Db(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

/// What a service function of this crate returns.
pub type Result<T> = std::result::Result<T, Error>;

/// `DocsError(status, code, message)` as an `Err`.
pub(crate) fn docs_err<T>(status: u16, code: &str, message: impl Into<String>) -> Result<T> {
    Err(DocsError::new(status, code, message).into())
}
