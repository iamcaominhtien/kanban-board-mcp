//! The exceptions `services/notifications.py` raises (`ValueError`, `LookupError`, `PermissionError`) as one enum;
//! the router (`api/notifications.py`) maps each to a status exactly where the Python router has its `except`.

use kb_base::ApiError;
use kb_db::sea_orm::DbErr;

/// What a notification service call can fail with.
#[derive(Debug)]
pub enum NotifyError {
    /// `ValueError(message)`.
    Value(String),
    /// `LookupError(message)`.
    Lookup(String),
    /// `PermissionError(message)`.
    Permission(String),
    /// Anything Python would raise that nothing catches (`TypeError`, `AttributeError`...): a 500.
    Internal(String),
    /// A database call failed.
    Db(DbErr),
}

/// What a notification service call returns.
pub type Result<T> = std::result::Result<T, NotifyError>;

impl NotifyError {
    /// `ValueError(message)`.
    pub fn value(message: impl Into<String>) -> Self {
        NotifyError::Value(message.into())
    }

    /// `LookupError(message)`.
    pub fn lookup(message: impl Into<String>) -> Self {
        NotifyError::Lookup(message.into())
    }
}

impl std::fmt::Display for NotifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotifyError::Value(m) | NotifyError::Lookup(m) | NotifyError::Permission(m) | NotifyError::Internal(m) => {
                f.write_str(m)
            }
            NotifyError::Db(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for NotifyError {}

impl From<DbErr> for NotifyError {
    fn from(err: DbErr) -> Self {
        NotifyError::Db(err)
    }
}

impl NotifyError {
    /// The router's `_bad(exc, status)`: the message as the `detail`; a database or internal failure is a 500.
    pub fn into_api(self, status: u16) -> ApiError {
        match self {
            NotifyError::Db(e) => ApiError::from(e),
            NotifyError::Internal(m) => ApiError::internal(m),
            other => ApiError::code(status, other.to_string()),
        }
    }
}
