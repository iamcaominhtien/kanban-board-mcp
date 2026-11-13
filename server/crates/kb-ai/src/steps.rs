//! Steps of a run (AI v2): append-only rows, written in small batches, announced as typed SSE events.
//!
//! A step is what the lead or one of its subagents did: a tool call, an edit, a command and its output, text, a
//! message, a hook event. `StepWriter` gathers the steps a stream yields and flushes them every `FLUSH_S` seconds (or on
//! demand), so a run streaming ten tool calls a second costs one commit and one event per batch, not ten.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use kb_base::{ctx, events, pyjson};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_agent, ai_run_step};
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use crate::store::{loads, now_iso, set_run_field};

/// Seconds between two flushes of a `StepWriter`.
pub const FLUSH_S: f64 = 0.25;
/// Characters of a command's output kept on its step.
pub const OUTPUT_MAX: usize = 12_000;
/// Steps carried by one SSE event (the rest is fetched).
pub const EVENT_STEPS_MAX: usize = 40;

/// A step for the API and the SSE event.
pub fn to_dict(step: &ai_run_step::Model, with_output: bool) -> Value {
    let detail = if step.detail.is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&step.detail).unwrap_or_else(|_| json!({}))
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(step.id));
    out.insert("run_id".into(), json!(step.run_id));
    out.insert("seq".into(), json!(step.seq));
    out.insert("at".into(), json!(step.at));
    out.insert("agent_id".into(), json!(step.agent_id));
    out.insert("kind".into(), json!(step.kind));
    out.insert("tool".into(), json!(step.tool));
    out.insert("title".into(), json!(step.title));
    out.insert("detail".into(), detail);
    out.insert("has_output".into(), json!(step.output.as_ref().is_some_and(|o| !o.is_empty())));
    out.insert("parent_tool_id".into(), json!(step.parent_tool_id));
    out.insert("tool_id".into(), json!(step.tool_id));
    if with_output {
        out.insert("output".into(), json!(step.output));
    }
    Value::Object(out)
}

/// A subagent row as the API shows it. `spans` are its stretches of work: from its start to its first stop, then from
/// each time it was woken again to its next stop (the markers the board wrote), the last one open while it works.
pub fn agent_dict(agent: &ai_run_agent::Model, marks: Option<&[ai_run_step::Model]>) -> Value {
    let mut spans: Vec<(String, Option<String>)> = Vec::new();
    for m in marks.unwrap_or(&[]) {
        let detail = loads(Some(&m.detail), json!({}));
        let event = detail.get("event").and_then(Value::as_str).map(str::to_string);
        match event.as_deref() {
            Some("stop") => match spans.last_mut() {
                None => spans.push((agent.started_at.clone(), Some(m.at.clone()))),
                Some(last) if last.1.is_none() => last.1 = Some(m.at.clone()),
                Some(_) => {}
            },
            Some("start") => match spans.last() {
                None => spans.push((agent.started_at.clone(), None)),
                Some(last) if last.1.is_some() => spans.push((m.at.clone(), None)),
                Some(_) => {}
            },
            _ => {}
        }
    }
    match spans.last_mut() {
        None => spans.push((agent.started_at.clone(), agent.ended_at.clone())),
        Some(last) => {
            if agent.ended_at.as_ref().is_some_and(|e| !e.is_empty()) && last.1.is_none() {
                last.1 = agent.ended_at.clone();
            }
        }
    }
    json!({
        "id": agent.id,
        "run_id": agent.run_id,
        "agent_type": agent.agent_type,
        "claude_id": agent.claude_id,
        "started_at": agent.started_at,
        "ended_at": agent.ended_at,
        "steps_count": agent.steps_count,
        "last_text": agent.last_text,
        "spans": spans.into_iter().map(|(s, e)| json!({"start": s, "end": e})).collect::<Vec<_>>(),
    })
}

async fn next_seq(session: &Session, run_id: &str) -> Result<i32, DbErr> {
    let last = ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.eq(run_id))
        .order_by_desc(ai_run_step::Column::Seq)
        .limit(1)
        .one(session)
        .await?;
    Ok(last.map_or(0, |s| s.seq) + 1)
}

/// What `append` takes besides the run and its rows (the keyword arguments of the Python function).
pub struct Extras {
    /// Each agent: `{id | claude_id, agent_type?, claude_id?, ended?: bool, at?: when it ended, reopen?: bool, last_text?}`.
    pub agents: Vec<Value>,
    /// Run columns to change (`state`, `summary`...).
    pub fields: Map<String, Value>,
    /// Changed files: `{path, added, removed, new}`.
    pub files: Vec<Value>,
    /// Announce the batch as an `ai.step` event.
    pub announce: bool,
}

impl Default for Extras {
    fn default() -> Self {
        Self { agents: Vec::new(), fields: Map::new(), files: Vec::new(), announce: true }
    }
}

/// Python's `value or default` for a text field of a dict.
fn text_or<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn opt_string(row: &Value, key: &str) -> Option<String> {
    match row.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(pyjson::py_str(other)),
    }
}

/// Write steps (and subagent starts/stops, run fields, changed files) in one commit and announce them.
///
/// Each row: `{kind, title, tool?, detail?, output?, agent_id?, parent_tool_id?, at?}`.
pub async fn append(run_id: &str, rows: Vec<Value>, extras: Extras) -> Result<Vec<ai_run_step::Model>, DbErr> {
    let Extras { agents: agent_specs, fields, files, announce } = extras;
    if rows.is_empty() && agent_specs.is_empty() && fields.is_empty() && files.is_empty() {
        return Ok(Vec::new());
    }
    let mut written: Vec<ai_run_step::Model> = Vec::new();
    let session = database::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(Vec::new()) };
    let mut seq = next_seq(&session, run_id).await?;
    let mut per_agent: Vec<(String, i32)> = Vec::new();
    for r in &rows {
        let mut step = ai_run_step::new();
        step.run_id = Set(run_id.to_string());
        step.seq = Set(seq);
        step.at = Set(text_or(r, "at").map_or_else(now_iso, str::to_string));
        step.agent_id = Set(opt_string(r, "agent_id"));
        step.kind = Set(text_or(r, "kind").unwrap_or("tool").to_string());
        step.tool = Set(opt_string(r, "tool"));
        step.title = Set(text_or(r, "title").unwrap_or("").chars().take(400).collect());
        let detail = r.get("detail").filter(|d| pyjson::truthy(d)).cloned().unwrap_or_else(|| json!({}));
        step.detail = Set(pyjson::dumps(&detail));
        step.output = Set(text_or(r, "output").map(|o| o.chars().take(OUTPUT_MAX).collect()));
        step.parent_tool_id = Set(opt_string(r, "parent_tool_id"));
        step.tool_id = Set(opt_string(r, "tool_id"));
        let step = step.insert(&session).await?;
        seq += 1;
        if let Some(agent_id) = step.agent_id.clone().filter(|a| !a.is_empty()) {
            match per_agent.iter_mut().find(|(id, _)| *id == agent_id) {
                Some(slot) => slot.1 += 1,
                None => per_agent.push((agent_id, 1)),
            }
        }
        written.push(step);
    }
    let mut run_row = kb_db::edit(run.clone());
    let steps_count = run.steps_count + rows.len() as i32;
    run_row.steps_count = Set(steps_count);
    let mut last_output_at = run.last_output_at.clone();
    if !rows.is_empty() {
        last_output_at = Some(now_iso());
        run_row.last_output_at = Set(last_output_at.clone());
    }
    for a in &agent_specs {
        let mut a = a.clone();
        if !a.get("id").is_some_and(pyjson::truthy) {
            // named by Claude's own id only (a task notification): the role's row, if the run has one
            let found = match text_or(&a, "claude_id") {
                Some(claude_id) => {
                    ai_run_agent::Entity::find()
                        .filter(ai_run_agent::Column::RunId.eq(run_id))
                        .filter(ai_run_agent::Column::ClaudeId.eq(claude_id))
                        .one(&session)
                        .await?
                }
                None => None,
            };
            let Some(found) = found else { continue };
            if let Value::Object(map) = &mut a {
                map.insert("id".into(), json!(found.id));
            }
        }
        let id = a.get("id").map(pyjson::py_str).unwrap_or_default();
        let existing = ai_run_agent::Entity::find_by_id(id.as_str()).one(&session).await?;
        let mut agent = existing.clone().unwrap_or_else(|| ai_run_agent::Model {
            id: id.clone(),
            run_id: run_id.to_string(),
            agent_type: text_or(&a, "agent_type").unwrap_or("").to_string(),
            claude_id: None,
            started_at: now_iso(),
            ended_at: None,
            steps_count: 0,
            last_text: None,
        });
        if let Some(t) = text_or(&a, "agent_type") {
            agent.agent_type = t.to_string();
        }
        if let Some(c) = text_or(&a, "claude_id") {
            agent.claude_id = Some(c.to_string());
        }
        if let Some(t) = text_or(&a, "last_text") {
            agent.last_text = Some(t.chars().take(400).collect());
        }
        let mut marks: Vec<&str> = Vec::new();
        if a.get("reopen").is_some_and(pyjson::truthy) && agent.ended_at.as_ref().is_some_and(|e| !e.is_empty()) {
            // the lead sent it a message, or its hook says so: it works again
            agent.ended_at = None;
            marks.push("start");
        }
        if a.get("ended").is_some_and(pyjson::truthy) && agent.ended_at.as_ref().is_none_or(|e| e.is_empty()) {
            agent.ended_at = Some(text_or(&a, "at").map_or_else(now_iso, str::to_string));
            marks.push("stop");
        }
        for event in marks {
            // a marker row per change, so the stretches of work of a role that was woken again can be told apart (not
            // counted in the run's steps; the screens leave `role` rows out of the list)
            let name = if agent.agent_type.is_empty() { "role" } else { agent.agent_type.as_str() };
            let mut marker = ai_run_step::new();
            marker.run_id = Set(run_id.to_string());
            marker.seq = Set(seq);
            let at = if event == "stop" { text_or(&a, "at").map(str::to_string) } else { None };
            marker.at = Set(at.unwrap_or_else(now_iso));
            marker.agent_id = Set(Some(agent.id.clone()));
            marker.kind = Set("role".into());
            marker.title = Set(format!("{name} {}", if event == "start" { "works again" } else { "finished" }));
            marker.detail = Set(pyjson::dumps(&json!({"event": event})));
            written.push(marker.insert(&session).await?);
            seq += 1;
        }
        if let Some(at) = per_agent.iter().position(|(id, _)| *id == agent.id) {
            agent.steps_count += per_agent.remove(at).1;
        }
        match &existing {
            None => {
                ai_run_agent::ActiveModel::from(agent).reset_all().insert(&session).await?;
            }
            Some(read) => {
                kb_db::save_model(&session, read, agent).await?;
            }
        }
    }
    let leftover = !per_agent.is_empty();
    for (agent_id, n) in &per_agent {
        match ai_run_agent::Entity::find_by_id(agent_id.as_str()).one(&session).await? {
            Some(read) => {
                let mut agent = read.clone();
                agent.steps_count += n;
                kb_db::save_model(&session, &read, agent).await?;
            }
            None => {
                let mut agent = ai_run_agent::new();
                agent.id = Set(agent_id.clone());
                agent.run_id = Set(run_id.to_string());
                agent.steps_count = Set(*n);
                agent.insert(&session).await?;
            }
        }
    }
    if !files.is_empty() {
        let mut current: Vec<(String, Map<String, Value>)> = Vec::new();
        if let Ok(Value::Array(items)) =
            serde_json::from_str::<Value>(if run.files.is_empty() { "[]" } else { &run.files })
        {
            for f in items {
                if let Some(path) = f.get("path").map(pyjson::py_str) {
                    let map = f.as_object().cloned().unwrap_or_default();
                    match current.iter_mut().find(|(p, _)| *p == path) {
                        Some(slot) => slot.1 = map,
                        None => current.push((path, map)),
                    }
                }
            }
        }
        for f in &files {
            let path = f.get("path").map(pyjson::py_str).unwrap_or_default();
            let number = |m: &Map<String, Value>, key: &str| m.get(key).and_then(Value::as_i64).unwrap_or(0);
            match current.iter_mut().find(|(p, _)| *p == path) {
                Some((_, prev)) => {
                    let added = number(prev, "added") + f.get("added").and_then(Value::as_i64).unwrap_or(0);
                    let removed = number(prev, "removed") + f.get("removed").and_then(Value::as_i64).unwrap_or(0);
                    prev.insert("added".into(), json!(added));
                    prev.insert("removed".into(), json!(removed));
                }
                None => current.push((path, f.as_object().cloned().unwrap_or_default())),
            }
        }
        let list: Vec<Value> = current.into_iter().map(|(_, m)| Value::Object(m)).collect();
        run_row.files = Set(pyjson::dumps(&Value::Array(list)));
    }
    for (key, value) in &fields {
        set_run_field(&mut run_row, key, value);
    }
    let saved = run_row.update(&session).await?;
    session.commit().await?;
    let snapshot = json!({
        "run_id": run_id,
        "state": saved.state,
        "steps_count": saved.steps_count,
        "last_output_at": saved.last_output_at.clone().or(last_output_at),
    });
    let agent_rows = if !agent_specs.is_empty() || leftover { Some(agents(&session, run_id).await?) } else { None };
    if announce {
        let mut payload = match snapshot {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let shown: Vec<Value> =
            written[written.len().saturating_sub(EVENT_STEPS_MAX)..].iter().map(|s| to_dict(s, false)).collect();
        payload.insert("steps".into(), Value::Array(shown));
        payload.insert("truncated".into(), json!(written.len() > EVENT_STEPS_MAX));
        if let Some(rows) = agent_rows {
            payload.insert("agents".into(), Value::Array(rows));
        }
        if !fields.is_empty() {
            let kept: Map<String, Value> = fields
                .iter()
                .filter(|(k, _)| k.as_str() != "steps_count")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            payload.insert("fields".into(), Value::Object(kept));
        }
        events::publish_typed("ai.step", &payload).await;
        events::mark_own_change();
    }
    Ok(written)
}

/// The batch a `StepWriter` holds until its next flush.
#[derive(Default)]
struct Pending {
    rows: Vec<Value>,
    agents: Vec<Value>,
    files: Vec<Value>,
    fields: Map<String, Value>,
}

struct Inner {
    run_id: String,
    pending: StdMutex<Pending>,
    task: StdMutex<Option<JoinHandle<()>>>,
    lock: tokio::sync::Mutex<()>,
    written: std::sync::atomic::AtomicUsize,
}

/// Gathers a run's steps as its stream yields them and writes them in batches.
#[derive(Clone)]
pub struct StepWriter {
    inner: Arc<Inner>,
}

impl StepWriter {
    /// Batch the steps of `run_id`.
    pub fn new(run_id: &str) -> Self {
        Self {
            inner: Arc::new(Inner {
                run_id: run_id.to_string(),
                pending: StdMutex::new(Pending::default()),
                task: StdMutex::new(None),
                lock: tokio::sync::Mutex::new(()),
                written: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    /// How many steps this writer has written so far.
    pub fn written(&self) -> usize {
        self.inner.written.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Queue rows (and agents, fields, files) for the next flush. Must run inside the Tokio runtime.
    pub fn add(&self, rows: Vec<Value>, agents: Vec<Value>, files: Vec<Value>, fields: Map<String, Value>) {
        {
            let mut p = self.inner.pending.lock().unwrap_or_else(|e| e.into_inner());
            p.rows.extend(rows);
            p.agents.extend(agents);
            p.files.extend(files);
            p.fields.extend(fields);
        }
        let mut task = self.inner.task.lock().unwrap_or_else(|e| e.into_inner());
        if task.as_ref().is_none_or(JoinHandle::is_finished) {
            let me = self.clone();
            *task = Some(ctx::spawn(async move { me.later().await }));
        }
    }

    async fn later(&self) {
        tokio::time::sleep(Duration::from_secs_f64(FLUSH_S)).await;
        self.flush().await;
    }

    /// Write what is queued now.
    pub async fn flush(&self) {
        let _guard = self.inner.lock.lock().await;
        let pending = std::mem::take(&mut *self.inner.pending.lock().unwrap_or_else(|e| e.into_inner()));
        if pending.rows.is_empty() && pending.agents.is_empty() && pending.files.is_empty() && pending.fields.is_empty()
        {
            return;
        }
        let extras = Extras { agents: pending.agents, fields: pending.fields, files: pending.files, announce: true };
        // a lost batch of steps never stops the run
        match append(&self.inner.run_id, pending.rows, extras).await {
            Ok(written) => {
                self.inner.written.fetch_add(written.len(), std::sync::atomic::Ordering::SeqCst);
            }
            Err(err) => tracing::error!("Could not write the steps of run {}: {err}", self.inner.run_id),
        }
    }

    /// Write what is left and stop the timer.
    pub async fn close(&self) {
        let task = self.inner.task.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task {
            if !task.is_finished() {
                task.abort();
            }
        }
        self.flush().await;
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Steps of a run after `after` (a seq), oldest first; with `last`, the newest `limit` instead.
pub async fn read(
    session: &Session,
    run_id: &str,
    after: i32,
    limit: u64,
    agent_id: Option<&str>,
    last: bool,
) -> Result<Vec<Value>, DbErr> {
    let mut stmt = ai_run_step::Entity::find().filter(ai_run_step::Column::RunId.eq(run_id));
    if after != 0 {
        stmt = stmt.filter(ai_run_step::Column::Seq.gt(after));
    }
    match agent_id.filter(|a| !a.is_empty()) {
        Some("lead") => stmt = stmt.filter(ai_run_step::Column::AgentId.is_null()),
        Some(agent) => stmt = stmt.filter(ai_run_step::Column::AgentId.eq(agent)),
        None => {}
    }
    stmt =
        if last { stmt.order_by_desc(ai_run_step::Column::Seq) } else { stmt.order_by_asc(ai_run_step::Column::Seq) };
    let mut rows = stmt.limit(limit).all(session).await?;
    if last {
        rows.reverse();
    }
    Ok(rows.iter().map(|s| to_dict(s, false)).collect())
}

/// A tool's result arrived for a step already written: its output and exit code go onto that step.
pub async fn attach_result(
    run_id: &str,
    tool_id: &str,
    output_text: Option<&str>,
    detail: &Map<String, Value>,
) -> Result<bool, DbErr> {
    let session = database::session();
    let row = ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.eq(run_id))
        .filter(ai_run_step::Column::ToolId.eq(tool_id))
        .one(&session)
        .await?;
    let Some(row) = row else { return Ok(false) };
    let mut current = match serde_json::from_str::<Value>(if row.detail.is_empty() { "{}" } else { &row.detail }) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let mut active = kb_db::edit(row);
    if let Some(text) = output_text.filter(|t| !t.is_empty()) {
        active.output = Set(Some(text.chars().take(OUTPUT_MAX).collect()));
    }
    current.extend(detail.clone());
    active.detail = Set(pyjson::dumps(&Value::Object(current)));
    active.update(&session).await?;
    session.commit().await?;
    Ok(true)
}

/// One step with its output.
pub async fn output(session: &Session, run_id: &str, seq: i32) -> Result<Option<Value>, DbErr> {
    let row = ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.eq(run_id))
        .filter(ai_run_step::Column::Seq.eq(seq))
        .one(session)
        .await?;
    Ok(row.map(|r| to_dict(&r, true)))
}

/// The subagents of a run, oldest first.
pub async fn agents(session: &Session, run_id: &str) -> Result<Vec<Value>, DbErr> {
    let rows = ai_run_agent::Entity::find()
        .filter(ai_run_agent::Column::RunId.eq(run_id))
        .order_by_asc(ai_run_agent::Column::StartedAt)
        .all(session)
        .await?;
    let marks = ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.eq(run_id))
        .filter(ai_run_step::Column::Kind.eq("role"))
        .order_by_asc(ai_run_step::Column::Seq)
        .all(session)
        .await?;
    Ok(rows
        .iter()
        .map(|a| {
            let mine: Vec<ai_run_step::Model> =
                marks.iter().filter(|m| m.agent_id.as_deref().unwrap_or("") == a.id).cloned().collect();
            agent_dict(a, Some(&mine))
        })
        .collect())
}

/// The CLI is gone: a role that never reported (its hook was lost, or it was stopped with the CLI) ends now.
pub async fn close_roles(run_id: &str) -> Result<(), DbErr> {
    let open: Vec<String> = {
        let session = database::session();
        agents(&session, run_id)
            .await?
            .into_iter()
            .filter(|a| a.get("ended_at").is_none_or(|e| !pyjson::truthy(e)))
            .filter_map(|a| a.get("id").and_then(Value::as_str).map(str::to_string))
            .collect()
    };
    if !open.is_empty() {
        let specs = open.into_iter().map(|id| json!({"id": id, "ended": true})).collect();
        append(run_id, Vec::new(), Extras { agents: specs, ..Extras::default() }).await?;
    }
    Ok(())
}

/// Every step of a run (for the work log and the transcript).
pub async fn all_rows(session: &Session, run_id: &str) -> Result<Vec<ai_run_step::Model>, DbErr> {
    ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.eq(run_id))
        .order_by_asc(ai_run_step::Column::Seq)
        .all(session)
        .await
}

/// Forget a run's steps and agents (retention, a deleted project).
pub async fn delete_for_run(session: &Session, run_id: &str) -> Result<(), DbErr> {
    for row in ai_run_step::Entity::find().filter(ai_run_step::Column::RunId.eq(run_id)).all(session).await? {
        row.delete(session).await?;
    }
    for row in ai_run_agent::Entity::find().filter(ai_run_agent::Column::RunId.eq(run_id)).all(session).await? {
        row.delete(session).await?;
    }
    Ok(())
}
