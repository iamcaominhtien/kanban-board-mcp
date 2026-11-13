//! AI teams (AI v2): a team is a Member row of kind "ai" (the assignee, the avatar, the comment author) with an
//! `AiTeam` profile (account, model, pack of roles, config). Its lead runs a ticket as one Claude Code session; the
//! roles of its pack work as subagents (`kb_ai_know::roles`). Port of `services/ai/teams.py`.
//!
//! The Python module is one file; here it is this file (lines 1 to 133: the constants, `TeamError`, names and colours,
//! `check_name`, `_validate`, `_checked_account`) and three more in the order of the Python text: `edit` (135 to 395:
//! `create`, `update`, `set_paused`, `removal_impact`, `remove`), `health` (398 to 526: runner detection and health)
//! and `describe` (529 to 733: a team for the API). Every name of the Python module is `teams::<name>` here too.
//!
//! A team's data arrives as the dict the router makes of its body (`body.model_dump(exclude_unset=True)`): a
//! `serde_json::Map` with only the keys that were sent, so "absent" and "null" stay apart as they do in Python.

use std::collections::HashSet;
use std::sync::LazyLock;

use kb_ai_know::roles;
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_account, member, project};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use regex::Regex;
use serde_json::{Map, Value, json};

mod describe;
mod edit;
mod health;

pub use describe::*;
pub use edit::*;
pub use health::*;

pub use kb_ai::store::get_profile;

/// The avatar colours a new team may take; the first is the default.
pub const AI_COLORS: [&str; 7] = ["#2E6F40", "#6D5DD3", "#2F6FB0", "#B4791E", "#B0446E", "#5B6B60", "#C4432A"];
/// The longest persona (characters).
pub const MAX_PERSONA: usize = 4000;
/// The model names a team may use besides a full model id.
pub const MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
/// The effort levels of Claude Code.
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// How Claude Code answers permission prompts in a team's runs.
pub const PERMISSION_MODES: [&str; 2] = ["bypass", "auto"];
/// how often the scheduler re-detects runners
pub const HEALTH_INTERVAL_S: f64 = 60.0;
/// how often a healthy runner's sign-in is checked again
pub const HEALTH_STALE_S: f64 = 300.0;
/// How old an account's check may be before `health_check` asks its CLI again.
pub const ACCOUNT_STALE_S: f64 = 240.0;

/// What a function of this module fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `TeamError` (a `ValueError`): a request about a team was refused; the message is shown as is.
    #[error("{0}")]
    Team(String),
    /// Any other `ValueError` (a number that is not one, a ticket that refuses its new assignee): the routers answer
    /// it as they answer `TeamError`.
    #[error("{0}")]
    Value(String),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Anything Python lets through as a 500 (the CLI could not be asked, a column that cannot be empty).
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// Whether Python's `except ValueError` catches it (`TeamError` is one).
    pub fn is_value_error(&self) -> bool {
        matches!(self, Error::Team(_) | Error::Value(_))
    }
}

pub(crate) fn refuse<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error::Team(message.into()))
}

/// `data.get(key)` when it is truthy (`data.get(key) or ...`, `if data.get(key):`).
pub(crate) fn truthy<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    data.get(key).filter(|v| pyjson::truthy(v))
}

/// `str(value)`.
pub(crate) fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

/// `int(value)`; a value Python's `int` refuses is its `ValueError`.
pub(crate) fn int_of(value: &Value) -> Result<i128, Error> {
    kb_ai::store::py_int(value).ok_or_else(|| {
        Error::Value(format!("invalid literal for int() with base 10: {}", pytext::repr(&text_of(value))))
    })
}

/// `float(value)`; a value Python's `float` refuses is its `ValueError`.
pub(crate) fn float_of(value: &Value) -> Result<f64, Error> {
    let parsed = match value {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::String(s) => pytext::strip(s).replace('_', "").parse::<f64>().ok(),
        _ => None,
    };
    parsed.ok_or_else(|| Error::Value(format!("could not convert string to float: {}", pytext::repr(&text_of(value)))))
}

/// `_clean_name`: the name with its spaces squeezed, refused when empty or over 80 characters.
pub fn clean_name(name: &str) -> Result<String, Error> {
    let name = pytext::squash(name);
    if name.is_empty() {
        return refuse("Name must not be empty.");
    }
    if name.chars().count() > 80 {
        return refuse("Name must be at most 80 characters.");
    }
    Ok(name)
}

static COLOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#[0-9a-fA-F]{6}$").expect("the colour pattern written in the code compiles"));

/// `_clean_color`: a `#RRGGBB` colour in capitals.
pub fn clean_color(color: &str) -> Result<String, Error> {
    let color = pytext::strip(color);
    if !COLOR.is_match(color) {
        return refuse("Pick one of the avatar colours.");
    }
    Ok(color.to_uppercase())
}

/// Names are unique across people and teams in a project (case and surrounding spaces ignored).
pub async fn check_name(
    session: &Session,
    project_id: &str,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<Map<String, Value>, DbErr> {
    let clean = pytext::squash(name);
    let project = project::Entity::find_by_id(project_id).one(session).await?;
    let rows = member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await?;
    let low = clean.to_lowercase();
    let lowered = |m: &member::Model| pytext::strip(&m.name).to_lowercase();
    let verdict = |ok: bool, conflict: Value, message: Value, suggestion: Value| {
        let mut out = Map::new();
        out.insert("ok".into(), json!(ok));
        out.insert("conflict".into(), conflict);
        out.insert("message".into(), message);
        out.insert("suggestion".into(), suggestion);
        out
    };
    for m in &rows {
        if exclude_id == Some(m.id.as_str()) || m.kind == "ai_removed" {
            continue;
        }
        if lowered(m) == low {
            if m.kind == "ai" {
                let existing: HashSet<String> = rows.iter().map(lowered).collect();
                let mut n = 2;
                while existing.contains(&format!("{low} {n}")) {
                    n += 1;
                }
                return Ok(verdict(
                    false,
                    json!("ai"),
                    json!(format!("Another AI team already uses this name. Try “{clean} {n}”.")),
                    json!(format!("{clean} {n}")),
                ));
            }
            let place = project.as_ref().map_or("this project", |p| p.name.as_str());
            return Ok(verdict(
                false,
                json!("person"),
                json!(format!("“{}” is already a member of {place}.", m.name)),
                Value::Null,
            ));
        }
    }
    Ok(verdict(true, Value::Null, Value::Null, Value::Null))
}

/// `key.replace("_", " ").capitalize()`.
fn label_of(key: &str) -> String {
    let text = key.replace('_', " ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect(),
        None => String::new(),
    }
}

static PACK_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9_-]{1,40}$").expect("the pack key pattern written in the code compiles"));

/// `_validate`: the values of a team's data, each refused with its own sentence.
pub fn validate(data: &Map<String, Value>) -> Result<(), Error> {
    let one_of = |value: &Value, allowed: &[&str]| value.as_str().is_some_and(|v| allowed.contains(&v));
    if let Some(model) = truthy(data, "model") {
        if !one_of(model, &MODELS) && !text_of(model).contains('-') {
            return refuse("The model is haiku, sonnet, opus or a full model id.");
        }
    }
    if truthy(data, "effort").is_some_and(|effort| !one_of(effort, &EFFORTS)) {
        return refuse("The effort is low, medium, high, xhigh or max.");
    }
    if truthy(data, "permission_mode").is_some_and(|mode| !one_of(mode, &PERMISSION_MODES)) {
        return refuse("The permission mode is bypass or auto.");
    }
    if let Some(persona) = truthy(data, "persona") {
        // `len(...)` of the text (or of a list or a dict someone sent in its place)
        let length = match persona {
            Value::String(s) => s.chars().count(),
            Value::Array(items) => items.len(),
            Value::Object(map) => map.len(),
            _ => return Err(Error::Other("TypeError: the persona has no len()".into())),
        };
        if length > MAX_PERSONA {
            return refuse(format!("The persona is at most {MAX_PERSONA} characters."));
        }
    }
    for key in ["max_parallel", "max_runs_per_day", "tokens_per_day"] {
        if let Some(value) = data.get(key).filter(|v| !v.is_null()) {
            if int_of(value)? < 1 {
                return refuse(format!("{} must be at least 1.", label_of(key)));
            }
        }
    }
    for key in ["daily_budget", "monthly_cap", "cap_per_run"] {
        if let Some(value) = data.get(key).filter(|v| !v.is_null()) {
            if float_of(value)? < 0.0 {
                return refuse(format!("{} cannot be negative.", label_of(key)));
            }
        }
    }
    if truthy(data, "scope").is_some_and(|scope| !one_of(scope, &["assigned", "project"])) {
        return refuse("The scope is assigned or project.");
    }
    if let Some(pack_key) = truthy(data, "pack_key") {
        let known = pack_key.as_str().is_some_and(|key| roles::team_pack(key).is_some());
        if !known {
            let Some(key) = pack_key.as_str() else {
                return Err(Error::Other("TypeError: expected string or bytes-like object".into()));
            };
            if !PACK_KEY.is_match(key) {
                return refuse("Unknown pack.");
            }
        }
    }
    if data.get("config").is_some_and(|cfg| !cfg.is_null() && !cfg.is_object()) {
        return refuse("config must be an object.");
    }
    Ok(())
}

/// `_checked_account`: the id of the Claude Code account a team may run as, or None for no account.
pub(crate) async fn checked_account(session: &Session, account_id: Option<&Value>) -> Result<Option<String>, Error> {
    let Some(account_id) = account_id.filter(|id| pyjson::truthy(id)) else {
        return Ok(None);
    };
    let account = ai_account::Entity::find_by_id(text_of(account_id)).one(session).await?;
    let Some(account) = account else {
        return refuse("That AI account does not exist.");
    };
    if account.cli != "claude" {
        return refuse(format!("{} is not a Claude Code account.", account.name));
    }
    Ok(Some(account.id))
}
