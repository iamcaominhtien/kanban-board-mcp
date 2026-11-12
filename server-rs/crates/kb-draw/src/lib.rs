//! Drawings: draw.io diagrams, paint-style sketches, and the exact SVG previews of diagrams.

pub mod api;
pub mod diagram_export;
pub mod diagram_model;
pub mod diagrams;
pub mod hooks;
pub mod html;
pub mod html_entities;
pub mod schemas;
pub mod sketches;
pub mod util;
pub mod xml;

use kb_db::sea_orm::DbErr;
use kb_doctext::docs_text::DocsError;

/// What a service function of this crate fails with: the `DocsError` it raised, the `ValueError` of a number that is
/// not one (nothing above catches it: a 500), or a database call that failed.
#[derive(Debug)]
pub enum Error {
    /// `raise DocsError(...)`.
    Docs(DocsError),
    /// `ValueError(message)`.
    Value(String),
    /// The database call failed.
    Db(DbErr),
    /// A file operation the Python code does not catch (an `OSError`): a 500.
    Io(std::io::Error),
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

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err)
    }
}

impl From<diagram_model::Error> for Error {
    fn from(err: diagram_model::Error) -> Self {
        match err {
            diagram_model::Error::Docs(e) => Error::Docs(e),
            diagram_model::Error::Value(m) => Error::Value(m),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Docs(e) => e.fmt(f),
            Error::Value(m) => f.write_str(m),
            Error::Db(e) => e.fmt(f),
            Error::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

/// What a service function returns.
pub type Result<T> = std::result::Result<T, Error>;
