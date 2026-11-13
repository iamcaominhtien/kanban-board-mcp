//! The Docs AI, the editor assistant and the ideas assistant against what the Python modules gave
//! (`contract/golden/assist_docs.json`, made by `gen_assist_docs.py`): every call of a case runs on the rows the
//! Python models dumped, with a program that records what each CLI is started with, and what came back is compared
//! with what the Python call gave (the job as the API shows it, the draft, the result, the findings, the note a team
//! is sent...), and so is what the CLI was started with.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use kb_assist::assistant::docs as adocs;
use kb_assist::assistant::drafts;
use kb_assist::assistant::editor;
use kb_assist::assistant::engine;
use kb_assist::assistant::errors::AssistError;
use kb_assist::assistant::ideas;
use kb_assist::docs_ai::errors::{DocsAiError, Error};
use kb_assist::docs_ai::handoff::{self, SendOpts};
use kb_assist::docs_ai::jobs::{self, JobFilter, NewJob};
use kb_assist::docs_ai::{health, settings as dsettings, tidy};
use kb_assist::seams;
use kb_base::{pyjson, pytext};
use kb_db::database;
use kb_db::entities::{
    ai_assist_settings, ai_chat, ai_chat_message, ai_team, docs_ai_job, docs_comment_thread, docs_page, idea_ticket,
    ticket,
};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, Set};
use regex::Regex;
use serde_json::{Map, Value, json};

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

static GOLDEN: LazyLock<Value> = LazyLock::new(|| common::golden("assist_docs.json"));

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a pattern written in the test")
}

static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| re(r"kbr_chat_[A-Za-z0-9_-]+"));
static UUID_RE: LazyLock<Regex> = LazyLock::new(|| re(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));
static RUN_RE: LazyLock<Regex> = LazyLock::new(|| re(r"run_[0-9a-f]{12}"));
static JOB_RE: LazyLock<Regex> = LazyLock::new(|| re(r"dj_[0-9a-f]{12}"));
static HEX_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\b[0-9a-f]{32}\b"));
static TIME_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+00:00"));
static DAY_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\d{4}-\d\d-\d\d"));
static ONESHOT_RE: LazyLock<Regex> = LazyLock::new(|| re(r"oneshot-[0-9a-f]{8}"));

/// `scrub` of the generator for a text.
fn scrub_text(text: &str) -> String {
    let text = common::golden_text(text);
    let text = TOKEN_RE.replace_all(&text, "<TOKEN>");
    let text = UUID_RE.replace_all(&text, "<UUID>");
    let text = RUN_RE.replace_all(&text, "<RUN>");
    let text = JOB_RE.replace_all(&text, "<JOB>");
    let text = HEX_RE.replace_all(&text, "<HEX>");
    let text = TIME_RE.replace_all(&text, "<TIME>");
    let text = DAY_RE.replace_all(&text, "<DAY>");
    ONESHOT_RE.replace_all(&text, "oneshot-<ID>").into_owned()
}

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

/// `got` against `want`, key order included; a long text of the golden file is its hash and length.
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

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn opt<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str().filter(|s| !s.is_empty())
}

// -- what a refused call gave -------------------------------------------------------------------------------------------

fn fail_docs_ai(err: &DocsAiError) -> Value {
    json!({"error": {"type": "DocsAiError", "message": err.message, "code": err.code, "status": err.status()}})
}

fn fail_assist(err: &AssistError) -> Value {
    json!({"error": {"type": "AssistError", "message": err.message, "code": err.code}})
}

fn fail_value(message: &str) -> Value {
    json!({"error": {"type": "ValueError", "message": message}})
}

/// `fail(exc)` of the generator for what a Docs AI function failed with.
fn fail(err: &Error) -> Value {
    match err {
        Error::DocsAi(e) => fail_docs_ai(e),
        Error::Assist(e) => fail_assist(e),
        Error::Docs(kb_docs::Error::Docs(d)) => {
            json!({"error": {"type": "DocsError", "message": d.message, "code": d.code, "status": d.status}})
        }
        other => panic!("not an error the generator catches: {other}"),
    }
}

/// `fail(exc)` for what the ideas assistant failed with.
fn fail_ideas(err: &ideas::Error) -> Value {
    match err {
        ideas::Error::Idea(e) => json!({"error": {"type": "IdeaAiError", "message": e.message, "code": e.code}}),
        ideas::Error::Assist(e) => fail_assist(e),
        ideas::Error::Value(m) => fail_value(m),
        other => panic!("not an error the generator catches: {other}"),
    }
}

/// `fail(exc)` for what the editor failed with.
fn fail_editor(err: &kb_assist::assistant::errors::Error) -> Value {
    match err {
        kb_assist::assistant::errors::Error::Assist(e) => fail_assist(e),
        other => panic!("not an error the generator catches: {other}"),
    }
}

// -- helpers ------------------------------------------------------------------------------------------------------------

async fn settled(job_id: &str) -> docs_ai_job::Model {
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        let session = database::session();
        let j = docs_ai_job::Entity::find_by_id(job_id).one(&session).await.expect("query").expect("the job");
        drop(session);
        if !jobs::ACTIVE.contains(&j.state.as_str()) {
            return j;
        }
        assert!(Instant::now() < end, "job {job_id} never ended");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn thread_of(thread_id: &str) -> Map<String, Value> {
    let session = database::session();
    kb_docs::docs_comments::get_thread(&session, thread_id).await.expect("the thread")
}

fn thread_lines(thread: &Map<String, Value>) -> Value {
    let comments = thread["comments"].as_array().cloned().unwrap_or_default();
    Value::Array(
        comments.iter().map(|x| json!([x["author"], x["body"], x.get("ai").cloned().unwrap_or(Value::Null)])).collect(),
    )
}

async fn groups_of(spec: &Value) -> Vec<(docs_page::Model, Vec<docs_comment_thread::Model>)> {
    let session = database::session();
    let mut out = Vec::new();
    for pair in spec.as_array().expect("groups") {
        let page = docs_page::Entity::find_by_id(pair[0].as_str().expect("page"))
            .one(&session)
            .await
            .expect("q")
            .expect("page");
        let mut threads = Vec::new();
        for t in pair[1].as_array().expect("threads") {
            threads.push(
                docs_comment_thread::Entity::find_by_id(t.as_str().expect("thread"))
                    .one(&session)
                    .await
                    .expect("q")
                    .expect("thread"),
            );
        }
        out.push((page, threads));
    }
    out
}

fn draft_view(d: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for key in [
        "kind",
        "owner",
        "status",
        "member_name",
        "ticket_id",
        "doc_id",
        "raw",
        "result",
        "payload",
        "cost",
        "tokens",
        "applied_by",
    ] {
        out.insert(key.into(), d.get(key).cloned().unwrap_or(Value::Null));
    }
    Value::Object(out)
}

fn job_queued(j: &docs_ai_job::Model) -> Value {
    json!({
        "kind": j.kind,
        "state": j.state,
        "started_by": j.started_by,
        "instruction": j.instruction,
        "page_id": j.page_id,
        "thread_id": j.thread_id,
        "member_id": j.member_id,
        "reply_comment_id": j.reply_comment_id,
    })
}

fn new_job(pid: &str, by: &str, spec: &Value) -> NewJob {
    NewJob {
        project_id: pid.to_string(),
        kind: text(spec, "kind").to_string(),
        started_by: by.to_string(),
        page_id: opt(spec, "page_id").map(str::to_string),
        thread_id: opt(spec, "thread_id").map(str::to_string),
        comment_id: opt(spec, "comment_id").map(str::to_string),
        member_id: opt(spec, "member_id").map(str::to_string),
        instruction: text(spec, "instruction").to_string(),
        result: spec.get("result").cloned(),
    }
}

/// A row of the database as an object with its keys in order (`srow` of the generator).
fn row_json<T: serde::Serialize>(row: &T) -> Value {
    let value = serde_json::to_value(row).expect("a row as JSON");
    let sorted: BTreeMap<String, Value> = object(&value).into_iter().collect();
    Value::Object(sorted.into_iter().collect())
}

// -- the calls ------------------------------------------------------------------------------------------------------------

async fn do_call(pid: &str, call: &Value) -> Value {
    let mut call = call.clone();
    if let Some(spec) = call["markdown"].as_object().cloned() {
        let unit = spec["repeat"][0].as_str().expect("unit");
        let n = spec["repeat"][1].as_u64().expect("count");
        call["markdown"] = json!(unit.repeat(usize::try_from(n).expect("count")));
    }
    let call = &call;
    let by = call["by"].as_str().unwrap_or("An Nguyen");
    match text(call, "kind") {
        "job" => {
            let session = database::session();
            let started = jobs::start(&session, new_job(pid, by, &call["job"])).await.expect("start");
            drop(session);
            let done = settled(&started.id).await;
            let mut out = Map::new();
            out.insert("queued".into(), job_queued(&started));
            out.insert("job".into(), Value::Object(jobs::to_dict(&done)));
            if let Some(thread_id) = done.thread_id.as_deref().filter(|t| !t.is_empty()) {
                out.insert("thread".into(), thread_lines(&thread_of(thread_id).await));
            }
            Value::Object(out)
        }
        "job_cancel" => {
            let session = database::session();
            let j = jobs::create(&session, new_job(pid, "An Nguyen", &call["job"])).await.expect("create");
            let first = jobs::cancel(&session, &j.id, "An Nguyen").await.expect("cancel");
            let first = jobs::to_dict(&first);
            let second = jobs::to_dict(&jobs::cancel(&session, &j.id, "Ana").await.expect("cancel"));
            json!({"first": first, "second": second})
        }
        "job_helpers" => job_helpers(pid, call).await,
        "docs_helpers" => docs_helpers(pid, call).await,
        "docs_tickets" => {
            let session = database::session();
            let page_id = text(call, "page_id");
            let drafts_in = call["drafts"].as_array().cloned().unwrap_or_default();
            let link = call["link"].as_bool().unwrap_or(true);
            let mut out = Map::new();
            let made = adocs::create_tickets(&session, page_id, "An Nguyen", &drafts_in, link, adocs::LineKeys::Keep).await.expect("create");
            let token = text(&Value::Object(made.clone()), "undo_token").to_string();
            out.insert("made".into(), Value::Object(made));
            out.insert(
                "undone".into(),
                Value::Object(adocs::undo_tickets(&session, &token, "An Nguyen").await.expect("undo")),
            );
            if let Err(err) = adocs::undo_tickets(&session, &token, "An Nguyen").await {
                out.insert("again".into(), fail(&err));
            }
            let bad = [json!({"title": "x", "project_id": "nope"})];
            if let Err(err) = adocs::create_tickets(&session, page_id, "An Nguyen", &bad, true, adocs::LineKeys::Keep).await {
                out.insert("bad_project".into(), fail(&err));
            }
            Value::Object(out)
        }
        "docs_chat" => {
            let session = database::session();
            let chat_id = adocs::open_as_chat(&session, text(call, "job_id"), "An Nguyen").await.expect("chat");
            let ch = ai_chat::Entity::find_by_id(chat_id.as_str()).one(&session).await.expect("q").expect("chat");
            let msgs = ai_chat_message::Entity::find()
                .filter(ai_chat_message::Column::ChatId.eq(chat_id.as_str()))
                .order_by_desc(ai_chat_message::Column::Role)
                .all(&session)
                .await
                .expect("messages");
            json!({
                "chat": {"project_id": ch.project_id, "owner": ch.owner, "title": ch.title, "scope": ch.scope, "scope_id": ch.scope_id, "doc_id": ch.doc_id},
                "messages": msgs.iter().map(|m| json!({"role": m.role, "text": m.text, "state": m.state})).collect::<Vec<_>>(),
            })
        }
        "docs_threads" => {
            let session = database::session();
            let page_id = text(call, "page_id");
            let t1 = thread_of(text(call, "thread_id")).await;
            let page = docs_page::Entity::find_by_id(page_id).one(&session).await.expect("q").expect("page");
            let mut out = Map::new();
            let mut threads = vec![t1.clone()];
            out.insert("on".into(), json!(adocs::annotate(&session, &page, &mut threads).await.expect("annotate")));
            out.insert(
                "annotated".into(),
                json!(threads.iter().map(|x| json!([x["ai_jobs"], x["ai_summary"]])).collect::<Vec<_>>()),
            );
            let members = kb_doctext::docs_access::members_of(&session, pid).await.expect("members");
            let mut rows = adocs::member_rows(&session, pid, &members, true).await.expect("rows");
            rows.extend(adocs::member_rows(&session, pid, &members[..1], false).await.expect("rows"));
            out.insert("member_rows".into(), Value::Array(rows));
            let intents: Vec<String> = match call["intents"].as_array() {
                Some(list) => list.iter().map(|i| i.as_str().unwrap_or("").to_string()).collect(),
                None => vec!["ask".to_string()],
            };
            for intent in intents {
                let got = adocs::deliver(&session, &t1, "An Nguyen", &intent).await.expect("deliver");
                for item in &got {
                    if let Some(job_id) = item["job_id"].as_str() {
                        settled(job_id).await;
                    }
                }
                out.insert(format!("deliver {intent}"), Value::Array(got));
            }
            Value::Object(out)
        }
        "tidy_call" => {
            let session = database::session();
            let accept: Option<Vec<String>> =
                call["accept"].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect());
            let filename = call["filename"].as_str().unwrap_or("import.md");
            match tidy::tidy(
                &session,
                pid,
                text(call, "markdown"),
                &object(&call["options"]),
                filename,
                accept.as_deref(),
            )
            .await
            {
                Ok(out) => Value::Object(out),
                Err(err) => fail(&err),
            }
        }
        "tidy_all" => {
            let session = database::session();
            let filename = call["filename"].as_str().unwrap_or("import.md");
            let options = object(&call["options"]);
            let first =
                tidy::tidy(&session, pid, text(call, "markdown"), &options, filename, None).await.expect("tidy");
            let ids: Vec<String> = first["see_links"]
                .as_array()
                .expect("links")
                .iter()
                .step_by(2)
                .map(|x| text(x, "id").to_string())
                .collect();
            let second =
                tidy::tidy(&session, pid, text(call, "markdown"), &options, filename, Some(&ids)).await.expect("tidy");
            json!({"first": first, "second": second})
        }
        "health_call" => {
            let session = database::session();
            let mut out = Map::new();
            for step in call["steps"].as_array().expect("steps") {
                let key = pyjson::dumps(step);
                let s = |i: usize| step[i].as_str().unwrap_or("");
                let got: Result<Value, Error> = match s(0) {
                    "get" => health::get(&session, pid, true).await.map(Value::Object),
                    "run" => health::run(&session, pid, "An Nguyen", true, step.get(1).and_then(Value::as_str), 50)
                        .await
                        .map(Value::Object),
                    "dismiss" => health::dismiss(&session, pid, s(1), s(2), s(3), "An Nguyen").await.map(Value::Object),
                    "count" => health::count(&session, pid).await.map(|n| json!(n)),
                    "words" => {
                        let words = health::words(s(1));
                        let n = usize::try_from(step[2].as_u64().expect("n")).expect("n");
                        let mut shingles: Vec<String> = health::shingles(&words, n).into_iter().collect();
                        shingles.sort();
                        Ok(json!([words, shingles]))
                    }
                    other => panic!("no health step {other}"),
                };
                out.insert(key, got.unwrap_or_else(|err| fail(&err)));
            }
            Value::Object(out)
        }
        "handoff_call" => handoff_call(call).await,
        "handoff_send" => {
            let session = database::session();
            let got = match handoff::send(&session, send_opts(&call["send"])).await {
                Ok(got) => got,
                Err(err) => return fail(&err),
            };
            drop(session);
            let mut ids: Vec<String> = got
                .get("job_ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|j| j.as_str().unwrap_or("").to_string())
                .collect();
            if let Some(id) = got.get("job_id").and_then(Value::as_str) {
                ids.push(id.to_string());
            }
            let mut done = Vec::new();
            for id in ids {
                done.push(Value::Object(jobs::to_dict(&settled(&id).await)));
            }
            done.sort_by_key(|j| j["thread_id"].as_str().unwrap_or("").to_string());
            let mut threads = Map::new();
            for tid in call["threads"].as_array().cloned().unwrap_or_default() {
                let tid = tid.as_str().unwrap_or("");
                threads.insert(tid.to_string(), thread_lines(&thread_of(tid).await));
            }
            json!({"sent": got, "jobs": done, "threads": threads})
        }
        "settings_call" => {
            let session = database::session();
            let mut out = Map::new();
            for step in call["steps"].as_array().expect("steps") {
                let key = pyjson::dumps(step);
                let s = |i: usize| step[i].as_str().unwrap_or("");
                let got: Result<Value, Error> = match s(0) {
                    "get" => dsettings::get(&session, pid).await.map(|r| row_json(&r)),
                    "describe" => dsettings::describe(&session, pid).await.map(Value::Object),
                    "update" => {
                        dsettings::update(&session, pid, &object(&step[1]), "An Nguyen").await.map(|r| row_json(&r))
                    }
                    "candidates" => dsettings::candidates(&session, pid).await.map(Value::Array),
                    "member" => {
                        dsettings::answering_member(&session, pid).await.map(|(m, p)| json!([m.id, m.name, p.provider]))
                    }
                    "enabled" => {
                        let id = step.get(1).and_then(Value::as_str).unwrap_or(pid);
                        dsettings::require_enabled(&session, id).await.map(|r| row_json(&r))
                    }
                    "count" => dsettings::count_pages(&session, pid).await.map(|n| json!(n)),
                    "can_answer" => {
                        let team = match step[1].as_str() {
                            Some(id) => ai_team::Entity::find_by_id(id).one(&session).await.expect("team"),
                            None => None,
                        };
                        Ok(json!(dsettings::can_answer(team.as_ref())))
                    }
                    "ready" => adocs::ready_or_raise(pid).await.map(|()| json!(true)),
                    other => panic!("no settings step {other}"),
                };
                out.insert(key, got.unwrap_or_else(|err| fail(&err)));
            }
            Value::Object(out)
        }
        "editor_call" => {
            let session = database::session();
            let mut out = Map::new();
            for step in call["steps"].as_array().expect("steps") {
                let key = pyjson::dumps(step);
                let got = match step[0].as_str().unwrap_or("") {
                    "state" => editor::state(&session, pid, step[1].as_str().unwrap_or(""))
                        .await
                        .map(Value::Object)
                        .map_err(|e| fail_editor(&e)),
                    "preview" => editor::preview(&object(&step[1])).map(Value::Object).map_err(|e| fail_assist(&e)),
                    "items" => Ok(json!(editor::items(step[1].as_str().unwrap_or("")))),
                    other => panic!("no editor step {other}"),
                };
                out.insert(key, got.unwrap_or_else(|v| v));
            }
            Value::Object(out)
        }
        "editor_draft" => editor_draft(pid, call).await,
        "ideas_call" => ideas_call(call).await,
        "pure" => pure(),
        other => panic!("no call {other}"),
    }
}

async fn job_helpers(pid: &str, call: &Value) -> Value {
    let session = database::session();
    let page_id = call["page_id"].as_str().map(str::to_string);
    let j = jobs::create(
        &session,
        NewJob {
            project_id: pid.to_string(),
            kind: "check".into(),
            started_by: "An Nguyen".into(),
            page_id,
            instruction: "x".repeat(9000),
            result: Some(json!({"input": {"a": 1}})),
            ..Default::default()
        },
    )
    .await
    .expect("create");
    jobs::add_step(&j.id, "Reading API").await.expect("step");
    for i in 0..45 {
        jobs::add_step(&j.id, &format!("step {i}")).await.expect("step");
    }
    jobs::set_reads(&j.id, &[json!({"page_id": "p1", "title": "API"})]).await.expect("reads");
    jobs::update(&j.id, &[("reply_comment_id", json!("c1")), ("result", json!({"k": 1}))]).await.expect("update");
    jobs::finish(&j.id, "finished", Some(json!({"z": 2})), None).await.expect("finish");
    let mut d = jobs::to_dict(&jobs::get(&session, &j.id).await.expect("job"));
    let filter = JobFilter { kind: Some("check"), state: Some("finished"), ..Default::default() };
    let listed: Vec<String> =
        jobs::list_jobs(&session, pid, filter, 500).await.expect("list").into_iter().map(|x| x.kind).collect();
    let none = jobs::cancel(&session, &j.id, "An Nguyen").await.expect("cancel").state;
    let missing = match jobs::get(&session, "dj_nope").await {
        Err(err) => fail(&err),
        Ok(_) => panic!("a job that is not there"),
    };
    let new = |kind: &str| NewJob {
        project_id: pid.into(),
        kind: kind.into(),
        started_by: "An Nguyen".into(),
        ..Default::default()
    };
    let r2 = jobs::create(&session, new("ask")).await.expect("create");
    let r3 = jobs::create(&session, new("ask")).await.expect("create");
    let mut running = r3.clone().into_active_model();
    running.state = Set("running".to_string());
    running.update(&session).await.expect("running");
    session.commit().await.expect("commit");
    jobs::recover().await.expect("recover");
    let fresh = database::session();
    let mut after = Vec::new();
    for id in [&r2.id, &r3.id] {
        after.push(Value::Object(jobs::to_dict(&jobs::get(&fresh, id).await.expect("job"))));
    }
    let instruction = d["instruction"].as_str().unwrap_or("").chars().count();
    d.insert("instruction".into(), json!(instruction));
    let steps: Vec<Value> = d["steps"].as_array().expect("steps").iter().map(|s| s["text"].clone()).collect();
    d.insert("steps".into(), Value::Array(steps));
    json!({"job": d, "listed": listed, "cancel_of_finished": none, "missing": missing, "recovered": after})
}

async fn docs_helpers(pid: &str, call: &Value) -> Value {
    let session = database::session();
    let page_id = text(call, "page_id");
    let mut out = Map::new();
    for key in ["  ", " k1 ", "k1"] {
        let label = format!("ignore {}", pytext::repr(key));
        let got = match adocs::ignore(&session, page_id, key, "An Nguyen").await {
            Ok(()) => {
                let mut keys: Vec<String> =
                    adocs::ignored_keys(&session, page_id).await.expect("keys").into_iter().collect();
                keys.sort();
                json!(keys)
            }
            Err(err) => fail(&err),
        };
        out.insert(label, got);
    }
    out.insert(
        "finding_ids".into(),
        json!(
            [("unclear", "The API uses REST."), ("style", "Zażółć"), ("", "")]
                .iter()
                .map(|(k, q)| adocs::finding_id(k, q))
                .collect::<Vec<_>>()
        ),
    );
    out.insert("markers".into(), Value::Object(adocs::markers_of(&session, page_id).await.expect("markers")));
    for (i, p) in call["writes"].as_array().expect("writes").iter().enumerate() {
        let params = object(p);
        match adocs::normalize_write(&params) {
            Ok(n) => {
                out.insert(format!("normalize {i}"), Value::Object(n));
                let preview = match adocs::write_preview(&session, pid, &params).await {
                    Ok(out) => Value::Object(out),
                    Err(err) => fail(&err),
                };
                out.insert(format!("preview {i}"), preview);
            }
            Err(err) => {
                out.insert(format!("normalize {i}"), fail_docs_ai(&err));
            }
        }
    }
    let page = docs_page::Entity::find_by_id(page_id).one(&session).await.expect("q").expect("page");
    let mut fresh = vec![Value::Object(adocs::freshness_of(&session, &page).await.expect("freshness"))];
    adocs::freshness_mark(&session, &page, call["still"].as_bool().unwrap_or(false), call["dismiss"].as_str())
        .await
        .expect("mark");
    fresh.push(Value::Object(adocs::freshness_of(&session, &page).await.expect("freshness")));
    out.insert("freshness".into(), Value::Array(fresh));
    if let Err(err) = adocs::find_finding(&session, pid, page_id, "nope", None).await {
        out.insert("no_finding".into(), fail(&err));
    }
    for (rating, reason) in [("sideways", String::new()), ("down", "r".repeat(600))] {
        let got = match adocs::feedback(&session, text(call, "feedback_job"), "An Nguyen", rating, &reason).await {
            Ok(job) => {
                let mut fb = job["result"]["feedback"].as_object().cloned().unwrap_or_default();
                let len = fb.get("reason").and_then(Value::as_str).unwrap_or("").chars().count();
                fb.insert("reason".into(), json!(len));
                Value::Object(fb)
            }
            Err(err) => fail(&err),
        };
        out.insert(format!("feedback {rating}"), got);
    }
    Value::Object(out)
}

fn send_opts(send: &Value) -> SendOpts {
    let mut opts = SendOpts::new();
    opts.page_id = opt(send, "page_id").map(str::to_string);
    opts.thread_ids = send["thread_ids"]
        .as_array()
        .map(|a| a.iter().map(|t| t.as_str().unwrap_or("").to_string()).collect())
        .unwrap_or_default();
    opts.from_ticket = opt(send, "from_ticket").map(str::to_string);
    if let Some(to) = send["to"].as_str() {
        opts.to = to.to_string();
    }
    opts.ticket_id = opt(send, "ticket_id").map(str::to_string);
    opts.give_team_id = opt(send, "give_team_id").map(str::to_string);
    opts
}

async fn handoff_call(call: &Value) -> Value {
    let session = database::session();
    let mut out = Map::new();
    for step in call["steps"].as_array().expect("steps") {
        let key = pyjson::dumps(step);
        let s = |i: usize| step[i].as_str().unwrap_or("");
        match s(0) {
            "targets" => {
                out.insert(key, handoff::targets(&session, s(1)).await.map(Value::Object).unwrap_or_else(|e| fail(&e)));
            }
            "note" => {
                let groups = groups_of(&step[1]).await;
                let ticket = match step.get(3).and_then(Value::as_str) {
                    Some(id) => ticket::Entity::find_by_id(id).one(&session).await.expect("q"),
                    None => None,
                };
                out.insert(
                    key,
                    handoff::build_note(&session, &groups, s(2), ticket.as_ref())
                        .await
                        .map(Value::String)
                        .unwrap_or_else(|e| fail(&e)),
                );
            }
            "send" => {
                out.insert(
                    key,
                    handoff::send(&session, send_opts(&step[1])).await.map(Value::Object).unwrap_or_else(|e| fail(&e)),
                );
            }
            "of_ticket" => {
                let got = handoff::threads_of_ticket(&session, s(1)).await;
                match got {
                    Ok(got) => {
                        let rows: Vec<Value> = got
                            .iter()
                            .map(|(p, ts)| json!([p.id, ts.iter().map(|t| t.id.clone()).collect::<Vec<_>>()]))
                            .collect();
                        out.insert(key.clone(), Value::Array(rows));
                        let count = handoff::open_count_for_ticket(&session, s(1)).await.expect("count");
                        out.insert(format!("{key} count"), json!(count));
                    }
                    Err(err) => {
                        out.insert(key, fail(&err));
                    }
                }
            }
            "builder" => {
                let page = docs_page::Entity::find_by_id(s(1)).one(&session).await.expect("q").expect("page");
                let got = handoff::builder_team_of(&session, &page).await.expect("builder");
                out.insert(key, got.unwrap_or(Value::Null));
            }
            other => panic!("no handoff step {other}"),
        }
    }
    Value::Object(out)
}

async fn editor_draft(pid: &str, call: &Value) -> Value {
    let by = call["by"].as_str().unwrap_or("An Nguyen");
    let d = {
        let session = database::session();
        match editor::start(&session, pid, &object(&call["body"]), by).await {
            Ok(d) => d,
            Err(err) => return fail_editor(&err),
        }
    };
    let id = text(&Value::Object(d.clone()), "id").to_string();
    let mut out = Map::new();
    let mut started = Map::new();
    for key in ["kind", "status", "owner", "ticket_id", "doc_id", "member_name"] {
        started.insert(key.into(), d[key].clone());
    }
    out.insert("started".into(), Value::Object(started));
    let wait = |id: String| async move {
        for _ in 0..400 {
            if drafts::find(&id).is_some_and(|d| d["status"] != "pending") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    wait(id.clone()).await;
    out.insert("written".into(), draft_view(&drafts::get(&id).expect("the draft")));
    for step in call["then"].as_array().cloned().unwrap_or_default() {
        let key = pyjson::dumps(&step);
        let who = step[1].as_str().unwrap_or("");
        match step[0].as_str().unwrap_or("") {
            "accept" => {
                let items: Option<Vec<String>> = step
                    .get(2)
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(|i| i.as_str().unwrap_or("").to_string()).collect());
                let got = match editor::accept(&id, who, items).await {
                    Ok(got) => {
                        json!({"status": got["draft"]["status"], "created": got.get("created").cloned().unwrap_or(Value::Null)})
                    }
                    Err(err) => fail_editor(&err),
                };
                out.insert(key, got);
            }
            "again" => match editor::again(&id, who, step[2].as_bool().unwrap_or(false)).await {
                Ok(got) => {
                    out.insert(key.clone(), got["status"].clone());
                    wait(id.clone()).await;
                    out.insert(format!("{key} written"), draft_view(&drafts::get(&id).expect("the draft")));
                }
                Err(err) => {
                    out.insert(key, fail_assist(&err));
                }
            },
            other => panic!("no editor step {other}"),
        }
    }
    Value::Object(out)
}

async fn ideas_call(call: &Value) -> Value {
    let mut out = Map::new();
    for step in call["steps"].as_array().expect("steps") {
        let key = pyjson::dumps(step);
        let session = database::session();
        let s = |i: usize| step[i].as_str();
        let id = |i: usize| s(i).unwrap_or("");
        let got: Result<Value, ideas::Error> = match id(0) {
            "status" => ideas::status(&session, s(1)).await.map(Value::Object),
            "update" => ideas::update_settings(&session, s(1), &object(&step[2]))
                .await
                .map(|r| Value::Object(ideas::settings_out(&r)))
                .map_err(Into::into),
            "advise" => ideas::advise(&session, id(1), "An Nguyen").await.map(|a| match a {
                None => Value::Null,
                Some(a) => json!({
                    "idea_id": a.idea_id, "action": a.action, "reason": a.reason, "confidence": a.confidence,
                    "target_id": a.target_id, "archive_reason": a.archive_reason, "park_days": a.park_days,
                    "idea_stamp": a.idea_stamp, "cost": a.cost, "state": a.state,
                }),
            }),
            "advice_for" => {
                let ids: Vec<String> =
                    step[1].as_array().expect("ids").iter().map(|i| i.as_str().unwrap_or("").to_string()).collect();
                ideas::advice_for(&session, &ids, step.get(2).and_then(Value::as_bool).unwrap_or(false))
                    .await
                    .map(Value::Array)
                    .map_err(Into::into)
            }
            "advice_state" => ideas::set_advice_state(&session, id(1), id(2)).await.map(|a| json!(a.state)),
            "ask" => ideas::ask(&session, id(1), s(2), id(3), "An Nguyen").await.map(Value::Object),
            "shape" => ideas::shape(&session, id(1), id(2), s(3), "An Nguyen").await.map(Value::Object),
            "prepare" => ideas::prepare_ticket(&session, id(1), "An Nguyen").await.map(Value::Object),
            "groom" => ideas::groom(&session, s(1), "An Nguyen").await.map(|d| Value::Object(ideas::digest_out(&d))),
            "latest" => ideas::latest_digest(&session, s(1))
                .await
                .map(|d| d.map_or(Value::Null, |d| Value::Object(ideas::digest_out(&d))))
                .map_err(Into::into),
            "brief" => {
                let idea = idea_ticket::Entity::find_by_id(id(1)).one(&session).await.expect("q").expect("idea");
                let rows = kb_db::entities::idea_assumption::Entity::find()
                    .filter(kb_db::entities::idea_assumption::Column::IdeaId.eq(idea.id.as_str()))
                    .order_by_asc(kb_db::entities::idea_assumption::Column::Position)
                    .all(&session)
                    .await
                    .expect("assumptions");
                Ok(json!([ideas::brief(&idea, None), ideas::brief(&idea, Some(&rows))]))
            }
            other => panic!("no ideas step {other}"),
        };
        out.insert(key, got.unwrap_or_else(|err| fail_ideas(&err)));
    }
    Value::Object(out)
}

fn pure() -> Value {
    let actions: Vec<Value> = editor::ACTIONS
        .iter()
        .map(|(k, label, hint, result, skill)| json!([k, [label, hint, result, skill]]))
        .collect();
    let surfaces: Map<String, Value> = editor::SURFACES
        .iter()
        .map(|s| (s.key.to_string(), json!({"label": s.label, "menu": s.menu, "bar": s.bar})))
        .collect();
    let extra: Map<String, Value> = editor::EXTRA.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect();
    let badges: Map<String, Value> = handoff::BADGES.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect();
    let status: Map<String, Value> =
        kb_assist::docs_ai::errors::STATUS.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect();
    let docs_ai_status: Vec<Value> = ["not_found", "invalid", "paused", "rate_limited", "other"]
        .iter()
        .map(|k| json!([k, DocsAiError::new(k, "m").status()]))
        .collect();
    json!({
        "actions": actions,
        "surfaces": surfaces,
        "extra": extra,
        "limits": [editor::MAX_SELECTION, editor::MAX_AROUND, editor::MAX_PROMPT, adocs::MAX_QUESTION, adocs::SCOPES, ideas::SHAPE_KINDS, ideas::SETTING_KEYS, ideas::OPEN_STAGES_OFF],
        "handoff": [handoff::TRIGGER, handoff::MAX_THREADS, handoff::COMMENTS_PER_THREAD, handoff::COMMENT_CHARS, handoff::QUOTE_CHARS, handoff::OTHERS_LIMIT, handoff::MAX_NOTE_CHARS, handoff::DESTINATIONS, badges, handoff::INSTRUCTION],
        "health": [health::KINDS, health::MISSING_DAYS, health::MAX_PAIR_PAGES, health::TITLE_SIMILARITY, health::TEXT_SIMILARITY, health::MIN_WORDS],
        "errors": status,
        "tidy": [tidy::MAX_MARKDOWN],
        "docs_ai_status": docs_ai_status,
    })
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
async fn what_a_docs_ai_job_an_editor_turn_and_an_ideas_turn_are_started_with_is_python_s() {
    let _guard = common::init_with(&BOARD_ENV).await;
    kb_assist::register();
    drafts::clear();
    let recorded = common::install_recorder();
    assert_eq!(json!(common::RECORDER), GOLDEN["recorder"], "the recorder of the test is the generator's");
    seams::set_runs(Some(Arc::new(common::Deliveries::default())));
    assert_eq!(json!(seams::board_url()), GOLDEN["board_url"]);
    for case in GOLDEN["turns"].as_array().expect("turns") {
        let name = case["name"].as_str().expect("name");
        let pid = case["project_id"].as_str().expect("project");
        common::clear::<ai_assist_settings::Entity>().await;
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
            let what = format!("{name} call {i} ({})", call["kind"]);
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
