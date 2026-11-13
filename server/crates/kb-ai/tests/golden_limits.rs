//! `quota` and `budget` against the vectors the Python modules gave (`contract/golden/ai_limits.json`, made by
//! `gen_ai_limits.py`): reading the stream, keys, holds, and the day and month boundaries in twenty time zones across
//! their DST changes, with the clock frozen (the Python generator patches `datetime.now`; the Rust functions take the
//! zone and the moment).

mod common;

use std::str::FromStr;

use chrono::{DateTime, Utc};
use kb_ai::{budget, quota};
use kb_base::{pyjson, time};
use serde_json::{Value, json};

fn golden() -> Value {
    common::golden("ai_limits.json")
}

fn utc(text: &str) -> DateTime<Utc> {
    kb_ai::store::parse_iso(Some(text)).expect("a time").with_timezone(&Utc)
}

#[test]
fn parse_event_reads_the_windows_and_ignores_other_events() {
    for case in golden()["parse_event"].as_array().expect("cases") {
        let got = quota::parse_event(&case["event"]).map_or(Value::Null, Value::Object);
        assert_eq!(got, case["out"], "{}", case["event"]);
        assert_eq!(pyjson::dumps(&got), pyjson::dumps(&case["out"]), "{} (order)", case["event"]);
    }
}

#[test]
fn key_for_picks_the_override_then_the_account_then_the_local_login() {
    let acct = |name: &str| match name {
        "account" => Some("acct_team"),
        "empty_account" => Some(""),
        _ => None,
    };
    let run_acct = |name: &str| match name {
        "account" => Some("acct_run"),
        "empty_account" => Some(""),
        _ => None,
    };
    for case in golden()["key_for"].as_array().expect("cases") {
        let (t, r) = (case["team"].as_str().expect("team"), case["run"].as_str().expect("run"));
        let team = (t != "none").then(|| common::team_model("t", "p", acct(t)));
        let run = (r != "none").then(|| common::run_model("p", "t", run_acct(r)));
        assert_eq!(json!(quota::key_for(team.as_ref(), run.as_ref())), case["out"], "{t} / {r}");
    }
}

#[test]
fn held_is_the_reset_time_only_while_it_lies_ahead_and_hold_never_shortens() {
    let g = golden();
    for case in g["held"].as_array().expect("cases") {
        if case.get("row").is_some() {
            assert_eq!(quota::held(None, None), None);
            continue;
        }
        let now = utc(case["now"].as_str().expect("now"));
        let mut row = quota::default_state("a");
        row.held_until = case["held_until"].as_str().map(str::to_string);
        if case["out"] == json!("TypeError") {
            // Python raises where it compares a time without a zone to an aware one; the port reads it as UTC
            continue;
        }
        assert_eq!(json!(quota::held(Some(&row), Some(now))), case["out"], "{}", case["held_until"]);
    }
    for case in g["hold"].as_array().expect("cases") {
        let mut row = quota::default_state("a");
        row.held_until = case["held_until"].as_str().map(str::to_string);
        row.held_reason = case["held_reason"].as_str().map(str::to_string);
        quota::hold(&mut row, case["until"].as_str().expect("until"), case["window"].as_str());
        assert_eq!(json!(row.held_until), case["after_until"], "{case}");
        assert_eq!(json!(row.held_reason), case["after_reason"], "{case}");
    }
    let c = &g["consts"];
    assert_eq!(json!(quota::LOCAL), c["LOCAL"]);
    assert_eq!(json!(quota::DEFAULT_PARALLEL), c["DEFAULT_PARALLEL"]);
    assert_eq!(json!(quota::NEAR), c["NEAR"]);
}

#[test]
fn run_kind_is_schedule_or_person() {
    for case in golden()["run_kind"].as_array().expect("cases") {
        let mut run = common::run_model("p", "m", None);
        run.trigger = case["trigger"].as_str().expect("trigger").to_string();
        assert_eq!(json!(budget::run_kind(&run)), case["out"], "{}", case["trigger"]);
    }
}

#[test]
fn the_day_and_month_start_at_local_midnight_in_every_zone() {
    let g = golden();
    let now_for_ats = utc("2026-11-12T10:00:00+00:00");
    let mut checked = 0;
    for z in g["zones"].as_array().expect("zones") {
        let name = z["zone"].as_str().expect("zone");
        let tz = chrono_tz::Tz::from_str(name).expect("a zone");
        for case in z["cases"].as_array().expect("cases") {
            let now = utc(case["now"].as_str().expect("now"));
            let what = format!("{name} at {now}");
            assert_eq!(json!(time::iso(&budget::today_start_in(&tz, now))), case["today_start"], "today_start {what}");
            assert_eq!(json!(budget::day_key_in(&tz, None, now)), case["day_key"], "day_key {what}");
            assert_eq!(
                json!(time::iso(&budget::month_start_in(&tz, None, now))),
                case["month_start"],
                "month_start {what}"
            );
            for b in case["bounds"].as_array().expect("bounds") {
                let n = b["days_ago"].as_u64().expect("days");
                let (key, start, end) = budget::day_bounds_in(&tz, n, now);
                assert_eq!(json!(key), b["key"], "day_bounds({n}) key {what}");
                assert_eq!(json!(time::iso(&start)), b["start"], "day_bounds({n}) start {what}");
                assert_eq!(json!(time::iso(&end)), b["end"], "day_bounds({n}) end {what}");
                checked += 1;
            }
        }
        for a in z["ats"].as_array().expect("ats") {
            let at = utc(a["at"].as_str().expect("at"));
            assert_eq!(json!(budget::day_key_in(&tz, Some(at), now_for_ats)), a["day_key"], "day_key({at}) in {name}");
            assert_eq!(
                json!(time::iso(&budget::month_start_in(&tz, Some(at), now_for_ats))),
                a["month_start"],
                "month_start({at}) in {name}"
            );
        }
        for d in z["local_day"].as_array().expect("days") {
            assert_eq!(
                json!(budget::local_day_in(&tz, d["iso"].as_str())),
                d["out"],
                "local_day({}) in {name}",
                d["iso"]
            );
        }
        for h in z["local_hhmm"].as_array().expect("times") {
            assert_eq!(json!(quota::local_in(h["when"].as_str(), &tz)), h["out"], "local({}) in {name}", h["when"]);
        }
    }
    assert!(checked > 3000, "{checked} day bounds");
}
