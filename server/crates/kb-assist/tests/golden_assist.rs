//! The assistants against what the Python modules gave (`contract/golden/assist.json`, made by `gen_assist.py`): the
//! pure functions and constants of every module, three scenarios on the database (settings, receipts, board health)
//! and everything a turn is started with over a matrix of situations (the command line, the settings JSON, the MCP
//! config, the schema, the system prompts, the child's environment), each built from the rows the Python models
//! dumped and run with a program that records what it is started with.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::{Arc, LazyLock};

use kb_assist::assistant::engine::{self, OneshotOpts, Schema, Turn, TurnOpts};
use kb_assist::assistant::errors::{self, Error};
use kb_assist::assistant::{chat, drafts, health, receipt, sessions, settings, skills};
use kb_assist::seams;
use kb_base::pyjson;
use kb_db::database;
use kb_db::entities::{ai_assist_settings, ai_run, ai_team, ai_usage, docs_ai_session, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::Digest;

/// What the board's own environment holds besides the folders (`BOARD_ENV` of the generator).
const BOARD_ENV: [(&str, &str); 5] = [
    ("CLAUDECODE", "1"),
    ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ("CLAUDE_CODE_SESSION_ID", "board-session"),
    ("ANTHROPIC_API_KEY", "sk-ant-board-key"),
    ("CLAUDE_CODE_OAUTH_TOKEN", "board-oauth"),
];
/// What the shell of the recorder adds to its environment, and the variable that names the stream to print.
const SHELL_VARS: [&str; 5] = ["PWD", "OLDPWD", "SHLVL", "_", "GOLDEN_STREAM"];

static GOLDEN: LazyLock<Value> = LazyLock::new(|| common::golden("assist.json"));

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a pattern written in the test")
}

static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| re(r"kbr_chat_[A-Za-z0-9_-]+"));
static UUID_RE: LazyLock<Regex> = LazyLock::new(|| re(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));
static RUN_RE: LazyLock<Regex> = LazyLock::new(|| re(r"run_[0-9a-f]{12}"));
static TIME_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+00:00"));
static DAY_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\d{4}-\d\d-\d\d"));
static ONESHOT_RE: LazyLock<Regex> = LazyLock::new(|| re(r"oneshot-[0-9a-f]{8}"));

/// `scrub` of the generator for a text: this process's folders and what differs from one run to the next, as marks.
fn scrub_text(text: &str) -> String {
    let text = common::golden_text(text);
    let text = TOKEN_RE.replace_all(&text, "<TOKEN>");
    let text = UUID_RE.replace_all(&text, "<UUID>");
    let text = RUN_RE.replace_all(&text, "<RUN>");
    let text = TIME_RE.replace_all(&text, "<TIME>");
    let text = DAY_RE.replace_all(&text, "<DAY>");
    ONESHOT_RE.replace_all(&text, "oneshot-<ID>").into_owned()
}

/// `scrub` of the generator.
fn scrub(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(scrub_text(s)),
        Value::Array(items) => Value::Array(items.iter().map(scrub).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (scrub_text(k), scrub(v))).collect()),
        other => other.clone(),
    }
}

fn is_hash(want: &Value) -> bool {
    want.as_object().is_some_and(|m| m.len() == 2 && m.contains_key("sha256") && m.contains_key("chars"))
}

/// `got` against `want`, key order included (what is stored keeps the order of the Python dict); a long text of the
/// golden file is its hash and length. Numbers compare by value.
fn same_value(got: &Value, want: &Value, what: &str) {
    match (got, want) {
        (Value::String(g), w) if w.is_string() || is_hash(w) => common::same_text(g, w, &GOLDEN["blobs"], what),
        (Value::Array(g), Value::Array(w)) => {
            assert_eq!(g.len(), w.len(), "{what}: lengths differ\n got: {got}\nwant: {want}");
            for (i, (a, b)) in g.iter().zip(w).enumerate() {
                same_value(a, b, &format!("{what}[{i}]"));
            }
        }
        (Value::Object(g), Value::Object(w)) => {
            let (gk, wk): (Vec<&String>, Vec<&String>) = (g.keys().collect(), w.keys().collect());
            assert_eq!(gk, wk, "{what}: keys differ\n got: {got}\nwant: {want}");
            for (k, a) in g {
                same_value(a, &w[k], &format!("{what}.{k}"));
            }
        }
        (Value::Number(g), Value::Number(w)) => assert_eq!(g.as_f64(), w.as_f64(), "{what}"),
        _ => assert_eq!(got, want, "{what}"),
    }
}

fn opt(value: &Value) -> Option<&str> {
    value.as_str()
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn pairs(items: &[(&str, &str)]) -> Value {
    json!(items.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>())
}

fn sha256_hex(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// What a refused call gave (`err` of the generator).
fn refused(err: &Error) -> Value {
    match err {
        Error::Assist(exc) => json!({"error": {"code": exc.code, "message": exc.message}}),
        other => panic!("not an AssistError: {other}"),
    }
}

async fn new_board() {
    common::clear::<ai_assist_settings::Entity>().await;
}

#[tokio::test]
async fn the_pure_functions_are_python_s() {
    let _guard = common::init_with(&BOARD_ENV).await;
    let p = &GOLDEN["pure"];
    let blobs = &GOLDEN["blobs"];

    // errors
    assert_eq!(json!(errors::STATUS.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()), p["errors"]["STATUS"]);
    assert_eq!(errors::status("gone"), Some(410));
    assert_eq!(errors::status("paused"), None);

    // settings
    let s = &p["settings"];
    assert_eq!(pairs(&settings::FEATURES), s["FEATURES"]);
    assert_eq!(pairs(&settings::DESCRIPTIONS), s["DESCRIPTIONS"]);
    assert_eq!(json!(pyjson::dumps(&settings::default_features())), s["DEFAULT_FEATURES"]);
    assert_eq!(json!(pyjson::dumps(&settings::default_health())), s["DEFAULT_HEALTH"]);
    assert_eq!(json!(settings::TONES), s["TONES"]);
    assert_eq!(json!(settings::STYLE_GUIDE_MAX), s["STYLE_GUIDE_MAX"]);
    for case in s["stored"].as_array().expect("stored") {
        let mut row = ai_assist_settings::new();
        row.id = kb_db::sea_orm::ActiveValue::Set(1);
        row.features = kb_db::sea_orm::ActiveValue::Set(case["features"].as_str().expect("features").into());
        row.health = kb_db::sea_orm::ActiveValue::Set(case["health"].as_str().expect("health").into());
        let row = kb_db::sea_orm::TryIntoModel::try_into_model(row).expect("a row");
        assert_eq!(json!(pyjson::dumps(&settings::features(&row))), case["out_features"], "{case}");
        assert_eq!(json!(pyjson::dumps(&settings::health_config(&row))), case["out_health"], "{case}");
    }

    // sessions
    let s = &p["sessions"];
    assert_eq!(json!(sessions::MEMBER), s["MEMBER"]);
    assert_eq!(json!(sessions::page_name("pg-1")), s["names"]["page"]);
    assert_eq!(json!(sessions::board_name("p-1")), s["names"]["board"]);
    assert_eq!(json!(sessions::chat_name("c-1")), s["names"]["chat"]);
    assert_eq!(json!(sessions::idea_name("IDEA-1")), s["names"]["idea"]);
    assert_eq!(json!(sessions::sketch_name("sk_1")), s["names"]["sketch"]);
    for case in s["asked_by"].as_array().expect("asked_by") {
        let got = sessions::asked_by(opt(&case["person"]), case["prompt"].as_str().expect("prompt"));
        assert_eq!(json!(got), case["out"], "{case}");
    }

    // skills
    let s = &p["skills"];
    assert_eq!(json!(skills::PLUGIN), s["PLUGIN"]);
    assert_eq!(json!(skills::names()), s["names"]);
    assert_eq!(json!(skills::version()), s["version"]);
    for name in skills::names() {
        let text = skills::text_of(name).expect("the skill's text");
        assert_eq!(json!(sha256_hex(text.as_bytes())), s["texts"][name]["sha256"], "{name}");
        assert_eq!(json!(text.chars().count()), s["texts"][name]["chars"], "{name}");
    }
    assert!(skills::text_of("no-such-skill").is_none());
    let schemas: Vec<(&String, &Value)> = skills::SCHEMAS.iter().collect();
    let wanted = s["schemas"].as_array().expect("schemas");
    assert_eq!(schemas.len(), wanted.len());
    for ((name, schema), want) in schemas.iter().zip(wanted) {
        assert_eq!(json!(name), want[0]);
        common::same_text(&pyjson::dumps(schema), &want[1], blobs, &format!("the schema of {name}"));
        assert_eq!(skills::schema_for(name), Some(*schema));
    }
    assert!(skills::schema_for("board-ask").is_none());
    let dir = skills::plugin_dir().expect("the plugin");
    assert_eq!(json!(common::golden_text(&dir)), s["plugin_dir"]);
    assert_eq!(skills::plugin_dir().expect("the plugin again"), dir);
    let mut files: BTreeMap<String, Value> = BTreeMap::new();
    let mut todo = vec![Path::new(&dir).to_path_buf()];
    while let Some(folder) = todo.pop() {
        for entry in std::fs::read_dir(&folder).expect("a folder of the plugin").flatten() {
            let path = entry.path();
            if path.is_dir() {
                todo.push(path);
                continue;
            }
            let bytes = std::fs::read(&path).expect("a file of the plugin");
            let rel = path.strip_prefix(&dir).expect("inside the plugin").to_string_lossy().into_owned();
            files.insert(rel, json!({"sha256": sha256_hex(&bytes), "bytes": bytes.len()}));
        }
    }
    assert_eq!(json!(files), s["plugin_files"]);
    let manifest =
        std::fs::read_to_string(Path::new(&dir).join(".claude-plugin").join("plugin.json")).expect("manifest");
    assert_eq!(json!(manifest), s["plugin_json"]);

    // engine
    let e = &p["engine"];
    assert_eq!(json!(engine::BOARD_SKILLS), e["BOARD_SKILLS"]);
    assert_eq!(json!(engine::DEFAULT_MODEL), e["DEFAULT_MODEL"]);
    assert_eq!(json!(engine::TIMEOUT_S), e["TIMEOUT_S"]);
    assert_eq!(pairs(&engine::NAMES), e["NAMES"]);
    assert_eq!(engine::name_of("docs"), "Docs AI");
    assert_eq!(engine::name_of("anything"), "Board AI");
    for case in e["system_prompt"].as_array().expect("system_prompt") {
        let t = |k: &str| case[k].as_str().expect("text");
        let got = engine::system_prompt(t("member"), t("by"), t("project"), t("skill"));
        common::same_text(&got, &case["out"], blobs, &format!("system_prompt {}", case["skill"]));
    }
    for case in e["render_inputs"].as_array().expect("render_inputs") {
        let got = engine::render_inputs(
            case["skill"].as_str().expect("skill"),
            case["inputs"].as_object().expect("inputs"),
            case["by"].as_str().expect("by"),
        );
        common::same_text(&got, &case["out"], blobs, &format!("render_inputs {}", case["skill"]));
    }
    for case in e["data"].as_array().expect("data") {
        let mut turn = Turn::new("r", "Board AI", None);
        turn.text = case["text"].as_str().expect("text").into();
        turn.structured = case["structured"].as_object().cloned();
        assert_eq!(Value::Object(turn.data()), case["out"], "{case}");
    }

    // drafts
    let d = &p["drafts"];
    drafts::clear();
    assert_eq!(json!(drafts::MAX), d["MAX"]);
    let d1 = drafts::new(
        "p1",
        "editor",
        "An Nguyen",
        json!({"x": 1}),
        drafts::NewDraft {
            ticket_id: Some("T-1"),
            chat_message_id: Some("m1"),
            member_name: "Docs AI",
            ..Default::default()
        },
    );
    let d2 = drafts::new("p1", "sketch", "An Nguyen", json!({"result": {"ideas": ["a"]}}), drafts::NewDraft::default());
    same_value(&scrub(&Value::Object(d1.clone())), &d["new"][0], "drafts.new 1");
    same_value(&scrub(&Value::Object(d2.clone())), &d["new"][1], "drafts.new 2");
    let (id1, id2) = (d1["id"].as_str().expect("id"), d2["id"].as_str().expect("id"));
    assert_eq!(Value::Object(drafts::get(id1).expect("held")), Value::Object(d1.clone()));
    let mut closed = vec![
        drafts::close(id1, "discarded", Some("An")).expect("close")["status"].clone(),
        drafts::close(id1, "cancelled", None).expect("close")["status"].clone(),
    ];
    drafts::edit(id2, |held| held.insert("status".into(), json!("applied"))).expect("held");
    closed.push(drafts::close(id2, "discarded", None).expect("close")["status"].clone());
    assert_eq!(json!(closed), d["closed"]);
    let gone = drafts::get("nope").expect_err("nothing held");
    assert_eq!(json!({"code": gone.code, "message": gone.message}), d["gone"]);
    assert!(drafts::edit("nope", |_| ()).is_err() && drafts::close("nope", "discarded", None).is_err());
    drafts::clear();
    let ids: Vec<String> = (0..drafts::MAX)
        .map(|_| {
            drafts::new("p", "editor", "An", json!({}), drafts::NewDraft::default())["id"]
                .as_str()
                .expect("id")
                .to_string()
        })
        .collect();
    let newest = drafts::new("p", "editor", "An", json!({}), drafts::NewDraft::default());
    let first_kept = ids.iter().position(|id| drafts::holds(id)).expect("some are kept");
    assert_eq!(
        json!({"count": drafts::count(), "first_kept": first_kept, "newest_kept": drafts::holds(newest["id"].as_str().expect("id"))}),
        d["after_full"]
    );
    drafts::clear();

    // receipt
    let r = &p["receipt"];
    assert_eq!(json!(receipt::FIELDS), r["FIELDS"]);
    assert_eq!(json!(receipt::LISTED), r["LISTED"]);
    assert_eq!(json!(receipt::MAX_CHANGES), r["MAX_CHANGES"]);
    assert_eq!(json!(receipt::HAND_OVER), r["HAND_OVER"]);
    for case in r["item_words"].as_array().expect("item_words") {
        let got = receipt::item_words(case["field"].as_str().expect("field"), &case["e"]);
        assert_eq!(json!(got), case["out"], "{case}");
    }
    let sum = &r["summary"];
    let got = receipt::summary(
        sum["changes"].as_array().expect("changes").clone(),
        sum["runs"].as_array().expect("runs").clone(),
    );
    assert_eq!(json!(pyjson::dumps(&got)), sum["out"]);
    for case in r["merge"].as_array().expect("merge") {
        let old = Some(&case["old"]).filter(|o| !o.is_null());
        let got = receipt::merge(
            old,
            case["changes"].as_array().expect("changes").clone(),
            case["run_id"].as_str().expect("run"),
        );
        same_value(&got.unwrap_or(Value::Null), &case["out"], &format!("merge {case}"));
    }
    for case in r["same"].as_array().expect("same") {
        assert_eq!(json!(receipt::same(&case["a"], &case["b"])), case["out"], "{case}");
    }

    // health
    let h = &p["health"];
    assert_eq!(json!(health::KINDS), h["KINDS"]);
    for case in h["insight_out"].as_array().expect("insight_out") {
        let row: kb_db::entities::ai_insight::Model = serde_json::from_value(case["row"].clone()).expect("a row");
        assert_eq!(json!(pyjson::dumps(&health::insight_out(&row))), case["out"], "{case}");
    }
}

fn team_ids(found: Option<(kb_db::entities::member::Model, ai_team::Model)>) -> Value {
    let (member, profile) = found.unzip();
    json!({"member": member.map(|m| m.id), "profile": profile.map(|p| p.id)})
}

#[tokio::test]
async fn the_settings_scenario_is_python_s() {
    let _guard = common::init_with(&BOARD_ENV).await;
    new_board().await;
    common::clear::<ai_usage::Entity>().await;
    let scenario = &GOLDEN["db"]["settings"];
    common::insert_all(&scenario["rows"]).await;
    let s = database::session();
    for (i, call) in scenario["calls"].as_array().expect("calls").iter().enumerate() {
        let args = &call["args"];
        let text = |key: &str| args[key].as_str().unwrap_or("");
        let got: Value = match call["op"].as_str().expect("op") {
            "describe" => Value::Object(settings::describe(&s, text("project_id")).await.expect("describe")),
            "update" => {
                let row = settings::update(&s, args["data"].as_object().expect("data")).await.expect("update");
                json!({"features": row.features, "language": row.language, "tone": row.tone, "style_guide": row.style_guide, "health": row.health})
            }
            "feature_on" => json!(settings::feature_on(&s, text("feature")).await.expect("feature_on")),
            "first_team" => team_ids(settings::first_team(&s, text("project_id")).await.expect("first_team")),
            "answering_team" => match settings::answering_team(&s, text("project_id"), text("feature")).await {
                Ok(found) => team_ids(found),
                Err(err) => refused(&err),
            },
            "record_usage" => {
                let usage = settings::Usage {
                    tokens_in: args["tokens_in"].as_i64().unwrap_or(0),
                    tokens_out: args["tokens_out"].as_i64().unwrap_or(0),
                    cost: args["cost"].as_f64().unwrap_or(0.0),
                    member_id: opt(&args["member_id"]),
                };
                let row = settings::record_usage(&s, text("project_id"), text("feature"), opt(&args["person"]), usage)
                    .await
                    .expect("record_usage");
                serde_json::to_value(row).expect("a row")
            }
            "month_spend" => json!(settings::month_spend(&s, opt(&args["feature"])).await.expect("month_spend")),
            other => panic!("no op {other}"),
        };
        if call["op"] == "record_usage" {
            // a row as the model dumps it: the columns, whatever their order
            assert_eq!(scrub(&got), call["out"], "settings call {i} (record_usage {args})");
            continue;
        }
        same_value(&scrub(&got), &call["out"], &format!("settings call {i} ({} {args})", call["op"]));
    }
}

async fn snapshot(ids: &[&str]) -> Value {
    let s = database::session();
    let mut snap = Map::new();
    for id in ids {
        let Some(t) = ticket::Entity::find_by_id(*id).one(&s).await.expect("ticket") else {
            snap.insert(id.to_string(), Value::Null);
            continue;
        };
        let comments: Vec<Value> = serde_json::from_str::<Vec<Value>>(&t.comments)
            .unwrap_or_default()
            .iter()
            .map(|c| json!([c["id"], pyjson::truthy(&c["deleted_at"])]))
            .collect();
        snap.insert(
            id.to_string(),
            json!({
                "status": t.status,
                "assignee": t.assignee,
                "priority": t.priority,
                "title": t.title,
                "description": t.description,
                "tags": t.tags,
                "estimate": t.estimate,
                "due_date": t.due_date,
                "start_date": t.start_date,
                "parent_id": t.parent_id,
                "type": t.r#type,
                "comments": comments,
            }),
        );
    }
    Value::Object(snap)
}

#[tokio::test]
async fn the_receipt_scenario_is_python_s() {
    let _guard = common::init_with(&BOARD_ENV).await;
    let scenario = &GOLDEN["db"]["receipt"];
    common::insert_all(&scenario["rows"]).await;
    let ids = ["R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7", "R-8", "R-9", "R-10", "R-12", "R-13", "R-14", "Q-1"];
    let calls = scenario["calls"].as_array().expect("calls");
    for (i, call) in calls.iter().enumerate() {
        let args = &call["args"];
        let s = database::session();
        match call["op"].as_str().expect("op") {
            "collect" => {
                let got = receipt::collect(
                    &s,
                    opt(&args["project_id"]),
                    args["run_id"].as_str().expect("run"),
                    opt(&args["since"]),
                )
                .await
                .expect("collect");
                same_value(&Value::Array(got), &call["out"], &format!("collect {}", call["name"]));
            }
            "undo" => {
                // the changes of a `collect` above (by its name), or the list itself
                let applied = match &args["applied"] {
                    Value::String(name) => {
                        calls.iter().find(|c| c["name"] == name.as_str()).expect("a collect")["out"].clone()
                    }
                    list => list.clone(),
                };
                let already: Option<HashSet<i64>> =
                    args["already"].as_array().map(|list| list.iter().filter_map(Value::as_i64).collect());
                let runs = args["runs"].as_array().expect("runs");
                let got = receipt::undo(&s, applied.as_array().expect("applied"), runs, already.as_ref())
                    .await
                    .expect("undo");
                let want = &call["out"];
                for key in ["undone", "put_back", "kept"] {
                    assert_eq!(
                        got[key],
                        want[key],
                        "undo {i}: {key}\n got: {}\nwant: {want}",
                        Value::Object(got.clone())
                    );
                }
                let (g, w) =
                    (got["skipped"].as_array().expect("skipped"), want["skipped"].as_array().expect("skipped"));
                assert_eq!(g.len(), w.len(), "undo {i}: skipped\n got: {g:?}\nwant: {w:?}");
                for (a, b) in g.iter().zip(w) {
                    let (a, b) = (a.as_str().expect("a line"), b.as_str().expect("a line"));
                    // a value the field does not take is refused in pydantic's words in Python and in serde's here
                    let refused = "Q-1 priority: ";
                    if b.starts_with(refused) {
                        assert!(a.starts_with(refused), "undo {i}: {a}");
                    } else {
                        assert_eq!(a, b, "undo {i}");
                    }
                }
                drop(s);
                same_value(&snapshot(&ids).await, &call["tickets"], &format!("the tickets after undo {i}"));
            }
            other => panic!("no op {other}"),
        }
    }
}

#[tokio::test]
async fn the_health_scenario_is_python_s() {
    let _guard = common::init_with(&BOARD_ENV).await;
    new_board().await;
    let scenario = &GOLDEN["db"]["health"];
    common::insert_all(&scenario["rows"]).await;
    let s = database::session();
    for (i, call) in scenario["calls"].as_array().expect("calls").iter().enumerate() {
        let args = &call["args"];
        let text = |key: &str| args[key].as_str().unwrap_or("");
        let got: Value = match call["op"].as_str().expect("op") {
            "panel" => Value::Object(health::panel(&s, text("project_id")).await.expect("panel")),
            "chips" => Value::Array(health::chips(&s, text("project_id")).await.expect("chips")),
            "set_state" => {
                match health::set_state(&s, text("insight_id"), text("action"), args["hours"].as_i64().expect("hours"))
                    .await
                {
                    Ok(insight) => insight,
                    Err(err) => refused(&err),
                }
            }
            "mark_seen" => {
                health::mark_seen(&s, text("project_id")).await.expect("mark_seen");
                Value::Null
            }
            "snooze_all" => {
                json!(
                    health::snooze_all(&s, text("project_id"), args["hours"].as_i64().expect("hours"))
                        .await
                        .expect("snooze_all")
                )
            }
            other => panic!("no op {other}"),
        };
        same_value(&scrub(&got), &call["out"], &format!("health call {i} ({} {args})", call["op"]));
    }
}

// ---------------------------------------------------------------------------------------------------------------
// what a turn is started with
// ---------------------------------------------------------------------------------------------------------------

fn files_of(call: &Value) -> Vec<(String, Vec<u8>)> {
    let listed = call["files"].as_array().map(Vec::as_slice).unwrap_or_default();
    listed
        .iter()
        .map(|f| (f[0].as_str().expect("name").to_string(), f[1].as_str().expect("text").as_bytes().to_vec()))
        .collect()
}

fn turn_dict(t: &Turn) -> Map<String, Value> {
    object(&json!({
        "text": t.text,
        "structured": t.structured,
        "state": t.state,
        "error": t.error,
        "tokens_in": t.tokens_in,
        "tokens_out": t.tokens_out,
        "cost": t.cost,
        "metered": t.metered,
        "member": t.member,
        "model": t.model,
        "files": t.files,
    }))
}

/// `run_of` of the generator: the turn's run, whether its conversation is kept, its steps.
async fn run_of(run_id: &str) -> Map<String, Value> {
    let s = database::session();
    let run = ai_run::Entity::find_by_id(run_id).one(&s).await.expect("query").expect("the run");
    let rows = kb_ai::steps::read(&s, run_id, 0, 200, None, false).await.expect("steps");
    let kept = docs_ai_session::Entity::find()
        .filter(docs_ai_session::Column::Scope.eq(run.target.clone().unwrap_or_default()))
        .one(&s)
        .await
        .expect("the conversation");
    let steps: Vec<Value> = rows.iter().map(|r| json!([r["kind"], r["title"], r.get("tool")])).collect();
    object(&json!({
        "run": {
            "kind": run.kind,
            "ticket_id": run.ticket_id,
            "target": run.target,
            "member_id": run.member_id,
            "mode": run.mode,
            "trigger": run.trigger,
            "depth": run.depth,
            "state": run.state,
            "started_by": run.started_by,
            "instruction": run.instruction,
            "session_name": run.session_name,
            "model": run.model,
            "effort": run.effort,
            "account_id": run.account_id,
            "ended_reason": run.ended_reason,
            "tokens_in": run.tokens_in,
            "tokens_out": run.tokens_out,
            "cost_usd": run.cost_usd,
            "report": run.report,
            "summary": run.summary,
            "pid": run.pid,
            "steps_count": run.steps_count,
        },
        "session_kept": [
            run.session_id.is_some(),
            kept.as_ref().map(|k| k.calls),
            kept.as_ref().is_some_and(|k| Some(&k.session_id) == run.session_id.as_ref()),
        ],
        "steps": steps,
    }))
}

async fn usage_of(pid: &str) -> Value {
    let s = database::session();
    let rows = ai_usage::Entity::find()
        .filter(ai_usage::Column::ProjectId.eq(pid))
        .order_by_asc(ai_usage::Column::CreatedAt)
        .all(&s)
        .await
        .expect("usage");
    json!(
        rows.iter()
            .map(|u| json!({
                "feature": u.feature,
                "member_id": u.member_id,
                "person": u.person,
                "cost": u.cost,
                "tokens_in": u.tokens_in,
                "tokens_out": u.tokens_out,
                "metered": u.metered,
            }))
            .collect::<Vec<_>>()
    )
}

/// `do_call` of the generator.
async fn do_call(pid: &str, call: &Value) -> Value {
    let text = |key: &str| call[key].as_str().unwrap_or("");
    let mut given = Map::new();
    match text("kind") {
        "turn" => {
            let mut opts = TurnOpts::new(text("name"), text("skill"), object(&call["inputs"]), text("by"));
            opts.feature = call["feature"].as_str().unwrap_or("chat");
            opts.schema = match &call["schema"] {
                Value::Null => Schema::Skill,
                Value::String(s) if s == "skill" => Schema::Skill,
                Value::String(_) => Schema::Plain,
                given => Schema::Given(given.clone()),
            };
            opts.ticket_id = opt(&call["ticket_id"]);
            opts.files = files_of(call);
            opts.fresh = call["fresh"].as_bool().unwrap_or(false);
            opts.depth = call["depth"].as_i64().unwrap_or(0);
            opts.timeout_s = 30.0;
            let t = match engine::turn(pid, opts).await {
                Ok(t) => t,
                Err(err) => return refused(&err),
            };
            given.insert("turn".into(), Value::Object(turn_dict(&t)));
            given.extend(run_of(&t.run_id).await);
        }
        "oneshot" => {
            let mut opts = OneshotOpts::default();
            if let Some(by) = call["by"].as_str() {
                opts.by = by;
            }
            if let Some(model) = call["model"].as_str() {
                opts.model = model;
            }
            let t = match engine::oneshot(text("skill"), call["inputs"].as_object().expect("inputs"), opts).await {
                Ok(t) => t,
                Err(err) => return refused(&err),
            };
            given.insert("turn".into(), Value::Object(turn_dict(&t)));
            given.insert("run_id".into(), json!(t.run_id));
        }
        "chat" => {
            let opts = chat::SendOpts {
                doc_ids: call["doc_ids"]
                    .as_array()
                    .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default(),
                mode: call["mode"].as_str().map(str::to_string),
                files: files_of(call),
                skill: call["skill"].as_str().map(str::to_string),
                extra: call["extra"].as_object().cloned(),
            };
            let s = database::session();
            let sent = match chat::send(&s, text("chat_id"), text("by"), text("text"), opts).await {
                Ok(sent) => sent,
                Err(err) => return refused(&err),
            };
            drop(s);
            let mid = sent["ai"]["id"].as_str().expect("the answer's id").to_string();
            let m = common::answer(&mid, text("by")).await;
            // the task that wrote the answer has let go of it
            common::until("the answer's task to end", 5.0, || !chat::is_answering(&mid)).await;
            let s = database::session();
            let detail = chat::detail(&s, text("chat_id"), text("by")).await.expect("detail");
            drop(s);
            let run_id = m["context"]["run"]["id"].as_str().map(str::to_string);
            given.insert("sent".into(), Value::Object(sent));
            given.insert("message".into(), m);
            given.insert("detail".into(), Value::Object(detail));
            if let Some(run_id) = run_id {
                given.extend(run_of(&run_id).await);
            }
        }
        "health" => {
            let panel = match health::check(pid, text("by")).await {
                Ok(panel) => panel,
                Err(err) => return refused(&err),
            };
            let s = database::session();
            let run = ai_run::Entity::find()
                .filter(ai_run::Column::ProjectId.eq(pid))
                .order_by_desc(ai_run::Column::QueuedAt)
                .one(&s)
                .await
                .expect("query")
                .expect("the run of the check");
            drop(s);
            given.insert("panel".into(), Value::Object(panel));
            given.extend(run_of(&run.id).await);
        }
        other => panic!("no kind {other}"),
    }
    given.insert("usage".into(), usage_of(pid).await);
    Value::Object(given)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|at| args.get(at + 1)).cloned()
}

/// `read_recordings` and `launch_of` of the generator: what the recorder wrote down from recording `start` on.
fn launches_from(recorded: &Path, start: usize) -> Vec<Value> {
    let mut found = Vec::new();
    let mut n = start;
    while recorded.join(n.to_string()).is_dir() {
        let base = recorded.join(n.to_string());
        let split = |name: &str| -> Vec<String> {
            let raw = std::fs::read(base.join(name)).expect("a recording");
            String::from_utf8_lossy(&raw).split('\0').map(str::to_string).collect()
        };
        let mut args = split("args");
        args.pop();
        let env: BTreeMap<String, String> = split("env")
            .iter()
            .filter_map(|item| item.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let cwd = std::fs::read_to_string(base.join("cwd")).expect("cwd").trim().to_string();
        let board: BTreeMap<String, String> = std::env::vars().collect();
        let set: BTreeMap<&String, &String> =
            env.iter().filter(|(k, v)| board.get(*k) != Some(*v) && !SHELL_VARS.contains(&k.as_str())).collect();
        let removed: Vec<&String> =
            board.keys().filter(|k| !env.contains_key(*k) && !SHELL_VARS.contains(&k.as_str())).collect();
        let parsed = |name: &str| -> Value {
            flag(&args, name).map_or(Value::Null, |text| serde_json::from_str(&text).expect("JSON in a flag"))
        };
        let read = |name: &str| -> Value {
            flag(&args, name).and_then(|path| std::fs::read_to_string(path).ok()).map_or(Value::Null, Value::String)
        };
        found.push(scrub(&json!({
            "args": args,
            "cwd": cwd,
            "env": {"set": set, "removed": removed},
            "mcp": parsed("--mcp-config"),
            "settings": parsed("--settings"),
            "schema": parsed("--json-schema"),
            "system": read("--append-system-prompt-file"),
            "sub_system": read("--append-subagent-system-prompt-file"),
            "resumed": args.iter().any(|a| a == "--resume"),
        })));
        n += 1;
    }
    found
}

#[tokio::test]
async fn what_a_turn_is_started_with_is_python_s() {
    let _guard = common::init_with(&BOARD_ENV).await;
    new_board().await;
    drafts::clear();
    let recorded = common::install_recorder();
    assert_eq!(json!(common::RECORDER), GOLDEN["recorder"], "the recorder of the test is the generator's");
    assert_eq!(seams::board_url(), seams::DEFAULT_BOARD_URL);
    seams::set_runs(Some(Arc::new(common::Deliveries::default())));
    assert_eq!(json!(seams::board_url()), GOLDEN["board_url"]);
    for case in GOLDEN["turns"].as_array().expect("turns") {
        let name = case["name"].as_str().expect("name");
        let pid = case["project_id"].as_str().expect("project");
        if case["clear_teams"] == true {
            common::clear::<ai_team::Entity>().await;
        }
        for dir in case["dirs"].as_array().expect("dirs") {
            std::fs::create_dir_all(common::local_text(dir.as_str().expect("a folder"))).expect("a folder of the case");
        }
        for file in case["files"].as_array().expect("files") {
            let path = common::local_text(file["path"].as_str().expect("path"));
            std::fs::create_dir_all(Path::new(&path).parent().expect("a folder")).expect("the file's folder");
            std::fs::write(&path, common::local_text(file["text"].as_str().expect("text")))
                .expect("a file of the case");
        }
        common::insert_all(&case["rows"]).await;
        let calls = case["calls"].as_array().expect("calls");
        for (i, (call, want)) in calls.iter().zip(case["out"].as_array().expect("out")).enumerate() {
            let what = format!("{name} call {i}");
            let stream = common::tmp_path("stream").join("stream.jsonl");
            std::fs::write(&stream, call["stream"].as_str().expect("stream")).expect("the stream of the call");
            engine::set_child_env(&[("GOLDEN_STREAM", &stream.to_string_lossy())]);
            let start = std::fs::read_dir(&recorded).expect("recordings").count();
            let gave = do_call(pid, call).await;
            let launches = launches_from(&recorded, start);
            let wanted = want["launches"].as_array().expect("launches");
            assert_eq!(launches.len(), wanted.len(), "{what}: how many CLIs were started");
            for (got, want) in launches.iter().zip(wanted) {
                same_value(got, want, &format!("{what}: launch"));
            }
            same_value(&scrub(&gave), &want["gave"], &format!("{what}: gave"));
        }
    }
    engine::set_child_env(&[]);
    seams::set_runs(None);
}
