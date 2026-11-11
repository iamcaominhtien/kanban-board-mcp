//! The service functions of `services/notifications.py` called directly, on a database of their own in this
//! process (`database::setup()` + `init_db()`; the database is process-global, so the scenarios run as one
//! sequence in one test). Expected values follow the Python code line by line; the same behaviors seen through
//! HTTP are in `routes.rs`, `acting.rs` and `reconcile.rs`, which also run on the Python server.

#![allow(unsafe_code)]

use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};
use kb_base::time::iso;
use kb_db::database;
use kb_db::entities::{
    ai_chat, ai_run, ai_schedule_run, docs_comment_event, member, notification, notify_event, notify_follow,
    notify_prefs, project, ticket,
};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use kb_notify::{EmitFields, NotifyError};
use serde_json::{Map, Value, json};

fn data(v: Value) -> Option<Map<String, Value>> {
    match v {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn s(v: &str) -> Option<String> {
    Some(v.to_string())
}

fn ago(minutes: i64) -> String {
    iso(&(Utc::now() - Duration::minutes(minutes)))
}

async fn clear() {
    let conn = database::conn();
    notification::Entity::delete_many().exec(&conn).await.expect("clear");
    notify_event::Entity::delete_many().exec(&conn).await.expect("clear");
    notify_follow::Entity::delete_many().exec(&conn).await.expect("clear");
    notify_prefs::Entity::delete_many().exec(&conn).await.expect("clear");
    ai_run::Entity::delete_many().exec(&conn).await.expect("clear");
    ai_chat::Entity::delete_many().exec(&conn).await.expect("clear");
    ai_schedule_run::Entity::delete_many().exec(&conn).await.expect("clear");
    ticket::Entity::delete_many().exec(&conn).await.expect("clear");
    member::Entity::delete_many().exec(&conn).await.expect("clear");
    project::Entity::delete_many().exec(&conn).await.expect("clear");
    docs_comment_event::Entity::delete_many().exec(&conn).await.expect("clear");
}

async fn rows_of(recipient: &str) -> Vec<notification::Model> {
    notification::Entity::find()
        .filter(notification::Column::Recipient.eq(recipient))
        .order_by_asc(notification::Column::CreatedAt)
        .order_by_asc(notification::Column::Id)
        .all(&database::conn())
        .await
        .expect("rows")
}

async fn one_row(recipient: &str) -> notification::Model {
    let mut rows = rows_of(recipient).await;
    assert_eq!(rows.len(), 1, "{recipient}: {rows:?}");
    rows.remove(0)
}

async fn events() -> Vec<notify_event::Model> {
    notify_event::Entity::find().order_by_asc(notify_event::Column::Id).all(&database::conn()).await.expect("events")
}

async fn add_project(id: &str, name: &str) {
    let mut p = project::new();
    p.id = Set(id.to_string());
    p.name = Set(name.to_string());
    p.prefix = Set(id.to_uppercase());
    p.color = Set("#000000".into());
    p.insert(&database::conn()).await.expect("project");
}

async fn add_member(id: &str, project_id: &str, name: &str, kind: &str, role: &str) {
    let mut m = member::new();
    m.id = Set(id.to_string());
    m.project_id = Set(project_id.to_string());
    m.name = Set(name.to_string());
    m.color = Set("#111111".into());
    m.kind = Set(kind.to_string());
    m.role = Set(role.to_string());
    m.insert(&database::conn()).await.expect("member");
}

async fn add_ticket(id: &str, project_id: &str, assignee: Option<&str>) {
    let mut t = ticket::new();
    t.id = Set(id.to_string());
    t.project_id = Set(project_id.to_string());
    t.title = Set("A ticket".into());
    t.assignee = Set(assignee.map(str::to_string));
    t.insert(&database::conn()).await.expect("ticket");
}

async fn add_run(id: &str, ticket_id: Option<&str>, state: &str, change: impl FnOnce(&mut ai_run::ActiveModel)) {
    let mut r = ai_run::new();
    r.id = Set(id.to_string());
    r.project_id = Set("p1".into());
    r.member_id = Set("mc".into());
    r.ticket_id = Set(ticket_id.map(str::to_string));
    r.state = Set(state.to_string());
    r.number = Set(3);
    r.mode = Set("work".into());
    r.started_by = Set("user".into());
    change(&mut r);
    r.insert(&database::conn()).await.expect("run");
}

async fn add_follow(
    recipient: &str,
    scope: &str,
    scope_id: &str,
    level: &str,
    project: Option<&str>,
    until: Option<String>,
) {
    let mut f = notify_follow::new();
    f.recipient = Set(recipient.to_string());
    f.scope = Set(scope.to_string());
    f.scope_id = Set(scope_id.to_string());
    f.level = Set(level.to_string());
    f.project_id = Set(project.map(str::to_string));
    f.until = Set(until);
    f.insert(&database::conn()).await.expect("follow");
}

async fn set_prefs(recipient: &str, prefs: Value) {
    let mut p = notify_prefs::new();
    p.recipient = Set(recipient.to_string());
    p.prefs = Set(kb_base::pyjson::dumps(&prefs));
    p.insert(&database::conn()).await.expect("prefs");
}

fn fields(project: Option<&str>, recipients: &[&str], title: &str) -> EmitFields {
    EmitFields {
        project_id: project.map(str::to_string),
        recipients: recipients.iter().map(|r| r.to_string()).collect(),
        title: title.to_string(),
        ..Default::default()
    }
}

async fn emit(kind: &str, f: EmitFields) -> i32 {
    kb_notify::emit(kind, None, f).await.unwrap_or_else(|e| panic!("emit {kind}: {e}"))
}

#[tokio::test]
async fn the_service_functions_of_the_notification_centre() {
    let dir = tempfile::tempdir().expect("temporary folder");
    // this test is the only one in its process: the folders are set before anything reads them
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("setup");
    database::init_db().await.expect("init_db");

    emit_writes_one_row_per_recipient_and_merges_a_group().await;
    clear().await;
    quiet_and_switches().await;
    clear().await;
    what_the_features_write().await;
    clear().await;
    comments_and_the_queues().await;
    clear().await;
    time_is_injectable().await;
    clear().await;
    reconcile_and_resolve().await;
    clear().await;
    log_and_head().await;
}

async fn emit_writes_one_row_per_recipient_and_merges_a_group() {
    // an unknown kind is refused, nothing is written
    let err = kb_notify::emit("nope", None, fields(None, &["user"], "x")).await.expect_err("unknown kind");
    assert!(matches!(&err, NotifyError::Value(m) if m == "Unknown notification kind: nope"), "{err}");
    assert!(events().await.is_empty());

    // information: the person who caused it is not told; blanks and repeats are dropped; every event is logged
    let mut f = fields(Some("p1"), &["user", "hoa", "", "user"], "Claude finished KAN-1");
    f.actor = s("Hoa");
    f.ticket_id = s("KAN-1");
    f.member_id = s("m1");
    f.body = Some("x".repeat(300));
    let ev = emit("ai_finished", f).await;
    assert_eq!(ev, 1);
    let log = events().await;
    assert_eq!(log[0].recipients, r#"["user"]"#);
    assert_eq!(log[0].op, "new");
    assert!(!log[0].needs);
    assert_eq!(log[0].body.chars().count(), 300);
    assert_eq!(log[0].data, "{}");
    let row = one_row("user").await;
    assert!(rows_of("hoa").await.is_empty());
    assert_eq!((row.count, row.group_key.as_str()), (1, "ai_finished:p1"));
    assert_eq!((row.event_id, row.last_event_id), (1, 1));
    assert!(row.inapp && !row.desktop);
    let items: Value = serde_json::from_str(&row.items).expect("items");
    assert_eq!(items[0]["body"].as_str().expect("body").chars().count(), 200);
    assert_eq!(items[0]["at"], json!(log[0].created_at));
    assert_eq!(row.created_at, log[0].created_at);
    assert_eq!(row.updated_at, log[0].created_at);

    // a second event of the group inside 10 minutes is the same row
    let mut f = fields(Some("p1"), &["user"], "Claude finished KAN-2");
    f.actor = s("Linh");
    f.ticket_id = s("KAN-2");
    emit("ai_finished", f).await;
    let row = one_row("user").await;
    assert_eq!((row.count, row.last_event_id), (2, 2));
    assert_eq!(row.title, "2 AI finished work");
    assert_eq!(row.body, "Hoa, Linh · KAN-1 to KAN-2");
    assert_eq!(serde_json::from_str::<Value>(&row.items).expect("items").as_array().expect("array").len(), 2);
    // another project is another row
    emit("ai_finished", fields(Some("p2"), &["user"], "other")).await;
    assert_eq!(rows_of("user").await.len(), 2);

    // a row older than the window, or one that is done or cleared, is not merged into
    let conn = database::conn();
    let first = one_row_by_key("ai_finished:p1").await;
    let mut am: notification::ActiveModel = first.clone().into();
    am.created_at = Set(ago(11));
    am.update(&conn).await.expect("update");
    emit("ai_finished", fields(Some("p1"), &["user"], "third")).await;
    assert_eq!(rows_of("user").await.iter().filter(|r| r.group_key == "ai_finished:p1").count(), 2);

    // the 21st event of a group says "20+" and the row keeps the last 50 items
    for i in 0..52 {
        emit("comment", fields(Some("p3"), &["user"], &format!("c{i}"))).await;
    }
    let row = one_row_by_key("comment:p3").await;
    assert_eq!(row.count, 52);
    assert_eq!(row.title, "20+ new comments in threads you follow");
    assert_eq!(row.body, "52 in 10 minutes");
    assert_eq!(serde_json::from_str::<Value>(&row.items).expect("items").as_array().expect("array").len(), 50);

    clear().await;
    // Needs you: the same request is one row, told to AI members too; the actor is told as well
    let t0 = ago(30);
    let mut f = fields(Some("p1"), &["user", "ai:m1", "hoa"], "Claude asks a question");
    f.body = Some("“A?”".into());
    f.actor = s("Hoa");
    f.target_kind = s("run");
    f.target_id = s("r1");
    f.ticket_id = s("KAN-1");
    f.since = Some(t0.clone());
    emit("question", f.clone()).await;
    for who in ["user", "ai:m1", "hoa"] {
        let r = one_row(who).await;
        assert_eq!(r.group_key, "question:run:r1");
        assert!(r.needs && r.inapp && r.desktop, "{who}");
        assert_eq!(r.created_at, t0);
    }
    // snoozed and read, then asked again: the latest words, unread, back from the snooze
    let user = one_row("user").await;
    let mut am: notification::ActiveModel = user.into();
    am.snoozed_until = Set(s("2099-01-01T00:00:00+00:00"));
    am.read_at = Set(Some(ago(1)));
    am.update(&database::conn()).await.expect("update");
    let mut again = f.clone();
    again.title = "Claude asks again".into();
    again.body = Some("“B?”".into());
    again.since = None;
    emit("question", again).await;
    let user = one_row("user").await;
    assert_eq!((user.count, user.title.as_str(), user.body.as_str()), (2, "Claude asks again", "“B?”"));
    assert_eq!((user.read_at.clone(), user.snoozed_until.clone()), (None, None));
    assert_eq!(user.created_at, t0);
    // a reminder of the request is not one more thing: the row only comes back
    let mut reminder = f.clone();
    reminder.title = "ignored".into();
    reminder.data = data(json!({"reminder": true}));
    emit("question", reminder).await;
    let user = one_row("user").await;
    assert_eq!((user.count, user.title.as_str()), (2, "Claude asks again"));
    let d: Value = serde_json::from_str(&user.data).expect("data");
    assert!(d["reminded_at"].is_string());
    // the next real event is a new request for attention and forgets it reminded
    let mut next = f.clone();
    next.title = "A safety reminder".into();
    next.data = data(json!({"safety_id": "s1"}));
    emit("question", next).await;
    let user = one_row("user").await;
    assert_eq!(user.count, 3);
    assert_eq!(user.title, "Claude asks again", "a safety reminder keeps the request's own words");
    assert_eq!(user.data, "{}");
    // a closed row is never merged into
    let mut am: notification::ActiveModel = user.into();
    am.done_at = Set(Some(ago(0)));
    am.update(&database::conn()).await.expect("update");
    emit("question", f.clone()).await;
    assert_eq!(rows_of("user").await.len(), 2);
    // a Needs you row points at the newest run, and a row of a run keeps pointing at a run
    let mut f2 = fields(Some("p1"), &["user"], "t");
    f2.target_kind = s("ticket");
    f2.target_id = s("KAN-1");
    emit("workflow_step", f2.clone()).await;
    let mut f3 = f2.clone();
    f3.target_kind = s("run");
    f3.target_id = s("r9");
    f3.title = "t2".into();
    // (a different target is a different group; same kind and same target merge, as asserted above)
    emit("workflow_step", f3).await;
    assert_eq!(rows_of("user").await.iter().filter(|r| r.kind == "workflow_step").count(), 2);

    // day cards never merge
    clear().await;
    emit("day_card", fields(None, &["user"], "card")).await;
    emit("day_card", fields(None, &["user"], "card")).await;
    assert_eq!(rows_of("user").await.len(), 2);
    // a failure of one ticket is one row, whatever run it came from
    clear().await;
    let mut f = fields(Some("p1"), &["user"], "Run #1 on KAN-1 failed");
    f.ticket_id = s("KAN-1");
    f.target_kind = s("run");
    f.target_id = s("r1");
    emit("run_failed", f.clone()).await;
    f.target_id = s("r2");
    f.title = "Run #2 on KAN-1 failed".into();
    emit("run_failed", f).await;
    let row = one_row("user").await;
    assert_eq!(
        (row.group_key.as_str(), row.count, row.target_id.as_deref()),
        ("run_failed:ticket:KAN-1", 2, Some("r2"))
    );
}

async fn one_row_by_key(key: &str) -> notification::Model {
    notification::Entity::find()
        .filter(notification::Column::GroupKey.eq(key))
        .order_by_asc(notification::Column::CreatedAt)
        .one(&database::conn())
        .await
        .expect("row")
        .unwrap_or_else(|| panic!("no row {key}"))
}

async fn quiet_and_switches() {
    // a mute makes an information row quiet (not in the panel or the count), but it is still written
    add_follow("user", "kind", "comment", "mute", None, None).await;
    emit("comment", fields(Some("p1"), &["user"], "c")).await;
    let r = one_row("user").await;
    assert!(!r.inapp && !r.desktop);
    clear().await;
    for (scope, scope_id, project) in
        [("project", "p1", None), ("ticket", "KAN-1", None), ("page", "pg1", None), ("kind", "comment", Some("p1"))]
    {
        add_follow("user", scope, scope_id, "mentions", project, None).await;
        let mut f = fields(Some("p1"), &["user"], "c");
        f.ticket_id = s("KAN-1");
        f.page_id = s("pg1");
        emit("comment", f).await;
        assert!(!one_row("user").await.inapp, "{scope}");
        clear().await;
    }
    // not a mute: following, another project's mute, another kind's, and one that ran out
    add_follow("user", "ticket", "KAN-1", "follow", None, None).await;
    add_follow("user", "project", "p9", "mute", None, None).await;
    add_follow("user", "kind", "lesson", "mute", None, None).await;
    add_follow("user", "kind", "comment", "mute", Some("p9"), None).await;
    add_follow("user", "ticket", "KAN-2", "mute", None, Some(ago(5))).await;
    let mut f = fields(Some("p1"), &["user"], "c");
    f.ticket_id = s("KAN-2");
    emit("comment", f).await;
    assert!(one_row("user").await.inapp);
    clear().await;
    // a Needs you row is never quiet
    add_follow("user", "kind", "mention", "mute", None, None).await;
    emit("mention", fields(Some("p1"), &["user"], "m")).await;
    let r = one_row("user").await;
    assert!(r.inapp && r.desktop);
    clear().await;

    // the person's switches: In app per kind (Needs you is locked on), desktop per kind and the master switch
    set_prefs(
        "user",
        json!({"events": {"ai_finished": {"inapp": false, "desktop": true}, "question": {"inapp": false, "desktop": false}}}),
    )
    .await;
    emit("ai_finished", fields(Some("p1"), &["user"], "a")).await;
    emit("question", fields(Some("p1"), &["user"], "q")).await;
    let a = one_row_by_key("ai_finished:p1").await;
    assert!(!a.inapp && a.desktop);
    let q = one_row_by_key("question:project:p1").await;
    assert!(q.inapp && !q.desktop);
    clear().await;
    set_prefs("user", json!({"desktop_on": false})).await;
    emit("question", fields(Some("p1"), &["user"], "q")).await;
    assert!(!one_row("user").await.desktop);
    // the defaults: desktop on for a question, off for "An AI team went offline" and for information
    clear().await;
    emit("offline", fields(Some("p1"), &["user"], "o")).await;
    emit("lesson", fields(Some("p1"), &["user"], "l")).await;
    assert!(rows_of("user").await.iter().all(|r| !r.desktop));
}

async fn what_the_features_write() {
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;
    add_member("mh", "p1", "Hoa Mai", "human", "admin").await;
    add_member("mt", "p1", "Tuan", "human", "member").await;
    add_ticket("KAN-1", "p1", Some("mt")).await;
    add_follow("linh", "ticket", "KAN-1", "follow", None, None).await;

    // recipients
    let conn = database::conn();
    let session = database::session();
    let keys = kb_notify::recipient_keys(
        &session,
        Some("p1"),
        &[Some(" Claude "), Some("ai:zz"), None, Some("YOU"), Some("Hoa Mai"), Some("hoa mai")],
    )
    .await
    .expect("keys");
    assert_eq!(keys, ["ai:mc", "ai:zz", "user", "hoa mai"]);
    assert_eq!(kb_notify::owners_and_admins(&session, Some("p1")).await.expect("admins"), ["user", "hoa mai"]);
    assert_eq!(kb_notify::owners_and_admins(&session, None).await.expect("admins"), ["user"]);
    assert_eq!(kb_notify::followers(&session, "ticket", Some("KAN-1")).await.expect("followers"), ["linh"]);
    assert!(kb_notify::followers(&session, "ticket", None).await.expect("followers").is_empty());
    assert_eq!(kb_notify::managed_projects(&session, "user").await.expect("managed"), None);
    assert_eq!(kb_notify::managed_projects(&session, "hoa mai").await.expect("managed").expect("some").len(), 1);
    assert!(kb_notify::may_manage(&session, "hoa mai").await.expect("may"));
    assert!(!kb_notify::may_manage(&session, "tuan").await.expect("may"));

    // an AI's question: for the person it asked and the one who started the run
    let asked = ago(20);
    add_run("r1", Some("KAN-1"), "needs_input", |r| {
        r.number = Set(4);
        r.question = Set(Some(
            json!({"text": format!("  {}  ", "Which database?"), "to": "Hoa Mai", "options": ["a", "b"], "asked_at": asked}).to_string(),
        ));
    })
    .await;
    kb_notify::on_run_question("r1", false, None, None).await;
    let hoa = one_row("hoa mai").await;
    assert_eq!(hoa.kind, "question");
    assert_eq!(hoa.title, "Claude asks a question");
    assert_eq!(hoa.body, "“Which database?”");
    assert_eq!(hoa.created_at, asked);
    assert_eq!(hoa.actor.as_deref(), Some("Claude"));
    assert_eq!(
        (hoa.target_kind.as_deref(), hoa.target_id.as_deref(), hoa.member_id.as_deref()),
        (Some("run"), Some("r1"), Some("mc"))
    );
    assert_eq!(
        serde_json::from_str::<Value>(&hoa.data).expect("data"),
        json!({"to": "Hoa Mai", "options": ["a", "b"], "run_number": 4})
    );
    assert_eq!(one_row("user").await.group_key, "question:run:r1");
    // a reminder is the same row coming back
    kb_notify::on_run_question("r1", true, None, None).await;
    assert_eq!(one_row("hoa mai").await.count, 1);
    assert!(serde_json::from_str::<Value>(&one_row("hoa mai").await.data).expect("data")["reminded_at"].is_string());
    // passed on to Linh: those who are no longer addressed see "Passed to Linh"
    let mut am: ai_run::ActiveModel =
        ai_run::Entity::find_by_id("r1").one(&conn).await.expect("run").expect("run").into();
    am.question = Set(Some(json!({"text": "Which?", "to": "Linh"}).to_string()));
    am.update(&conn).await.expect("update");
    kb_notify::on_run_question("r1", false, Some("Linh"), Some("Hoa Mai")).await;
    let hoa = one_row("hoa mai").await;
    assert_eq!(hoa.done_reason.as_deref(), Some("Passed to Linh"));
    assert_eq!(hoa.done_by.as_deref(), Some("Hoa Mai"));
    assert!(hoa.done_at.is_some());
    assert!(one_row("linh").await.done_at.is_none());
    assert!(one_row("user").await.done_at.is_none());
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;
    add_member("mh", "p1", "Hoa Mai", "human", "admin").await;
    add_member("mt", "p1", "Tuan", "human", "member").await;
    add_ticket("KAN-1", "p1", Some("mt")).await;
    add_follow("linh", "ticket", "KAN-1", "follow", None, None).await;
    // a run that is not there tells nothing
    kb_notify::on_run_question("missing", false, None, None).await;
    kb_notify::on_run_ended("missing").await;
    kb_notify::on_run_trouble("missing").await;
    kb_notify::on_window_urgent("missing", "2026-01-01T00:00:00+00:00", &[]).await;
    assert!(events().await.is_empty());

    // a run that finished: the person who started it, the assignee and the followers hear
    add_run("fin", Some("KAN-1"), "finished", |r| {
        r.report = Set(json!({"summary": "  Fixed the bug.\nSecond line"}).to_string());
        r.cost_usd = Set(0.0);
    })
    .await;
    kb_notify::on_run_ended("fin").await;
    for who in ["user", "tuan", "linh"] {
        let r = one_row(who).await;
        assert_eq!(
            (r.kind.as_str(), r.title.as_str(), r.body.as_str()),
            ("ai_finished", "Claude finished KAN-1", "Fixed the bug."),
            "{who}"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&r.data).expect("data"),
            json!({"run_number": 3, "state": "finished", "cost_usd": 0.0})
        );
    }
    assert!(rows_of("hoa mai").await.is_empty());
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;
    add_member("mh", "p1", "Hoa Mai", "human", "admin").await;
    // no summary, a failure, a timeout, a board fault, memory, a schedule's run, an archived ticket
    add_run("nosum", Some("KAN-1"), "finished", |_| {}).await;
    kb_notify::on_run_ended("nosum").await;
    assert_eq!(one_row("user").await.body, "AI summary ready for review.");
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;
    add_run("bad", Some("KAN-1"), "failed", |r| {
        r.ended_reason = Set(Some("Exit code 1".into()));
        r.diagnosis = Set(Some(json!({"cause": "x"}).to_string()));
    })
    .await;
    kb_notify::on_run_ended("bad").await;
    let r = one_row("user").await;
    assert_eq!(
        (r.kind.as_str(), r.title.as_str(), r.body.as_str()),
        ("run_failed", "Run #3 on KAN-1 failed", "Exit code 1")
    );
    assert_eq!(serde_json::from_str::<Value>(&r.data).expect("data")["diagnosis"], json!({"cause": "x"}));
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;
    add_run("late", Some("KAN-1"), "timed_out", |_| {}).await;
    add_run("fault", Some("KAN-2"), "failed", |r| {
        r.diagnosis = Set(Some(json!({"board_fault": true, "what": "The board lost the process"}).to_string()));
    })
    .await;
    add_run("mem", Some("KAN-3"), "failed", |r| r.stop_code = Set(Some("memory".into()))).await;
    add_run("sched", Some("KAN-4"), "failed", |r| r.trigger = Set("schedule".into())).await;
    add_run("sched_ok", Some("KAN-5"), "finished", |r| r.trigger = Set("schedule".into())).await;
    add_run("chatmode", Some("KAN-6"), "failed", |r| r.mode = Set("chat".into())).await;
    add_run("arch", Some("KAN-7"), "cancelled", |r| {
        r.stop_code = Set(Some("archive".into()));
        r.ended_by = Set(Some("Hoa".into()));
        r.number = Set(9);
    })
    .await;
    add_run("arch2", Some("KAN-8"), "cancelled", |r| r.stop_code = Set(Some("archive".into()))).await;
    add_run("cancelled", Some("KAN-9"), "cancelled", |_| {}).await;
    for id in ["late", "fault", "mem", "sched", "sched_ok", "chatmode", "arch", "arch2", "cancelled"] {
        kb_notify::on_run_ended(id).await;
    }
    let all: Vec<(String, String, String)> =
        rows_of("user").await.into_iter().map(|r| (r.kind, r.title, r.body)).collect();
    assert_eq!(
        all.iter().map(|(k, t, b)| (k.as_str(), t.as_str(), b.as_str())).collect::<Vec<_>>(),
        vec![
            ("run_failed", "Run #3 on KAN-1 timed out", ""),
            ("board_fault", "The board failed run #3 on KAN-2", "The board lost the process"),
            // two cancellations of one project inside 10 minutes are one row
            ("run_cancelled", "2 runs were cancelled", "Claude · KAN-7 to KAN-8"),
        ]
    );
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;

    // the chat open and in front of the person who asked: no "AI finished" for them
    let mut chat = ai_chat::new();
    chat.project_id = Set("p1".into());
    chat.owner = Set("user".into());
    chat.scope = Set("ticket".into());
    chat.scope_id = Set(Some("KAN-1".into()));
    chat.seen_at = Set(Some(iso(&(Utc::now() - Duration::seconds(10)))));
    chat.insert(&database::conn()).await.expect("chat");
    add_run("inchat", Some("KAN-1"), "finished", |r| r.trigger = Set("message".into())).await;
    kb_notify::on_run_ended("inchat").await;
    assert!(events().await.is_empty());
    let chat_row = ai_chat::Entity::find().one(&database::conn()).await.expect("chat").expect("chat");
    let mut am: ai_chat::ActiveModel = chat_row.into();
    am.seen_at = Set(Some(iso(&(Utc::now() - Duration::seconds(120)))));
    am.update(&database::conn()).await.expect("update");
    kb_notify::on_run_ended("inchat").await;
    assert_eq!(one_row("user").await.kind, "ai_finished");
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;
    add_member("mh", "p1", "Hoa Mai", "human", "owner").await;

    // a run that stopped moving: the people of the run and the owners and admins
    add_run("stuck", Some("KAN-1"), "running", |r| {
        r.diagnosis = Set(Some(json!({"cause": "silent", "quiet_s": 125, "what": "No output.", "means": "It may be stuck.", "actions": ["wait"]}).to_string()));
    })
    .await;
    kb_notify::on_run_trouble("stuck").await;
    let r = one_row("user").await;
    assert_eq!(
        (r.kind.as_str(), r.title.as_str(), r.body.as_str()),
        ("run_stuck", "Claude has produced nothing for 2 min on KAN-1", "No output. It may be stuck.")
    );
    assert_eq!(one_row("hoa mai").await.id.len(), 15);
    assert_eq!(r.actor.as_deref(), Some("Claude"));
    assert_eq!(serde_json::from_str::<Value>(&r.data).expect("data")["run_number"], 3);
    let mut am: ai_run::ActiveModel =
        ai_run::Entity::find_by_id("stuck").one(&database::conn()).await.expect("run").expect("run").into();
    am.diagnosis = Set(Some(json!({"cause": "busy", "quiet_s": 5}).to_string()));
    am.update(&database::conn()).await.expect("update");
    kb_notify::on_run_trouble("stuck").await;
    let r = one_row("user").await;
    assert_eq!(r.title, "Claude is still working on KAN-1: one command has run a long time");
    assert_eq!(r.body, "", "the same request keeps one row, with the latest words");
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;

    // urgent work waits for a window
    add_run("urgent", Some("KAN-1"), "queued", |_| {}).await;
    let until = "2026-06-01T10:30:00+00:00";
    let when = DateTime::parse_from_rfc3339(until).expect("time").with_timezone(&Local).format("%H:%M").to_string();
    kb_notify::on_window_urgent("urgent", until, &[json!({"id": "a1"}), json!({"id": "a2"})]).await;
    let r = one_row("user").await;
    assert_eq!(r.title, format!("Urgent KAN-1 waits for the usage window (reopens {when})"));
    assert_eq!(r.body, "2 other accounts have room: move it there.");
    assert_eq!(
        serde_json::from_str::<Value>(&r.data).expect("data"),
        json!({"until": until, "room": [{"id": "a1"}, {"id": "a2"}]})
    );
    clear().await;
    add_project("p1", "Proj One").await;
    add_run("urgent", Some("KAN-1"), "queued", |_| {}).await;
    kb_notify::on_window_urgent("urgent", "not a time", &[json!({"id": "a1"})]).await;
    let r = one_row("user").await;
    assert_eq!(r.title, "Urgent KAN-1 waits for the usage window (reopens )");
    assert_eq!(r.body, "1 other account has room: move it there.");
    clear().await;
    add_project("p1", "Proj One").await;
    add_run("urgent", Some("KAN-1"), "queued", |_| {}).await;
    kb_notify::on_window_urgent("urgent", "2026-06-01T10:30:00", &[]).await;
    assert_eq!(one_row("user").await.body, "No other Claude account has room right now.");

    // a page published: for the followers of its space or the page, not the author
    clear().await;
    add_follow("linh", "space", "p1", "follow", None, None).await;
    add_follow("tuan", "page", "pg1", "everything", None, None).await;
    add_follow("hoa", "page", "pg1", "follow", None, None).await;
    kb_notify::on_page_published(
        &json!({"project_id": "p1", "id": "pg1", "updated_by": "Hoa", "version": 3, "title": "Guide", "path": "guide"}),
        Some("  a note  "),
    )
    .await;
    assert_eq!(one_row("linh").await.title, "Hoa published v3 of Guide");
    let r = one_row("tuan").await;
    assert_eq!(
        (r.body.as_str(), r.target_kind.as_deref(), r.target_id.as_deref(), r.page_id.as_deref()),
        ("a note", Some("page"), Some("pg1"), Some("pg1"))
    );
    assert_eq!(serde_json::from_str::<Value>(&r.data).expect("data"), json!({"version": 3, "path": "guide"}));
    assert!(rows_of("hoa").await.is_empty(), "the author is not told");
    assert_eq!(events().await.len(), 1);
}

fn comment_fields(kind: &str, actor: &str, recipients: Value, mentioned: Value) -> kb_notify::CommentFields {
    kb_notify::CommentFields {
        project_id: "p1".into(),
        page_id: s("pg1"),
        thread_id: s("th1"),
        comment_id: s("cm1"),
        kind: kind.into(),
        actor: actor.into(),
        mentioned: mentioned.to_string(),
        recipients: recipients.to_string(),
        page_title: "Guide".into(),
        snippet: "Is this right?".into(),
    }
}

async fn comments_and_the_queues() {
    add_project("p1", "Proj One").await;
    add_member("mc", "p1", "Claude", "ai", "member").await;
    // a comment event: a mention is Needs you, a reply in a followed thread is information
    kb_notify::on_comment_event(comment_fields("created", "Hoa", json!(["Tuan", "Linh", "Claude"]), json!(["tuan"])))
        .await;
    let tuan = one_row("tuan").await;
    assert_eq!(
        (tuan.kind.as_str(), tuan.title.as_str(), tuan.body.as_str()),
        ("mention", "Hoa mentioned you", "“Is this right?”")
    );
    assert!(tuan.needs);
    assert_eq!(
        (tuan.target_kind.as_deref(), tuan.target_id.as_deref(), tuan.page_id.as_deref()),
        (Some("thread"), Some("th1"), Some("pg1"))
    );
    assert_eq!(
        serde_json::from_str::<Value>(&tuan.data).expect("data"),
        json!({"page_title": "Guide", "comment_id": "cm1", "event": "created"})
    );
    let linh = one_row("linh").await;
    assert_eq!(
        (linh.kind.as_str(), linh.title.as_str(), linh.body.as_str()),
        ("comment", "New reply in a thread you follow", "Hoa: “Is this right?”")
    );
    let ai = one_row("ai:mc").await;
    assert_eq!(ai.kind, "comment");
    clear().await;
    add_project("p1", "Proj One").await;
    kb_notify::on_comment_event(comment_fields("resolved", "user", json!(["Linh"]), json!([]))).await;
    assert_eq!(one_row("linh").await.title, "Someone resolved a thread on Guide");
    clear().await;
    add_project("p1", "Proj One").await;
    let mut ask = comment_fields("access_request", "Hoa", json!(["user"]), json!([]));
    ask.thread_id = None;
    ask.snippet = String::new();
    kb_notify::on_comment_event(ask).await;
    let r = one_row("user").await;
    assert_eq!(
        (r.kind.as_str(), r.title.as_str(), r.body.as_str(), r.target_kind.clone(), r.target_id.clone()),
        ("access_request", "Hoa asked for access to Docs", "", None, None)
    );
    clear().await;
    add_project("p1", "Proj One").await;

    // `comment_event` in a process without the loop: a task writes it right away
    let mut e = docs_comment_event::new();
    e.project_id = Set("p1".into());
    e.kind = Set("created".into());
    e.actor = Set("Hoa".into());
    e.recipients = Set(json!(["Linh"]).to_string());
    e.page_title = Set("Guide".into());
    e.thread_id = Set(Some("th1".into()));
    let e = e.insert(&database::conn()).await.expect("event");
    assert!(!kb_notify::loop_running());
    kb_notify::comment_event(&e);
    kb_notify::drain_background().await;
    assert_eq!(one_row("linh").await.kind, "comment");
    clear().await;
    add_project("p1", "Proj One").await;

    // with the loop running it is queued, and the loop (or `flush_pending`) writes it
    kb_notify::start();
    assert!(kb_notify::loop_running());
    kb_notify::stop().await;
    assert!(!kb_notify::loop_running());
    kb_notify::start();
    kb_notify::comment_event(&e);
    // the loop writes it within a second or two
    for _ in 0..40 {
        if !rows_of("linh").await.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(one_row("linh").await.kind, "comment");
    kb_notify::stop().await;
    clear().await;
    add_project("p1", "Proj One").await;
    add_member("mh", "p1", "Hoa Mai", "human", "admin").await;
    add_follow("tuan", "ticket", "KAN-1", "follow", None, None).await;

    // the queue of synchronous callers: names become keys, followers of the ticket are added, a scheduled slot
    // points at its last run
    let mut srun = ai_schedule_run::new();
    srun.id = Set("sr1".into());
    srun.schedule_id = Set("sc1".into());
    srun.project_id = Set("p1".into());
    srun.ticket_id = Set("KAN-1".into());
    srun.slot_at = Set(ago(5));
    srun.run_ids = Set(json!(["run_a", "run_b"]).to_string());
    srun.insert(&database::conn()).await.expect("schedule run");
    let mut f = fields(Some("p1"), &[], "Nightly run ended");
    f.target_kind = s("schedule_run");
    f.target_id = s("sr1");
    f.ticket_id = s("KAN-1");
    f.data = data(json!({"schedule_id": "sc1", "event": "skipped"}));
    kb_notify::enqueue(kb_notify::PendingEvent {
        kind: "schedule".into(),
        fields: f,
        names: Some(vec![Some("Hoa Mai".into()), None, Some("user".into())]),
        follow_ticket: s("KAN-1"),
    });
    kb_notify::enqueue(kb_notify::PendingEvent {
        kind: "nope".into(),
        fields: fields(None, &["user"], "bad"),
        ..Default::default()
    });
    assert_eq!(kb_notify::flush_pending().await.expect("flush"), 1);
    assert_eq!(kb_notify::flush_pending().await.expect("flush"), 0);
    let r = one_row("hoa mai").await;
    assert_eq!((r.target_kind.as_deref(), r.target_id.as_deref()), (Some("run"), Some("run_b")));
    assert_eq!(
        serde_json::from_str::<Value>(&r.data).expect("data"),
        json!({"schedule_id": "sc1", "event": "skipped", "srun_id": "sr1"})
    );
    for who in ["user", "tuan"] {
        assert_eq!(one_row(who).await.kind, "schedule");
    }
    assert_eq!(events().await.len(), 1);
    // what a test queued is dropped, not written into the next test's database
    kb_notify::enqueue(kb_notify::PendingEvent {
        kind: "lesson".into(),
        fields: fields(None, &["user"], "x"),
        ..Default::default()
    });
    kb_notify::clear_queues();
    assert_eq!(kb_notify::flush_pending().await.expect("flush"), 0);
    assert_eq!(events().await.len(), 1);
}

async fn time_is_injectable() {
    // quiet hours, for a time given
    let quiet_at = |h: u32, m: u32| -> DateTime<Utc> {
        Local.with_ymd_and_hms(2026, 6, 3, h, m, 0).earliest().expect("local time").with_timezone(&Utc)
    };
    let prefs = kb_notify::default_prefs();
    let prefs = prefs.as_object().expect("prefs").clone();
    assert!(kb_notify::in_quiet_hours(&prefs, Some(quiet_at(23, 0))));
    assert!(kb_notify::in_quiet_hours(&prefs, Some(quiet_at(7, 59))));
    assert!(!kb_notify::in_quiet_hours(&prefs, Some(quiet_at(8, 0))));
    assert!(!kb_notify::in_quiet_hours(&prefs, Some(quiet_at(12, 0))));
    assert!(kb_notify::in_quiet_hours(&prefs, Some(quiet_at(22, 0))));
    let mut same = prefs.clone();
    same.insert("quiet".into(), json!({"on": true, "start": "09:00", "end": "09:00"}));
    assert!(!kb_notify::in_quiet_hours(&same, Some(quiet_at(9, 0))));
    let mut day = prefs.clone();
    day.insert("quiet".into(), json!({"on": true, "start": "09:00", "end": "17:00"}));
    assert!(kb_notify::in_quiet_hours(&day, Some(quiet_at(9, 0))));
    assert!(!kb_notify::in_quiet_hours(&day, Some(quiet_at(17, 0))));
    let mut off = prefs.clone();
    off.insert("quiet".into(), json!({"on": false}));
    assert!(!kb_notify::in_quiet_hours(&off, Some(quiet_at(23, 0))));

    // remind_unanswered: after `remind_after_min`, once, not in quiet hours, not for AI or snoozed or read rows
    set_prefs("user", json!({"remind_after_min": 5, "quiet": {"on": true, "start": "22:00", "end": "08:00"}})).await;
    let conn = database::conn();
    let put =
        |id: &str, recipient: &str, updated: DateTime<Utc>, change: Box<dyn FnOnce(&mut notification::ActiveModel)>| {
            let id = id.to_string();
            let recipient = recipient.to_string();
            async move {
                let mut n = notification::new();
                n.id = Set(id.clone());
                n.recipient = Set(recipient);
                n.event_id = Set(1);
                n.last_event_id = Set(1);
                n.kind = Set("mention".into());
                n.needs = Set(true);
                // what `emit` computes for a Needs you row with this target, so a reminder merges into it
                n.target_kind = Set(s("x"));
                n.target_id = Set(Some(id.clone()));
                n.group_key = Set(format!("mention:x:{id}"));
                n.title = Set(format!("title {id}"));
                n.created_at = Set(iso(&updated));
                n.updated_at = Set(iso(&updated));
                change(&mut n);
                n.insert(&database::conn()).await.expect("row");
            }
        };
    let long_ago = quiet_at(10, 0);
    put("waits", "user", long_ago, Box::new(|_| {})).await;
    put("ai", "ai:m1", long_ago, Box::new(|_| {})).await;
    put("read", "user", long_ago, Box::new(|n| n.read_at = Set(s("2026-06-03T10:01:00+00:00")))).await;
    put("snoozed", "user", long_ago, Box::new(|n| n.snoozed_until = Set(s("2099-01-01T00:00:00+00:00")))).await;
    put("gone", "user", long_ago, Box::new(|n| n.data = Set(r#"{"gone": true}"#.into()))).await;
    put(
        "hidden",
        "user",
        long_ago,
        Box::new(|n| {
            n.inapp = Set(false);
            n.desktop = Set(false);
        }),
    )
    .await;
    put("fresh", "user", quiet_at(11, 58), Box::new(|_| {})).await;
    // in quiet hours: nothing
    assert_eq!(kb_notify::remind_unanswered(Some(quiet_at(23, 0))).await.expect("remind"), 0);
    // not yet for the one that waited 2 minutes, yes for the old one; once
    assert_eq!(kb_notify::remind_unanswered(Some(quiet_at(12, 0))).await.expect("remind"), 1);
    assert_eq!(kb_notify::remind_unanswered(Some(quiet_at(12, 0))).await.expect("remind"), 0);
    let waits = notification::Entity::find_by_id("waits").one(&conn).await.expect("row").expect("row");
    assert_eq!(waits.count, 1);
    assert!(serde_json::from_str::<Value>(&waits.data).expect("data")["reminded_at"].is_string());
    assert!(waits.read_at.is_none());
    // later the fresh one is due too (its minutes have passed)
    assert_eq!(kb_notify::remind_unanswered(Some(quiet_at(12, 10))).await.expect("remind"), 1);
    // reminders off
    set_prefs("hoa", json!({"remind_after_min": 0})).await;
    put("hoa_row", "hoa", long_ago, Box::new(|_| {})).await;
    assert_eq!(kb_notify::remind_unanswered(Some(quiet_at(12, 20))).await.expect("remind"), 0);
    let log = events().await;
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|e| e.kind == "mention" && e.data == r#"{"reminder": true}"#));

    // wake_snoozed: a snooze that ran out brings its rows back, one event per target
    clear().await;
    let t = |h: u32| quiet_at(h, 0);
    put(
        "s1",
        "user",
        t(8),
        Box::new(|n| {
            n.snoozed_until = Set(Some(iso(&quiet_at(9, 0))));
            n.read_at = Set(Some(iso(&quiet_at(8, 30))));
            n.target_kind = Set(s("run"));
            n.target_id = Set(s("r1"));
        }),
    )
    .await;
    put(
        "s2",
        "hoa",
        t(8),
        Box::new(|n| {
            n.snoozed_until = Set(Some(iso(&quiet_at(9, 30))));
            n.target_kind = Set(s("run"));
            n.target_id = Set(s("r1"));
        }),
    )
    .await;
    put("s3", "user", t(8), Box::new(|n| n.snoozed_until = Set(Some(iso(&quiet_at(18, 0)))))).await;
    put(
        "s4",
        "user",
        t(8),
        Box::new(|n| {
            n.snoozed_until = Set(Some(iso(&quiet_at(9, 0))));
            n.done_at = Set(Some(iso(&quiet_at(8, 5))));
        }),
    )
    .await;
    assert_eq!(kb_notify::wake_snoozed(Some(quiet_at(8, 59))).await.expect("wake"), None);
    let last = kb_notify::wake_snoozed(Some(quiet_at(10, 0))).await.expect("wake");
    let woke = events().await;
    let ev = &woke[0];
    assert_eq!(last, Some(ev.id));
    assert_eq!(
        (ev.op.as_str(), ev.kind.as_str(), ev.title.as_str(), ev.recipients.as_str()),
        ("wake", "mention", "title s1", r#"["hoa", "user"]"#)
    );
    assert!(ev.needs && ev.body.is_empty() && ev.data == "{}" && ev.actor.is_none());
    for id in ["s1", "s2"] {
        let r = notification::Entity::find_by_id(id).one(&conn).await.expect("row").expect("row");
        assert_eq!((r.snoozed_until.clone(), r.read_at.clone(), r.last_event_id), (None, None, ev.id), "{id}");
    }
    let r3 = notification::Entity::find_by_id("s3").one(&conn).await.expect("row").expect("row");
    assert!(r3.snoozed_until.is_some());
    let r4 = notification::Entity::find_by_id("s4").one(&conn).await.expect("row").expect("row");
    assert!(r4.snoozed_until.is_some() && r4.last_event_id == 1);

    // prune: retention deletes old rows and events, keeps open Needs you rows, and remembers the newest id
    clear().await;
    let old = Utc::now() - Duration::days(100);
    let mut ids = Vec::new();
    for (kind, when) in [("ai_finished", old), ("comment", old), ("lesson", Utc::now())] {
        let mut e = notify_event::new();
        e.kind = Set(kind.into());
        e.created_at = Set(iso(&when));
        ids.push(e.insert(&conn).await.expect("event").id);
    }
    put(
        "old_info",
        "user",
        old,
        Box::new(|n| {
            n.needs = Set(false);
            n.kind = Set("comment".into());
        }),
    )
    .await;
    put("old_open", "user", old, Box::new(|_| {})).await;
    put("old_done", "user", old, Box::new(|n| n.done_at = Set(Some(iso(&old))))).await;
    put("new_info", "user", Utc::now(), Box::new(|n| n.needs = Set(false))).await;
    assert_eq!(kb_notify::retention_days(&database::session()).await.expect("days"), 90);
    assert_eq!(kb_notify::prune(Some(Utc::now())).await.expect("prune"), 2);
    let left: Vec<String> = notification::Entity::find()
        .order_by_asc(notification::Column::Id)
        .all(&conn)
        .await
        .expect("rows")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(left, ["new_info", "old_open"]);
    assert_eq!(events().await.len(), 1);
    let g = kb_notify::global(&database::session()).await.expect("global");
    assert_eq!(g["pruned_through"], ids[1]);
    // a cursor below what was deleted is too old, and the head never goes back
    assert_eq!(kb_notify::head_id(&database::session()).await.expect("head"), ids[2]);
    let feed = kb_notify::feed(&database::session(), "user", Some(i64::from(ids[0]))).await.expect("feed");
    assert_eq!(feed["cursor_too_old"], true);
    let log = kb_notify::log_since(&database::session(), i64::from(ids[0]), None, 200, None).await.expect("log");
    assert_eq!(log["cursor_too_old"], true);
    // a shorter retention reaches rows younger than that, and the day count is the setting
    let s2 = database::session();
    kb_notify::set_global(&s2, &[("retention_days", json!(7))]).await.expect("set");
    s2.commit().await.expect("commit");
    assert_eq!(kb_notify::retention_days(&database::session()).await.expect("days"), 7);
    assert_eq!(kb_notify::prune(Some(Utc::now() + Duration::days(8))).await.expect("prune"), 1);
    assert_eq!(kb_notify::head_id(&database::session()).await.expect("head"), ids[2]);

    // write_day_cards at a given time: weekdays at 18:00 by default, once a day, from the last scheduled card
    clear().await;
    add_project("p1", "Proj One").await;
    let at_local = |day: u32, h: u32, m: u32| -> DateTime<Utc> {
        Local.with_ymd_and_hms(2026, 6, day, h, m, 0).earliest().expect("local").with_timezone(&Utc)
    };
    // 2026-06-03 is a Wednesday, 2026-06-06 a Saturday
    assert_eq!(
        Local.with_ymd_and_hms(2026, 6, 3, 12, 0, 0).earliest().expect("local").weekday().num_days_from_monday(),
        2
    );
    assert_eq!(kb_notify::write_day_cards(Some(at_local(3, 17, 59)), None).await.expect("cards"), 0);
    assert_eq!(kb_notify::write_day_cards(Some(at_local(6, 18, 30)), None).await.expect("cards"), 0);
    assert_eq!(kb_notify::write_day_cards(Some(at_local(3, 18, 0)), None).await.expect("cards"), 1);
    let card = one_row("user").await;
    assert_eq!(card.kind, "day_card");
    assert_eq!(card.target_kind.as_deref(), Some("day"));
    assert_eq!(card.target_id.as_deref(), Some("user:2026-06-03"));
    assert_eq!(card.title, "Today on your boards");
    assert_eq!(card.body, "Wed 03 Jun · 18:00 · 0 projects");
    let facts: Value = serde_json::from_str(&card.data).expect("data");
    assert_eq!(facts["quiet"], true);
    assert_eq!(facts["until"], json!(iso(&at_local(3, 18, 0))));
    assert_eq!(
        facts["since"],
        json!(iso(&Local.with_ymd_and_hms(2026, 6, 3, 0, 0, 0).earliest().expect("local").with_timezone(&Utc)))
    );
    // once a day, even when asked again later
    assert_eq!(kb_notify::write_day_cards(Some(at_local(3, 19, 0)), None).await.expect("cards"), 0);
    // a card asked for now neither stands in for it nor counts as the last one
    assert_eq!(kb_notify::write_day_cards(Some(at_local(3, 19, 0)), Some("user")).await.expect("cards"), 1);
    let forced = rows_of("user")
        .await
        .into_iter()
        .find(|r| r.target_id.as_deref().is_some_and(|t| t.contains(":now:")))
        .expect("forced");
    assert_eq!(forced.target_id, Some(format!("user:2026-06-03:now:{}", at_local(3, 19, 0).timestamp())));
    // the next scheduled card counts from the last scheduled one
    assert_eq!(kb_notify::write_day_cards(Some(at_local(4, 18, 5)), None).await.expect("cards"), 1);
    let next =
        rows_of("user").await.into_iter().find(|r| r.target_id.as_deref() == Some("user:2026-06-04")).expect("next");
    let facts: Value = serde_json::from_str(&next.data).expect("data");
    assert_eq!(facts["since"], json!(card.created_at));
    // a person who turned it off, or moved its time
    set_prefs("hoa", json!({"day_card": {"on": false}})).await;
    set_prefs("tuan", json!({"day_card": {"time": "19:00", "days": [0, 1, 2, 3, 4, 5, 6]}})).await;
    assert_eq!(kb_notify::write_day_cards(Some(at_local(6, 18, 30)), None).await.expect("cards"), 0);
    assert_eq!(kb_notify::write_day_cards(Some(at_local(6, 19, 0)), None).await.expect("cards"), 1);
    assert_eq!(rows_of("tuan").await.len(), 1);
    assert!(rows_of("hoa").await.is_empty());
    assert!(rows_of("user").await.iter().all(|r| r.target_id.as_deref() != Some("user:2026-06-06")));
}

async fn reconcile_and_resolve() {
    add_project("p1", "Proj One").await;
    // resolve_target closes every open Needs you row that points at a thing, for every recipient
    for who in ["user", "hoa"] {
        let mut f = fields(Some("p1"), &[who], "Claude asks");
        f.target_kind = s("run");
        f.target_id = s("r1");
        emit("question", f).await;
    }
    let mut f = fields(Some("p1"), &["user"], "Merge conflict");
    f.target_kind = s("run");
    f.target_id = s("r1");
    emit("merge_conflict", f).await;
    assert_eq!(
        kb_notify::resolve_target("run", "r1", "Answered", Some("Hoa"), Some(&["question"])).await.expect("resolve"),
        2
    );
    assert_eq!(
        kb_notify::resolve_target("run", "r1", "Answered", None, Some(&["question"])).await.expect("resolve"),
        0
    );
    let r = one_row("hoa").await;
    assert_eq!((r.done_reason.as_deref(), r.done_by.as_deref()), (Some("Answered"), Some("Hoa")));
    let log = events().await;
    let resolve: Vec<_> = log.iter().filter(|e| e.op == "resolve").collect();
    assert_eq!(resolve.len(), 1);
    assert_eq!(resolve[0].recipients, r#"["hoa", "user"]"#);
    assert_eq!(resolve[0].data, r#"{"gone": false}"#);
    assert_eq!(resolve[0].actor.as_deref(), Some("Hoa"));
    assert_eq!(kb_notify::resolve_target("run", "r1", "All", None, None).await.expect("resolve"), 1);
    // reconcile: the run is not there, so the rows say so and wait for Dismiss
    clear().await;
    let mut f = fields(Some("p1"), &["user"], "Claude asks");
    f.target_kind = s("run");
    f.target_id = s("ghost");
    emit("question", f).await;
    assert_eq!(kb_notify::reconcile().await.expect("reconcile"), 0);
    let r = one_row("user").await;
    assert!(r.done_at.is_none());
    assert_eq!(
        serde_json::from_str::<Value>(&r.data).expect("data"),
        json!({"gone": true, "gone_reason": "The run is gone."})
    );
}

async fn log_and_head() {
    let session = database::session();
    assert_eq!(kb_notify::head_id(&session).await.expect("head"), 0);
    let first = emit("lesson", fields(None, &["user"], "l")).await;
    let second = emit("lesson", fields(None, &["user"], "l")).await;
    assert_eq!(second, first + 1, "ids only go up");
    assert_eq!(kb_notify::head_id(&session).await.expect("head"), second);
    let log = kb_notify::log_since(&session, 0, None, 1, None).await.expect("log");
    assert_eq!(log["events"].as_array().expect("events").len(), 1);
    // an announcement says where the log is
    let sub = kb_base::events::subscribe();
    let third = emit("lesson", fields(None, &["user"], "l")).await;
    let msg = sub.recv().await;
    assert_eq!(msg, format!(r#"{{"type": "invalidate", "topics": ["notifications"], "head": {third}}}"#));
    kb_base::events::unsubscribe(&sub);
}
