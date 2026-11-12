//! Ending (`services/ai/runs.py` lines 952-1386): `_usage_line`, `_post_comment`, `_chat_was_enough`, `_finish`,
//! `_needs_input`, `_log_work`, `_end`.

use chrono::Utc;
use kb_ai::store::{get_profile, get_settings, loads, now_iso, parse_iso};
use kb_ai::{audit, guard, steps, transcripts};
use kb_ai_know::knowledge;
use kb_ai_work::worktrees;
use kb_base::secrets::redact;
use kb_base::{pyjson, pytext};
use kb_board::tickets as svc_tickets;
use kb_db::database;
use kb_db::entities::{ai_chat, ai_chat_message, ai_run, member, ticket};
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QuerySelect,
};
use serde_json::{Map, Value, json};

use super::describe::publish_run;
use super::{ENDED, RT, RunError, clip, ctx_for, thousands};
use crate::{compact, teams, touches};

/// The keyword arguments of `_end` besides the state and the reason.
#[derive(Debug, Clone, Default)]
pub struct EndOpts {
    /// Who ended the run.
    pub by: Option<String>,
    /// Say nothing on the ticket and to nobody (the board is closing).
    pub quiet: bool,
    /// `stop_code=`: when given, the run's stop code becomes this (also when it is None).
    pub stop_code: Option<Option<String>>,
    /// `reply_comment_id=`: when given, the comment the run closed with.
    pub reply_comment_id: Option<Option<String>>,
}

/// A text of a report as Python reads it: the text itself, `str()` of anything else.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

fn usage_line(run: &ai_run::Model) -> String {
    let tokens = i64::from(run.tokens_in) + i64::from(run.tokens_out);
    if tokens == 0 {
        return String::new();
    }
    let model = run.model.as_deref().filter(|m| !m.is_empty()).unwrap_or("default model");
    format!("\n\n<sub>Run #{} · {} tokens · {model}</sub>", run.number, thousands(tokens))
}

async fn post_comment(
    ticket_id: Option<&str>,
    author: &str,
    text: &str,
    meta: Map<String, Value>,
) -> Result<Option<String>, RunError> {
    let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) else { return Ok(None) };
    let session = database::session();
    let ticket = svc_tickets::add_comment(&session, ticket_id, text, author, Some(&meta)).await?;
    let comments = match ticket {
        Some(ticket) => loads(Some(&ticket.comments), json!([])),
        None => json!([]),
    };
    let last = comments.as_array().and_then(|list| list.last());
    Ok(last.and_then(|c| c.get("id")).and_then(Value::as_str).map(str::to_string))
}

/// A run a person's chat message started, and the team says in its report that the chat answer is enough
/// (`comment_needed: false`) and did answer with `ai_run reply` while it ran: its report stays on the run and the
/// ticket gets no closing comment that only says "I replied in the chat". (Any status but `blocked`: a team often
/// says `partial` after a chat answer because the ticket's own work is still open.) A report that does not say so, a
/// run that did not answer in the chat, and any run that is not a chat message get the comment, so work never goes
/// unreported. (Not used as a sign: the run's workspace files can be empty after real work; the open items repeat
/// "a person moves the ticket to done" in every report.)
async fn chat_was_enough(run_id: &str, report: &Map<String, Value>, status: &str) -> Result<bool, RunError> {
    if status == "blocked"
        || report.get("comment_needed") != Some(&Value::Bool(false))
        || report.get("branch").is_some_and(pyjson::truthy)
    {
        return Ok(false);
    }
    let session = database::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(false) };
    let Some(ticket_id) = run.ticket_id.as_deref().filter(|t| !t.is_empty()) else { return Ok(false) };
    if run.trigger != "message" {
        return Ok(false);
    }
    let since = run.started_at.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| run.queued_at.clone());
    let chats: Vec<String> = ai_chat::Entity::find()
        .filter(ai_chat::Column::Scope.eq("ticket"))
        .filter(ai_chat::Column::ScopeId.eq(ticket_id))
        .all(&session)
        .await?
        .into_iter()
        .map(|c| c.id)
        .collect();
    if chats.is_empty() {
        return Ok(false);
    }
    let answered = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.is_in(chats))
        .filter(ai_chat_message::Column::Role.eq("ai"))
        .filter(ai_chat_message::Column::MemberId.eq(run.member_id.as_str()))
        .filter(ai_chat_message::Column::State.eq("done"))
        .filter(ai_chat_message::Column::FinishedAt.gte(since))
        .limit(1)
        .one(&session)
        .await?;
    Ok(answered.is_some())
}

/// `_finish`: the lead answered; keep its report, its lessons, its question or its closing comment, and end the run.
pub(crate) async fn finish(run_id: &str, result: &Value) -> Result<(), RunError> {
    let report: Map<String, Value> = match result.get("structured") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let truthy = |key: &str| report.get(key).filter(|v| pyjson::truthy(v));
    let (name, summary, status, lessons_mode, lessons_max, ticket_id, number, project_id, member_id) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(()) };
        if ENDED.contains(&run.state.as_str()) {
            return Ok(());
        }
        let (member, _profile) = get_profile(&session, &run.member_id).await?;
        let name = member.map_or_else(|| "AI".to_string(), |m| m.name);
        let said = truthy("summary")
            .or_else(|| result.get("text").filter(|v| pyjson::truthy(v)))
            .map(text_of)
            .unwrap_or_default();
        let summary = match pytext::strip(&said) {
            "" => "Finished.".to_string(),
            text => text.to_string(),
        };
        let status = truthy("status").map(text_of).unwrap_or_else(|| "done".to_string());
        let settings = get_settings(&session, &run.project_id).await?;
        let kept = if report.is_empty() { json!({"summary": summary}) } else { Value::Object(report.clone()) };
        let (ticket_id, number, project_id, member_id) =
            (run.ticket_id.clone(), run.number, run.project_id.clone(), run.member_id.clone());
        let mut row = kb_db::edit(run);
        row.summary = Set(Some(clip(&summary, 8000)));
        row.report = Set(pyjson::dumps(&kept));
        row.update(&session).await?;
        session.commit().await?;
        (name, summary, status, settings.lessons_mode, settings.lessons_max, ticket_id, number, project_id, member_id)
    };
    // lessons the lead proposes go to the project's memory: kept at once while the project has room for them
    // (`lessons_max`), else for a person to review
    let mut room = {
        let session = database::session();
        match knowledge::lessons(&session, &project_id, Some("kept")).await {
            Ok(kept) => i64::from(lessons_max) - kept.len() as i64,
            // a lesson is a bonus
            Err(_) => 0,
        }
    };
    let lessons: Vec<Value> = match truthy("lessons") {
        Some(Value::Array(list)) => list.iter().take(5).cloned().collect(),
        _ => Vec::new(),
    };
    for text in lessons {
        let Some(text) = text.as_str().map(pytext::strip).filter(|t| !t.is_empty()) else { continue };
        let keep = lessons_mode == "auto" && room > 0;
        let session = database::session();
        let opts = knowledge::LessonOpts {
            state: if keep { "kept" } else { "proposed" },
            proposed_by: Some(&name),
            source_ticket_id: ticket_id.as_deref(),
            source_run_id: Some(run_id),
        };
        match knowledge::add_lesson(&session, &project_id, &clip(text, 300), &name, opts).await {
            Ok(_) => {
                if keep {
                    room -= 1;
                }
            }
            // a lesson is a bonus
            Err(err) => tracing::debug!(target: "kanban.ai.runs", "lesson not kept: {err}"),
        }
    }
    let asks_given = match truthy("asks") {
        Some(Value::Array(list)) => list.clone(),
        _ => Vec::new(),
    };
    if status == "question" && !asks_given.is_empty() {
        let asks: Vec<String> = asks_given
            .iter()
            .filter_map(Value::as_str)
            .filter(|a| !pytext::strip(a).is_empty())
            .map(str::to_string)
            .collect();
        // (`asks[0]` of a list with no text in it: Python's IndexError ends the run as failed)
        let Some(first) = asks.first() else { return Err(RunError::Other("list index out of range".to_string())) };
        let more: Vec<&String> = asks.iter().skip(1).take(5).collect();
        {
            let session = database::session();
            let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
                return Err(RunError::Other("'NoneType' object has no attribute 'question'".to_string()));
            };
            let question = json!({
                "text": clip(first, 1000),
                "options": [],
                "to": run.started_by,
                "asked_at": now_iso(),
                "more": more,
                "previous": touches::carry_answer(run.question.as_deref(), run.answer.as_deref()),
            });
            let mut row = kb_db::edit(run);
            row.question = Set(Some(pyjson::dumps(&question)));
            row.update(&session).await?;
            session.commit().await?;
        }
        let mut text = format!("**{name} asks:** {first}");
        if asks.len() > 1 {
            text += "\n\n";
            text += &more.iter().map(|a| format!("- {a}")).collect::<Vec<_>>().join("\n");
        }
        let mut meta = Map::new();
        meta.insert("kind".into(), json!("question"));
        meta.insert("run_id".into(), json!(run_id));
        meta.insert("run_number".into(), json!(number));
        post_comment(ticket_id.as_deref(), &name, &text, meta).await?;
        needs_input(run_id).await?;
        return Ok(());
    }
    let mut lines = vec![summary];
    if let Some(open) = truthy("open_items") {
        let items: Vec<String> = open.as_array().map(|l| l.iter().take(8).map(text_of).collect()).unwrap_or_default();
        lines.push(format!("**Open:** {}", items.join("; ")));
    }
    let skills_used: Vec<String> = match truthy("skills") {
        Some(Value::Array(list)) => {
            list.iter().map(text_of).filter(|x| !pytext::strip(x).is_empty()).take(12).collect()
        }
        _ => Vec::new(),
    };
    if !skills_used.is_empty() {
        lines.push(format!("Skills: {}", skills_used.iter().map(|x| format!("`{x}`")).collect::<Vec<_>>().join(", ")));
    }
    if let Some(branch) = truthy("branch") {
        let mut line = format!("Branch: `{}`", text_of(branch));
        if let Some(pr) = truthy("pr_url") {
            line += &format!(" · PR {}", text_of(pr));
        }
        lines.push(line);
    }
    let text = {
        let session = database::session();
        let run = ai_run::Entity::find_by_id(run_id).one(&session).await?;
        lines.join("\n\n") + &run.as_ref().map(usage_line).unwrap_or_default()
    };
    let reply_id = if chat_was_enough(run_id, &report, &status).await? {
        // the answer is in the ticket chat (with its "Post as comment"): a closing comment would say it twice
        None
    } else {
        let mut meta = Map::new();
        meta.insert("kind".into(), json!("summary"));
        meta.insert("run_id".into(), json!(run_id));
        meta.insert("run_number".into(), json!(number));
        meta.insert("member_id".into(), json!(member_id));
        meta.insert("status".into(), json!(status));
        post_comment(ticket_id.as_deref(), &name, &redact(&text), meta).await?
    };
    let mut reason = None;
    if status == "blocked" {
        let first = match truthy("open_items") {
            Some(Value::Array(list)) => list.first().map(text_of),
            _ => None,
        };
        reason = Some(format!("Blocked: {}", clip(&first.unwrap_or_else(|| "see the summary".to_string()), 200)));
    }
    let opts = EndOpts { reply_comment_id: Some(reply_id), ..EndOpts::default() };
    end(run_id, "finished", reason.as_deref(), opts).await?;
    Ok(())
}

/// `_needs_input`: the lead asked a person; the run parks until the answer.
pub(crate) async fn needs_input(run_id: &str) -> Result<(), RunError> {
    let (started_by, asked) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(()) };
        if ENDED.contains(&run.state.as_str()) {
            return Ok(());
        }
        let (member, _) = get_profile(&session, &run.member_id).await?;
        let mut q = match loads(run.question.as_deref(), json!({})) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let asked = q.get("text").map(text_of).unwrap_or_default();
        let ticket = match run.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            Some(ticket_id) => ticket::Entity::find_by_id(ticket_id).one(&session).await?,
            None => None,
        };
        if let Some(ticket) = ticket.filter(|t| !t.pending && !matches!(t.status.as_str(), "done" | "wont_do")) {
            let human = member::Entity::find()
                .filter(member::Column::ProjectId.eq(run.project_id.as_str()))
                .filter(member::Column::Kind.eq("human"))
                .filter(member::Column::Name.eq(run.started_by.as_str()))
                .one(&session)
                .await?;
            let context = ctx_for(&session, &run).await?;
            let note = clip(&format!("{} asks: {asked}", member.as_ref().map_or("AI", |m| m.name.as_str())), 240);
            let mut reason = svc_tickets::reopen::PendingReason::new(if human.is_some() { "person" } else { "party" });
            reason.member_id = human.as_ref().map(|h| h.id.as_str());
            reason.party = match &human {
                Some(_) => None,
                None if run.started_by != "user" => Some(run.started_by.as_str()),
                None => Some("the board user"),
            };
            reason.note = Some(&note);
            let tokens = guard::enter(&context);
            let set = svc_tickets::reopen::set_pending(&session, &ticket.id, reason).await;
            guard::leave(tokens);
            match set {
                Ok(_) => {}
                Err(svc_tickets::Error::Value(_)) => {
                    tracing::warn!(target: "kanban.ai.runs", "Could not set Pending on {} for run {run_id}", ticket.id);
                }
                Err(err) => return Err(err.into()),
            }
        }
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(()) };
        if !q.get("asked_at").is_some_and(pyjson::truthy) {
            q.insert("asked_at".into(), json!(now_iso()));
        }
        let started_by = run.started_by.clone();
        let mut row = kb_db::edit(run);
        row.state = Set("needs_input".to_string());
        row.token_hash = Set(None);
        row.pid = Set(None);
        row.question = Set(Some(pyjson::dumps(&Value::Object(q))));
        row.update(&session).await?;
        session.commit().await?;
        (started_by, asked)
    };
    let title = format!("Asked {started_by}: {}", clip(&asked, 200));
    super::append_steps(run_id, vec![json!({"kind": "question", "title": title})], steps::Extras::default()).await?;
    guard::forget_run(run_id);
    publish_run(run_id).await?;
    // (the question notice never fails the run: it logs what went wrong itself)
    kb_notify::on_run_question(run_id, false, None, None).await;
    Ok(())
}

/// Every ended work run leaves an entry in the ticket's work log.
async fn log_work(run: &ai_run::Model, state: &str, reason: Option<&str>) {
    let Some(ticket_id) = run.ticket_id.as_deref().filter(|t| !t.is_empty()) else { return };
    let written: Result<(), RunError> = async {
        let session = database::session();
        let (member, _profile) = get_profile(&session, &run.member_id).await?;
        let Some(member) = member else { return Ok(()) };
        let rows = steps::all_rows(&session, &run.id).await?;
        let files = match loads(Some(&run.files), json!([])) {
            Value::Array(list) => list,
            _ => Vec::new(),
        };
        let report = match loads(Some(&run.report), json!({})) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let seconds = if run.started_at.as_deref().is_some_and(|s| !s.is_empty()) {
            let now = Utc::now();
            let at = |text: Option<&str>| parse_iso(text).map_or(now, |t| t.with_timezone(&Utc));
            (at(run.ended_at.as_deref()) - at(run.started_at.as_deref())).num_seconds()
        } else {
            0
        };
        let model = run.model.as_deref().filter(|m| !m.is_empty()).unwrap_or("default model");
        let mut lines = vec![format!(
            "**Run #{}** {state} · {} min {} s · {} tokens · {model} · started by {} ({})",
            run.number,
            seconds.div_euclid(60),
            seconds.rem_euclid(60),
            thousands(i64::from(run.tokens_in) + i64::from(run.tokens_out)),
            run.started_by,
            run.trigger
        )];
        let said = report
            .get("summary")
            .filter(|v| pyjson::truthy(v))
            .map(text_of)
            .or_else(|| run.summary.clone().filter(|s| !s.is_empty()))
            .or_else(|| reason.map(str::to_string))
            .unwrap_or_default();
        let said = pytext::strip(&said);
        if !said.is_empty() {
            lines.extend([String::new(), "**Summary**".to_string(), clip(said, 1800)]);
        }
        if !files.is_empty() {
            lines.extend([String::new(), "**Files changed**".to_string()]);
            for f in files.iter().take(15) {
                let shown = |key: &str, default: &str| f.get(key).map_or_else(|| default.to_string(), pyjson::py_str);
                lines.push(format!(
                    "- `{}` (+{} −{})",
                    shown("path", "None"),
                    shown("added", "0"),
                    shown("removed", "0")
                ));
            }
        }
        let titles = |kind: &str| rows.iter().filter(|s| s.kind == kind).map(|s| s.title.clone()).collect::<Vec<_>>();
        let commands: Vec<String> = titles("command").into_iter().take(10).collect();
        if !commands.is_empty() {
            lines.extend([String::new(), "**Commands**".to_string()]);
            lines.extend(commands.iter().map(|c| format!("- {c}")));
        }
        let agents: Vec<String> = titles("subagent").into_iter().take(8).collect();
        if !agents.is_empty() {
            lines.extend([String::new(), "**Roles used**".to_string()]);
            lines.extend(agents.iter().map(|a| format!("- {a}")));
        }
        let mut board: Vec<String> = Vec::new();
        for title in titles("board") {
            if !board.contains(&title) {
                board.push(title);
            }
        }
        board.truncate(12);
        if !board.is_empty() {
            lines.extend([String::new(), "**Board actions**".to_string()]);
            lines.extend(board.iter().map(|b| format!("- {b}")));
        }
        if let Some(Value::Object(tests)) = report.get("tests") {
            let count = |key: &str| tests.get(key).map_or_else(|| "0".to_string(), pyjson::py_str);
            lines.extend([
                String::new(),
                format!("**Tests (as reported)**: {} passed, {} failed", count("passed"), count("failed")),
            ]);
        }
        if let (true, Some(reason)) = (state != "finished", reason.filter(|r| !r.is_empty())) {
            lines.extend([String::new(), format!("**Why it stopped**: {}", clip(reason, 300))]);
        }
        let kind = if state != "finished" {
            "blocked"
        } else if !files.is_empty() {
            "fix_attempt"
        } else {
            "investigation"
        };
        let note = lines.join("\n");
        let mut entry = svc_tickets::work_log::NewWorkLog::new(&member.name, "Developer", &note);
        entry.kind = kind;
        svc_tickets::work_log::add_work_log(&session, ticket_id, entry).await?;
        Ok(())
    }
    .await;
    if let Err(err) = written {
        tracing::error!(target: "kanban.ai.runs", "Could not write the work log of run {}: {err}", run.id);
    }
}

/// `text.capitalize()`.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect(),
        None => String::new(),
    }
}

/// Move a run to an ended state (once): kills its token, closes the transcript, logs, tells people.
pub async fn end(
    run_id: &str,
    state: &str,
    reason: Option<&str>,
    opts: EndOpts,
) -> Result<Option<ai_run::Model>, RunError> {
    let EndOpts { by, quiet, stop_code, reply_comment_id } = opts;
    let (run, member) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(None) };
        if ENDED.contains(&run.state.as_str()) {
            return Ok(Some(run));
        }
        let mut row = kb_db::edit(run);
        row.state = Set(state.to_string());
        row.ended_at = Set(Some(now_iso()));
        row.ended_reason = Set(reason.map(str::to_string));
        row.ended_by = Set(by.clone());
        row.token_hash = Set(None);
        row.pid = Set(None);
        row.paused = Set(false);
        row.live = Set(false);
        row.waiting_reason = Set(None);
        if let Some(stop_code) = stop_code {
            row.stop_code = Set(stop_code);
        }
        if let Some(reply_comment_id) = reply_comment_id {
            row.reply_comment_id = Set(reply_comment_id);
        }
        let run = row.update(&session).await?;
        session.commit().await?;
        let (member, profile) = get_profile(&session, &run.member_id).await?;
        // a run that hit the account's usage limit marks its team "Rate-limited"; the next run that finishes clears it
        if let Some(mut profile) = profile {
            if teams::note_run_outcome(&mut profile, state, run.stop_code.as_deref(), reason) {
                let (health, detail) = (profile.health.clone(), profile.health_detail.clone());
                let mut row = kb_db::edit(profile);
                row.health = Set(health);
                row.health_detail = Set(detail);
                row.update(&session).await?;
                session.commit().await?;
            }
        }
        (run, member)
    };
    let writer = RT.inner().writers.remove(run_id);
    if let Some(writer) = writer {
        writer.close().await;
    }
    if let Some(reason) = reason.filter(|r| !r.is_empty()) {
        transcripts::note(run_id, "end", &format!("{state}: {reason}"), None);
    }
    transcripts::finish(run_id).await;
    super::execute::settled(run_id).await;
    let said = reason.filter(|r| !r.is_empty()).map(|r| clip(&format!(": {r}"), 240)).unwrap_or_default();
    let mut fields = Map::new();
    fields.insert("state".into(), json!(state));
    super::append_steps(
        run_id,
        vec![json!({"kind": "end", "title": format!("{}{said}", capitalize(state))})],
        steps::Extras { fields, ..steps::Extras::default() },
    )
    .await?;
    guard::forget_run(run_id);
    let mut detail = Map::new();
    detail.insert("reason".into(), json!(reason));
    detail.insert("by".into(), json!(by));
    audit::record(
        &run.project_id,
        &format!("run_{state}"),
        "info",
        audit::Entry {
            member_id: Some(run.member_id.clone()),
            member_name: member.as_ref().map_or_else(String::new, |m| m.name.clone()),
            on_behalf_of: Some(run.started_by.clone()),
            run_id: Some(run.id.clone()),
            target: run.ticket_id.clone(),
            detail,
        },
    )
    .await?;
    let ticket_id = run.ticket_id.clone().filter(|t| !t.is_empty());
    if !quiet {
        if let (true, Some(member), Some(ticket_id)) = (state == "failed", &member, &ticket_id) {
            let mut meta = Map::new();
            meta.insert("kind".into(), json!("failed"));
            meta.insert("run_id".into(), json!(run.id));
            meta.insert("run_number".into(), json!(run.number));
            meta.insert("member_id".into(), json!(run.member_id));
            let text = format!(
                "Run #{} failed: {}. Partial work is kept; Retry starts a new run.{}",
                run.number,
                reason.filter(|r| !r.is_empty()).unwrap_or("no reason given"),
                usage_line(&run)
            );
            post_comment(Some(ticket_id), &member.name, &text, meta).await?;
        }
        if run.mode == "work" && matches!(state, "finished" | "failed") {
            log_work(&run, state, reason).await;
        }
        // (the end notice never fails the run: it logs what went wrong itself)
        kb_notify::on_run_ended(&run.id).await;
        if let Some(ticket_id) = &ticket_id {
            if let Err(err) = worktrees::tidy_after_run(ticket_id, &run.id).await {
                tracing::debug!(target: "kanban.ai.runs", "tidy after run failed: {err}");
            }
        }
    }
    if let Some(ticket_id) = &ticket_id {
        // a Review hand-over (push, pull request) that waited for this run to stop goes now
        worktrees::after_run(ticket_id);
        // a compaction asked for in the chat is a convenience
        compact::after_run(ticket_id, &run.id);
    }
    super::forget_append_lock(run_id);
    RT.wake.set();
    publish_run(run_id).await?;
    Ok(Some(run))
}
