//! What a run's hooks tell the board (AI v2): `POST /ai/hooks` with the run's bearer token and the hook's JSON
//! (`api/ai_hooks.py`).
//!
//! The board's plugin (`kb_ai_run::launch`) runs on PreToolUse (the one safety rule), PostToolUse (the plan the lead
//! keeps) and Stop; each posts the hook input here. The stream is the source of steps and of the roles' starts and ends
//! (its `task_*` events); hooks add what it lacks and never block the AI.
//!
//! The file also serves what the runner process posts (`POST /internal/ai/events`) and where the CLIs run
//! (`GET /ai/runner`).

use axum::Json;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use kb_ai::{guard, runner_link, steps};
use kb_base::{ApiResult, Routes, events, pyjson, pytext};
use serde_json::{Map, Value, json};

use super::ai_accounts::{client_host, is_local};

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .post("/ai/hooks", post_hook)
        .post("/internal/ai/events", post_internal_event)
        .get("/ai/runner", get_runner_status)
}

/// A header as Starlette reads it (latin-1), or None when it was not sent.
fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).map(|v| v.as_bytes().iter().map(|b| *b as char).collect())
}

fn ignored(why: &str) -> Response {
    Json(json!({"ignored": why})).into_response()
}

/// `(authorization or "").split(None, 1)[1].strip()` when the header starts with `bearer ` (any case), else "".
fn bearer_token(authorization: Option<&str>) -> String {
    let auth = authorization.unwrap_or("");
    if !auth.to_lowercase().starts_with("bearer ") {
        return String::new();
    }
    let rest = auth.trim_start_matches(pytext::is_space);
    let rest = rest.trim_start_matches(|c: char| !pytext::is_space(c));
    pytext::strip(rest).to_string()
}

/// A hook event of a run. Unknown events and bad tokens answer 200 with `ignored`, so a hook never fails.
async fn post_hook(headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let token = bearer_token(header(&headers, "authorization").as_deref());
    if !token.starts_with("kbr_") {
        return Ok(ignored("no token"));
    }
    let ctx = match guard::context_for_token(&token).await {
        Ok(ctx) => ctx,
        Err(guard::Error::Action(_)) => return Ok(ignored("run ended")),
        Err(guard::Error::Db(err)) => return Err(err.into()),
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body) else { return Ok(ignored("not json")) };
    let Value::Object(body) = body else { return Ok(ignored("not an object")) };
    let name = match body.get("hook_event_name").filter(|v| pyjson::truthy(v)) {
        Some(Value::String(s)) => s.clone(),
        Some(other) => pyjson::py_str(other),
        None => String::new(),
    };
    let tool = body.get("tool_name").cloned().unwrap_or(Value::Null);
    let inp = match body.get("tool_input") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut rows: Vec<Value> = Vec::new();
    if name == "SubagentStart" || name == "SubagentStop" {
        // A role's start, work and end come from the stream's own task events (`kb_ai_run::stream`), which need no hook.
        return Ok(ignored("roles come from the stream"));
    } else if name == "PostToolUse" && matches!(tool.as_str(), Some("TaskCreate" | "TaskUpdate" | "TodoWrite")) {
        let title = ["subject", "description", "status"]
            .iter()
            .find_map(|key| inp.get(*key).filter(|v| pyjson::truthy(v)))
            .unwrap_or(&tool);
        let title = match title {
            Value::String(s) => s.clone(),
            other => pyjson::py_str(other),
        };
        rows.push(json!({
            "kind": "plan",
            "title": title.chars().take(200).collect::<String>(),
            "tool": tool,
            "detail": {"input": inp, "hook": true},
        }));
    } else if name == "Stop" {
        rows.push(json!({
            "kind": "hook",
            "title": "The lead ended its turn",
            "detail": {"hook_event_name": name},
        }));
    } else {
        return Ok(ignored(if name.is_empty() { "unknown" } else { &name }));
    }
    // a hook never fails the run
    if let Err(err) = steps::append(&ctx.run_id, rows, steps::Extras::default()).await {
        tracing::error!(target: "kanban.ai.hooks", "hook of run {} not recorded: {err}", ctx.run_id);
    }
    Ok(Json(json!({"ok": true})).into_response())
}

/// `hmac.compare_digest(a, b)`: equal, in a time that does not depend on where they differ.
fn same_text(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// An event from the runner process, broadcast to the SSE subscribers of this API.
async fn post_internal_event(headers: HeaderMap, body: Bytes) -> Response {
    let given = header(&headers, "x-kanban-internal").unwrap_or_default();
    if given.is_empty() || !same_text(&given, runner_link::TOKEN.as_str()) {
        return (StatusCode::FORBIDDEN, Json(json!({"detail": "Not the runner"}))).into_response();
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else { return ignored("not json") };
    let Some(event) = body.as_object().and_then(|b| b.get("event")).and_then(Value::as_str) else {
        return ignored("no event");
    };
    events::broadcast_raw(event);
    Json(json!({"ok": true})).into_response()
}

/// Where the CLIs run (this process or the runner process), whether the runner is alive, and what computer it is:
/// the name, the system and the app version, whether this request comes from it, and whether Claude Code is there.
async fn get_runner_status(headers: HeaderMap) -> Json<Map<String, Value>> {
    let host = client_host(&headers);
    let (path, _) = kb_ai_run::cli::find_cli("claude", None).await;
    let platform = if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        std::env::consts::OS
    };
    let mut out = runner_link::status();
    out.insert("host".into(), json!(kb_ai_run::runner::host_name()));
    out.insert("local".into(), json!(is_local(&host)));
    out.insert("platform".into(), json!(platform));
    out.insert("app_version".into(), json!(kb_base::version::APP_VERSION));
    out.insert("claude_found".into(), json!(path.is_some_and(|p| !p.is_empty())));
    Json(out)
}
