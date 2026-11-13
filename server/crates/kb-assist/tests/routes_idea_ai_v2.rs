//! The Idea Space's AI helpers on the assistant engine (AI v2 stage 7): status and switches, triage advice, Shape,
//! Ask, Prepare a ticket and the digest are turns of the Idea assistant with a skill; the ideas are given to it
//! (`server/tests/test_idea_ai_v2.py`, through HTTP: the route assertions that `test_idea_ai_v2.rs` left out).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod http;

use http::{Fixture, start};
use serde_json::{Value, json};

const BASE: &str = "/api/idea-ai";

/// `_ideas(env, monkeypatch, answers)`: (fixture, project id, idea a, idea b).
async fn ideas(name: &str, answers: Value) -> Option<(Fixture, String, String, String)> {
    let f = start(name, &[]).await?;
    let (pid, _) = f.project().await;
    f.runner(&pid, "Claude Code · Backend", json!({})).await;
    let a =
        f.c.post(
            "/api/idea-tickets",
            json!({"project_id": pid, "title": "Dark mode", "description": "People ask for it."}),
        )
        .await;
    a.assert_status(201);
    let b = f.c.post("/api/idea-tickets", json!({"project_id": pid, "title": "Night theme"})).await;
    f.by_skill(&answers);
    let (a, b) = (http::id(&a.json()), http::id(&b.json()));
    Some((f, pid, a, b))
}

#[tokio::test]
async fn test_status_and_switches() {
    let Some((f, pid, _a, _b)) = ideas("test_status_and_switches", json!({})).await else { return };
    let c = &f.c;
    let st = c.get_query(&format!("{BASE}/status"), &[("project_id", &pid)]).await.json();
    assert!(
        st["state"] == "on" && st["settings"]["enabled"] == true && st["cap"] == 1.0 && st["limited"] == false,
        "{st}"
    );
    let off = c.put(&format!("{BASE}/settings?project_id={pid}"), json!({"enabled": false})).await;
    assert!(off.status == 200 && off.json()["state"] == "off", "{}", off.text());
    let r = c.post(&format!("{BASE}/ask"), json!({"question": "What next?", "project_id": pid})).await;
    assert!(r.status == 409 && r.json()["detail"]["code"] == "off", "{}", r.text());
    assert_eq!(c.get(&format!("{BASE}/status")).await.json()["limited"], true);
}

#[tokio::test]
async fn test_triage_advice() {
    let Some((f, _pid, a, b)) = ideas("test_triage_advice", json!({})).await else { return };
    let c = &f.c;
    f.record();
    f.answer_json(&json!({"action": "merge", "reason": "Same as Dark mode.", "confidence": "high", "target_id": a}));
    let r = c.post(&format!("{BASE}/advice"), json!({"idea_ids": [b, "nope"]})).await;
    r.assert_status(200);
    let out = r.json();
    assert_eq!(out["errors"], json!([{"idea_id": "nope", "code": "not_found", "message": "Idea not found"}]));
    assert_eq!(out["none"], json!([]));
    let adv = out["advice"][0].clone();
    assert!(
        adv["action"] == "merge"
            && adv["target_id"] == a.as_str()
            && adv["target_title"] == "Dark mode"
            && adv["stale"] == false,
        "{adv}"
    );
    let prompt = f.prompts().pop().expect("a recorded turn")["prompt"].as_str().expect("prompt").to_string();
    assert!(
        prompt.contains("kanban-assistant:idea-triage")
            && prompt.contains("Night theme")
            && prompt.contains("Dark mode")
    );
    f.answer_json(&json!({"action": "none", "reason": "Not sure.", "confidence": "low"}));
    let unsure = c.post(&format!("{BASE}/advice"), json!({"idea_ids": [a]})).await.json();
    assert!(unsure["none"] == json!([a]) && unsure["advice"] == json!([]), "{unsure}");
    let listed = c
        .get_query(&format!("{BASE}/advice"), &[("idea_ids", &a), ("idea_ids", &b), ("include_none", "true")])
        .await
        .json();
    let mut actions: Vec<String> =
        listed.as_array().expect("list").iter().map(|x| x["action"].as_str().expect("action").to_string()).collect();
    actions.sort();
    assert_eq!(actions, ["merge", "none"]);
    let done =
        c.post(&format!("{BASE}/advice/{}/state", adv["id"].as_str().expect("id")), json!({"state": "accepted"})).await;
    assert_eq!(done.json(), json!({"id": adv["id"], "state": "accepted"}));
    assert_eq!(c.get_query(&format!("{BASE}/advice"), &[("idea_ids", &b)]).await.json(), json!([]));
}

#[tokio::test]
async fn test_shape_ask_prepare_and_digest() {
    let Some((f, pid, a, _b)) = ideas(
        "test_shape_ask_prepare_and_digest",
        json!({
            "idea-shape": {"assumptions": [{"text": "People work at night", "impact": "high",
                                            "cheapest_test": "Ask five users"}]},
            "idea-ask": {"answer": "Test Dark mode first.", "sources": [{"id": "IDEA_A"}], "actions": []},
            "idea-prepare-ticket": {"title": "Add a dark theme", "description": "Do it.",
                                    "acceptance_criteria": ["Toggle in settings"], "sub_tickets": []},
            "idea-digest": {"text": "Two ideas, one duplicate.",
                            "items": [{"kind": "ready", "idea_ids": ["IDEA_A", "ghost"], "text": "Dark mode is ready."}]},
        }),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    let shaped = c.post(&format!("{BASE}/shape"), json!({"idea_id": a, "kind": "assumptions"})).await;
    shaped.assert_status(200);
    let s = shaped.json();
    assert!(
        s["kind"] == "assumptions"
            && s["ai"] == true
            && s["member"] == "Idea AI"
            && s["assumptions"][0]["impact"] == "high",
        "{s}"
    );
    c.post(&format!("{BASE}/shape"), json!({"idea_id": a, "kind": "ask"})).await.assert_status(400);
    c.post(&format!("{BASE}/shape"), json!({"idea_id": "nope", "kind": "problem"})).await.assert_status(404);
    assert_eq!(c.post_empty(&format!("{BASE}/shape/req-12345678/stop")).await.json(), json!({"stopped": false}));
    let asked =
        c.post(&format!("{BASE}/ask"), json!({"question": "What should we test next?", "project_id": pid})).await;
    asked.assert_status(200);
    assert!(
        asked.json()["answer"] == "Test Dark mode first."
            && asked.json()["ideas_read"] == 2
            && asked.json()["sources"] == json!([]),
        "{}",
        asked.text()
    );
    let prepared = c.post(&format!("{BASE}/prepare-ticket"), json!({"idea_id": a})).await.json();
    assert!(
        prepared["title"] == "Add a dark theme"
            && prepared["acceptance_criteria"] == json!(["Toggle in settings"])
            && prepared["cost"] == 0.02,
        "{prepared}"
    );
    assert_eq!(c.get_query(&format!("{BASE}/digest"), &[("project_id", &pid)]).await.json(), Value::Null);
    let d = c.post(&format!("{BASE}/digest/run"), json!({"project_id": pid})).await;
    d.assert_status(201);
    assert!(
        d.json()["text"] == "Two ideas, one duplicate."
            && d.json()["ideas_read"] == 2
            && d.json()["items"][0]["idea_ids"] == json!([]),
        "{}",
        d.text()
    );
    let latest = c.get_query(&format!("{BASE}/digest"), &[("project_id", &pid)]).await.json();
    assert_eq!(latest["id"], d.json()["id"]);
    assert_eq!(c.get_query(&format!("{BASE}/status"), &[("project_id", &pid)]).await.json()["spent_today"], 0.08);
}
