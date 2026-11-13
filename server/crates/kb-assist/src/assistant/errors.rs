//! Errors of the assistants: a code the UI maps to a state, and a message (`services/assistant/errors.py`, lines 1 to
//! 27).

use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

/// A request to an assistant was refused; `code` says why (the API maps it to a status).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct AssistError {
    /// Why the request was refused (a key of `STATUS`, or a code only the UI reads, such as `paused`).
    pub code: String,
    /// What the person reads (`str(exc)`).
    pub message: String,
    /// Extra response fields.
    pub extra: Map<String, Value>,
}

impl AssistError {
    /// Keep the code and the message (no extra response fields).
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into(), extra: Map::new() }
    }

    /// Keep the code and any extra response fields.
    pub fn with_extra(code: &str, message: impl Into<String>, extra: Map<String, Value>) -> Self {
        Self { code: code.to_string(), message: message.into(), extra }
    }
}

/// The HTTP status of each code.
pub const STATUS: [(&str, u16); 12] = [
    ("not_found", 404),
    ("invalid", 422),
    ("invalid_output", 422),
    ("too_large", 413),
    ("viewer", 403),
    ("forbidden", 403),
    ("conflict", 409),
    ("feature_off", 409),
    ("not_configured", 409),
    ("unavailable", 409),
    ("ai_off", 409),
    ("gone", 410),
];

/// `STATUS.get(code)`.
pub fn status(code: &str) -> Option<u16> {
    STATUS.iter().find(|(key, _)| *key == code).map(|(_, status)| *status)
}

/// What a function of the assistants fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `AssistError`: the request was refused.
    #[error(transparent)]
    Assist(#[from] AssistError),
    /// `ValueError` that is not an `AssistError` (the AI team's reply to a ticket chat): the text is the message.
    #[error("{0}")]
    Value(String),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Any other exception: a 500.
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// The `AssistError` inside, if this is one.
    pub fn assist(&self) -> Option<&AssistError> {
        match self {
            Error::Assist(err) => Some(err),
            _ => None,
        }
    }

    /// `exc.code` of an `AssistError` (None for any other failure).
    pub fn code(&self) -> Option<&str> {
        self.assist().map(|err| err.code.as_str())
    }
}

impl From<kb_board::tickets::Error> for Error {
    fn from(err: kb_board::tickets::Error) -> Self {
        match err {
            // `AssistError` is a `ValueError`, and so is what the tickets raise: callers that catch one catch both
            kb_board::tickets::Error::Value(message) => Error::Value(message),
            kb_board::tickets::Error::Db(err) => Error::Db(err),
            kb_board::tickets::Error::NoResult(message) | kb_board::tickets::Error::Other(message) => {
                Error::Other(message)
            }
        }
    }
}
