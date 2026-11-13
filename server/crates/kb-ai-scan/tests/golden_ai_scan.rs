//! The golden vectors of the repository scan (`contract/golden/ai_scan.json`, made by `gen_ai_scan.py` from
//! `services/ai/repo_scan.py`): what `scan` reads from the layouts, what `suggest` proposes, the change fingerprint, how a
//! command's result is classified, the helpers that build a command line, the answers of the light model and the AI as
//! they are read, the AI's prompt and a job's document.
//!
//! A layout is described as data, so each test recreates the folder (files in the listed order, links, `git init`).
//! `Path.rglob` keeps the first twelve `package.json` in the order the system lists the folders, so a layout with
//! manifests in several folders is compared exactly when this machine lists every folder as it was listed when the
//! vectors were made (the same file system: the usual case), and in a normalised order (packages sorted, suggestions not
//! compared) otherwise.

mod common;

use std::path::Path;

use base64::Engine;
use common::{assert_same, git, golden, init, tmp};
use kb_ai_scan::cancel::Cancel;
use kb_ai_scan::job::Job;
use kb_ai_scan::{Error, suggest::ROLE_NAMES};
use serde_json::{Map, Value, json};

/// Build the layout `spec` in `root`.
fn build(root: &Path, spec: &Value) {
    std::fs::create_dir_all(root).expect("root");
    for file in spec["files"].as_array().expect("files") {
        let rel = file[0].as_str().expect("path");
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        let content = &file[1];
        let bytes: Vec<u8> = match content {
            Value::String(text) => text.clone().into_bytes(),
            Value::Object(map) if map.contains_key("b64") => {
                base64::engine::general_purpose::STANDARD.decode(map["b64"].as_str().expect("b64")).expect("base64")
            }
            Value::Object(map) => {
                let times = map["times"].as_u64().expect("times") as usize;
                let mut text = map["repeat"].as_str().expect("repeat").repeat(times);
                text.push_str(map.get("tail").and_then(Value::as_str).unwrap_or(""));
                text.into_bytes()
            }
            other => panic!("a file's content: {other}"),
        };
        std::fs::write(&path, bytes).expect("file");
    }
    for link in spec["links"].as_array().expect("links") {
        let path = root.join(link[0].as_str().expect("link"));
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        #[cfg(unix)]
        std::os::unix::fs::symlink(link[1].as_str().expect("target"), &path).expect("symlink");
    }
    if let Some(spec_git) = spec["git"].as_object() {
        git(root, &["init", "-q", "-b", "main"]);
        if let Some(remote) = spec_git.get("remote").and_then(Value::as_str) {
            git(root, &["remote", "add", "origin", remote]);
        }
        if spec_git.get("commit").and_then(Value::as_bool) == Some(true) {
            git(root, &["add", "-A"]);
            for rel in spec_git.get("untracked").and_then(Value::as_array).into_iter().flatten() {
                git(root, &["rm", "-q", "--cached", rel.as_str().expect("path")]);
            }
            git(root, &["commit", "-q", "--allow-empty", "-m", "x"]);
        }
    }
}

/// Whether every folder of the layout is listed here in the order it was listed when the vectors were made.
fn same_order(root: &Path, case: &Value) -> bool {
    case["dir_order"].as_object().expect("dir_order").iter().all(|(rel, names)| {
        let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
        let listed: Vec<String> = std::fs::read_dir(&dir)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.as_array().expect("names").iter().map(|n| n.as_str().expect("name").to_string()).collect::<Vec<_>>()
            == listed
    })
}

/// `found` with what depends on the order of the folders put in a fixed order.
fn normalised(found: &Value) -> Value {
    let mut out = found.clone();
    let map = out.as_object_mut().expect("an object");
    for key in ["frameworks", "languages"] {
        if let Some(Value::Array(items)) = map.get_mut(key) {
            items.sort_by_key(|v| v.as_str().unwrap_or("").to_string());
        }
    }
    if let Some(Value::Array(items)) = map.get_mut("packages") {
        items.sort_by_key(|p| format!("{}|{}", p["kind"].as_str().unwrap_or(""), p["path"].as_str().unwrap_or("")));
    }
    out
}

fn error_of(expected: &Value) -> Option<String> {
    expected.get("error").map(|e| e[1].as_str().expect("message").to_string())
}

fn message(err: &Error) -> String {
    err.to_string()
}

#[tokio::test]
async fn scan_of_every_layout() {
    let _guard = init().await;
    let vectors = golden("ai_scan.json");
    let mut checked = 0;
    for case in vectors["layouts"].as_array().expect("layouts") {
        let name = case["name"].as_str().expect("name");
        let root = tmp(name);
        build(&root, case);
        let exact = !case["order_free"].as_bool().expect("flag") || same_order(&root, case);
        let got = kb_ai_scan::scan(&root.to_string_lossy()).await;
        let want = &case["scan"];
        match (&got, error_of(want)) {
            (Err(e), Some(text)) => assert_eq!(message(e), text, "{name}"),
            (Ok(found), None) => {
                let mut want = want.clone();
                want["folder"] = json!(root.to_string_lossy());
                if exact {
                    assert_same(name, found, &want);
                } else {
                    eprintln!("{name}: the folders are listed in another order here, compared in a normalised order");
                    // the folders are listed in another order here: the packages, the languages and the frameworks
                    // are what they are in a different order
                    assert_same(name, &normalised(found), &normalised(&want));
                }
            }
            (got, want) => panic!("{name}: got {got:?}, wanted {want:?}"),
        }
        checked += 1;
    }
    assert!(checked >= 24, "{checked} layouts");
}

#[tokio::test]
async fn suggest_of_every_layout() {
    let _guard = init().await;
    let vectors = golden("ai_scan.json");
    for case in vectors["layouts"].as_array().expect("layouts") {
        let name = case["name"].as_str().expect("name");
        let root = tmp(name);
        build(&root, case);
        if case["order_free"].as_bool().expect("flag") && !same_order(&root, case) {
            continue;
        }
        let Ok(found) = kb_ai_scan::scan(&root.to_string_lossy()).await else {
            assert!(error_of(&case["scan"]).is_some(), "{name}");
            continue;
        };
        let got = kb_ai_scan::suggest(&found);
        match (got, error_of(&case["suggest"])) {
            (Ok(got), None) => assert_same(name, &got, &case["suggest"]),
            (Err(e), Some(text)) => assert_eq!(message(&e), text, "{name}"),
            (got, want) => panic!("{name}: got {got:?}, wanted {want:?}"),
        }
    }
}

#[tokio::test]
async fn fingerprint_and_committed_files_of_every_layout() {
    let _guard = init().await;
    let vectors = golden("ai_scan.json");
    for case in vectors["layouts"].as_array().expect("layouts") {
        let name = case["name"].as_str().expect("name");
        let root = tmp(name);
        build(&root, case);
        assert_eq!(kb_ai_scan::fingerprint(&root), case["fingerprint"].as_str().expect("fingerprint"), "{name}");
        let got = kb_ai_scan::detect::committed(&root).await.map(|set| {
            let mut v: Vec<String> = set.into_iter().collect();
            v.sort();
            json!(v)
        });
        assert_eq!(got.unwrap_or(Value::Null), case["committed"], "{name}");
    }
}

/// The fingerprint changes with the files the scan reads and with nothing else.
#[tokio::test]
async fn the_fingerprint_follows_the_tooling_files_only() {
    let _guard = init().await;
    let root = tmp("fp");
    common::write_files(&root, &[("package.json", "{}"), ("src/a.ts", "x"), (".github/workflows/ci.yml", "run: x\n")]);
    let first = kb_ai_scan::fingerprint(&root);
    common::write_files(&root, &[("src/a.ts", "changed"), ("README.md", "new")]);
    assert_eq!(kb_ai_scan::fingerprint(&root), first, "a source file or a readme is not tooling");
    common::write_files(&root, &[("package.json", "{\"a\": 1}")]);
    let second = kb_ai_scan::fingerprint(&root);
    assert_ne!(second, first);
    common::write_files(&root, &[(".github/workflows/ci.yml", "run: y\n")]);
    assert_ne!(kb_ai_scan::fingerprint(&root), second);
    common::write_files(&root, &[("node_modules/x/package.json", "{}"), ("dist/Makefile", "x")]);
    assert_eq!(kb_ai_scan::fingerprint(&root), kb_ai_scan::fingerprint(&root));
}

#[tokio::test]
async fn a_folder_that_is_missing_is_refused_in_the_words_of_python() {
    let _guard = init().await;
    for pair in golden("ai_scan.json")["folder_missing"].as_array().expect("cases") {
        let given = pair[0].as_str().expect("folder");
        let want = pair[1][1].as_str().expect("message");
        match kb_ai_scan::scan(given).await {
            Err(Error::Value(text)) => assert_eq!(text, want),
            other => panic!("{given}: {other:?}"),
        }
    }
}

#[test]
fn str_of_a_path() {
    for pair in golden("ai_scan.json")["path_str"].as_array().expect("cases") {
        let given = pair[0].as_str().expect("path");
        assert_eq!(kb_ai_scan::pyfs::path_str(given), pair[1].as_str().expect("want"), "{given:?}");
    }
}

#[test]
fn classify_of_a_result() {
    let vectors = golden("ai_scan.json");
    let cases = vectors["classify"].as_array().expect("classify");
    assert!(cases.len() > 300);
    for case in cases {
        let code = case[0].as_i64().map(|c| i32::try_from(c).expect("exit code"));
        let text = case[1].as_str().expect("text");
        let got = kb_ai_scan::classify(code, text, case[2].as_bool().expect("flag"));
        assert_eq!(got, case[3].as_str().expect("status"), "{code:?} {text:?}");
    }
}

#[test]
fn the_reason_a_command_is_wrong() {
    for case in golden("ai_scan.json")["why_wrong"].as_array().expect("why_wrong") {
        let code = case[1].as_i64().map(|c| i32::try_from(c).expect("exit code"));
        let text = case[0].as_str().expect("text");
        assert_eq!(kb_ai_scan::why_wrong(text, code), case[2].as_str().expect("reason"), "{text:?} {code:?}");
    }
}

#[test]
fn folders_and_commands_of_a_package() {
    use kb_ai_scan::suggest::{dir, npm, py};
    for case in golden("ai_scan.json")["dir_npm_py"].as_array().expect("cases") {
        let pkg = &case[0];
        assert_eq!(json!(dir(pkg).expect("dir")), case[1], "{pkg}");
        assert_eq!(npm(pkg, "ci").expect("npm"), case[2].as_str().expect("want"), "{pkg}");
        assert_eq!(npm(pkg, "run x").expect("npm"), case[3].as_str().expect("want"), "{pkg}");
        assert_eq!(py(pkg, "sync").expect("py"), case[4].as_str().expect("want"), "{pkg}");
        assert_eq!(py(pkg, "run pytest -q").expect("py"), case[5].as_str().expect("want"), "{pkg}");
    }
}

#[test]
fn the_script_of_a_package() {
    let vectors = golden("ai_scan.json");
    for case in vectors["pkg_cmd"].as_array().expect("cases") {
        let got = kb_ai_scan::suggest::pkg_cmd(&case[0], case[1].as_str().expect("script")).expect("a command or none");
        assert_eq!(json!(got), case[2], "{} {}", case[0], case[1]);
    }
    for case in vectors["pkg_cmd_errors"].as_array().expect("cases") {
        for pair in &case.as_array().expect("row")[1..] {
            let script = pair[0].as_str().expect("script");
            match (kb_ai_scan::suggest::pkg_cmd(&case[0], script), error_of(&pair[1])) {
                (Err(e), Some(text)) => assert_eq!(message(&e), text, "{} {script}", case[0]),
                (Ok(got), None) => assert_eq!(json!(got), pair[1], "{} {script}", case[0]),
                (got, want) => panic!("{} {script}: got {got:?}, wanted {want:?}", case[0]),
            }
        }
    }
}

#[test]
fn suggest_of_facts_written_by_hand() {
    let vectors = golden("ai_scan.json");
    for pair in vectors["suggest"].as_array().expect("cases") {
        match (kb_ai_scan::suggest(&pair[0]), error_of(&pair[1])) {
            (Ok(got), None) => assert_same(&pair[0].to_string(), &got, &pair[1]),
            (Err(e), Some(text)) => assert_eq!(message(&e), text, "{}", pair[0]),
            (got, want) => panic!("{}: got {got:?}, wanted {want:?}", pair[0]),
        }
    }
    for pair in vectors["suggest_missing_keys"].as_array().expect("cases") {
        let want = error_of(&pair[1]).expect("a KeyError");
        match kb_ai_scan::suggest(&pair[0]) {
            Err(e) => assert_eq!(message(&e), want, "{}", pair[0]),
            Ok(got) => panic!("{}: {got}", pair[0]),
        }
    }
}

#[test]
fn a_browser_tool_is_only_for_a_project_with_a_ui() {
    for case in golden("ai_scan.json")["wanted"].as_array().expect("cases") {
        let entry: Map<String, Value> = case[0].as_object().expect("entry").clone();
        assert_eq!(kb_ai_scan::suggest::wanted(&entry, &case[1]), case[2].as_bool().expect("want"), "{case}");
    }
}

#[test]
fn the_roles_a_team_can_have() {
    let want = golden("ai_scan.json")["role_names"].clone();
    let got: Map<String, Value> = ROLE_NAMES.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect();
    assert_same("role names", &Value::Object(got), &want);
}

#[test]
fn the_answers_of_the_models_as_they_are_read() {
    let vectors = golden("ai_scan.json");
    for pair in vectors["parse_refined"].as_array().expect("cases") {
        let text = pair[0].as_str();
        let got = kb_ai_scan::parse_refined(text).map_or(Value::Null, Value::Object);
        assert_same(&format!("refined {text:?}"), &got, &pair[1]);
    }
    for pair in vectors["parse_proposal"].as_array().expect("cases") {
        let text = pair[0].as_str();
        assert_same(&format!("proposal {text:?}"), &kb_ai_scan::parse_proposal(text).unwrap_or(Value::Null), &pair[1]);
    }
    for pair in vectors["code_proposal"].as_array().expect("cases") {
        assert_same(&pair[0].to_string(), &kb_ai_scan::code_proposal(&pair[0]), &pair[1]);
    }
}

#[test]
fn what_a_tool_call_of_the_ai_looks_like() {
    for case in golden("ai_scan.json")["describe_tool"].as_array().expect("cases") {
        let got = kb_ai_scan::describe_tool(case[0].as_str().expect("name"), &case[1], case[2].as_str().expect("cwd"));
        assert_eq!(got, case[3].as_str().expect("want"), "{case}");
    }
}

#[test]
fn the_prompts_are_python_s() {
    use sha2::Digest;
    let vectors = golden("ai_scan.json");
    // Python's `str.format` turned `{{` into `{`: put them back to compare with the text of the source
    let escaped = kb_ai_scan::job::AI_PROMPT_TEMPLATE
        .replace('{', "{{")
        .replace('}', "}}")
        .replace("{{facts}}", "{facts}")
        .replace("{{extra}}", "{extra}");
    let hash =
        |text: &str| -> String { sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect() };
    let want = &vectors["prompts"];
    assert_eq!(json!([escaped.chars().count(), hash(&escaped)]), want["ai"]);
    assert_eq!(json!([kb_ai_scan::REFINE_PROMPT.chars().count(), hash(kb_ai_scan::REFINE_PROMPT)]), want["refine"]);
}

#[test]
fn the_prompt_the_ai_is_given() {
    for case in golden("ai_scan.json")["ai_prompt"].as_array().expect("cases") {
        let keep = case[2].as_object().expect("keep").clone();
        let got = kb_ai_scan::job::ai_prompt(&case[0], case[1].as_str().expect("hint"), &keep, &case[3]);
        assert_eq!(got, case[4].as_str().expect("want"), "{}", case[1]);
    }
}

#[test]
fn a_job_s_document() {
    let _ = Cancel::new();
    for case in golden("ai_scan.json")["job"].as_array().expect("cases") {
        let mode = case[0].as_str().expect("mode");
        let trial = case[1].as_object().expect("trial").clone();
        let job = Job::new("scn", mode, "hint", trial, json!({"commands": {}}));
        for op in case[2].as_array().expect("ops") {
            let op = op.as_array().expect("op");
            match op[0].as_str().expect("kind") {
                "step" => job.step(
                    op[1].as_str().expect("key"),
                    op[2].as_str().expect("label"),
                    op.get(3).and_then(Value::as_str).unwrap_or(""),
                    op.get(4).and_then(Value::as_str).unwrap_or("waiting"),
                ),
                "mark" => job.mark(
                    op[1].as_str().expect("key"),
                    op[2].as_str().expect("state"),
                    op[3].get("label").and_then(Value::as_str),
                    op[3].get("detail").and_then(Value::as_str),
                ),
                "line" => job.line(op[1].as_str().expect("text")),
                other => panic!("{other}"),
            }
        }
        let fin = case[3].as_array().expect("finish");
        job.finish(fin[0].as_str().expect("state"), fin.get(1).and_then(Value::as_str));
        let mut doc = job.doc();
        let map = doc.as_object_mut().expect("doc");
        map.shift_remove("started_at");
        map.shift_remove("ended_at");
        for s in map["steps"].as_array_mut().expect("steps") {
            if !s["at_s"].is_null() {
                s["at_s"] = json!(0);
            }
        }
        let got = json!({"doc": doc, "trial": job.trial()});
        assert_same(&case[2].to_string().chars().take(60).collect::<String>(), &got, &case[4]);
    }
}

#[test]
fn how_long_a_job_has_run() {
    for pair in golden("ai_scan.json")["job_view"].as_array().expect("cases") {
        let got = kb_ai_scan::job_view(pair[0].as_str().expect("raw"));
        assert_same(&pair[0].to_string(), &got, &pair[1]);
    }
}
