//! What the Python tests of these modules do not reach, at service level: a ticket chat whose message goes to the
//! ticket's team (the runs seam), the team's reply and a team that stopped; the receipt of an answer whose turn
//! changed a ticket, and Undo; answers left over from a board that stopped (`recover`); a turn that is dropped; the
//! hook of the database helper.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::sync::Arc;

use kb_assist::assistant::chat::{self, NewChat, SendOpts};
use kb_assist::assistant::engine::{self, TurnOpts};
use kb_assist::seams;
use kb_db::database;
use kb_db::entities::{ai_chat_message, ai_run, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel};
use serde_json::{Map, Value, json};

const BY: &str = "An Nguyen";

fn id_of(message: &Value) -> &str {
    message["id"].as_str().expect("id")
}

#[tokio::test]
async fn a_ticket_chat_with_a_team_goes_to_the_team_and_its_reply_fills_the_answer() {
    let _guard = common::init().await;
    let (pid, team) = common::board().await;
    let team_id = team["id"].as_str().expect("the team's id").to_string();
    let tk = common::ticket(&pid, "Fix add()", "todo").await;
    let s = database::session();
    let mut row = tk.clone().into_active_model();
    row.assignee = Set(Some(team_id.clone()));
    row.update(&s).await.expect("assign");
    s.commit().await.expect("commit");
    let found = chat::ticket_team(&s, &tk.id).await.expect("team").expect("the ticket has a team");
    assert!(found.id == team_id && !found.working);
    assert!(chat::ticket_team(&s, "nope").await.expect("team").is_none());
    let c = chat::scope_chat(&s, "ticket", &tk.id, BY, false).await.expect("chat");

    // with the runs not connected the note cannot be delivered, and the call says so
    seams::set_runs(None);
    let lost = chat::send(&s, &c.id, BY, "Is this done?", SendOpts::default()).await.expect_err("no runs");
    assert!(lost.code().is_none());
    common::clear::<ai_chat_message::Entity>().await;

    let runs = Arc::new(common::Deliveries::default());
    seams::set_runs(Some(runs.clone()));
    let sent = chat::send(&s, &c.id, BY, "Is this done?", SendOpts::default()).await.expect("send");
    let ai = &sent["ai"];
    assert!(ai["state"] == "thinking" && ai["member_id"] == team_id.as_str());
    assert_eq!(ai["context"]["team"], team["name"]);
    assert_eq!(ai["context"]["delivered"], json!({"delivered": "new_run", "run_id": "run-1"}));
    let (ticket_id, note, by) = runs.sent.lock().expect("lock").pop().expect("a note was delivered");
    assert!(ticket_id == tk.id && by == BY);
    assert_eq!(note, chat::team_note(BY, id_of(ai), "Is this done?"));
    assert!(note.starts_with(&format!(
        "{BY} writes to you in the ticket chat (chat message {}):\n\nIs this done?\n\n",
        id_of(ai)
    )));
    assert!(!chat::is_answering(id_of(ai)));

    // the team answers with ai_run(action='reply')
    let empty = chat::reply_from_team(&tk.id, "  ", &team_id, None).await.expect_err("no text");
    assert_eq!(empty.to_string(), "ai_run(action='reply') needs `text`.");
    let other = chat::reply_from_team(&tk.id, "Done.", "someone-else", None).await.expect_err("not this team's");
    assert!(other.to_string().starts_with("No message in this ticket's chat waits for an answer"));
    let replied = chat::reply_from_team(&tk.id, "  Yes, **done**.  ", &team_id, Some(id_of(ai))).await.expect("reply");
    assert_eq!(replied, json!({"replied": true, "message_id": id_of(ai)}));
    let m = chat::get_message(&s, id_of(ai), BY).await.expect("message");
    assert!(m["state"] == "done" && m["text"] == "Yes, **done**.");

    // a message nobody answered, and no run of the ticket is going: the chat stops waiting
    let waiting = chat::send(&s, &c.id, BY, "And the tests?", SendOpts::default()).await.expect("send");
    let detail = chat::detail(&s, &c.id, BY).await.expect("detail");
    let last = detail["messages"].as_array().expect("messages").last().expect("a message").clone();
    assert_eq!(last["id"], waiting["ai"]["id"]);
    assert_eq!(last["state"], "done");
    assert_eq!(last["text"], "The team stopped before it answered here. What it did is in its report on the ticket.");

    // a refusal of the runs is the person's to read
    *runs.refuse.lock().expect("lock") = Some(seams::DeliverError::Run("Ticket not found.".into()));
    let refused = chat::send(&s, &c.id, BY, "Once more", SendOpts::default()).await.expect_err("refused");
    assert_eq!(refused.to_string(), "Ticket not found.");
    seams::set_runs(None);
}

#[tokio::test]
async fn an_answer_keeps_the_receipt_of_what_its_turn_changed_and_undo_puts_it_back() {
    let _guard = common::init().await;
    seams::set_runs(None);
    let (pid, _team) = common::board().await;
    let tk = common::ticket(&pid, "Fix add()", "todo").await;
    let s = database::session();
    let c = chat::create_chat(&s, &pid, BY, NewChat::default()).await.expect("chat");
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "1.5"), ("FAKE_CLAUDE_ASSISTANT_TEXT", "Moved it.")]);
    let sent = chat::send(&s, &c.id, BY, "Start the ticket", SendOpts::default()).await.expect("send");
    let mid = id_of(&sent["ai"]).to_string();
    common::until("the turn's run", 10.0, || chat::run_of(&mid).is_some()).await;
    let run_id = chat::run_of(&mid).expect("the run");
    // what a board tool does with the turn's token: the change is in the ticket's Activity, marked with the run
    let entry = json!({
        "field": "status", "from": "todo", "to": "in-progress", "at": kb_base::time::now_iso(), "actor": "Claude Code · Backend",
        "ai": true, "on_behalf_of": BY, "run_id": run_id, "member_id": "m",
    });
    let mut row = tk.clone().into_active_model();
    row.status = Set("in-progress".into());
    row.activity_log = Set(kb_base::pyjson::dumps(&json!([entry])));
    row.updated_at = Set(kb_base::time::now_iso());
    row.update(&s).await.expect("the change");
    s.commit().await.expect("commit");
    let m = common::answer(&mid, BY).await;
    assert!(m["state"] == "done" && m["text"] == "Moved it.", "{m}");
    let rec = &m["context"]["receipt"];
    assert!(rec["count"] == 1 && rec["status"] == "done" && rec["runs"] == json!([run_id]), "{rec}");
    assert!(rec["applied"][0]["op"] == "status" && rec["applied"][0]["ticket"] == tk.id.as_str());
    let undone = chat::undo_receipt(&s, &mid, BY).await.expect("undo");
    let rec = &undone["context"]["receipt"];
    assert!(rec["status"] == "undone" && rec["undo"]["put_back"] == json!([0]) && rec["undo"]["undone"] == 1, "{rec}");
    let stored = ticket::Entity::find_by_id(tk.id.as_str()).one(&s).await.expect("query").expect("the ticket");
    assert_eq!(stored.status, "todo");
    let twice = chat::undo_receipt(&s, &mid, BY).await.expect_err("already put back");
    assert!(twice.code() == Some("conflict") && twice.to_string() == "These changes were already put back.");
    let nothing = chat::undo_receipt(&s, id_of(&sent["user"]), BY).await.expect_err("a question changed nothing");
    assert_eq!(nothing.code(), Some("not_found"));
    let stranger = chat::get_message(&s, &mid, "Someone Else").await.expect_err("not their chat");
    assert_eq!(stranger.code(), Some("not_found"));
}

#[tokio::test]
async fn answers_left_over_from_a_board_that_stopped_are_marked_at_start() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    let s = database::session();
    let c = chat::create_chat(&s, &pid, BY, NewChat::default()).await.expect("chat");
    let mut ids = Vec::new();
    for state in ["thinking", "streaming", "queued", "done"] {
        let mut m = ai_chat_message::new();
        m.chat_id = Set(c.id.clone());
        m.role = Set("ai".into());
        m.state = Set(state.into());
        ids.push(m.insert(&s).await.expect("message").id);
    }
    s.commit().await.expect("commit");
    chat::recover().await.expect("recover");
    for id in &ids[..3] {
        let m = chat::get_message(&s, id, BY).await.expect("message");
        assert_eq!(m["state"], "error");
        assert_eq!(
            m["error"],
            json!({"code": "unavailable", "message": "The board restarted while this was being written. Try again."})
        );
        assert!(m["finished_at"].is_string());
    }
    let done = chat::get_message(&s, &ids[3], BY).await.expect("message");
    assert!(done["state"] == "done" && done["error"] == json!({}));
    // nothing is left to mark: the second call changes nothing
    chat::recover().await.expect("recover again");
}

#[tokio::test]
async fn a_turn_that_is_dropped_stops_its_cli_and_ends_its_run_as_cancelled() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "30")]);
    let (tell, mut told) = tokio::sync::mpsc::unbounded_channel::<String>();
    let project = pid.clone();
    let task = tokio::spawn(async move {
        let mut inputs = Map::new();
        inputs.insert("question".into(), json!("Take your time"));
        let mut opts = TurnOpts::new("board:dropped", "board-ask", inputs, BY);
        opts.on_run = Some(Box::new(move |run_id: &str| {
            let _ = tell.send(run_id.to_string());
        }));
        engine::turn(&project, opts).await
    });
    let run_id = told.recv().await.expect("the run of the turn");
    common::until("the turn's CLI", 10.0, || engine::is_running(&run_id)).await;
    let s = database::session();
    let mut cli = None;
    for _ in 0..100 {
        cli = ai_run::Entity::find_by_id(run_id.as_str()).one(&s).await.expect("query").expect("the run").pid;
        if cli.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let cli = cli.expect("the pid of the turn's CLI");
    assert!(common::alive(cli));
    task.abort();
    let _ = task.await;
    common::until("the dropped turn's CLI to end", 5.0, || !common::alive(cli)).await;
    assert!(!engine::is_running(&run_id));
    let mut state = String::new();
    for _ in 0..100 {
        state = ai_run::Entity::find_by_id(run_id.as_str()).one(&s).await.expect("query").expect("the run").state;
        if state == "cancelled" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(state, "cancelled");
    let run = ai_run::Entity::find_by_id(run_id.as_str()).one(&s).await.expect("query").expect("the run");
    assert!(run.ended_reason.as_deref() == Some("Stopped.") && run.pid.is_none());
    // `cancel` of a turn that is not going only notes the wish
    assert!(!engine::cancel("no-such-run"));
}

#[tokio::test]
async fn the_database_helper_asks_through_its_hook() {
    let _guard = common::init().await;
    let (_pid, _team) = common::board().await;
    kb_assist::register();
    let hook = kb_dbkit::hooks::assistant().expect("the hook is registered");
    assert!(hook.any_cli().await.is_some_and(|path| path.ends_with("claude")));
    common::fake(&[(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        &json!({"cause": "Too small.", "statements": ["ALTER TABLE project ADD COLUMN x TEXT"]}).to_string(),
    )]);
    let out = hook.oneshot("db-fix", &json!({"stop": {"table": "project"}})).await.expect("an answer");
    assert!(out.state == "finished" && out.error.is_none() && out.cost == 0.02);
    assert_eq!(out.structured.expect("a structured answer")["cause"], "Too small.");
}
