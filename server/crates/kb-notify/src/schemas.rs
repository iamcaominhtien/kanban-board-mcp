//! The request models of `api/notifications.py`, and the query-string reader that answers a bad value the way
//! FastAPI does (a 422 whose detail lists `{type, loc, msg, input}` for every parameter that failed).

use kb_base::ApiError;
use serde::Deserialize;
use serde_json::{Value, json};

/// `kind` of `ReadBody`: one kind or a list of kinds.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum KindField {
    /// `"kind": "mention"`.
    One(String),
    /// `"kind": ["mention", "question"]`.
    Many(Vec<String>),
}

/// Rows to mark read: `ids`, or `all` (of a `tab`, and narrowed by the All notifications page's filters, with the
/// same names and meaning as `GET /notifications?view=page`).
#[derive(Debug, Clone, Deserialize)]
pub struct ReadBody {
    /// Ids of the rows to mark read.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// Every row of the tab (narrowed by the filters).
    #[serde(default)]
    pub all: bool,
    /// needs | updates.
    #[serde(default)]
    pub tab: Option<String>,
    /// The page's filter.
    #[serde(default)]
    pub filter: Option<String>,
    /// Search text.
    #[serde(default)]
    pub q: Option<String>,
    /// Only this project.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Only these kinds.
    #[serde(default)]
    pub kind: Option<KindField>,
    /// ai | people | schedules | info | needs | docs.
    #[serde(default)]
    pub family: Option<String>,
    /// Only rows moved in the last this many days.
    #[serde(default)]
    pub days: Option<i64>,
}

/// What the person opened.
#[derive(Debug, Clone, Deserialize)]
pub struct OpenedBody {
    /// ticket, page, run...
    pub target_kind: String,
    /// Its id.
    pub target_id: String,
}

/// Until when a row is hidden.
#[derive(Debug, Clone, Deserialize)]
pub struct SnoozeBody {
    /// UTC or offset ISO time; `null` brings it back now.
    #[serde(default)]
    pub until: Option<String>,
}

fn yes() -> bool {
    true
}

/// Clear or put back.
#[derive(Debug, Clone, Deserialize)]
pub struct ClearBody {
    /// `false` puts a cleared row back.
    #[serde(default = "yes")]
    pub on: bool,
}

/// A follow or a mute.
#[derive(Debug, Clone, Deserialize)]
pub struct FollowBody {
    /// ticket | page | space | project | kind.
    pub scope: String,
    /// Its id.
    pub scope_id: String,
    /// follow | everything | mentions | mute; `null` forgets.
    #[serde(default)]
    pub level: Option<String>,
    /// A kind muted in one project only.
    #[serde(default)]
    pub project_id: Option<String>,
    /// "Mute for 1 hour".
    #[serde(default)]
    pub minutes: Option<i64>,
    /// What the Muted list shows.
    #[serde(default)]
    pub label: String,
}

/// The query string of a request: parameters are read one by one, and every failure is kept so the 422 lists them
/// all, as FastAPI's does.
pub struct Params {
    pairs: Vec<(String, String)>,
    errors: Vec<Value>,
}

impl Params {
    /// Read a raw query string.
    pub fn new(raw: Option<&str>) -> Self {
        let pairs = url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()).into_owned().collect();
        Self { pairs, errors: Vec::new() }
    }

    /// The last value given for `name` (the one Starlette keeps).
    pub fn get(&self, name: &str) -> Option<String> {
        self.pairs.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    /// `name: Optional[str] = None`.
    pub fn opt(&self, name: &str) -> Option<String> {
        self.get(name)
    }

    /// `name: str = default`.
    pub fn text(&self, name: &str, default: &str) -> String {
        self.get(name).unwrap_or_else(|| default.to_string())
    }

    /// `name: str` (required).
    pub fn required(&mut self, name: &str) -> String {
        match self.get(name) {
            Some(v) => v,
            None => {
                self.errors
                    .push(json!({"type": "missing", "loc": ["query", name], "msg": "Field required", "input": null}));
                String::new()
            }
        }
    }

    /// `name: Optional[list[str]] = None`.
    pub fn many(&self, name: &str) -> Option<Vec<String>> {
        let all: Vec<String> = self.pairs.iter().filter(|(k, _)| k == name).map(|(_, v)| v.clone()).collect();
        if all.is_empty() { None } else { Some(all) }
    }

    /// `name: Optional[int] = None`.
    pub fn opt_int(&mut self, name: &str) -> Option<i64> {
        let value = self.get(name)?;
        match parse_int(&value) {
            Some(n) => Some(n),
            None => {
                self.errors.push(json!({
                    "type": "int_parsing",
                    "loc": ["query", name],
                    "msg": "Input should be a valid integer, unable to parse string as an integer",
                    "input": value,
                }));
                None
            }
        }
    }

    /// `name: int = default`.
    pub fn int(&mut self, name: &str, default: i64) -> i64 {
        self.opt_int(name).unwrap_or(default)
    }

    /// `name: bool = default`.
    pub fn boolean(&mut self, name: &str, default: bool) -> bool {
        let Some(value) = self.get(name) else {
            return default;
        };
        match value.trim().to_lowercase().as_str() {
            "1" | "on" | "t" | "true" | "y" | "yes" => true,
            "0" | "off" | "f" | "false" | "n" | "no" => false,
            _ => {
                self.errors.push(json!({
                    "type": "bool_parsing",
                    "loc": ["query", name],
                    "msg": "Input should be a valid boolean, unable to interpret input",
                    "input": value,
                }));
                default
            }
        }
    }

    /// The 422 FastAPI answers when a parameter failed, or `Ok`.
    #[allow(clippy::result_large_err)] // `ApiError` is the foundation's error type, and every handler returns it
    pub fn finish(self) -> Result<(), ApiError> {
        if self.errors.is_empty() { Ok(()) } else { Err(ApiError::unprocessable(Value::Array(self.errors))) }
    }
}

/// What pydantic's lax `int` makes of a query value.
fn parse_int(text: &str) -> Option<i64> {
    let t = text.trim();
    if let Ok(n) = t.parse::<i64>() {
        return Some(n);
    }
    let f: f64 = t.parse().ok()?;
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e18 { Some(f as i64) } else { None }
}
