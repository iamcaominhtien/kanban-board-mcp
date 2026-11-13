//! A differential check of every route of `api/idea_tickets.py` and `api/idea_space.py`: the same request script
//! runs against the Python server (which wrote `contract/golden/idea_routes.json`) and the Rust server, and the
//! status and the answer of each request are compared, ids and times normalized: the success case and every error
//! branch of each route, then the overlaps of the two routers (a fixed path next to `/{ticket_id}`).
//!
//! Regenerate the golden file with `KANBAN_WRITE_GOLDEN=1 PARITY_TARGET=python cargo test -p kb-ideas --test
//! idea_routes_differential`.

mod common;

use common::record::Script;
use common::{API, id};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

const FUTURE: &str = "2999-01-01";

/// The two tests start a server each; one at a time (two Python servers at once on this machine drop connections).
static ONE_SERVER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn project(c: &Client, r: &mut Script, name: &str, prefix: &str) -> String {
    let resp = r.post(c, "/projects", json!({"name": name, "prefix": prefix, "color": "#123456"})).await;
    id(&resp.json())
}

async fn idea(c: &Client, r: &mut Script, body: Value) -> String {
    let resp = r.post(c, API, body).await;
    id(&resp.json())
}

async fn assumption(c: &Client, r: &mut Script, idea_id: &str, text: &str, impact: &str) -> String {
    let resp = r.post(c, &format!("{API}/{idea_id}/assumption-records"), json!({"text": text, "impact": impact})).await;
    resp.json()["assumptions"].as_array().and_then(|a| a.last()).map(id).unwrap_or_default()
}

#[tokio::test]
async fn every_route_of_the_idea_space_answers_the_same() {
    if !skip_unless_available("every_route_of_the_idea_space_answers_the_same") {
        return;
    }
    let _one = ONE_SERVER.lock().await;
    let s = Server::start().await;
    let c = s.client();
    let mut r = Script::default();
    let p1 = project(&c, &mut r, "Alpha", "DIA").await;
    let p2 = project(&c, &mut r, "Beta", "DIB").await;
    r.post(&c, &format!("/projects/{p1}/members"), json!({"name": "Vera", "role": "viewer"})).await;
    r.post(&c, &format!("/projects/{p1}/members"), json!({"name": "Mia", "role": "member"})).await;

    // ── POST /api/idea-tickets, GET /api/idea-tickets ──────────────────────────────────────────────────────────
    let i1 = idea(
        &c,
        &mut r,
        json!({
            "project_id": p1, "title": "Show cost on every AI run card", "description": "People ask what a run costs",
            "idea_color": "blue", "idea_emoji": "🚀", "idea_energy": "hot", "tags": ["ai", "cost", 3],
            "problem_statement": "  The cost is hidden  ", "source": "doc",
            "source_ref": {"kind": "doc", "id": "D1", "quote": "what does it cost?"},
        }),
    )
    .await;
    let i2 = idea(&c, &mut r, json!({"project_id": p1, "title": "Dark mode for Docs"})).await;
    let i3 = idea(&c, &mut r, json!({"title": "Loose note", "description": "x"})).await;
    let i4 = idea(&c, &mut r, json!({"project_id": p2, "title": "Beta idea", "source": "ai"})).await;
    for body in [
        json!({"project_id": p1, "title": "x", "idea_emoji": "   "}),
        json!({"project_id": p1, "title": "x", "idea_emoji": "123456789"}),
        json!({"project_id": "nope", "title": "x"}),
        json!({"project_id": p1, "title": "x", "idea_color": "red"}),
        json!({"project_id": p1}),
        json!({"project_id": p1, "title": "x", "source": "telepathy"}),
        json!({"project_id": p1, "title": "x", "idea_energy": "warm"}),
        json!({"project_id": p1, "title": "x", "tags": null}),
        json!({"project_id": p1, "title": "x", "source_ref": []}),
        json!({"project_id": p1, "title": 5}),
    ] {
        r.post(&c, API, body).await;
    }
    r.call(&c, "POST", API, None).await;
    r.get(&c, &format!("{API}?project_id={p1}")).await;
    r.get(&c, &format!("{API}?project_id={p1}&idea_status=draft")).await;
    r.get(&c, &format!("{API}?project_id={p1}&idea_status=approved")).await;
    r.get(&c, &format!("{API}?project_id={p1}&q=DARK")).await;
    r.get(&c, &format!("{API}?project_id={p1}&q=%25")).await;
    r.get(&c, &format!("{API}?project_id={p1}&q=a_b")).await;
    r.get(&c, &format!("{API}?project_id={p1}&q=hidden")).await;
    r.get(&c, &format!("{API}?project_id=nope")).await;
    r.get(&c, API).await;

    // ── GET / PATCH / DELETE /api/idea-tickets/{id} ────────────────────────────────────────────────────────────
    r.get(&c, &format!("{API}/{i1}")).await;
    r.get(&c, &format!("{API}/IDEA-999")).await;
    r.patch(
        &c,
        &format!("{API}/{i2}"),
        json!({"title": "Dark mode", "description": "d", "tags": ["x"], "ice_impact": 5}),
    )
    .await;
    r.patch(
        &c,
        &format!("{API}/{i2}"),
        json!({"idea_energy": "seed", "problem_statement": "P", "revisit_date": "2026-05-01"}),
    )
    .await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"title": "Dark mode"})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"idea_emoji": null, "idea_energy": null})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"idea_emoji": ""})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"idea_emoji": "abcdefghi"})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"idea_emoji": "🎯"})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"idea_color": "red"})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"idea_color": "pink"})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"ice_impact": 9})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"ice_effort": 0})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"ice_confidence": 1, "ice_effort": 3})).await;
    r.patch(&c, &format!("{API}/{i2}"), json!({"title": ["x"]})).await;
    r.patch(&c, "/api/idea-tickets/IDEA-999", json!({"title": "x"})).await;
    r.get(&c, &format!("{API}/{i2}")).await;

    // ── the legacy status, assumptions and microthoughts ───────────────────────────────────────────────────────
    let i5 = idea(&c, &mut r, json!({"project_id": p1, "title": "Legacy"})).await;
    for (status, reason) in [
        ("approved", None),
        ("bogus", None),
        ("in_review", Some("looks fine")),
        ("approved", None),
        ("draft", None),
        ("dropped", Some("no")),
        ("draft", None),
    ] {
        let mut body = json!({"new_status": status});
        if let Some(reason) = reason {
            body["reason"] = json!(reason);
        }
        r.patch(&c, &format!("{API}/{i5}/status"), body).await;
    }
    r.patch(&c, &format!("{API}/{i5}/status"), json!({"new_status": "dropped", "reason": "x".repeat(501)})).await;
    r.patch(&c, &format!("{API}/{i5}/status"), json!({})).await;
    r.patch(&c, "/api/idea-tickets/IDEA-999/status", json!({"new_status": "dropped"})).await;
    let a1 = r.post(&c, &format!("{API}/{i5}/assumptions"), json!({"text": "  Users want reminders  "})).await;
    let a1 = a1.json()["assumptions"][0]["id"].as_str().expect("id").to_string();
    r.post(&c, &format!("{API}/{i5}/assumptions"), json!({"text": "Second", "impact": "high"})).await;
    r.post(&c, &format!("{API}/{i5}/assumptions"), json!({"text": "   "})).await;
    r.post(&c, &format!("{API}/{i5}/assumptions"), json!({"text": "x".repeat(501)})).await;
    r.post(&c, &format!("{API}/{i5}/assumptions"), json!({"text": "x", "impact": "huge"})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/assumptions", json!({"text": "x"})).await;
    for status in ["validated", "invalidated", "testing", "untested", "maybe"] {
        r.patch(&c, &format!("{API}/{i5}/assumptions/{a1}"), json!({"status": status})).await;
    }
    r.patch(&c, &format!("{API}/{i5}/assumptions/nope"), json!({"status": "testing"})).await;
    r.patch(&c, &format!("{API}/IDEA-999/assumptions/{a1}"), json!({"status": "testing"})).await;
    let m1 = r.post(&c, &format!("{API}/{i5}/microthoughts"), json!({"text": " a thought "})).await;
    let m1 = m1.json()["microthoughts"][0]["id"].as_str().expect("id").to_string();
    r.post(&c, &format!("{API}/{i5}/microthoughts"), json!({"text": ""})).await;
    r.post(&c, &format!("{API}/{i5}/microthoughts"), json!({"text": "x".repeat(501)})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/microthoughts", json!({"text": "x"})).await;
    r.delete(&c, &format!("{API}/{i5}/microthoughts/{m1}")).await;
    r.delete(&c, &format!("{API}/{i5}/microthoughts/{m1}")).await;
    r.delete(&c, &format!("{API}/{i5}/assumptions/{a1}")).await;
    r.delete(&c, &format!("{API}/{i5}/assumptions/{a1}")).await;
    r.delete(&c, &format!("{API}/IDEA-999/assumptions/{a1}")).await;
    r.delete(&c, &format!("{API}/{i5}")).await;
    r.delete(&c, &format!("{API}/{i5}")).await;

    // ── listing, counts, search ────────────────────────────────────────────────────────────────────────────────
    let a2 = assumption(&c, &mut r, &i1, "Cost fits on the card", "low").await;
    let a3 = assumption(&c, &mut r, &i1, "Price table stays current", "high").await;
    r.patch(&c, &format!("{API}/{i1}/assumption-records/{a2}"), json!({"status": "validated"})).await;
    r.post(&c, &format!("{API}/{i1}/vote"), json!({"voter": "Lan"})).await;
    r.post(&c, &format!("{API}/{i1}/vote"), json!({"voter": "Hoa"})).await;
    r.post(&c, &format!("{API}/{i1}/stage"), json!({"to": "exploring"})).await;
    for query in [
        format!("project_id={p1}"),
        "scope=all".to_string(),
        "scope=none".to_string(),
        format!("scope=project&project_id={p2}"),
        "scope=project".to_string(),
        "scope=nope".to_string(),
        "scope=all&stage=exploring".to_string(),
        "scope=all&stage=exploring&stage=inbox".to_string(),
        "scope=all&stage=bogus".to_string(),
        "scope=all&active=true".to_string(),
        "scope=all&active=maybe".to_string(),
        "scope=all&source=ai".to_string(),
        "scope=all&source=bogus".to_string(),
        "scope=all&tag=ai".to_string(),
        "scope=all&q=dark+mode".to_string(),
        "scope=all&q=%20".to_string(),
        "scope=all&q=price+table".to_string(),
        "scope=all&sort=votes".to_string(),
        "scope=all&sort=title".to_string(),
        "scope=all&sort=updated".to_string(),
        "scope=all&sort=created".to_string(),
        "scope=all&sort=readiness".to_string(),
        "scope=all&sort=nope".to_string(),
        String::new(),
    ] {
        r.get(&c, &format!("{API}/space?{query}")).await;
    }
    r.get(&c, &format!("{API}/counts")).await;
    for query in [
        format!("project_id={p1}"),
        "scope=all".to_string(),
        "scope=none".to_string(),
        "scope=nope".to_string(),
        String::new(),
    ] {
        r.get(&c, &format!("{API}/sorted-this-week?{query}")).await;
    }
    r.call_as(&c, Some("Mia"), "GET", &format!("{API}/sorted-this-week?scope=all"), None).await;
    for query in [
        "text=Show+cost+on+the+AI+run+card".to_string(),
        format!("text=Show+cost+on+the+AI+run+card&project_id={p1}&kinds=idea"),
        "text=Show+cost+on+the+AI+run+card&kinds=idea&kinds=ticket&limit=1".to_string(),
        format!("text=cost+card&exclude={i1}"),
        "text=the+and+of".to_string(),
        "text=cost&limit=0".to_string(),
        "text=cost&limit=21".to_string(),
        "text=cost&limit=x".to_string(),
        "text=cost&kinds=bogus".to_string(),
        String::new(),
    ] {
        r.get(&c, &format!("{API}/similar?{query}")).await;
    }
    r.get(&c, &format!("{API}/tag-suggestions?text=AI+run+card+cost")).await;
    r.get(&c, &format!("{API}/tag-suggestions?text=cost&exclude={i1}")).await;
    r.get(&c, &format!("{API}/tag-suggestions")).await;

    // ── stage, undo, park-many ─────────────────────────────────────────────────────────────────────────────────
    let stage = |to: &str, extra: Value| {
        let mut body = json!({"to": to});
        for (k, v) in extra.as_object().expect("object") {
            body[k] = v.clone();
        }
        body
    };
    let i6 = idea(&c, &mut r, json!({"project_id": p1, "title": "Stages"})).await;
    let st = format!("{API}/{i6}/stage");
    for body in [
        stage("bogus", json!({})),
        stage("inbox", json!({})),
        stage("building", json!({})),
        stage("shipped", json!({})),
        stage("ready", json!({})),
        stage("parked", json!({})),
        stage("parked", json!({"park_until": "2020-01-01"})),
        stage("parked", json!({"park_until": "not a date"})),
        stage("parked", json!({"park_until": "20990101"})),
        stage("parked", json!({"park_until": "2999-W01-1"})),
        stage("parked", json!({"park_until": FUTURE, "park_note": "later", "via": "Park"})),
        stage("parked", json!({"park_until": "x".repeat(501)})),
        stage("archived", json!({})),
        stage("archived", json!({"archive_reason": "bored"})),
        stage("archived", json!({"archive_reason": "too_big", "archive_note": "n".repeat(501)})),
        stage("archived", json!({"archive_reason": "too_big", "archive_note": "big"})),
        stage("exploring", json!({"via": "v".repeat(41)})),
        stage("exploring", json!({"via": "Restore", "project_id": p2, "tags": ["a", "b"]})),
        stage("exploring", json!({"project_id": "nope"})),
        stage("exploring", json!({"tags": [1]})),
        stage("ready", json!({})),
        stage("ready", json!({"force": true})),
        json!({}),
        json!({"to": "exploring", "park_note": "x".repeat(501)}),
    ] {
        r.post(&c, &st, body).await;
    }
    r.post(&c, &format!("{API}/{i6}/undo"), json!({})).await;
    r.call(&c, "POST", &format!("{API}/{i6}/undo"), None).await;
    r.post(&c, &format!("{API}/{i6}/undo"), json!({})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/stage", json!({"to": "exploring"})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/undo", json!({})).await;
    let pm = vec![
        idea(&c, &mut r, json!({"project_id": p1, "title": "P1"})).await,
        idea(&c, &mut r, json!({"project_id": p1, "title": "P2"})).await,
    ];
    r.post(&c, &format!("{API}/park-many"), json!({"ids": pm, "park_until": FUTURE, "park_note": "month"})).await;
    r.post(&c, &format!("{API}/park-many"), json!({"ids": pm, "park_until": FUTURE})).await;
    r.post(&c, &format!("{API}/park-many"), json!({"ids": [pm[0], "IDEA-999"], "park_until": FUTURE})).await;
    r.post(&c, &format!("{API}/park-many"), json!({"ids": [], "park_until": FUTURE})).await;
    r.post(&c, &format!("{API}/park-many"), json!({"ids": pm, "park_until": "2020-01-01"})).await;
    r.post(&c, &format!("{API}/park-many"), json!({"ids": pm})).await;
    r.post(
        &c,
        &format!("{API}/park-many"),
        json!({"ids": (0..201).map(|n| format!("I{n}")).collect::<Vec<_>>(), "park_until": FUTURE}),
    )
    .await;

    // ── merge, undo-merge, votes, outcome ──────────────────────────────────────────────────────────────────────
    let src = idea(&c, &mut r, json!({"project_id": p1, "title": "Cost in members", "description": "S text", "source": "doc", "source_ref": {"quote": "q"}})).await;
    let tgt = idea(&c, &mut r, json!({"project_id": p1, "title": "Cost on card", "description": "T"})).await;
    r.post(&c, &format!("{API}/{src}/vote"), json!({"voter": "Lan"})).await;
    r.post(&c, &format!("{API}/{tgt}/vote"), json!({"voter": "Tuan"})).await;
    r.post(&c, &format!("{API}/{src}/merge"), json!({"into_id": src})).await;
    r.post(&c, &format!("{API}/{src}/merge"), json!({"into_id": "IDEA-999"})).await;
    r.post(&c, &format!("{API}/IDEA-999/merge"), json!({"into_id": tgt})).await;
    r.post(&c, &format!("{API}/{src}/merge"), json!({})).await;
    r.post(&c, &format!("{API}/{src}/merge"), json!({"into_id": tgt})).await;
    r.get(&c, &format!("{API}/{src}")).await;
    r.post(&c, &format!("{API}/{src}/merge"), json!({"into_id": tgt})).await;
    r.post(&c, &format!("{API}/{tgt}/undo-merge"), json!({})).await;
    r.post(&c, &format!("{API}/{tgt}/undo-merge"), json!({})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/undo-merge", json!({})).await;
    r.get(&c, &format!("{API}/{src}")).await;
    r.post(&c, &format!("{API}/{src}/vote"), json!({})).await;
    r.post(&c, &format!("{API}/{src}/vote"), json!({"voter": "  "})).await;
    r.post(&c, &format!("{API}/{src}/vote"), json!({"voter": " Lan ", "on": false})).await;
    r.post(&c, &format!("{API}/{src}/vote"), json!({"voter": "Lan", "on": false})).await;
    r.call_as(&c, Some("Vera"), "POST", &format!("{API}/{src}/vote"), Some(json!({}))).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/vote", json!({})).await;
    r.post(&c, &format!("{API}/{src}/vote"), json!({"on": "maybe"})).await;
    r.post(&c, &format!("{API}/{src}/outcome"), json!({"outcome": "worked", "note": "yes"})).await;
    r.post(&c, &format!("{API}/{src}/outcome"), json!({"outcome": "bogus"})).await;
    r.post(&c, &format!("{API}/{src}/outcome"), json!({"outcome": "no", "note": "n".repeat(1001)})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/outcome", json!({"outcome": "no"})).await;

    // ── page, project ──────────────────────────────────────────────────────────────────────────────────────────
    let pg = format!("{API}/{tgt}/page");
    for body in [
        json!({"body": "new text", "ai": true}),
        json!({"body": "new text"}),
        json!({"details": "some details", "owner": "Mia", "effort_guess": "2d", "title": "  Renamed  ", "tags": ["z"]}),
        json!({"owner": null, "effort_guess": null}),
        json!({"owner": ""}),
        json!({"workspace_retention": "forever"}),
        json!({"workspace_retention": "bogus"}),
        json!({"title": "   "}),
        json!({"title": "t".repeat(201)}),
        json!({"body": "b".repeat(200_001)}),
        json!({"details": "d".repeat(20_001)}),
        json!({"tags": [1]}),
        json!({}),
    ] {
        r.patch(&c, &pg, body).await;
    }
    r.patch(&c, "/api/idea-tickets/IDEA-999/page", json!({"body": "x"})).await;
    r.put(&c, &format!("{API}/{tgt}/project"), json!({"project_id": p2})).await;
    r.put(&c, &format!("{API}/{tgt}/project"), json!({"project_id": p2})).await;
    r.put(&c, &format!("{API}/{tgt}/project"), json!({"project_id": null})).await;
    r.put(&c, &format!("{API}/{tgt}/project"), json!({})).await;
    r.put(&c, &format!("{API}/{tgt}/project"), json!({"project_id": "nope"})).await;
    r.put(&c, &format!("{API}/{tgt}/project"), json!({"project_id": p1})).await;
    r.put(&c, "/api/idea-tickets/IDEA-999/project", json!({"project_id": p1})).await;

    // ── assumption records, test tickets, resolve ──────────────────────────────────────────────────────────────
    let i7 = idea(&c, &mut r, json!({"project_id": p1, "title": "Assumptions"})).await;
    let ar = format!("{API}/{i7}/assumption-records");
    r.post(&c, &ar, json!({"text": "  They pay  ", "impact": "high", "ai": true})).await;
    r.post(&c, &ar, json!({"text": ""})).await;
    r.post(&c, &ar, json!({"text": "x".repeat(501)})).await;
    r.post(&c, &ar, json!({"text": "x", "impact": "huge"})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/assumption-records", json!({"text": "x"})).await;
    let b1 = assumption(&c, &mut r, &i7, "They stay", "medium").await;
    let first =
        r.get(&c, &format!("{API}/{i7}")).await.json()["assumptions"][0]["id"].as_str().expect("id").to_string();
    let one = format!("{ar}/{first}");
    for body in [
        json!({"text": "They pay monthly", "impact": "low"}),
        json!({"status": "testing"}),
        json!({"status": "disproved"}),
        json!({"status": "bogus"}),
        json!({"text": null}),
        json!({"impact": null}),
        json!({"status": null}),
        json!({"test_ticket_id": "NOPE-1"}),
        json!({"test_ticket_id": null}),
        json!({"text": "   "}),
        json!({"text": "x".repeat(501)}),
        json!({"impact": "huge"}),
        json!({}),
    ] {
        r.patch(&c, &one, body).await;
    }
    r.patch(&c, &format!("{ar}/nope"), json!({"text": "x"})).await;
    r.patch(&c, "/api/idea-tickets/IDEA-999/assumption-records/x", json!({"text": "x"})).await;
    let tt = r.post(&c, &format!("{ar}/{b1}/test-ticket"), json!({"title": "Ask 3 members", "assignee": null})).await;
    let tt_id = id(&tt.json()["ticket"]);
    r.post(&c, &format!("{ar}/{b1}/test-ticket"), json!({})).await;
    r.post(&c, &format!("{ar}/{first}/test-ticket"), json!({"title": "t".repeat(201)})).await;
    r.post(&c, &format!("{ar}/{first}/test-ticket"), json!({"assignee": "nobody"})).await;
    r.post(&c, &format!("{ar}/nope/test-ticket"), json!({})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/assumption-records/x/test-ticket", json!({})).await;
    r.post(&c, &format!("{API}/{i3}/assumption-records/x/test-ticket"), json!({})).await;
    r.get(&c, &format!("{API}/by-ticket/{tt_id}")).await;
    r.get(&c, &format!("{API}/by-ticket/NOPE-1")).await;
    r.patch(&c, &format!("{ar}/{b1}"), json!({"test_ticket_id": "NOPE-1"})).await;
    for outcome in ["unsure", "validated", "disproved", "bogus"] {
        r.post(&c, &format!("{ar}/{b1}/resolve"), json!({"outcome": outcome})).await;
    }
    r.post(&c, &format!("{ar}/nope/resolve"), json!({"outcome": "unsure"})).await;
    r.post(&c, &format!("{ar}/nope/resolve"), json!({"outcome": "validated"})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/assumption-records/x/resolve", json!({"outcome": "unsure"})).await;

    // ── evidence ───────────────────────────────────────────────────────────────────────────────────────────────
    let ev = format!("{API}/{i7}/evidence");
    r.post(&c, &ev, json!({"assumption_ids": [first, b1], "kind": "link", "ref": " https://example.com/x ", "title": " Pricing page "})).await;
    r.post(&c, &ev, json!({"assumption_ids": [first], "kind": "sketch", "ref": "![Run card](sketch:abc)"})).await;
    r.post(&c, &ev, json!({"assumption_ids": [first], "kind": "file", "ref": "/uploads/a.png", "title": "a.png"}))
        .await;
    r.post(&c, &ev, json!({"assumption_ids": [], "kind": "link", "ref": "x"})).await;
    r.post(&c, &ev, json!({"assumption_ids": ["nope"], "kind": "link", "ref": "x"})).await;
    r.post(&c, &ev, json!({"assumption_ids": [first], "kind": "bogus", "ref": "x"})).await;
    r.post(&c, &ev, json!({"assumption_ids": [first], "kind": "note", "ref": ""})).await;
    r.post(&c, &ev, json!({"assumption_ids": [first], "kind": "note", "ref": "x".repeat(4001)})).await;
    r.post(&c, &ev, json!({"assumption_ids": [first], "kind": "note", "ref": "x", "title": "t".repeat(301)})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/evidence", json!({"assumption_ids": ["x"], "kind": "note", "ref": "x"}))
        .await;
    let listed = r.get(&c, &ev).await.json();
    r.get(&c, "/api/idea-tickets/IDEA-999/evidence").await;
    let eid = listed[0]["ids"][0].as_str().expect("id").to_string();
    r.delete(&c, &format!("{ev}/{eid}")).await;
    r.delete(&c, &format!("{ev}/{eid}")).await;
    r.delete(&c, &format!("{API}/IDEA-999/evidence/{eid}")).await;

    // ── comments and the research log ──────────────────────────────────────────────────────────────────────────
    let cm = format!("{API}/{i7}/comments");
    let c1 = r.post(&c, &cm, json!({"body": "  hello  "})).await.json();
    r.post(&c, &cm, json!({"body": ""})).await;
    r.post(&c, &cm, json!({"body": "b".repeat(20_001)})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/comments", json!({"body": "x"})).await;
    r.call_as(&c, Some("Vera"), "POST", &cm, Some(json!({"body": "from a viewer"}))).await;
    r.get(&c, &cm).await;
    r.get(&c, "/api/idea-tickets/IDEA-999/comments").await;
    r.patch(&c, &format!("{cm}/{}", id(&c1)), json!({"body": " hi "})).await;
    r.patch(&c, &format!("{cm}/{}", id(&c1)), json!({"body": ""})).await;
    r.patch(&c, &format!("{cm}/nope"), json!({"body": "x"})).await;
    r.patch(&c, &format!("{API}/{i6}/comments/{}", id(&c1)), json!({"body": "x"})).await;
    r.delete(&c, &format!("{cm}/{}", id(&c1))).await;
    r.delete(&c, &format!("{cm}/{}", id(&c1))).await;
    let lg = format!("{API}/{i7}/log");
    let e1 = r.post(&c, &lg, json!({"kind": "finding", "body": " 5 of 8 checked ", "assumption_id": first, "attachments": [{"name": "a", "url": "/u/a"}], "ticket_id": "T-1", "ai": true})).await.json();
    r.post(&c, &lg, json!({"body": "later"})).await;
    r.post(&c, &lg, json!({"kind": "gossip", "body": "x"})).await;
    r.post(&c, &lg, json!({"body": ""})).await;
    r.post(&c, &lg, json!({"body": "x", "assumption_id": "nope"})).await;
    r.post(&c, &lg, json!({"body": "x", "attachments": [{"name": 1}]})).await;
    r.post(&c, &lg, json!({"body": "x", "attachments": (0..21).map(|_| json!({})).collect::<Vec<_>>()})).await;
    r.post(&c, "/api/idea-tickets/IDEA-999/log", json!({"body": "x"})).await;
    r.get(&c, &lg).await;
    r.get(&c, "/api/idea-tickets/IDEA-999/log").await;
    r.patch(&c, &format!("{lg}/"), json!({"pinned": true})).await;
    r.patch(&c, &format!("{lg}/{}", id(&e1)), json!({"pinned": true, "kind": "decision", "body": " decided "})).await;
    r.patch(&c, &format!("{lg}/{}", id(&e1)), json!({"kind": "bogus"})).await;
    r.patch(&c, &format!("{lg}/{}", id(&e1)), json!({"body": ""})).await;
    r.patch(&c, &format!("{lg}/{}", id(&e1)), json!({})).await;
    r.patch(&c, &format!("{lg}/nope"), json!({"pinned": true})).await;
    r.get(&c, &lg).await;
    r.post(&c, &format!("{lg}/{}/evidence", id(&e1)), json!({"assumption_id": b1})).await;
    r.post(&c, &format!("{lg}/{}/evidence", id(&e1)), json!({"assumption_id": "nope"})).await;
    r.post(&c, &format!("{lg}/nope/evidence"), json!({"assumption_id": b1})).await;
    r.delete(&c, &format!("{lg}/{}", id(&e1))).await;
    r.delete(&c, &format!("{lg}/{}", id(&e1))).await;
    r.delete(&c, &format!("{API}/IDEA-999/log/x")).await;

    // ── activity ───────────────────────────────────────────────────────────────────────────────────────────────
    for filter in [
        "",
        "?filter=stage",
        "?filter=assumptions",
        "?filter=evidence",
        "?filter=page",
        "?filter=ai",
        "?filter=links",
        "?filter=nope",
    ] {
        r.get(&c, &format!("{API}/{i7}/activity{filter}")).await;
    }
    r.get(&c, &format!("{API}/{src}/activity")).await;
    r.get(&c, "/api/idea-tickets/IDEA-999/activity").await;

    // ── promote ────────────────────────────────────────────────────────────────────────────────────────────────
    r.get(&c, &format!("{API}/{i1}/promote/preview")).await;
    r.get(&c, &format!("{API}/{i1}/promote/preview?project_id={p2}")).await;
    r.get(&c, &format!("{API}/{i3}/promote/preview")).await;
    r.get(&c, &format!("{API}/{i3}/promote/preview?project_id=nope")).await;
    r.get(&c, &format!("{API}/{i3}/promote/preview?project_id={p1}")).await;
    r.get(&c, "/api/idea-tickets/IDEA-999/promote/preview").await;
    let pr = format!("{API}/{i1}/promote");
    for body in [
        json!({}),
        json!({"title": "t".repeat(201), "acknowledge_not_ready": true}),
        json!({"type": "story", "acknowledge_not_ready": true}),
        json!({"priority": "urgent", "acknowledge_not_ready": true}),
        json!({"status": "done", "acknowledge_not_ready": true}),
        json!({"workspace": "teleport", "acknowledge_not_ready": true}),
        json!({"sub_tickets": (0..11).map(|n| format!("S{n}")).collect::<Vec<_>>(), "acknowledge_not_ready": true}),
        json!({"project_id": "nope", "acknowledge_not_ready": true}),
        json!({"acknowledge_not_ready": true, "sub_tickets": ["", "  "], "title": "Cost badge", "type": "bug", "priority": "high", "status": "todo", "description": "My own text", "workspace": "copy"}),
        json!({"acknowledge_not_ready": true}),
    ] {
        r.post(&c, &pr, body).await;
    }
    r.get(&c, &format!("{API}/{i1}/promote/preview")).await;
    r.post(&c, &format!("{API}/{i3}/promote"), json!({"acknowledge_not_ready": true})).await;
    r.post(
        &c,
        &format!("{API}/{i3}/promote"),
        json!({"project_id": p2, "acknowledge_not_ready": true, "sub_tickets": ["One", "Two"]}),
    )
    .await;
    r.post(&c, "/api/idea-tickets/IDEA-999/promote", json!({})).await;
    r.get(&c, &format!("{API}/{i1}")).await;
    r.get(&c, &format!("{API}/{i3}")).await;
    r.get(&c, &format!("{API}/space?scope=all&sort=created")).await;
    r.get(&c, &format!("{API}/counts")).await;
    r.get(&c, &format!("/projects/{p1}/tickets")).await;
    let _ = (i4, a3);

    // ── a viewer may read, vote and comment, nothing else ──────────────────────────────────────────────────────
    let i8 = idea(&c, &mut r, json!({"project_id": p1, "title": "For the viewer"})).await;
    let viewer = Some("Vera");
    for (method, path, body) in [
        ("POST", format!("{API}/{i8}/stage"), Some(json!({"to": "exploring"}))),
        ("POST", format!("{API}/{i8}/undo"), None),
        ("POST", format!("{API}/park-many"), Some(json!({"ids": [i8], "park_until": FUTURE}))),
        ("POST", format!("{API}/{i8}/merge"), Some(json!({"into_id": i2}))),
        ("POST", format!("{API}/{i8}/undo-merge"), None),
        ("POST", format!("{API}/{i8}/outcome"), Some(json!({"outcome": "no"}))),
        ("PATCH", format!("{API}/{i8}/page"), Some(json!({"body": "x"}))),
        ("PUT", format!("{API}/{i8}/project"), Some(json!({"project_id": null}))),
        ("POST", format!("{API}/{i8}/assumption-records"), Some(json!({"text": "x"}))),
        ("PATCH", format!("{API}/{i8}/assumption-records/x"), Some(json!({"text": "x"}))),
        ("POST", format!("{API}/{i8}/assumption-records/x/test-ticket"), Some(json!({}))),
        ("POST", format!("{API}/{i8}/assumption-records/x/resolve"), Some(json!({"outcome": "unsure"}))),
        ("POST", format!("{API}/{i8}/evidence"), Some(json!({"assumption_ids": ["x"], "kind": "note", "ref": "x"}))),
        ("DELETE", format!("{API}/{i8}/evidence/x"), None),
        ("POST", format!("{API}/{i8}/log"), Some(json!({"body": "x"}))),
        ("PATCH", format!("{API}/{i8}/log/x"), Some(json!({"pinned": true}))),
        ("DELETE", format!("{API}/{i8}/log/x"), None),
        ("POST", format!("{API}/{i8}/log/x/evidence"), Some(json!({"assumption_id": "x"}))),
        ("POST", format!("{API}/{i8}/promote"), Some(json!({}))),
        ("GET", format!("{API}/{i8}"), None),
        ("GET", format!("{API}/space?project_id={p1}"), None),
        ("POST", format!("{API}/{i8}/vote"), Some(json!({}))),
        ("POST", format!("{API}/IDEA-999/stage"), Some(json!({"to": "exploring"}))),
    ] {
        r.call_as(&c, viewer, method, &path, body).await;
    }

    r.check_dumping_the_log("routes", &s);
    s.stop().await;
}

/// Where the two routers overlap: a fixed path of the first next to `/{ticket_id}` of the second, and the words of
/// the fixed paths used as an idea id. FastAPI takes the first route that matches the path and the method; a route
/// that matches only the path answers 405 when nothing later matches fully.
#[tokio::test]
async fn the_two_routers_overlap_as_fastapi_has_them() {
    if !skip_unless_available("the_two_routers_overlap_as_fastapi_has_them") {
        return;
    }
    let _one = ONE_SERVER.lock().await;
    let s = Server::start().await;
    let c = s.client();
    let mut r = Script::default();
    let p1 = project(&c, &mut r, "Alpha", "DIA").await;
    let i1 = idea(&c, &mut r, json!({"project_id": p1, "title": "Overlap"})).await;
    let a = assumption(&c, &mut r, &i1, "x", "low").await;
    let words = [
        "space",
        "counts",
        "sorted-this-week",
        "similar",
        "tag-suggestions",
        "park-many",
        "by-ticket",
        "undo",
        "stage",
    ];
    for word in words {
        for method in ["GET", "POST", "PATCH", "PUT", "DELETE"] {
            let body = (method != "GET" && method != "DELETE").then(|| json!({"title": "x", "to": "exploring", "text": "x", "status": "testing", "new_status": "draft", "ids": [], "park_until": FUTURE}));
            r.call(&c, method, &format!("{API}/{word}"), body.clone()).await;
            for tail in [
                "stage",
                "undo",
                "vote",
                "evidence",
                "comments",
                "activity",
                "assumptions",
                "microthoughts",
                "status",
                "promote/preview",
                "x",
            ] {
                r.call(&c, method, &format!("{API}/{word}/{tail}"), body.clone()).await;
            }
            r.call(&c, method, &format!("{API}/{word}/assumptions/{a}"), body.clone()).await;
            r.call(&c, method, &format!("{API}/{word}/microthoughts/{a}"), body.clone()).await;
        }
    }
    // the same methods on the paths of one idea, where each router has its own
    for method in ["GET", "POST", "PATCH", "PUT", "DELETE"] {
        let body = (method != "GET" && method != "DELETE")
            .then(|| json!({"text": "x", "status": "testing", "new_status": "draft"}));
        for path in [
            API.to_string(),
            format!("{API}/{i1}"),
            format!("{API}/{i1}/assumptions"),
            format!("{API}/{i1}/assumptions/{a}"),
            format!("{API}/{i1}/assumption-records"),
            format!("{API}/{i1}/assumption-records/{a}"),
            format!("{API}/{i1}/status"),
            format!("{API}/{i1}/microthoughts"),
            format!("{API}/{i1}/page"),
            format!("{API}/{i1}/project"),
            format!("{API}/{i1}/nope"),
            format!("{API}/{i1}/a/b/c"),
            format!("{API}/by-ticket/{i1}"),
            format!("{API}/"),
        ] {
            r.call(&c, method, &path, body.clone()).await;
        }
    }
    r.check_dumping_the_log("overlaps", &s);
    s.stop().await;
}
