//! What the project knows and what its AIs learned (design/screens/ai-operations.md, H; plan D18 a and b). Port of
//! `services/ai/knowledge.py`.
//!
//! - **Instructions**: one text per project, written by a person, in the system prompt of every run on the project
//!   (before the member's own persona). Project-wide, so it is not copied into each member's CLAUDE.md.
//! - **Memory (lessons)**: short facts learned the hard way. An AI proposes one (the lead in its final report, or an
//!   outside agent); a person keeps, edits or drops it. Only kept lessons go into the prompt, capped at
//!   `LESSON_TOKEN_CAP`.
//!
//! The system prompt is fixed at the first request of a conversation, so a change takes effect on the next run (the
//! runner starts a fresh conversation when the instructions it would send differ from the ones the conversation has).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use kb_ai::config_model::estimate_tokens;
use kb_ai::store::{get_settings, py_int};
use kb_ai::{ops, transcripts};
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_account, ai_lesson, ai_project_knowledge, ai_run, ai_team};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

use crate::{light, memory, plugins, seams};

/// `LESSON_TOKEN_CAP`.
pub const LESSON_TOKEN_CAP: i64 = 2000;
/// `PROMPT_BUDGET`.
pub const PROMPT_BUDGET: i64 = 8000;
/// `LIGHT_MODEL_TIMEOUT_S` as the Python tests patch it: milliseconds, 180 seconds at first.
static LIGHT_MODEL_TIMEOUT_MS: AtomicU64 = AtomicU64::new(180_000);

/// Change the seconds the light model has to answer (the Python tests patch `LIGHT_MODEL_TIMEOUT_S`).
pub fn set_light_model_timeout_s(seconds: f64) {
    LIGHT_MODEL_TIMEOUT_MS.store((seconds * 1000.0) as u64, Ordering::SeqCst);
}

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `ValueError`: the text is the message.
    Value(String),
    /// `LookupError`: the text is the message.
    Lookup(String),
    /// The database call failed.
    Db(DbErr),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Value(text) | Error::Lookup(text) => f.write_str(text),
            Error::Db(err) => write!(f, "{err}"),
        }
    }
}

fn now() -> String {
    kb_base::time::now_iso()
}

fn history_of(text: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(if text.is_empty() { "[]" } else { text }) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// The project's knowledge row, created on first use.
pub async fn get(session: &Session, project_id: &str) -> Result<ai_project_knowledge::Model, DbErr> {
    if let Some(row) = ai_project_knowledge::Entity::find_by_id(project_id).one(session).await? {
        return Ok(row);
    }
    let mut row = ai_project_knowledge::new();
    row.project_id = Set(project_id.to_string());
    database::insert_missing(session, row).await?;
    ai_project_knowledge::Entity::find_by_id(project_id)
        .one(session)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("ai_project_knowledge {project_id}")))
}

/// Replace the project's instructions; the previous text goes into the history.
pub async fn set_instructions(
    session: &Session,
    project_id: &str,
    text: &str,
    by: &str,
) -> Result<ai_project_knowledge::Model, DbErr> {
    let row = get(session, project_id).await?;
    let mut history = history_of(&row.history);
    if !pytext::strip(&row.instructions).is_empty() {
        history.push(json!({"at": row.updated_at, "by": row.updated_by, "text": row.instructions}));
    }
    let keep = history.len().saturating_sub(30);
    let mut active = ai_project_knowledge::ActiveModel::from(row);
    active.instructions = Set(text.to_string());
    active.history = Set(pyjson::dumps(&history[keep..].to_vec()));
    active.updated_at = Set(Some(now()));
    active.updated_by = Set(Some(by.to_string()));
    let saved = active.update(session).await?;
    session.commit().await?;
    Ok(saved)
}

/// The project's lessons, newest first.
pub async fn lessons(session: &Session, project_id: &str, state: Option<&str>) -> Result<Vec<ai_lesson::Model>, DbErr> {
    let mut stmt = ai_lesson::Entity::find().filter(ai_lesson::Column::ProjectId.eq(project_id));
    if let Some(state) = state.filter(|s| !s.is_empty()) {
        stmt = stmt.filter(ai_lesson::Column::State.eq(state));
    }
    stmt.order_by_desc(ai_lesson::Column::CreatedAt).all(session).await
}

/// What `add_lesson` takes beside the text.
#[derive(Debug, Clone)]
pub struct LessonOpts<'a> {
    /// "kept" (a person's, the default), "proposed" (an AI's) or "dropped".
    pub state: &'a str,
    /// The ticket it came from.
    pub source_ticket_id: Option<&'a str>,
    /// The run it came from.
    pub source_run_id: Option<&'a str>,
    /// Who proposed it (default: `by`).
    pub proposed_by: Option<&'a str>,
}

impl Default for LessonOpts<'_> {
    fn default() -> Self {
        LessonOpts { state: "kept", source_ticket_id: None, source_run_id: None, proposed_by: None }
    }
}

fn lesson_text(text: &str) -> String {
    pytext::squash(text).chars().take(600).collect()
}

/// Add a lesson (a person's is kept at once; an AI's is a proposal). None when the same text already exists.
pub async fn add_lesson(
    session: &Session,
    project_id: &str,
    text: &str,
    by: &str,
    opts: LessonOpts<'_>,
) -> Result<Option<ai_lesson::Model>, Error> {
    let text = lesson_text(text);
    if text.is_empty() {
        return Err(Error::Value("Write the lesson.".into()));
    }
    let same = ai_lesson::Entity::find()
        .filter(ai_lesson::Column::ProjectId.eq(project_id))
        .filter(ai_lesson::Column::Text.eq(text.as_str()))
        .filter(ai_lesson::Column::State.ne("dropped"))
        .one(session)
        .await?;
    if same.is_some() {
        return Ok(None);
    }
    let mut row = ai_lesson::new();
    row.project_id = Set(project_id.to_string());
    row.text = Set(text);
    row.state = Set(opts.state.to_string());
    row.source_ticket_id = Set(opts.source_ticket_id.map(str::to_string));
    row.source_run_id = Set(opts.source_run_id.map(str::to_string));
    row.proposed_by = Set(Some(opts.proposed_by.filter(|p| !p.is_empty()).unwrap_or(by).to_string()));
    row.kept_by = Set(if opts.state == "kept" { Some(by.to_string()) } else { None });
    let saved = row.insert(session).await?;
    session.commit().await?;
    Ok(Some(saved))
}

/// Keep, edit or drop a lesson.
pub async fn update_lesson(
    session: &Session,
    lesson_id: &str,
    by: &str,
    text: Option<&str>,
    state: Option<&str>,
) -> Result<ai_lesson::Model, Error> {
    let Some(row) = ai_lesson::Entity::find_by_id(lesson_id).one(session).await? else {
        return Err(Error::Lookup("Lesson not found.".into()));
    };
    let mut active = ai_lesson::ActiveModel::from(row);
    if let Some(text) = text {
        let clean = lesson_text(text);
        if clean.is_empty() {
            return Err(Error::Value("A lesson cannot be empty.".into()));
        }
        active.text = Set(clean);
    }
    if let Some(state) = state {
        if !["proposed", "kept", "dropped"].contains(&state) {
            return Err(Error::Value("A lesson is proposed, kept or dropped.".into()));
        }
        active.state = Set(state.to_string());
        if state == "kept" {
            active.kept_by = Set(Some(by.to_string()));
        }
    }
    active.updated_at = Set(now());
    let saved = active.update(session).await?;
    session.commit().await?;
    Ok(saved)
}

/// Kept lessons up to the cap, the most used and most recent first. Newest first among equally used ones (it sorted the
/// oldest first, so a fresh lesson was the one left out).
pub fn fits(rows: &[ai_lesson::Model]) -> Vec<&ai_lesson::Model> {
    let mut ordered: Vec<&ai_lesson::Model> = rows.iter().collect();
    ordered.sort_by_key(|r| (-i64::from(r.uses), memory::neg(Some(&r.created_at))));
    let mut out = Vec::new();
    let mut used = 0;
    for r in ordered {
        let cost = estimate_tokens(Some(&r.text));
        if used + cost > LESSON_TOKEN_CAP {
            continue;
        }
        out.push(r);
        used += cost;
    }
    out
}

/// The project's part of every run's system prompt: the instructions, then the kept lessons.
pub async fn prompt_block(session: &Session, project_id: &str, record_use: bool) -> Result<String, DbErr> {
    let (text, _used) = block_for(session, project_id, BlockOpts { record_use, ..BlockOpts::default() }).await?;
    Ok(text)
}

/// What `block_for` takes beside the project.
#[derive(Debug, Clone)]
pub struct BlockOpts<'a> {
    /// The member's role.
    pub role: Option<&'a str>,
    /// The member.
    pub member_id: Option<&'a str>,
    /// The run's ticket.
    pub ticket_id: Option<&'a str>,
    /// Count this as a use of each lesson and note.
    pub record_use: bool,
    /// Whether the notes go in at all.
    pub notes_on: bool,
}

impl Default for BlockOpts<'_> {
    fn default() -> Self {
        BlockOpts { role: None, member_id: None, ticket_id: None, record_use: false, notes_on: true }
    }
}

/// `list[:cap]` for a cap that may be negative.
fn take_cap<T>(mut items: Vec<T>, cap: i128) -> Vec<T> {
    let n = items.len() as i128;
    let keep = if cap >= 0 { cap.min(n) } else { (n + cap).max(0) };
    items.truncate(keep as usize);
    items
}

/// (text, used) for a run's system prompt: the instructions, the kept lessons, the member's own notes (its role's) and
/// the notes on its ticket (issue #274). `used` is what the run carried: {lessons, notes}, recorded on the run so a
/// person sees "used 3 lessons" and which.
pub async fn block_for(session: &Session, project_id: &str, opts: BlockOpts<'_>) -> Result<(String, Value), DbErr> {
    let row = ai_project_knowledge::Entity::find_by_id(project_id).one(session).await?;
    let settings = get_settings(session, project_id).await?;
    let cfg = ops::get(Some(&settings));
    let cap = cfg.get("lessons_in_prompt").filter(|v| pyjson::truthy(v)).and_then(py_int).unwrap_or(20);
    let all_kept = lessons(session, project_id, Some("kept")).await?;
    let kept: Vec<ai_lesson::Model> = take_cap(fits(&all_kept), cap).into_iter().cloned().collect();
    let wants_notes = opts.notes_on
        && (opts.member_id.is_some_and(|m| !m.is_empty()) || opts.ticket_id.is_some_and(|t| !t.is_empty()));
    let (own, on_ticket) = if wants_notes {
        memory::for_run(session, project_id, opts.role, opts.member_id, opts.ticket_id).await?
    } else {
        (Vec::new(), Vec::new())
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(row) = row.as_ref() {
        if !pytext::strip(&row.instructions).is_empty() {
            parts.push(format!(
                "Project instructions (written by the project's people, for every AI on this project):\n{}",
                pytext::strip(&row.instructions)
            ));
        }
    }
    if !kept.is_empty() {
        let lines: Vec<String> = kept.iter().map(|r| format!("- {}", r.text)).collect();
        parts.push(format!(
            "What the AIs on this project learned (lessons kept by a person; follow them):\n{}",
            lines.join("\n")
        ));
    }
    if !own.is_empty() {
        let whose = match opts.role.filter(|r| !r.is_empty()) {
            Some(role) => format!("the {role} role's"),
            None => "your own".to_string(),
        };
        let lines: Vec<String> = own
            .iter()
            .map(|n| format!("- [{}]{} {}", n.id, if n.kind == "feedback" { " (a person said)" } else { "" }, n.text))
            .collect();
        parts.push(format!(
            "Your notes ({whose} memory, kept across runs by you and your teammates of the same role; update them when \
they are wrong):\n{}",
            lines.join("\n")
        ));
    }
    if !on_ticket.is_empty() {
        let lines: Vec<String> = on_ticket
            .iter()
            .map(|n| {
                let by = n.written_by.as_deref().filter(|b| !b.is_empty()).unwrap_or("a run");
                format!("- [{}] ({by}) {}", n.id, n.text)
            })
            .collect();
        parts.push(format!(
            "Notes on this ticket (left by earlier runs on {}; read them before you start):\n{}",
            opts.ticket_id.unwrap_or("None"),
            lines.join("\n")
        ));
    }
    let notes: Vec<&kb_db::entities::ai_memory_note::Model> = own.iter().chain(on_ticket.iter()).collect();
    let used = json!({
        "lessons": kept.iter().map(|r| json!({"id": r.id, "text": r.text})).collect::<Vec<_>>(),
        "notes": notes.iter().map(|n| json!({"id": n.id, "scope": n.scope, "text": n.text})).collect::<Vec<_>>(),
        "tokens": kept.iter().map(|r| estimate_tokens(Some(&r.text))).sum::<i64>()
            + notes.iter().map(|n| estimate_tokens(Some(&n.text))).sum::<i64>(),
    });
    if opts.record_use && (!kept.is_empty() || !own.is_empty() || !on_ticket.is_empty()) {
        let at = now();
        for r in &kept {
            let mut active = ai_lesson::ActiveModel::from(r.clone());
            active.uses = Set(r.uses + 1);
            active.last_used_at = Set(Some(at.clone()));
            active.update(session).await?;
        }
        for n in notes {
            let mut active = kb_db::entities::ai_memory_note::ActiveModel::from(n.clone());
            active.uses = Set(n.uses + 1);
            active.last_used_at = Set(Some(at.clone()));
            active.update(session).await?;
        }
        session.commit().await?;
    }
    Ok((parts.join("\n\n"), used))
}

/// The memory block of one run, recorded on the run (`memory_used`).
pub async fn for_run(session: &Session, run: &ai_run::Model, profile: &ai_team::Model) -> Result<String, DbErr> {
    let settings = get_settings(session, &run.project_id).await?;
    let notes_on = ops::get(Some(&settings)).get("ai_notes") != Some(&Value::Bool(false));
    let role = plugins::role_of(profile);
    let (text, _used) = block_for(
        session,
        &run.project_id,
        BlockOpts {
            role: role.as_deref(),
            member_id: Some(&profile.id),
            ticket_id: run.ticket_id.as_deref(),
            record_use: true,
            notes_on,
        },
    )
    .await?;
    session.commit().await?;
    Ok(text)
}

/// The knowledge page: instructions, lessons, and how many tokens they add to every prompt.
pub async fn summary(session: &Session, project_id: &str) -> Result<Value, DbErr> {
    let row = get(session, project_id).await?;
    let rows = lessons(session, project_id, None).await?;
    let kept_rows: Vec<ai_lesson::Model> = rows.iter().filter(|r| r.state == "kept").cloned().collect();
    let kept = fits(&kept_rows);
    let instr_tokens = estimate_tokens(Some(&row.instructions));
    let lesson_tokens: i64 = kept.iter().map(|r| estimate_tokens(Some(&r.text))).sum();
    let notes = memory::notes(session, project_id, None, None).await?;
    let flags = memory::flags(session, project_id).await?;
    let labels = memory::labels(session, &notes).await?;
    session.commit().await?;
    let note_rows: Vec<Value> = notes
        .iter()
        .map(|n| {
            let mut d = match memory::note_dict(n) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            d.insert(
                "scope_label".into(),
                labels.get(&(n.scope.clone(), n.scope_key.clone())).map_or(Value::Null, |l| json!(l)),
            );
            Value::Object(d)
        })
        .collect();
    // a list, not a dict keyed by id: the UI camel-cases dict keys, ids included
    let mut flag_rows: Vec<Value> = Vec::new();
    for (id, fs) in &flags {
        for f in fs {
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            for (k, v) in f {
                m.insert(k.clone(), v.clone());
            }
            flag_rows.push(Value::Object(m));
        }
    }
    Ok(json!({
        "proposals": rows.iter().filter(|r| r.state == "proposed").count(),
        "notes": note_rows,
        "note_caps": memory::max_notes_json(),
        "flags": flag_rows,
        "project_id": project_id,
        "instructions": row.instructions,
        "instructions_tokens": instr_tokens,
        "updated_at": row.updated_at,
        "updated_by": row.updated_by,
        "history": history_of(&row.history),
        "lessons": rows.iter().filter(|r| r.state == "proposed" || r.state == "kept").map(lesson_dict).collect::<Vec<_>>(),
        "lessons_tokens": lesson_tokens,
        "lesson_cap": LESSON_TOKEN_CAP,
        "total_tokens": instr_tokens + lesson_tokens,
        "budget": PROMPT_BUDGET,
        "unused": rows.iter().filter(|r| r.state == "kept" && r.uses == 0).map(|r| r.id.clone()).collect::<Vec<_>>(),
    }))
}

/// A lesson for the API.
pub fn lesson_dict(r: &ai_lesson::Model) -> Value {
    json!({
        "id": r.id,
        "text": r.text,
        "state": r.state,
        "tokens": estimate_tokens(Some(&r.text)),
        "source_ticket_id": r.source_ticket_id,
        "source_run_id": r.source_run_id,
        "proposed_by": r.proposed_by,
        "kept_by": r.kept_by,
        "uses": r.uses,
        "last_used_at": r.last_used_at,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    })
}

// ---------------------------------------------------------------------------
// The light model (notes after a run, the repository scan)
// ---------------------------------------------------------------------------

/// A short text of a run for the light model: what the AI said, the commands it ran and how they ended, errors.
pub fn digest(records: &[Value], limit: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    for rec in records {
        let kind = rec.get("k").and_then(Value::as_str);
        if kind == Some("note") {
            let text = rec.get("text").map_or_else(|| "None".to_string(), pyjson::py_str);
            out.push(format!("[board] {text}"));
            continue;
        }
        let ev = if kind == Some("event") { rec.get("e") } else { None };
        let Some(ev @ Value::Object(ev_map)) = ev else { continue };
        for block in transcripts::blocks_of(ev) {
            let btype = block.get("type").and_then(Value::as_str);
            if btype == Some("text") && ev_map.get("type").and_then(Value::as_str) == Some("assistant") {
                let text = match block.get("text").filter(|v| pyjson::truthy(v)) {
                    Some(v) => pyjson::py_str(v),
                    None => String::new(),
                };
                out.push(format!("AI: {}", text.chars().take(400).collect::<String>()));
            } else if btype == Some("tool_use") {
                let input = block.get("input").filter(|v| pyjson::truthy(v));
                let what = input
                    .and_then(Value::as_object)
                    .and_then(|i| {
                        ["command", "file_path", "pattern"].iter().find_map(|k| i.get(*k).filter(|v| pyjson::truthy(v)))
                    })
                    .map(pyjson::py_str)
                    .unwrap_or_default();
                let name = block.get("name").map_or_else(|| "None".to_string(), pyjson::py_str);
                out.push(format!("tool {name}: {}", what.chars().take(200).collect::<String>()));
            } else if btype == Some("tool_result") && block.get("is_error").is_some_and(pyjson::truthy) {
                let body = block.get("content").cloned().unwrap_or(Value::Null);
                let body = match &body {
                    Value::Array(items) => Value::String(
                        items
                            .iter()
                            .filter_map(Value::as_object)
                            .map(|c| c.get("text").map_or_else(String::new, pyjson::py_str))
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                    other => other.clone(),
                };
                out.push(format!("  error: {}", pyjson::py_str(&body).chars().take(300).collect::<String>()));
            }
        }
    }
    let text = out.join("\n");
    let chars: Vec<char> = text.chars().collect();
    chars[chars.len().saturating_sub(limit)..].iter().collect()
}

/// One answer from Haiku for `profile` (on `account`'s sign-in); a child that does not answer in time is killed with
/// everything it started.
pub async fn ask_light_model(
    prompt: &str,
    profile: &ai_team::Model,
    account: Option<&ai_account::Model>,
) -> Option<String> {
    let cli = seams::cli()?;
    let path = cli.find_cli("claude", profile.cli_path.as_deref()).filter(|p| !p.is_empty())?;
    let mut env = cli.child_env();
    if let Some(account) = account {
        env = cli.env_for_account(account, env);
    }
    let timeout = Duration::from_millis(LIGHT_MODEL_TIMEOUT_MS.load(Ordering::SeqCst));
    light::run(&light::args(&path, prompt, None), env, timeout).await
}

/// Propose a lesson and tell the project's owners and admins it waits for them (an AI in a run, an outside agent over
/// MCP, a diagnosis). None when the same lesson is already there.
pub async fn propose(
    session: &Session,
    project_id: &str,
    text: &str,
    by: &str,
    proposed_by: &str,
    source_ticket_id: Option<&str>,
    source_run_id: Option<&str>,
    member_id: Option<&str>,
) -> Result<Option<ai_lesson::Model>, Error> {
    let opts = LessonOpts { state: "proposed", source_ticket_id, source_run_id, proposed_by: Some(proposed_by) };
    let Some(row) = add_lesson(session, project_id, text, by, opts).await? else { return Ok(None) };
    let told = async {
        let recipients = kb_notify::recipients::owners_and_admins(session, Some(project_id)).await?;
        let mut data = Map::new();
        if let Some(run) = source_run_id.filter(|r| !r.is_empty()) {
            data.insert("run_id".into(), json!(run));
        }
        let title = match source_ticket_id.filter(|t| !t.is_empty()) {
            Some(t) => format!("A lesson proposed by {proposed_by} on {t}"),
            None => format!("A lesson proposed by {proposed_by}"),
        };
        kb_notify::emit(
            "lesson",
            Some(session),
            kb_notify::writing::EmitFields {
                project_id: Some(project_id.to_string()),
                recipients,
                title,
                body: Some(row.text.chars().take(300).collect()),
                target_kind: Some("lesson".into()),
                target_id: Some(row.id.clone()),
                ticket_id: source_ticket_id.map(str::to_string),
                member_id: member_id.map(str::to_string),
                data: Some(data),
                ..Default::default()
            },
        )
        .await
    }
    .await;
    // the proposal stands even if nobody could be told
    if let Err(err) = told {
        tracing::error!("Could not tell anyone about lesson {}: {err}", row.id);
    }
    Ok(Some(row))
}
