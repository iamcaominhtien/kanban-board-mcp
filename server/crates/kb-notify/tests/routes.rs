//! Every route of `api/notifications.py` through the real server: status and exact JSON for the success case and
//! for each error branch. The routes of other areas (projects, members, tickets) are not used; rows are written
//! into the server's SQLite file in the stored formats. Run with `PARITY_TARGET=python` first, then `rust`.

mod common;

use common::{Event, Nrow, at, ids, member, pool, project, table};
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

const FILTER_MESSAGE: &str = "filter must be one of all, unread, needs, snoozed, done, cleared";

fn settings_events(overrides: &[(&str, Value)]) -> Value {
    let table: Vec<(&str, &str, bool, bool)> = vec![
        ("question", "A question from an AI", true, true),
        ("run_failed", "A run failed or timed out", true, true),
        ("account_signed_out", "An AI account signed out", true, true),
        ("mention", "Someone mentioned you", true, true),
        ("run_stopped_memory", "A run was stopped for memory", true, true),
        ("budget", "Budget or cap reached", true, true),
        ("auto_trip", "AI was paused (auto-trip or Pause all AI)", true, true),
        ("offline", "An AI team went offline", true, false),
        ("run_stuck", "An AI stopped moving", true, true),
        ("board_fault", "The board failed an AI (a board fault)", true, true),
        ("merge_conflict", "A merge conflict", true, true),
        ("arbitration", "Two AIs could not agree", true, true),
        ("window_urgent", "Urgent work waits for a usage window", true, true),
        ("workflow_step", "A workflow waits for you (the design to approve)", true, true),
        ("workflow_blocked", "A workflow step cannot start, or a ticket reached its token cap", true, true),
        ("ai_finished", "An AI finished work", false, false),
        ("schedule", "A scheduled run finished or was skipped", false, false),
        ("schedule_started", "A scheduled run started", false, false),
        ("page_published", "A page was published", false, false),
        ("comment", "A new comment in a thread you follow", false, false),
        ("run_cancelled", "A run was cancelled", false, false),
        ("budget_warning", "Budget passed a warning level", false, false),
        ("access_request", "Someone asked for access to Docs", false, false),
        ("day_card", "The day in one card", false, false),
        ("window_wait", "Runs wait for the next usage window", false, false),
        ("lesson", "An AI proposed a lesson for the project", false, false),
    ];
    let rows: Vec<Value> = table
        .iter()
        .map(|(kind, label, needs, desktop)| {
            let mut row = json!({"kind": kind, "label": label, "needs": needs, "inapp": true, "inapp_locked": needs, "desktop": desktop});
            for (k, v) in overrides {
                if k == kind {
                    for (f, x) in v.as_object().expect("override") {
                        row[f] = x.clone();
                    }
                }
            }
            row
        })
        .collect();
    Value::Array(rows)
}

#[tokio::test]
async fn an_empty_board_answers_every_read_route() {
    if !skip_unless_available("an_empty_board_answers_every_read_route") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();

    let r = c.get("/notifications/counts").await;
    r.assert_status(200);
    assert_eq!(
        r.json(),
        json!({"needs": 0, "needs_unread": 0, "updates_unread": 0, "updates": 0, "snoozed": 0, "unread": 0, "head": 0, "oldest_needs_at": null})
    );

    let r = c.get("/notifications").await;
    r.assert_status(200);
    let body = r.json();
    assert_eq!(body["items"], json!([]));
    assert_eq!(body["total"], 0);
    assert_eq!(body["head"], 0);
    assert_eq!(body["day_card"], Value::Null);
    assert!(body["now"].as_str().is_some_and(|n| n.ends_with("+00:00")), "{body}");
    assert_eq!(body.as_object().expect("object").len(), 5);
    for query in ["?view=panel&tab=needs", "?view=panel&tab=updates", "?filter=done&family=ai&days=3&limit=5"] {
        let r = c.get(&format!("/notifications{query}")).await;
        r.assert_status(200);
        assert_eq!(r.json()["items"], json!([]), "{query}");
    }

    let r = c.get("/notifications/feed").await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"head": 0, "cursor_too_old": false, "items": [], "resolved": []}));
    let r = c.get("/notifications/feed?since=5").await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"head": 0, "cursor_too_old": true, "items": [], "resolved": []}));
    let r = c.get("/notifications/feed?since=0").await;
    r.assert_status(200);
    let body = r.json();
    assert!(body["quiet"].is_boolean(), "{body}");
    assert_eq!(body["dnd"], true);
    assert_eq!(body["sound"], true);
    assert_eq!(body["sound_name"], "chime");
    assert_eq!(body["items"], json!([]));
    assert_eq!(body["resolved"], json!([]));
    assert_eq!(body["cursor_too_old"], false);

    let r = c.get("/notifications/log").await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"head": 0, "cursor_too_old": false, "events": []}));
    let r = c.get("/notifications/log?since=3&limit=1").await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"head": 0, "cursor_too_old": true, "events": []}));

    let r = c.get("/notifications/settings").await;
    r.assert_status(200);
    assert_eq!(
        r.json(),
        json!({
            "events": settings_events(&[]),
            "quiet": {"on": true, "start": "22:00", "end": "08:00"},
            "desktop_on": true,
            "dnd": true,
            "sound": true,
            "sound_name": "chime",
            "remind_after_min": 15,
            "day_card": {"on": true, "time": "18:00", "days": [0, 1, 2, 3, 4]},
            "retention_days": 90,
            "retention_editable": true,
            "muted": []
        })
    );

    let r = c.get("/notifications/follow?scope=ticket&scope_id=KAN-1").await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"scope": "ticket", "scope_id": "KAN-1", "level": null, "until": null, "id": null}));

    let r = c.get("/notifications/day-card").await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"card": null, "preview": null}));
    s.stop().await;
}

#[tokio::test]
async fn bad_query_values_are_a_422_in_fastapis_shape() {
    if !skip_unless_available("bad_query_values_are_a_422_in_fastapis_shape") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let r = c.get("/notifications?filter=sometimes").await;
    r.assert_status(422);
    assert_eq!(r.json(), json!({"detail": FILTER_MESSAGE}));

    let r = c.get("/notifications?days=abc").await;
    r.assert_status(422);
    let d = r.detail();
    assert_eq!(d[0]["type"], "int_parsing");
    assert_eq!(d[0]["loc"], json!(["query", "days"]));
    assert_eq!(d[0]["input"], "abc");

    let r = c.get("/notifications?limit=x&days=y").await;
    r.assert_status(422);
    assert_eq!(r.detail().as_array().expect("list").len(), 2);

    for path in ["/notifications/feed?since=soon", "/notifications/log?since=a", "/notifications/log?limit=a"] {
        let r = c.get(path).await;
        r.assert_status(422);
        assert_eq!(r.detail()[0]["type"], "int_parsing", "{path}");
    }

    let r = c.get("/notifications/follow").await;
    r.assert_status(422);
    let d = r.detail();
    assert_eq!(d.as_array().expect("list").len(), 2);
    assert_eq!(d[0]["type"], "missing");
    assert_eq!(d[0]["loc"], json!(["query", "scope"]));
    assert_eq!(d[1]["loc"], json!(["query", "scope_id"]));
    let r = c.get("/notifications/follow?scope=ticket").await;
    r.assert_status(422);
    assert_eq!(r.detail()[0]["loc"], json!(["query", "scope_id"]));

    let r = c.get("/notifications/day-card?preview=maybe").await;
    r.assert_status(422);
    assert_eq!(r.detail()[0]["type"], "bool_parsing");
    assert_eq!(r.detail()[0]["loc"], json!(["query", "preview"]));
    for yes in ["true", "1", "yes", "on"] {
        c.get(&format!("/notifications/day-card?preview={yes}")).await.assert_status(200);
    }

    // a body that is not what the route reads
    let r = c.post("/notifications/opened", json!({"target_kind": "ticket"})).await;
    r.assert_status(422);
    assert_eq!(r.detail()[0]["type"], "missing");
    assert_eq!(r.detail()[0]["loc"], json!(["body", "target_id"]));
    let r = c.post_empty("/notifications/read").await;
    r.assert_status(422);
    assert_eq!(r.detail()[0]["loc"], json!(["body"]));
    let r = c.post("/notifications/read", json!([1])).await;
    r.assert_status(422);
    let r = c.post("/notifications/x/snooze", json!({"until": 5})).await;
    r.assert_status(422);
    let r = c.put("/notifications/follow", json!({"scope": "ticket"})).await;
    r.assert_status(422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "scope_id"]));
    let r = c.patch("/notifications/settings", json!([])).await;
    r.assert_status(422);
    s.stop().await;
}

/// The rows every list test reads; returns their ids by name.
async fn seed_rows(s: &Server) {
    let db = pool(s).await;
    project(&db, "p1", "Proj One").await;
    member(&db, "mem_ai1", "p1", "Claude", "ai", "member").await;
    member(&db, "mem_hoa", "p1", "Hoa Mai", "human", "admin").await;
    let ev1 = {
        let mut e = Event::new("question", "Claude asks a question");
        e.project_id = Some("p1".into());
        e.needs = true;
        e.recipients = r#"["user"]"#.into();
        e.insert(&db).await
    };
    let ev2 = {
        let mut e = Event::new("mention", "Hoa mentioned you");
        e.needs = true;
        e.recipients = r#"["hoa mai"]"#.into();
        e.actor = Some("Hoa".into());
        e.data = r#"{"x": 1}"#.into();
        e.insert(&db).await
    };
    let ev3 = {
        let mut e = Event::new("mention", "Dismissed by {who}");
        e.op = "resolve".into();
        e.needs = true;
        e.target_kind = Some("thread".into());
        e.target_id = Some("th-1".into());
        e.recipients = r#"["user"]"#.into();
        e.data = r#"{"gone": false}"#.into();
        e.insert(&db).await
    };
    assert_eq!((ev1, ev2, ev3), (1, 2, 3));

    let mut a = Nrow::new("a", "ai_finished", false, "Claude finished KAN-1");
    a.member_id = Some("mem_ai1".into());
    a.ticket_id = Some("KAN-1".into());
    a.actor = Some("Claude".into());
    a.last_event_id = 2;
    a.updated_at = at(-10);
    a.items = r#"[{"event_id": 2, "title": "Claude finished KAN-1"}]"#.into();
    a.insert(&db).await;

    let mut b = Nrow::new("b", "comment", false, "New reply in a thread you follow");
    b.project_id = Some("p1".into());
    b.ticket_id = Some("KAN-7".into());
    b.read_at = Some(at(-30));
    b.updated_at = at(-20);
    b.insert(&db).await;

    let mut c = Nrow::new("c", "mention", true, "Hoa mentioned you");
    c.created_at = at(-3000);
    c.updated_at = at(-30);
    c.desktop = true;
    c.insert(&db).await;

    let mut d = Nrow::new("d", "question", true, "Claude asks a question");
    d.created_at = at(-2000);
    d.updated_at = at(-40);
    d.group_key = "question:run:r-none".into();
    d.insert(&db).await;

    let mut e = Nrow::new("e", "mention", true, "You were mentioned");
    e.group_key = "mention:thread:th-1".into();
    e.target_kind = Some("thread".into());
    e.target_id = Some("th-1".into());
    e.done_at = Some(at(-5));
    e.done_reason = Some("Dismissed by {who}".into());
    e.done_by = Some("user".into());
    e.read_at = Some(at(-5));
    e.updated_at = at(-50);
    e.insert(&db).await;

    let mut f = Nrow::new("f", "schedule", false, "Nightly run ended");
    f.snoozed_until = Some("2099-01-01T00:00:00+00:00".into());
    f.updated_at = at(-60);
    f.insert(&db).await;

    let mut g = Nrow::new("g", "budget_warning", false, "Budget passed 80%");
    g.cleared_at = Some(at(-70));
    g.read_at = Some(at(-70));
    g.updated_at = at(-70);
    g.insert(&db).await;

    let mut h = Nrow::new("h", "lesson", false, "A lesson was proposed");
    h.inapp = false;
    h.updated_at = at(-80);
    h.insert(&db).await;

    let mut i = Nrow::new("i", "page_published", false, "Hoa published v2 of Guide");
    i.page_id = Some("pg1".into());
    i.created_at = at(-40 * 86400);
    i.updated_at = at(-40 * 86400);
    i.insert(&db).await;

    let mut j = Nrow::new("j", "day_card", false, "Today on your boards");
    j.target_kind = Some("day".into());
    j.target_id = Some("user:2026-01-01".into());
    j.updated_at = at(-5);
    j.insert(&db).await;

    let mut other = Nrow::new("o1", "ai_finished", false, "Someone else's row");
    other.recipient = "hoa mai".into();
    other.insert(&db).await;
}

#[tokio::test]
async fn the_list_has_a_panel_and_a_page_with_filters() {
    if !skip_unless_available("the_list_has_a_panel_and_a_page_with_filters") {
        return;
    }
    let s = Server::start().await;
    seed_rows(&s).await;
    let c = s.client();
    let list = |q: &str| {
        let c = c.clone();
        let q = q.to_string();
        async move {
            let r = c.get(&format!("/notifications{q}")).await;
            r.assert_status(200);
            r.json()
        }
    };

    let all = list("").await;
    assert_eq!(ids(&all), ["j", "a", "b", "c", "d", "e", "f", "h", "i"]);
    assert_eq!(all["total"], 9);
    assert_eq!(all["head"], 3);
    // one row in full: the shape the UI and the desktop notifier read
    let a = all["items"][1].clone();
    assert_eq!(
        a,
        json!({
            "id": "a", "kind": "ai_finished", "kind_label": "An AI finished work", "needs": false, "project_id": null,
            "title": "Claude finished KAN-1", "body": "", "target_kind": null, "target_id": null, "ticket_id": "KAN-1",
            "page_id": null, "member_id": "mem_ai1", "member_name": "Claude", "actor": "Claude", "count": 1,
            "items": [{"event_id": 2, "title": "Claude finished KAN-1"}], "data": {}, "inapp": true, "desktop": false,
            "read": false, "read_at": null, "done": false, "done_at": null, "done_text": null, "done_by": null,
            "gone": false, "gone_reason": null, "snoozed": false, "snoozed_until": null, "cleared": false,
            "cleared_at": null, "group_key": "ai_finished:-", "event_id": 1, "last_event_id": 2,
            "created_at": a["created_at"], "updated_at": a["updated_at"],
            "actions": [{"id": "open", "label": "Open"}], "reminded": false, "dismissable": false
        })
    );
    let e = all["items"][5].clone();
    assert_eq!(e["done"], true);
    assert_eq!(e["done_text"], "Dismissed by you");
    assert_eq!(e["actions"], json!([]));
    assert_eq!(e["dismissable"], false);
    let c_row = all["items"][3].clone();
    assert_eq!(c_row["actions"], json!([{"id": "reply", "label": "Reply"}, {"id": "open", "label": "Open"}]));
    assert_eq!(c_row["dismissable"], true);
    assert_eq!(c_row["desktop"], true);
    let f_row = all["items"][6].clone();
    assert_eq!(f_row["snoozed"], true);
    assert_eq!(f_row["snoozed_until"], "2099-01-01T00:00:00+00:00");

    assert_eq!(ids(&list("?filter=unread").await), ["j", "a", "c", "d", "f", "h", "i"]);
    assert_eq!(ids(&list("?filter=needs").await), ["c", "d"]);
    assert_eq!(ids(&list("?filter=snoozed").await), ["f"]);
    assert_eq!(ids(&list("?filter=done").await), ["e"]);
    assert_eq!(ids(&list("?filter=cleared").await), ["g"]);

    let needs = list("?view=panel&tab=needs").await;
    assert_eq!(ids(&needs), ["c", "d", "e"]);
    assert_eq!(needs["day_card"], Value::Null);
    let updates = list("?view=panel&tab=updates").await;
    assert_eq!(ids(&updates), ["a", "b"]);
    assert_eq!(updates["total"], 3);
    assert_eq!(updates["day_card"]["id"], "j");
    assert_eq!(updates["day_card"]["kind"], "day_card");
    assert_eq!(ids(&list("?view=panel").await), ["a", "b", "c", "d", "e"]);

    assert_eq!(ids(&list("?q=finished").await), ["a"]);
    assert_eq!(ids(&list("?q=%20KAN-7%20").await), ["b"]);
    assert_eq!(ids(&list("?q=KAN-1").await), ["a"]);
    assert_eq!(ids(&list("?project_id=p1").await), ["b"]);
    assert_eq!(ids(&list("?kind=comment&kind=mention").await), ["b", "c", "e"]);
    assert_eq!(ids(&list("?kind=mention").await), ["c", "e"]);
    assert_eq!(ids(&list("?family=docs").await), ["i"]);
    assert_eq!(ids(&list("?family=ai").await), ["a"]);
    assert_eq!(ids(&list("?family=people").await), ["b", "c", "d", "e", "f", "h", "i"]);
    assert_eq!(ids(&list("?family=schedules").await), ["f"]);
    assert_eq!(ids(&list("?family=info").await), ["j", "a", "b", "f", "h", "i"]);
    assert_eq!(ids(&list("?family=needs").await), ["c", "d", "e"]);
    assert_eq!(ids(&list("?family=nonsense").await).len(), 9);
    assert_eq!(ids(&list("?days=1").await), ["j", "a", "b", "c", "d", "e", "f", "h"]);
    assert_eq!(ids(&list("?days=0").await).len(), 9);
    assert_eq!(ids(&list("?view=whatever").await).len(), 9);
    let limited = list("?limit=2").await;
    assert_eq!(ids(&limited), ["j", "a"]);
    assert_eq!(limited["total"], 9);
    assert_eq!(ids(&list("?limit=0").await), ["j"]);
    assert_eq!(ids(&list("?limit=-4").await), ["j"]);
    let before = all["items"][2]["updated_at"].as_str().expect("updated_at").to_string();
    assert_eq!(ids(&list(&format!("?before={}", before.replace('+', "%2B"))).await), ["c", "d", "e", "f", "h", "i"]);

    // another person sees their own rows
    let hoa = s.client().header("X-Actor", "Hoa Mai");
    let r = hoa.get("/notifications").await;
    r.assert_status(200);
    assert_eq!(ids(&r.json()), ["o1"]);
    let you = s.client().header("X-Actor", "You");
    assert_eq!(ids(&you.get("/notifications").await.json()).len(), 9);
    s.stop().await;
}

#[tokio::test]
async fn counts_feed_and_log_read_the_rows_and_the_log() {
    if !skip_unless_available("counts_feed_and_log_read_the_rows_and_the_log") {
        return;
    }
    let s = Server::start().await;
    seed_rows(&s).await;
    let c = s.client();

    let r = c.get("/notifications/counts").await;
    r.assert_status(200);
    let body = r.json();
    let oldest = {
        let db = pool(&s).await;
        let rows = table(&db, "notification").await;
        rows.iter().find(|r| r["id"] == "c").expect("row c")["created_at"].clone()
    };
    assert_eq!(
        body,
        json!({"needs": 2, "needs_unread": 2, "updates_unread": 2, "updates": 4, "snoozed": 1, "unread": 7, "head": 3, "oldest_needs_at": oldest})
    );

    let r = c.get("/notifications/feed?since=1").await;
    r.assert_status(200);
    let feed = r.json();
    assert_eq!(ids(&feed), ["a"]);
    assert_eq!(feed["resolved"], json!(["e"]));
    assert_eq!(feed["head"], 3);
    assert_eq!(feed["cursor_too_old"], false);
    let r = c.get("/notifications/feed?since=3").await;
    assert_eq!(ids(&r.json()), Vec::<String>::new());
    assert_eq!(r.json()["resolved"], json!([]));
    let r = c.get("/notifications/feed?since=0").await;
    // sorted by the newest event; rows with the same one come in the order the database reads them
    let mut every = ids(&r.json());
    assert_eq!(every.pop().as_deref(), Some("a"));
    every.sort();
    assert_eq!(every, ["b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    let r = c.get("/notifications/feed?since=9").await;
    assert_eq!(r.json()["cursor_too_old"], true);

    // the log: the board's own user reads everything, oldest first
    let r = c.get("/notifications/log").await;
    r.assert_status(200);
    let log = r.json();
    assert_eq!(log["head"], 3);
    assert_eq!(log["cursor_too_old"], false);
    let events = log["events"].as_array().expect("events").clone();
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[0],
        json!({
            "id": 1, "project_id": "p1", "kind": "question", "op": "new", "needs": true, "target_kind": null,
            "target_id": null, "ticket_id": null, "page_id": null, "member_id": null, "actor": null,
            "title": "Claude asks a question", "body": "", "data": {}, "recipients": ["user"],
            "created_at": events[0]["created_at"]
        })
    );
    assert_eq!(events[1]["data"], json!({"x": 1}));
    assert_eq!(events[1]["actor"], "Hoa");
    assert_eq!(events[2]["op"], "resolve");
    assert_eq!(events[2]["data"], json!({"gone": false}));
    let ids_of = |r: &Value| {
        r["events"].as_array().expect("events").iter().map(|e| e["id"].as_i64().expect("id")).collect::<Vec<_>>()
    };
    assert_eq!(ids_of(&c.get("/notifications/log?since=1").await.json()), [2, 3]);
    assert_eq!(ids_of(&c.get("/notifications/log?limit=2").await.json()), [1, 2]);
    assert_eq!(ids_of(&c.get("/notifications/log?limit=0").await.json()), [1]);
    assert_eq!(ids_of(&c.get("/notifications/log?project_id=p1").await.json()), [1]);
    assert_eq!(c.get("/notifications/log?since=1").await.json()["cursor_too_old"], false);
    assert_eq!(c.get("/notifications/log?since=9").await.json()["cursor_too_old"], true);

    // anyone else reads the events told to them, and every event of the projects they administer
    let hoa = s.client().header("X-Actor", "Hoa Mai");
    assert_eq!(ids_of(&hoa.get("/notifications/log").await.json()), [1, 2]);
    assert_eq!(ids_of(&hoa.get("/notifications/log?project_id=p1").await.json()), [1]);
    let stranger = s.client().header("X-Actor", "Stranger");
    let r = stranger.get("/notifications/log").await;
    r.assert_status(200);
    assert_eq!(ids_of(&r.json()), Vec::<i64>::new());
    let r = stranger.get("/notifications/counts").await;
    assert_eq!(r.json()["unread"], 0);
    s.stop().await;
}
