//! `api/tickets.py`. The Python file is one router; here each part is a file, and `routes()` registers them in the
//! order of the Python file:
//!
//! - `core.rs` (lines 1-440): the two upload routes, list, counts, create, read, update, delete and the quick status;
//! - `reopen.rs` (lines 443-560): reopen and its undo, the Pending flag and Resume;
//! - `comments.rs` (lines 563-674): comments;
//! - `checklists.rs` (lines 677-780): acceptance criteria and sub-tasks;
//! - `work_log.rs` (lines 783-880): the work log;
//! - `test_cases.rs` (lines 883-991): test cases;
//! - `relations.rs` (lines 994-1096): the project's activity feed, blocks and links;
//! - `branches.rs` (lines 1099-1276): branches, the commit graph and commit details.
//!
//! FastAPI takes the first route that matches; axum takes the most specific one whatever the order. The one pair
//! where the two differ is `/tickets/{ticket_id}/branches/base` next to `/tickets/{ticket_id}/branches/{branch_id}`:
//! see `branches.rs`.

use axum::Json;
use kb_base::{ApiError, ApiResult, Routes};
use kb_db::entities::ticket;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::schemas::TicketRead;
use crate::tickets::Error;

mod branches;
mod checklists;
mod comments;
mod core;
mod relations;
mod reopen;
mod test_cases;
mod work_log;

pub use self::core::TOUCH_FIELDS;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .merge(core::routes())
        .merge(reopen::routes())
        .merge(comments::routes())
        .merge(checklists::routes())
        .merge(work_log::routes())
        .merge(test_cases::routes())
        .merge(relations::routes())
        .merge(branches::routes())
}

/// `except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc))`; anything else is a 500.
pub(crate) fn bad_request(err: Error) -> ApiError {
    match err {
        Error::Value(message) => ApiError::bad_request(message),
        Error::Db(err) => err.into(),
        Error::NoResult(message) | Error::Other(message) => ApiError::internal(message),
    }
}

/// A route that catches nothing: a `ValueError` is a 500 like any other exception.
pub(crate) fn uncaught(err: Error) -> ApiError {
    match err {
        Error::Db(err) => err.into(),
        Error::Value(message) | Error::NoResult(message) | Error::Other(message) => ApiError::internal(message),
    }
}

/// `_read`.
pub(crate) fn read(ticket: ticket::Model) -> ApiResult<Json<TicketRead>> {
    Ok(Json(TicketRead::from_ticket(ticket)?))
}

/// `_404`.
pub(crate) fn not_found() -> ApiError {
    ApiError::not_found("Ticket not found")
}

/// What most routes of a sub-entity end with: `if ticket is None: _404()`, the announcement, `_read(ticket)`.
pub(crate) async fn changed(ticket: Option<ticket::Model>) -> ApiResult<Json<TicketRead>> {
    let Some(ticket) = ticket else {
        return Err(not_found());
    };
    kb_base::events::publish("invalidate", &[]).await;
    read(ticket)
}

/// A `bool` query value as Pydantic reads it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct QueryBool(pub(crate) bool);

impl<'de> Deserialize<'de> for QueryBool {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        match bool_of(&text) {
            Some(flag) => Ok(QueryBool(flag)),
            None => Err(serde::de::Error::custom("Input should be a valid boolean, unable to interpret input")),
        }
    }
}

/// The text of a bool as Pydantic reads it, or None.
fn bool_of(text: &str) -> Option<bool> {
    match text.to_lowercase().as_str() {
        "1" | "true" | "t" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "f" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

/// A query value that was given, an empty one included (`status=` is the status `""`, not no status; an empty
/// value is not a bool).
pub(crate) fn given<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// `name: bool = False` of a query: the flag, or FastAPI's 422 naming the parameter.
pub(crate) fn query_bool(name: &str, value: Option<&str>, default: bool) -> ApiResult<bool> {
    let Some(value) = value else { return Ok(default) };
    bool_of(value).ok_or_else(|| {
        ApiError::validation(
            &["query", name],
            "Input should be a valid boolean, unable to interpret input",
            "bool_parsing",
        )
    })
}

/// `name: int = default` of a query: the number, or FastAPI's 422 naming the parameter.
pub(crate) fn query_int(name: &str, value: Option<&str>, default: i64) -> ApiResult<i64> {
    let Some(value) = value else { return Ok(default) };
    let text = value.trim();
    // "80", "+80", "-5", and "80.0" as Pydantic reads a whole number written with a fraction
    let whole = match text.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() && fraction.bytes().all(|b| b == b'0') => whole,
        Some(_) => "",
        None => text,
    };
    let digits = whole.strip_prefix(['+', '-']).unwrap_or(whole);
    let parsed = if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        whole.strip_prefix('+').unwrap_or(whole).parse::<i64>().ok()
    } else {
        None
    };
    parsed.ok_or_else(|| {
        ApiError::validation(
            &["query", name],
            "Input should be a valid integer, unable to parse string as an integer",
            "int_parsing",
        )
    })
}

/// `int` in a JSON body as Pydantic reads it: a whole number, also written as a float (`3.0`) or a bool.
fn int_of<E: serde::de::Error>(value: &Value) -> Result<i64, E> {
    match value {
        Value::Bool(flag) => Ok(i64::from(*flag)),
        Value::Number(n) => {
            if let Some(whole) = n.as_i64() {
                return Ok(whole);
            }
            match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => Ok(f as i64),
                _ => Err(E::custom("Input should be a valid integer, got a number with a fractional part")),
            }
        }
        _ => Err(E::custom("Input should be a valid integer")),
    }
}

/// A body field `name: int = default`.
pub(crate) fn int<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    int_of(&Value::deserialize(deserializer)?)
}

/// A body field `name: int | None = None`.
pub(crate) fn optional_int<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::Null => Ok(None),
        value => int_of(&value).map(Some),
    }
}

/// `actor: Optional[str] = "user"`: the default of a body that does not name the actor.
pub(crate) fn user() -> Option<String> {
    Some("user".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_read_as_pydantic_reads_them() {
        assert_eq!(query_int("limit", None, 80).ok(), Some(80));
        assert_eq!(query_int("limit", Some("5"), 80).ok(), Some(5));
        assert_eq!(query_int("limit", Some("-5"), 80).ok(), Some(-5));
        assert_eq!(query_int("limit", Some("+5"), 80).ok(), Some(5));
        assert_eq!(query_int("limit", Some("5.0"), 80).ok(), Some(5));
        for bad in ["", "x", "5.5", "5.", "1e3", "--5"] {
            assert!(query_int("limit", Some(bad), 80).is_err(), "{bad:?}");
        }
        assert_eq!(query_bool("force", None, false).ok(), Some(false));
        assert_eq!(query_bool("force", Some("True"), false).ok(), Some(true));
        assert_eq!(query_bool("force", Some("off"), true).ok(), Some(false));
        assert!(query_bool("force", Some(""), false).is_err());
        assert!(query_bool("force", Some("maybe"), false).is_err());
    }
}
