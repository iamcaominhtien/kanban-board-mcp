//! `touches`, `health`, `session_history` and `compact` against what the Python modules gave
//! (`contract/golden/ai_review.json`, made by `gen_ai_review.py`): the pure functions over tables of values, and, on
//! the rows the Python models dumped and with the clock stopped where the generator stopped it, the touches of a
//! project (whole ranges, and one key at a time), the tab "You stepped in" with every filter, the Health page of
//! projects in every shape, marks and lessons step by step, the audit entries of an edit, a sign-in and a pause, the
//! history of a ticket's conversations (`start_over` with an assistant that answers, fails or is absent) and
//! `compact_ticket` with a script in place of the CLI.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use kb_ai_run::runs::RunError;
use kb_ai_run::seams::{self, AssistAsk, AssistFailure, AssistTurn};
use kb_ai_run::{clock, compact, health, session_history, touches};
use kb_db::database;
use kb_db::entities::{ai_account, ai_audit, ai_lesson, ai_run, ai_run_message, ai_team, ai_touch_mark, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    common::golden("ai_review.json")
}

fn cases(g: &Value, name: &str) -> Vec<Value> {
    let cases = g[name].as_array().unwrap_or_else(|| panic!("{name}")).clone();
    assert!(!cases.is_empty(), "{name}");
    cases
}

fn now_of(g: &Value) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(g["now"].as_str().expect("now")).expect("a time").to_utc()
}

fn model<M: serde::de::DeserializeOwned>(row: &Value) -> M {
    serde_json::from_value(common::to_local(row)).unwrap_or_else(|e| panic!("a row: {e}: {row}"))
}

fn maps(list: Vec<Map<String, Value>>) -> Value {
    Value::Array(list.into_iter().map(Value::Object).collect())
}

fn keys(map: &Map<String, Value>) -> Value {
    json!(map.keys().collect::<Vec<_>>())
}

/// What Python raised, as the generator wrote it: `[type name, message]`.
fn refusal(kind: &str, message: &str) -> Value {
    json!({"error": [kind, message]})
}

#[test]
fn the_pure_functions_of_touches() {
    let g = golden();
    let p = &g["pure"];
    let now = now_of(&g);
    let ai: std::collections::HashSet<String> =
        ["Dev Team", "QA Team", "Old Team"].iter().map(|s| s.to_string()).collect();
    for case in cases(p, "is_person") {
        let name = case["name"].as_str();
        assert_eq!(json!(touches::is_person(name, Some(&ai))), case["with_ai"], "{case}");
        assert_eq!(json!(touches::is_person(name, None)), case["without"], "{case}");
    }
    for case in cases(p, "clip") {
        let n = case["n"].as_u64().expect("n") as usize;
        assert_eq!(json!(touches::clip(case["text"].as_str(), n)), case["out"], "{} at {n}", case["text"]);
    }
    for case in cases(p, "since_of") {
        let got = touches::since_of(case["range"].as_str().expect("range"), Some(now));
        assert_eq!(json!(kb_base::time::iso(&got)), case["out"], "{case}");
    }
    let c = &p["constants"];
    assert_eq!(
        json!(touches::RANGES.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>()),
        c["RANGES"]
    );
    assert_eq!(json!(touches::DEFAULT_RANGE), c["DEFAULT_RANGE"]);
    assert_eq!(json!(touches::MARKS), c["MARKS"]);
    assert_eq!(json!(touches::LIMIT), c["LIMIT"]);
    assert_eq!(json!(touches::LESSON_MAX), c["LESSON_MAX"]);
    assert_eq!(json!(touches::KINDS.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>()), c["KINDS"]);
    assert_eq!(
        json!(touches::KINDS.iter().map(|(k, _)| *k).collect::<Vec<_>>()),
        json!(c["KINDS"].as_object().expect("kinds").keys().collect::<Vec<_>>()),
        "the order of the kinds"
    );
    let mut machine = touches::MACHINE.to_vec();
    machine.sort_unstable();
    assert_eq!(json!(machine), c["MACHINE"]);
    assert_eq!(json!(touches::EDIT_ACTION), c["EDIT_ACTION"]);
    assert_eq!(json!(touches::SIGNIN_ACTION), c["SIGNIN_ACTION"]);
    assert_eq!(json!(touches::PAUSE_ACTIONS), c["PAUSE_ACTIONS"]);
    assert_eq!(json!(touches::CLAIMED), c["CLAIMED"]);
    assert_eq!(json!(touches::RUN_ENDED), c["RUN_ENDED"]);
    assert_eq!(json!(touches::STOP_WITH_PAUSE_S), c["STOP_WITH_PAUSE_S"]);
    assert_eq!(Some(touches::EDIT_COALESCE_S), c["EDIT_COALESCE_S"].as_f64());
    assert_eq!(json!(compact::WISH), c["WISH"]);
    assert_eq!(json!(compact::TIMEOUT_S), c["TIMEOUT_S"]);
    assert_eq!(json!(session_history::DIGEST_MAX), c["DIGEST_MAX"]);
    assert_eq!(
        json!(health::RANGES.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>()),
        c["HEALTH_RANGES"]
    );
    assert_eq!(json!(health::MIN_RUNS), c["MIN_RUNS"]);
    assert_eq!(json!(health::MAX_FIXES), c["MAX_FIXES"]);
    assert_eq!(json!(health::ENDED), c["ENDED"]);
    assert_eq!(json!(health::NOT_THE_TEAM), c["NOT_THE_TEAM"]);
    assert_eq!(json!(health::MIN_CASES), c["MIN_CASES"]);
    assert_eq!(json!(health::MIN_CASES_MEMORY), c["MIN_CASES_MEMORY"]);
    for case in cases(p, "carry_answer") {
        let got = touches::carry_answer(case["question"].as_str(), case["answer"].as_str());
        assert_eq!(json!(got), case["out"], "{} / {}", case["question"], case["answer"]);
    }
    for case in cases(p, "answers_of") {
        let mut run = common::run_model("p", "m", None);
        run.question = case["question"].as_str().map(str::to_string);
        run.answer = case["answer"].as_str().map(str::to_string);
        assert_eq!(maps(touches::answers_of(&run)), case["out"], "{} / {}", case["question"], case["answer"]);
    }
    for case in cases(p, "draft_lesson") {
        let touch = case["touch"].as_object().expect("touch");
        assert_eq!(json!(touches::draft_lesson(touch)), case["out"], "{}", case["touch"]);
    }
}

#[test]
fn the_pure_functions_of_health() {
    let g = golden();
    let p = &g["pure"];
    for case in cases(p, "verdict_of") {
        let got = health::verdict_of(
            case["value"].as_f64(),
            case["good"].as_f64().expect("good"),
            case["watch"].as_f64().expect("watch"),
            case["higher"].as_bool().expect("higher"),
        );
        assert_eq!(json!(got), case["out"], "{case}");
    }
    for case in cases(p, "median") {
        let values: Vec<f64> = case["values"].as_array().expect("values").iter().filter_map(Value::as_f64).collect();
        assert_eq!(json!(health::median(&values)), case["out"], "{case}");
    }
    for case in cases(p, "secs") {
        assert_eq!(json!(health::secs(case["a"].as_str(), case["b"].as_str())), case["out"], "{case}");
    }
    for case in cases(p, "reason") {
        let got = health::reason(case["text"].as_str().expect("text"), case["limit"].as_u64().expect("limit") as usize);
        assert_eq!(json!(got), case["out"], "{case}");
    }
    for case in cases(p, "sentence") {
        let fixes = case["fixes"].as_array().expect("fixes").clone();
        let bad: Vec<String> =
            case["bad"].as_array().expect("bad").iter().map(|b| b.as_str().expect("a name").to_string()).collect();
        let prev = Some(&case["prev"]).filter(|prev| !prev.is_null());
        assert_eq!(json!(health::sentence(&case["m"], prev, &fixes, &bad)), case["out"], "{case}");
    }
    let tickets: HashMap<String, ticket::Model> =
        cases(p, "tickets").iter().map(model::<ticket::Model>).map(|t| (t.id.clone(), t)).collect();
    let ticket_of = |case: &Value| case["ticket"].as_str().map(|id| &tickets[id]);
    for case in cases(p, "ticket_times") {
        let (assigned, review) = health::ticket_times(ticket_of(&case));
        assert_eq!(json!([assigned, review]), case["out"], "{case}");
    }
    for case in cases(p, "reopens_after") {
        let got = health::reopens_after(ticket_of(&case), case["after"].as_str(), case["until"].as_str());
        assert_eq!(json!(got), case["out"], "{case}");
    }
    let runs: Vec<ai_run::Model> = cases(p, "runs").iter().map(model).collect();
    let all: Vec<&ai_run::Model> = runs.iter().collect();
    let as_dict = |pairs: Vec<(String, String)>| Value::Object(pairs.into_iter().map(|(k, v)| (k, json!(v))).collect());
    assert_eq!(as_dict(health::first_finish(&all)), p["first_finish"]["all"]);
    let reversed: Vec<&ai_run::Model> = runs.iter().rev().collect();
    assert_eq!(as_dict(health::first_finish(&reversed)), p["first_finish"]["reversed"]);
    assert_eq!(as_dict(health::first_finish(&[])), p["first_finish"]["none"]);

    let teams: HashMap<String, ai_team::Model> =
        p["teams"].as_object().expect("teams").iter().map(|(k, row)| (k.clone(), model(row))).collect();
    let tks: Vec<Map<String, Value>> =
        p["tks"].as_array().expect("tks").iter().map(|t| t.as_object().expect("a touch").clone()).collect();
    let measured = cases(p, "measures");
    assert!(measured.len() > 150);
    for case in measured {
        let picked: Vec<&ai_run::Model> =
            case["runs"].as_array().expect("runs").iter().map(|i| &runs[i.as_u64().expect("index") as usize]).collect();
        let touched: Vec<&Map<String, Value>> = if case["tks"] == "some" { tks.iter().collect() } else { Vec::new() };
        let spend: Vec<f64> = case["spend"].as_array().expect("spend").iter().filter_map(Value::as_f64).collect();
        let got = health::measures(
            &picked,
            &touched,
            &tickets,
            health::MeasureOpts {
                team: teams.get(case["team"].as_str().expect("team")),
                month_spend: &spend,
                judged: case["judged"].as_bool().expect("judged"),
                until: case["until"].as_str(),
            },
        );
        let what = format!(
            "runs {} team {} spend {} judged {} tks {} until {}",
            case["runs"], case["team"], case["spend"], case["judged"], case["tks"], case["until"]
        );
        for (measure, want) in case["out"].as_object().expect("measures") {
            assert_eq!(
                keys(got[measure].as_object().expect("a measure")),
                keys(want.as_object().expect("a measure")),
                "{what}: the keys of {measure}"
            );
            for (key, value) in want.as_object().expect("a measure") {
                assert_eq!(&got[measure][key], value, "{what}: {measure}.{key}");
            }
        }
        assert_eq!(keys(got.as_object().expect("measures")), keys(case["out"].as_object().expect("measures")));
    }
}

#[test]
fn a_history_row_and_the_fallback_summary() {
    let g = golden();
    let p = &g["pure"];
    for case in cases(p, "history_to_dict") {
        let got = session_history::to_dict(&model(&case["row"]));
        assert_eq!(keys(&got), case["keys"]);
        assert_eq!(Value::Object(got), case["out"]);
    }
    for case in cases(p, "fallback") {
        let runs: Vec<ai_run::Model> = case["runs"].as_array().expect("runs").iter().map(model).collect();
        let (title, summary) = session_history::fallback(&runs, case["digest"].as_str().expect("digest"));
        assert_eq!(json!([title, summary]), case["out"], "{}", case["runs"][0]["instruction"]);
    }
}

/// A value with what differs from one run to the next taken out: the time a mark or a lesson was made, and the id of
/// a lesson that was made.
fn settled(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let v = match (k.as_str(), v) {
                        ("marked_at" | "created_at" | "updated_at", Value::String(_)) => json!("<time>"),
                        ("lesson_id" | "id", Value::String(id)) if id.starts_with("lsn_") => json!("<lesson>"),
                        _ => settled(v),
                    };
                    (k.clone(), v)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(settled).collect()),
        other => other.clone(),
    }
}

fn touch_error<T>(result: Result<T, touches::Error>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({"ok": ok(value)}),
        Err(touches::Error::Touch(message)) => refusal("TouchError", &message),
        Err(other) => panic!("not a TouchError: {other:?}"),
    }
}

#[tokio::test]
async fn the_touches_and_the_health_of_a_project() {
    let _guard = common::init().await;
    let g = golden();
    let now = now_of(&g);
    clock::set_now(Some(now));
    let r = &g["review"];
    common::insert_all(&r["rows"]).await;
    const P: &str = "p-rev";
    let session = database::session();
    assert_eq!(
        json!({"24h": kb_base::time::iso(&touches::since_of("24h", None)), "90d": kb_base::time::iso(&touches::since_of("90d", None))}),
        g["pure"]["since_of_default_now"]
    );
    for (range, want) in r["collect"].as_object().expect("ranges") {
        let got = touches::collect(&session, P, touches::since_of(range, None), None).await.expect("collect");
        assert_eq!(got.len(), want.as_array().expect("touches").len(), "{range}");
        for (got, want) in got.iter().zip(want.as_array().expect("touches")) {
            assert_eq!(keys(got), keys(want.as_object().expect("a touch")), "{range}");
            assert_eq!(&Value::Object(got.clone()), want, "{range}: {}", want["id"]);
        }
    }
    for (project, want) in r["collect_other"].as_object().expect("projects") {
        let got = touches::collect(&session, project, touches::since_of("90d", None), None).await.expect("collect");
        assert_eq!(&maps(got), want, "{project}");
    }
    let every = touches::collect(&session, P, now - Duration::days(400), None).await.expect("collect");
    assert_eq!(maps(every), r["collect_all"]);
    for case in cases(r, "by_key") {
        let since = touches::since_of(case["since"].as_str().expect("since"), None);
        let got = touches::collect(&session, P, since, case["key"].as_str()).await.expect("collect");
        assert_eq!(maps(got), case["out"], "key {} since {}", case["key"], case["since"]);
    }
    for case in cases(r, "stepped_in") {
        let a = &case["args"];
        let project = a["project_id"].as_str().unwrap_or(P);
        let got = touches::stepped_in(
            &session,
            project,
            a["range_key"].as_str().expect("range"),
            a["team_id"].as_str(),
            a["kind"].as_str(),
            a["mark"].as_str(),
        )
        .await
        .expect("stepped_in");
        assert_eq!(keys(&got), keys(case["out"].as_object().expect("the tab")), "{a}");
        for (key, value) in &got {
            assert_eq!(value, &case["out"][key], "{a}: {key}");
        }
    }
    let got = touches::stepped_in(&session, P, touches::DEFAULT_RANGE, None, None, None).await.expect("stepped_in");
    assert_eq!(Value::Object(got), r["stepped_default"]);

    for case in cases(r, "health") {
        let project = case["project_id"].as_str().expect("project");
        let range = case["range_key"].as_str().expect("range");
        let got = health::health(&session, project, range).await.expect("health");
        let what = format!("{project} {range}");
        assert_eq!(keys(&got), case["keys"], "{what}");
        for (key, value) in &got {
            match key.as_str() {
                "measures" => {
                    for (measure, numbers) in value.as_object().expect("measures") {
                        for (name, number) in numbers.as_object().expect("a measure") {
                            assert_eq!(number, &case["out"][key][measure][name], "{what}: measures.{measure}.{name}");
                        }
                    }
                }
                "teams" => {
                    let want = case["out"][key].as_array().expect("teams");
                    assert_eq!(value.as_array().expect("teams").len(), want.len(), "{what}: teams");
                    for (got, want) in value.as_array().expect("teams").iter().zip(want) {
                        assert_eq!(got, want, "{what}: the row of {}", want["name"]);
                    }
                }
                "fixes" => {
                    let want = case["out"][key].as_array().expect("fixes");
                    let ids = |list: &[Value]| list.iter().map(|f| f["id"].clone()).collect::<Vec<_>>();
                    assert_eq!(ids(value.as_array().expect("fixes")), ids(want), "{what}: what to fix");
                    for (got, want) in value.as_array().expect("fixes").iter().zip(want) {
                        assert_eq!(
                            keys(got.as_object().expect("a finding")),
                            keys(want.as_object().expect("a finding"))
                        );
                        assert_eq!(got, want, "{what}: {}", want["id"]);
                    }
                }
                _ => assert_eq!(value, &case["out"][key], "{what}: {key}"),
            }
        }
    }
    let got = health::health(&session, P, "7d").await.expect("health");
    assert_eq!(Value::Object(got), r["health_default"]);
    drop(session);

    // marks and lessons, step by step
    for step in cases(&r["marks"], "steps") {
        let (project, key, by) = (
            step["project_id"].as_str().expect("project"),
            step["key"].as_str().expect("key"),
            step["by"].as_str().expect("by"),
        );
        let session = database::session();
        let got = match step["call"].as_str().expect("call") {
            "set_mark" => {
                touch_error(touches::set_mark(&session, project, key, step["mark"].as_str(), by).await, Value::Object)
            }
            _ => touch_error(
                touches::make_lesson(&session, project, key, step["text"].as_str(), by).await,
                Value::Object,
            ),
        };
        let what = format!("{} {key} {} {}", step["call"], step["mark"], step["text"]);
        let want = if step.get("ok").is_some() { json!({"ok": step["ok"]}) } else { json!({"error": step["error"]}) };
        assert_eq!(settled(&got), settled(&want), "{what}");
        let row = ai_touch_mark::Entity::find_by_id(key).one(&session).await.expect("db");
        assert_eq!(settled(&json!(row)), settled(&step["row"]), "{what}: the mark's row");
    }
    let session = database::session();
    let lessons = ai_lesson::Entity::find()
        .filter(ai_lesson::Column::ProjectId.eq(P))
        .order_by_asc(ai_lesson::Column::CreatedAt)
        .all(&session)
        .await
        .expect("lessons");
    let kept: Vec<Value> = lessons
        .iter()
        .map(|x| {
            json!({
                "text": x.text, "state": x.state, "source_ticket_id": x.source_ticket_id,
                "source_run_id": x.source_run_id, "proposed_by": x.proposed_by, "kept_by": x.kept_by,
            })
        })
        .collect();
    assert_eq!(json!(kept), r["marks"]["lessons"]);
    clock::set_now(None);
}

async fn last_seq() -> i32 {
    let session = database::session();
    let last =
        ai_audit::Entity::find().order_by_desc(ai_audit::Column::Seq).one(&session).await.expect("the audit log");
    last.map_or(0, |l| l.seq)
}

async fn audits_after(seq: i32) -> Value {
    let session = database::session();
    let rows = ai_audit::Entity::find()
        .filter(ai_audit::Column::Seq.gt(seq))
        .order_by_asc(ai_audit::Column::Seq)
        .all(&session)
        .await
        .expect("the audit log");
    rows.iter()
        .map(|r| {
            json!({
                "project_id": r.project_id, "member_id": r.member_id, "member_name": r.member_name,
                "on_behalf_of": r.on_behalf_of, "run_id": r.run_id, "action": r.action, "target": r.target,
                "result": r.result, "detail": r.detail,
            })
        })
        .collect()
}

#[tokio::test]
async fn an_edit_a_sign_in_and_a_pause_are_written_to_the_audit_log() {
    let _guard = common::init().await;
    let g = golden();
    clock::set_now(Some(now_of(&g)));
    let r = &g["recording"];
    common::insert_all(&r["rows"]).await;
    for call in cases(r, "calls") {
        let before = last_seq().await;
        let by = call["by"].as_str();
        match call["call"].as_str().expect("call") {
            "record_edit" => {
                let session = database::session();
                let n = touches::record_edit(
                    &session,
                    call["ticket_id"].as_str().expect("ticket"),
                    by,
                    call["what"].as_str().expect("what"),
                )
                .await
                .expect("record_edit");
                assert_eq!(json!(n), call["out"], "{call}");
            }
            "record_signin" => {
                let session = database::session();
                let account = ai_account::Entity::find_by_id(call["account_id"].as_str().expect("account"))
                    .one(&session)
                    .await
                    .expect("db")
                    .expect("the account");
                let n = touches::record_signin(&session, &account, by.expect("by")).await;
                assert_eq!(json!(n), call["out"], "{call}");
            }
            _ => {
                touches::record_pause(
                    "p-rec",
                    call["action"].as_str().expect("action"),
                    by.expect("by"),
                    call["detail"].as_object().cloned(),
                )
                .await;
            }
        }
        let written = audits_after(before).await;
        // (the entries of a sign-in are one per project, in the order the teams are read)
        assert_eq!(
            written,
            call["audit"],
            "{}",
            serde_json::to_string(&call).expect("json").chars().take(200).collect::<String>()
        );
    }
    clock::set_now(None);
}

/// The board's assistant as the generator replaced `engine.oneshot`: an answer per ticket, an error for any other.
struct Assistant {
    answers: HashMap<&'static str, AssistTurn>,
    asked: Mutex<Vec<Value>>,
}

#[async_trait::async_trait]
impl seams::Assistant for Assistant {
    async fn oneshot(
        &self,
        skill: &str,
        inputs: Map<String, Value>,
        by: &str,
        model: &str,
    ) -> Result<AssistTurn, AssistFailure> {
        let ticket_id = inputs["ticket"].as_str().expect("ticket").split(' ').next().expect("an id").to_string();
        self.asked.lock().expect("lock").push(json!({"skill": skill, "inputs": inputs, "by": by, "model": model}));
        self.answers.get(ticket_id.as_str()).cloned().ok_or_else(|| AssistFailure::Other("no assistant".into()))
    }

    async fn turn(&self, _project_id: &str, _ask: AssistAsk) -> Result<AssistTurn, AssistFailure> {
        Err(AssistFailure::Other("not asked here".into()))
    }
}

fn turn(state: &str, title: &str, summary: &str, model: Option<&str>) -> AssistTurn {
    let structured = json!({"title": title, "summary": summary}).as_object().cloned();
    AssistTurn {
        state: state.to_string(),
        data: structured.clone().unwrap_or_default(),
        structured,
        member: "Board AI".to_string(),
        model: model.map(str::to_string),
        ..Default::default()
    }
}

#[tokio::test]
async fn the_history_of_a_teams_conversations_on_a_ticket() {
    let _guard = common::init().await;
    let g = golden();
    let h = &g["history"];
    common::insert_all(&h["rows"]).await;
    let session = database::session();
    for case in cases(h, "rows_for") {
        let ticket_id = case["ticket_id"].as_str().expect("ticket");
        let rows =
            session_history::rows_for(&session, ticket_id, case["limit"].as_u64().expect("limit")).await.expect("rows");
        assert_eq!(json!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>()), case["out"], "{case}");
    }
    for (ticket_id, want) in h["list_for_ticket"].as_object().expect("tickets") {
        assert_eq!(&maps(session_history::list_for_ticket(ticket_id, 20).await.expect("list")), want, "{ticket_id}");
    }
    for (ticket_id, want) in h["list_for_ticket_10"].as_object().expect("tickets") {
        assert_eq!(&maps(session_history::list_for_ticket(ticket_id, 10).await.expect("list")), want, "{ticket_id}");
    }
    for (ticket_id, want) in h["closed_session_ids"].as_object().expect("tickets") {
        let mut ids: Vec<String> =
            session_history::closed_session_ids(&session, ticket_id).await.expect("ids").into_iter().collect();
        ids.sort();
        assert_eq!(&json!(ids), want, "{ticket_id}");
    }
    for case in cases(h, "prompt_block") {
        let ticket_id = case["ticket_id"].as_str().expect("ticket");
        let got = session_history::prompt_block(&session, ticket_id, case["limit"].as_u64().expect("limit"))
            .await
            .expect("block");
        assert_eq!(json!(got), case["out"], "{ticket_id}");
    }
    for case in cases(h, "digest") {
        let mut runs = Vec::new();
        for id in case["runs"].as_array().expect("runs") {
            let id = id.as_str().expect("id");
            runs.push(ai_run::Entity::find_by_id(id).one(&session).await.expect("db").expect("the run"));
        }
        assert_eq!(
            json!(session_history::digest(&session, &runs).await.expect("digest")),
            case["out"],
            "{}",
            case["runs"]
        );
    }
    let long: Vec<ai_run::Model> = h["digest_long"]["runs"].as_array().expect("runs").iter().map(model).collect();
    let text = session_history::digest(&session, &long).await.expect("digest");
    assert_eq!(json!(text.chars().count()), h["digest_long"]["chars"]);
    assert_eq!(json!(text.chars().take(80).collect::<String>()), h["digest_long"]["head"]);
    let tail: String = text.chars().skip(text.chars().count() - 80).collect();
    assert_eq!(json!(tail), h["digest_long"]["tail"]);
    drop(session);

    // start over: the assistant answers, fails, or is not there
    let assistant = Arc::new(Assistant {
        answers: HashMap::from([
            (
                "HIS-4",
                turn(
                    "finished",
                    &format!("  A fine title  {}", "t".repeat(100)),
                    "  The team summarised it.  ",
                    Some("claude-light"),
                ),
            ),
            ("HIS-1", turn("finished", "", "Second try worked.", None)),
            ("HIS-2", turn("finished", "Ignored", "   ", Some("m"))),
            ("HIS-5", turn("failed", "T", "Not used.", Some("m"))),
        ]),
        asked: Mutex::new(Vec::new()),
    });
    seams::set_assistant(Some(assistant.clone()));
    for case in cases(h, "start_over") {
        let ticket_id = case["ticket_id"].as_str().expect("ticket");
        let got = match session_history::start_over(ticket_id, "An Nguyen").await {
            Ok(mut row) => {
                assert!(row["id"].as_str().expect("id").starts_with("ses_"));
                row.shift_remove("id");
                row.shift_remove("ended_at");
                json!({"ticket_id": ticket_id, "ok": row})
            }
            Err(RunError::Run(message)) => {
                json!({"ticket_id": ticket_id, "error": ["RunError", message]})
            }
            Err(other) => panic!("{ticket_id}: {other:?}"),
        };
        assert_eq!(got, case, "{ticket_id}");
    }
    assert_eq!(json!(*assistant.asked.lock().expect("lock")), h["asked"]);
    // with no assistant at all the digest stands in
    seams::set_assistant(None);
    let again = session_history::start_over("HIS-1", "An Nguyen").await;
    assert!(matches!(again, Err(RunError::Run(message)) if message.starts_with("Nothing to close")));
}

#[tokio::test]
async fn compacting_the_conversation_of_a_ticket() {
    let _guard = common::init().await;
    let g = golden();
    let c = &g["compact"];
    let tool = common::local_text(c["tool"].as_str().expect("tool"));
    let repo = common::local_text(c["repo"].as_str().expect("repo"));
    std::fs::create_dir_all(&repo).expect("the repository");
    let tool = std::path::Path::new(&tool);
    let text = c["script"].as_str().expect("script").strip_prefix("#!/bin/sh\n").expect("a shell script").to_string();
    common::script(tool.parent().expect("a folder"), "compact-claude", text.trim_end_matches('\n'), true);
    let sessions = std::path::Path::new(&std::env::var("CLAUDE_CONFIG_DIR").expect("set by init"))
        .join("projects")
        .join("compact-repo");
    std::fs::create_dir_all(&sessions).expect("the sessions folder");
    for name in c["sessions"].as_array().expect("sessions") {
        std::fs::write(sessions.join(format!("{}.jsonl", name.as_str().expect("a name"))), "{}\n").expect("a session");
    }
    common::insert_all(&c["rows"]).await;
    let by = format!("An Nguyen {}", "n".repeat(250));
    for call in cases(c, "calls") {
        let ticket_id = call["ticket_id"].as_str().expect("ticket");
        let args_file = std::path::Path::new(&repo).join("args.txt");
        let _ = std::fs::remove_file(&args_file);
        let got = match compact::compact_ticket(ticket_id, &by).await {
            Ok(done) => json!({"ok": done}),
            Err(RunError::Run(message)) => refusal("RunError", &message),
            Err(other) => panic!("{ticket_id}: {other:?}"),
        };
        let want = if call.get("ok").is_some() { json!({"ok": call["ok"]}) } else { json!({"error": call["error"]}) };
        assert_eq!(got, want, "{ticket_id}");
        let session = database::session();
        let runs = ai_run::Entity::find()
            .filter(ai_run::Column::TicketId.eq(ticket_id))
            .order_by_asc(ai_run::Column::Number)
            .all(&session)
            .await
            .expect("runs");
        let after: Vec<Value> = runs
            .iter()
            .map(|r| json!({"id": r.id, "session_id": r.session_id, "context_used": r.context_used}))
            .collect();
        assert_eq!(json!(after), call["runs"], "{ticket_id}: the runs after it");
        let messages = ai_run_message::Entity::find()
            .filter(ai_run_message::Column::RunId.is_in(runs.iter().map(|r| r.id.clone())))
            .all(&session)
            .await
            .expect("messages");
        let messages: Vec<Value> = messages
            .iter()
            .map(|m| json!({"run_id": m.run_id, "direction": m.direction, "peer": m.peer, "text": m.text}))
            .collect();
        assert_eq!(json!(messages), call["messages"], "{ticket_id}: the messages");
        let args = std::fs::read_to_string(&args_file)
            .ok()
            .map(|text| text.lines().map(common::golden_text).collect::<Vec<_>>());
        assert_eq!(json!(args), call["args"], "{ticket_id}: what the CLI was started with");
    }
}

#[tokio::test]
async fn a_wish_to_compact_is_granted_when_the_run_has_ended() {
    let _guard = common::init().await;
    let (pid, _) = common::project().await;
    let repo = common::tmp_path("compact-after");
    let tool = common::script(
        &common::folder().join("tools"),
        "compact-after",
        "echo '{\"subtype\":\"compact_boundary\",\"compact_metadata\":{\"pre_tokens\":9,\"post_tokens\":4},\"session_id\":\"after-2\"}'",
        true,
    );
    let (team, _) = common::team(
        &pid,
        "Wish Team",
        common::TeamOpts { working_dir: Some(repo.to_string_lossy().into_owned()), ..Default::default() },
    )
    .await;
    {
        use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
        let session = database::session();
        let profile = ai_team::Entity::find_by_id(team.id.as_str()).one(&session).await.expect("db").expect("team");
        let mut row = profile.into_active_model();
        row.cli_path = Set(Some(tool.to_string_lossy().into_owned()));
        row.update(&session).await.expect("update");
        session.commit().await.expect("commit");
    }
    let sessions =
        std::path::Path::new(&std::env::var("CLAUDE_CONFIG_DIR").expect("set by init")).join("projects").join("wish");
    std::fs::create_dir_all(&sessions).expect("the sessions folder");
    std::fs::write(sessions.join("after-1.jsonl"), "{}\n").expect("a session");
    let tk = common::ticket(&pid, "Wish", "todo").await;
    let run = common::run(&pid, &team.id, Some(&tk.id), "running", |r| {
        r.session_id = kb_db::sea_orm::ActiveValue::Set(Some("after-1".into()));
    })
    .await;
    // while the run works the wish is kept on it
    let queued = compact::compact_ticket(&tk.id, "An Nguyen").await.expect("queued");
    assert_eq!(Value::Object(queued), json!({"state": "queued", "run_id": run.id}));
    // the run ends: the board compacts the conversation itself and the wish is gone
    {
        use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
        let session = database::session();
        let mut row = run.clone().into_active_model();
        row.state = Set("finished".into());
        row.update(&session).await.expect("update");
        session.commit().await.expect("commit");
    }
    compact::set_settle_s(0.05);
    compact::after_run(&tk.id, &run.id);
    let mut after = None;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let session = database::session();
        let row = ai_run::Entity::find_by_id(run.id.as_str()).one(&session).await.expect("db").expect("the run");
        if row.session_id.as_deref() == Some("after-2") {
            after = Some(row);
            break;
        }
    }
    compact::set_settle_s(2.0);
    let after = after.expect("the conversation was compacted after the run");
    assert_eq!(after.context_used, Some(4));
    let session = database::session();
    let left = ai_run_message::Entity::find()
        .filter(ai_run_message::Column::RunId.eq(run.id.as_str()))
        .all(&session)
        .await
        .expect("messages");
    assert!(left.is_empty(), "{left:?}");
    // a run nobody asked to compact is left alone
    compact::after_run(&tk.id, &run.id);
}
