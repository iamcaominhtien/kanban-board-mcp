//! What the Idea Space services fail with. The Python code raises `ValueError` for a bad value, a missing idea or a
//! missing record, and `IdeaRuleError` (a `ValueError` with a machine-readable code) for a broken rule; anything else
//! is a 500 on the REST routes.

use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

/// `IdeaRuleError` (`services/idea_space.py`): a request that breaks a rule of the Idea Space; `code` tells a client
/// which one.
#[derive(Debug, Clone, PartialEq)]
pub struct IdeaRuleError {
    /// The machine-readable code (`building_locked`, `not_ready`...).
    pub code: String,
    /// The text of the exception.
    pub message: String,
    /// The details the API returns next to the code (`readiness`, `ticket_id`).
    pub extra: Map<String, Value>,
}

/// What a function of the Idea Space services fails with.
#[derive(Debug)]
pub enum Error {
    /// `IdeaRuleError`.
    Rule(IdeaRuleError),
    /// `ValueError`: the text is the message.
    Value(String),
    /// The database call failed.
    Db(DbErr),
    /// Any other exception (a ticket that could not be created for a reason that is not a `ValueError`, a stored
    /// value of a kind the code does not expect): a 500.
    Other(String),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl From<IdeaRuleError> for Error {
    fn from(err: IdeaRuleError) -> Self {
        Error::Rule(err)
    }
}

impl From<kb_board::tickets::Error> for Error {
    /// What `services.tickets.create_ticket` raises: `ValueError` stays one, `NoResultFound` and the rest are 500s.
    fn from(err: kb_board::tickets::Error) -> Self {
        use kb_board::tickets::Error as T;
        match err {
            T::Value(message) => Error::Value(message),
            T::Db(err) => Error::Db(err),
            T::NoResult(message) | T::Other(message) => Error::Other(message),
        }
    }
}

impl From<kb_board::workspace::Error> for Error {
    /// `WorkspaceError` is a `ValueError`; a missing entry (`LookupError`) and I/O failures are 500s.
    fn from(err: kb_board::workspace::Error) -> Self {
        use kb_board::workspace::Error as W;
        match err {
            W::Workspace(message) => Error::Value(message),
            W::Db(err) => Error::Db(err),
            other => Error::Other(other.to_string()),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Rule(rule) => f.write_str(&rule.message),
            Error::Value(message) | Error::Other(message) => f.write_str(message),
            Error::Db(err) => write!(f, "{err}"),
        }
    }
}

/// `ValueError(message)`.
pub(crate) fn value_error<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error::Value(message.into()))
}

/// `raise IdeaRuleError(code, message)`.
pub(crate) fn rule_error<T>(code: &str, message: impl Into<String>) -> Result<T, Error> {
    Err(Error::Rule(IdeaRuleError { code: code.to_string(), message: message.into(), extra: Map::new() }))
}

/// `raise IdeaRuleError(code, message, **extra)`.
pub(crate) fn rule_error_with<T>(
    code: &str,
    message: impl Into<String>,
    extra: Map<String, Value>,
) -> Result<T, Error> {
    Err(Error::Rule(IdeaRuleError { code: code.to_string(), message: message.into(), extra }))
}
