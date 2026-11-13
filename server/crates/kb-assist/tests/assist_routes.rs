//! One check per route of the assistants' routers (`api/docs_ai/`, `api/assist.py`, `api/ai_editor.py`,
//! `api/ai_sketch.py`, `api/idea_ai.py`) and of the four Docs routes that call the Docs AI (`send-to-ai`, a ticket's
//! page comments): the answer of each route, for the success case and for each error branch, as status and JSON with
//! ids, times and ports normalized, must be what the Python server answers. The expected answers are recorded from the
//! Python server in `contract/golden/assist_routes/<test>.json` and compared on both targets:
//!
//! `ASSIST_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-assist --test assist_routes`
//!
//! A 422 for a body or query the server cannot read is compared by its status and the location of the field (the
//! wording is Pydantic's). The stand-in CLI answers for `claude` (see `tests/http`); a team is a row added to the
//! database. A GET that no route serves reaches the UI's last route (`Resp::is_ui_index`), recorded as without a UI.

mod http;

use http::{Fixture, Rec, post_form, start};
use serde_json::{Value, json};

/// `_space`: a project with a team, Docs AI on and one page; `answers` are what the stand-in answers per skill.
async fn space(name: &str, answers: Value) -> Option<(Fixture, String, String, String)> {
    let f = start(name, &[]).await?;
    let (pid, _) = f.project().await;
    let team = f.runner(&pid, "Claude Code · Backend", json!({})).await;
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
    let team_id = team["id"].as_str().expect("team").to_string();
    Some((f, pid, page, team_id))
}

fn all_answers() -> Value {
    json!({
        "docs-ask": {"answer": "REST [1].", "verdict": "answered", "citations": [{"page_id": "PAGE", "title": "API"}],
                     "pages_read": 2},
        "docs-check": {"findings": [
            {"kind": "unclear", "quote": "The API uses REST.", "message": "Say which version.",
             "suggestion": "The API uses REST v2."},
            {"kind": "style", "quote": "Add paging", "message": "Write a full sentence."}]},
        "docs-fix": {"old": "The API uses REST.", "new": "The API uses REST v2."},
        "docs-summarise": {"text": "REST API.", "title": "API"},
        "docs-explain": {"text": "REST is a style."},
        "docs-translate": {"markdown": "# API\n\nAPI d\u{f9}ng REST.", "language": "Vietnamese"},
        "docs-write": {"page_id": "PAGE", "title": "Paging", "gaps": ["Who owns it?"]},
        "docs-tickets": {"drafts": [{"title": "Add paging", "text": "From the API page.", "type": "task"}], "skipped": []},
        "docs-freshness": {"state": "stale", "reasons": [{"quote": "REST", "source": "KAN-1", "why": "The API moved to gRPC."}]},
        "docs-thread": {"reply": "- Paging is wanted.", "posted": true},
        "docs-diagram": {"diagram_id": "d1", "label": "Flow", "markdown": "# API\n", "changed": true},
        "docs-history": {"text": "Added paging."},
        "docs-publish-note": {"note": "Paging added."},
        "docs-since": {"lines": []},
    })
}

// ---------------------------------------------------------------------------
// docs_ai
// ---------------------------------------------------------------------------

#[tokio::test]
async fn docs_ai_settings_routes() {
    let name = "docs_ai_settings_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let (pid, an) = f.project().await;
    rec.check("GET docs/ai: no such project", &c.get("/projects/nope/docs/ai").await);
    rec.check("GET docs/ai: no team", &c.get(&format!("/projects/{pid}/docs/ai")).await);
    f.runner(&pid, "Claude Code · Backend", json!({})).await;
    rec.check("GET docs/ai: a team", &c.get(&format!("/projects/{pid}/docs/ai")).await);
    rec.check("PATCH docs/ai: no such project", &c.patch("/projects/nope/docs/ai", json!({"enabled": true})).await);
    rec.check("PATCH docs/ai: enable", &c.patch(&format!("/projects/{pid}/docs/ai"), json!({"enabled": true})).await);
    rec.check(
        "PATCH docs/ai: wrong type",
        &c.patch(&format!("/projects/{pid}/docs/ai"), json!({"enabled": "maybe"})).await,
    );
    rec.check(
        "PATCH docs/ai: not a team",
        &c.patch(&format!("/projects/{pid}/docs/ai"), json!({"member_id": an})).await,
    );
    rec.check(
        "PATCH docs/ai: no page for style",
        &c.patch(&format!("/projects/{pid}/docs/ai"), json!({"style_page_id": "nope"})).await,
    );
    rec.check(
        "PATCH docs/ai: switches",
        &c.patch(&format!("/projects/{pid}/docs/ai"), json!({"freshness_on": false, "digest_on": true})).await,
    );
    let reader = c.clone().header("x-actor", "Someone");
    rec.check(
        "PATCH docs/ai: not an admin",
        &reader.patch(&format!("/projects/{pid}/docs/ai"), json!({"enabled": false})).await,
    );
    rec.check("GET jobs: none", &c.get(&format!("/projects/{pid}/docs/ai/jobs")).await);
    rec.check("GET jobs: limit 0", &c.get(&format!("/projects/{pid}/docs/ai/jobs?limit=0")).await);
    rec.check("GET jobs: limit 201", &c.get(&format!("/projects/{pid}/docs/ai/jobs?limit=201")).await);
    rec.check("GET jobs: limit text", &c.get(&format!("/projects/{pid}/docs/ai/jobs?limit=x")).await);
    rec.check("GET job: none", &c.get("/docs/ai/jobs/nope").await);
    rec.check("POST job cancel: none", &c.post_empty("/docs/ai/jobs/nope/cancel").await);
    f.by_skill(&json!({"docs-summarise": {"text": "REST API.", "title": "API"}}));
    let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "API", "markdown": "# API\n"})).await;
    let page_id = http::id(&page.json());
    let job = c.post_empty(&format!("/docs/pages/{page_id}/ai/summary")).await;
    rec.check("POST summary", &job);
    let jid = http::id(&job.json());
    f.job(&jid).await;
    rec.check("GET job: finished", &c.get(&format!("/docs/ai/jobs/{jid}")).await);
    rec.check("POST job cancel: finished", &c.post_empty(&format!("/docs/ai/jobs/{jid}/cancel")).await);
    rec.check(
        "GET jobs: one",
        &c.get(&format!("/projects/{pid}/docs/ai/jobs?kind=summary&state=finished&page_id={page_id}")).await,
    );
    rec.check("GET jobs: filtered away", &c.get(&format!("/projects/{pid}/docs/ai/jobs?kind=ask")).await);
    rec.finish();
}

#[tokio::test]
async fn docs_ai_ask_and_page_routes() {
    let name = "docs_ai_ask_and_page_routes";
    let Some((f, pid, page, _team)) = space(name, all_answers()).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let ask = format!("/projects/{pid}/docs/ai/ask");
    rec.check("ask: no such project", &c.post("/projects/nope/docs/ai/ask", json!({"question": "x"})).await);
    rec.check("ask: blank", &c.post(&ask, json!({"question": "  "})).await);
    rec.check("ask: too long", &c.post(&ask, json!({"question": "x".repeat(1001)})).await);
    rec.check("ask: scope", &c.post(&ask, json!({"question": "x", "scope": "moon"})).await);
    rec.check("ask: page scope without a page", &c.post(&ask, json!({"question": "x", "scope": "page"})).await);
    rec.check("ask: no body", &c.post_empty(&ask).await);
    let asked = c.post(&ask, json!({"question": "  Which   API style? "})).await;
    rec.check("ask", &asked);
    let jid = http::id(&asked.json());
    rec.check("ask: job", &f.job_resp(&jid).await);
    rec.check("ask: open as chat", &c.post_empty(&format!("/docs/ai/ask/{jid}/chat")).await);
    rec.check("ask: open as chat, none", &c.post_empty("/docs/ai/ask/nope/chat").await);
    rec.check("ask: feedback", &c.post(&format!("/docs/ai/ask/{jid}/feedback"), json!({"rating": "up"})).await);
    rec.check(
        "ask: feedback, bad rating",
        &c.post(&format!("/docs/ai/ask/{jid}/feedback"), json!({"rating": "meh"})).await,
    );
    rec.check("ask: feedback, none", &c.post("/docs/ai/ask/nope/feedback", json!({"rating": "up"})).await);
    let page_ask = c.post(&ask, json!({"question": "About this", "scope": "page", "page_id": page})).await;
    rec.check("ask: this page", &page_ask);
    f.job(&http::id(&page_ask.json())).await;
    rec.check("ask: no such page", &c.post(&ask, json!({"question": "x", "scope": "page", "page_id": "nope"})).await);
    let stale = format!("/docs/pages/{page}/ai/report-stale");
    rec.check("report-stale: no page", &c.post("/docs/pages/nope/ai/report-stale", json!({"reason": "x"})).await);
    rec.check("report-stale: no reason", &c.post(&stale, json!({})).await);
    let reported = c.post(&stale, json!({"reason": "The API moved to gRPC."})).await;
    rec.check("report-stale", &reported);
    f.job(reported.json()["job_id"].as_str().expect("job")).await;
    // the page's jobs
    let p = |tail: &str| format!("/docs/pages/{page}/ai/{tail}");
    for (label, tail, body) in [
        ("summary", "summary", Some(json!({"markdown": "# Draft\n"}))),
        ("summary: no body", "summary", None),
        ("explain", "explain", Some(json!({"selection": "REST"}))),
        ("translate", "translate", Some(json!({"language": "  Vietnamese  "}))),
        ("check", "check", Some(json!({}))),
        ("check: no body", "check", None),
        ("diagram", "diagram", Some(json!({"instruction": "Draw the flow", "selection": "REST"}))),
        ("diagram: nothing", "diagram", Some(json!({}))),
    ] {
        let r = match body {
            Some(b) => c.post(&p(tail), b).await,
            None => c.post_empty(&p(tail)).await,
        };
        rec.check(label, &r);
        f.job(&http::id(&r.json())).await;
    }
    rec.check("explain: blank", &c.post(&p("explain"), json!({"selection": " "})).await);
    rec.check("explain: too long", &c.post(&p("explain"), json!({"selection": "x".repeat(4001)})).await);
    rec.check("explain: no selection", &c.post(&p("explain"), json!({})).await);
    rec.check("translate: blank", &c.post(&p("translate"), json!({"language": "  "})).await);
    rec.check("summary: no page", &c.post_empty("/docs/pages/nope/ai/summary").await);
    let checked = c.post(&p("check"), json!({})).await;
    let job = f.job(&http::id(&checked.json())).await;
    let finding = job["result"]["findings"][0]["id"].as_str().expect("finding").to_string();
    let other = job["result"]["findings"][1]["id"].as_str().expect("finding").to_string();
    let fix = c.post(&p(&format!("check/{finding}/fix")), json!({"job_id": jid.clone()})).await;
    rec.check("fix: job of another kind", &fix);
    let fix = c.post(&p(&format!("check/{finding}/fix")), json!({"job_id": http::id(&checked.json())})).await;
    rec.check("fix", &fix);
    f.job(&http::id(&fix.json())).await;
    rec.check("fix: no finding", &c.post(&p("check/nope/fix"), json!({})).await);
    rec.check("fix: no body", &c.post_empty(&p(&format!("check/{finding}/fix"))).await);
    f.job(&http::id(&c.post_empty(&p("check")).await.json())).await;
    rec.check("ignore", &c.post(&p("check/ignore"), json!({"key": format!(" {other} ")})).await);
    rec.check("ignore: no key", &c.post(&p("check/ignore"), json!({})).await);
    rec.check("ignore: no page", &c.post("/docs/pages/nope/ai/check/ignore", json!({"key": "x"})).await);
    // not allowed: a person who may only read
    let reader = c.clone().header("x-actor", "Someone");
    rec.check("check: another person", &reader.post(&p("check"), json!({})).await);
    rec.check("fix: GET is not served", &c.get(&p("check/x/fix")).await);
    rec.finish();
}

#[tokio::test]
async fn docs_ai_write_routes() {
    let name = "docs_ai_write_routes";
    let Some((f, pid, page, _team)) = space(name, all_answers()).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let base = format!("/projects/{pid}/docs/ai");
    rec.check(
        "write/preview",
        &c.post(&format!("{base}/write/preview"), json!({"source": {"kind": "prompt", "text": "Paging design"}})).await,
    );
    rec.check(
        "write/preview: ticket",
        &c.post(
            &format!("{base}/write/preview"),
            json!({"source": {"kind": "ticket", "ticket_id": "KAN-1"}, "page_kind": "spec"}),
        )
        .await,
    );
    rec.check("write/preview: no source", &c.post(&format!("{base}/write/preview"), json!({})).await);
    rec.check(
        "write/preview: no notes",
        &c.post(&format!("{base}/write/preview"), json!({"source": {"kind": "notes", "text": ""}})).await,
    );
    let w = c
        .post(
            &format!("{base}/write"),
            json!({"source": {"kind": "prompt", "text": "Paging design"}, "page_kind": "spec", "title": "Paging"}),
        )
        .await;
    rec.check("write", &w);
    rec.check("write: job", &f.job_resp(&http::id(&w.json())).await);
    rec.check("write: no ticket", &c.post(&format!("{base}/write"), json!({"source": {"kind": "ticket"}})).await);
    rec.check("write: no idea", &c.post(&format!("{base}/write"), json!({"source": {"kind": "idea"}})).await);
    rec.check("write: bad kind", &c.post(&format!("{base}/write"), json!({"source": {"kind": "moon"}})).await);
    rec.check(
        "write: no project",
        &c.post("/projects/nope/docs/ai/write", json!({"source": {"kind": "prompt", "text": "x"}})).await,
    );
    rec.check("markers", &c.get(&format!("/docs/pages/{page}/ai/markers")).await);
    rec.check("markers: no page", &c.get("/docs/pages/nope/ai/markers").await);
    rec.check("accepted", &c.post_empty(&format!("/docs/pages/{page}/ai/accepted")).await);
    rec.check("accepted: no page", &c.post_empty("/docs/pages/nope/ai/accepted").await);
    let h = format!("/docs/pages/{page}/ai/history-summary");
    let hs = c.post(&h, json!({"from_version": 1, "to_version": 3})).await;
    rec.check("history-summary", &hs);
    f.job(&http::id(&hs.json())).await;
    rec.check("history-summary: not later", &c.post(&h, json!({"from_version": 3, "to_version": 3})).await);
    rec.check("history-summary: no versions", &c.post(&h, json!({})).await);
    rec.check(
        "history-summary: no page",
        &c.post("/docs/pages/nope/ai/history-summary", json!({"from_version": 1, "to_version": 2})).await,
    );
    let pn = c.post(&format!("/docs/pages/{page}/ai/publish-note"), json!({"markdown": "# API\n\nNew.\n"})).await;
    rec.check("publish-note", &pn);
    f.job(&http::id(&pn.json())).await;
    rec.check("publish-note: no body", &c.post_empty(&format!("/docs/pages/{page}/ai/publish-note")).await);
    let sv = c.post_empty(&format!("{base}/since-viewed")).await;
    rec.check("since-viewed", &sv);
    f.job(&http::id(&sv.json())).await;
    rec.check("since-viewed: no project", &c.post_empty("/projects/nope/docs/ai/since-viewed").await);
    let tidy = format!("{base}/tidy");
    rec.check("tidy", &c.post(&tidy, json!({"markdown": "# A\n\ntext\n\n# B\n\nmore KAN-1\n", "options": {"split_by_heading": true, "ticket_chips": true}})).await);
    rec.check("tidy: all options", &c.post(&tidy, json!({"markdown": "# A\n\n### B\n\nsee API\n", "filename": "notes.md", "options": {"see_links": true, "heading_levels": true}, "accept_see_links": ["api"]})).await);
    rec.check("tidy: no markdown", &c.post(&tidy, json!({})).await);
    rec.check("tidy: no project", &c.post("/projects/nope/docs/ai/tidy", json!({"markdown": "x"})).await);
    let thread =
        c.post(&format!("/docs/pages/{page}/comments"), json!({"kind": "page", "body": "Who owns paging?"})).await;
    let tid = http::id(&thread.json());
    let s = c.post_empty(&format!("/docs/ai/threads/{tid}/summary")).await;
    rec.check("thread summary", &s);
    f.job(&http::id(&s.json())).await;
    rec.check("thread summary: no thread", &c.post_empty("/docs/ai/threads/nope/summary").await);
    rec.finish();
}

#[tokio::test]
async fn docs_ai_health_and_ticket_routes() {
    let name = "docs_ai_health_and_ticket_routes";
    let Some((f, pid, page, _team)) = space(name, all_answers()).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let fresh = format!("/docs/pages/{page}/ai/freshness");
    rec.check("freshness: unchecked", &c.get(&fresh).await);
    rec.check("freshness: no page", &c.get("/docs/pages/nope/ai/freshness").await);
    let r = c.post_empty(&fresh).await;
    rec.check("freshness: check", &r);
    f.job(&http::id(&r.json())).await;
    let banner = c.get(&fresh).await;
    rec.check("freshness: stale", &banner);
    let key = banner.json()["reasons"][0]["key"].clone();
    rec.check("freshness: dismiss", &c.post(&format!("{fresh}/dismiss"), json!({"key": key, "level": "once"})).await);
    rec.check("freshness: dismiss, no key", &c.post(&format!("{fresh}/dismiss"), json!({})).await);
    rec.check("freshness: still correct", &c.post_empty(&format!("{fresh}/still-correct")).await);
    let health = format!("/projects/{pid}/docs/ai/health");
    rec.check("health", &c.get(&health).await);
    rec.check("health: no project", &c.get("/projects/nope/docs/ai/health").await);
    rec.check("health/count", &c.get(&format!("{health}/count")).await);
    rec.check("health/count: no project", &c.get("/projects/nope/docs/ai/health/count").await);
    rec.check("health/run", &c.post_empty(&format!("{health}/run")).await);
    rec.check("health/run: no project", &c.post_empty("/projects/nope/docs/ai/health/run").await);
    let missing = c.get(&health).await.json();
    let kind = missing
        .as_object()
        .and_then(|m| m.iter().find(|(_, v)| v.as_array().is_some_and(|a| !a.is_empty())).map(|(k, _)| k.clone()));
    let _ = kind;
    rec.check(
        "health/dismiss: bad kind",
        &c.post(&format!("{health}/dismiss"), json!({"kind": "moon", "id": "x", "level": "once"})).await,
    );
    rec.check(
        "health/dismiss: bad level",
        &c.post(&format!("{health}/dismiss"), json!({"kind": "stale", "id": "x", "level": "moon"})).await,
    );
    rec.check(
        "health/dismiss",
        &c.post(&format!("{health}/dismiss"), json!({"kind": "stale", "id": "x", "level": "never"})).await,
    );
    rec.check("health/dismiss: no body", &c.post(&format!("{health}/dismiss"), json!({})).await);
    // from a page to tickets
    let tickets = format!("/docs/pages/{page}/ai/tickets");
    let d = c.post(&format!("{tickets}/draft"), json!({"selection": "Add paging"})).await;
    rec.check("tickets/draft", &d);
    let job = f.job(&http::id(&d.json())).await;
    rec.check("tickets/draft: no body", &c.post_empty(&format!("{tickets}/draft")).await);
    rec.check("tickets/draft: no page", &c.post_empty("/docs/pages/nope/ai/tickets/draft").await);
    let made = c.post(&format!("{tickets}/create"), json!({"drafts": job["result"]["drafts"]})).await;
    rec.check("tickets/create", &made);
    let token = made.json()["undo_token"].clone();
    let tid = made.json()["tickets"][0]["id"].as_str().expect("ticket").to_string();
    rec.check("tickets/create: the ticket", &c.get(&format!("/tickets/{tid}")).await);
    rec.check(
        "tickets/create: not linked",
        &c.post(&format!("{tickets}/create"), json!({"drafts": [{"title": "Plain"}], "link": false})).await,
    );
    rec.check("tickets/create: no title", &c.post(&format!("{tickets}/create"), json!({"drafts": [{}]})).await);
    rec.check("tickets/create: no page", &c.post("/docs/pages/nope/ai/tickets/create", json!({"drafts": []})).await);
    rec.check("tickets/undo", &c.post("/docs/ai/tickets/undo", json!({"undo_token": token})).await);
    rec.check("tickets/undo: again", &c.post("/docs/ai/tickets/undo", json!({"undo_token": token})).await);
    rec.check("tickets/undo: no token", &c.post("/docs/ai/tickets/undo", json!({})).await);
    rec.finish();
}

#[tokio::test]
async fn docs_ai_off_routes() {
    let name = "docs_ai_off_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let (pid, _) = f.project().await;
    let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "API", "markdown": "# API\n"})).await;
    let page = http::id(&page.json());
    c.patch(&format!("/projects/{pid}/docs/ai"), json!({"enabled": false})).await.assert_status(200);
    rec.check("off: ask", &c.post(&format!("/projects/{pid}/docs/ai/ask"), json!({"question": "x"})).await);
    rec.check("off: summary", &c.post_empty(&format!("/docs/pages/{page}/ai/summary")).await);
    rec.check("off: freshness", &c.get(&format!("/docs/pages/{page}/ai/freshness")).await);
    rec.check("off: health", &c.get(&format!("/projects/{pid}/docs/ai/health")).await);
    rec.check("off: tidy", &c.post(&format!("/projects/{pid}/docs/ai/tidy"), json!({"markdown": "x"})).await);
    c.patch(&format!("/projects/{pid}/docs/ai"), json!({"enabled": true})).await.assert_status(200);
    rec.check("no team: ask", &c.post(&format!("/projects/{pid}/docs/ai/ask"), json!({"question": "x"})).await);
    rec.check("no team: summary", &c.post_empty(&format!("/docs/pages/{page}/ai/summary")).await);
    rec.check(
        "no team: write",
        &c.post(&format!("/projects/{pid}/docs/ai/write"), json!({"source": {"kind": "prompt", "text": "x"}})).await,
    );
    rec.finish();
}

#[tokio::test]
async fn docs_send_to_ai_routes() {
    let name = "docs_send_to_ai_routes";
    let Some((f, pid, page, team)) = space(name, all_answers()).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let send = format!("/docs/pages/{page}/send-to-ai");
    rec.check("send-to-ai: targets", &c.get(&send).await);
    rec.check("send-to-ai: targets, no page", &c.get("/docs/pages/nope/send-to-ai").await);
    let t =
        c.post(&format!("/docs/pages/{page}/comments"), json!({"kind": "page", "body": "Please add paging."})).await;
    let tid = http::id(&t.json());
    rec.check("send-to-ai: targets with a thread", &c.get(&send).await);
    rec.check("send-to-ai: no threads", &c.post(&send, json!({"thread_ids": []})).await);
    rec.check("send-to-ai: no body", &c.post_empty(&send).await);
    rec.check("send-to-ai: bad destination", &c.post(&send, json!({"thread_ids": [tid], "to": "moon"})).await);
    rec.check("send-to-ai: no ticket", &c.post(&send, json!({"thread_ids": [tid], "to": "team"})).await);
    rec.check(
        "send-to-ai: unknown ticket",
        &c.post(&send, json!({"thread_ids": [tid], "to": "team", "ticket_id": "KAN-99"})).await,
    );
    rec.check(
        "send-to-ai: unknown thread",
        &c.post(&send, json!({"thread_ids": ["nope"], "to": "page_assistant"})).await,
    );
    let ticket = f.ticket(&pid, "Add paging").await;
    rec.check(
        "send-to-ai: ticket without a team",
        &c.post(&send, json!({"thread_ids": [tid], "to": "team", "ticket_id": ticket})).await,
    );
    rec.check(
        "send-to-ai: give a team that is not there",
        &c.post(&send, json!({"thread_ids": [tid], "to": "team", "ticket_id": ticket, "give_team_id": "nope"})).await,
    );
    let assist = c.post(&send, json!({"thread_ids": [tid], "to": "page_assistant"})).await;
    rec.check("send-to-ai: page assistant", &assist);
    if let Some(job) = assist.json()["job_id"].as_str() {
        f.job(job).await;
    }
    let routed = c.post(&send, json!({"thread_ids": [tid], "to": "board_ai"})).await;
    rec.check("send-to-ai: board ai", &routed);
    if let Some(job) = routed.json()["job_id"].as_str() {
        f.job(job).await;
    }
    rec.check(
        "send-to-ai: team, given",
        &c.post(&send, json!({"thread_ids": [tid], "to": "team", "ticket_id": ticket, "give_team_id": team})).await,
    );
    rec.check("send-to-ai: PUT is not served", &c.put(&send, json!({})).await);
    // the comments of the pages linked to a ticket (a second ticket: the first one's run is going, and whether it has
    // ended by the next request is a race between two servers)
    let other = f.ticket(&pid, "Export CSV").await;
    let comments = format!("/tickets/{other}/docs/comments");
    rec.check("ticket comments: none linked", &c.get(&comments).await);
    c.post(&format!("/tickets/{other}/docs"), json!({"page_id": page})).await.assert_status(201);
    rec.check("ticket comments: linked", &c.get(&comments).await);
    rec.check("ticket comments: no ticket", &c.get("/tickets/KAN-99/docs/comments").await);
    rec.check("ticket comments/send: no body", &c.post_empty(&format!("{comments}/send")).await);
    rec.check("ticket comments/send: no team", &c.post(&format!("{comments}/send"), json!({})).await);
    rec.check(
        "ticket comments/send: team that is not there",
        &c.post(&format!("{comments}/send"), json!({"give_team_id": "nope"})).await,
    );
    rec.check(
        "ticket comments/send: given a team",
        &c.post(&format!("{comments}/send"), json!({"give_team_id": team})).await,
    );
    rec.check("ticket comments/send: no ticket", &c.post("/tickets/KAN-99/docs/comments/send", json!({})).await);
    // a comment that names the AI is answered
    let team_row = c.get(&format!("/projects/{pid}/members")).await.json();
    let ai = team_row.as_array().expect("members").iter().find(|m| m["kind"] == "ai").expect("AI member").clone();
    let body = format!(
        "@[{}](member:{}) who owns paging?",
        ai["name"].as_str().expect("name"),
        ai["id"].as_str().expect("id")
    );
    let mention = c.post(&format!("/docs/pages/{page}/comments"), json!({"kind": "page", "body": body})).await;
    rec.check("comment naming an AI", &mention);
    if let Some(job) = mention.json()["ai_delivery"][0]["job_id"].as_str() {
        f.job(job).await;
    }
    rec.check(
        "comment naming an AI: notify",
        &c.post(&format!("/docs/pages/{page}/comments"), json!({"kind": "page", "body": body, "ai_intent": "notify"}))
            .await,
    );
    rec.check("comments: the list", &c.get(&format!("/docs/pages/{page}/comments")).await);
    rec.finish();
}

// ---------------------------------------------------------------------------
// assist
// ---------------------------------------------------------------------------

#[tokio::test]
async fn assist_settings_and_chat_routes() {
    let name = "assist_settings_and_chat_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let (pid, _) = f.project().await;
    let base = format!("/projects/{pid}/ai/assist");
    rec.check("assist: no team", &c.get(&base).await);
    rec.check("assist: no project", &c.get("/projects/nope/ai/assist").await);
    f.runner(&pid, "Claude Code · Backend", json!({})).await;
    rec.check("assist", &c.get(&base).await);
    rec.check("assist: patch", &c.patch(&base, json!({"tone": "concise", "language": "Vietnamese", "style_guide": "Short.", "features": {"sketch": false}, "health": {"stuck_days": 3}})).await);
    rec.check("assist: patch, no project", &c.patch("/projects/nope/ai/assist", json!({"tone": "x"})).await);
    rec.check("assist: patch, wrong type", &c.patch(&base, json!({"features": {"chat": "maybe"}})).await);
    rec.check("assist: patch, bad feature", &c.patch(&base, json!({"features": {"moon": true}})).await);
    rec.check("assist: patch, null", &c.patch(&base, json!({"tone": null})).await);
    let ticket = f.ticket(&pid, "Fix add()").await;
    rec.check("chats: none", &c.get(&format!("{base}/chats")).await);
    rec.check("chats: no project", &c.get("/projects/nope/ai/assist/chats").await);
    let chat = c.post(&format!("{base}/chats"), json!({"scope": "project"})).await;
    rec.check("chats: new", &chat);
    let cid = http::id(&chat.json());
    rec.check("chats: same again", &c.post(&format!("{base}/chats"), json!({})).await);
    rec.check("chats: fresh", &c.post(&format!("{base}/chats"), json!({"fresh": true})).await);
    rec.check(
        "chats: ticket",
        &c.post(&format!("{base}/chats"), json!({"scope": "ticket", "ticket_id": ticket})).await,
    );
    rec.check("chats: bad scope", &c.post(&format!("{base}/chats"), json!({"scope": "moon"})).await);
    rec.check("chats: new, no project", &c.post("/projects/nope/ai/assist/chats", json!({})).await);
    rec.check("chats: search", &c.get(&format!("{base}/chats?q=zzz")).await);
    rec.check("chats: listed", &c.get(&format!("{base}/chats")).await);
    rec.check("chat", &c.get(&format!("/ai/assist/chats/{cid}")).await);
    rec.check("chat: none", &c.get("/ai/assist/chats/nope").await);
    rec.check(
        "chat: another person",
        &c.clone().header("x-actor", "Someone").get(&format!("/ai/assist/chats/{cid}")).await,
    );
    rec.check(
        "chat: patch",
        &c.patch(&format!("/ai/assist/chats/{cid}"), json!({"scope": "ticket", "ticket_id": ticket})).await,
    );
    rec.check("chat: patch, none", &c.patch("/ai/assist/chats/nope", json!({"scope": "project"})).await);
    rec.check("chat: patch, bad scope", &c.patch(&format!("/ai/assist/chats/{cid}"), json!({"scope": "moon"})).await);
    rec.check("chat: seen", &c.post_empty(&format!("/ai/assist/chats/{cid}/seen")).await);
    rec.check("chat: seen, none", &c.post_empty("/ai/assist/chats/nope/seen").await);
    rec.check("scope: ticket", &c.get(&format!("/ai/scopes/ticket/{ticket}")).await);
    rec.check("scope: none", &c.get("/ai/scopes/ticket/nope").await);
    rec.check("scope: bad kind", &c.get("/ai/scopes/moon/x").await);
    rec.check("scope chat", &c.post(&format!("/ai/scopes/ticket/{ticket}/chat"), json!({})).await);
    rec.check("scope chat: no body", &c.post_empty(&format!("/ai/scopes/ticket/{ticket}/chat")).await);
    rec.check("scope chat: fresh", &c.post(&format!("/ai/scopes/ticket/{ticket}/chat"), json!({"fresh": true})).await);
    rec.check("scope chat: none", &c.post("/ai/scopes/ticket/nope/chat", json!({})).await);
    let member = c.get(&format!("/projects/{pid}/members")).await.json();
    let ai = member.as_array().expect("members").iter().find(|m| m["kind"] == "ai").expect("AI").clone();
    let mid = ai["id"].as_str().expect("id");
    rec.check("estimate", &c.get_query(&format!("/tickets/{ticket}/ai/estimate"), &[("member_id", mid)]).await);
    rec.check(
        "estimate: work",
        &c.get_query(&format!("/tickets/{ticket}/ai/estimate"), &[("member_id", mid), ("mode", "work")]).await,
    );
    rec.check(
        "estimate: person",
        &c.get_query(&format!("/tickets/{ticket}/ai/estimate"), &[("member_id", "nope")]).await,
    );
    rec.check("estimate: no member", &c.get(&format!("/tickets/{ticket}/ai/estimate")).await);
    rec.check("estimate: no ticket", &c.get_query("/tickets/nope/ai/estimate", &[("member_id", mid)]).await);
    rec.check("chat: delete", &c.delete(&format!("/ai/assist/chats/{cid}")).await);
    rec.check("chat: delete, none", &c.delete("/ai/assist/chats/nope").await);
    rec.finish();
}

#[tokio::test]
async fn assist_message_routes() {
    let name = "assist_message_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let pid = f.board().await;
    let ticket = f.ticket(&pid, "Fix add()").await;
    f.fake(&[("FAKE_CLAUDE_ASSISTANT_TEXT", "add() subtracts: fix the operator.")]);
    let chat = c.post(&format!("/ai/scopes/ticket/{ticket}/chat"), json!({})).await.json();
    let cid = http::id(&chat);
    let msgs = format!("/ai/assist/chats/{cid}/messages");
    rec.check("message: no text", &c.post(&msgs, json!({})).await);
    rec.check("message: no chat", &c.post("/ai/assist/chats/nope/messages", json!({"text": "x"})).await);
    rec.check("message: bad mode", &c.post(&msgs, json!({"text": "x", "mode": 5})).await);
    let sent = c.post(&msgs, json!({"text": "What is wrong?", "doc_ids": [], "mode": "ask"})).await;
    rec.check("message", &sent);
    sent.assert_status(200);
    let mid = http::id(&sent.json()["ai"]);
    rec.check("message: answered", &f.answer_resp(&mid).await);
    rec.check("message: get none", &c.get("/ai/assist/messages/nope").await);
    rec.check(
        "message: another person",
        &c.clone().header("x-actor", "Someone").get(&format!("/ai/assist/messages/{mid}")).await,
    );
    rec.check(
        "message: feedback",
        &c.post(&format!("/ai/assist/messages/{mid}/feedback"), json!({"thumb": "down", "reason": "wrong"})).await,
    );
    rec.check("message: feedback, clear", &c.post(&format!("/ai/assist/messages/{mid}/feedback"), json!({})).await);
    rec.check("message: feedback, none", &c.post("/ai/assist/messages/nope/feedback", json!({"thumb": "up"})).await);
    rec.check(
        "message: feedback, bad thumb",
        &c.post(&format!("/ai/assist/messages/{mid}/feedback"), json!({"thumb": "sideways"})).await,
    );
    rec.check(
        "message: post-comment",
        &c.post(&format!("/ai/assist/messages/{mid}/post-comment"), json!({"text": "Edited answer."})).await,
    );
    rec.check(
        "message: post-comment, no body",
        &c.post_empty(&format!("/ai/assist/messages/{mid}/post-comment")).await,
    );
    rec.check("message: post-comment, none", &c.post("/ai/assist/messages/nope/post-comment", json!({})).await);
    rec.check("message: undo", &c.post_empty(&format!("/ai/assist/messages/{mid}/undo")).await);
    rec.check("message: undo, none", &c.post_empty("/ai/assist/messages/nope/undo").await);
    rec.check("message: stop, done", &c.post_empty(&format!("/ai/assist/messages/{mid}/stop")).await);
    rec.check("message: stop, none", &c.post_empty("/ai/assist/messages/nope/stop").await);
    let again = c.post(&format!("/ai/assist/messages/{mid}/retry"), json!({"send_all": true})).await;
    rec.check("message: retry", &again);
    f.answer(&http::id(&again.json())).await;
    let again = c.post_empty(&format!("/ai/assist/messages/{mid}/retry")).await;
    rec.check("message: retry, no body", &again);
    f.answer(&http::id(&again.json())).await;
    rec.check("message: retry, none", &c.post_empty("/ai/assist/messages/nope/retry").await);
    f.fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "20")]);
    let slow = c.post(&msgs, json!({"text": "Take your time"})).await.json()["ai"].clone();
    rec.check("message: busy", &c.post(&msgs, json!({"text": "Again"})).await);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let sid = http::id(&slow);
    rec.check("message: stop", &c.post_empty(&format!("/ai/assist/messages/{sid}/stop")).await);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    rec.check("message: stopped", &c.get(&format!("/ai/assist/messages/{sid}")).await);
    rec.check(
        "message: retry a stopped one",
        &c.post(&format!("/ai/assist/messages/{sid}/retry"), json!({"continue": true})).await,
    );
    f.fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "0")]);
    rec.check("chat: with messages", &c.get(&format!("/ai/assist/chats/{cid}")).await);
    rec.finish();
}

#[tokio::test]
async fn assist_draft_and_health_routes() {
    let name = "assist_draft_and_health_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let pid = f.board().await;
    let ticket = f.ticket(&pid, "Fix add()").await;
    rec.check("drafts: create", &c.post(&format!("/projects/{pid}/ai/assist/drafts"), json!({"kind": "split"})).await);
    rec.check("drafts: create, no body", &c.post_empty(&format!("/projects/{pid}/ai/assist/drafts")).await);
    for action in ["apply", "undo", "request-apply", "moon"] {
        rec.check(&format!("drafts: {action}"), &c.post_empty(&format!("/ai/assist/drafts/d1/{action}")).await);
    }
    rec.check("drafts: patch", &c.patch("/ai/assist/drafts/d1", json!({})).await);
    rec.check("drafts: get none", &c.get("/ai/assist/drafts/d1").await);
    rec.check("drafts: discard none", &c.post_empty("/ai/assist/drafts/d1/discard").await);
    rec.check("drafts: cancel none", &c.post_empty("/ai/assist/drafts/d1/cancel").await);
    rec.check("drafts: regenerate none", &c.post_empty("/ai/assist/drafts/d1/regenerate").await);
    rec.check("drafts: ticket list", &c.get(&format!("/tickets/{ticket}/ai/assist/drafts")).await);
    rec.check("drafts: ticket list, no ticket", &c.get("/tickets/nope/ai/assist/drafts").await);
    rec.check("drafts: project list", &c.get(&format!("/projects/{pid}/ai/assist/drafts")).await);
    rec.check("similar", &c.get(&format!("/projects/{pid}/ai/assist/similar?text=add")).await);
    rec.check("similar: no text", &c.get(&format!("/projects/{pid}/ai/assist/similar")).await);
    rec.check("assignees", &c.get(&format!("/projects/{pid}/ai/assist/assignees?text=add&ticket_id={ticket}")).await);
    rec.check("coverage: none", &c.get(&format!("/tickets/{ticket}/ai/assist/coverage")).await);
    rec.check("coverage: no ticket", &c.get("/tickets/nope/ai/assist/coverage").await);
    c.patch(
        &format!("/tickets/{ticket}"),
        json!({"acceptance_criteria": [{"id": "ac1", "text": "add(2, 3) returns 5"}, {"id": "ac2", "text": "Negative numbers work"}]}),
    )
    .await;
    rec.check("coverage: criteria", &c.get(&format!("/tickets/{ticket}/ai/assist/coverage")).await);
    // board health
    let base = format!("/projects/{pid}/ai/assist");
    rec.check("health: empty", &c.get(&format!("{base}/health")).await);
    rec.check("health: no project", &c.get("/projects/nope/ai/assist/health").await);
    rec.check("chips: empty", &c.get(&format!("{base}/chips")).await);
    rec.check("health/seen", &c.post_empty(&format!("{base}/health/seen")).await);
    rec.check("health/snooze-all: none", &c.post_empty(&format!("{base}/health/snooze-all")).await);
    rec.check("health/run: no project", &c.post_empty("/projects/nope/ai/assist/health/run").await);
    let insight = json!({"kind": "stuck", "ticket_id": ticket, "title": format!("{ticket} has not moved for 6 days"),
                         "detail": "In todo since Monday.", "score": 80});
    f.answer_json(&json!({"insights": [insight], "summary": "One ticket is stuck."}));
    let run = c.post_empty(&format!("{base}/health/run")).await;
    rec.check("health/run", &run);
    let iid = run.json()["needs_action"][0]["id"].as_str().expect("insight").to_string();
    rec.check("health", &c.get(&format!("{base}/health")).await);
    rec.check("chips", &c.get(&format!("{base}/chips")).await);
    rec.check("health/seen: after", &c.post_empty(&format!("{base}/health/seen")).await);
    rec.check("insights: snooze", &c.post(&format!("/ai/assist/insights/{iid}/snooze"), json!({"hours": 2})).await);
    rec.check("insights: restore", &c.post(&format!("/ai/assist/insights/{iid}/restore"), json!({})).await);
    rec.check("insights: dismiss, no body", &c.post_empty(&format!("/ai/assist/insights/{iid}/dismiss")).await);
    rec.check("insights: act", &c.post(&format!("/ai/assist/insights/{iid}/act"), json!({})).await);
    rec.check("insights: none", &c.post("/ai/assist/insights/nope/snooze", json!({})).await);
    rec.check("insights: bad action", &c.post(&format!("/ai/assist/insights/{iid}/moon"), json!({})).await);
    rec.check("health/snooze-all", &c.post_empty(&format!("{base}/health/snooze-all")).await);
    rec.finish();
}

#[tokio::test]
async fn editor_routes() {
    let name = "editor_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let pid = f.board().await;
    let tid = f.ticket(&pid, "Fix add()").await;
    let state = format!("/projects/{pid}/ai/editor/state");
    rec.check("state", &c.get_query(&state, &[("surface", "ticket_description"), ("ticket_id", &tid)]).await);
    rec.check("state: comment", &c.get_query(&state, &[("surface", "ticket_comment")]).await);
    rec.check("state: no surface", &c.get(&state).await);
    rec.check("state: bad surface", &c.get_query(&state, &[("surface", "moon")]).await);
    rec.check(
        "state: no project",
        &c.get_query("/projects/nope/ai/editor/state", &[("surface", "ticket_description")]).await,
    );
    let body =
        json!({"surface": "ticket_description", "action": "improve", "selection": "add is brokn", "ticket_id": tid});
    let preview = format!("/projects/{pid}/ai/editor/preview");
    rec.check("preview", &c.post(&preview, body.clone()).await);
    rec.check(
        "preview: bad action",
        &c.post(&preview, json!({"surface": "ticket_description", "action": "moon"})).await,
    );
    rec.check("preview: no body", &c.post_empty(&preview).await);
    rec.check("preview: no project", &c.post("/projects/nope/ai/editor/preview", body.clone()).await);
    let drafts = format!("/projects/{pid}/ai/editor/drafts");
    f.answer_json(&json!({"text": "add() is broken."}));
    let d = c.post(&drafts, body.clone()).await;
    rec.check("drafts", &d);
    let did = http::id(&d.json());
    rec.check("drafts: written", &f.draft_resp(&did).await);
    let mut empty = body.clone();
    empty["selection"] = json!("");
    rec.check("drafts: nothing selected", &c.post(&drafts, empty).await);
    rec.check("drafts: no project", &c.post("/projects/nope/ai/editor/drafts", body.clone()).await);
    rec.check("accept", &c.post(&format!("/ai/editor/drafts/{did}/accept"), json!({})).await);
    rec.check("accept: again", &c.post(&format!("/ai/editor/drafts/{did}/accept"), json!({})).await);
    rec.check("accept: none", &c.post("/ai/editor/drafts/nope/accept", json!({})).await);
    f.answer_json(&json!({"text": "- add(2, 3) returns 5\n- add(-1, 1) returns 0"}));
    let mut crit = body.clone();
    crit["action"] = json!("criteria");
    crit["selection"] = json!("");
    let d = c.post(&drafts, crit).await;
    let cid = http::id(&d.json());
    f.draft(&cid).await;
    rec.check(
        "accept: criteria",
        &c.post(&format!("/ai/editor/drafts/{cid}/accept"), json!({"items": ["add(2, 3) returns 5"]})).await,
    );
    rec.check("ticket: criteria", &c.get(&format!("/tickets/{tid}")).await);
    let again = c.post(&drafts, body.clone()).await;
    let aid = http::id(&again.json());
    f.draft(&aid).await;
    let cont = c.post_empty(&format!("/ai/editor/drafts/{aid}/continue")).await;
    rec.check("continue", &cont);
    f.draft(&http::id(&cont.json())).await;
    rec.check("continue: none", &c.post_empty("/ai/editor/drafts/nope/continue").await);
    let regen = c.post_empty(&format!("/ai/assist/drafts/{aid}/regenerate")).await;
    rec.check("regenerate", &regen);
    f.draft(&http::id(&regen.json())).await;
    rec.check("discard", &c.post_empty(&format!("/ai/assist/drafts/{aid}/discard")).await);
    rec.check("cancel", &c.post_empty(&format!("/ai/assist/drafts/{aid}/cancel")).await);
    rec.check("draft: get", &c.get(&format!("/ai/assist/drafts/{aid}")).await);
    rec.finish();
}

#[tokio::test]
async fn sketch_routes() {
    let name = "sketch_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let pid = f.board().await;
    rec.check(
        "state",
        &c.get_query("/ai/sketch/state", &[("owner_kind", "ticket"), ("owner_id", "x"), ("project_id", &pid)]).await,
    );
    rec.check(
        "state: no project",
        &c.get_query("/ai/sketch/state", &[("owner_kind", "ticket"), ("owner_id", "x")]).await,
    );
    rec.check(
        "state: unknown project",
        &c.get_query("/ai/sketch/state", &[("owner_kind", "ticket"), ("owner_id", "x"), ("project_id", "nope")]).await,
    );
    rec.check("state: no owner", &c.get("/ai/sketch/state").await);
    rec.check(
        "preview",
        &c.post(
            "/ai/sketch/preview",
            json!({"owner_kind": "ticket", "owner_id": "x", "prompt": " What is this? ", "title": "Login", "image_width": 800,
                   "image_height": 600, "image_bytes": 1000,
                   "attachments": [{"name": "notes.txt", "chars": 401}, {"chars": "9"}, {}]}),
        )
        .await,
    );
    rec.check(
        "preview: empty",
        &c.post("/ai/sketch/preview", json!({"owner_kind": "ticket", "owner_id": "x", "with_image": false})).await,
    );
    rec.check("preview: no owner", &c.post("/ai/sketch/preview", json!({})).await);
    let chat = c
        .post(&format!("/projects/{pid}/ai/assist/chats"), json!({"scope": "sketch", "scope_id": "sk_1"}))
        .await
        .json();
    let cid = http::id(&chat);
    let messages = format!("/ai/sketch/chats/{cid}/messages");
    f.answer_json(&json!({"answer": "A login flow.", "ideas": ["Add an error state", "Add a logo"]}));
    let r = post_form(
        c,
        &messages,
        &[("text", "What is this?"), ("width", "800"), ("height", "600"), ("title", "Login")],
        &[("image", "canvas.png", b"\x89PNG\r\n"), ("files", "notes.txt", b"A note.")],
    )
    .await;
    rec.check("message", &r);
    let m = f.answer(&http::id(&r.json()["ai"])).await;
    rec.check("message: answered", &c.get(&format!("/ai/assist/messages/{}", http::id(&m))).await);
    let run_id = m["context"]["run"]["id"].as_str().expect("run").to_string();
    let files = format!("/ai/sketch/chats/{cid}/files/{run_id}");
    let pic = c.get(&format!("{files}/canvas.png")).await;
    rec.note(
        "file: picture",
        json!({"status": pic.status, "type": pic.headers.get("content-type").and_then(|v| v.to_str().ok()),
        "disposition": pic.headers.get("content-disposition").and_then(|v| v.to_str().ok()),
        "csp": pic.headers.get("content-security-policy").and_then(|v| v.to_str().ok()),
        "bytes": String::from_utf8_lossy(&pic.body)}),
    );
    let note = c.get(&format!("{files}/notes.txt")).await;
    rec.note("file: note", json!({"status": note.status, "disposition": note.headers.get("content-disposition").and_then(|v| v.to_str().ok()),
        "bytes": String::from_utf8_lossy(&note.body)}));
    rec.check("file: system.md", &c.get(&format!("{files}/system.md")).await);
    rec.check("file: none", &c.get(&format!("{files}/nope.png")).await);
    rec.check("file: no turn", &c.get(&format!("/ai/sketch/chats/{cid}/files/nope/canvas.png")).await);
    rec.check("file: no chat", &c.get(&format!("/ai/sketch/chats/nope/files/{run_id}/canvas.png")).await);
    rec.check(
        "file: another person",
        &c.clone().header("x-actor", "Someone").get(&format!("{files}/canvas.png")).await,
    );
    rec.check("message: no fields", &post_form(c, &messages, &[], &[]).await);
    rec.check(
        "message: bad numbers",
        &post_form(c, &messages, &[("text", "x"), ("width", "wide"), ("height", "")], &[]).await,
    );
    rec.check(
        "message: bad flag",
        &post_form(c, &messages, &[("text", "x"), ("width", "1"), ("height", "1"), ("with_image", "maybe")], &[]).await,
    );
    rec.check(
        "message: too long",
        &post_form(c, &messages, &[("text", &"x".repeat(2001)), ("width", "1"), ("height", "1")], &[]).await,
    );
    let many: Vec<(&str, &str, &[u8])> = (0..8).map(|_| ("files", "a.txt", &b"a"[..])).collect();
    rec.check(
        "message: too many files",
        &post_form(c, &messages, &[("text", "x"), ("width", "1"), ("height", "1")], &many).await,
    );
    let big = vec![b'x'; 4 * 1024 * 1024 + 1];
    rec.check(
        "message: big picture",
        &post_form(c, &messages, &[("text", "x"), ("width", "1"), ("height", "1")], &[("image", "canvas.png", &big)])
            .await,
    );
    let bigger = vec![b'x'; 5 * 1024 * 1024 + 1];
    rec.check(
        "message: big file",
        &post_form(c, &messages, &[("text", "x"), ("width", "1"), ("height", "1")], &[("files", "huge.txt", &bigger)])
            .await,
    );
    rec.check(
        "message: no chat",
        &post_form(c, "/ai/sketch/chats/nope/messages", &[("text", "x"), ("width", "1"), ("height", "1")], &[]).await,
    );
    rec.check("message: JSON is not a form", &c.post(&messages, json!({"text": "x", "width": 1, "height": 1})).await);
    let draft_id = m["draft_id"].as_str().expect("draft").to_string();
    rec.check("idea", &c.post(&format!("/ai/sketch/drafts/{draft_id}/idea"), json!({"index": 1})).await);
    rec.check("idea: again", &c.post(&format!("/ai/sketch/drafts/{draft_id}/idea"), json!({"index": 0})).await);
    rec.check("idea: out of range", &c.post(&format!("/ai/sketch/drafts/{draft_id}/idea"), json!({"index": 2})).await);
    rec.check("idea: negative", &c.post(&format!("/ai/sketch/drafts/{draft_id}/idea"), json!({"index": -1})).await);
    rec.check("idea: no index", &c.post(&format!("/ai/sketch/drafts/{draft_id}/idea"), json!({})).await);
    rec.check("idea: none", &c.post("/ai/sketch/drafts/nope/idea", json!({"index": 0})).await);
    rec.check("accept", &c.post_empty(&format!("/ai/sketch/drafts/{draft_id}/accept")).await);
    rec.check("accept: again", &c.post_empty(&format!("/ai/sketch/drafts/{draft_id}/accept")).await);
    rec.check("accept: none", &c.post_empty("/ai/sketch/drafts/nope/accept").await);
    f.fake(&[("FAKE_CLAUDE_ASSISTANT_JSON", "")]);
    rec.finish();
}

#[tokio::test]
async fn idea_ai_routes() {
    let name = "idea_ai_routes";
    let Some(f) = start(name, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name);
    let base = "/api/idea-ai";
    let (pid, _) = f.project().await;
    rec.check("status: no team", &c.get_query(&format!("{base}/status"), &[("project_id", &pid)]).await);
    rec.check("status: no project", &c.get(&format!("{base}/status")).await);
    f.runner(&pid, "Claude Code · Backend", json!({})).await;
    f.by_skill(&json!({
        "idea-shape": {"assumptions": [{"text": "People work at night", "impact": "high", "cheapest_test": "Ask five users"}]},
        "idea-ask": {"answer": "Test Dark mode first.", "sources": [{"id": "IDEA_A"}], "actions": []},
        "idea-prepare-ticket": {"title": "Add a dark theme", "description": "Do it.", "acceptance_criteria": ["Toggle in settings"], "sub_tickets": []},
        "idea-digest": {"text": "Two ideas, one duplicate.", "items": [{"kind": "ready", "idea_ids": ["IDEA_A", "ghost"], "text": "Dark mode is ready."}]},
    }));
    let a = c
        .post(
            "/api/idea-tickets",
            json!({"project_id": pid, "title": "Dark mode", "description": "People ask for it."}),
        )
        .await;
    let b = c.post("/api/idea-tickets", json!({"project_id": pid, "title": "Night theme"})).await;
    let (a, b) = (http::id(&a.json()), http::id(&b.json()));
    rec.check("status", &c.get_query(&format!("{base}/status"), &[("project_id", &pid)]).await);
    rec.check("settings", &c.get_query(&format!("{base}/settings"), &[("project_id", &pid)]).await);
    rec.check("settings: none", &c.get(&format!("{base}/settings")).await);
    let put = |q: &str, body: Value| {
        let c = c.clone();
        let url = format!("{base}/settings{q}");
        async move { c.put(&url, body).await }
    };
    rec.check(
        "settings: put",
        &put(&format!("?project_id={pid}"), json!({"triage_advice": false, "daily_cap": 2.5, "read_docs": false}))
            .await,
    );
    rec.check("settings: put, cap 0", &put(&format!("?project_id={pid}"), json!({"daily_cap": 0})).await);
    rec.check("settings: put, cap 1001", &put(&format!("?project_id={pid}"), json!({"daily_cap": 1001})).await);
    rec.check("settings: put, wrong type", &put(&format!("?project_id={pid}"), json!({"enabled": "maybe"})).await);
    rec.check("settings: put, nothing", &put(&format!("?project_id={pid}"), json!({})).await);
    rec.check("settings: put, no project", &put("", json!({"ask": false})).await);
    rec.check(
        "settings: put, another person",
        &c.clone()
            .header("x-actor", "Someone")
            .put(&format!("{base}/settings?project_id={pid}"), json!({"ask": false}))
            .await,
    );
    rec.check(
        "settings: put, back on",
        &put(&format!("?project_id={pid}"), json!({"triage_advice": true, "enabled": true})).await,
    );
    // advice
    f.record();
    f.answer_json(&json!({"action": "merge", "reason": "Same as Dark mode.", "confidence": "high", "target_id": a}));
    let adv = c.post(&format!("{base}/advice"), json!({"idea_ids": [b, "nope"]})).await;
    rec.check("advice", &adv);
    let advice_id = adv.json()["advice"][0]["id"].as_str().expect("advice").to_string();
    rec.check("advice: none", &c.post(&format!("{base}/advice"), json!({"idea_ids": []})).await);
    rec.check("advice: 31", &c.post(&format!("{base}/advice"), json!({"idea_ids": vec!["x"; 31]})).await);
    rec.check("advice: no body", &c.post(&format!("{base}/advice"), json!({})).await);
    f.answer_json(&json!({"action": "none", "reason": "Not sure.", "confidence": "low"}));
    rec.check("advice: unsure", &c.post(&format!("{base}/advice"), json!({"idea_ids": [a]})).await);
    f.answer_json(&json!("not an object"));
    rec.check("advice: unusable answer", &c.post(&format!("{base}/advice"), json!({"idea_ids": [a]})).await);
    rec.check("advice: get", &c.get_query(&format!("{base}/advice"), &[("idea_ids", &a), ("idea_ids", &b)]).await);
    rec.check(
        "advice: get, with none",
        &c.get_query(&format!("{base}/advice"), &[("idea_ids", &a), ("idea_ids", &b), ("include_none", "yes")]).await,
    );
    rec.check(
        "advice: get, bad flag",
        &c.get_query(&format!("{base}/advice"), &[("idea_ids", &a), ("include_none", "maybe")]).await,
    );
    rec.check("advice: get, no ids", &c.get(&format!("{base}/advice")).await);
    rec.check(
        "advice: state",
        &c.post(&format!("{base}/advice/{advice_id}/state"), json!({"state": "accepted"})).await,
    );
    rec.check(
        "advice: state, bad",
        &c.post(&format!("{base}/advice/{advice_id}/state"), json!({"state": "moon"})).await,
    );
    rec.check("advice: state, none", &c.post(&format!("{base}/advice/nope/state"), json!({"state": "ignored"})).await);
    rec.check("advice: state, no body", &c.post(&format!("{base}/advice/{advice_id}/state"), json!({})).await);
    // shape, ask, prepare, digest
    rec.check(
        "shape",
        &c.post(&format!("{base}/shape"), json!({"idea_id": a, "kind": "assumptions", "request_id": "req-12345678"}))
            .await,
    );
    rec.check(
        "shape: ask without a question",
        &c.post(&format!("{base}/shape"), json!({"idea_id": a, "kind": "ask"})).await,
    );
    rec.check("shape: no idea", &c.post(&format!("{base}/shape"), json!({"idea_id": "nope", "kind": "problem"})).await);
    rec.check("shape: bad kind", &c.post(&format!("{base}/shape"), json!({"idea_id": a, "kind": "moon"})).await);
    rec.check(
        "shape: short request id",
        &c.post(&format!("{base}/shape"), json!({"idea_id": a, "kind": "problem", "request_id": "short"})).await,
    );
    rec.check(
        "shape: long question",
        &c.post(&format!("{base}/shape"), json!({"idea_id": a, "kind": "ask", "question": "x".repeat(1001)})).await,
    );
    rec.check("shape/stop", &c.post_empty(&format!("{base}/shape/req-12345678/stop")).await);
    rec.check(
        "ask",
        &c.post(&format!("{base}/ask"), json!({"question": "What should we test next?", "project_id": pid})).await,
    );
    rec.check("ask: everywhere", &c.post(&format!("{base}/ask"), json!({"question": "Anything?"})).await);
    rec.check("ask: none", &c.post(&format!("{base}/ask"), json!({"question": "Nothing?", "scope": "none"})).await);
    rec.check("ask: empty", &c.post(&format!("{base}/ask"), json!({"question": ""})).await);
    rec.check("ask: long", &c.post(&format!("{base}/ask"), json!({"question": "x".repeat(1001)})).await);
    rec.check("ask: bad scope", &c.post(&format!("{base}/ask"), json!({"question": "x", "scope": "moon"})).await);
    rec.check("prepare-ticket", &c.post(&format!("{base}/prepare-ticket"), json!({"idea_id": a})).await);
    rec.check("prepare-ticket: none", &c.post(&format!("{base}/prepare-ticket"), json!({"idea_id": "nope"})).await);
    rec.check("prepare-ticket: no body", &c.post(&format!("{base}/prepare-ticket"), json!({})).await);
    rec.check("digest: none", &c.get_query(&format!("{base}/digest"), &[("project_id", &pid)]).await);
    rec.check("digest/run", &c.post(&format!("{base}/digest/run"), json!({"project_id": pid})).await);
    rec.check("digest", &c.get_query(&format!("{base}/digest"), &[("project_id", &pid)]).await);
    rec.check("digest/run: everywhere", &c.post(&format!("{base}/digest/run"), json!({})).await);
    rec.check("digest: another project", &c.get_query(&format!("{base}/digest"), &[("project_id", "nope")]).await);
    rec.check("status: after", &c.get_query(&format!("{base}/status"), &[("project_id", &pid)]).await);
    // a person who is not a member
    let stranger = c.clone().header("x-actor", "Stranger");
    rec.check("advice: not a member", &stranger.post(&format!("{base}/advice"), json!({"idea_ids": [a]})).await);
    rec.check(
        "ask: not a member",
        &stranger.post(&format!("{base}/ask"), json!({"question": "x", "project_id": pid})).await,
    );
    rec.check(
        "shape: not a member",
        &stranger.post(&format!("{base}/shape"), json!({"idea_id": a, "kind": "problem"})).await,
    );
    rec.check(
        "prepare-ticket: not a member",
        &stranger.post(&format!("{base}/prepare-ticket"), json!({"idea_id": a})).await,
    );
    rec.check(
        "digest/run: not a member",
        &stranger.post(&format!("{base}/digest/run"), json!({"project_id": pid})).await,
    );
    // off
    c.put(&format!("{base}/settings?project_id={pid}"), json!({"enabled": false})).await;
    rec.check("off: advice", &c.post(&format!("{base}/advice"), json!({"idea_ids": [a]})).await);
    rec.check("off: shape", &c.post(&format!("{base}/shape"), json!({"idea_id": a, "kind": "problem"})).await);
    rec.check("off: prepare-ticket", &c.post(&format!("{base}/prepare-ticket"), json!({"idea_id": a})).await);
    rec.check("off: digest/run", &c.post(&format!("{base}/digest/run"), json!({"project_id": pid})).await);
    rec.finish();
}
