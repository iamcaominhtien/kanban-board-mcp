//! Board AI on the assistant engine (AI v2 stage 7): the chat is one Claude Code conversation per chat, editors get a
//! held result to accept, board health keeps insights, and the old draft routes answer 410
//! (`server/tests/test_board_ai_v2.py`, through HTTP: the route assertions that `test_board_ai_v2.rs` left out; the
//! tests of the sketch chat's routes are here too).
//!
//! Left out: `test_a_schedule_dry_run_is_a_plan_from_the_assistant` goes through `POST
//! /projects/{id}/ai/schedules/dry-run` (`api/ai_schedules.py`), a route of the schedules task, not of this crate.

mod http;

use std::time::Duration;

use http::{post_form, start};
use serde_json::{Value, json};

#[tokio::test]
async fn test_a_chat_turn_answers_and_resumes_the_conversation() {
    let Some(f) = start("test_a_chat_turn_answers_and_resumes_the_conversation", &[]).await else { return };
    let c = &f.c;
    let pid = f.board().await;
    f.record();
    f.fake(&[("FAKE_CLAUDE_ASSISTANT_TEXT", "Two tickets are open.")]);
    let state = c.get(&format!("/projects/{pid}/ai/assist")).await.json();
    assert!(state["board_ai"]["state"] == "ready" && state["ticket_count"] == 0, "{state}");
    let chat = c.post(&format!("/projects/{pid}/ai/assist/chats"), json!({"scope": "project"})).await;
    chat.assert_status(201);
    let cid = http::id(&chat.json());
    let r = c.post(&format!("/ai/assist/chats/{cid}/messages"), json!({"text": "What is open?"})).await;
    r.assert_status(200);
    assert!(r.json()["user"]["text"] == "What is open?" && r.json()["ai"]["state"] == "thinking");
    let m = f.answer(&http::id(&r.json()["ai"])).await;
    assert!(
        m["state"] == "done" && m["text"] == "Two tickets are open." && m["cost"] == 0.02 && m["tokens_in"] == 200,
        "{m}"
    );
    let first = f.prompts().pop().expect("a recorded turn");
    let prompt = first["prompt"].as_str().expect("prompt");
    assert!(prompt.contains("kanban-assistant:board-ask") && prompt.contains("question: What is open?"));
    let args: Vec<&str> = first["args"].as_array().expect("args").iter().filter_map(Value::as_str).collect();
    let at = args.iter().position(|a| *a == "--name").expect("--name");
    assert!(!args.contains(&"--json-schema") && args[at + 1] == format!("chat:{cid}"));
    let second = c.post(&format!("/ai/assist/chats/{cid}/messages"), json!({"text": "And blocked?"})).await.json();
    let m2 = f.answer(&http::id(&second["ai"])).await;
    assert_eq!(m2["state"], "done");
    let last = f.prompts().pop().expect("a recorded turn");
    assert!(last["args"].as_array().expect("args").iter().any(|a| a == "--resume"));
    let detail = c.get(&format!("/ai/assist/chats/{cid}")).await.json();
    let roles: Vec<&Value> = detail["messages"].as_array().expect("messages").iter().map(|x| &x["role"]).collect();
    assert_eq!(roles, ["user", "ai", "user", "ai"]);
    assert!(detail["title"] == "What is open?" && detail["cost"] == 0.04 && detail["drafts"] == json!([]), "{detail}");
    let listed = c.get(&format!("/projects/{pid}/ai/assist/chats")).await.json();
    assert!(listed["count"] == 1 && listed["month_cost"] == 0.04, "{listed}");
    let mid = m["id"].as_str().expect("id");
    let fb = c.post(&format!("/ai/assist/messages/{mid}/feedback"), json!({"thumb": "up"})).await;
    assert_eq!(fb.json()["feedback"]["thumb"], "up");
    let again = c.post(&format!("/ai/assist/messages/{mid}/retry"), json!({})).await;
    assert!(again.status == 200 && f.answer(&http::id(&again.json())).await["state"] == "done");
    c.delete(&format!("/ai/assist/chats/{cid}")).await.assert_status(204);
    c.get(&format!("/ai/assist/chats/{cid}")).await.assert_status(404);
}

#[tokio::test]
async fn test_a_ticket_chat_answer_is_posted_as_a_comment_and_stop_works() {
    let Some(f) = start("test_a_ticket_chat_answer_is_posted_as_a_comment_and_stop_works", &[]).await else { return };
    let c = &f.c;
    let pid = f.board().await;
    let tid = f.ticket(&pid, "Fix add()").await;
    let scope = c.get(&format!("/ai/scopes/ticket/{tid}")).await.json();
    assert!(
        scope["availability"]["code"] == "ok"
            && scope["scope"]["project_id"] == pid.as_str()
            && scope["chat_id"].is_null(),
        "{scope}"
    );
    let chat = c.post(&format!("/ai/scopes/ticket/{tid}/chat"), json!({})).await.json();
    assert!(chat["scope"] == "ticket" && chat["ticket_id"] == tid.as_str());
    assert_eq!(c.post(&format!("/ai/scopes/ticket/{tid}/chat"), json!({})).await.json()["id"], chat["id"]);
    assert_ne!(c.post(&format!("/ai/scopes/ticket/{tid}/chat"), json!({"fresh": true})).await.json()["id"], chat["id"]);
    f.fake(&[("FAKE_CLAUDE_ASSISTANT_TEXT", "add() subtracts: fix the operator.")]);
    let chat_id = http::id(&chat);
    let sent = c.post(&format!("/ai/assist/chats/{chat_id}/messages"), json!({"text": "What is wrong?"})).await.json();
    let m = f.answer(&http::id(&sent["ai"])).await;
    assert_eq!(m["state"], "done");
    let posted =
        c.post(&format!("/ai/assist/messages/{}/post-comment", m["id"].as_str().expect("id")), json!({})).await;
    posted.assert_status(200);
    let comments = c.get(&format!("/tickets/{tid}")).await.json()["comments"].clone();
    let last = comments.as_array().expect("comments").last().expect("a comment").clone();
    assert!(
        last["text"] == "add() subtracts: fix the operator." && last["id"] == posted.json()["comment_id"],
        "{last}"
    );
    f.fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "20")]);
    let slow = c.post(&format!("/ai/assist/chats/{chat_id}/messages"), json!({"text": "Take your time"})).await.json()
        ["ai"]
        .clone();
    let busy = c.post(&format!("/ai/assist/chats/{chat_id}/messages"), json!({"text": "Again"})).await;
    assert!(busy.status == 409 && busy.json()["code"] == "conflict", "{}", busy.text());
    tokio::time::sleep(Duration::from_millis(500)).await;
    let sid = http::id(&slow);
    assert_eq!(c.post_empty(&format!("/ai/assist/messages/{sid}/stop")).await.json()["state"], "stopped");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(c.get(&format!("/ai/assist/messages/{sid}")).await.json()["state"], "stopped");
    c.get_query(&format!("/tickets/{tid}/ai/estimate"), &[("member_id", "nope")]).await.assert_status(404);
}

#[tokio::test]
async fn test_an_editor_result_is_held_until_accepted() {
    let Some(f) = start("test_an_editor_result_is_held_until_accepted", &[]).await else { return };
    let c = &f.c;
    let pid = f.board().await;
    let tid = f.ticket(&pid, "Fix add()").await;
    let st = c
        .get_query(
            &format!("/projects/{pid}/ai/editor/state"),
            &[("surface", "ticket_description"), ("ticket_id", &tid)],
        )
        .await
        .json();
    assert!(st["availability"]["code"] == "ok" && st["bar"][0]["action"] == "improve", "{st}");
    let body =
        json!({"surface": "ticket_description", "action": "improve", "selection": "add is brokn", "ticket_id": tid});
    let pre = c.post(&format!("/projects/{pid}/ai/editor/preview"), body.clone()).await.json();
    let kinds: Vec<&Value> = pre["pieces"].as_array().expect("pieces").iter().map(|p| &p["kind"]).collect();
    assert_eq!(kinds, ["instruction", "selection", "ticket"]);
    f.answer_json(&json!({"text": "add() is broken."}));
    let r = c.post(&format!("/projects/{pid}/ai/editor/drafts"), body.clone()).await;
    assert!(r.status == 201 && r.json()["status"] == "pending" && r.json()["kind"] == "editor", "{}", r.text());
    let d = f.draft(&http::id(&r.json())).await;
    assert!(d["status"] == "open", "{d}");
    assert_eq!(d["payload"]["result"], json!({"kind": "replace", "cut_short": false, "text": "add() is broken."}));
    let did = http::id(&d);
    let acc = c.post(&format!("/ai/editor/drafts/{did}/accept"), json!({})).await;
    assert!(acc.status == 200 && acc.json()["draft"]["status"] == "applied", "{}", acc.text());
    c.post(&format!("/ai/editor/drafts/{did}/accept"), json!({})).await.assert_status(409);
    f.answer_json(&json!({"text": "- add(2, 3) returns 5\n- add(-1, 1) returns 0"}));
    let mut crit_body = body.clone();
    crit_body["action"] = json!("criteria");
    crit_body["selection"] = json!("");
    let crit = f.draft(&http::id(&c.post(&format!("/projects/{pid}/ai/editor/drafts"), crit_body).await.json())).await;
    assert_eq!(crit["payload"]["result"]["items"], json!(["add(2, 3) returns 5", "add(-1, 1) returns 0"]));
    let out = c
        .post(&format!("/ai/editor/drafts/{}/accept", http::id(&crit)), json!({"items": ["add(2, 3) returns 5"]}))
        .await
        .json();
    assert_eq!(out["created"], json!(["add(2, 3) returns 5"]));
    let texts: Vec<Value> = c.get(&format!("/tickets/{tid}")).await.json()["acceptance_criteria"]
        .as_array()
        .expect("criteria")
        .iter()
        .map(|x| x["text"].clone())
        .collect();
    assert_eq!(texts, [json!("add(2, 3) returns 5")]);
    let mut bad_body = body.clone();
    bad_body["selection"] = json!("");
    c.post(&format!("/projects/{pid}/ai/editor/drafts"), bad_body).await.assert_status(422);
    let third = f.draft(&http::id(&c.post(&format!("/projects/{pid}/ai/editor/drafts"), body).await.json())).await;
    let discarded = c.post_empty(&format!("/ai/assist/drafts/{}/discard", http::id(&third))).await.json();
    assert_eq!(discarded["status"], "discarded");
}

#[tokio::test]
async fn test_board_health_keeps_insights() {
    let Some(f) = start("test_board_health_keeps_insights", &[]).await else { return };
    let c = &f.c;
    let pid = f.board().await;
    let tid = f.ticket(&pid, "Fix add()").await;
    let insight = json!({"kind": "stuck", "ticket_id": tid, "title": format!("{tid} has not moved for 6 days"),
                         "detail": "In todo since Monday.", "score": 80});
    f.answer_json(&json!({"insights": [insight], "summary": "One ticket is stuck."}));
    let panel = c.post_empty(&format!("/projects/{pid}/ai/assist/health/run")).await;
    panel.assert_status(200);
    let p = panel.json();
    assert!(
        p["needs_action"].as_array().is_some_and(|a| a.len() == 1)
            && p["unseen"] == 1
            && p["digest"]["text"] == "One ticket is stuck.",
        "{p}"
    );
    let iid = p["needs_action"][0]["id"].as_str().expect("id").to_string();
    assert_eq!(c.get(&format!("/projects/{pid}/ai/assist/chips")).await.json()[0]["ticket_id"], tid.as_str());
    let again = c.post_empty(&format!("/projects/{pid}/ai/assist/health/run")).await.json();
    let ids: Vec<&Value> = again["needs_action"].as_array().expect("list").iter().map(|i| &i["id"]).collect();
    assert_eq!(ids, [&json!(iid)]);
    assert_eq!(c.post_empty(&format!("/projects/{pid}/ai/assist/health/seen")).await.json(), json!({"ok": true}));
    assert_eq!(c.get(&format!("/projects/{pid}/ai/assist/health")).await.json()["unseen"], 0);
    assert_eq!(
        c.post(&format!("/ai/assist/insights/{iid}/snooze"), json!({"hours": 2})).await.json()["state"],
        "snoozed"
    );
    assert_eq!(c.post(&format!("/ai/assist/insights/{iid}/restore"), json!({})).await.json()["state"], "open");
    c.post(&format!("/ai/assist/insights/{iid}/act"), json!({})).await.assert_status(410);
    f.answer_json(&json!({"insights": []}));
    assert_eq!(c.post_empty(&format!("/projects/{pid}/ai/assist/health/run")).await.json()["needs_action"], json!([]));
}

#[tokio::test]
async fn test_draft_routes_are_gone_and_lists_are_empty() {
    let Some(f) = start("test_draft_routes_are_gone_and_lists_are_empty", &[]).await else { return };
    let c = &f.c;
    let pid = f.board().await;
    let tid = f.ticket(&pid, "Fix add()").await;
    c.post(&format!("/projects/{pid}/ai/assist/drafts"), json!({"kind": "split", "ticket_id": tid}))
        .await
        .assert_status(410);
    for action in ["apply", "undo", "request-apply"] {
        c.post(&format!("/ai/assist/drafts/d1/{action}"), json!({})).await.assert_status(410);
    }
    c.patch("/ai/assist/drafts/d1", json!({"payload": {}})).await.assert_status(410);
    c.get("/ai/assist/drafts/d1").await.assert_status(404);
    assert_eq!(c.get(&format!("/tickets/{tid}/ai/assist/drafts")).await.json(), json!([]));
    assert_eq!(c.get(&format!("/projects/{pid}/ai/assist/drafts")).await.json(), json!([]));
    assert_eq!(c.get_query(&format!("/projects/{pid}/ai/assist/similar"), &[("text", "add")]).await.json(), json!([]));
    assert_eq!(
        c.get_query(&format!("/projects/{pid}/ai/assist/assignees"), &[("text", "add")]).await.json(),
        json!([])
    );
    assert_eq!(
        c.get(&format!("/tickets/{tid}/ai/assist/coverage")).await.json(),
        json!({"coverage": [], "covered": 0, "total": 0})
    );
    let patched =
        c.patch(&format!("/projects/{pid}/ai/assist"), json!({"tone": "concise", "features": {"chat": false}})).await;
    assert!(patched.status == 200 && patched.json()["tone"] == "concise", "{}", patched.text());
    let chat = c.post(&format!("/projects/{pid}/ai/assist/chats"), json!({})).await.json();
    let off = c.post(&format!("/ai/assist/chats/{}/messages", http::id(&chat)), json!({"text": "Hi"})).await;
    assert!(off.status == 409 && off.json()["code"] == "feature_off", "{}", off.text());
}

#[tokio::test]
async fn test_the_sketch_chat_reads_the_picture_and_offers_ideas() {
    let Some(f) = start("test_the_sketch_chat_reads_the_picture_and_offers_ideas", &[]).await else { return };
    let c = &f.c;
    let pid = f.board().await;
    let st = c
        .get_query("/ai/sketch/state", &[("owner_kind", "ticket"), ("owner_id", "x"), ("project_id", &pid)])
        .await
        .json();
    assert!(st["availability"]["code"] == "ok" && st["limits"]["max_prompt"] == 2000, "{st}");
    let chat = c
        .post(&format!("/projects/{pid}/ai/assist/chats"), json!({"scope": "sketch", "scope_id": "sk_1"}))
        .await
        .json();
    f.record();
    f.answer_json(&json!({"answer": "A login flow.", "ideas": ["Add an error state"]}));
    let chat_id = http::id(&chat);
    let r = post_form(
        c,
        &format!("/ai/sketch/chats/{chat_id}/messages"),
        &[("text", "What is this?"), ("width", "800"), ("height", "600"), ("title", "Login")],
        &[("image", "canvas.png", b"\x89PNG\r\n")],
    )
    .await;
    r.assert_status(200);
    let m = f.answer(&http::id(&r.json()["ai"])).await;
    assert!(m["state"] == "done" && m["text"] == "A login flow.", "{m}");
    assert!(
        m["draft"]["payload"]["result"]["ideas"] == json!(["Add an error state"]) && m["draft"]["status"] == "open"
    );
    let sent = f.prompts().pop().expect("a recorded turn");
    let prompt = sent["prompt"].as_str().expect("prompt");
    assert!(prompt.contains("kanban-assistant:sketch-ask") && prompt.contains("canvas.png"));
    assert!(sent["args"].as_array().expect("args").iter().any(|a| a == "--add-dir"));
    let run_id = m["context"]["run"]["id"].as_str().expect("run id");
    let pic = c.get(&format!("/ai/sketch/chats/{chat_id}/files/{run_id}/canvas.png")).await;
    assert!(pic.status == 200 && pic.body.starts_with(b"\x89PNG"));
    c.get(&format!("/ai/sketch/chats/{chat_id}/files/{run_id}/system.md")).await.assert_status(404);
    let draft_id = m["draft_id"].as_str().expect("draft id");
    let added = c.post(&format!("/ai/sketch/drafts/{draft_id}/idea"), json!({"index": 0})).await.json();
    assert_eq!(added["payload"]["result"]["added"], json!([0]));
    assert_eq!(c.post_empty(&format!("/ai/sketch/drafts/{draft_id}/accept")).await.json()["status"], "applied");
}
