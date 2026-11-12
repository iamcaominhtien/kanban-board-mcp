//! The request models of the core ticket routes: `TicketCreateBody` and `TicketUpdate` (`models.py`), and
//! `StatusBody` and the two upload answers declared in `api/tickets.py`. `TicketRead` is in `crate::schemas`.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};

/// A `Literal[...]` of strings: an enum that reads and shows the exact values.
macro_rules! literal {
    ($(#[$doc:meta])* $name:ident { $($variant:ident => $text:literal),* $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant,)*
        }

        impl $name {
            /// The value as it is stored.
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text,)*
                }
            }
        }
    };
}

literal! {
    /// `Literal["bug", "feature", "task", "chore", "story"]`.
    TicketType { Bug => "bug", Feature => "feature", Task => "task", Chore => "chore", Story => "story" }
}

literal! {
    /// `Literal["low", "medium", "high", "critical"]`.
    TicketPriority { Low => "low", Medium => "medium", High => "high", Critical => "critical" }
}

literal! {
    /// `Literal["backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"]`.
    TicketStatus {
        Backlog => "backlog",
        Todo => "todo",
        InProgress => "in-progress",
        Review => "review",
        Testing => "testing",
        Done => "done",
        WontDo => "wont_do",
    }
}

fn default_type() -> TicketType {
    TicketType::Task
}

fn default_priority() -> TicketPriority {
    TicketPriority::Medium
}

fn default_status() -> TicketStatus {
    TicketStatus::Backlog
}

/// Request body to create a ticket in a project.
#[derive(Debug, Clone, Deserialize)]
pub struct TicketCreateBody {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_type")]
    pub r#type: TicketType,
    #[serde(default = "default_priority")]
    pub priority: TicketPriority,
    #[serde(default = "default_status")]
    pub status: TicketStatus,
    #[serde(default)]
    pub estimate: Option<f64>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub tags: Vec<Value>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
}

/// A field that was sent, with its value or null (`Some(None)`); a field left out stays `None`.
fn sent<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `Optional[int]` as Pydantic reads a JSON value: a whole number, also written as a float (`3.0`) or a bool.
fn sent_int<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<i64>>, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::Null => Ok(Some(None)),
        Value::Bool(flag) => Ok(Some(Some(i64::from(flag)))),
        Value::Number(n) => {
            if let Some(whole) = n.as_i64() {
                return Ok(Some(Some(whole)));
            }
            match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => Ok(Some(Some(f as i64))),
                _ => Err(D::Error::custom("Input should be a valid integer, got a number with a fractional part")),
            }
        }
        _ => Err(D::Error::custom("Input should be a valid integer")),
    }
}

/// The fields of `TicketUpdate`, each one absent, null or a value of its type.
#[derive(Debug, Default, Deserialize)]
struct TicketUpdateFields {
    #[serde(default, deserialize_with = "sent")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    r#type: Option<Option<TicketType>>,
    #[serde(default, deserialize_with = "sent")]
    status: Option<Option<TicketStatus>>,
    #[serde(default, deserialize_with = "sent")]
    priority: Option<Option<TicketPriority>>,
    #[serde(default, deserialize_with = "sent")]
    estimate: Option<Option<f64>>,
    #[serde(default, deserialize_with = "sent")]
    due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    tags: Option<Option<Vec<Value>>>,
    #[serde(default, deserialize_with = "sent")]
    parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    wont_do_reason: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    assignee: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    block_done_if_acs_incomplete: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    block_done_if_tcs_incomplete: Option<Option<bool>>,
    /// empty/null clears the ticket override
    #[serde(default, deserialize_with = "sent")]
    repo_path: Option<Option<String>>,
    /// a sub-ticket's wave pinned by hand; null: computed from Blocked by again (TDP-1)
    #[serde(default, deserialize_with = "sent_int")]
    wave_pin: Option<Option<i64>>,
    /// who the review is asked of (member id); null clears it
    #[serde(default, deserialize_with = "sent")]
    review_requested_from: Option<Option<String>>,
}

/// Partial update of a ticket: `fields` is `model_dump(exclude_unset=True)`, the fields that were sent (a null
/// included), in the order the model declares them. Anything else in the body is dropped.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TicketUpdate {
    pub fields: Map<String, Value>,
}

impl TicketUpdate {
    /// `TicketUpdate(status=status)`.
    pub fn status(status: &str) -> Self {
        Self::of("status", json!(status))
    }

    /// `TicketUpdate(**{field: value})`: one field. The caller gives a value of the field's type.
    pub fn of(field: &str, value: Value) -> Self {
        let mut fields = Map::new();
        fields.insert(field.to_string(), value);
        Self { fields }
    }
}

impl<'de> Deserialize<'de> for TicketUpdate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let f = TicketUpdateFields::deserialize(deserializer)?;
        let mut fields = Map::new();
        let mut put = |name: &str, value: Option<Value>| {
            if let Some(value) = value {
                fields.insert(name.to_string(), value);
            }
        };
        put("title", f.title.map(|v| json!(v)));
        put("description", f.description.map(|v| json!(v)));
        put("type", f.r#type.map(|v| json!(v.map(TicketType::as_str))));
        put("status", f.status.map(|v| json!(v.map(TicketStatus::as_str))));
        put("priority", f.priority.map(|v| json!(v.map(TicketPriority::as_str))));
        put("estimate", f.estimate.map(|v| json!(v)));
        put("due_date", f.due_date.map(|v| json!(v)));
        put("start_date", f.start_date.map(|v| json!(v)));
        put("tags", f.tags.map(|v| json!(v)));
        put("parent_id", f.parent_id.map(|v| json!(v)));
        put("wont_do_reason", f.wont_do_reason.map(|v| json!(v)));
        put("assignee", f.assignee.map(|v| json!(v)));
        put("block_done_if_acs_incomplete", f.block_done_if_acs_incomplete.map(|v| json!(v)));
        put("block_done_if_tcs_incomplete", f.block_done_if_tcs_incomplete.map(|v| json!(v)));
        put("repo_path", f.repo_path.map(|v| json!(v)));
        put("wave_pin", f.wave_pin.map(|v| json!(v)));
        put("review_requested_from", f.review_requested_from.map(|v| json!(v)));
        Ok(Self { fields })
    }
}

/// Request body to change a ticket's status.
#[derive(Debug, Clone, Deserialize)]
pub struct StatusBody {
    pub status: TicketStatus,
}

/// Stored URL and Markdown alt text of an uploaded image.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DescriptionImageUploadResponse {
    pub url: String,
    pub markdown: String,
    pub filename: String,
    pub content_type: String,
    pub size: usize,
}

/// Stored URL, name and size of an uploaded file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AttachmentUploadResponse {
    pub id: String,
    pub url: String,
    pub name: String,
    pub size: usize,
    pub r#type: String,
    pub markdown: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_update_keeps_what_was_sent_in_the_order_of_the_model() {
        let body = r#"{"tags": ["a"], "wont_do_reason": null, "status": "done", "title": "T", "estimate": 2,
                       "wave_pin": 3.0, "nope": 1}"#;
        let update: TicketUpdate = serde_json::from_str(body).unwrap();
        let keys: Vec<&str> = update.fields.keys().map(String::as_str).collect();
        assert_eq!(keys, ["title", "status", "estimate", "tags", "wont_do_reason", "wave_pin"]);
        assert_eq!(update.fields["wont_do_reason"], Value::Null);
        // a float column: `2` is stored and logged as `2.0`
        assert_eq!(kb_base::pyjson::dumps(&update.fields["estimate"]), "2.0");
        assert_eq!(update.fields["wave_pin"], json!(3));
        assert_eq!(serde_json::from_str::<TicketUpdate>("{}").unwrap(), TicketUpdate::default());
        assert_eq!(kb_base::pyjson::dumps(&TicketUpdate::status("done").fields), r#"{"status": "done"}"#);
    }

    #[test]
    fn a_value_of_the_wrong_kind_is_refused() {
        for body in [
            r#"{"status": "closed"}"#,
            r#"{"type": 3}"#,
            r#"{"title": ["x"]}"#,
            r#"{"tags": "a"}"#,
            r#"{"wave_pin": 2.5}"#,
            r#"{"wave_pin": "x"}"#,
            r#"{"block_done_if_acs_incomplete": "maybe"}"#,
        ] {
            assert!(serde_json::from_str::<TicketUpdate>(body).is_err(), "{body}");
        }
        assert!(serde_json::from_str::<TicketCreateBody>(r#"{"title": "t", "tags": null}"#).is_err());
        assert!(serde_json::from_str::<TicketCreateBody>(r#"{"description": "no title"}"#).is_err());
        let body: TicketCreateBody = serde_json::from_str(r#"{"title": "t"}"#).unwrap();
        assert_eq!((body.r#type.as_str(), body.priority.as_str(), body.status.as_str()), ("task", "medium", "backlog"));
    }
}
