//! Board AI on the assistant engine (AI v2 stage 7): the chat is one Claude Code conversation per chat, board health
//! keeps insights (`server/tests/test_board_ai_v2.py`).
//!
//! The Python tests go through the routes of `api/assist.py` and `api/ai_sketch.py`, which a later task ports. Here
//! are the ones whose assertions are about what the service functions of `chat`, `health` and `settings` return, at
//! service level, with the same names; what a test asserts about a route alone (a status code, a field the route
//! adds, a route that answers 410) waits with the routes and is named in a comment where it was left out.
//! `test_an_editor_result_is_held_until_accepted` (`assistant/editor.py`) is here too, ported with the editor. One
//! test waits whole: `test_a_schedule_dry_run_is_a_plan_from_the_assistant` (`services/ai/schedules.py`).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use kb_assist::assistant::chat::{self, NewChat, SendOpts};
use kb_assist::assistant::{engine, health, settings};
use kb_db::database;
use kb_db::entities::{ai_run, ai_usage, ticket};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

const BY: &str = "user";

async fn ask(chat_id: &str, text: &str) -> Value {
    let s = database::session();
    let sent = chat::send(&s, chat_id, BY, text, SendOpts::default()).await.expect("send");
    sent["ai"].clone()
}

fn id_of(message: &Value) -> &str {
    message["id"].as_str().expect("id")
}

#[tokio::test]
async fn test_a_chat_turn_answers_and_resumes_the_conversation() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    common::clear::<ai_usage::Entity>().await;
    let record = common::record_file();
    common::fake(&[("FAKE_CLAUDE_PROMPTS", &record), ("FAKE_CLAUDE_ASSISTANT_TEXT", "Two tickets are open.")]);
    let s = database::session();
    // `GET /projects/{id}/ai/assist`: `ticket_count` is added by the route
    let state = settings::describe(&s, &pid).await.expect("describe");
    assert_eq!(state["board_ai"]["state"], "ready");
    assert_eq!(engine::ready(&pid, "chat").await.expect("ready")["state"], "ready");
    let created =
        chat::create_chat(&s, &pid, BY, NewChat { scope: "project", ..Default::default() }).await.expect("chat");
    let cid = created.id.clone();
    let r = chat::send(&s, &cid, BY, "What is open?", SendOpts::default()).await.expect("send");
    assert!(r["user"]["text"] == "What is open?" && r["ai"]["state"] == "thinking");
    let m = common::answer(id_of(&r["ai"]), BY).await;
    assert!(m["state"] == "done" && m["text"] == "Two tickets are open." && m["cost"] == 0.02 && m["tokens_in"] == 200);
    let first = common::prompts(&record).pop().expect("a recorded turn");
    let prompt = first["prompt"].as_str().expect("prompt");
    assert!(prompt.contains("kanban-assistant:board-ask") && prompt.contains("question: What is open?"));
    let args = common::args_of(&first);
    assert!(!args.iter().any(|a| a == "--json-schema") && common::flag(&args, "--name") == format!("chat:{cid}"));
    let m2 = common::answer(id_of(&ask(&cid, "And blocked?").await), BY).await;
    assert_eq!(m2["state"], "done");
    assert!(common::args_of(&common::prompts(&record).pop().expect("a recorded turn")).iter().any(|a| a == "--resume"));
    let detail = chat::detail(&s, &cid, BY).await.expect("detail");
    let roles: Vec<&str> =
        detail["messages"].as_array().expect("messages").iter().map(|x| x["role"].as_str().expect("role")).collect();
    assert_eq!(roles, ["user", "ai", "user", "ai"]);
    assert!(detail["title"] == "What is open?" && detail["cost"] == 0.04 && detail["drafts"] == json!([]));
    let listed = chat::list_chats(&s, &pid, BY, None).await.expect("chats");
    assert!(listed["count"] == 1 && listed["month_cost"] == 0.04);
    let fb = chat::set_feedback(&s, id_of(&m), BY, Some("up"), "").await.expect("feedback");
    assert_eq!(fb["feedback"]["thumb"], "up");
    let again = chat::retry(&s, id_of(&m), BY, false).await.expect("retry");
    assert_eq!(common::answer(id_of(&again), BY).await["state"], "done");
    common::until("the answer's task to end", 5.0, || !chat::is_answering(id_of(&m))).await;
    chat::delete_chat(&s, &cid, BY).await.expect("delete");
    let gone = chat::detail(&s, &cid, BY).await.expect_err("the chat is gone");
    assert_eq!(gone.code(), Some("not_found"));
}

#[tokio::test]
async fn test_a_ticket_chat_answer_is_posted_as_a_comment_and_stop_works() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let s = database::session();
    let scope = chat::scope_state(&s, "ticket", &tid, BY).await.expect("scope");
    assert!(scope["availability"]["code"] == "ok" && scope["scope"]["project_id"] == pid.as_str());
    assert!(scope["chat_id"].is_null());
    let c = chat::scope_chat(&s, "ticket", &tid, BY, false).await.expect("chat");
    assert!(c.scope == "ticket" && c.ticket_id.as_deref() == Some(tid.as_str()));
    assert_eq!(chat::scope_chat(&s, "ticket", &tid, BY, false).await.expect("chat").id, c.id);
    assert_ne!(chat::scope_chat(&s, "ticket", &tid, BY, true).await.expect("chat").id, c.id);
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_TEXT", "add() subtracts: fix the operator.")]);
    let m = common::answer(id_of(&ask(&c.id, "What is wrong?").await), BY).await;
    assert_eq!(m["state"], "done");
    let posted = chat::post_as_comment(&s, id_of(&m), BY, None).await.expect("post");
    let stored = ticket::Entity::find_by_id(tid.as_str()).one(&s).await.expect("query").expect("the ticket");
    let comments: Vec<Value> = serde_json::from_str(&stored.comments).expect("comments");
    let last = comments.last().expect("a comment");
    assert!(last["text"] == "add() subtracts: fix the operator." && last["id"] == posted["comment_id"]);
    common::until("the answer's task to end", 5.0, || !chat::is_answering(id_of(&m))).await;
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "20")]);
    let slow = ask(&c.id, "Take your time").await;
    let busy = chat::send(&s, &c.id, BY, "Again", SendOpts::default()).await.expect_err("busy");
    assert_eq!(busy.code(), Some("conflict"));
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let run_id = chat::run_of(id_of(&slow)).expect("the turn of the slow answer runs");
    let pid_of_cli =
        ai_run::Entity::find_by_id(run_id.as_str()).one(&s).await.expect("query").expect("the run").pid.expect("a pid");
    assert!(common::alive(pid_of_cli));
    assert_eq!(chat::stop(&s, id_of(&slow), BY).await.expect("stop")["state"], "stopped");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(chat::get_message(&s, id_of(&slow), BY).await.expect("message")["state"], "stopped");
    // no CLI is left behind, and the run says how it ended
    common::until("the stopped CLI to end", 5.0, || !common::alive(pid_of_cli)).await;
    common::until("the answer's task to end", 5.0, || !chat::is_answering(id_of(&slow))).await;
    let run = ai_run::Entity::find_by_id(run_id.as_str()).one(&s).await.expect("query").expect("the run");
    assert!(run.state == "cancelled" && !engine::is_running(&run_id));
    // `GET /tickets/{id}/ai/estimate` (404) is a route of its own
}

#[tokio::test]
async fn test_board_health_keeps_insights() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let insight = json!({
        "kind": "stuck",
        "ticket_id": tid,
        "title": format!("{tid} has not moved for 6 days"),
        "detail": "In todo since Monday.",
        "score": 80,
    });
    common::fake(&[(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        &json!({"insights": [insight], "summary": "One ticket is stuck."}).to_string(),
    )]);
    let p = health::check(&pid, BY).await.expect("the check");
    assert!(p["needs_action"].as_array().expect("list").len() == 1 && p["unseen"] == 1);
    assert_eq!(p["digest"]["text"], "One ticket is stuck.");
    let iid = p["needs_action"][0]["id"].as_str().expect("id").to_string();
    let s = database::session();
    assert_eq!(health::chips(&s, &pid).await.expect("chips")[0]["ticket_id"], tid.as_str());
    let again = health::check(&pid, BY).await.expect("the check again");
    let ids: Vec<&str> =
        again["needs_action"].as_array().expect("list").iter().map(|i| i["id"].as_str().expect("id")).collect();
    assert_eq!(ids, [iid.as_str()]);
    health::mark_seen(&s, &pid).await.expect("seen");
    assert_eq!(health::panel(&s, &pid).await.expect("panel")["unseen"], 0);
    assert_eq!(health::set_state(&s, &iid, "snooze", 2).await.expect("snooze")["state"], "snoozed");
    assert_eq!(health::set_state(&s, &iid, "restore", 24).await.expect("restore")["state"], "open");
    // the route answers 410 for this code
    let act = health::set_state(&s, &iid, "act", 24).await.expect_err("drafts are gone");
    assert!(act.code() == Some("gone") && kb_assist::assistant::errors::status("gone") == Some(410));
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_JSON", &json!({"insights": []}).to_string())]);
    assert_eq!(health::check(&pid, BY).await.expect("the check")["needs_action"], json!([]));
}

#[tokio::test]
async fn test_draft_routes_are_gone_and_lists_are_empty() {
    // the routes that answer 410, 404 and the empty lists are the router's own and wait for it; what is left is the
    // settings change and the chat that is off
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    common::fake(&[]);
    let s = database::session();
    let patch = json!({"tone": "concise", "features": {"chat": false}});
    settings::update(&s, patch.as_object().expect("a patch")).await.expect("update");
    assert_eq!(settings::describe(&s, &pid).await.expect("describe")["tone"], "concise");
    let c = chat::create_chat(&s, &pid, BY, NewChat::default()).await.expect("chat");
    let off = chat::send(&s, &c.id, BY, "Hi", SendOpts::default()).await.expect_err("the chat is off");
    assert_eq!(off.code(), Some("feature_off"));
    // the settings are the board's: the tests after this one find them as a new board has them
    common::clear::<kb_db::entities::ai_assist_settings::Entity>().await;
}

#[tokio::test]
async fn test_the_sketch_chat_reads_the_picture_and_offers_ideas() {
    // `/ai/sketch/state`, the multipart route, the picture's route and the draft routes (`idea`, `accept`) are
    // `api/ai_sketch.py`; the chat's part of the test is here: the question with its picture, the answer, its ideas
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    let s = database::session();
    let c = chat::create_chat(&s, &pid, BY, NewChat { scope: "sketch", scope_id: Some("sk_1"), ..Default::default() })
        .await
        .expect("chat");
    let record = common::record_file();
    common::fake(&[
        ("FAKE_CLAUDE_PROMPTS", &record),
        (
            "FAKE_CLAUDE_ASSISTANT_JSON",
            &json!({"answer": "A login flow.", "ideas": ["Add an error state"]}).to_string(),
        ),
    ]);
    // what the route sends on: the picture as a file, the canvas in `extra`
    let opts = SendOpts {
        files: vec![("canvas.png".to_string(), b"\x89PNG\r\n".to_vec())],
        skill: Some("sketch-ask".to_string()),
        extra: json!({"canvas": {"w": 800, "h": 600, "title": "Login"}}).as_object().cloned(),
        ..Default::default()
    };
    let r = chat::send(&s, &c.id, BY, "What is this?", opts).await.expect("send");
    let m = common::answer(id_of(&r["ai"]), BY).await;
    assert!(m["state"] == "done" && m["text"] == "A login flow.", "{m}");
    assert_eq!(m["draft"]["payload"]["result"]["ideas"], json!(["Add an error state"]));
    assert_eq!(m["draft"]["status"], "open");
    let sent = common::prompts(&record).pop().expect("a recorded turn");
    let prompt = sent["prompt"].as_str().expect("prompt");
    assert!(prompt.contains("kanban-assistant:sketch-ask") && prompt.contains("canvas.png"));
    assert!(common::args_of(&sent).iter().any(|a| a == "--add-dir"));
    let run_id = m["context"]["run"]["id"].as_str().expect("the run of the answer");
    let picture = kb_ai_run::launch::run_dir(run_id, false).expect("the run's folder").join("canvas.png");
    assert!(std::fs::read(picture).expect("the picture").starts_with(b"\x89PNG"));
    // the question keeps what the turn was given
    let detail = chat::detail(&s, &c.id, BY).await.expect("detail");
    let turn = &detail["messages"][0]["context"]["turn"];
    assert!(turn["canvas"] == json!({"w": 800, "h": 600, "title": "Login"}) && turn["picture"]["file"] == "canvas.png");
}

#[tokio::test]
async fn test_an_editor_result_is_held_until_accepted() {
    use kb_assist::assistant::{drafts, editor};
    let _guard = common::init().await;
    drafts::clear();
    let (pid, _team) = common::board().await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let s = database::session();
    // `GET /projects/{id}/ai/editor/state`
    let st = editor::state(&s, &pid, "ticket_description").await.expect("state");
    assert!(st["availability"]["code"] == "ok" && st["bar"][0]["action"] == "improve");
    let body =
        json!({"surface": "ticket_description", "action": "improve", "selection": "add is brokn", "ticket_id": tid});
    let body = body.as_object().cloned().expect("body");
    let pre = editor::preview(&body).expect("preview");
    let kinds: Vec<&str> =
        pre["pieces"].as_array().expect("pieces").iter().map(|p| p["kind"].as_str().expect("kind")).collect();
    assert_eq!(kinds, ["instruction", "selection", "ticket"]);
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_JSON", &json!({"text": "add() is broken."}).to_string())]);
    // `POST /projects/{id}/ai/editor/drafts` answers 201 with the pending draft
    let draft = editor::start(&s, &pid, &body, "An Nguyen").await.expect("start");
    assert!(draft["status"] == "pending" && draft["kind"] == "editor");
    let id = draft["id"].as_str().expect("id").to_string();
    common::until("the draft to be written", 15.0, || drafts::find(&id).is_some_and(|d| d["status"] != "pending"))
        .await;
    let d = drafts::get(&id).expect("the draft");
    assert_eq!(d["status"], "open");
    assert_eq!(d["payload"]["result"], json!({"kind": "replace", "cut_short": false, "text": "add() is broken."}));
    let acc = editor::accept(&id, "An Nguyen", None).await.expect("accept");
    assert_eq!(acc["draft"]["status"], "applied");
    // the second accept answers 409
    let again = editor::accept(&id, "An Nguyen", None).await.expect_err("closed");
    assert_eq!(again.code(), Some("conflict"));
}
