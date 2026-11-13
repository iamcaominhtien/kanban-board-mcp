//! The pure functions of `services/notifications.py`: keys, kinds, settings, titles, actions. No database.

use chrono::{TimeZone, Utc};
use kb_db::entities::notification;
use kb_notify::helpers::{first_line, py_int, py_repr_str};
use kb_notify::{
    GROUP_NAMES_MAX, KINDS, NotifyError, SOUND_NAMES, actions, ai_key, default_prefs, done_text, event_switch,
    group_body, group_key, group_title, hhmm, in_quiet_hours, info_kinds, is_needs, keys_to_tell, needs_kinds,
    person_key, prefs_of, remind_after, sound_name, ticket_order,
};
use serde_json::{Value, json};

fn row(kind: &str) -> notification::Model {
    let now = "2026-06-03T10:00:00+00:00".to_string();
    notification::Model {
        id: "nt_1".into(),
        recipient: "user".into(),
        event_id: 1,
        last_event_id: 1,
        project_id: None,
        kind: kind.into(),
        needs: false,
        group_key: String::new(),
        count: 1,
        items: "[]".into(),
        target_kind: None,
        target_id: None,
        ticket_id: None,
        page_id: None,
        member_id: None,
        actor: None,
        title: String::new(),
        body: String::new(),
        data: "{}".into(),
        inapp: true,
        desktop: false,
        read_at: None,
        done_at: None,
        done_reason: None,
        done_by: None,
        snoozed_until: None,
        cleared_at: None,
        created_at: now.clone(),
        updated_at: now,
    }
}

#[test]
fn recipient_keys_are_lower_case_names_and_the_board_user() {
    for name in ["", "user", "You", " ME ", "  "] {
        assert_eq!(person_key(Some(name)), "user", "{name:?}");
    }
    assert_eq!(person_key(None), "user");
    assert_eq!(person_key(Some("  Hoa Mai ")), "hoa mai");
    assert_eq!(person_key(Some("ĐỨC")), "đức");
    assert_eq!(ai_key("m1"), "ai:m1");
}

#[test]
fn the_kinds_are_the_table_of_the_python_module() {
    assert_eq!(KINDS.len(), 26);
    assert_eq!(needs_kinds().count(), 15);
    assert_eq!(info_kinds().count(), 11);
    assert_eq!(needs_kinds().next().map(|k| k.name), Some("question"));
    assert_eq!(needs_kinds().last().map(|k| k.name), Some("workflow_blocked"));
    assert_eq!(info_kinds().next().map(|k| k.name), Some("ai_finished"));
    assert!(is_needs("mention") && !is_needs("comment") && !is_needs("nope"));
    // the kinds a person can dismiss: the ones that do not close by themselves are not
    let dismissable: Vec<&str> = KINDS.iter().filter(|k| k.dismissable).map(|k| k.name).collect();
    assert_eq!(
        dismissable,
        [
            "run_failed",
            "mention",
            "run_stopped_memory",
            "budget",
            "auto_trip",
            "offline",
            "run_stuck",
            "board_fault",
            "window_urgent"
        ]
    );
    let desktop: Vec<&str> = KINDS.iter().filter(|k| k.desktop).map(|k| k.name).collect();
    assert_eq!(desktop.len(), 14);
    assert!(!desktop.contains(&"offline"));
}

#[test]
fn a_group_key_is_the_request_for_needs_you_and_the_project_for_information() {
    assert_eq!(group_key("ai_finished", Some("p1"), None, None, None), "ai_finished:p1");
    assert_eq!(group_key("ai_finished", None, Some("run"), Some("r1"), Some("KAN-1")), "ai_finished:-");
    assert_eq!(group_key("question", Some("p1"), Some("run"), Some("r1"), None), "question:run:r1");
    assert_eq!(group_key("question", Some("p1"), None, Some("r1"), None), "question:-:r1");
    assert_eq!(group_key("question", Some("p1"), None, None, None), "question:project:p1");
    assert_eq!(group_key("question", None, None, None, None), "question:project:-");
    for kind in ["run_failed", "run_stopped_memory", "board_fault"] {
        assert_eq!(group_key(kind, Some("p1"), Some("run"), Some("r1"), Some("KAN-1")), format!("{kind}:ticket:KAN-1"));
        assert_eq!(group_key(kind, Some("p1"), Some("run"), Some("r1"), None), format!("{kind}:run:r1"));
    }
    assert_eq!(group_key("budget", Some("p1"), None, Some(""), Some("KAN-1")), "budget:project:p1");
}

#[test]
fn keys_to_tell_drops_blanks_repeats_and_the_actor_of_an_information_event() {
    let r = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(keys_to_tell(&r(&["user", "", "hoa", "user"]), None, false), ["user", "hoa"]);
    assert_eq!(keys_to_tell(&r(&["user", "hoa"]), Some("Hoa"), false), ["user"]);
    assert_eq!(keys_to_tell(&r(&["user", "hoa"]), Some("Hoa"), true), ["user", "hoa"]);
    assert_eq!(keys_to_tell(&r(&["user", "hoa"]), Some("You"), false), ["hoa"]);
    assert_eq!(keys_to_tell(&r(&["user"]), Some(""), false), ["user"]);
}

#[test]
fn titles_and_bodies_of_a_group() {
    assert_eq!(group_title("ai_finished", &[], 3), "3 AI finished work");
    assert_eq!(group_title("schedule", &[], 2), "2 scheduled runs ended");
    assert_eq!(group_title("schedule_started", &[], 2), "2 scheduled runs started");
    assert_eq!(group_title("page_published", &[], 2), "2 pages were published");
    assert_eq!(group_title("comment", &[], 4), "4 new comments in threads you follow");
    assert_eq!(group_title("run_cancelled", &[], 2), "2 runs were cancelled");
    assert_eq!(group_title("budget_warning", &[], 2), "2 budget warnings");
    assert_eq!(group_title("access_request", &[], 2), "2 people asked for access to Docs");
    assert_eq!(group_title("lesson", &[], 2), "2 updates");
    assert_eq!(group_title("comment", &[], GROUP_NAMES_MAX), "20 new comments in threads you follow");
    assert_eq!(group_title("comment", &[], GROUP_NAMES_MAX + 1), "20+ new comments in threads you follow");

    let item = |actor: &str, ticket: Option<&str>| json!({"actor": actor, "ticket_id": ticket});
    let items =
        vec![item("Hoa", Some("KAN-10")), item("Linh", Some("KAN-2")), item("Hoa", Some("KAN-2")), item("", None)];
    assert_eq!(group_body(&items, Some(4)), "Hoa, Linh · KAN-2 to KAN-10");
    assert_eq!(group_body(&items[..1], None), "Hoa · KAN-10");
    assert_eq!(group_body(&[json!({"actor": null, "ticket_id": "KAN-1"})], Some(1)), "KAN-1");
    assert_eq!(group_body(&[json!({})], Some(1)), "");
    let five: Vec<Value> = ["A", "B", "C", "D", "E", "F"].iter().map(|n| item(n, None)).collect();
    assert_eq!(group_body(&five, Some(6)), "A, B, C, D and 2 more");
    assert_eq!(group_body(&five, Some(21)), "21 in 10 minutes");
    assert_eq!(group_body(&five, Some(0)), "A, B, C, D and 2 more");
}

#[test]
fn tickets_sort_by_prefix_then_number() {
    let mut t = vec!["KAN-10", "KAN-2", "ABC-7", "odd", "KAN-1x", "kan-3"];
    t.sort_by_key(|x| ticket_order(x));
    assert_eq!(t, ["ABC-7", "KAN-2", "KAN-10", "KAN-1x", "kan-3", "odd"]);
    assert_eq!(ticket_order("KAN-12"), ("KAN".to_string(), 12));
    assert_eq!(ticket_order("A-B-1"), ("A-B-1".to_string(), 0));
}

#[test]
fn python_int_of_a_json_value() {
    assert_eq!(py_int(&json!(5)).expect("int"), 5);
    assert_eq!(py_int(&json!(5.9)).expect("int"), 5);
    assert_eq!(py_int(&json!(-5.9)).expect("int"), -5);
    assert_eq!(py_int(&json!(true)).expect("int"), 1);
    assert_eq!(py_int(&json!(" 42 ")).expect("int"), 42);
    assert_eq!(py_int(&json!("+7")).expect("int"), 7);
    assert_eq!(py_int(&json!("1_000")).expect("int"), 1000);
    for bad in ["", "abc", "1__0", "_1", "1_", "1.5", "0x10", "--1"] {
        let err = py_int(&json!(bad)).expect_err(bad);
        assert!(
            matches!(&err, NotifyError::Value(m) if *m == format!("invalid literal for int() with base 10: {}", py_repr_str(bad))),
            "{bad}: {err}"
        );
    }
    assert!(matches!(py_int(&json!(null)), Err(NotifyError::Internal(_))));
    assert!(matches!(py_int(&json!([1])), Err(NotifyError::Internal(_))));
    assert!(matches!(py_int(&json!({"a": 1})), Err(NotifyError::Internal(_))));
    assert_eq!(py_repr_str("abc"), "'abc'");
    assert_eq!(py_repr_str("it's"), "\"it's\"");
    assert_eq!(py_repr_str("a'b\"c"), "'a\\'b\"c'");
    assert_eq!(py_repr_str("a\nb\\"), "'a\\nb\\\\'");
    assert_eq!(py_repr_str("tab\t"), "'tab\\t'");
}

#[test]
fn text_helpers() {
    assert_eq!(first_line("one\ntwo"), Some("one"));
    assert_eq!(first_line("one\r\ntwo"), Some("one"));
    assert_eq!(first_line("one\u{2028}two"), Some("one"));
    assert_eq!(first_line("alone"), Some("alone"));
    assert_eq!(first_line(""), None);
    assert_eq!(hhmm(Some(&json!("07:30")), "x"), "07:30");
    for bad in [json!("7:30"), json!("07:3"), json!("07:30 "), json!(730), json!(null), json!("ab:cd")] {
        assert_eq!(hhmm(Some(&bad), "fallback"), "fallback", "{bad}");
    }
    assert_eq!(hhmm(None, "fallback"), "fallback");
}

#[test]
fn settings_are_the_defaults_with_what_the_person_changed_on_top() {
    let defaults = default_prefs();
    assert_eq!(
        defaults,
        json!({
            "events": {},
            "quiet": {"on": true, "start": "22:00", "end": "08:00"},
            "desktop_on": true,
            "dnd": true,
            "sound": true,
            "sound_name": "chime",
            "remind_after_min": 15,
            "day_card": {"on": true, "time": "18:00", "days": [0, 1, 2, 3, 4]}
        })
    );
    let stored = kb_db::entities::notify_prefs::Model {
        recipient: "x".into(),
        prefs: r#"{"quiet": {"start": "21:00"}, "dnd": false, "extra": [1], "events": {"comment": {"inapp": false}}}"#
            .into(),
        updated_at: String::new(),
    };
    let p = prefs_of(Some(&stored));
    assert_eq!(p["quiet"], json!({"on": true, "start": "21:00", "end": "08:00"}));
    assert_eq!(p["dnd"], false);
    assert_eq!(p["extra"], json!([1]));
    assert_eq!(p["events"], json!({"comment": {"inapp": false}}));
    assert_eq!(
        p.keys().map(String::as_str).collect::<Vec<_>>(),
        ["events", "quiet", "desktop_on", "dnd", "sound", "sound_name", "remind_after_min", "day_card", "extra"]
    );
    assert_eq!(prefs_of(None).get("sound"), Some(&json!(true)));

    // a kind's switches
    assert_eq!(event_switch(&p, "comment"), (false, false));
    assert_eq!(event_switch(&p, "question"), (true, true));
    assert_eq!(event_switch(&p, "offline"), (true, false));
    assert_eq!(event_switch(&p, "unknown"), (true, false));
    let mut off = p.clone();
    off.insert("desktop_on".into(), json!(false));
    assert_eq!(event_switch(&off, "question"), (true, false));
    let mut locked = p.clone();
    locked
        .insert("events".into(), json!({"question": {"inapp": false, "desktop": true}, "comment": {"desktop": true}}));
    assert_eq!(event_switch(&locked, "question"), (true, true));
    assert_eq!(event_switch(&locked, "comment"), (true, true));

    // sound and reminder values
    let mut q = prefs_of(None);
    assert_eq!((sound_name(&q), remind_after(&q)), ("chime", 15));
    q.insert("sound_name".into(), json!("bell"));
    assert_eq!(sound_name(&q), "bell");
    q.insert("sound_name".into(), json!("gong"));
    assert_eq!(sound_name(&q), SOUND_NAMES[0]);
    for (value, expect) in [
        (json!(0), 0),
        (json!(1440), 1440),
        (json!(1441), 15),
        (json!(-1), 15),
        (json!("30"), 30),
        (json!("x"), 15),
        (json!(null), 15),
        (json!(7.9), 7),
    ] {
        q.insert("remind_after_min".into(), value.clone());
        assert_eq!(remind_after(&q), expect, "{value}");
    }
}

#[test]
fn quiet_hours_cross_midnight() {
    let at = |h: u32, m: u32| {
        chrono::Local.with_ymd_and_hms(2026, 6, 3, h, m, 0).earliest().expect("local").with_timezone(&Utc)
    };
    let mut p = prefs_of(None);
    for (h, m, quiet) in
        [(22, 0, true), (23, 59, true), (0, 0, true), (7, 59, true), (8, 0, false), (12, 0, false), (21, 59, false)]
    {
        assert_eq!(in_quiet_hours(&p, Some(at(h, m))), quiet, "{h}:{m}");
    }
    p.insert("quiet".into(), json!({"on": true, "start": "08:00", "end": "08:00"}));
    assert!(!in_quiet_hours(&p, Some(at(8, 0))));
    p.insert("quiet".into(), json!({}));
    assert!(!in_quiet_hours(&p, Some(at(23, 0))));
    p.remove("quiet");
    assert!(!in_quiet_hours(&p, Some(at(23, 0))));
}

#[test]
fn the_buttons_of_a_row_follow_its_kind() {
    let labels = |r: &notification::Model, gone: bool| -> Vec<String> {
        actions(r, gone)
            .iter()
            .map(|a| format!("{}:{}", a["id"].as_str().expect("id"), a["label"].as_str().expect("label")))
            .collect()
    };
    assert_eq!(labels(&row("question"), false), ["answer:Answer", "open_ticket:Open ticket"]);
    assert_eq!(labels(&row("run_failed"), false), ["retry:Retry", "open_run_log:Open run log"]);
    assert_eq!(labels(&row("run_stopped_memory"), false), ["retry:Retry", "open_run_log:Open run log"]);
    assert_eq!(labels(&row("board_fault"), false), ["retry:Retry", "open_run_log:Open run log"]);
    assert_eq!(
        labels(&row("run_stuck"), false),
        [
            "trouble:continue_note:Continue with a note",
            "trouble:wait:Wait, tell me again at 30 min",
            "trouble:cancel:Cancel the run",
            "open_run_log:Open the run"
        ]
    );
    let mut stuck = row("run_stuck");
    stuck.data = json!({"diagnosis": {"actions": ["stop_child", "bogus", "tell_ai"]}}).to_string();
    assert_eq!(
        labels(&stuck, false),
        [
            "trouble:stop_child:Stop that command, keep the run",
            "trouble:tell_ai:Tell the AI to run it in the background",
            "open_run_log:Open the run"
        ]
    );
    assert_eq!(
        labels(&row("merge_conflict"), false),
        ["conflict:ai:Hand it to an AI", "conflict:me:I will do it", "open_ticket:Open ticket"]
    );
    assert_eq!(
        labels(&row("arbitration"), false),
        [
            "arbitration:reviewer:Side with Reviewer",
            "arbitration:dev:Side with Dev",
            "arbitration:split:Split the ticket",
            "open_ticket:Read the arbitration"
        ]
    );
    assert_eq!(
        labels(&row("workflow_step"), false),
        ["workflow:approve:Approve", "workflow:send_back:Send back", "open_ticket:Open ticket"]
    );
    assert_eq!(labels(&row("window_urgent"), false), ["move_account:Move urgent work", "open_ai:Open accounts"]);
    assert_eq!(labels(&row("account_signed_out"), false), ["sign_in:Sign in again"]);
    assert_eq!(labels(&row("mention"), false), ["reply:Reply", "open:Open"]);
    let mut canvas = row("mention");
    canvas.target_kind = Some("canvas_thread".into());
    assert_eq!(labels(&canvas, false), ["open:Open"]);
    for kind in ["budget", "auto_trip", "offline"] {
        assert_eq!(labels(&row(kind), false), ["open_ai:Open AI Team"]);
    }
    assert_eq!(labels(&row("day_card"), false), ["open:Open"]);
    assert_eq!(labels(&row("schedule_started"), false), ["open_run_log:Open run"]);
    let mut skipped = row("schedule");
    skipped.data = json!({"event": "skipped", "schedule_id": "sc1"}).to_string();
    assert_eq!(labels(&skipped, false), ["reschedule:Reschedule", "open:Open"]);
    skipped.count = 3;
    assert_eq!(labels(&skipped, false), ["expand:Show all 3"]);
    assert_eq!(labels(&row("schedule"), false), ["open:Open"]);
    assert_eq!(labels(&row("comment"), false), ["open:Open"]);
    // gone: only Dismiss; done: nothing
    assert_eq!(labels(&row("question"), true), ["dismiss:Dismiss"]);
    let mut done = row("question");
    done.done_at = Some("2026-06-03T10:00:00+00:00".into());
    assert!(actions(&done, true).is_empty());
}

#[test]
fn what_a_closed_row_says() {
    let mut r = row("mention");
    assert_eq!(done_text(&r, "user"), None);
    r.done_at = Some("2026-06-03T10:00:00+00:00".into());
    assert_eq!(done_text(&r, "user").as_deref(), Some("Done"));
    r.done_reason = Some("Dismissed by {who}".into());
    r.done_by = Some("User".into());
    assert_eq!(done_text(&r, "user").as_deref(), Some("Dismissed by you"));
    assert_eq!(done_text(&r, "hoa").as_deref(), Some("Dismissed by User"));
    r.done_by = None;
    assert_eq!(done_text(&r, "hoa").as_deref(), Some("Dismissed by someone"));
    r.done_reason = Some("{who} replied".into());
    r.done_by = Some("hoa".into());
    assert_eq!(done_text(&r, "user").as_deref(), Some("Hoa replied"));
    assert_eq!(done_text(&r, "hoa").as_deref(), Some("You replied"));
    r.done_reason = Some("the run ended".into());
    assert_eq!(done_text(&r, "user").as_deref(), Some("The run ended"));
}
