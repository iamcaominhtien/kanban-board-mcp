//! The Idea Space's AI helpers on the assistant engine (AI v2 stage 7): status and switches, triage advice, Shape, Ask,
//! Prepare a ticket and the digest are turns of the Idea assistant with a skill; the ideas are given to it
//! (`server/tests/test_idea_ai_v2.py`).
//!
//! The Python tests go through the routes of `api/idea_ai.py`, which a later task ports. Here the calls are the
//! service functions the routes make, with the same names; what a test asserts about a route alone (a status code,
//! the per-idea `errors` and `none` lists of `POST /advice`, a path that answers `{stopped: false}`) waits with the
//! routes and is named in a comment where it was left out.

mod common;

use kb_assist::assistant::ideas;
use kb_db::database;
use kb_db::entities::idea_ticket;
use kb_db::sea_orm::{ActiveModelTrait, Set};
use serde_json::{Map, Value, json};

const BY: &str = "An Nguyen";

/// `_ideas(env, monkeypatch, answers)`: a project with a team and two ideas, and the answers of the stand-in CLI per
/// skill. Returns the project's id and the two ideas' ids.
async fn ideas_in_project(answers: Value) -> (String, String, String) {
    // Python's tests each have a database of their own: what the other tests of this file spent is not today's here
    common::clear::<kb_db::entities::ai_usage::Entity>().await;
    let (pid, _an) = common::project().await;
    common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let s = database::session();
    let mut ids = Vec::new();
    for (title, description) in [("Dark mode", "People ask for it."), ("Night theme", "")] {
        let mut row = idea_ticket::new();
        row.id = Set(format!("IDEA-{}", &kb_base::time::uuid4_hex()[..8]));
        row.project_id = Set(Some(pid.clone()));
        row.title = Set(title.to_string());
        row.description = Set(description.to_string());
        ids.push(row.insert(&s).await.expect("idea").id);
    }
    s.commit().await.expect("commit");
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_BY_SKILL", &answers.to_string())]);
    (pid, ids.remove(0), ids.remove(0))
}

fn map(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

#[tokio::test]
async fn test_status_and_switches() {
    let _guard = common::init().await;
    let (pid, _a, _b) = ideas_in_project(json!({})).await;
    let s = database::session();
    let st = ideas::status(&s, Some(&pid)).await.expect("status");
    assert!(st["state"] == "on" && st["settings"]["enabled"] == true && st["cap"] == 1.0 && st["limited"] == false);
    ideas::update_settings(&s, Some(&pid), &map(json!({"enabled": false}))).await.expect("off");
    assert_eq!(ideas::status(&s, Some(&pid)).await.expect("status")["state"], "off");
    // `POST /ask` answers 409 with the code of this error
    let err = ideas::ask(&s, "What next?", Some(&pid), "project", BY).await.expect_err("off");
    match err {
        ideas::Error::Idea(e) => assert_eq!(e.code, "off"),
        other => panic!("{other}"),
    }
    assert_eq!(ideas::status(&s, None).await.expect("status")["limited"], true);
}

#[tokio::test]
async fn test_triage_advice() {
    let _guard = common::init().await;
    let (_pid, a, b) = ideas_in_project(json!({})).await;
    let record = common::record_file();
    let merge = json!({"action": "merge", "reason": "Same as Dark mode.", "confidence": "high", "target_id": a});
    common::fake(&[("FAKE_CLAUDE_PROMPTS", &record), ("FAKE_CLAUDE_ASSISTANT_JSON", &merge.to_string())]);
    let s = database::session();
    // `POST /advice` with `["nope"]` lists `{idea_id, code: "not_found", message}` in `errors`
    let err = ideas::advise(&s, "nope", BY).await.expect_err("no such idea");
    match err {
        ideas::Error::Idea(e) => assert_eq!((e.code.as_str(), e.message.as_str()), ("not_found", "Idea not found.")),
        other => panic!("{other}"),
    }
    let advice = ideas::advise(&s, &b, BY).await.expect("advise").expect("advice");
    let listed = ideas::advice_for(&s, std::slice::from_ref(&b), false).await.expect("advice");
    let adv = &listed[0];
    assert!(
        advice.action == "merge"
            && adv["action"] == "merge"
            && adv["target_id"] == a.as_str()
            && adv["target_title"] == "Dark mode"
            && adv["stale"] == false
    );
    let prompts = common::prompts(&record);
    let prompt = prompts.last().expect("a recorded turn")["prompt"].as_str().expect("prompt");
    assert!(
        prompt.contains("kanban-assistant:idea-triage")
            && prompt.contains("Night theme")
            && prompt.contains("Dark mode")
    );
    let unsure = json!({"action": "none", "reason": "Not sure.", "confidence": "low"});
    common::fake(&[("FAKE_CLAUDE_PROMPTS", &record), ("FAKE_CLAUDE_ASSISTANT_JSON", &unsure.to_string())]);
    // an answer of "none" is `none` in the route's reply and no advice for the person
    assert!(ideas::advise(&s, &a, BY).await.expect("advise").is_none());
    let all = ideas::advice_for(&s, &[a.clone(), b.clone()], true).await.expect("advice");
    let mut actions: Vec<&str> = all.iter().map(|x| x["action"].as_str().expect("action")).collect();
    actions.sort_unstable();
    assert_eq!(actions, ["merge", "none"]);
    let done = ideas::set_advice_state(&s, adv["id"].as_str().expect("id"), "accepted").await.expect("state");
    assert_eq!((done.id.as_str(), done.state.as_str()), (adv["id"].as_str().expect("id"), "accepted"));
    assert!(ideas::advice_for(&s, std::slice::from_ref(&b), false).await.expect("advice").is_empty());
}

#[tokio::test]
async fn test_shape_ask_prepare_and_digest() {
    let _guard = common::init().await;
    let (pid, a, _b) = ideas_in_project(json!({
        "idea-shape": {"assumptions": [{"text": "People work at night", "impact": "high", "cheapest_test": "Ask five users"}]},
        "idea-ask": {"answer": "Test Dark mode first.", "sources": [{"id": "IDEA_A"}], "actions": []},
        "idea-prepare-ticket": {"title": "Add a dark theme", "description": "Do it.", "acceptance_criteria": ["Toggle in settings"], "sub_tickets": []},
        "idea-digest": {"text": "Two ideas, one duplicate.", "items": [{"kind": "ready", "idea_ids": ["IDEA_A", "ghost"], "text": "Dark mode is ready."}]},
    }))
    .await;
    let s = database::session();
    let shaped = ideas::shape(&s, &a, "assumptions", None, BY).await.expect("shape");
    assert!(
        shaped["kind"] == "assumptions"
            && shaped["ai"] == true
            && shaped["member"] == "Idea AI"
            && shaped["assumptions"][0]["impact"] == "high"
    );
    // `POST /shape` answers 400 for an `ask` with no question and 404 for an idea that is not there
    assert!(matches!(ideas::shape(&s, &a, "ask", None, BY).await, Err(ideas::Error::Value(_))));
    match ideas::shape(&s, "nope", "problem", None, BY).await {
        Err(ideas::Error::Idea(e)) => assert_eq!(e.code, "not_found"),
        other => panic!("{other:?}"),
    }
    assert!(!ideas::stop_shape("req-12345678"));
    let asked = ideas::ask(&s, "What should we test next?", Some(&pid), "project", BY).await.expect("ask");
    assert!(asked["answer"] == "Test Dark mode first." && asked["ideas_read"] == 2 && asked["sources"] == json!([]));
    let prepared = ideas::prepare_ticket(&s, &a, BY).await.expect("prepare");
    assert!(
        prepared["title"] == "Add a dark theme"
            && prepared["acceptance_criteria"] == json!(["Toggle in settings"])
            && prepared["cost"] == 0.02
    );
    assert!(ideas::latest_digest(&s, Some(&pid)).await.expect("digest").is_none());
    let d = ideas::groom(&s, Some(&pid), BY).await.expect("groom");
    let out = ideas::digest_out(&d);
    assert!(
        out["text"] == "Two ideas, one duplicate."
            && out["ideas_read"] == 2
            && out["items"][0]["idea_ids"] == json!([])
    );
    let latest = ideas::latest_digest(&s, Some(&pid)).await.expect("digest").expect("a digest");
    assert_eq!(latest.id, d.id);
    assert_eq!(ideas::status(&s, Some(&pid)).await.expect("status")["spent_today"], 0.08);
}
