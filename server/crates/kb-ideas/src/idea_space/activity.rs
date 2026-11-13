//! `services/idea_space.py`, lines 1142-1220: the idea's activity list, and what a list row warns about.

use chrono::Utc;
use kb_base::time;
use serde_json::Value;

use super::{get, json_or};
use crate::error::{Error, value_error};
use crate::model::{Idea, idea_readiness};

/// An idea in Exploring or Ready is stale after this many days (`STALE_DAYS`).
pub const STALE_DAYS: i64 = 30;
/// An idea waits too long in the Inbox after this many days (`WAITING_DAYS`).
pub const WAITING_DAYS: i64 = 14;

/// The filters of the activity list, with the entry kinds each shows (`ACTIVITY_FILTERS`); `ai` shows the entries
/// made by an AI member whatever their kind.
pub const ACTIVITY_FILTERS: [&str; 6] = ["stage", "assumptions", "evidence", "page", "ai", "links"];

/// The kinds a filter shows.
fn kinds_of(filter: &str) -> &'static [&'static str] {
    match filter {
        "stage" => &["stage", "created", "merge"],
        "assumptions" => &["assumption"],
        "evidence" => &["evidence"],
        "page" => &["page"],
        "links" => &["project", "link"],
        _ => &[],
    }
}

/// The idea's activity, newest first; `filter` is one of `ACTIVITY_FILTERS`.
pub fn activity(idea: &Idea, filter: Option<&str>) -> Result<Vec<Value>, Error> {
    if let Some(filter) = filter {
        if !ACTIVITY_FILTERS.contains(&filter) {
            return value_error(format!("filter must be one of: {}", ACTIVITY_FILTERS.join(", ")));
        }
    }
    let mut items = match json_or(&idea.row.activity_trail, Value::Array(Vec::new())) {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    items.reverse();
    Ok(match filter {
        Some("ai") => items.into_iter().filter(|i| kb_base::pyjson::truthy(get(i, "ai"))).collect(),
        Some(filter) => {
            let wanted = kinds_of(filter);
            items.into_iter().filter(|i| get(i, "kind").as_str().is_some_and(|k| wanted.contains(&k))).collect()
        }
        None => items,
    })
}

/// `(now - datetime.fromisoformat(text)).days`, 0 where the text is not a time.
fn age_days(now: chrono::DateTime<Utc>, text: &str) -> i64 {
    match time::parse_iso(text) {
        Some(parsed) => {
            let micros = (now - parsed.utc()).num_microseconds().unwrap_or(i64::MAX);
            micros.div_euclid(86_400_000_000)
        }
        None => 0,
    }
}

/// Badges for a list row: stale, waiting too long in the Inbox, parked due, at risk.
pub fn warnings(idea: &Idea) -> Vec<String> {
    let mut out = Vec::new();
    let now = Utc::now();
    let changed = if idea.row.updated_at.is_empty() { &idea.row.created_at } else { &idea.row.updated_at };
    let age = age_days(now, changed);
    if ["exploring", "ready"].contains(&idea.row.stage.as_str()) && age >= STALE_DAYS {
        out.push(format!("stale:{age}"));
    }
    if idea.row.stage == "inbox" {
        let waited = age_days(now, &idea.row.created_at);
        if waited >= WAITING_DAYS {
            out.push(format!("waiting:{waited}"));
        }
    }
    if idea_readiness(idea.assumptions())["state"] == "at_risk" {
        out.push("at_risk".to_string());
    }
    out
}
