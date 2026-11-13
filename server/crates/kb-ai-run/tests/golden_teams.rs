//! `teams` against what the Python module gave (`contract/golden/ai_teams.json`, made by `gen_ai_teams.py`): names and
//! colours, a team's data, the status of a team in every state, what a run's end and a runner check do to its health,
//! `check_name` over a table of names, `create` and `update` over tables of data (the stored rows, the refusals, the
//! audit entries), and `describe`, `list_teams` and `removal_impact` for teams in every shape. The rows of each
//! situation are the ones the Python models dumped.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use kb_ai_run::teams;
use kb_db::database;
use kb_db::entities::{ai_audit, ai_project_settings, ai_run, ai_team, member};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, TryIntoModel};
use serde_json::{Map, Value, json};

const STAMP: &str = "2025-01-01T00:00:00+00:00";

fn golden() -> Value {
    common::golden("ai_teams.json")
}

fn cases(g: &Value, name: &str) -> Vec<Value> {
    let cases = g[name].as_array().unwrap_or_else(|| panic!("{name}")).clone();
    assert!(!cases.is_empty(), "{name}");
    cases
}

fn refused<T: serde::Serialize>(result: Result<T, teams::Error>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(teams::Error::Team(message)) => json!({"error": message}),
        Err(other) => panic!("not a TeamError: {other:?}"),
    }
}

/// Every number as a float: a Python model keeps the int it was given for a float column, the database does not.
fn loose(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64()),
        Value::Array(items) => Value::Array(items.iter().map(loose).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), loose(v))).collect()),
        other => other.clone(),
    }
}

/// A value this process made, as the golden file writes it: the folders, and today's date.
fn shown(value: &Value) -> Value {
    let text = serde_json::to_string(&common::to_golden(value)).expect("json");
    serde_json::from_str(&text.replace(&common::today(), "<TODAY>")).expect("json")
}

/// A stored row without the columns the generator left out.
fn stored<M: serde::Serialize>(row: &M, drop: &[&str]) -> Value {
    let mut map = serde_json::to_value(row).expect("a row").as_object().expect("a row").clone();
    for key in drop {
        map.shift_remove(*key);
    }
    loose(&common::to_golden(&Value::Object(map)))
}

fn data_of(case: &Value) -> Map<String, Value> {
    let mut data = common::to_local(&case["data"]).as_object().expect("data").clone();
    data.shift_remove("health");
    data
}

async fn last_audit(project_id: &str) -> Value {
    let session = database::session();
    let row = ai_audit::Entity::find()
        .filter(ai_audit::Column::ProjectId.eq(project_id))
        .order_by_desc(ai_audit::Column::Seq)
        .limit(1)
        .one(&session)
        .await
        .expect("db");
    match row {
        Some(r) => json!({
            "action": r.action,
            "result": r.result,
            "member_name": r.member_name,
            "on_behalf_of": r.on_behalf_of,
            "detail": r.detail,
        }),
        None => Value::Null,
    }
}

/// A refusal against the generator's `[type name, message]`: a `TeamError` with its words, anything else by its kind.
fn same_error(err: &teams::Error, want: &Value, what: &str) {
    match (err, want[0].as_str().expect("the kind of error")) {
        (teams::Error::Team(message), "TeamError") => assert_eq!(json!(message), want[1], "{what}"),
        (teams::Error::Value(_), "ValueError") => {}
        (teams::Error::Other(_) | teams::Error::Db(_), kind) if !matches!(kind, "TeamError" | "ValueError") => {}
        (err, kind) => panic!("{what}: {err:?} where Python raised {kind}"),
    }
}

#[test]
fn names_colours_and_a_teams_data() {
    let g = golden();
    let p = &g["pure"];
    for case in cases(p, "clean_name") {
        assert_eq!(refused(teams::clean_name(case["name"].as_str().expect("name"))), case["out"], "{}", case["name"]);
    }
    for case in cases(p, "clean_color") {
        let color = case["color"].as_str().expect("color");
        assert_eq!(refused(teams::clean_color(color)), case["out"], "{color:?}");
    }
    for case in cases(p, "validate") {
        let data = case["data"].as_object().expect("data");
        assert_eq!(refused(teams::validate(data)), case["out"], "{}", case["data"]);
    }
    let c = &p["constants"];
    assert_eq!(json!(teams::AI_COLORS), c["AI_COLORS"]);
    assert_eq!(json!(teams::MAX_PERSONA), c["MAX_PERSONA"]);
    assert_eq!(json!(teams::MODELS), c["MODELS"]);
    assert_eq!(json!(teams::EFFORTS), c["EFFORTS"]);
    assert_eq!(json!(teams::PERMISSION_MODES), c["PERMISSION_MODES"]);
    assert_eq!(Some(teams::HEALTH_INTERVAL_S), c["HEALTH_INTERVAL_S"].as_f64());
    assert_eq!(Some(teams::HEALTH_STALE_S), c["HEALTH_STALE_S"].as_f64());
    assert_eq!(Some(teams::ACCOUNT_STALE_S), c["ACCOUNT_STALE_S"].as_f64());
    assert_eq!(json!(teams::EDITABLE), c["EDITABLE"]);
}

fn profile_of(health: &str, detail: Option<&str>) -> ai_team::Model {
    let mut t = ai_team::new();
    t.id = Set("m".into());
    t.project_id = Set("p".into());
    t.health = Set(health.into());
    t.health_detail = Set(detail.map(str::to_string));
    t.try_into_model().expect("a team")
}

#[tokio::test]
async fn the_status_and_the_health_of_a_team() {
    let _guard = common::init().await;
    let g = golden();
    let p = &g["pure"];
    for case in cases(p, "status_of") {
        let mut m = member::new();
        m.id = Set("m".into());
        m.project_id = Set("p".into());
        m.name = Set("Dev An".into());
        m.color = Set("#000000".into());
        m.kind = Set(case["kind"].as_str().expect("kind").into());
        let m = m.try_into_model().expect("a member");
        let health = case["health"].as_str().expect("health");
        let detail = (!matches!(health, "ok" | "unknown")).then(|| format!("detail of {health}"));
        let mut profile = profile_of(health, detail.as_deref());
        profile.paused = case["paused"].as_bool().expect("paused");
        profile.paused_reason = profile.paused.then(|| "lunch".to_string());
        let mut settings = common::settings_model("p", None);
        settings.paused_all = case["paused_all"].as_bool().expect("paused_all");
        settings.paused_reason = settings.paused_all.then(|| "Stopped by An".to_string());
        let runs: Vec<ai_run::Model> = case["runs"]
            .as_array()
            .expect("runs")
            .iter()
            .map(|state| {
                let mut r = common::run_model("p", "m", None);
                r.state = state.as_str().expect("state").into();
                r.ticket_id = Some("KAN-1".into());
                r
            })
            .collect();
        let got = teams::status_of(&m, &profile, &runs, &settings);
        assert_eq!(got, case["out"], "{case}");
        assert_eq!(json!(got.as_object().expect("status").keys().collect::<Vec<_>>()), case["keys"], "{case}");
    }
    for case in cases(p, "note_run_outcome") {
        let mut profile = profile_of(case["health"].as_str().expect("health"), Some("before"));
        let changed = teams::note_run_outcome(
            &mut profile,
            case["state"].as_str().expect("state"),
            case["stop_code"].as_str(),
            case["reason"].as_str(),
        );
        assert_eq!(json!(changed), case["changed"], "{case}");
        assert_eq!(json!([profile.health, profile.health_detail]), case["after"], "{case}");
    }
    for file in cases(p, "files") {
        let path = common::local_text(file["path"].as_str().expect("path"));
        std::fs::create_dir_all(std::path::Path::new(&path).parent().expect("parent")).expect("folder");
        std::fs::write(&path, file["text"].as_str().expect("text")).expect("file");
    }
    for case in cases(p, "apply_health") {
        let mut profile = profile_of(case["health"].as_str().expect("health"), Some("before"));
        profile.cli_path = case["cli_path"].as_str().map(common::local_text);
        teams::apply_health(&mut profile, case["info"].as_object().expect("info")).await;
        let after = json!([profile.health, profile.health_detail.as_deref().map(common::golden_text)]);
        assert_eq!(after, case["after"], "{case}");
    }
}

#[tokio::test]
async fn check_name_over_a_table_of_names() {
    let _guard = common::init().await;
    let g = golden();
    common::insert_all(&g["check_name"]["rows"]).await;
    let session = database::session();
    for case in cases(&g["check_name"], "cases") {
        let got = teams::check_name(
            &session,
            case["project_id"].as_str().expect("project"),
            case["name"].as_str().expect("name"),
            case["exclude_id"].as_str(),
        )
        .await
        .expect("check_name");
        assert_eq!(Value::Object(got.clone()), case["out"], "{} (except {})", case["name"], case["exclude_id"]);
        assert_eq!(got.keys().collect::<Vec<_>>(), ["ok", "conflict", "message", "suggestion"]);
    }
}

#[tokio::test]
async fn create_over_a_table_of_data() {
    let _guard = common::init().await;
    let g = golden();
    common::insert_all(&g["create"]["rows"]).await;
    for case in cases(&g["create"], "cases") {
        let what = case["data"].to_string();
        let session = database::session();
        match teams::create(&session, "p-edit", &data_of(&case), "An Nguyen").await {
            Err(err) => same_error(&err, &case["error"], &what),
            Ok(m) => {
                assert!(case["error"].is_null(), "{what}: Python refused with {}", case["error"]);
                assert_eq!(stored(&m, &["id", "created_at"]), loose(&case["member"]), "{what}");
                let (_, profile) = teams::get_profile(&session, &m.id).await.expect("rows");
                let profile = profile.expect("the profile");
                assert_eq!(profile.id, m.id);
                assert_eq!(stored(&profile, &["id", "created_at", "updated_at"]), loose(&case["profile"]), "{what}");
                assert_eq!(last_audit("p-edit").await, case["audit"], "{what}");
            }
        }
    }
}

#[tokio::test]
async fn update_over_a_table_of_data() {
    let _guard = common::init().await;
    let g = golden();
    common::insert_all(&g["update"]["rows"]).await;
    for case in cases(&g["update"], "steps") {
        let what = case["data"].to_string();
        let member_id = case["member_id"].as_str().unwrap_or("u-team");
        let session = database::session();
        if case["data"].get("health").is_some() {
            // a healthy, checked team: only a new folder, CLI or account resets that
            let (_, profile) = teams::get_profile(&session, "u-team").await.expect("rows");
            let read = profile.expect("the profile");
            let mut profile = read.clone();
            profile.health = "ok".into();
            profile.health_detail = Some("was fine".into());
            profile.checked_at = Some(STAMP.into());
            kb_db::save_model(&session, &read, profile).await.expect("save");
            session.commit().await.expect("commit");
        }
        match teams::update(&session, member_id, &data_of(&case), "An Nguyen").await {
            Err(err) => same_error(&err, &case["error"], &what),
            Ok(profile) => {
                assert!(case["error"].is_null(), "{what}: Python refused with {}", case["error"]);
                assert_eq!(stored(&profile, &["updated_at"]), loose(&case["profile"]), "{what}");
                assert!(profile.updated_at.as_str() > STAMP);
                let (m, again) = teams::get_profile(&session, member_id).await.expect("rows");
                assert_eq!(again.as_ref(), Some(&profile), "{what}: what was returned is what is stored");
                assert_eq!(stored(&m.expect("member"), &[]), loose(&case["member"]), "{what}");
                assert_eq!(last_audit("p-update").await, case["audit"], "{what}");
            }
        }
    }
}

#[tokio::test]
async fn describe_and_list_teams_in_every_shape() {
    let _guard = common::init().await;
    let g = golden();
    let d = &g["describe"];
    common::insert_all(&d["rows"]).await;
    let session = database::session();
    for (team_id, want) in d["describe"].as_object().expect("teams") {
        let (m, profile) = teams::get_profile(&session, team_id).await.expect("rows");
        let (m, profile) = (m.expect("member"), profile.expect("profile"));
        let got = teams::describe(&session, &m, &profile, None).await.expect("describe");
        assert_eq!(json!(got.keys().collect::<Vec<_>>()), want["keys"], "{team_id}: the order of the keys");
        for (key, value) in &got {
            assert_eq!(shown(value), want["out"][key], "{team_id}: {key}");
        }
        let impact = teams::removal_impact(&session, team_id).await.expect("impact");
        assert_eq!(shown(&Value::Object(impact)), d["removal_impact"][team_id], "{team_id}: removal_impact");
    }
    let ids = |teams: &[Map<String, Value>]| teams.iter().map(|t| t["id"].clone()).collect::<Vec<_>>();
    let listed = teams::list_teams(&session, "p-describe", false).await.expect("list");
    assert_eq!(json!(ids(&listed)), d["list"]);
    let listed = teams::list_teams(&session, "p-describe", true).await.expect("list");
    assert_eq!(json!(ids(&listed)), d["list_removed"]);
    // with every AI of the project paused
    let settings = ai_project_settings::Entity::find_by_id("p-describe").one(&session).await.expect("db");
    let read = settings.expect("made by describe");
    let mut settings = read.clone();
    settings.paused_all = true;
    settings.paused_reason = Some("Stopped by An".into());
    kb_db::save_model(&session, &read, settings).await.expect("save");
    session.commit().await.expect("commit");
    let listed = teams::list_teams(&session, "p-describe", true).await.expect("list");
    let statuses: Map<String, Value> =
        listed.iter().map(|t| (t["id"].as_str().expect("id").to_string(), t["status"].clone())).collect();
    assert_eq!(Value::Object(statuses), d["paused_all"]);
}
