//! Docs AI on the assistant engine (AI v2 stage 7): the old API paths start jobs whose handlers run one assistant
//! turn with a skill; what needs no model (ignore, create tickets, undo) is plain code
//! (`server/tests/test_docs_ai_v2.py`, through HTTP: the route assertions that `test_docs_ai_v2.rs` left out).
//!
//! `PARITY_TARGET=python cargo test -p kb-assist --test routes_docs_ai_v2`, then the same with the Rust server
//! (`KANBAN_SERVER_BIN`). The stand-in CLI answers for `claude`; a team is a row added to the database (the route that
//! makes it is not ported yet).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod http;

use http::{Fixture, start};
use serde_json::{Value, json};

/// `_space(env, monkeypatch, answers)`: (client fixture, project id, page id).
async fn space(name: &str, answers: Value) -> Option<(Fixture, String, String)> {
    let f = start(name, &[]).await?;
    let (pid, _) = f.project().await;
    f.runner(&pid, "Claude Code · Backend", json!({})).await;
    f.c.patch(&format!("/projects/{pid}/docs/ai"), json!({"enabled": true})).await.assert_status(200);
    let r =
        f.c.post(
            &format!("/projects/{pid}/docs/pages"),
            json!({"title": "API", "markdown": "# API\n\nThe API uses REST.\n\n- [ ] Add paging\n"}),
        )
        .await;
    r.assert_status(201);
    let page = http::id(&r.json());
    f.by_skill(&answers);
    Some((f, pid, page))
}

#[tokio::test]
async fn test_ask_the_docs_answers_with_citations() {
    let Some((f, pid, _page)) = space(
        "test_ask_the_docs_answers_with_citations",
        json!({"docs-ask": {"answer": "REST [1].", "verdict": "answered",
                            "citations": [{"page_id": "PAGE", "title": "API"}], "pages_read": 2}}),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    let r = c.post(&format!("/projects/{pid}/docs/ai/ask"), json!({"question": "  Which   API style? "})).await;
    r.assert_status(202);
    assert!(r.json()["kind"] == "ask" && r.json()["instruction"] == "Which API style?");
    let j = f.job(&http::id(&r.json())).await;
    assert_eq!(j["state"], "finished", "{j}");
    let res = &j["result"];
    assert!(res["answer"] == "REST [1]." && res["verdict"] == "answered" && res["pages_read"] == 2);
    assert_eq!(res["citations"], json!([{"n": 1, "page_id": "PAGE", "title": "API", "section": null}]));
    assert!(j["cost"] == 0.02 && j["tokens_in"] == 200);
    let chat = c.post_empty(&format!("/docs/ai/ask/{}/chat", j["id"].as_str().expect("id"))).await;
    assert!(chat.status == 201 && chat.json()["chat_id"].as_str().is_some_and(|c| !c.is_empty()));
    let fb = c.post(&format!("/docs/ai/ask/{}/feedback", j["id"].as_str().expect("id")), json!({"rating": "up"})).await;
    assert!(fb.status == 200 && fb.json()["result"]["feedback"]["rating"] == "up");
    c.post(&format!("/projects/{pid}/docs/ai/ask"), json!({"question": " "})).await.assert_status(422);
    c.post(&format!("/projects/{pid}/docs/ai/ask"), json!({"question": "x", "scope": "moon"})).await.assert_status(422);
}

#[tokio::test]
async fn test_docs_ai_off_refuses() {
    let Some(f) = start("test_docs_ai_off_refuses", &[]).await else { return };
    let (pid, _) = f.project().await;
    let r = f.c.post(&format!("/projects/{pid}/docs/ai/ask"), json!({"question": "Anything?"})).await;
    assert!(r.status == 409 && r.json()["code"] == "docs_ai_off", "{}", r.text());
}

#[tokio::test]
async fn test_check_fix_and_ignore() {
    let finding = json!({"kind": "unclear", "quote": "The API uses REST.", "message": "Say which version.",
                         "suggestion": "The API uses REST v2."});
    let Some((f, _pid, page)) = space(
        "test_check_fix_and_ignore",
        json!({
            "docs-check": {"findings": [finding,
                {"kind": "style", "quote": "Add paging", "message": "Write a full sentence."}]},
            "docs-fix": {"old": "The API uses REST.", "new": "The API uses REST v2."},
        }),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    let r = c.post(&format!("/docs/pages/{page}/ai/check"), json!({})).await;
    r.assert_status(202);
    let j = f.job(&http::id(&r.json())).await;
    assert_eq!(j["state"], "finished", "{j}");
    let found = j["result"]["findings"].as_array().expect("findings").clone();
    let kinds: Vec<&Value> = found.iter().map(|x| &x["kind"]).collect();
    assert_eq!(kinds, [&json!("unclear"), &json!("style")]);
    assert!(found.iter().all(|x| x["id"].as_str().is_some_and(|id| id.chars().count() == 10)));
    let first = found[0]["id"].as_str().expect("id");
    let fix = c.post(&format!("/docs/pages/{page}/ai/check/{first}/fix"), json!({})).await;
    fix.assert_status(202);
    let fixed = f.job(&http::id(&fix.json())).await;
    assert!(fixed["state"] == "finished" && fixed["result"]["new"] == "The API uses REST v2.");
    c.post(&format!("/docs/pages/{page}/ai/check/nope/fix"), json!({})).await.assert_status(404);
    let ig = c.post(&format!("/docs/pages/{page}/ai/check/ignore"), json!({"key": found[1]["id"]})).await;
    assert!(ig.status == 200 && ig.json()["ok"] == true);
    let again = f.job(&http::id(&c.post(&format!("/docs/pages/{page}/ai/check"), json!({})).await.json())).await;
    let kinds: Vec<Value> =
        again["result"]["findings"].as_array().expect("findings").iter().map(|x| x["kind"].clone()).collect();
    assert!(kinds == [json!("unclear")] && again["result"]["ignored"] == 1);
}

#[tokio::test]
async fn test_page_views_summary_explain_translate() {
    let Some((f, _pid, page)) = space(
        "test_page_views_summary_explain_translate",
        json!({
            "docs-summarise": {"text": "REST API.", "title": "API"},
            "docs-explain": {"text": "REST is a style."},
            "docs-translate": {"markdown": "# API\n\nAPI d\u{f9}ng REST.", "language": "Vietnamese"},
        }),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    let s = f.job(&http::id(&c.post_empty(&format!("/docs/pages/{page}/ai/summary")).await.json())).await;
    assert!(s["result"]["text"] == "REST API." && s["result"]["title"] == "API");
    let e = f
        .job(&http::id(&c.post(&format!("/docs/pages/{page}/ai/explain"), json!({"selection": "REST"})).await.json()))
        .await;
    assert!(e["result"]["text"] == "REST is a style." && e["result"]["from"] == "API");
    let t = f
        .job(&http::id(
            &c.post(&format!("/docs/pages/{page}/ai/translate"), json!({"language": "Vietnamese"})).await.json(),
        ))
        .await;
    assert!(
        t["result"]["language"] == "Vietnamese"
            && t["result"]["markdown"].as_str().is_some_and(|m| m.contains("d\u{f9}ng REST"))
    );
    c.post(&format!("/docs/pages/{page}/ai/explain"), json!({"selection": " "})).await.assert_status(422);
}

#[tokio::test]
async fn test_write_a_page_and_markers() {
    let Some((f, pid, page)) = space(
        "test_write_a_page_and_markers",
        json!({"docs-write": {"page_id": "PAGE", "title": "Paging", "gaps": ["Who owns it?"]}}),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    f.record();
    let pre = c
        .post(
            &format!("/projects/{pid}/docs/ai/write/preview"),
            json!({"source": {"kind": "prompt", "text": "Paging design"}}),
        )
        .await;
    assert!(pre.status == 200 && pre.json()["items"][0]["kind"] == "prompt", "{}", pre.text());
    let r = c
        .post(
            &format!("/projects/{pid}/docs/ai/write"),
            json!({"source": {"kind": "prompt", "text": "Paging design"}, "page_kind": "spec"}),
        )
        .await;
    r.assert_status(200);
    let j = f.job(&http::id(&r.json())).await;
    assert_eq!(j["state"], "finished", "{j}");
    assert!(
        j["result"]["page_id"] == "PAGE" && j["result"]["gaps"] == json!(["Who owns it?"]) && j["page_id"] == "PAGE"
    );
    let prompt = f.prompts().pop().expect("a recorded turn")["prompt"].as_str().expect("prompt").to_string();
    assert!(
        prompt.contains("kanban-assistant:docs-write")
            && prompt.contains("Paging design")
            && prompt.contains("page_kind: spec")
    );
    let bad = c.post(&format!("/projects/{pid}/docs/ai/write"), json!({"source": {"kind": "notes", "text": ""}})).await;
    bad.assert_status(422);
    let m = c.get(&format!("/docs/pages/{page}/ai/markers")).await;
    assert!(m.status == 200 && m.json() == json!({"markers": [], "count": 0}));
}

#[tokio::test]
async fn test_tickets_from_a_page_draft_create_undo() {
    let Some((f, _pid, page)) = space(
        "test_tickets_from_a_page_draft_create_undo",
        json!({"docs-tickets": {"drafts": [{"title": "Add paging", "text": "From the API page.", "type": "task"}],
                                "skipped": []}}),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    let d = f.job(&http::id(&c.post(&format!("/docs/pages/{page}/ai/tickets/draft"), json!({})).await.json())).await;
    assert!(d["state"] == "finished" && d["result"]["drafts"][0]["title"] == "Add paging");
    let made = c.post(&format!("/docs/pages/{page}/ai/tickets/create"), json!({"drafts": d["result"]["drafts"]})).await;
    made.assert_status(200);
    let out = made.json();
    assert!(out["tickets"].as_array().is_some_and(|t| t.len() == 1) && out["linked"] == true);
    assert!(out["undo_token"].as_str().is_some_and(|t| !t.is_empty()));
    let tid = out["tickets"][0]["id"].as_str().expect("ticket id").to_string();
    assert_eq!(c.get(&format!("/tickets/{tid}")).await.json()["title"], "Add paging");
    let linked = c.get(&format!("/tickets/{tid}/docs")).await.json();
    assert!(linked.as_array().expect("list").iter().any(|p| p["page_id"] == page.as_str()));
    let undo = c.post("/docs/ai/tickets/undo", json!({"undo_token": out["undo_token"]})).await;
    assert!(undo.status == 200 && undo.json()["removed"] == json!([tid]));
    c.get(&format!("/tickets/{tid}")).await.assert_status(404);
    c.post("/docs/ai/tickets/undo", json!({"undo_token": out["undo_token"]})).await.assert_status(404);
}

#[tokio::test]
async fn test_freshness_banner() {
    let Some((f, _pid, page)) = space(
        "test_freshness_banner",
        json!({"docs-freshness": {"state": "stale",
                                  "reasons": [{"quote": "REST", "source": "KAN-1", "why": "The API moved to gRPC."}]}}),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    assert_eq!(c.get(&format!("/docs/pages/{page}/ai/freshness")).await.json()["state"], "unchecked");
    let r = c.post_empty(&format!("/docs/pages/{page}/ai/freshness")).await;
    r.assert_status(202);
    let j = f.job(&http::id(&r.json())).await;
    assert!(j["state"] == "finished" && j["result"]["state"] == "stale");
    let banner = c.get(&format!("/docs/pages/{page}/ai/freshness")).await.json();
    assert!(banner["stale"] == true && banner["reasons"][0]["text"] == "The API moved to gRPC.");
    let key = banner["reasons"][0]["key"].clone();
    let gone =
        c.post(&format!("/docs/pages/{page}/ai/freshness/dismiss"), json!({"key": key, "level": "once"})).await.json();
    assert!(gone["stale"] == false && gone["hidden"] == 1);
    assert_eq!(c.post_empty(&format!("/docs/pages/{page}/ai/freshness/still-correct")).await.json()["state"], "ok");
}

#[tokio::test]
async fn test_thread_summary() {
    let Some((f, _pid, page)) = space(
        "test_thread_summary",
        json!({"docs-thread": {"reply": "- Paging is wanted.\n- Nobody owns it.", "posted": true}}),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    let t = c.post(&format!("/docs/pages/{page}/comments"), json!({"kind": "page", "body": "Who owns paging?"})).await;
    t.assert_status(201);
    let thread_id = http::id(&t.json());
    let r = c.post_empty(&format!("/docs/ai/threads/{thread_id}/summary")).await;
    r.assert_status(202);
    let j = f.job(&http::id(&r.json())).await;
    assert_eq!(j["state"], "finished", "{j}");
    assert_eq!(j["thread_id"], thread_id.as_str());
    assert_eq!(c.get(&format!("/docs/pages/{page}/comments")).await.json()["docs_ai"], true);
}

#[tokio::test]
async fn test_an_ai_mention_in_a_thread_is_answered_by_the_assistant() {
    let Some((f, pid, page)) = space(
        "test_an_ai_mention_in_a_thread_is_answered_by_the_assistant",
        json!({"docs-thread": {"reply": "Nobody yet: assign it.", "posted": false}}),
    )
    .await
    else {
        return;
    };
    let c = &f.c;
    // `GET /projects/{pid}/ai/teams` is not served by this build: the AI member row made by `runner`
    let members = c.get(&format!("/projects/{pid}/members")).await.json();
    let ai = members.as_array().expect("members").iter().find(|m| m["kind"] == "ai").expect("the AI member").clone();
    let (team_id, team_name) =
        (ai["id"].as_str().expect("id").to_string(), ai["name"].as_str().expect("name").to_string());
    let body = format!("@[{team_name}](member:{team_id}) who owns paging?");
    let t = c.post(&format!("/docs/pages/{page}/comments"), json!({"kind": "page", "body": body})).await;
    t.assert_status(201);
    let delivery = t.json()["ai_delivery"].clone();
    assert!(delivery.as_array().is_some_and(|d| !d.is_empty()) && delivery[0]["result"] == "job", "{delivery}");
    let j = f.job(delivery[0]["job_id"].as_str().expect("job id")).await;
    assert!(j["state"] == "finished" && j["result"]["reply"] == "Nobody yet: assign it.", "{j}");
    let threads = c.get(&format!("/docs/pages/{page}/comments")).await.json()["threads"].clone();
    let replies = threads[0]["comments"].as_array().expect("comments").clone();
    assert!(
        replies.len() == 2 && replies[1]["body"] == "Nobody yet: assign it." && replies[1]["ai"]["member"] == "Docs AI"
    );
    assert_eq!(replies[1]["id"], j["reply_comment_id"]);
}

/// `messaging.deliver_to_page(page, note, by=...)` is a function, not a route. A comment on a canvas of a Docs page
/// that names an AI team reaches it (`services/canvas_delivery.py`, `POST /canvases/{id}/threads`), so the test goes
/// through that route: the note is kept as a page thread written by the sender, the page's assistant answers in it
/// (`delivered`), and with Docs AI off the note is only a comment (`not_delivered`). The `ValueError` of a page that
/// is not there is `deliver_to_page`'s own and is a unit test of `kb-ai-run` (`messaging`).
#[tokio::test]
async fn test_a_note_to_a_page_reaches_the_page_assistant() {
    let Some((f, pid, page)) = space(
        "test_a_note_to_a_page_reaches_the_page_assistant",
        json!({"docs-thread": {"reply": "Noted: the API page will say gRPC.", "posted": false}}),
    )
    .await
    else {
        return;
    };
    let c = f.c.clone().header("x-actor", "An Nguyen");
    let members = c.get(&format!("/projects/{pid}/members")).await.json();
    let team = members.as_array().expect("members").iter().find(|m| m["kind"] == "ai").expect("the AI member").clone();
    let mention = format!("@[{}](member:{})", team["name"].as_str().expect("name"), team["id"].as_str().expect("id"));
    let cv = c.post("/canvases", json!({"owner_kind": "doc", "owner_id": page, "project_id": pid})).await;
    cv.assert_status(201);
    let cid = http::id(&cv.json());
    let t = c
        .post(
            &format!("/canvases/{cid}/threads"),
            json!({"body": format!("{mention} The API moved to gRPC in KAN-1.")}),
        )
        .await;
    t.assert_status(201);
    let deliveries = t.json()["deliveries"].clone();
    assert!(deliveries[0]["result"] == "delivered", "{deliveries}");
    let job = http::poll(|| async {
        let jobs = c.get(&format!("/projects/{pid}/docs/ai/jobs")).await.json();
        jobs.as_array()
            .and_then(|l| l.iter().find(|j| j["kind"] == "thread_reply" && j["state"] == "finished").cloned())
    })
    .await;
    assert_eq!(job["result"]["reply"], "Noted: the API page will say gRPC.");
    let thread = c.get(&format!("/docs/pages/{page}/comments")).await.json()["threads"][0].clone();
    let bodies: Vec<&str> =
        thread["comments"].as_array().expect("comments").iter().filter_map(|x| x["body"].as_str()).collect();
    assert_eq!(bodies.last(), Some(&"Noted: the API page will say gRPC."));
    assert_eq!(thread["comments"][0]["author"], "An Nguyen");
    f.c.patch(&format!("/projects/{pid}/docs/ai"), json!({"enabled": false})).await.assert_status(200);
    let quiet = c.post(&format!("/canvases/{cid}/threads"), json!({"body": format!("{mention} Another note.")})).await;
    assert!(quiet.json()["deliveries"][0]["result"] == "not_delivered", "{}", quiet.text());
}
