//! The hooks and seams of other crates that this crate backs (`register` in `lib.rs` fills them):
//!
//! - `kb_ai_run::seams::PageNotes` ([`Notes`]): what `messaging.deliver_to_page` asks of Docs comments, the assistant
//!   and the Docs AI jobs (late imports in `services/ai/messaging.py`).
//! - `seams::Runs` of this crate ([`CoreRuns`]): `services/ai/runs.py` and `services/ai/messaging.py`, as
//!   `kb_ai_run::runs` and `kb_ai_run::messaging` port them.
//! - `kb_docs::hooks::DocsAiHook` ([`Docs`]): the Docs AI on the comments and the "send to AI" routes
//!   (`services/docs_comments.py` and `api/docs.py` import `services.assistant.docs` and `services.docs_ai.handoff`
//!   late).
//! - `kb_docs::hooks::AssignHook` ([`Assign`], `docs_work.assign_page`): `create_ticket` and `assign` are
//!   `kb_board::tickets` calls, `wake_new_assignee` goes through `seams::Runs::wake_new_assignee`.
//!
//! `kb_draw::hooks::CanvasDelivery` is not registered here: `kb_ai_run::register()` registers it (it calls
//! `messaging` directly), and the slot holds one.

use async_trait::async_trait;
use kb_board::tickets::{self, NewTicket, TicketUpdate};
use kb_db::Session;
use kb_db::entities::{ai_run, docs_page, member};
use kb_db::sea_orm::DbErr;
use kb_docs::hooks::{AssignHook, DocsAiHook, RunBrief, TicketBrief};
use serde_json::{Map, Value, json};

use crate::assistant::docs;
use crate::docs_ai::errors::Error;
use crate::docs_ai::handoff::{self, SendOpts};
use crate::docs_ai::jobs::{self, NewJob};
use crate::seams::{self, DeliverError};

/// The error of a runs call as `seams::DeliverError` tells it (`kb_ai_run::seams::deliver_error`: a `RunError` is
/// the one callers catch, anything else is a failure of the call).
fn deliver_error(err: kb_ai_run::runs::RunError) -> DeliverError {
    if err.is_run_error() { DeliverError::Run(err.to_string()) } else { DeliverError::Other(err.to_string()) }
}

/// The `seams::Runs` this crate registers: `services/ai/runs.py` as `kb_ai_run` ports it.
pub struct CoreRuns;

#[async_trait]
impl seams::Runs for CoreRuns {
    fn url(&self) -> String {
        kb_ai_run::runs::url()
    }

    fn to_dict(&self, run: &ai_run::Model) -> Map<String, Value> {
        kb_ai_run::runs::to_dict(run)
    }

    /// `ai_runs.deliver_to_ticket(ticket_id, text, by=by)`: the Python defaults are `trigger="message"`, `depth=0`.
    async fn deliver_to_ticket(&self, ticket_id: &str, text: &str, by: &str) -> Result<Value, DeliverError> {
        self.deliver_to_ticket_with(ticket_id, text, by, "message", 0).await
    }

    async fn deliver_to_ticket_with(
        &self,
        ticket_id: &str,
        text: &str,
        by: &str,
        trigger: &str,
        depth: i64,
    ) -> Result<Value, DeliverError> {
        kb_ai_run::runs::deliver_to_ticket(ticket_id, text, by, trigger, depth)
            .await
            .map(Value::Object)
            .map_err(deliver_error)
    }

    async fn deliver_to_page(&self, page_id: &str, note: &str, by: &str, depth: i64) -> Result<Value, DeliverError> {
        kb_ai_run::messaging::deliver_to_page(page_id, note, by, depth).await.map(Value::Object).map_err(deliver_error)
    }

    async fn wake_new_assignee(
        &self,
        ticket_id: &str,
        member_id: &str,
        by: Option<&str>,
        instruction: &str,
    ) -> Option<(String, String)> {
        match kb_ai_run::runs::wake_new_assignee(ticket_id, Some(member_id), by, instruction).await {
            Ok(run) => run.map(|run| (run.id, run.state)),
            Err(err) => {
                tracing::error!("waking the new assignee of {ticket_id} failed: {err}");
                None
            }
        }
    }
}

/// A failure of this crate as the text of a `DbErr` (what a seam that answers `DbErr` can carry).
fn db_err(err: Error) -> DbErr {
    match err {
        Error::Db(err) | Error::Docs(kb_docs::Error::Db(err)) => err,
        other => DbErr::Custom(other.to_string()),
    }
}

/// The `kb_ai_run::seams::PageNotes` this crate registers: `messaging.deliver_to_page`'s late imports.
pub struct Notes;

#[async_trait]
impl kb_ai_run::seams::PageNotes for Notes {
    async fn create_thread(&self, session: &Session, page_id: &str, body: &str) -> Result<Map<String, Value>, String> {
        kb_docs::docs_comments::create_thread(session, page_id, "page", body, None, None)
            .await
            .map_err(|err| err.to_string())
    }

    async fn docs_ai_on(&self, session: &Session, project_id: &str) -> Result<bool, DbErr> {
        docs::docs_ai_on(session, project_id).await.map_err(db_err)
    }

    async fn ready_state(&self, project_id: &str) -> Result<String, String> {
        // `engine.ready(project_id)`: the default feature is "chat"
        let info = crate::assistant::engine::ready(project_id, "chat").await.map_err(|err| err.to_string())?;
        Ok(info.get("state").and_then(Value::as_str).unwrap_or("").to_string())
    }

    async fn start_thread_reply(
        &self,
        session: &Session,
        project_id: &str,
        by: &str,
        page_id: &str,
        thread_id: &str,
        instruction: &str,
        depth: i64,
    ) -> Result<String, String> {
        let new = NewJob {
            project_id: project_id.to_string(),
            kind: "thread_reply".to_string(),
            started_by: by.to_string(),
            page_id: Some(page_id.to_string()),
            thread_id: Some(thread_id.to_string()),
            instruction: instruction.to_string(),
            result: Some(json!({"input": {"depth": depth}})),
            ..Default::default()
        };
        jobs::start(session, new).await.map(|job| job.id).map_err(|err| err.to_string())
    }
}

/// What a Docs AI failure is to the Docs route that called it: a `DocsError` stays one, an exception with a handler
/// of its own in the app (`DocsAiError`, `AssistError`) is its answer, the rest is a failure of the call.
fn for_docs(err: Error) -> kb_docs::Error {
    let json_of = |status: u16, code: &str, message: &str, extra: &Map<String, Value>| {
        let mut body = Map::new();
        body.insert("detail".into(), json!(message));
        body.insert("code".into(), json!(code));
        for (key, value) in extra {
            body.insert(key.clone(), value.clone());
        }
        kb_docs::Error::Json { status, body: Value::Object(body) }
    };
    match err {
        Error::Docs(err) => err,
        Error::Db(err) => kb_docs::Error::Db(err),
        Error::DocsAi(err) => json_of(err.status(), &err.code, &err.message, &err.extra),
        Error::Assist(err) => {
            json_of(crate::assistant::errors::status(&err.code).unwrap_or(400), &err.code, &err.message, &err.extra)
        }
        other @ (Error::Ticket(_) | Error::Other(_)) => kb_docs::Error::Other(other.to_string()),
    }
}

/// The `kb_docs::hooks::DocsAiHook` this crate registers.
pub struct Docs;

#[async_trait]
impl DocsAiHook for Docs {
    async fn docs_ai_on(&self, session: &Session, project_id: &str) -> kb_docs::Result<bool> {
        docs::docs_ai_on(session, project_id).await.map_err(for_docs)
    }

    async fn member_rows(
        &self,
        session: &Session,
        project_id: &str,
        members: &[member::Model],
        docs_ai: bool,
    ) -> kb_docs::Result<Vec<Value>> {
        docs::member_rows(session, project_id, members, docs_ai).await.map_err(for_docs)
    }

    async fn annotate(
        &self,
        session: &Session,
        page: &docs_page::Model,
        threads: &mut [Map<String, Value>],
    ) -> kb_docs::Result<bool> {
        docs::annotate(session, page, threads).await.map_err(for_docs)
    }

    async fn deliver(
        &self,
        session: &Session,
        thread: &Map<String, Value>,
        by: &str,
        intent: &str,
    ) -> kb_docs::Result<Vec<Value>> {
        docs::deliver(session, thread, by, intent).await.map_err(for_docs)
    }

    async fn send_to_ai_targets(&self, session: &Session, page_id: &str) -> kb_docs::Result<Map<String, Value>> {
        handoff::targets(session, page_id).await.map_err(for_docs)
    }

    async fn send_to_ai(
        &self,
        session: &Session,
        page_id: &str,
        thread_ids: &[String],
        to: &str,
        ticket_id: Option<&str>,
        give_team_id: Option<&str>,
    ) -> kb_docs::Result<Map<String, Value>> {
        let opts = SendOpts {
            page_id: Some(page_id.to_string()),
            thread_ids: thread_ids.to_vec(),
            from_ticket: None,
            to: to.to_string(),
            ticket_id: ticket_id.map(str::to_string),
            give_team_id: give_team_id.map(str::to_string),
        };
        handoff::send(session, opts).await.map_err(for_docs)
    }

    async fn ticket_doc_comments(&self, session: &Session, ticket_id: &str) -> kb_docs::Result<Map<String, Value>> {
        let groups = handoff::threads_of_ticket(session, ticket_id).await.map_err(for_docs)?;
        let mut out = Map::new();
        out.insert("threads".into(), json!(groups.iter().map(|(_, ts)| ts.len()).sum::<usize>()));
        out.insert(
            "pages".into(),
            Value::Array(
                groups.iter().map(|(p, ts)| json!({"page_id": p.id, "title": p.title, "threads": ts.len()})).collect(),
            ),
        );
        out.insert("max_threads".into(), json!(handoff::MAX_THREADS));
        // the team that built the first of those pages (the default for "give it to a team")
        let builder = match groups.first() {
            Some((page, _)) => handoff::builder_team_of(session, page).await.map_err(for_docs)?,
            None => None,
        };
        out.insert("builder_team".into(), builder.unwrap_or(Value::Null));
        Ok(out)
    }

    async fn send_ticket_doc_comments(
        &self,
        session: &Session,
        ticket_id: &str,
        give_team_id: Option<&str>,
    ) -> kb_docs::Result<Map<String, Value>> {
        let opts = SendOpts {
            from_ticket: Some(ticket_id.to_string()),
            give_team_id: give_team_id.map(str::to_string),
            ..SendOpts::new()
        };
        handoff::send(session, opts).await.map_err(for_docs)
    }
}

/// The `kb_docs::hooks::AssignHook` this crate registers.
pub struct Assign;

#[async_trait]
impl AssignHook for Assign {
    async fn create_ticket(
        &self,
        session: &Session,
        project_id: &str,
        title: &str,
        description: &str,
        created_by: Option<&str>,
    ) -> Result<TicketBrief, String> {
        let mut new = NewTicket::new(title);
        new.status = "todo";
        new.description = description;
        new.created_by = created_by;
        match tickets::create_ticket(session, project_id, new).await {
            Ok(t) => Ok(TicketBrief { id: t.id, title: t.title }),
            Err(err) => Err(ticket_message(err)),
        }
    }

    async fn assign(&self, session: &Session, ticket_id: &str, member_id: &str) -> Result<(), String> {
        tickets::update_ticket(session, ticket_id, &TicketUpdate::of("assignee", json!(member_id)))
            .await
            .map(|_| ())
            .map_err(ticket_message)
    }

    async fn wake_new_assignee(
        &self,
        ticket_id: &str,
        member_id: &str,
        by: Option<&str>,
        instruction: &str,
    ) -> Option<RunBrief> {
        let runs = seams::runs()?;
        runs.wake_new_assignee(ticket_id, member_id, by, instruction).await.map(|(id, state)| RunBrief { id, state })
    }
}

/// The text of a failed ticket call (`str(exc)`).
fn ticket_message(err: tickets::Error) -> String {
    match err {
        tickets::Error::Value(message) | tickets::Error::NoResult(message) | tickets::Error::Other(message) => message,
        tickets::Error::Db(err) => err.to_string(),
    }
}

/// `kb_ai_run::seams::Assistant`: the assistant's engine for the modules of the runs that ask it something
/// (`session_history.start_over`, `schedules.dry_run`).
pub struct Engine;

fn assist_turn(turn: crate::assistant::engine::Turn) -> kb_ai_run::seams::AssistTurn {
    let data = turn.data();
    kb_ai_run::seams::AssistTurn {
        state: turn.state,
        error: turn.error,
        text: turn.text,
        structured: turn.structured,
        data,
        member: turn.member,
        model: turn.model,
        cost: turn.cost,
    }
}

fn assist_failure(err: crate::assistant::errors::Error) -> kb_ai_run::seams::AssistFailure {
    use crate::assistant::errors::Error as AssistantError;
    match err {
        AssistantError::Assist(refused) => kb_ai_run::seams::AssistFailure::Assist(refused.to_string()),
        other => kb_ai_run::seams::AssistFailure::Other(other.to_string()),
    }
}

#[async_trait]
impl kb_ai_run::seams::Assistant for Engine {
    async fn oneshot(
        &self,
        skill: &str,
        inputs: Map<String, Value>,
        by: &str,
        model: &str,
    ) -> Result<kb_ai_run::seams::AssistTurn, kb_ai_run::seams::AssistFailure> {
        use crate::assistant::engine::{self, OneshotOpts};
        let opts = OneshotOpts { by, model, ..OneshotOpts::default() };
        engine::oneshot(skill, &inputs, opts).await.map(assist_turn).map_err(assist_failure)
    }

    async fn turn(
        &self,
        project_id: &str,
        ask: kb_ai_run::seams::AssistAsk,
    ) -> Result<kb_ai_run::seams::AssistTurn, kb_ai_run::seams::AssistFailure> {
        use crate::assistant::engine::{self, TurnOpts};
        let mut opts = TurnOpts::new(&ask.name, &ask.skill, ask.inputs.clone(), &ask.by);
        opts.feature = &ask.feature;
        opts.ticket_id = ask.ticket_id.as_deref();
        opts.fresh = ask.fresh;
        opts.timeout_s = ask.timeout_s;
        engine::turn(project_id, opts).await.map(assist_turn).map_err(assist_failure)
    }
}
