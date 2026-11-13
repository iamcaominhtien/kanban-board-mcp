//! The text and shaping modules of the base against the vectors the Python modules gave (`contract/golden/ai_text.json`,
//! made by `gen_ai_text.py`): `store.parse_iso`, `providers`, `ops`, `config_model`, `injection`, `hook_guard`, `context`,
//! `steps` (shaping), `transcripts` (query, snippets, masking, index text), `audit` (digest, trace text) and `guard`.

mod common;

use std::collections::HashSet;

use kb_ai::{audit, config_model, context, guard, hook_guard, injection, ops, providers, steps, store, transcripts};
use kb_base::pyjson;
use kb_db::entities::{ai_audit, ai_run, ai_run_agent, ai_run_step, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::TryIntoModel;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    common::golden("ai_text.json")
}

/// Equal as values and as the text Python writes (key order, float spelling).
fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(got, want, "{what}");
    assert_eq!(pyjson::dumps(got), pyjson::dumps(want), "{what} (order)");
}

fn set_of(v: &Value) -> HashSet<String> {
    v.as_array().expect("a list").iter().map(|x| x.as_str().expect("text").to_string()).collect()
}

fn opt_str(v: &Value) -> Option<&str> {
    v.as_str()
}

#[test]
fn store_parse_iso_and_loads() {
    let g = golden();
    for case in g["parse_iso"].as_array().expect("cases") {
        let got = store::parse_iso(opt_str(&case["in"]));
        let want = &case["out"];
        match got {
            Some(dt) => {
                assert_eq!(&json!(kb_base::time::iso(&dt.with_timezone(&chrono::Utc))), want, "{}", case["in"]);
                assert_eq!(json!(dt.offset().local_minus_utc()), case["offset"], "{}", case["in"]);
            }
            None => assert!(want.is_null(), "{} parses in Python as {want}", case["in"]),
        }
    }
    for case in g["loads"].as_array().expect("cases") {
        let got = store::loads(opt_str(&case["in"]), json!("DEFAULT"));
        assert_eq!(got, case["out"], "{}", case["in"]);
    }
}

#[test]
fn config_model_and_providers() {
    let g = golden();
    for case in g["estimate_tokens"].as_array().expect("cases") {
        assert_eq!(json!(config_model::estimate_tokens(opt_str(&case["in"]))), case["out"], "{}", case["in"]);
    }
    for case in g["prices"].as_array().expect("cases") {
        let m = opt_str(&case["model"]);
        let (pin, pout) = providers::price_for(m);
        assert_eq!(json!([pin, pout]), case["price"], "{m:?}");
        assert_eq!(json!(providers::cost_of(m, 1234, 5678)), case["cost"], "{m:?}");
        assert_eq!(json!(providers::cost_of(m, 0, 0)), case["cost_zero"], "{m:?}");
        assert_eq!(json!(providers::cost_of(m, 12_345_678, 987_654)), case["cost_big"], "{m:?}");
    }
    same(&Value::Object(providers::providers()), &g["providers"], "PROVIDERS");
    assert_eq!(json!(providers::PRICES_UPDATED), g["prices_updated"]);
    for case in g["merged_config"].as_array().expect("cases") {
        let raw = case["in"].as_object();
        same(&Value::Object(providers::merged_config(raw)), &case["out"], "merged_config");
    }
}

#[test]
fn ops_get_update_and_the_auto_compact_level() {
    let g = golden();
    same(&Value::Object(ops::defaults()), &g["ops_defaults"], "DEFAULTS");
    for case in g["ops_get"].as_array().expect("cases") {
        let model;
        let settings = if case["none"] == json!(true) {
            None
        } else {
            model = common::settings_model("p", opt_str(&case["ops"]));
            Some(&model)
        };
        same(&Value::Object(ops::get(settings)), &case["get"], &format!("get({})", case["ops"]));
    }
    for case in g["ops_update"].as_array().expect("cases") {
        let mut model = common::settings_model("p", opt_str(&case["ops"]));
        let patch = case["patch"].as_object().cloned().unwrap_or_default();
        let full = ops::update(&mut model, &patch);
        same(&Value::Object(full), &case["full"], &format!("update({}, {})", case["ops"], case["patch"]));
        assert_eq!(json!(model.ops), case["stored"], "stored text after {}", case["patch"]);
    }
    for case in g["auto_compact_pct"].as_array().expect("cases") {
        let mut cfg = Map::new();
        if case["in"] != json!("__absent__") {
            cfg.insert("auto_compact_pct".into(), case["in"].clone());
        }
        assert_eq!(json!(ops::auto_compact_pct(&cfg)), case["out"], "{}", case["in"]);
    }
}

#[test]
fn injection_phrases_trust_and_flags() {
    let g = golden();
    for case in g["injection_phrases"].as_array().expect("cases") {
        let got = injection::phrases(opt_str(&case["text"]));
        assert_eq!(json!(got), case["phrases"], "{}", case["text"]);
    }
    let t = &g["trust_of"];
    let (humans, ai) = (set_of(&t["humans"]), set_of(&t["ai_names"]));
    for case in t["cases"].as_array().expect("cases") {
        let author = case["author"].as_str().expect("text");
        assert_eq!(json!(injection::trust_of(author, &humans, &ai)), case["trust"], "{author}");
    }
    let f = &g["flags_for_comments"];
    let comments = f["comments"].as_array().expect("comments");
    let got = injection::flags_for_comments(comments, &set_of(&f["humans"]), &set_of(&f["ai_names"]));
    same(&Value::Array(got), &f["out"], "flags_for_comments");
}

#[tokio::test]
async fn hook_guard_scripts_decide_as_the_python_ones_do() {
    use sha2::Digest;
    let _lock = common::init().await;
    let g = golden();
    let hex = |bytes: &[u8]| format!("{:x}", sha2::Sha256::digest(bytes));
    let s = &g["hook_guard_scripts"];
    assert_eq!(json!(hex(hook_guard::POSIX.as_bytes())), s["posix_sha256"]);
    assert_eq!(json!(hex(hook_guard::POWERSHELL.as_bytes())), s["powershell_sha256"]);
    assert_eq!(json!(hook_guard::POSIX.chars().count()), s["posix_len"]);
    assert_eq!(json!(hook_guard::POWERSHELL.chars().count()), s["powershell_len"]);

    let work = common::folder().join("hook-guard");
    let work = std::fs::create_dir_all(&work).and_then(|()| work.canonicalize()).expect("folder");
    let git = |dir: &std::path::Path, branch: &str| {
        std::fs::create_dir_all(dir).expect("folder");
        let ok = std::process::Command::new("git")
            .args(["init", "-q", "-b", branch])
            .arg(dir)
            .status()
            .expect("git")
            .success();
        assert!(ok, "git init");
    };
    git(&work.join("wt"), "feature/x");
    git(&work.join("mainwt"), "main");
    std::fs::create_dir_all(work.join("wt/sub")).expect("folder");
    let script = work.join("guard.sh");
    std::fs::write(&script, hook_guard::POSIX).expect("script");
    let work_text = work.to_string_lossy().into_owned();
    let path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let mut checked = 0;
    for case in g["hook_guard_runs"].as_array().expect("cases") {
        let payload = match case["raw"].as_str() {
            Some(raw) => raw.to_string(),
            None => {
                let command = case["command"].as_str().expect("command").replace("{W}", &work_text);
                pyjson::dumps(&json!({"tool_name": "Bash", "tool_input": {"command": command}}))
            }
        };
        let mut cmd = std::process::Command::new("sh");
        cmd.arg(&script).env_clear().env("PATH", &path).env("HOME", &home).current_dir(work.join("wt/sub"));
        match case["worktree"].as_str().expect("worktree") {
            "feature" => cmd.env("KANBAN_WORKTREE", work.join("wt")),
            "main" => cmd.env("KANBAN_WORKTREE", work.join("mainwt")),
            "missing" => cmd.env("KANBAN_WORKTREE", work.join("nope")),
            _ => &mut cmd,
        };
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("sh");
        {
            use std::io::Write;
            let mut stdin = child.stdin.take().expect("stdin");
            let _ = stdin.write_all(payload.as_bytes());
        }
        let out = child.wait_with_output().expect("run");
        let stdout = String::from_utf8_lossy(&out.stdout).replace(&work_text, "{W}");
        let what =
            format!("{} / {}", case["worktree"], case.get("command").or(case.get("raw")).unwrap_or(&Value::Null));
        assert_eq!(json!(stdout), case["stdout"], "{what}");
        assert_eq!(json!(out.status.code().unwrap_or(-1)), case["code"], "{what}");
        checked += 1;
    }
    assert!(checked > 300, "{checked} runs");
}

fn ticket_model(kw: &Value) -> ticket::Model {
    let mut t = ticket::new();
    t.id = Set(kw.get("id").and_then(Value::as_str).unwrap_or("KAN-7").to_string());
    t.project_id = Set("p".into());
    t.title = Set(kw.get("title").and_then(Value::as_str).unwrap_or("Fix the login").to_string());
    t.description = Set(kw
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("Users cannot log in.\nsk-ant-abcdefgh12345 leaked")
        .to_string());
    t.r#type = Set(kw.get("type").and_then(Value::as_str).unwrap_or("bug").to_string());
    t.priority = Set(kw.get("priority").and_then(Value::as_str).unwrap_or("high").to_string());
    t.status = Set(kw.get("status").and_then(Value::as_str).unwrap_or("in-progress").to_string());
    t.estimate = Set(match kw.get("estimate") {
        Some(Value::Null) => None,
        Some(v) => v.as_f64().map(Into::into),
        None => Some(kb_db::Float(3.0)),
    });
    if let Some(v) = kw.get("acceptance_criteria").and_then(Value::as_str) {
        t.acceptance_criteria = Set(v.to_string());
    }
    if let Some(v) = kw.get("comments").and_then(Value::as_str) {
        t.comments = Set(v.to_string());
    }
    t.try_into_model().expect("every column has a value")
}

#[test]
fn context_blocks_fence_and_redact() {
    let g = golden();
    let tb = &g["ticket_block"];
    let ai = set_of(&tb["ai_names"]);
    let subs: Vec<ticket::Model> = tb["subs"].as_array().expect("subs").iter().map(ticket_model).collect();
    for case in tb["cases"].as_array().expect("cases") {
        let t = ticket_model(&case["ticket"]);
        let o = &case["options"];
        let humans = o.get("humans").map(set_of);
        let mut options =
            context::TicketBlockOptions { humans: humans.as_ref(), ..context::TicketBlockOptions::default() };
        if let Some(v) = o.get("allow_external") {
            options.allow_external = v.as_bool().unwrap_or(false);
        }
        if let Some(v) = o.get("comment_limit") {
            options.comment_limit = v.as_i64().expect("number");
        }
        if let Some(v) = o.get("comments") {
            options.comments = v.as_bool().unwrap_or(true);
        }
        if let Some(v) = o.get("criteria") {
            options.criteria = v.as_bool().unwrap_or(true);
        }
        if case["subs"].as_i64().unwrap_or(0) > 0 {
            options.sub_tickets = Some(&subs);
        }
        assert_eq!(json!(context::ticket_block(&t, &ai, &options)), case["out"], "{} {}", case["ticket"], o);
    }
    let c = &g["comments_for_reader"];
    let raw = c["raw"].as_array().expect("raw");
    for case in c["cases"].as_array().expect("cases") {
        let humans = if case["humans"].is_null() { None } else { Some(set_of(&case["humans"])) };
        let (comments, held) = context::comments_for_reader(
            raw,
            &set_of(&c["ai_names"]),
            humans.as_ref(),
            case["allow_external"] == json!(true),
        );
        same(&Value::Array(comments), &case["comments"], "comments_for_reader");
        assert_eq!(json!(held), case["held_back"]);
    }
    for case in g["instruction_block"].as_array().expect("cases") {
        let mut rc = context::RunContext {
            run_id: "run_1".into(),
            member_id: "m1".into(),
            member_name: "Dev team".into(),
            project_id: "p".into(),
            ticket_id: Some("KAN-7".into()),
            on_behalf_of: "An Nguyen".into(),
            mode: "work".into(),
            ..context::RunContext::default()
        };
        match case["mode"].as_str().expect("mode") {
            "ask" => rc.mode = "ask".into(),
            "noticket" => rc.ticket_id = None,
            _ => {}
        }
        let got = context::instruction_block(
            &rc,
            case["instruction"].as_str().expect("text"),
            case["person_trusted"] == json!(true),
        );
        assert_eq!(json!(got), case["out"], "{case}");
        if case["mode"] == json!("work") && case["instruction"] == json!("") {
            same(&Value::Object(rc.activity()), &g["run_context_activity"], "activity");
        }
    }
    for (key, label) in g["status_labels"].as_object().expect("labels") {
        assert_eq!(json!(context::status_label(key)), *label, "{key}");
    }
    assert_eq!(context::status_label("weird"), "weird");
}

fn step_model(kw: &Value) -> ai_run_step::Model {
    let mut s = ai_run_step::new();
    s.id = Set(kw["id"].as_i64().expect("id") as i32);
    s.run_id = Set(kw["run_id"].as_str().expect("run").to_string());
    s.seq = Set(kw["seq"].as_i64().expect("seq") as i32);
    s.at = Set(kw["at"].as_str().expect("at").to_string());
    s.kind = Set(kw["kind"].as_str().expect("kind").to_string());
    for (key, set) in [("tool", 0), ("agent_id", 1), ("parent_tool_id", 2), ("tool_id", 3), ("output", 4)] {
        if let Some(v) = kw.get(key).and_then(Value::as_str) {
            match set {
                0 => s.tool = Set(Some(v.to_string())),
                1 => s.agent_id = Set(Some(v.to_string())),
                2 => s.parent_tool_id = Set(Some(v.to_string())),
                3 => s.tool_id = Set(Some(v.to_string())),
                _ => s.output = Set(Some(v.to_string())),
            }
        }
    }
    if let Some(v) = kw.get("title").and_then(Value::as_str) {
        s.title = Set(v.to_string());
    }
    if let Some(v) = kw.get("detail").and_then(Value::as_str) {
        s.detail = Set(v.to_string());
    }
    s.try_into_model().expect("every column has a value")
}

#[test]
fn steps_shape_a_step_and_the_spans_of_a_subagent() {
    let g = golden();
    for case in g["steps_to_dict"].as_array().expect("cases") {
        let s = step_model(&case["step"]);
        same(&steps::to_dict(&s, false), &case["plain"], "to_dict");
        same(&steps::to_dict(&s, true), &case["with_output"], "to_dict with output");
    }
    for case in g["steps_agent_dict"].as_array().expect("cases") {
        let mut a = ai_run_agent::new();
        a.id = Set("a".into());
        a.run_id = Set("r".into());
        a.agent_type = Set("Dev".into());
        a.claude_id = Set(Some("c".into()));
        a.started_at = Set("s0".into());
        a.ended_at = Set(case["ended_at"].as_str().map(str::to_string));
        a.steps_count = Set(3);
        a.last_text = Set(Some("hi".into()));
        let agent = a.try_into_model().expect("model");
        let marks: Vec<ai_run_step::Model> = case["marks"]
            .as_array()
            .expect("marks")
            .iter()
            .map(|m| {
                let (i, event) = (m[0].as_i64().expect("n"), m[1].as_str().expect("event"));
                step_model(
                    &json!({"id": i, "run_id": "r", "seq": i, "at": format!("t{i}"), "kind": "role", "title": "m",
                    "detail": pyjson::dumps(&json!({"event": event})), "agent_id": "a"}),
                )
            })
            .collect();
        same(&steps::agent_dict(&agent, Some(&marks)), &case["out"], &format!("agent_dict {}", case["marks"]));
    }
    let c = &g["steps_consts"];
    assert_eq!(json!(steps::FLUSH_S), c["FLUSH_S"]);
    assert_eq!(json!(steps::OUTPUT_MAX), c["OUTPUT_MAX"]);
    assert_eq!(json!(steps::EVENT_STEPS_MAX), c["EVENT_STEPS_MAX"]);
}

fn run_model(
    summary: Option<&str>,
    instruction: &str,
    question: Option<&str>,
    answer: Option<&str>,
    files: &str,
    ended: Option<&str>,
) -> ai_run::Model {
    let mut r = ai_run::new();
    r.id = Set("run_x".into());
    r.project_id = Set("p".into());
    r.member_id = Set("m".into());
    r.summary = Set(summary.map(str::to_string));
    r.instruction = Set(instruction.to_string());
    r.question = Set(question.map(str::to_string));
    r.answer = Set(answer.map(str::to_string));
    r.files = Set(files.to_string());
    r.ended_reason = Set(ended.map(str::to_string));
    r.try_into_model().expect("model")
}

#[test]
fn transcripts_query_snippets_masking_and_index_text() {
    let g = golden();
    for case in g["fts_query"].as_array().expect("cases") {
        let got = transcripts::fts_query(opt_str(&case["q"]).unwrap_or(""));
        assert_eq!(json!(got), case["out"], "{}", case["q"]);
    }
    let s = &g["snippets"];
    let records = s["records"].as_array().expect("records");
    for case in s["cases"].as_array().expect("cases") {
        let got = transcripts::snippet(
            records,
            case["q"].as_str().expect("q"),
            case["width"].as_u64().expect("width") as usize,
        );
        assert_eq!(json!(got), case["out"], "{} / {}", case["q"], case["width"]);
    }
    let i = &g["index_text"];
    let records = i["records"].as_array().expect("records");
    let run1 = run_model(
        Some("Fixed the login"),
        "Fix the bug",
        Some(&pyjson::dumps(&json!({"text": "Which env?"}))),
        Some("plain answer"),
        &pyjson::dumps(&json!([{"path": "src/a.py"}, {"path": "b.py"}, {}])),
        Some("done"),
    );
    let run2 = run_model(None, "", Some("[1, 2]"), Some("{\"text\": null}"), "bad json", None);
    let run3 = run_model(None, "", Some("12"), Some("null"), "[]", None);
    let cases = i["cases"].as_array().expect("cases");
    assert_eq!(json!(transcripts::index_text(records, None)), cases[0]["out"]);
    assert_eq!(json!(transcripts::index_text(records, Some(&run1))), cases[1]["out"]);
    assert_eq!(json!(transcripts::index_text(records, Some(&run2))), cases[2]["out"]);
    assert_eq!(json!(transcripts::index_text(records, Some(&run3))), cases[3]["out"]);
    assert_eq!(json!(transcripts::index_text(&[], None)), cases[4]["out"]);

    for case in g["mask"].as_array().expect("cases") {
        let input = &case["in"];
        let built;
        let (input, long) = match input.as_object() {
            Some(o) if o.contains_key("repeat") && o.contains_key("n") => {
                built = json!(o["repeat"].as_str().expect("char").repeat(o["n"].as_u64().expect("n") as usize));
                (&built, true)
            }
            _ => (input, false),
        };
        let got = transcripts::mask(input);
        if long {
            let text = got.as_str().expect("text");
            let want = &case["out"];
            assert_eq!(json!(text.chars().count()), want["len"], "length");
            let tail: String = text.chars().rev().take(60).collect::<Vec<_>>().into_iter().rev().collect();
            assert_eq!(json!(tail), want["tail"], "tail");
            assert_eq!(json!(text.chars().take(10).collect::<String>()), want["head"], "head");
        } else {
            same(&got, &case["out"], &format!("mask({input})"));
        }
    }
    for case in g["safe_args"].as_array().expect("cases") {
        let args: Vec<String> =
            case["args"].as_array().expect("args").iter().map(|a| a.as_str().expect("text").to_string()).collect();
        assert_eq!(json!(transcripts::safe_args(&args)), case["out"], "{}", case["args"]);
    }
    let c = &g["transcripts_consts"];
    assert_eq!(json!(transcripts::MAX_TEXT), c["MAX_TEXT"]);
    assert_eq!(json!(transcripts::MAX_INDEX), c["MAX_INDEX"]);
    assert_eq!(json!(transcripts::CREATE_FTS), c["CREATE_FTS"]);
}

#[test]
fn audit_digest_text_and_shaping() {
    let g = golden();
    for case in g["audit_digest"].as_array().expect("cases") {
        let entry: ai_audit::Model = serde_json::from_value(case["entry"].clone()).expect("an audit row");
        assert_eq!(json!(audit::digest(case["prev"].as_str().expect("prev"), &entry)), case["out"]);
    }
    for (trigger, text) in g["audit_trigger_text"].as_object().expect("texts") {
        assert_eq!(json!(audit::trigger_text(trigger)), *text, "{trigger}");
    }
    assert_eq!(audit::trigger_text("something else"), "{by} started run #{n} on {ticket}");
    for case in g["audit_redaction_count"].as_array().expect("cases") {
        let mut entry: ai_audit::Model = serde_json::from_value(g["audit_digest"][0]["entry"].clone()).expect("row");
        entry.detail = case["detail"].as_str().expect("detail").to_string();
        assert_eq!(json!(audit::redaction_count(&entry)), case["out"], "{}", case["detail"]);
    }
    for case in g["audit_loads_json"].as_array().expect("cases") {
        let default = if case["default"].is_null() { None } else { Some(case["default"].clone()) };
        assert_eq!(audit::loads_json(opt_str(&case["in"]), default), case["out"], "{}", case["in"]);
    }
    for case in g["audit_to_dict"].as_array().expect("cases") {
        let entry: ai_audit::Model = serde_json::from_value(case["entry"].clone()).expect("row");
        same(&Value::Object(audit::to_dict(&entry)), &case["out"], "to_dict");
    }
    assert_eq!(json!(audit::round4(0.123_456_5)), json!(0.1235), "ties go to the even digit as Python's round does");
    assert_eq!(json!(audit::round4(2.5)), json!(2.5));
}

#[test]
fn guard_hashes_and_fingerprints() {
    let g = golden();
    for case in g["guard_hashes"].as_array().expect("cases") {
        assert_eq!(json!(guard::token_hash(case["token"].as_str().expect("token"))), case["hash"]);
    }
    for case in g["guard_fingerprints"].as_array().expect("cases") {
        let given = case["given"].as_object().expect("given");
        let got =
            guard::fingerprint(case["tool"].as_str().expect("tool"), case["action"].as_str().expect("action"), given);
        assert_eq!(json!(got), case["out"]);
    }
    let c = &g["guard_consts"];
    assert_eq!(Some(guard::DUPLICATE_WINDOW_S), c["DUPLICATE_WINDOW_S"].as_f64());
    let mut tools: Vec<&str> = guard::WRITE_TOOLS.to_vec();
    tools.sort_unstable();
    assert_eq!(json!(tools), c["WRITE_TOOLS"]);
    let token = guard::new_token();
    assert_eq!(&token[..4], g["new_token_shape"]["prefix"].as_str().expect("prefix"));
    assert_eq!(json!(token.len()), g["new_token_shape"]["len"]);
}

#[tokio::test]
async fn pictures_stage_the_named_uploads_and_name_the_calls_folder() {
    use kb_ai::pictures;
    let _lock = common::init().await;
    let g = golden();
    let p = &g["pictures"];
    let uploads = std::path::PathBuf::from(std::env::var("KANBAN_UPLOADS_DIR").expect("set by common::init"));
    for (rel, content) in p["files"].as_object().expect("files") {
        let path = uploads.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        std::fs::write(&path, content.as_str().expect("text")).expect("file");
    }
    std::fs::create_dir_all(uploads.join(p["dir"].as_str().expect("dir"))).expect("folder");
    let unique = kb_base::time::uuid4_hex();
    let mut staged = 0;
    for case in p["cases"].as_array().expect("cases") {
        // another run's copies in the temporary folder must not be taken for this run's: the key gets a suffix
        let key = format!("{}-{unique}", case["key"].as_str().expect("key"));
        let (text, folder) = pictures::stage(case["text"].as_str().expect("text"), &key).expect("stage");
        let what = format!("{}", case["text"]);
        match folder {
            Some(folder) => {
                assert_eq!(case["folder"], json!(true), "{what}");
                assert_eq!(json!(text.replace(&folder, "{F}")), case["out"], "{what}");
                let mut names: Vec<String> = std::fs::read_dir(&folder)
                    .expect("folder")
                    .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                assert_eq!(json!(names), case["copied"], "{what}");
                for (name, content) in case["contents"].as_object().expect("contents") {
                    assert_eq!(
                        json!(std::fs::read_to_string(format!("{folder}/{name}")).expect("copy")),
                        *content,
                        "{what} {name}"
                    );
                }
                let _ = std::fs::remove_dir_all(&folder);
                staged += 1;
            }
            None => {
                assert_eq!(case["folder"], json!(false), "{what}");
                assert_eq!(json!(text), case["out"], "{what}");
            }
        }
    }
    assert!(staged > 10, "{staged} texts staged");
    for case in p["folder_for"].as_array().expect("cases") {
        let folder = pictures::folder_for(case["key"].as_str().expect("key"));
        assert_eq!(json!(folder.file_name().expect("name").to_string_lossy()), case["name"], "{}", case["key"]);
        assert_eq!(
            json!(folder.parent().and_then(|p| p.file_name()).expect("parent").to_string_lossy()),
            case["parent"]
        );
    }
}
