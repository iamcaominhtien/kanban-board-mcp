//! `timeline`, `flow` and `activity` against the vectors the Python modules gave (`contract/golden/ai_timeline.json`,
//! `ai_flow.json`, `ai_activity.json`, `ai_timeline_pure.json` over the rows of `ai_views_rows.json`, made by
//! `gen_ai_views.py`): teams with roles, runs in every state and trigger, subagents with several stretches of work,
//! steps of every kind, questions, notes between teams, a paused project, a crowded one and one with no teams. The clock
//! is frozen at the moment the generator froze it.

mod common;

use chrono::{DateTime, FixedOffset};
use kb_ai_work::flow::{self, FlowOpts};
use kb_ai_work::timeline::{self, TimelineOpts};
use kb_ai_work::{activity, flow as _flow};
use kb_db::database;
use serde_json::Value;

fn dt(text: &str) -> DateTime<FixedOffset> {
    kb_ai::store::parse_iso(Some(text)).unwrap_or_else(|| panic!("a time: {text}"))
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn when(v: &Value) -> Option<DateTime<FixedOffset>> {
    v.as_str().map(dt)
}

#[tokio::test]
async fn timeline_gives_what_python_gives() {
    let _guard = common::init().await;
    common::insert_view_rows().await;
    let g = common::golden("ai_timeline.json");
    let now = dt(g["now"].as_str().expect("now"));
    let cases = g["calls"].as_array().expect("calls");
    assert!(cases.len() > 20);
    for case in cases {
        let args = &case["args"];
        let opts = TimelineOpts {
            range_key: args["range_key"].as_str().unwrap_or("today").to_string(),
            since: when(&args["since"]),
            until: when(&args["until"]),
            ticket_id: text(&args["ticket_id"]),
            team_id: text(&args["team_id"]),
        };
        let session = database::session();
        let got = timeline::timeline_at(&session, case["project"].as_str().expect("project"), &opts, now)
            .await
            .expect("the timeline");
        common::assert_same(case["name"].as_str().expect("name"), &got, &case["out"]);
    }
}

#[tokio::test]
async fn timeline_helpers_give_what_python_gives() {
    let _guard = common::init().await;
    let g = common::golden("ai_timeline_pure.json");
    for case in g["role_label"].as_array().expect("cases") {
        let input = case[0].as_str().unwrap_or("");
        // `role_label(None)` is `(None or "agent")`: the same as an empty text
        assert_eq!(timeline::role_label(input), case[1].as_str().expect("label"), "{}", case[0]);
    }
    for case in g["role_color"].as_array().expect("cases") {
        assert_eq!(timeline::role_color(case[0].as_str().unwrap_or("")), case[1].as_str().expect("color"), "{}", case[0]);
    }
    let now = dt("2026-11-12T10:00:00.250000+00:00");
    for case in g["window"].as_array().expect("cases") {
        let (a, b) = timeline::window(case[0].as_str().expect("range"), now, when(&case[1]), when(&case[2]));
        assert_eq!(kb_base::time::iso(&a), case[3].as_str().expect("since"), "{case}");
        assert_eq!(kb_base::time::iso(&b), case[4].as_str().expect("until"), "{case}");
    }
    let group = &g["group"];
    let arrows: Vec<serde_json::Map<String, Value>> =
        group["arrows"].as_array().expect("arrows").iter().map(|a| a.as_object().expect("an arrow").clone()).collect();
    for (key, within) in [("grouped_90", 90), ("grouped_600", 600), ("grouped_1", 1)] {
        let got = Value::Array(timeline::group(&arrows, within).into_iter().map(Value::Object).collect());
        common::assert_same(key, &got, &group[key]);
    }
}

#[tokio::test]
async fn flow_gives_what_python_gives() {
    let _guard = common::init().await;
    common::insert_view_rows().await;
    let g = common::golden("ai_flow.json");
    let now = dt(g["now"].as_str().expect("now"));
    let cases = g["calls"].as_array().expect("calls");
    assert!(cases.len() > 20);
    for case in cases {
        let project = case["project"].as_str().expect("project");
        let session = database::session();
        let got = if case["kind"] == "scopes" {
            flow::flow_scopes(&session, project).await.expect("the scopes")
        } else {
            let args = &case["args"];
            let opts = FlowOpts {
                range_key: args["range_key"].as_str().unwrap_or("today").to_string(),
                since: when(&args["since"]),
                until: when(&args["until"]),
                ticket_id: text(&args["ticket_id"]),
                team_id: text(&args["team_id"]),
            };
            flow::flow_map_at(&session, project, &opts, now).await.expect("the map")
        };
        common::assert_same(case["name"].as_str().expect("name"), &got, &case["out"]);
    }
    let _ = _flow::ids(None);
}

#[tokio::test]
async fn activity_gives_what_python_gives() {
    let _guard = common::init().await;
    common::insert_view_rows().await;
    let g = common::golden("ai_activity.json");
    let day = g["day"].as_str().expect("day");
    let cases = g["calls"].as_array().expect("calls");
    for case in cases {
        let args = &case["args"];
        let session = database::session();
        let got = match case["kind"].as_str().expect("kind") {
            "team_activity" => {
                let keys: Vec<String> =
                    args["role_keys"].as_array().expect("keys").iter().map(|k| k.as_str().expect("key").to_string()).collect();
                activity::team_activity_at(&session, args["member_id"].as_str().expect("member"), &keys, day)
                    .await
                    .expect("the activity")
            }
            "project_activity" => {
                let teams = args["teams"].as_array().expect("teams");
                // the clock of `project_activity` is the real one: the same call with the frozen day
                let mut out = serde_json::Map::new();
                for t in teams {
                    let keys: Vec<String> = match t.get("roles") {
                        Some(Value::Array(roles)) => roles.iter().map(|r| r["key"].as_str().unwrap_or("").to_string()).collect(),
                        _ => Vec::new(),
                    };
                    let id = t["id"].as_str().expect("id");
                    out.insert(id.to_string(), activity::team_activity_at(&session, id, &keys, day).await.expect("one team"));
                }
                Value::Object(out)
            }
            "recent" => activity::recent(
                &session,
                args["project_id"].as_str().expect("project"),
                args["team_id"].as_str(),
                args["limit"].as_u64().unwrap_or(8),
            )
            .await
            .expect("recent"),
            other => panic!("a call the views do not have: {other}"),
        };
        common::assert_same(case["name"].as_str().expect("name"), &got, &case["out"]);
    }
}

#[test]
fn first_line_gives_what_python_gives() {
    let g = common::golden("ai_activity.json");
    let cases = g["first_line"].as_array().expect("cases");
    assert!(cases.len() > 80);
    for case in cases {
        let got = match case.as_array().expect("a case").len() {
            2 => activity::first_line_default(case[0].as_str()),
            _ => activity::first_line(case[0].as_str(), case[1].as_u64().expect("limit") as usize),
        };
        assert_eq!(got, case.as_array().and_then(|c| c.last()).and_then(Value::as_str).expect("want"), "{case}");
    }
}
