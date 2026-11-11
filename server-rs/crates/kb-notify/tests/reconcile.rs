//! What the server does on its own: `reconcile` closes rows whose thing no longer needs a person (run on every list
//! and feed), notes AI accounts that signed out, the loop wakes snoozed rows and reminds unanswered ones, and the
//! day card counts the day. Rows of other areas (runs, tickets, accounts) are written into the SQLite file.
//! Run with `PARITY_TARGET=python` first, then `rust`.

mod common;

use std::time::Duration;

use common::{Event, Nrow, ai_run, at, insert, member, pool, project, table, ticket, update};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

async fn rows(c: &Client) -> Vec<Value> {
    let r = c.get("/notifications?limit=500").await;
    r.assert_status(200);
    r.json()["items"].as_array().expect("items").clone()
}

fn by_id<'a>(rows: &'a [Value], id: &str) -> &'a Value {
    rows.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("no row {id}"))
}

fn needs(id: &str, kind: &str) -> Nrow {
    let mut n = Nrow::new(id, kind, true, id);
    n.group_key = format!("{kind}:{id}");
    n
}

async fn wait_for<F, Fut>(what: &str, seconds: u64, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while std::time::Instant::now() < deadline {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    panic!("gave up waiting for {what}");
}

#[tokio::test]
async fn reconcile_closes_what_no_longer_needs_a_person_and_says_why() {
    if !skip_unless_available("reconcile_closes_what_no_longer_needs_a_person_and_says_why") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    project(&db, "p1", "Proj One").await;
    ticket(&db, "KAN-1", "p1").await;
    // runs
    ai_run(&db, "r_wait", "p1", None, "needs_input", &[]).await;
    ai_run(
        &db,
        "r_ans",
        "p1",
        None,
        "running",
        &[(
            "question",
            json!(r#"{"answered_at": "2026-01-01T00:00:00+00:00", "answered_via": "mcp", "answered_by": "Hoa"}"#),
        )],
    )
    .await;
    ai_run(&db, "r_end", "p1", None, "timed_out", &[("ended_by", json!("Tuan"))]).await;
    ai_run(&db, "r_end2", "p1", None, "cancelled", &[]).await;
    ai_run(&db, "r_run", "p1", None, "running", &[]).await;
    ai_run(&db, "r_diag", "p1", None, "running", &[("diagnosis", json!(r#"{"cause": "silent", "quiet_s": 300}"#))])
        .await;
    ai_run(
        &db,
        "r_clr",
        "p1",
        None,
        "starting",
        &[("diagnosis", json!(r#"{"cleared_at": "x", "cleared_why": "Someone chose to wait"}"#))],
    )
    .await;
    ai_run(&db, "r_queued", "p1", None, "queued", &[]).await;
    ai_run(
        &db,
        "r_new",
        "p1",
        Some("KAN-1"),
        "running",
        &[("number", json!(7)), ("started_by", json!("Linh")), ("queued_at", json!(at(-100)))],
    )
    .await;
    // accounts, teams, settings, threads
    insert(
        &db,
        "ai_account",
        &[
            ("id", json!("acc_in")),
            ("name", json!("In")),
            ("cli", json!("claude")),
            ("folder", json!("/x")),
            ("status", json!("signed_in")),
            ("created_at", json!(at(-9))),
            ("updated_at", json!(at(-9))),
        ],
    )
    .await;
    insert(
        &db,
        "ai_account",
        &[
            ("id", json!("acc_out")),
            ("name", json!("Out")),
            ("cli", json!("claude")),
            ("folder", json!("/y")),
            ("status", json!("cli_missing")),
            ("created_at", json!(at(-9))),
            ("updated_at", json!(at(-9))),
        ],
    )
    .await;
    insert(&db, "ai_project_settings", &[("project_id", json!("p1"))]).await;
    insert(
        &db,
        "ai_team",
        &[
            ("id", json!("team_ok")),
            ("project_id", json!("p1")),
            ("created_at", json!(at(-9))),
            ("updated_at", json!(at(-9))),
        ],
    )
    .await;
    insert(
        &db,
        "ai_team",
        &[
            ("id", json!("team_paused")),
            ("project_id", json!("p1")),
            ("paused", json!(1)),
            ("created_at", json!(at(-9))),
            ("updated_at", json!(at(-9))),
        ],
    )
    .await;
    insert(
        &db,
        "docs_comment_thread",
        &[("id", json!("th1")), ("page_id", json!("pg")), ("created_by", json!("x")), ("created_at", json!(at(-9)))],
    )
    .await;
    insert(
        &db,
        "docs_comment_thread",
        &[("id", json!("th2")), ("page_id", json!("pg")), ("created_by", json!("x")), ("created_at", json!(at(-9)))],
    )
    .await;
    insert(
        &db,
        "docs_comment",
        &[
            ("id", json!("cm1")),
            ("thread_id", json!("th2")),
            ("author", json!("You")),
            ("body", json!("ok")),
            ("created_at", json!(at(-1))),
        ],
    )
    .await;
    insert(
        &db,
        "canvas_thread",
        &[("id", json!("cth1")), ("canvas_id", json!("cv")), ("created_by", json!("x")), ("created_at", json!(at(-9)))],
    )
    .await;

    let mut list: Vec<Nrow> = Vec::new();
    let mut add = |mut n: Nrow, f: &dyn Fn(&mut Nrow)| {
        f(&mut n);
        list.push(n);
    };
    add(needs("q_open", "question"), &|n| (n.target_kind, n.target_id) = (Some("run".into()), Some("r_wait".into())));
    add(needs("q_answered", "question"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_ans".into()))
    });
    add(needs("q_ended", "question"), &|n| (n.target_kind, n.target_id) = (Some("run".into()), Some("r_end".into())));
    add(needs("gone_run", "question"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_missing".into()))
    });
    add(needs("gone_ticket", "run_failed"), &|n| n.ticket_id = Some("KAN-99".into()));
    add(needs("retried", "run_failed"), &|n| {
        n.ticket_id = Some("KAN-1".into());
        n.updated_at = at(-600);
    });
    add(needs("stuck_ended", "run_stuck"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_end2".into()))
    });
    add(needs("stuck_moving", "run_stuck"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_run".into()))
    });
    add(needs("stuck_open", "run_stuck"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_diag".into()))
    });
    add(needs("stuck_cleared", "run_stuck"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_clr".into()))
    });
    add(needs("win_started", "window_urgent"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_run".into()))
    });
    add(needs("win_open", "window_urgent"), &|n| {
        (n.target_kind, n.target_id) = (Some("run".into()), Some("r_queued".into()))
    });
    add(needs("budget_old", "budget"), &|n| n.created_at = at(-3 * 86400));
    add(needs("budget_today", "budget"), &|n| n.project_id = Some("p1".into()));
    add(needs("trip_resumed", "auto_trip"), &|n| n.project_id = Some("p1".into()));
    add(needs("trip_team_gone", "auto_trip"), &|n| {
        (n.target_kind, n.target_id) = (Some("member".into()), Some("team_none".into()))
    });
    add(needs("trip_team_resumed", "auto_trip"), &|n| {
        (n.target_kind, n.target_id) = (Some("member".into()), Some("team_ok".into()))
    });
    add(needs("trip_team_paused", "auto_trip"), &|n| {
        (n.target_kind, n.target_id) = (Some("member".into()), Some("team_paused".into()))
    });
    add(needs("acc_in", "account_signed_out"), &|n| {
        (n.target_kind, n.target_id) = (Some("account".into()), Some("acc_in".into()))
    });
    add(needs("acc_missing", "account_signed_out"), &|n| {
        (n.target_kind, n.target_id) = (Some("account".into()), Some("acc_none".into()))
    });
    add(needs("acc_out", "account_signed_out"), &|n| {
        (n.target_kind, n.target_id) = (Some("account".into()), Some("acc_out".into()))
    });
    add(needs("th_gone", "mention"), &|n| {
        (n.target_kind, n.target_id) = (Some("thread".into()), Some("th_none".into()))
    });
    add(needs("th_open", "mention"), &|n| (n.target_kind, n.target_id) = (Some("thread".into()), Some("th1".into())));
    add(needs("th_replied", "mention"), &|n| {
        (n.target_kind, n.target_id) = (Some("thread".into()), Some("th2".into()))
    });
    add(needs("th_ai", "mention"), &|n| {
        n.recipient = "ai:mem-ai".into();
        (n.target_kind, n.target_id) = (Some("thread".into()), Some("th2".into()));
    });
    add(needs("cv_gone", "mention"), &|n| {
        (n.target_kind, n.target_id) = (Some("canvas_thread".into()), Some("cth_none".into()))
    });
    add(needs("cv_open", "mention"), &|n| {
        (n.target_kind, n.target_id) = (Some("canvas_thread".into()), Some("cth1".into()))
    });
    add(needs("off_plain", "offline"), &|_| {});
    add(needs("off_account", "offline"), &|n| {
        (n.target_kind, n.target_id) = (Some("account".into()), Some("acc_in".into()))
    });
    add(needs("conflict", "merge_conflict"), &|_| {});
    add(needs("arbit", "arbitration"), &|_| {});
    for n in &list {
        n.insert(&db).await;
    }
    let c = s.client();

    let first = rows(&c).await;
    let state = |id: &str| {
        let r = by_id(&first, id);
        (
            r["done"].as_bool().expect("done"),
            r["gone"].as_bool().expect("gone"),
            r["done_text"].clone(),
            r["gone_reason"].clone(),
            r["done_by"].clone(),
        )
    };
    let open = (false, false, Value::Null, Value::Null, Value::Null);
    let closed = |text: &str, by: Value| (true, false, json!(text), Value::Null, by);
    let gone = |why: &str| (false, true, Value::Null, json!(why), Value::Null);
    for id in [
        "q_open",
        "stuck_open",
        "win_open",
        "budget_today",
        "trip_team_paused",
        "acc_out",
        "th_open",
        "cv_open",
        "off_plain",
        "conflict",
        "arbit",
    ] {
        assert_eq!(state(id), open, "{id}");
    }
    assert_eq!(state("q_answered"), closed("Hoa answered over MCP", json!("Hoa")));
    assert_eq!(state("q_ended"), closed("The run ended (timed out).", json!("Tuan")));
    assert_eq!(state("gone_run"), gone("The run is gone."));
    assert_eq!(state("gone_ticket"), gone("KAN-99 was deleted, so this cannot be answered."));
    assert_eq!(state("retried"), closed("Linh retried: run #7 started", json!("Linh")));
    assert_eq!(state("stuck_ended"), closed("The run ended (cancelled).", Value::Null));
    assert_eq!(state("stuck_moving"), closed("It started moving again.", Value::Null));
    assert_eq!(state("stuck_cleared"), closed("Someone chose to wait", Value::Null));
    assert_eq!(state("win_started"), closed("The run started.", Value::Null));
    assert_eq!(state("budget_old"), closed("The day rolled over", Value::Null));
    assert_eq!(state("trip_resumed"), closed("AI was resumed", Value::Null));
    assert_eq!(state("trip_team_gone"), gone("The AI team was removed."));
    assert_eq!(state("trip_team_resumed"), closed("The AI team was resumed", Value::Null));
    assert_eq!(state("acc_in"), closed("The account signed in again", Value::Null));
    assert_eq!(state("acc_missing"), gone("The account was removed."));
    assert_eq!(state("th_gone"), gone("The thread is gone."));
    assert_eq!(state("th_replied"), closed("You replied", json!("user")));
    assert_eq!(state("cv_gone"), gone("The comment thread is gone."));
    assert_eq!(state("off_account"), closed("The account signed in again", Value::Null));
    // a mention of an AI in a Docs thread closes only when the thread goes (an AI does not reply in Docs)
    let ai_row = table(&db, "notification").await.into_iter().find(|r| r["id"] == "th_ai").expect("th_ai");
    assert_eq!(ai_row["done_at"], Value::Null);
    // a row that is gone says so once and offers only Dismiss
    let g = by_id(&first, "gone_run");
    assert_eq!(g["actions"], json!([{"id": "dismiss", "label": "Dismiss"}]));
    assert_eq!(g["dismissable"], true);
    assert_eq!(g["data"], json!({"gone": true, "gone_reason": "The run is gone."}));

    // one resolve event per target that closed, and nothing the second time
    let log = c.get("/notifications/log").await.json();
    let events = log["events"].as_array().expect("events").clone();
    assert!(events.iter().all(|e| e["op"] == "resolve" && e["needs"] == true), "{log}");
    let titles: Vec<&str> = events.iter().map(|e| e["title"].as_str().expect("title")).collect();
    assert_eq!(events.len(), 13, "{titles:?}");
    let replied = events.iter().find(|e| e["title"] == "{who} replied").expect("replied");
    assert_eq!(replied["actor"], "user");
    assert_eq!(replied["target_kind"], "thread");
    assert_eq!(replied["target_id"], "th2");
    assert_eq!(replied["recipients"], json!(["user"]));
    assert_eq!(replied["data"], json!({"gone": false}));
    let second = rows(&c).await;
    assert_eq!(second.len(), first.len());
    assert_eq!(c.get("/notifications/log").await.json()["head"], log["head"]);
    // closing a row writes the resolve event but leaves the row's own `last_event_id`; the feed names the rows that
    // closed (those with a target) so a toast or desktop notice for them is withdrawn
    let feed = c.get("/notifications/feed?since=0").await.json();
    let mut resolved: Vec<String> =
        feed["resolved"].as_array().expect("resolved").iter().map(|r| r.as_str().expect("id").to_string()).collect();
    resolved.sort();
    let mut expected: Vec<&str> = vec![
        "q_answered",
        "q_ended",
        "stuck_ended",
        "stuck_moving",
        "stuck_cleared",
        "win_started",
        "trip_team_resumed",
        "acc_in",
        "th_replied",
        "off_account",
    ];
    expected.sort_unstable();
    assert_eq!(resolved, expected);
    s.stop().await;
}

#[tokio::test]
async fn an_account_found_signed_out_is_told_once_to_the_people_who_run_the_teams() {
    if !skip_unless_available("an_account_found_signed_out_is_told_once_to_the_people_who_run_the_teams") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    project(&db, "p1", "Proj One").await;
    project(&db, "p2", "Proj Two").await;
    member(&db, "m1", "p1", "Hoa Mai", "human", "admin").await;
    member(&db, "m2", "p2", "Tuan", "human", "owner").await;
    member(&db, "m3", "p1", "Linh", "human", "member").await;
    let signed_out = at(-60);
    insert(
        &db,
        "ai_account",
        &[
            ("id", json!("acc1")),
            ("name", json!("Work")),
            ("cli", json!("claude")),
            ("folder", json!("/a")),
            ("status", json!("needs_sign_in")),
            ("signed_out_at", json!(signed_out)),
            ("signed_out_how", json!("token expired")),
            ("created_at", json!(at(-90))),
            ("updated_at", json!(at(-90))),
        ],
    )
    .await;
    insert(
        &db,
        "ai_account",
        &[
            ("id", json!("acc2")),
            ("name", json!("Spare")),
            ("cli", json!("claude")),
            ("folder", json!("/b")),
            ("status", json!("needs_sign_in")),
            ("signed_out_at", json!(at(-50))),
            ("created_at", json!(at(-90))),
            ("updated_at", json!(at(-90))),
        ],
    )
    .await;
    insert(
        &db,
        "ai_team",
        &[
            ("id", json!("t1")),
            ("project_id", json!("p1")),
            ("account_id", json!("acc1")),
            ("created_at", json!(at(-90))),
            ("updated_at", json!(at(-90))),
        ],
    )
    .await;
    insert(
        &db,
        "ai_account",
        &[
            ("id", json!("acc3")),
            ("name", json!("Shared")),
            ("cli", json!("claude")),
            ("folder", json!("/c")),
            ("status", json!("needs_sign_in")),
            ("signed_out_at", json!(at(-40))),
            ("created_at", json!(at(-90))),
            ("updated_at", json!(at(-90))),
        ],
    )
    .await;
    insert(
        &db,
        "ai_team",
        &[
            ("id", json!("t2")),
            ("project_id", json!("p1")),
            ("account_id", json!("acc3")),
            ("created_at", json!(at(-90))),
            ("updated_at", json!(at(-90))),
        ],
    )
    .await;
    insert(
        &db,
        "ai_team",
        &[
            ("id", json!("t3")),
            ("project_id", json!("p2")),
            ("account_id", json!("acc3")),
            ("created_at", json!(at(-90))),
            ("updated_at", json!(at(-90))),
        ],
    )
    .await;
    let c = s.client();

    let user_rows = rows(&c).await;
    let kinds: Vec<&str> = user_rows.iter().map(|r| r["kind"].as_str().expect("kind")).collect();
    assert_eq!(kinds.len(), 3, "{kinds:?}");
    assert!(kinds.iter().all(|k| *k == "account_signed_out"));
    let find = |target: &str| {
        user_rows.iter().find(|r| r["target_id"] == target).unwrap_or_else(|| panic!("row for {target}")).clone()
    };
    let one = find("acc1");
    assert_eq!(one["title"], "Work is signed out");
    assert_eq!(one["body"], "1 AI team on this account stopped. Their queued runs are held.");
    assert_eq!(one["project_id"], "p1");
    assert_eq!(one["target_kind"], "account");
    assert_eq!(one["needs"], true);
    assert_eq!(one["data"], json!({"members": 1, "how": "token expired"}));
    assert_eq!(one["actions"], json!([{"id": "sign_in", "label": "Sign in again"}]));
    assert_eq!(one["dismissable"], false);
    assert_eq!(one["group_key"], "account_signed_out:account:acc1");
    let none = find("acc2");
    assert_eq!(none["body"], "No AI team uses it right now.");
    assert_eq!(none["project_id"], Value::Null);
    assert_eq!(none["data"], json!({"members": 0, "how": null}));
    let both = find("acc3");
    assert_eq!(both["body"], "2 AI teams on this account stopped. Their queued runs are held.");
    assert_eq!(both["project_id"], Value::Null);
    // who is told: the board's own user, and the owners and admins of the projects the account's teams are in
    let hoa = s.client().header("X-Actor", "Hoa Mai");
    let tuan = s.client().header("X-Actor", "Tuan");
    let linh = s.client().header("X-Actor", "Linh");
    let targets = |rows: &[Value]| {
        let mut t: Vec<String> = rows.iter().map(|r| r["target_id"].as_str().expect("target").to_string()).collect();
        t.sort();
        t
    };
    assert_eq!(targets(&rows(&hoa).await), ["acc1", "acc3"]);
    assert_eq!(targets(&rows(&tuan).await), ["acc3"]);
    assert!(rows(&linh).await.is_empty());
    let events = c.get("/notifications/log").await.json()["events"].as_array().expect("events").clone();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["recipients"], json!(["user", "hoa mai"]));
    assert_eq!(events[0]["data"], json!({"members": 1, "how": "token expired"}));
    assert_eq!(events[0]["project_id"], "p1");
    assert_eq!(events[1]["recipients"], json!(["user"]));
    assert_eq!(events[2]["recipients"], json!(["user", "hoa mai", "tuan"]));
    // not told again
    rows(&c).await;
    assert_eq!(c.get("/notifications/log").await.json()["events"].as_array().expect("events").len(), 3);

    // signed in again: the row closes
    update(&db, "ai_account", "id", "acc1", &[("status", json!("signed_in"))]).await;
    let after = rows(&c).await;
    let closed = after.iter().find(|r| r["target_id"] == "acc1").expect("row").clone();
    assert_eq!(closed["done"], true);
    assert_eq!(closed["done_text"], "The account signed in again");
    // and a new sign-out is a new notification
    update(&db, "ai_account", "id", "acc1", &[("status", json!("needs_sign_in")), ("signed_out_at", json!(at(0)))])
        .await;
    let again = rows(&c).await;
    let open: Vec<&Value> = again.iter().filter(|r| r["target_id"] == "acc1").collect();
    assert_eq!(open.len(), 2);
    assert_eq!(open.iter().filter(|r| r["done"] == false).count(), 1);
    assert_eq!(
        table(&db, "notify_event")
            .await
            .iter()
            .filter(|e| e["kind"] == "account_signed_out" && e["op"] == "new")
            .count(),
        4
    );
    s.stop().await;
}

#[tokio::test]
async fn the_loop_wakes_a_snoozed_row_when_its_time_is_up() {
    if !skip_unless_available("the_loop_wakes_a_snoozed_row_when_its_time_is_up") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    let mut due = Nrow::new("due", "mention", true, "Hoa mentioned you");
    due.snoozed_until = Some(at(-5));
    due.read_at = Some(at(-100));
    due.project_id = Some("p1".into());
    due.insert(&db).await;
    let mut done = Nrow::new("done", "mention", true, "Already closed");
    done.group_key = "mention:done".into();
    done.snoozed_until = Some(at(-5));
    done.done_at = Some(at(-50));
    done.insert(&db).await;
    let mut later = Nrow::new("later", "schedule", false, "Nightly run ended");
    later.snoozed_until = Some("2099-01-01T00:00:00+00:00".into());
    later.insert(&db).await;
    let c = s.client();
    // any announcement makes the loop look at once
    c.patch("/notifications/settings", json!({})).await.assert_status(200);
    wait_for("the wake event", 15, || async {
        c.get("/notifications/log").await.json()["events"]
            .as_array()
            .is_some_and(|e| e.iter().any(|x| x["op"] == "wake"))
    })
    .await;
    let log = c.get("/notifications/log").await.json();
    let events = log["events"].as_array().expect("events").clone();
    assert_eq!(events.len(), 1, "{log}");
    let wake = &events[0];
    assert_eq!(wake["op"], "wake");
    assert_eq!(wake["kind"], "mention");
    assert_eq!(wake["needs"], true);
    assert_eq!(wake["title"], "Hoa mentioned you");
    assert_eq!(wake["project_id"], "p1");
    assert_eq!(wake["recipients"], json!(["user"]));
    assert_eq!(wake["data"], json!({}));
    assert_eq!(wake["body"], "");
    let all = rows(&c).await;
    let row = by_id(&all, "due");
    assert_eq!(row["snoozed"], false);
    assert_eq!(row["snoozed_until"], Value::Null);
    assert_eq!(row["read"], false);
    assert_eq!(row["last_event_id"], wake["id"]);
    assert_eq!(by_id(&all, "later")["snoozed"], true);
    assert_eq!(by_id(&all, "done")["last_event_id"], 1);
    // the feed brings it back to the notifier
    let feed = c.get("/notifications/feed?since=0").await.json();
    assert!(feed["items"].as_array().expect("items").iter().any(|i| i["id"] == "due"));
    s.stop().await;
}

#[tokio::test]
async fn the_loop_reminds_a_needs_you_row_once_when_it_stays_unanswered() {
    if !skip_unless_available("the_loop_reminds_a_needs_you_row_once_when_it_stays_unanswered") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    let c = s.client();
    c.patch("/notifications/settings", json!({"remind_after_min": 5, "quiet": {"on": false}})).await.assert_status(200);
    let mut waits = Nrow::new("waits", "mention", true, "Hoa mentioned you");
    waits.group_key = "mention:project:-".into();
    waits.created_at = at(-900);
    waits.updated_at = at(-600);
    waits.items = r#"[{"event_id": 1, "title": "Hoa mentioned you"}]"#.into();
    waits.insert(&db).await;
    let mut read = Nrow::new("read", "mention", true, "Read already");
    read.group_key = "mention:read".into();
    read.updated_at = at(-600);
    read.read_at = Some(at(-300));
    read.insert(&db).await;
    let mut fresh = Nrow::new("fresh", "mention", true, "Just now");
    fresh.group_key = "mention:fresh".into();
    fresh.updated_at = at(-30);
    fresh.insert(&db).await;
    let mut ai = Nrow::new("ai", "mention", true, "For an AI");
    ai.group_key = "mention:ai".into();
    ai.recipient = "ai:mem-ai".into();
    ai.updated_at = at(-600);
    ai.insert(&db).await;
    // the loop looks for these every 30 seconds
    wait_for("the reminder", 50, || async {
        c.get("/notifications/log").await.json()["events"].as_array().is_some_and(|e| !e.is_empty())
    })
    .await;
    let log = c.get("/notifications/log").await.json();
    let events = log["events"].as_array().expect("events").clone();
    assert_eq!(events.len(), 1, "{log}");
    assert_eq!(events[0]["op"], "new");
    assert_eq!(events[0]["kind"], "mention");
    assert_eq!(events[0]["title"], "Hoa mentioned you");
    assert_eq!(events[0]["data"], json!({"reminder": true}));
    assert_eq!(events[0]["recipients"], json!(["user"]));
    let all = rows(&c).await;
    let row = by_id(&all, "waits");
    // the same row comes back: one item, unread, and it remembers it reminded
    assert_eq!(row["count"], 1);
    assert_eq!(row["items"], json!([{"event_id": 1, "title": "Hoa mentioned you"}]));
    assert_eq!(row["reminded"], true);
    assert!(row["data"]["reminded_at"].is_string());
    assert_eq!(row["last_event_id"], events[0]["id"]);
    assert_eq!(row["read"], false);
    // the rows that did not wait long enough, were read, or are an AI's got no reminder
    let stored = table(&db, "notification").await;
    for id in ["read", "fresh", "ai"] {
        assert_eq!(by_id(&stored, id)["last_event_id"], 1, "{id}");
    }
    let _ = Event::new("x", "y");
    s.stop().await;
}

#[tokio::test]
async fn the_day_card_counts_the_day_from_the_runs_and_the_log() {
    if !skip_unless_available("the_day_card_counts_the_day_from_the_runs_and_the_log") {
        return;
    }
    let s = Server::start().await;
    let db = pool(&s).await;
    project(&db, "p1", "Proj One").await;
    ticket(&db, "KAN-3", "p1").await;
    let c = s.client();

    // a quiet day
    let r = c.get("/notifications/day-card?preview=true").await;
    r.assert_status(200);
    let body = r.json();
    assert_eq!(body["card"], Value::Null);
    let quiet = body["preview"].clone();
    let keys: Vec<&str> = quiet.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "since",
            "until",
            "finished",
            "failed",
            "failed_runs",
            "waiting",
            "waiting_ids",
            "snoozed",
            "spent",
            "projects",
            "lines",
            "quiet"
        ]
    );
    assert_eq!(
        quiet["lines"],
        json!([{"kind": "quiet", "text": "A quiet day: nothing ran and nothing waits for you."}])
    );
    assert_eq!(quiet["quiet"], true);
    assert_eq!(quiet["spent"], json!(0));
    assert_eq!(quiet["finished"], 0);
    assert!(quiet["since"].as_str().is_some_and(|t| t.contains("T00:00:00")), "{quiet}");

    // a day with work
    let ended = |s: i64| json!(at(s));
    ai_run(&db, "r1", "p1", Some("KAN-1"), "finished", &[("ended_at", ended(-30)), ("cost_usd", json!(0.5))]).await;
    ai_run(&db, "r2", "p1", Some("KAN-2"), "finished", &[("ended_at", ended(-30)), ("cost_usd", json!(0.25))]).await;
    ai_run(
        &db,
        "r3",
        "p2",
        Some("OTH-1"),
        "failed",
        &[("ended_at", ended(-30)), ("cost_usd", json!(0.1)), ("ended_reason", json!("Exit code 1. Something else"))],
    )
    .await;
    ai_run(&db, "r4", "p1", Some("KAN-3"), "timed_out", &[("ended_at", ended(-40)), ("queued_at", json!(at(-50)))])
        .await;
    ai_run(&db, "r5", "p1", Some("KAN-3"), "running", &[("queued_at", json!(at(-10)))]).await;
    ai_run(
        &db,
        "r_chat",
        "p1",
        Some("KAN-4"),
        "finished",
        &[("mode", json!("chat")), ("ended_at", ended(-30)), ("cost_usd", json!(9.0))],
    )
    .await;
    ai_run(
        &db,
        "r_old",
        "p1",
        Some("KAN-5"),
        "finished",
        &[("ended_at", json!(at(-3 * 86400))), ("cost_usd", json!(9.0))],
    )
    .await;
    Event::new("page_published", "Hoa published v2 of Guide").insert(&db).await;
    let mut wait = Nrow::new("w1", "mention", true, "Hoa mentioned you");
    wait.created_at = at(-3600);
    wait.insert(&db).await;
    let mut asleep = Nrow::new("w2", "question", true, "Claude asks");
    asleep.group_key = "question:w2".into();
    asleep.snoozed_until = Some("2099-01-01T00:00:00+00:00".into());
    asleep.insert(&db).await;
    let tomorrow = chrono::Utc::now() + chrono::Duration::hours(24);
    insert(
        &db,
        "ai_schedule",
        &[
            ("id", json!("sch1")),
            ("project_id", json!("p1")),
            ("ticket_id", json!("KAN-1")),
            ("member_id", json!("m")),
            ("state", json!("active")),
            ("next_run_at", json!(kb_base::time::iso(&tomorrow))),
            ("created_at", json!(at(-90))),
            ("updated_at", json!(at(-90))),
        ],
    )
    .await;
    let local_wait = chrono::DateTime::parse_from_rfc3339(&at(-3600)).expect("time").with_timezone(&chrono::Local);
    let local_tomorrow = tomorrow.with_timezone(&chrono::Local);

    let r = c.get("/notifications/day-card?preview=1").await;
    r.assert_status(200);
    let card = r.json()["preview"].clone();
    assert_eq!(card["finished"], 2);
    assert_eq!(card["failed"], 2);
    assert_eq!(card["failed_runs"], json!(["r3"]));
    assert_eq!(card["waiting"], 1);
    assert_eq!(card["waiting_ids"], json!(["w1"]));
    assert_eq!(card["snoozed"], 1);
    assert_eq!(card["spent"], json!(0.85));
    assert_eq!(card["projects"], 2);
    assert_eq!(card["quiet"], false);
    let lines = card["lines"].as_array().expect("lines").clone();
    let waited = local_wait.format("%H:%M").to_string();
    let first = local_tomorrow.format("%H:%M").to_string();
    assert_eq!(
        lines,
        vec![
            json!({"kind": "project", "project_id": "p1", "text": "Proj One: 2 AI runs finished on KAN-1, KAN-2."}),
            json!({"kind": "failed", "text": "2 runs failed: OTH-1 (Exit code 1), KAN-3 (timed out)."}),
            json!({"kind": "waiting", "text": format!("1 still wait for you, the oldest since {waited} — Hoa mentioned you.")}),
            json!({"kind": "docs", "text": "Docs: 1 page published."}),
            json!({"kind": "snoozed", "text": "1 still snoozed: Claude asks."}),
            json!({"kind": "tomorrow", "text": format!("Tomorrow: 1 scheduled run, the first at {first}.")}),
        ]
    );
    // the preview writes nothing
    assert_eq!(c.get("/notifications/counts").await.json()["head"], 1);

    // "Sum up today" writes the card now
    let r = c.post_empty("/notifications/day-card").await;
    r.assert_status(200);
    assert_eq!(r.json(), json!({"written": 1}));
    let r = c.get("/notifications/day-card").await;
    r.assert_status(200);
    let written = r.json();
    assert_eq!(written["preview"], Value::Null);
    let row = written["card"].clone();
    assert_eq!(row["kind"], "day_card");
    assert_eq!(row["title"], "Today on your boards");
    assert!(row["body"].as_str().is_some_and(|b| b.ends_with(" · 2 projects")), "{row}");
    assert_eq!(row["target_kind"], "day");
    assert!(row["target_id"].as_str().is_some_and(|t| t.starts_with("user:") && t.contains(":now:")), "{row}");
    assert_eq!(row["needs"], false);
    assert_eq!(row["actions"], json!([{"id": "open", "label": "Open"}]));
    let mut facts = row["data"].as_object().expect("data").clone();
    for key in ["since", "until"] {
        facts.remove(key);
    }
    let mut preview = card.as_object().expect("card").clone();
    for key in ["since", "until"] {
        preview.remove(key);
    }
    assert_eq!(Value::Object(facts), Value::Object(preview));
    let panel = c.get("/notifications?view=panel&tab=updates").await.json();
    assert_eq!(panel["day_card"]["id"], row["id"]);
    assert_eq!(panel["items"], json!([]));
    let log = c.get("/notifications/log?since=1").await.json();
    let events = log["events"].as_array().expect("events");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "day_card");
    assert_eq!(events[0]["recipients"], json!(["user"]));
    // another person gets a card of their own: their runs and the projects they have rows in
    let hoa = s.client().header("X-Actor", "Hoa Mai");
    let r = hoa.post_empty("/notifications/day-card").await;
    assert_eq!(r.json(), json!({"written": 1}));
    let theirs = hoa.get("/notifications/day-card").await.json()["card"].clone();
    assert_eq!(theirs["data"]["finished"], 0);
    // the Docs line counts every page published, whoever the card is for
    assert_eq!(theirs["data"]["quiet"], false);
    assert_eq!(
        theirs["data"]["lines"],
        json!([
            {"kind": "docs", "text": "Docs: 1 page published."},
            {"kind": "tomorrow", "text": format!("Tomorrow: 1 scheduled run, the first at {first}.")}
        ])
    );
    s.stop().await;
}
