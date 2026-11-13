//! The routes that change rows: read, opened, dismiss, snooze, clear and clear-read; then the settings and follow
//! routes. Run with `PARITY_TARGET=python` first, then `rust`.

mod common;

use common::{Nrow, at, ids, member, pool, project, table};
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

async fn row_of(c: &testkit::Client, id: &str) -> Value {
    let r = c.get("/notifications?limit=500&filter=all").await;
    r.assert_status(200);
    let mut all = r.json()["items"].as_array().expect("items").clone();
    let r = c.get("/notifications?limit=500&filter=cleared").await;
    all.extend(r.json()["items"].as_array().expect("items").clone());
    all.into_iter().find(|i| i["id"] == id).unwrap_or_else(|| panic!("no row {id}"))
}

#[tokio::test]
async fn read_and_opened_mark_rows_read_and_never_done() {
    if !skip_unless_available("read_and_opened_mark_rows_read_and_never_done") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    let mut a = Nrow::new("a", "ai_finished", false, "A");
    a.ticket_id = Some("KAN-1".into());
    a.insert(&db).await;
    let mut b = Nrow::new("b", "comment", false, "B");
    b.page_id = Some("pg1".into());
    b.project_id = Some("p1".into());
    b.insert(&db).await;
    let mut c_ = Nrow::new("c", "mention", true, "C");
    c_.target_kind = Some("run".into());
    c_.target_id = Some("r1".into());
    c_.insert(&db).await;
    let mut d = Nrow::new("d", "schedule", false, "D");
    d.cleared_at = Some(at(-5));
    d.insert(&db).await;
    let mut e = Nrow::new("e", "page_published", false, "E");
    e.read_at = Some(at(-5));
    e.insert(&db).await;
    let mut o = Nrow::new("o", "ai_finished", false, "Other");
    o.recipient = "hoa".into();
    o.insert(&db).await;
    let c = s.client();

    // nothing asked, nothing read
    let r = c.post("/notifications/read", json!({})).await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"read": 0}));
    let r = c.post("/notifications/read", json!({"ids": []})).await;
    assert_eq!(r.json(), json!({"read": 0}));
    // by id: only the caller's own, only unread ones
    let r = c.post("/notifications/read", json!({"ids": ["a", "o", "e", "nope"]})).await;
    assert_eq!(r.json(), json!({"read": 1}));
    assert!(row_of(&c, "a").await["read"] == true);
    assert_eq!(table(&db, "notification").await.iter().find(|r| r["id"] == "o").expect("o")["read_at"], Value::Null);
    let r = c.post("/notifications/read", json!({"ids": ["a"]})).await;
    assert_eq!(r.json(), json!({"read": 0}));

    // a whole tab
    let r = c.post("/notifications/read", json!({"all": true, "tab": "needs"})).await;
    assert_eq!(r.json(), json!({"read": 1}));
    let still_open = row_of(&c, "c").await;
    assert_eq!((still_open["read"].clone(), still_open["done"].clone()), (json!(true), json!(false)));
    // filters of the page narrow it: a project, kinds (one or a list), a family, days
    let r = c.post("/notifications/read", json!({"all": true, "project_id": "p1"})).await;
    assert_eq!(r.json(), json!({"read": 1}));
    // `days: 0` counts as a filter, so the page's own rule applies and cleared rows are left alone
    let r = c.post("/notifications/read", json!({"all": true, "days": 0})).await;
    assert_eq!(r.json(), json!({"read": 0}));
    let r = c.post("/notifications/read", json!({"all": true, "kind": "schedule"})).await;
    assert_eq!(r.json(), json!({"read": 0}));
    let r = c.post("/notifications/read", json!({"all": true, "filter": "cleared", "kind": ["schedule", "x"]})).await;
    assert_eq!(r.json(), json!({"read": 1}));
    // an unknown page filter
    let r = c.post("/notifications/read", json!({"all": true, "q": "zzz", "filter": "sometimes"})).await;
    r.assert_status(422);
    assert_eq!(r.json(), json!({"detail": "filter must be one of all, unread, needs, snoozed, done, cleared"}));
    let r = c.post("/notifications/read", json!({"all": true, "q": "zzz", "filter": ""})).await;
    r.assert_status(422);
    // all with no filter reads everything left of the caller's, cleared or not
    let r = c.post("/notifications/read", json!({"all": true, "filter": ""})).await;
    assert_eq!(r.json(), json!({"read": 0}));

    // the log moved: every change that read something announced a new head... (reading writes no event)
    assert_eq!(c.get("/notifications/counts").await.json()["head"], 0);

    // opened: rows that point at it are read, by target, by ticket or by page
    for (kind, id, n) in [("run", "r1", 0), ("ticket", "KAN-1", 0), ("page", "pg1", 0), ("page", "none", 0)] {
        let r = c.post("/notifications/opened", json!({"target_kind": kind, "target_id": id})).await;
        r.assert_status(200);
        assert_eq!(r.json(), json!({"read": n}), "{kind} {id}");
    }
    // (a, b and c were already read above; put them back to see opened work)
    common::update(&db, "notification", "recipient", "user", &[("read_at", Value::Null)]).await;
    let r = c.post("/notifications/opened", json!({"target_kind": "ticket", "target_id": "KAN-1"})).await;
    assert_eq!(r.json(), json!({"read": 1}));
    let r = c.post("/notifications/opened", json!({"target_kind": "page", "target_id": "pg1"})).await;
    assert_eq!(r.json(), json!({"read": 1}));
    let r = c.post("/notifications/opened", json!({"target_kind": "run", "target_id": "r1"})).await;
    assert_eq!(r.json(), json!({"read": 1}));
    assert_eq!(row_of(&c, "c").await["done"], false);
    s.stop().await;
}

#[tokio::test]
async fn dismiss_resolves_the_work_for_everyone_it_was_addressed_to() {
    if !skip_unless_available("dismiss_resolves_the_work_for_everyone_it_was_addressed_to") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    // a mention is the caller's own; a run failure is shared; a question cannot be dismissed
    let mut m_user = Nrow::new("m_user", "mention", true, "Hoa mentioned you");
    m_user.group_key = "mention:-:-".into();
    m_user.insert(&db).await;
    let mut m_hoa = Nrow::new("m_hoa", "mention", true, "Hoa mentioned you");
    m_hoa.recipient = "hoa".into();
    m_hoa.group_key = "mention:-:-".into();
    m_hoa.insert(&db).await;
    let mut f_user = Nrow::new("f_user", "offline", true, "A team went offline");
    f_user.group_key = "offline:project:-".into();
    f_user.insert(&db).await;
    let mut f_hoa = Nrow::new("f_hoa", "offline", true, "A team went offline");
    f_hoa.recipient = "hoa".into();
    f_hoa.group_key = "offline:project:-".into();
    f_hoa.insert(&db).await;
    let mut q = Nrow::new("q", "question", true, "Claude asks");
    q.group_key = "question:run:q1".into();
    q.insert(&db).await;
    let mut gone = Nrow::new("gone", "question", true, "Claude asks");
    gone.group_key = "question:run:q2".into();
    gone.data = r#"{"gone": true, "gone_reason": "The run is gone."}"#.into();
    gone.insert(&db).await;
    let info = Nrow::new("info", "ai_finished", false, "Finished");
    info.insert(&db).await;
    let c = s.client();

    let r = c.post_empty("/notifications/m_user/dismiss").await;
    r.assert_status(200);
    let done = r.json();
    assert_eq!(done["id"], "m_user");
    assert_eq!(done["done"], true);
    assert_eq!(done["done_text"], "Dismissed by you");
    assert_eq!(done["done_by"], "user");
    assert_eq!(done["actions"], json!([]));
    assert_eq!(done["dismissable"], false);
    assert_eq!(done["snoozed"], false);
    assert!(done["done_at"].is_string());
    // only the caller's mention closed
    let rows = table(&db, "notification").await;
    let get = |id: &str| rows.iter().find(|r| r["id"] == id).expect("row").clone();
    assert_eq!(get("m_hoa")["done_at"], Value::Null);
    assert_eq!(get("m_user")["done_reason"], "Dismissed by {who}");
    assert_eq!(get("m_user")["done_by"], "user");
    // the log says so once, for the caller
    let log = c.get("/notifications/log").await.json();
    let events = log["events"].as_array().expect("events").clone();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["op"], "resolve");
    assert_eq!(events[0]["kind"], "mention");
    assert_eq!(events[0]["needs"], true);
    assert_eq!(events[0]["title"], "Dismissed by {who}");
    assert_eq!(events[0]["actor"], "user");
    assert_eq!(events[0]["recipients"], json!(["user"]));
    assert_eq!(events[0]["data"], json!({"gone": false}));
    // asking again answers with the closed row and writes nothing more
    let r = c.post_empty("/notifications/m_user/dismiss").await;
    r.assert_status(200);
    assert_eq!(r.json()["done"], true);
    assert_eq!(c.get("/notifications/counts").await.json()["head"], 1);

    // shared work: every recipient's row closes, and each sees who did it
    let r = c.post_empty("/notifications/f_user/dismiss").await;
    r.assert_status(200);
    let rows = table(&db, "notification").await;
    assert!(rows.iter().find(|r| r["id"] == "f_hoa").expect("row")["done_at"].is_string());
    let hoa = s.client().header("X-Actor", "Hoa");
    let seen = row_of(&hoa, "f_hoa").await;
    assert_eq!(seen["done_text"], "Dismissed by user");
    // a row that points at a thing that is gone is dismissed even when its kind is not
    let r = c.post_empty("/notifications/gone/dismiss").await;
    r.assert_status(200);
    assert_eq!(r.json()["done"], true);
    assert_eq!(r.json()["gone"], true);

    let r = c.post_empty("/notifications/q/dismiss").await;
    r.assert_status(409);
    assert_eq!(r.json(), json!({"detail": "This one closes when the work is done; it cannot be dismissed."}));
    let r = c.post_empty("/notifications/info/dismiss").await;
    r.assert_status(409);
    assert_eq!(r.json(), json!({"detail": "Only a Needs you row is dismissed; clear an update instead."}));
    for id in ["nope", "m_hoa"] {
        let r = c.post_empty(&format!("/notifications/{id}/dismiss")).await;
        r.assert_status(404);
        assert_eq!(r.json(), json!({"detail": "Notification not found"}));
    }
    s.stop().await;
}

#[tokio::test]
async fn snooze_clear_and_clear_read_change_one_row_each() {
    if !skip_unless_available("snooze_clear_and_clear_read_change_one_row_each") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    for id in ["a", "b", "c"] {
        Nrow::new(id, "ai_finished", false, id).insert(&db).await;
    }
    let mut r_ = Nrow::new("r", "comment", false, "read already");
    r_.read_at = Some(at(-5));
    r_.insert(&db).await;
    let n = Nrow::new("n", "mention", true, "open need");
    n.insert(&db).await;
    let mut dn = Nrow::new("dn", "mention", true, "done need");
    dn.group_key = "mention:x".into();
    dn.done_at = Some(at(-5));
    dn.done_reason = Some("Dismissed by {who}".into());
    dn.insert(&db).await;
    let c = s.client();

    // snooze
    let r = c.post("/notifications/a/snooze", json!({"until": "2099-01-01T10:00:00+07:00"})).await;
    r.assert_status(200);
    let body = r.json();
    assert_eq!(body["snoozed"], true);
    assert_eq!(body["snoozed_until"], "2099-01-01T03:00:00+00:00");
    assert_eq!(body["id"], "a");
    assert_eq!(c.get("/notifications/counts").await.json()["snoozed"], 1);
    assert_eq!(c.get("/notifications/counts").await.json()["head"], 0);
    let r = c.post("/notifications/a/snooze", json!({"until": "2099-01-01T10:00:00"})).await;
    assert_eq!(r.json()["snoozed_until"], "2099-01-01T10:00:00+00:00");
    let r = c.post("/notifications/a/snooze", json!({"until": null})).await;
    r.assert_status(200);
    assert_eq!(r.json()["snoozed"], false);
    assert_eq!(r.json()["snoozed_until"], Value::Null);
    let r = c.post("/notifications/a/snooze", json!({})).await;
    assert_eq!(r.json()["snoozed"], false);
    for until in ["2001-01-01T00:00:00+00:00", "tomorrow", ""] {
        let r = c.post("/notifications/a/snooze", json!({"until": until})).await;
        r.assert_status(422);
        assert_eq!(r.json(), json!({"detail": "Snooze until a time in the future."}), "{until}");
    }
    let r = c.post("/notifications/nope/snooze", json!({"until": null})).await;
    r.assert_status(404);
    assert_eq!(r.json(), json!({"detail": "Notification not found"}));
    // a needs row can be snoozed: it leaves the red number until then
    let r = c.post("/notifications/n/snooze", json!({"until": "2099-01-01T00:00:00+00:00"})).await;
    assert_eq!(r.json()["snoozed"], true);
    assert_eq!(c.get("/notifications/counts").await.json()["needs"], 0);

    // clear: the x on a row; read at the same time
    let r = c.post_empty("/notifications/b/clear").await;
    r.assert_status(200);
    let body = r.json();
    assert_eq!(body["cleared"], true);
    assert_eq!(body["read"], true);
    assert_eq!(body["read_at"], body["cleared_at"]);
    let r = c.post("/notifications/b/clear", json!({"on": false})).await;
    assert_eq!(r.json()["cleared"], false);
    assert_eq!(r.json()["cleared_at"], Value::Null);
    assert_eq!(r.json()["read"], true);
    let r = c.post("/notifications/r/clear", json!({"on": true})).await;
    assert_eq!(r.json()["cleared"], true);
    assert_eq!(
        r.json()["read_at"],
        table(&db, "notification").await.iter().find(|r| r["id"] == "r").expect("r")["read_at"]
    );
    let r = c.post("/notifications/dn/clear", json!({})).await;
    r.assert_status(200);
    assert_eq!(r.json()["cleared"], true);
    let r = c.post("/notifications/n/clear", json!({"on": true})).await;
    r.assert_status(409);
    assert_eq!(
        r.json(),
        json!({"detail": "A Needs you row closes when the work is done, or is snoozed; it is not cleared."})
    );
    let r = c.post("/notifications/nope/clear", json!({})).await;
    r.assert_status(404);
    let r = c.post_empty("/notifications/c/clear").await;
    r.assert_status(200);
    let r = c.post("/notifications/c/clear", json!(null)).await;
    r.assert_status(200);
    assert_eq!(r.json()["cleared"], true);
    let r = c.post("/notifications/c/clear", json!({"on": "maybe"})).await;
    r.assert_status(422);

    // clear-read: every read update that is not cleared yet
    let r = c.post_empty("/notifications/clear-read").await;
    r.assert_status(200);
    // b was put back (not cleared) and is read
    assert_eq!(r.json(), json!({"cleared": 1}));
    c.post("/notifications/read", json!({"ids": ["a", "b"]})).await.assert_status(200);
    let r = c.post_empty("/notifications/clear-read").await;
    assert_eq!(r.json(), json!({"cleared": 1}));
    assert_eq!(ids(&c.get("/notifications?filter=cleared&limit=500").await.json()).len(), 5);
    s.stop().await;
}

#[tokio::test]
async fn settings_are_saved_per_person_in_the_order_python_wrote_them() {
    if !skip_unless_available("settings_are_saved_per_person_in_the_order_python_wrote_them") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    project(&db, "p1", "Proj One").await;
    member(&db, "m1", "p1", "Hoa Mai", "human", "admin").await;
    member(&db, "m2", "p1", "Tuan", "human", "member").await;
    let c = s.client();
    let stored = |recipient: &str| {
        let db = db.clone();
        let recipient = recipient.to_string();
        async move {
            table(&db, "notify_prefs")
                .await
                .into_iter()
                .find(|r| r["recipient"] == recipient)
                .map(|r| r["prefs"].as_str().expect("prefs").to_string())
        }
    };

    let r = c
        .patch(
            "/notifications/settings",
            json!({
                "events": [{"kind": "ai_finished", "inapp": false, "desktop": true}],
                "quiet": {"on": false, "start": "23:30", "end": "7:00"},
                "dnd": false,
                "sound_name": "bell",
                "remind_after_min": 0,
                "day_card": {"time": "19:15", "days": [5, 3, 3, 9, "1"]}
            }),
        )
        .await;
    r.assert_status(200);
    let body = r.json();
    assert_eq!(body["quiet"], json!({"on": false, "start": "23:30", "end": "08:00"}));
    assert_eq!(body["dnd"], false);
    assert_eq!(body["sound"], true);
    assert_eq!(body["sound_name"], "bell");
    assert_eq!(body["remind_after_min"], 0);
    assert_eq!(body["day_card"], json!({"on": true, "time": "19:15", "days": [1, 3, 5]}));
    assert_eq!(body["retention_days"], 90);
    assert_eq!(body["muted"], json!([]));
    let ai_finished =
        body["events"].as_array().expect("events").iter().find(|e| e["kind"] == "ai_finished").expect("kind").clone();
    assert_eq!(
        ai_finished,
        json!({"kind": "ai_finished", "label": "An AI finished work", "needs": false, "inapp": false, "inapp_locked": false, "desktop": true})
    );
    assert_eq!(
        stored("user").await.as_deref(),
        Some(
            r#"{"events": {"ai_finished": {"inapp": false, "desktop": true}}, "quiet": {"on": false, "start": "23:30", "end": "08:00"}, "dnd": false, "sound_name": "bell", "remind_after_min": 0, "day_card": {"on": true, "time": "19:15", "days": [1, 3, 5]}}"#
        )
    );
    // the change was announced: the log did not move (settings write no event), the stream did
    assert_eq!(c.get("/notifications/counts").await.json()["head"], 0);

    let r = c
        .patch(
            "/notifications/settings",
            json!({
                "events": [{"kind": "question", "desktop": false}, {"kind": "ai_finished", "inapp": true}, {"kind": "offline"}],
                "sound": false,
                "desktop_on": false,
                "retention_days": 30
            }),
        )
        .await;
    r.assert_status(200);
    let body = r.json();
    assert_eq!(body["desktop_on"], false);
    assert_eq!(body["sound"], false);
    assert_eq!(body["retention_days"], 30);
    assert_eq!(body["retention_editable"], true);
    let kind = |name: &str| {
        body["events"].as_array().expect("events").iter().find(|e| e["kind"] == name).expect("kind").clone()
    };
    assert_eq!(kind("question")["desktop"], false);
    assert_eq!(kind("ai_finished")["inapp"], true);
    assert_eq!(kind("ai_finished")["desktop"], true);
    assert_eq!(kind("run_failed")["desktop"], true);
    assert_eq!(
        stored("user").await.as_deref(),
        Some(
            r#"{"events": {"ai_finished": {"inapp": true, "desktop": true}, "question": {"desktop": false}, "offline": {}}, "quiet": {"on": false, "start": "23:30", "end": "08:00"}, "dnd": false, "sound_name": "bell", "remind_after_min": 0, "day_card": {"on": true, "time": "19:15", "days": [1, 3, 5]}, "sound": false, "desktop_on": false}"#
        )
    );
    assert_eq!(stored("*").await.as_deref(), Some(r#"{"retention_days": 30}"#));
    // an empty body changes nothing and answers the page
    let r = c.patch("/notifications/settings", json!({})).await;
    r.assert_status(200);
    assert_eq!(r.json()["retention_days"], 30);

    // every refusal, and nothing saved by it
    let before = table(&db, "notify_prefs").await;
    let refusals: Vec<(Value, u16, &str)> = vec![
        (
            json!({"events": [{"kind": "question", "inapp": false}]}),
            422,
            "In app stays on for everything that needs you: an AI waiting on an answer with no row and no count would wait for ever. Only its desktop notification can be switched off.",
        ),
        (json!({"events": [{"kind": "nope"}]}), 422, "Unknown kind: nope"),
        (json!({"events": [{}]}), 422, "Unknown kind: None"),
        (json!({"events": [{"kind": 5}]}), 422, "Unknown kind: 5"),
        (json!({"sound_name": "ding"}), 422, "Pick a sound: chime, drop, bell."),
        (json!({"remind_after_min": 2000}), 422, "Remind after 1 to 1440 minutes, or 0 for never."),
        (json!({"remind_after_min": -1}), 422, "Remind after 1 to 1440 minutes, or 0 for never."),
        (json!({"remind_after_min": "abc"}), 422, "invalid literal for int() with base 10: 'abc'"),
        (json!({"day_card": {"days": ["x"]}}), 422, "invalid literal for int() with base 10: 'x'"),
        (json!({"retention_days": 0}), 422, "Keep notifications for 1 to 3650 days."),
        (json!({"retention_days": 4000, "dnd": true}), 422, "Keep notifications for 1 to 3650 days."),
        (json!({"retention_days": "many"}), 422, "invalid literal for int() with base 10: 'many'"),
    ];
    for (body, status, detail) in refusals {
        let r = c.patch("/notifications/settings", body.clone()).await;
        r.assert_status(status);
        assert_eq!(r.json(), json!({"detail": detail}), "{body}");
    }
    assert_eq!(table(&db, "notify_prefs").await, before);
    // a value Python cannot take at all is a plain 500
    let r = c.patch("/notifications/settings", json!({"events": [1]})).await;
    assert_eq!(r.status, 500);
    let r = c.patch("/notifications/settings", json!({"remind_after_min": []})).await;
    assert_eq!(r.status, 500);

    // retention is app-wide: only the board's own user or an owner / admin changes it
    let stranger = s.client().header("X-Actor", "Stranger");
    let r = stranger.patch("/notifications/settings", json!({"retention_days": 10})).await;
    r.assert_status(403);
    assert_eq!(
        r.json(),
        json!({"detail": "Only the board's own user, or an owner or admin of a project, changes how long notifications are kept."})
    );
    let member_only = s.client().header("X-Actor", "Tuan");
    assert_eq!(member_only.patch("/notifications/settings", json!({"retention_days": 10})).await.status, 403);
    assert_eq!(member_only.get("/notifications/settings").await.json()["retention_editable"], false);
    let admin = s.client().header("X-Actor", "Hoa Mai");
    let r = admin.get("/notifications/settings").await;
    assert_eq!(r.json()["retention_editable"], true);
    // each person has settings of their own, with the defaults for what they never set
    assert_eq!(r.json()["sound_name"], "chime");
    assert_eq!(r.json()["quiet"], json!({"on": true, "start": "22:00", "end": "08:00"}));
    let r = admin.patch("/notifications/settings", json!({"retention_days": 45, "quiet": {"start": "21:00"}})).await;
    r.assert_status(200);
    assert_eq!(r.json()["retention_days"], 45);
    assert_eq!(r.json()["quiet"], json!({"on": true, "start": "21:00", "end": "08:00"}));
    assert_eq!(stored("*").await.as_deref(), Some(r#"{"retention_days": 45}"#));
    assert_eq!(
        stored("hoa mai").await.as_deref(),
        Some(r#"{"quiet": {"on": true, "start": "21:00", "end": "08:00"}}"#)
    );
    assert_eq!(
        c.get("/notifications/settings").await.json()["quiet"],
        json!({"on": false, "start": "23:30", "end": "08:00"})
    );
    let _ = at(0);
    s.stop().await;
}

#[tokio::test]
async fn follow_and_mute_are_kept_per_person_and_forgotten_on_request() {
    if !skip_unless_available("follow_and_mute_are_kept_per_person_and_forgotten_on_request") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    project(&db, "p1", "Proj One").await;
    let c = s.client();
    let put = |body: Value| {
        let c = c.clone();
        async move { c.put("/notifications/follow", body).await }
    };

    let r = put(json!({"scope": "ticket", "scope_id": "KAN-1", "level": "follow"})).await;
    r.assert_status(200);
    let first = r.json();
    assert_eq!(first["scope"], "ticket");
    assert_eq!(first["scope_id"], "KAN-1");
    assert_eq!(first["level"], "follow");
    assert_eq!(first["until"], Value::Null);
    let id = first["id"].as_str().expect("id").to_string();
    assert_eq!(first.as_object().expect("object").len(), 5);
    let rows = table(&db, "notify_follow").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["label"], "KAN-1");
    assert_eq!(rows[0]["recipient"], "user");
    assert_eq!(rows[0]["project_id"], Value::Null);
    // following again replaces the row
    let r = put(json!({"scope": "ticket", "scope_id": "KAN-1", "level": "everything"})).await;
    assert_eq!(r.json()["level"], "everything");
    assert_ne!(r.json()["id"].as_str().expect("id"), id);
    assert_eq!(table(&db, "notify_follow").await.len(), 1);
    assert_eq!(c.get("/notifications/follow?scope=ticket&scope_id=KAN-1").await.json()["level"], "everything");
    assert_eq!(c.get("/notifications/follow?scope=page&scope_id=KAN-1").await.json()["level"], Value::Null);

    // the label that is made for each scope
    let cases = vec![
        (json!({"scope": "page", "scope_id": "pg-x", "level": "mute"}), "A Docs page"),
        (json!({"scope": "project", "scope_id": "p1", "level": "mute"}), "Proj One"),
        (json!({"scope": "project", "scope_id": "pz", "level": "mute"}), "A project"),
        (json!({"scope": "space", "scope_id": "p1", "level": "follow"}), "Proj One · Docs space"),
        (json!({"scope": "space", "scope_id": "pz", "level": "follow"}), "A project · Docs space"),
        (json!({"scope": "kind", "scope_id": "question", "level": "mute"}), "A question from an AI"),
        (
            json!({"scope": "kind", "scope_id": "comment", "level": "mute", "project_id": "p1"}),
            "A new comment in a thread you follow, in Proj One",
        ),
        (
            json!({"scope": "kind", "scope_id": "lesson", "level": "mute", "project_id": "pz"}),
            "An AI proposed a lesson for the project",
        ),
        (json!({"scope": "ticket", "scope_id": "KAN-2", "level": "mentions", "label": "My label"}), "My label"),
    ];
    for (body, label) in cases {
        let r = put(body.clone()).await;
        r.assert_status(200);
        let rows = table(&db, "notify_follow").await;
        let row = rows.iter().find(|r| r["scope_id"] == body["scope_id"] && r["scope"] == body["scope"]).expect("row");
        assert_eq!(row["label"], label, "{body}");
    }
    // the Muted list is what is muted (mute and mentions), with its labels
    let muted = c.get("/notifications/settings").await.json()["muted"].as_array().expect("muted").clone();
    let labels: Vec<&str> = muted.iter().map(|m| m["label"].as_str().expect("label")).collect();
    assert_eq!(
        labels,
        [
            "A Docs page",
            "Proj One",
            "A project",
            "A question from an AI",
            "A new comment in a thread you follow, in Proj One",
            "An AI proposed a lesson for the project",
            "My label"
        ]
    );
    assert_eq!(
        muted[0],
        json!({"id": muted[0]["id"], "scope": "page", "scope_id": "pg-x", "project_id": null, "level": "mute", "until": null, "label": "A Docs page", "created_at": muted[0]["created_at"]})
    );
    // a kind muted in one project is its own row, next to the same kind muted everywhere
    put(json!({"scope": "kind", "scope_id": "comment", "level": "mute"})).await.assert_status(200);
    assert_eq!(table(&db, "notify_follow").await.iter().filter(|r| r["scope_id"] == "comment").count(), 2);
    put(json!({"scope": "kind", "scope_id": "comment", "level": "mentions", "project_id": "p1"}))
        .await
        .assert_status(200);
    assert_eq!(table(&db, "notify_follow").await.iter().filter(|r| r["scope_id"] == "comment").count(), 2);

    // mute for a while
    let r = put(json!({"scope": "ticket", "scope_id": "KAN-3", "level": "mute", "minutes": 60})).await;
    r.assert_status(200);
    let until = r.json()["until"].as_str().expect("until").to_string();
    let when = kb_base::time::parse_iso(&until).expect("iso").utc();
    let wait = (when - chrono::Utc::now()).num_minutes();
    assert!((58..=60).contains(&wait), "{until}");
    // zero minutes is forever
    assert_eq!(
        put(json!({"scope": "ticket", "scope_id": "KAN-3", "level": "mute", "minutes": 0})).await.json()["until"],
        Value::Null
    );
    // a mute that ran out is not there any more
    common::insert(
        &db,
        "notify_follow",
        &[
            ("id", json!("old")),
            ("recipient", json!("user")),
            ("scope", json!("ticket")),
            ("scope_id", json!("KAN-9")),
            ("level", json!("mute")),
            ("until", json!(at(-60))),
            ("label", json!("old")),
        ],
    )
    .await;
    let r = c.get("/notifications/follow?scope=ticket&scope_id=KAN-9").await;
    assert_eq!(r.json(), json!({"scope": "ticket", "scope_id": "KAN-9", "level": null, "until": null, "id": null}));
    assert!(!c.get("/notifications/settings").await.json()["muted"].to_string().contains("\"old\""));

    // forget: level null
    let r = put(json!({"scope": "ticket", "scope_id": "KAN-1", "level": null})).await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"scope": "ticket", "scope_id": "KAN-1", "level": null, "until": null, "id": null}));
    assert!(table(&db, "notify_follow").await.iter().all(|r| r["scope_id"] != "KAN-1"));
    assert_eq!(put(json!({"scope": "ticket", "scope_id": "KAN-1"})).await.json()["level"], Value::Null);

    // each refusal
    for (body, detail) in [
        (
            json!({"scope": "folder", "scope_id": "x", "level": "mute"}),
            "scope must be ticket, page, space, project or kind",
        ),
        (
            json!({"scope": "ticket", "scope_id": "x", "level": "loud"}),
            "level must be follow, everything, mentions or mute",
        ),
        (
            json!({"scope": "ticket", "scope_id": "x", "level": ""}),
            "level must be follow, everything, mentions or mute",
        ),
        (json!({"scope": "kind", "scope_id": "nope", "level": "mute"}), "Unknown kind: nope"),
    ] {
        let r = put(body.clone()).await;
        r.assert_status(422);
        assert_eq!(r.json(), json!({"detail": detail}), "{body}");
    }

    // delete: only the caller's own
    let muted_id = table(&db, "notify_follow").await.iter().find(|r| r["scope_id"] == "KAN-2").expect("row")["id"]
        .as_str()
        .expect("id")
        .to_string();
    let hoa = s.client().header("X-Actor", "Hoa");
    let r = hoa.delete(&format!("/notifications/follow/{muted_id}")).await;
    r.assert_status(404);
    assert_eq!(r.json(), json!({"detail": "Not found"}));
    let r = c.delete("/notifications/follow/nope").await;
    r.assert_status(404);
    let r = c.delete(&format!("/notifications/follow/{muted_id}")).await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"deleted": true}));
    assert!(table(&db, "notify_follow").await.iter().all(|r| r["id"] != muted_id.as_str()));
    // other people see nothing of it
    let r = hoa.get("/notifications/follow?scope=ticket&scope_id=KAN-3").await;
    assert_eq!(r.json()["level"], Value::Null);
    s.stop().await;
}
