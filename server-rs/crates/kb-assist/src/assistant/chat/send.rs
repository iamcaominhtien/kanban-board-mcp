//! `send`, `spawn` and `_answer` of `services/assistant/chat.py` (lines 518 to 824): asking in a chat, and the task
//! that writes the answer.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use kb_ai::store::{loads, now_iso};
use kb_base::{ctx, events, pyjson, pytext};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_chat, ai_chat_message};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use super::{ACTIVE, MAX_TEXT, SERIAL, chat_of, dict, msg_out, runs, tasks, team_note, ticket_team};
use crate::assistant::drafts::{self, NewDraft};
use crate::assistant::engine::{self, Schema, Turn, TurnOpts};
use crate::assistant::errors::{AssistError, Error};
use crate::assistant::settings::{self as svc_settings, round_to};
use crate::assistant::{receipt, sessions};
use crate::seams;

/// The keyword arguments of `send`.
#[derive(Debug, Clone, Default)]
pub struct SendOpts {
    /// Pages to read for this question.
    pub doc_ids: Vec<String>,
    /// `ask` (the default of the Python function) or what the UI sent.
    pub mode: Option<String>,
    /// (name, bytes) the question came with.
    pub files: Vec<(String, Vec<u8>)>,
    /// The skill that answers; None: `board-ask`.
    pub skill: Option<String>,
    /// More inputs for the skill.
    pub extra: Option<Map<String, Value>>,
}

/// Ask in a chat: the question and an answer that is being written (poll it) come back.
pub async fn send(
    session: &Session,
    chat_id: &str,
    by: &str,
    text: &str,
    opts: SendOpts,
) -> Result<Map<String, Value>, Error> {
    let SendOpts { doc_ids, mode, files, skill, extra } = opts;
    let mode = mode.unwrap_or_else(|| "ask".to_string());
    let skill = skill.unwrap_or_else(|| "board-ask".to_string());
    let chat = chat_of(session, chat_id, by).await?;
    let text = pytext::strip(text);
    if text.is_empty() {
        return Err(AssistError::new("invalid", "Write a question first.").into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(AssistError::new("too_large", format!("Keep the message under {MAX_TEXT} characters.")).into());
    }
    if !svc_settings::feature_on(session, if skill == "sketch-ask" { "sketch" } else { "chat" }).await? {
        return Err(AssistError::new("feature_off", "Ask AI is off in Settings › AI.").into());
    }
    let busy = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.eq(chat.id.as_str()))
        .filter(ai_chat_message::Column::State.is_in(ACTIVE))
        .count(session)
        .await?;
    if busy != 0 {
        return Err(AssistError::new("conflict", "The assistant is still answering in this chat.").into());
    }
    let info = engine::ready(&chat.project_id, "chat").await?;
    if info.get("state").and_then(Value::as_str) != Some("ready") {
        let message = info.get("message").and_then(Value::as_str).unwrap_or("");
        return Err(AssistError::new("not_configured", message).into());
    }
    let first = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.eq(chat.id.as_str()))
        .filter(ai_chat_message::Column::Role.eq("user"))
        .count(session)
        .await?
        == 0;
    let mut user = ai_chat_message::new();
    user.chat_id = Set(chat.id.clone());
    user.role = Set("user".to_string());
    user.text = Set(text.to_string());
    user.state = Set("done".to_string());
    user.finished_at = Set(Some(now_iso()));
    let mut ai = ai_chat_message::new();
    ai.chat_id = Set(chat.id.clone());
    ai.role = Set("ai".to_string());
    ai.state = Set("thinking".to_string());
    ai.context = Set(pyjson::dumps(&json!({
        "scope": chat.scope,
        "label": chat.title,
        "request": {
            "doc_ids": doc_ids,
            "mode": mode,
            "skill": skill,
            "extra": extra.unwrap_or_default(),
        },
    })));
    let mut title = chat.title.clone();
    let mut chat_row = chat.clone().into_active_model();
    if first && matches!(chat.title.as_str(), "New chat" | "") {
        title = pytext::squash(text).chars().take(60).collect();
        chat_row.title = Set(title.clone());
    }
    chat_row.updated_at = Set(now_iso());
    let team = match chat.scope_id.as_deref().filter(|id| !id.is_empty() && chat.scope == "ticket" && files.is_empty())
    {
        Some(scope_id) => ticket_team(session, scope_id).await?.map(|team| (team, scope_id.to_string())),
        None => None,
    };
    if let Some((team, _)) = &team {
        ai.member_id = Set(Some(team.id.clone())); // the team's lead answers, not the board's assistant
    }
    let user = user.insert(session).await?;
    let ai = ai.insert(session).await?;
    chat_row.update(session).await?;
    session.commit().await?;
    let ai = match team {
        Some((team, scope_id)) => {
            let note = team_note(by, &ai.id, text);
            let sent = match seams::runs() {
                Some(runs) => runs.deliver_to_ticket(&scope_id, &note, by).await.map_err(|err| match err {
                    seams::DeliverError::Run(message) => Error::Value(message),
                    seams::DeliverError::Other(message) => Error::Other(message),
                })?,
                None => {
                    return Err(Error::Other(
                        "The AI team's runs are not connected (kb_assist::seams::Runs): the note was not delivered."
                            .to_string(),
                    ));
                }
            };
            let mut row = ai.into_active_model();
            row.context = Set(pyjson::dumps(&json!({
                "scope": chat.scope,
                "label": title,
                "team": team.name,
                "delivered": sent,
            })));
            let ai = row.update(session).await?;
            session.commit().await?;
            ai
        }
        None => {
            spawn(&ai.id, by, files);
            ai
        }
    };
    let mut out = Map::new();
    out.insert("user".into(), msg_out(&user));
    out.insert("ai".into(), msg_out(&ai));
    Ok(out)
}

/// Write an answer in the background.
pub fn spawn(message_id: &str, by: &str, files: Vec<(String, Vec<u8>)>) {
    let stop = Arc::new(Notify::new());
    let serial = SERIAL.fetch_add(1, Ordering::SeqCst);
    tasks().insert(message_id.to_string(), (serial, stop.clone()));
    let (message_id, by) = (message_id.to_string(), by.to_string());
    ctx::spawn(async move {
        if let Err(err) = answer(&message_id, &by, files, &stop).await {
            tracing::error!(target: "kanban.assistant.chat", "chat answer {message_id} was not written: {err}");
        }
        let mut tasks = tasks();
        if tasks.get(&message_id).is_some_and(|(held, _)| *held == serial) {
            tasks.remove(&message_id);
        }
    });
}

/// `str(value)`.
fn py_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => pyjson::py_str(other),
    }
}

/// `value.get(key) or default`.
fn or_default(value: &Value, key: &str, default: Value) -> Value {
    value.get(key).filter(|v| pyjson::truthy(v)).cloned().unwrap_or(default)
}

/// `Path(f).name`.
fn file_name(path: &str) -> &str {
    path.split('/').rfind(|part| !part.is_empty() && *part != ".").unwrap_or("")
}

/// `type(exc).__name__` of what a turn failed with, as far as it can be told here.
fn kind_of(err: &Error) -> String {
    match err {
        Error::Assist(_) => "AssistError".to_string(),
        Error::Value(_) => "ValueError".to_string(),
        Error::Db(_) => "OperationalError".to_string(),
        Error::Other(message) => {
            let name = message.split(':').next().unwrap_or("");
            let named = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()) && name.ends_with("Error");
            if named { name.to_string() } else { "RuntimeError".to_string() }
        }
    }
}

/// How the turn of an answer ended.
enum Ended {
    Turn(Box<Turn>),
    Stopped,
    Failed(Value),
}

/// `_answer`: run the turn of an answer and write what it gave onto the message.
async fn answer(message_id: &str, by: &str, files: Vec<(String, Vec<u8>)>, stop: &Notify) -> Result<(), DbErr> {
    let session = database::session();
    let Some(ai) = ai_chat_message::Entity::find_by_id(message_id).one(&session).await? else { return Ok(()) };
    let Some(chat) = ai_chat::Entity::find_by_id(ai.chat_id.as_str()).one(&session).await? else { return Ok(()) };
    let question = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.eq(chat.id.as_str()))
        .filter(ai_chat_message::Column::Role.eq("user"))
        .filter(ai_chat_message::Column::CreatedAt.lte(ai.created_at.as_str()))
        .order_by_desc(ai_chat_message::Column::CreatedAt)
        .one(&session)
        .await?;
    let request = or_default(&loads(Some(&ai.context), json!({})), "request", json!({}));
    let skill =
        request.get("skill").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("board-ask").to_string();
    let extra = or_default(&request, "extra", json!({}));
    let mut also_read: Vec<Value> = match loads(Some(&chat.include_docs), json!([])) {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    if let Some(more) = request.get("doc_ids").and_then(Value::as_array) {
        also_read.extend(more.iter().cloned());
    }
    let mut inputs = Map::new();
    inputs.insert("question".into(), json!(question.as_ref().map_or("", |q| q.text.as_str())));
    inputs.insert("project_id".into(), json!(chat.project_id));
    inputs.insert("scope".into(), json!(chat.scope));
    inputs.insert("ticket_id".into(), json!(chat.ticket_id));
    inputs.insert("page_id".into(), json!(chat.doc_id));
    inputs.insert("idea_id".into(), json!(chat.scope_id.as_ref().filter(|_| chat.scope == "idea")));
    inputs.insert("sketch_id".into(), json!(chat.scope_id.as_ref().filter(|_| chat.scope == "sketch")));
    inputs.insert("also_read_pages".into(), if also_read.is_empty() { Value::Null } else { Value::Array(also_read) });
    if let Value::Object(extra) = &extra {
        inputs.extend(extra.clone());
    }
    let (project_id, chat_id, ticket_id) = (chat.project_id.clone(), chat.id.clone(), chat.ticket_id.clone());
    drop(session);
    let started = now_iso();
    let name = sessions::chat_name(&chat_id);
    let ended = {
        let mut opts = TurnOpts::new(&name, &skill, inputs, by);
        opts.feature = if skill == "sketch-ask" { "sketch" } else { "chat" };
        opts.schema = if skill == "sketch-ask" { Schema::Skill } else { Schema::Plain };
        opts.ticket_id = ticket_id.as_deref();
        opts.files = files;
        let key = message_id.to_string();
        opts.on_run = Some(Box::new(move |run_id: &str| {
            runs().insert(key, run_id.to_string());
        }));
        tokio::select! {
            turned = engine::turn(&project_id, opts) => match turned {
                Ok(out) => Ended::Turn(Box::new(out)),
                Err(Error::Assist(exc)) => Ended::Failed(json!({"code": exc.code, "message": exc.message})),
                // an answer that fails says so in the chat
                Err(exc) => {
                    tracing::error!(target: "kanban.assistant.chat", "chat answer {message_id} failed: {exc}");
                    Ended::Failed(json!({"code": "error", "message": format!("Couldn't answer ({}).", kind_of(&exc))}))
                }
            },
            () = stop.notified() => Ended::Stopped,
        }
    };
    let run_ref = runs().remove(message_id);
    let (state, error, out) = match ended {
        Ended::Turn(out) if out.state == "cancelled" => ("stopped", json!({}), Some(*out)),
        Ended::Turn(out) if out.state != "finished" => {
            let message = out.error.clone().filter(|e| !e.is_empty());
            let message = message.unwrap_or_else(|| "Claude Code did not answer.".to_string());
            ("error", json!({"code": "unavailable", "message": message}), Some(*out))
        }
        Ended::Turn(out) => ("done", json!({}), Some(*out)),
        Ended::Stopped => ("stopped", json!({}), None),
        Ended::Failed(error) => ("error", error, None),
    };
    let session = database::session();
    let Some(ai) = ai_chat_message::Entity::find_by_id(message_id).one(&session).await? else { return Ok(()) };
    let mut row = ai.clone().into_active_model();
    row.state = Set(state.to_string());
    row.error = Set(pyjson::dumps(&error));
    row.finished_at = Set(Some(now_iso()));
    if let (None, Some(run_ref)) = (&out, &run_ref) {
        // the turn died after its tools may have acted: the receipt is still read, so Undo stays possible
        let mut ctx0 = dict(&ai.context);
        let merged0 = match receipt::collect(&session, None, run_ref, Some(&started)).await {
            Ok(found) => receipt::merge(ctx0.get("receipt"), found, run_ref),
            Err(_) => ctx0.get("receipt").cloned(),
        };
        if let Some(merged0) = merged0.filter(pyjson::truthy) {
            ctx0.insert("receipt".into(), merged0);
            row.context = Set(pyjson::dumps(&ctx0));
        }
    }
    if let Some(out) = &out {
        let data = if skill == "sketch-ask" { out.data() } else { Map::new() };
        let answer = data.get("answer").filter(|a| pyjson::truthy(a)).map(py_text);
        let text =
            answer.or_else(|| Some(out.text.clone()).filter(|t| !t.is_empty())).unwrap_or_else(|| ai.text.clone());
        row.text = Set(text);
        row.cost = Set(out.cost);
        row.tokens_in = Set(i32::try_from(out.tokens_in).unwrap_or(i32::MAX));
        row.tokens_out = Set(i32::try_from(out.tokens_out).unwrap_or(i32::MAX));
        row.model = Set(out.model.clone());
        row.metered = Set(false);
        let mut ctx = dict(&ai.context);
        ctx.insert("run".into(), json!({"id": out.run_id}));
        let merged = match receipt::collect(&session, None, &out.run_id, Some(&started)).await {
            Ok(changes) => receipt::merge(ctx.get("receipt"), changes, &out.run_id),
            // a receipt that cannot be read must not lose the answer
            Err(err) => {
                tracing::error!(target: "kanban.assistant.chat", "receipt of {message_id} could not be read: {err}");
                ctx.get("receipt").cloned()
            }
        };
        match merged.filter(pyjson::truthy) {
            Some(merged) => {
                ctx.insert("receipt".into(), merged);
            }
            None => {
                ctx.shift_remove("receipt");
            }
        }
        row.context = Set(pyjson::dumps(&ctx));
        let ideas: Vec<String> = data
            .get("ideas")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(py_text)
            .filter(|idea| !pytext::strip(idea).is_empty())
            .take(8)
            .collect();
        let canvas = or_default(&extra, "canvas", json!({}));
        if !ideas.is_empty() && state == "done" {
            let draft = drafts::new(
                &project_id,
                "sketch",
                by,
                json!({
                    "result": {
                        "kind": "proposal",
                        "ops": [],
                        "dropped": 0,
                        "note": "",
                        "layer": "AI",
                        "width": or_default(&canvas, "w", json!(1)),
                        "height": or_default(&canvas, "h", json!(1)),
                        "ideas": ideas,
                        "added": [],
                    }
                }),
                NewDraft { chat_message_id: Some(&ai.id), member_name: &out.member, ..Default::default() },
            );
            let draft_id = draft.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let _ = drafts::edit(&draft_id, |held| held.insert("status".into(), json!("open")));
            row.draft_id = Set(Some(draft_id));
        }
        if let (false, Some(question)) = (out.files.is_empty(), &question) {
            if let Some(asked) = ai_chat_message::Entity::find_by_id(question.id.as_str()).one(&session).await? {
                let mut qctx = dict(&asked.context);
                let names: Vec<&str> = out.files.iter().map(|f| file_name(f)).collect();
                let picture = if names.contains(&"canvas.png") {
                    json!({"width": 0, "height": 0, "bytes": 0, "file": "canvas.png"})
                } else {
                    Value::Null
                };
                let attachments: Vec<Value> = names
                    .iter()
                    .filter(|n| **n != "canvas.png")
                    .map(|n| {
                        let lower = n.to_lowercase();
                        let image = [".png", ".jpg", ".jpeg", ".webp", ".gif"].iter().any(|ext| lower.ends_with(ext));
                        json!({
                            "id": n,
                            "name": n,
                            "kind": if image { "image" } else { "text" },
                            "mime": "",
                            "file": n,
                            "bytes": 0,
                            "width": 0,
                            "height": 0,
                            "chars": 0,
                        })
                    })
                    .collect();
                qctx.insert(
                    "turn".into(),
                    json!({
                        "id": out.run_id,
                        "canvas": {
                            "w": or_default(&canvas, "w", json!(1)),
                            "h": or_default(&canvas, "h", json!(1)),
                            "title": or_default(&canvas, "title", json!("")),
                        },
                        "picture": picture,
                        "attachments": attachments,
                    }),
                );
                let mut asked = asked.into_active_model();
                asked.context = Set(pyjson::dumps(&qctx));
                asked.update(&session).await?;
            }
        }
        if let Some(chat) = ai_chat::Entity::find_by_id(ai.chat_id.as_str()).one(&session).await? {
            let (cost, tokens, session_id) = (chat.cost, chat.tokens, chat.session_id.clone());
            let mut chat = chat.into_active_model();
            chat.cost = Set(round_to(cost + out.cost, 6));
            chat.tokens = Set(tokens.saturating_add(i32::try_from(out.tokens_in + out.tokens_out).unwrap_or(i32::MAX)));
            chat.session_id = Set(out.session_id.clone().filter(|s| !s.is_empty()).or(session_id));
            chat.updated_at = Set(now_iso());
            chat.update(&session).await?;
        }
    }
    row.update(&session).await?;
    session.commit().await?;
    drop(session);
    events::publish(events::INVALIDATE, &[]).await;
    Ok(())
}
