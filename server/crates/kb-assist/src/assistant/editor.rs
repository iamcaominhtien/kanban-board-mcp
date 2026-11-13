//! AI in every editor on the assistant engine (AI v2): the /ai menu and the selection bar. A request is one turn
//! with the `editor-write` skill; its result is held (`assistant::drafts`) until the person accepts it into their
//! text or discards it. Nothing is written for them, except an accepted list of criteria added to the ticket
//! (`services/assistant/editor.py`, lines 1 to 382).

use kb_ai::store::now_iso;
use kb_base::{ctx, events, pyjson, pytext};
use kb_board::tickets;
use kb_db::Session;
use kb_db::database;
use serde_json::{Map, Value, json};

use super::engine::{self, TurnOpts};
use super::errors::{AssistError, Error};
use super::{drafts, settings as svc_settings};

/// `ACTIONS`: action -> (label, hint, what the result is, the skill's action).
pub const ACTIONS: [(&str, &str, &str, &str, &str); 11] = [
    ("improve", "Improve", "Clearer and tighter, same meaning", "replace", "rewrite"),
    ("shorten", "Shorten", "The same, in fewer words", "replace", "shorten"),
    ("fix_spelling", "Fix spelling", "Spelling and grammar only", "replace", "fix"),
    ("explain", "Explain", "In plain words, as an answer", "answer", "custom"),
    ("ask", "Ask AI…", "Write from a prompt, with this page as context", "replace", "write"),
    ("continue", "Continue writing", "Carry on from the cursor", "insert", "continue"),
    ("summarise", "Summarise", "The text above, as a short list", "insert", "summarise"),
    ("criteria", "Draft acceptance criteria", "From this description (tickets only)", "list", "list_criteria"),
    ("translate", "Translate…", "The paragraph above", "replace", "translate"),
    ("split", "Split", "One criterion into several", "list", "list_criteria"),
    ("more_criteria", "Draft more", "Criteria that are not covered yet", "list", "list_criteria"),
];
/// `BAR`: the selection bar of most editors.
pub const BAR: [&str; 5] = ["improve", "shorten", "fix_spelling", "explain", "ask"];

/// What one editor offers.
pub struct Surface {
    /// The editor's name in the UI.
    pub key: &'static str,
    /// What the UI calls it.
    pub label: &'static str,
    /// The /ai menu.
    pub menu: &'static [&'static str],
    /// The selection bar.
    pub bar: &'static [&'static str],
}

/// `SURFACES`: the editors that have AI.
pub const SURFACES: [Surface; 7] = [
    Surface {
        key: "ticket_description",
        label: "Ticket description",
        menu: &["ask", "continue", "summarise", "criteria", "translate"],
        bar: &BAR,
    },
    Surface {
        key: "acceptance_criteria",
        label: "Acceptance criteria",
        menu: &["improve", "split", "more_criteria"],
        bar: &["improve", "split"],
    },
    Surface { key: "comment", label: "Comment box", menu: &["improve", "translate", "summarise"], bar: &BAR },
    Surface { key: "doc", label: "Docs page", menu: &["ask", "continue", "summarise", "translate"], bar: &BAR },
    Surface { key: "idea", label: "Idea page", menu: &["ask", "continue", "summarise", "translate"], bar: &BAR },
    Surface {
        key: "debug_note",
        label: "Debug notes",
        menu: &["improve", "summarise", "translate"],
        bar: &["improve", "summarise", "translate"],
    },
    Surface {
        key: "test_case",
        label: "Test case note",
        menu: &["ask", "continue", "summarise", "translate"],
        bar: &BAR,
    },
];
/// The editors of pages (they use the Docs AI switch and team).
pub const DOC_SURFACES: [&str; 2] = ["doc", "idea"];
/// The longest selection, in characters.
pub const MAX_SELECTION: usize = 12000;
/// How much text around the cursor is sent.
pub const MAX_AROUND: usize = 2000;
/// The longest instruction.
pub const MAX_PROMPT: usize = 2000;
/// What an action adds to the instruction.
pub const EXTRA: [(&str, &str); 3] = [
    ("explain", "Explain the selection in plain words, as an answer (do not rewrite it)."),
    ("split", "Split the selected criterion into several smaller criteria."),
    ("more_criteria", "Draft acceptance criteria that the existing ones (in `before`) do not cover yet."),
];

/// `ACTIONS[action]`.
fn action_of(action: &str) -> Option<&'static (&'static str, &'static str, &'static str, &'static str, &'static str)> {
    ACTIONS.iter().find(|a| a.0 == action)
}

/// `_info`.
fn info(action: &str) -> Value {
    let (_, label, hint, result, _skill_action) = action_of(action).copied().unwrap_or(("", "", "", "", ""));
    json!({"action": action, "label": label, "hint": hint, "result": result})
}

/// `_surface`.
fn surface(name: &str) -> Result<&'static Surface, AssistError> {
    SURFACES.iter().find(|s| s.key == name).ok_or_else(|| AssistError::new("invalid", "Unknown editor."))
}

/// `body.get(key) or ""` as text.
fn text(body: &Map<String, Value>, key: &str) -> String {
    match body.get(key).filter(|v| pyjson::truthy(v)) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => pyjson::py_str(other),
        None => String::new(),
    }
}

/// `feature` of a surface: pages use the Docs AI switch.
fn feature_of(surface: &str) -> &'static str {
    if DOC_SURFACES.contains(&surface) { "docs" } else { "drafting" }
}

/// Whether AI is available in this editor, its /ai menu and its selection bar.
pub async fn state(session: &Session, project_id: &str, surface_name: &str) -> Result<Map<String, Value>, Error> {
    let spec = surface(surface_name)?;
    let feature = feature_of(surface_name);
    let ready = engine::ready(project_id, "chat").await?;
    let availability = if !svc_settings::feature_on(session, feature).await? {
        json!({"code": "feature_off", "message": "AI in editors is off in Settings › AI."})
    } else if ready.get("state").and_then(Value::as_str) != Some("ready") {
        json!({"code": "not_configured", "message": ready.get("message").cloned().unwrap_or(Value::Null)})
    } else {
        json!({"code": "ok"})
    };
    let mut out = Map::new();
    out.insert("surface".into(), json!(surface_name));
    out.insert("label".into(), json!(spec.label));
    out.insert("availability".into(), availability);
    out.insert("menu".into(), Value::Array(spec.menu.iter().map(|a| info(a)).collect()));
    out.insert("bar".into(), Value::Array(spec.bar.iter().map(|a| info(a)).collect()));
    out.insert("estimate".into(), Value::Null);
    out.insert("member_id".into(), Value::Null);
    Ok(out)
}

/// `_check`: the request, or why it cannot be taken.
fn check(body: &Map<String, Value>) -> Result<(), AssistError> {
    let spec = surface(&text(body, "surface"))?;
    let action = text(body, "action");
    if action_of(&action).is_none() || !(spec.menu.contains(&action.as_str()) || spec.bar.contains(&action.as_str())) {
        return Err(AssistError::new("invalid", "This editor does not offer that."));
    }
    let selection = text(body, "selection");
    let prompt = text(body, "prompt");
    if selection.chars().count() > MAX_SELECTION {
        return Err(AssistError::new("too_large", "The selection is too long: select less text."));
    }
    if prompt.chars().count() > MAX_PROMPT {
        return Err(AssistError::new("too_large", format!("Keep the instruction under {MAX_PROMPT} characters.")));
    }
    if action == "ask" && pytext::strip(&prompt).is_empty() {
        return Err(AssistError::new("invalid", "Write what you want first."));
    }
    if matches!(action.as_str(), "improve" | "shorten" | "fix_spelling" | "explain" | "split")
        && pytext::strip(&selection).is_empty()
    {
        return Err(AssistError::new("invalid", "Select some text first."));
    }
    Ok(())
}

/// The last `n` characters.
fn tail(text: &str, n: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(n)).collect()
}

/// The first `n` characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `include.get(key, True)`.
fn included(include: &Map<String, Value>, key: &str) -> bool {
    include.get(key).is_none_or(pyjson::truthy)
}

/// `body.get("include") or {}`.
fn include_of(body: &Map<String, Value>) -> Map<String, Value> {
    match body.get("include") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// "What will be sent": the pieces of this request. The assistant may also read the ticket or the page itself.
pub fn preview(body: &Map<String, Value>) -> Result<Map<String, Value>, AssistError> {
    check(body)?;
    let action = text(body, "action");
    let label = action_of(&action).map_or("", |a| a.1);
    let prompt = text(body, "prompt");
    let mut pieces: Vec<Value> = Vec::new();
    let candidates = [
        ("instruction", "Your instruction", if prompt.is_empty() { label.to_string() } else { prompt }),
        ("selection", "Selected text", text(body, "selection")),
        ("before", "Text before the cursor", tail(&text(body, "before"), MAX_AROUND)),
        ("after", "Text after the cursor", head(&text(body, "after"), MAX_AROUND)),
    ];
    for (kind, label, body_text) in candidates {
        if !body_text.is_empty() {
            let chars = body_text.chars().count();
            pieces.push(json!({
                "kind": kind,
                "label": label,
                "chars": chars,
                "tokens": chars / 4 + 1,
                "preview": head(&body_text, 200),
            }));
        }
    }
    let include = include_of(body);
    if body.get("ticket_id").is_some_and(pyjson::truthy) && included(&include, "ticket") {
        pieces.push(json!({
            "kind": "ticket",
            "label": format!("Ticket {} (read by the assistant)", text(body, "ticket_id")),
            "chars": 0,
            "tokens": 0,
            "preview": "",
        }));
    }
    if (body.get("doc_id").is_some_and(pyjson::truthy) || body.get("idea_id").is_some_and(pyjson::truthy))
        && included(&include, "page")
    {
        pieces.push(json!({
            "kind": "page",
            "label": "This page (read by the assistant)",
            "chars": 0,
            "tokens": 0,
            "preview": "",
        }));
    }
    let tokens: i64 = pieces.iter().map(|p| p["tokens"].as_i64().unwrap_or(0)).sum();
    let mut out = Map::new();
    out.insert("pieces".into(), Value::Array(pieces));
    out.insert("tokens".into(), json!(tokens));
    out.insert("estimate".into(), Value::Null);
    out.insert("private_skipped".into(), json!([]));
    out.insert("never_sent".into(), json!(["Passwords, API keys and files outside the board"]));
    Ok(out)
}

/// Ask for a draft: it is written in the background (poll it); the text is not touched.
pub async fn start(
    session: &Session,
    project_id: &str,
    body: &Map<String, Value>,
    by: &str,
) -> Result<Map<String, Value>, Error> {
    check(body)?;
    let surface_name = text(body, "surface");
    let feature = feature_of(&surface_name);
    if !svc_settings::feature_on(session, feature).await? {
        return Err(AssistError::new("feature_off", "AI in editors is off in Settings › AI.").into());
    }
    let ready = engine::ready(project_id, "chat").await?;
    if ready.get("state").and_then(Value::as_str) != Some("ready") {
        let message = ready.get("message").map(|m| m.as_str().map_or_else(|| pyjson::py_str(m), str::to_string));
        return Err(AssistError::new("not_configured", message.unwrap_or_default()).into());
    }
    let ticket_id = body.get("ticket_id").filter(|v| pyjson::truthy(v)).and_then(Value::as_str);
    let doc_id = body.get("doc_id").filter(|v| pyjson::truthy(v)).and_then(Value::as_str);
    let payload = json!({"input": body, "action": body.get("action"), "result": null});
    let kind = if DOC_SURFACES.contains(&surface_name.as_str()) { "editor_doc" } else { "editor" };
    let more = drafts::NewDraft { ticket_id, doc_id, ..Default::default() };
    let draft = drafts::new(project_id, kind, by, payload, more);
    let draft_id = text(&draft, "id");
    let id = draft_id.clone();
    drafts::track(&draft_id, ctx::spawn(async move { write(&id, feature, "").await }));
    Ok(draft)
}

/// `_items`: the lines of an answer as a list, without bullets, boxes or numbers.
pub fn items(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in pytext::splitlines(text) {
        let bare = pytext::strip(line).trim_start_matches(['-', '*', '•']);
        let mut line = pytext::strip(bare).to_string();
        let first3: String = line.chars().take(3).collect::<String>().to_lowercase();
        if first3 == "[ ]" || first3 == "[x]" {
            line = pytext::strip(&line.chars().skip(3).collect::<String>()).to_string();
        }
        let starts_digit = line.chars().next().is_some_and(|c| c.is_ascii_digit());
        let dot_early = line.chars().take(4).any(|c| c == '.');
        if starts_digit && dot_early {
            if let Some((_, rest)) = line.split_once('.') {
                line = pytext::strip(rest).to_string();
            }
        }
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

/// `_write`: write the draft's text in the background (`continue_from`: what to carry on from).
async fn write(draft_id: &str, feature: &'static str, continue_from: &str) {
    if let Err(err) = write_inner(draft_id, feature, continue_from).await {
        tracing::error!(target: "kanban.assistant.editor", "the draft {draft_id} was not written: {err}");
    }
}

async fn write_inner(draft_id: &str, feature: &'static str, continue_from: &str) -> Result<(), Error> {
    let Some(draft) = drafts::find(draft_id) else { return Ok(()) };
    let payload = draft.get("payload").cloned().unwrap_or(Value::Null);
    let body = match payload.get("input") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let action = text(&body, "action");
    let include = include_of(&body);
    let (_, _, _, kind, skill_action) = action_of(&action).copied().unwrap_or(("", "", "", "", ""));
    let extra = EXTRA.iter().find(|(k, _)| *k == action).map_or("", |(_, v)| *v);
    let prompt: Vec<String> =
        [extra.to_string(), text(&body, "prompt")].into_iter().filter(|x| !x.is_empty()).collect();
    let pick = |key: &str, flag: &str| -> Value {
        if included(&include, flag) { body.get(key).cloned().unwrap_or(Value::Null) } else { Value::Null }
    };
    let mut inputs = Map::new();
    inputs.insert("surface".into(), body.get("surface").cloned().unwrap_or(Value::Null));
    inputs.insert("action".into(), json!(skill_action));
    inputs.insert("selection".into(), pick("selection", "selection"));
    inputs.insert("before".into(), json!(tail(&text(&body, "before"), MAX_AROUND)));
    inputs.insert("after".into(), json!(head(&text(&body, "after"), MAX_AROUND)));
    inputs.insert("prompt".into(), json!(prompt.join(" ")));
    inputs.insert("language".into(), body.get("language").cloned().unwrap_or(Value::Null));
    inputs.insert("ticket_id".into(), pick("ticket_id", "ticket"));
    inputs.insert("doc_id".into(), pick("doc_id", "page"));
    inputs.insert("idea_id".into(), pick("idea_id", "page"));
    inputs.insert("continue_from".into(), if continue_from.is_empty() { Value::Null } else { json!(continue_from) });
    let project_id = text(&draft, "project_id");
    let owner = text(&draft, "owner");
    let name = format!("editor:{draft_id}");
    let ticket_id = body.get("ticket_id").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).map(str::to_string);
    let mut opts = TurnOpts::new(&name, "editor-write", inputs, &owner);
    opts.feature = feature;
    opts.ticket_id = ticket_id.as_deref();
    opts.timeout_s = 180.0;
    let out = match engine::turn(&project_id, opts).await {
        Ok(out) => out,
        Err(Error::Assist(exc)) => {
            let _ = drafts::edit(draft_id, |d| {
                d.insert("status".into(), json!("failed"));
                d.insert("result".into(), json!({"error": {"code": exc.code, "message": exc.message}}));
            });
            return Ok(());
        }
        Err(other) => return Err(other),
    };
    let _ = drafts::edit(draft_id, |d| {
        let cost = d.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
        d.insert("cost".into(), json!(super::settings::round_to(cost + out.cost, 6)));
        let tokens = d.get("tokens").and_then(Value::as_i64).unwrap_or(0);
        d.insert("tokens".into(), json!(tokens + out.tokens_in + out.tokens_out));
        d.insert("member_name".into(), json!(out.member));
    });
    if out.state != "finished" {
        let status = if out.state == "cancelled" { "cancelled" } else { "failed" };
        let message = out
            .error
            .clone()
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "The assistant could not write this.".to_string());
        let _ = drafts::edit(draft_id, |d| {
            d.insert("status".into(), json!(status));
            d.insert("result".into(), json!({"error": {"code": "unavailable", "message": message}}));
        });
        return Ok(());
    }
    let data = out.data();
    let answer = match data.get("text").filter(|v| pyjson::truthy(v)) {
        Some(Value::String(t)) => t.clone(),
        Some(other) => pyjson::py_str(other),
        None => out.text.clone(),
    };
    let written = pytext::strip(&answer).to_string();
    if written.is_empty() {
        let _ = drafts::edit(draft_id, |d| {
            d.insert("status".into(), json!("failed"));
            d.insert(
                "result".into(),
                json!({"error": {"code": "invalid_output", "message": "The assistant wrote nothing. Try again."}}),
            );
        });
        return Ok(());
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!(kind));
    result.insert("cut_short".into(), json!(false));
    if kind == "list" {
        result.insert("items".into(), json!(items(&written)));
    } else {
        let full = if continue_from.is_empty() { written.clone() } else { format!("{continue_from}{written}") };
        result.insert("text".into(), json!(full));
    }
    let _ = drafts::edit(draft_id, |d| {
        d.insert("raw".into(), json!(written));
        if let Some(Value::Object(payload)) = d.get_mut("payload") {
            payload.insert("result".into(), Value::Object(result));
        }
        d.insert("status".into(), json!("open"));
    });
    events::publish(events::INVALIDATE, &[]).await;
    Ok(())
}

/// Accept: the editor has put the text in. An accepted list of criteria is added to the ticket.
pub async fn accept(draft_id: &str, by: &str, items: Option<Vec<String>>) -> Result<Map<String, Value>, Error> {
    let draft = drafts::get(draft_id)?;
    if text(&draft, "owner") != by {
        return Err(AssistError::new("forbidden", "This draft is someone else's.").into());
    }
    if draft.get("status").and_then(Value::as_str) != Some("open") {
        return Err(AssistError::new("conflict", "This draft is not ready or was already closed.").into());
    }
    let payload = draft.get("payload").cloned().unwrap_or(Value::Null);
    let result = match payload.get("result") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut created: Vec<String> = Vec::new();
    let body = payload.get("input").cloned().unwrap_or(Value::Null);
    let surface_name = body.get("surface").and_then(Value::as_str).unwrap_or("");
    let ticket_id = draft.get("ticket_id").filter(|v| pyjson::truthy(v)).and_then(Value::as_str);
    if result.get("kind").and_then(Value::as_str) == Some("list")
        && matches!(surface_name, "ticket_description" | "acceptance_criteria")
    {
        if let Some(ticket_id) = ticket_id {
            let wanted: Vec<String> = match items {
                Some(items) => items,
                None => match result.get("items") {
                    Some(Value::Array(list)) => list.iter().map(text_item).collect(),
                    _ => Vec::new(),
                },
            };
            {
                let session = database::session();
                for item in wanted {
                    let item = pytext::strip(&item).to_string();
                    if !item.is_empty()
                        && tickets::add_acceptance_criterion(&session, ticket_id, &item).await?.is_some()
                    {
                        created.push(item);
                    }
                }
            }
            events::publish(events::INVALIDATE, &[]).await;
        }
    }
    drafts::edit(draft_id, |d| {
        d.insert("status".into(), json!("applied"));
        d.insert("applied_by".into(), json!(by));
        d.insert("applied_at".into(), json!(now_iso()));
    })?;
    let mut out = Map::new();
    out.insert("draft".into(), Value::Object(drafts::get(draft_id)?));
    if !created.is_empty() {
        out.insert("created".into(), json!(created));
    }
    Ok(out)
}

/// `(item or "")` as text.
fn text_item(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        v if !pyjson::truthy(v) => String::new(),
        other => pyjson::py_str(other),
    }
}

/// Try again (the same request, written again) or Continue (carry on from what it has).
pub async fn again(draft_id: &str, by: &str, go_on: bool) -> Result<Map<String, Value>, AssistError> {
    let draft = drafts::get(draft_id)?;
    if text(&draft, "owner") != by {
        return Err(AssistError::new("forbidden", "This draft is someone else's."));
    }
    if draft.get("status").and_then(Value::as_str) == Some("pending") {
        return Ok(draft);
    }
    let kind = text(&draft, "kind");
    if kind != "editor" && kind != "editor_doc" {
        return Err(AssistError::new("invalid", "This draft cannot be written again."));
    }
    let before = if go_on {
        draft
            .get("payload")
            .and_then(|p| p.get("result"))
            .and_then(|r| r.get("text"))
            .filter(|v| pyjson::truthy(v))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    drafts::edit(draft_id, |d| {
        d.insert("status".into(), json!("pending"));
        d.insert("result".into(), json!({}));
    })?;
    let feature = if kind == "editor_doc" { "docs" } else { "drafting" };
    let id = draft_id.to_string();
    drafts::track(draft_id, ctx::spawn(async move { write(&id, feature, &before).await }));
    drafts::get(draft_id)
}
