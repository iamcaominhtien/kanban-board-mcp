//! The project memory over MCP (issue #274): read the instructions, lessons and notes; keep a note; propose a lesson.
//!
//! Inside a board run the note is the run's own: its role's memory (or its own when it has no role) or its ticket's.
//! An agent outside the board reads the same memory, proposes a lesson for a person to keep, and leaves notes on a
//! ticket.

use kb_ai::store::{get_profile, get_settings};
use kb_ai::{ops as ai_ops, steps};
use kb_ai_know::plugins::role_of;
use kb_ai_know::{knowledge, memory};
use kb_base::pytext;
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

use crate::common::{ToolError, ToolResult};
use crate::hooks::RunContext;

/// `LookupError` of the services: the tool turns it into a `ValueError` with the same text.
fn lookup(err: memory::Error) -> ToolError {
    match err {
        memory::Error::Value(text) | memory::Error::Lookup(text) => ToolError::Value(text),
        memory::Error::Db(err) => err.into(),
    }
}

/// `knowledge.Error` the same way.
fn knowledge_error(err: knowledge::Error) -> ToolError {
    match err {
        knowledge::Error::Value(text) | knowledge::Error::Lookup(text) => ToolError::Value(text),
        knowledge::Error::Db(err) => err.into(),
    }
}

/// The ticket a note is about: by id, or by id in upper case; it must be in the project.
async fn ticket_of(session: &Session, project_id: &str, ticket_id: &str) -> Result<ticket::Model, ToolError> {
    let mut found = ticket::Entity::find_by_id(ticket_id).one(session).await?;
    if found.is_none() {
        found = ticket::Entity::find_by_id(ticket_id.to_uppercase()).one(session).await?;
    }
    match found {
        Some(found) if found.project_id == project_id => Ok(found),
        _ => Err(ToolError::Value(format!("No ticket {ticket_id} in this project."))),
    }
}

/// `value or other`: the first when it is not empty.
fn or_text<'a>(first: Option<&'a str>, second: Option<&'a str>) -> Option<&'a str> {
    first.filter(|text| !text.is_empty()).or(second)
}

/// `knowledge(memory | remember | forget)`.
#[allow(clippy::too_many_arguments)]
pub async fn memory_action(
    session: &Session,
    ctx: Option<&RunContext>,
    project_id: &str,
    action: &str,
    text: Option<&str>,
    scope: Option<&str>,
    kind: Option<&str>,
    note_id: Option<&str>,
    ticket_id: Option<&str>,
    person: Option<&str>,
) -> ToolResult {
    let mut role = None;
    if let Some(ctx) = ctx {
        let (_member, profile) = get_profile(session, &ctx.member_id).await?;
        role = profile.as_ref().and_then(role_of);
    }
    if action == "memory" {
        return read(session, ctx, project_id, role.as_deref(), scope, ticket_id).await;
    }
    let settings = get_settings(session, project_id).await?;
    if ai_ops::get(Some(&settings)).get("ai_notes") == Some(&Value::Bool(false)) && scope != Some("project") {
        return Err(ToolError::Value(
            "This project has AI notes switched off (Settings › AI › Project knowledge › Memory). Propose a lesson \
             instead (scope='project')."
                .to_string(),
        ));
    }
    let outside = or_text(person, None).unwrap_or("an outside agent");
    let by = match ctx {
        Some(ctx) => ctx.member_name.as_str(),
        None => outside,
    };
    if action == "forget" {
        let Some(note_id) = note_id.filter(|id| !id.is_empty()) else {
            return Err(ToolError::Value("forget needs note_id.".to_string()));
        };
        let row = memory::forget(session, project_id, note_id).await.map_err(lookup)?;
        return Ok(json!({"forgot": row.id, "text": row.text}));
    }
    // remember
    if pytext::strip(text.unwrap_or("")).is_empty() {
        return Err(ToolError::Value("remember needs text.".to_string()));
    }
    let text = text.unwrap_or("");
    let scope = match scope.filter(|s| !s.is_empty()) {
        Some(scope) => scope,
        None if ctx.is_some() => "role",
        None => "project",
    };
    let run_ticket = ctx.and_then(|c| c.ticket_id.as_deref());
    let source_ticket = or_text(run_ticket, ticket_id);
    let run_id = ctx.map(|c| c.run_id.as_str());
    if scope == "project" {
        let row = knowledge::propose(
            session,
            project_id,
            text,
            by,
            by,
            source_ticket,
            run_id,
            ctx.map(|c| c.member_id.as_str()),
        )
        .await
        .map_err(knowledge_error)?;
        let Some(row) = row else {
            return Ok(json!({"lesson": null, "note": "That lesson is already there."}));
        };
        return Ok(json!({
            "lesson": knowledge::lesson_dict(&row),
            "note": "Proposed. It reaches every AI's prompt once a person keeps it.",
        }));
    }
    let (scope, key) = if scope == "ticket" {
        let Some(tid) = or_text(ticket_id, run_ticket) else {
            return Err(ToolError::Value("A ticket note needs ticket_id.".to_string()));
        };
        let found = ticket_of(session, project_id, tid).await?;
        ("ticket", found.id)
    } else {
        let Some(ctx) = ctx else {
            return Err(ToolError::Value(
                "Role notes are kept by a board run. Outside one, leave a ticket note (scope='ticket') or propose a \
                 lesson (scope='project')."
                    .to_string(),
            ));
        };
        memory::own_scope(role.as_deref(), &ctx.member_id)
    };
    let opts = memory::WriteOpts {
        kind: Some(kind.filter(|k| !k.is_empty()).unwrap_or("learned")),
        note_id,
        source_run_id: run_id,
        source_ticket_id: source_ticket,
    };
    let (row, what) = memory::write(session, project_id, scope, &key, text, by, opts).await.map_err(lookup)?;
    if let Some(ctx) = ctx.filter(|_| what != "unchanged") {
        log_on_run(&ctx.run_id, &row, what).await?;
    }
    let reaches = if scope == "ticket" {
        format!("every later run on {key}")
    } else {
        match role.as_deref().filter(|r| !r.is_empty()) {
            Some(role) => format!("every {role} run on this project"),
            None => "your next runs".to_string(),
        }
    };
    Ok(json!({"note": memory::note_dict(&row), "result": what, "reaches": reaches}))
}

/// What the project remembers, as a run (or an outside agent) would want it.
async fn read(
    session: &Session,
    ctx: Option<&RunContext>,
    project_id: &str,
    role: Option<&str>,
    scope: Option<&str>,
    ticket_id: Option<&str>,
) -> ToolResult {
    let summary = knowledge::summary(session, project_id).await?;
    let mut out = Map::new();
    out.insert("instructions".into(), summary["instructions"].clone());
    let lessons: Vec<Value> = summary["lessons"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|x| json!({"id": x["id"], "text": x["text"], "state": x["state"]}))
        .collect();
    out.insert("lessons".into(), Value::Array(lessons));
    let notes: &[Value] = summary["notes"].as_array().map(Vec::as_slice).unwrap_or_default();
    if let Some(ctx) = ctx {
        let (own_scope, own_key) = memory::own_scope(role, &ctx.member_id);
        let mine: Vec<Value> =
            notes.iter().filter(|n| n["scope"] == own_scope && n["scope_key"] == own_key.as_str()).map(short).collect();
        let on_ticket: Vec<Value> = notes
            .iter()
            .filter(|n| n["scope"] == "ticket" && ctx.ticket_id.as_deref().is_some_and(|t| n["scope_key"] == t))
            .map(short)
            .collect();
        out.insert("your_notes".into(), Value::Array(mine));
        out.insert("ticket_notes".into(), Value::Array(on_ticket));
        out.insert(
            "cap".into(),
            json!({"your_notes": memory::max_notes(own_scope), "ticket_notes": memory::max_notes("ticket")}),
        );
    } else {
        let listed: Vec<Value> = notes
            .iter()
            .filter(|n| match ticket_id.filter(|t| !t.is_empty()) {
                Some(ticket_id) => n["scope_key"] == ticket_id,
                None => true,
            })
            .map(|n| {
                let mut note = short(n).as_object().cloned().unwrap_or_default();
                note.insert("scope".into(), n["scope"].clone());
                note.insert("scope_key".into(), n["scope_key"].clone());
                Value::Object(note)
            })
            .collect();
        out.insert("notes".into(), Value::Array(listed));
    }
    if let Some(scope) = scope.filter(|s| !s.is_empty()) {
        let keep: Option<&[&str]> = match scope {
            "project" => Some(&["instructions", "lessons"]),
            "role" => Some(&["your_notes"]),
            "ticket" => Some(&["ticket_notes"]),
            _ => None,
        };
        out =
            out.into_iter().filter(|(k, _)| keep.is_none_or(|keep| keep.contains(&k.as_str())) || k == "cap").collect();
    }
    // a live outside agent (haiku) read the memory, wrote good lessons and asked the person before proposing them,
    // three times: it is told here, where it decides, that a proposal changes nothing until a person keeps it
    out.insert(
        "how".into(),
        json!(
            "remember: keep a fact you learned or a person's feedback (scope role, ticket or project); replace a wrong \
             note with note_id; forget one that no longer holds. See the keeping-memory guide. \
             A project lesson (scope='project') is only a proposal: it waits on the board until a person keeps or drops \
             it and changes nothing before that, so propose one yourself when you have one, without asking first."
        ),
    );
    Ok(Value::Object(out))
}

/// A note as an agent reads it in a list.
fn short(n: &Value) -> Value {
    json!({"id": n["id"], "text": n["text"], "kind": n["kind"], "by": n["written_by"], "uses": n["uses"]})
}

/// A step on the run, so a person reading it sees what the AI chose to remember.
async fn log_on_run(run_id: &str, row: &kb_db::entities::ai_memory_note::Model, what: &str) -> Result<(), ToolError> {
    let title: String = row.text.chars().take(200).collect();
    let label = if what == "added" { "Remembered" } else { "Updated a note" };
    steps::append(
        run_id,
        vec![json!({
            "kind": "memory",
            "title": format!("{label}: {title}"),
            "detail": {"note_id": row.id, "scope": row.scope},
        })],
        steps::Extras::default(),
    )
    .await?;
    Ok(())
}
