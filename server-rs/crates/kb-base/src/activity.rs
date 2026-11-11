//! Ticket activity log entries: who changed what, and when.

use serde_json::{Map, Value, json};

use crate::{ctx, pyjson, time};

pub const HUMAN_ACTOR: &str = "user";
pub const AGENT_ACTOR: &str = "agent";
pub const MAX_TEXT: usize = 200;

/// Where the request came from when it is not a person at the board: "mcp" for a tool acting for a person (MCP full
/// control). Recorded with the action, never worked out afterwards.
pub const ORIGINS: [&str; 1] = ["mcp"];

#[derive(Clone)]
struct Actor(String);
/// Set while an AI member acts: `{"member_id", "on_behalf_of", "run_id"}`; every entry then records "AI name, on
/// behalf of person".
#[derive(Clone)]
struct Ai(Option<Value>);
/// Set while a person applies a Board AI draft: entries read "suggested by <AI name>".
#[derive(Clone)]
struct Suggested(Option<String>);
#[derive(Clone)]
struct Origin(Option<String>);

/// Mark the current request as coming through `origin`; returns a token for `ctx::reset`.
pub fn set_origin(origin: Option<&str>) -> ctx::Token {
    ctx::set(Origin(origin.filter(|o| ORIGINS.contains(o)).map(str::to_string)))
}

/// "mcp" when a tool is acting for the person making the current request, else `None`.
pub fn current_origin() -> Option<String> {
    ctx::get::<Origin>().and_then(|o| o.0)
}

/// Mark the changes of the current task as suggested by the Board AI; returns a token for `ctx::reset`.
pub fn set_suggested(name: Option<&str>) -> ctx::Token {
    ctx::set(Suggested(name.map(str::to_string)))
}

/// Mark the current task as acting for an AI member; returns a token for `ctx::reset`.
pub fn set_ai(info: Option<Value>) -> ctx::Token {
    ctx::set(Ai(info))
}

/// The AI member the current task acts for, if any.
pub fn current_ai() -> Option<Value> {
    ctx::get::<Ai>().and_then(|a| a.0)
}

/// Set the actor recorded on activity entries; returns a token for `ctx::reset`. `None` sets no actor, which reads
/// back as the default, as `_actor.set(None)` followed by `actor or current_actor()` does in practice.
pub fn set_actor(name: Option<&str>) -> ctx::Token {
    ctx::set(Actor(name.unwrap_or("").to_string()))
}

/// The actor for the current request or task. Python returns whatever was set, including `None` or an empty
/// string; `raw_actor` gives that, this gives the person's name with the default filled in.
pub fn current_actor() -> String {
    ctx::get::<Actor>().map(|a| a.0).unwrap_or_else(|| HUMAN_ACTOR.to_string())
}

/// Shorten free text so one long note cannot bloat the log (only strings are clipped).
pub fn clip(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(clip_str(&s)),
        other => other,
    }
}

/// `clip` for a string: 200 characters at most, the last one an ellipsis when it was cut.
pub fn clip_str(s: &str) -> String {
    if s.chars().count() > MAX_TEXT {
        let mut out: String = s.chars().take(MAX_TEXT - 1).collect();
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

/// Build one activity-log entry for a field change. `actor` defaults to the current actor and `at` to now.
pub fn entry(
    field: &str,
    from: Value,
    to: Value,
    reference: Option<&str>,
    actor: Option<&str>,
    at: Option<&str>,
) -> Value {
    let mut out = Map::new();
    out.insert("field".into(), json!(field));
    out.insert("from".into(), from);
    out.insert("to".into(), to);
    out.insert("at".into(), json!(at.filter(|a| !a.is_empty()).map(str::to_string).unwrap_or_else(time::now_iso)));
    let actor = match actor.filter(|a| !a.is_empty()) {
        Some(actor) => actor.to_string(),
        None => current_actor(),
    };
    out.insert("actor".into(), json!(actor));
    if let Some(reference) = reference.filter(|r| !r.is_empty()) {
        out.insert("ref".into(), json!(clip_str(reference)));
    }
    if let Some(ai) = current_ai().filter(pyjson::truthy) {
        out.insert("ai".into(), json!(true));
        out.insert("on_behalf_of".into(), ai.get("on_behalf_of").cloned().unwrap_or(Value::Null));
        out.insert("run_id".into(), ai.get("run_id").cloned().unwrap_or(Value::Null));
        out.insert("member_id".into(), ai.get("member_id").cloned().unwrap_or(Value::Null));
    }
    if let Some(suggested) = ctx::get::<Suggested>().and_then(|s| s.0).filter(|s| !s.is_empty()) {
        out.insert("suggested_by".into(), json!(suggested));
    }
    Value::Object(out)
}

/// Append an entry to a ticket's activity log (the JSON text of the `activity_log` column); the caller saves it.
pub fn record(
    activity_log: &mut String,
    field: &str,
    from: Value,
    to: Value,
    reference: Option<&str>,
    actor: Option<&str>,
) {
    let mut log = match serde_json::from_str::<Value>(if activity_log.is_empty() { "[]" } else { activity_log }) {
        Ok(Value::Array(log)) => log,
        _ => Vec::new(),
    };
    log.push(entry(field, clip(from), clip(to), reference, actor, None));
    *activity_log = pyjson::dumps(&Value::Array(log));
}

/// A comment / work-log author is the actor, unless it is just the default.
pub fn author_actor(author: Option<&str>) -> Option<&str> {
    author.filter(|a| !a.is_empty() && *a != HUMAN_ACTOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn entries_carry_the_actor_and_the_ai() {
        ctx::scope(async {
            let e = entry("status", json!("todo"), json!("done"), None, None, Some("t"));
            assert_eq!(
                pyjson::dumps(&e),
                r#"{"field": "status", "from": "todo", "to": "done", "at": "t", "actor": "user"}"#
            );
            let _a = set_actor(Some("Tien"));
            let _ai = set_ai(Some(json!({"member_id": "m1", "on_behalf_of": "Tien", "run_id": "r1"})));
            let mut log = String::from("[]");
            record(&mut log, "title", json!("x".repeat(300)), json!(3), Some("c1"), None);
            let parsed: Value = serde_json::from_str(&log).unwrap();
            let first = &parsed[0];
            assert_eq!(first["actor"], "Tien");
            assert_eq!(first["from"].as_str().unwrap().chars().count(), 200);
            assert_eq!(first["ref"], "c1");
            assert_eq!(first["ai"], true);
            assert_eq!(first["member_id"], "m1");
        })
        .await;
    }
}
