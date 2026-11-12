//! `scope_state` of `services/assistant/chat.py` (lines 309 to 437): the chat panel of a ticket, a page or an idea.

use kb_db::Session;
use serde_json::{Map, Value, json};

use super::{latest_chat, target, ticket_team};
use crate::assistant::engine;
use crate::assistant::errors::{AssistError, Error};
use crate::assistant::settings as svc_settings;

/// The chat panel's state for a ticket, a page or an idea.
pub async fn scope_state(session: &Session, kind: &str, scope_id: &str, by: &str) -> Result<Map<String, Value>, Error> {
    let (project_id, title) = target(session, kind, Some(scope_id)).await?;
    if !matches!(kind, "ticket" | "doc" | "idea") {
        return Err(AssistError::new("not_found", "Nothing to chat about here.").into());
    }
    let project_id = project_id.filter(|p| !p.is_empty());
    let info = match &project_id {
        Some(project_id) => engine::ready(project_id, "chat").await?,
        None => {
            let mut info = Map::new();
            info.insert("state".into(), json!("ready"));
            info.insert("message".into(), json!(""));
            info.insert("member".into(), json!("Board AI"));
            info
        }
    };
    let is_ready = info.get("state").and_then(Value::as_str) == Some("ready");
    let on = svc_settings::feature_on(session, "chat").await?;
    let availability = if !on {
        json!({"code": "feature_off", "message": "Ask AI is off in Settings › AI."})
    } else if is_ready {
        json!({"code": "ok"})
    } else {
        json!({"code": "not_configured", "message": info.get("message")})
    };
    let chat = latest_chat(session, by, kind, Some(scope_id)).await?;
    let reading = match kind {
        "ticket" => json!([
            {"kind": "ticket", "label": "This ticket"},
            {"kind": "comments", "label": "Its comments"},
            {"kind": "docs", "label": "Linked pages"},
        ]),
        "doc" => json!([
            {"kind": "doc", "label": "This page"},
            {"kind": "docs", "label": "Pages it links"},
        ]),
        _ => json!([
            {"kind": "idea", "label": "This idea"},
            {"kind": "ideas", "label": "Related ideas"},
        ]),
    };
    let starting = match kind {
        "ticket" => json!([
            {
                "label": "Summarise this ticket",
                "request": "Summarise this ticket: what is asked, what is done, what is open.",
            },
            {
                "label": "What is left to do here?",
                "request": "What is left to do on this ticket? List what is open and what is unclear.",
            },
            {
                "label": "Who should review this?",
                "request": "Who should review this ticket, and why? Look at who worked on related tickets.",
            },
        ]),
        "doc" => json!([
            {
                "label": "Summarise this page",
                "request": "Summarise this page in five lines.",
            },
            {
                "label": "What is out of date?",
                "request": "What on this page looks out of date compared to the tickets and the code?",
            },
        ]),
        _ => json!([
            {
                "label": "Challenge this idea",
                "request": "Challenge this idea: the weakest assumptions first.",
            },
            {
                "label": "What is the smallest first step?",
                "request": "What is the smallest first step that would test this idea?",
            },
        ]),
    };
    let mut members: Vec<Value> = Vec::new();
    let mut member_id: Option<String> = None;
    if kind == "ticket" {
        if let Some(team) = ticket_team(session, scope_id).await? {
            member_id = Some(team.id.clone());
            members.push(json!({
                "id": team.id,
                "name": team.name,
                "board_ai": false,
                "provider": "claude-code",
                "connection": "local",
                "metered": false,
                "ready": true,
                "status_code": null,
                "status": if team.working { "Working on this ticket" } else { "Idle" },
            }));
        }
    }
    let thing = match kind {
        "ticket" => "ticket",
        "doc" => "page",
        _ => "idea",
    };
    let name = info.get("member").filter(|m| kb_base::pyjson::truthy(m)).cloned().unwrap_or(json!("Board AI"));
    let coded = info.get("code").is_some_and(kb_base::pyjson::truthy);
    let mut out = Map::new();
    out.insert(
        "scope".into(),
        json!({
            "kind": kind,
            "id": scope_id,
            "project_id": project_id.unwrap_or_default(),
            "title": title,
            "reading": reading,
            "starting_points": starting,
            "placeholder": format!("Ask about this {thing}…"),
            "work": false,
            "draft_kinds": [],
        }),
    );
    out.insert("availability".into(), availability);
    out.insert(
        "board_ai".into(),
        json!({
            "name": name,
            "provider_label": "Claude Code",
            "ready": is_ready,
            "label": if coded { "The Board AI is not ready" } else { "Claude Code was not found" },
        }),
    );
    out.insert("members".into(), Value::Array(members));
    out.insert("member_id".into(), json!(member_id));
    out.insert("estimate".into(), Value::Null);
    out.insert("work".into(), json!({"allowed": false, "estimate": null}));
    out.insert("chat_id".into(), json!(chat.map(|c| c.id)));
    Ok(out)
}
