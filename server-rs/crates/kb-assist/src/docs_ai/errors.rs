//! The error a Docs AI request ends with; `code` tells the UI which state to show (`services/docs_ai/errors.py`,
//! lines 1 to 34).

use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

use crate::assistant::errors::{AssistError, Error as AssistFailure};

/// code -> HTTP status
pub const STATUS: [(&str, u16); 14] = [
    ("not_found", 404),
    ("invalid", 422),
    ("forbidden", 403),
    ("viewer", 403),
    ("conflict", 409),
    ("docs_ai_off", 409),
    ("feature_off", 409),
    ("no_member", 409),
    ("unavailable", 409),
    ("paused", 409),
    ("rate_limited", 429),
    ("too_long", 409),
    ("stale", 409),
    ("not_covered", 409),
];

/// A Docs AI request that cannot be taken; `code` maps to an HTTP status and to a state in the UI.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct DocsAiError {
    /// Why the request was refused.
    pub code: String,
    /// What the person reads (`str(exc)`).
    pub message: String,
    /// Any extra response fields.
    pub extra: Map<String, Value>,
}

impl DocsAiError {
    /// Keep the code and the message (no extra response fields).
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into(), extra: Map::new() }
    }

    /// Keep the code, the message and any extra response fields.
    pub fn with_extra(code: &str, message: impl Into<String>, extra: Map<String, Value>) -> Self {
        Self { code: code.to_string(), message: message.into(), extra }
    }

    /// The HTTP status of this error (`STATUS.get(self.code, 400)`).
    pub fn status(&self) -> u16 {
        STATUS.iter().find(|(key, _)| *key == self.code).map_or(400, |(_, status)| *status)
    }
}

/// What a function of the Docs AI fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `DocsAiError`: the request was refused.
    #[error(transparent)]
    DocsAi(#[from] DocsAiError),
    /// `AssistError` that nothing turned into a `DocsAiError`.
    #[error(transparent)]
    Assist(#[from] AssistError),
    /// A Docs call failed (`DocsError`, a `ValueError`, the database).
    #[error(transparent)]
    Docs(#[from] kb_docs::Error),
    /// A ticket call failed.
    #[error("{0:?}")]
    Ticket(kb_board::tickets::Error),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Any other exception: a 500.
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// The `DocsAiError` inside, if this is one.
    pub fn docs_ai(&self) -> Option<&DocsAiError> {
        match self {
            Error::DocsAi(err) => Some(err),
            _ => None,
        }
    }

    /// `exc.code` of a `DocsAiError` (None for any other failure).
    pub fn code(&self) -> Option<&str> {
        self.docs_ai().map(|err| err.code.as_str())
    }

    /// `type(exc).__name__`, as far as it can be told here (what a failed job tells the person).
    pub fn kind(&self) -> String {
        match self {
            Error::DocsAi(_) => "DocsAiError".to_string(),
            Error::Assist(_) => "AssistError".to_string(),
            Error::Docs(kb_docs::Error::Docs(_)) => "DocsError".to_string(),
            Error::Docs(kb_docs::Error::Value(_)) => "ValueError".to_string(),
            Error::Docs(kb_docs::Error::Db(_)) | Error::Db(_) => "OperationalError".to_string(),
            Error::Docs(kb_docs::Error::Other(_)) => "RuntimeError".to_string(),
            Error::Ticket(kb_board::tickets::Error::Value(_)) => "ValueError".to_string(),
            Error::Ticket(kb_board::tickets::Error::NoResult(_)) => "NoResultFound".to_string(),
            Error::Ticket(_) => "RuntimeError".to_string(),
            Error::Other(message) => {
                let name = message.split(':').next().unwrap_or("");
                let named =
                    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()) && name.ends_with("Error");
                if named { name.to_string() } else { "RuntimeError".to_string() }
            }
        }
    }
}

impl From<kb_board::tickets::Error> for Error {
    fn from(err: kb_board::tickets::Error) -> Self {
        Error::Ticket(err)
    }
}

impl From<AssistFailure> for Error {
    fn from(err: AssistFailure) -> Self {
        match err {
            AssistFailure::Assist(err) => Error::Assist(err),
            AssistFailure::Db(err) => Error::Db(err),
            AssistFailure::Value(message) | AssistFailure::Other(message) => Error::Other(message),
        }
    }
}
