//! The pure functions of `accounts` and `signin` against what the Python modules gave
//! (`contract/golden/ai_accounts.json`, made by `gen_ai_accounts.py`): the account state machine, names and folders,
//! versions, an account as the UI sees it, the status bar's reading of the terminal, the command to run by hand.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::path::Path;

use kb_ai::profiles::Status;
use kb_ai_run::{accounts, signin};
use kb_base::pyjson;
use kb_db::entities::ai_account;
use serde_json::{Value, json};

fn golden() -> Value {
    common::golden("ai_accounts.json")
}

fn cases(g: &Value, name: &str) -> Vec<Value> {
    let cases = g[name].as_array().unwrap_or_else(|| panic!("{name}")).clone();
    assert!(!cases.is_empty(), "{name}");
    cases
}

fn refused<T: serde::Serialize>(result: Result<T, accounts::AccountError>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(e) => json!({"error": [e.message, e.code]}),
    }
}

fn account(row: &Value) -> ai_account::Model {
    serde_json::from_value(row.clone()).expect("an account row")
}

fn pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .expect("pairs")
        .iter()
        .map(|p| (p[0].as_str().expect("k").into(), p[1].as_str().expect("v").into()))
        .collect()
}

fn texts(value: &Value) -> Vec<String> {
    value.as_array().expect("a list").iter().map(|a| a.as_str().expect("text").to_string()).collect()
}

#[test]
fn names_folders_and_versions() {
    let g = golden();
    for case in cases(&g, "clean_name") {
        let got = refused(accounts::clean_name(case["name"].as_str().unwrap_or("")));
        assert_eq!(got, case["out"], "{}", case["name"]);
    }
    for case in cases(&g, "slug") {
        assert_eq!(json!(accounts::slug(case["name"].as_str().expect("name"))), case["out"], "{}", case["name"]);
    }
    for case in cases(&g, "inside_root") {
        let (root, leaf) = (case["root"].as_str().expect("root"), case["leaf"].as_str().expect("leaf"));
        let got = refused(accounts::inside(root, leaf).map(|p| p.to_string_lossy().into_owned()));
        assert_eq!(got, case["out"], "{root} + {leaf}");
    }
    for case in cases(&g, "parse_version") {
        assert_eq!(
            json!(accounts::parse_version(case["text"].as_str().unwrap_or(""))),
            case["out"],
            "{}",
            case["text"]
        );
    }
    for case in cases(&g, "cli_for_provider") {
        assert_eq!(json!(accounts::cli_for_provider(case["provider"].as_str().expect("provider"))), case["out"]);
    }
    for case in cases(&g, "claude_config_dir") {
        let row = (!case["account"].is_null()).then(|| account(&case["account"]));
        assert_eq!(json!(accounts::claude_config_dir(row.as_ref())), case["out"]);
    }
}

#[test]
fn the_constants_are_the_python_ones() {
    let c = &golden()["constants"];
    assert_eq!(json!(accounts::ROOT_ENV), c["ROOT_ENV"]);
    let clis: serde_json::Map<String, Value> = accounts::ACCOUNT_CLIS
        .iter()
        .map(|(key, spec)| {
            let spec = json!({"label": spec.label, "provider": spec.provider, "binary": spec.binary, "blurb": spec.blurb, "runnable": spec.runnable});
            (key.to_string(), spec)
        })
        .collect();
    assert_eq!(Value::Object(clis), c["ACCOUNT_CLIS"]);
    assert_eq!(json!(accounts::STATUSES), c["STATUSES"]);
    assert_eq!(json!(accounts::NAME_MAX), c["NAME_MAX"]);
    assert_eq!(json!(accounts::VERSION_TIMEOUT_S), c["VERSION_TIMEOUT_S"]);
    assert_eq!(json!(accounts::VERSION_RETRY_S), c["VERSION_RETRY_S"]);
    assert_eq!(json!(accounts::available("claude")), c["available"]);
    assert_eq!(json!(accounts::CHECKS_AT_ONCE), json!(3));
    assert_eq!(json!(signin::KEEP_BYTES), c["KEEP_BYTES"]);
    assert_eq!(json!(signin::POLL_S), c["POLL_S"]);
    assert_eq!(json!(signin::ORPHAN_S), c["ORPHAN_S"]);
    assert_eq!(signin::MAX_S, c["MAX_S"].as_f64().expect("MAX_S"));
    assert_eq!(json!(signin::SignInBusy { by: "An Nguyen".into() }.to_string()), c["busy"]);
    let t = signin::Timing::default();
    assert_eq!((t.poll_s, t.orphan_s, t.max_s), (signin::POLL_S, signin::ORPHAN_S, signin::MAX_S));
}

#[test]
fn apply_writes_a_cli_answer_into_the_row_as_python_does() {
    let all = cases(&golden(), "apply");
    assert_eq!(all.len(), 98);
    for case in all {
        let mut row = account(&case["before"]);
        let before = row.clone();
        let answer = (!case["answer"].is_null()).then(|| {
            let a = &case["answer"];
            let text = |key: &str| a[key].as_str().map(str::to_string);
            Status {
                signed_in: a["signed_in"].as_bool().expect("signed_in"),
                detail: text("detail").unwrap_or_default(),
                email: text("email"),
                plan: text("plan"),
                method: text("method"),
            }
        });
        let found = case["found"].as_bool().expect("found");
        let just_signed_out = accounts::apply(&mut row, answer.as_ref(), found);
        if row.checked_at != before.checked_at {
            assert!(kb_ai::store::parse_iso(row.checked_at.as_deref()).is_some());
            row.checked_at = Some("<now>".into());
        }
        if row.updated_at != before.updated_at {
            row.updated_at = "<now>".into();
        }
        let what = format!("{} + {} (found: {found})", case["before"], case["answer"]);
        assert_eq!(serde_json::to_value(&row).expect("json"), case["after"], "{what}");
        assert_eq!(json!(just_signed_out), case["out"], "{what}");
    }
}

#[test]
fn to_dict_is_the_account_the_ui_sees() {
    for case in cases(&golden(), "to_dict") {
        let row = account(&case["account"]);
        let users = Some(&case["users"]).filter(|u| !u.is_null());
        let got = accounts::to_dict(&row, users, case["signing_in_by"].as_str()).expect("a known CLI");
        let want = case["out"].clone();
        assert_eq!(got, want, "{case}");
        assert_eq!(pyjson::dumps(&got), pyjson::dumps(&want), "key order: {case}");
    }
    let mut unknown = account(&golden()["to_dict"][0]["account"]);
    unknown.cli = "codex".into();
    assert!(matches!(accounts::to_dict(&unknown, None, None), Err(accounts::Error::Other(_))));
}

#[test]
fn test_the_status_bar_reads_the_terminal_best_effort() {
    // the Python test's own table
    for (text, phase, url) in [
        ("$ claude auth login\nStarting…", "waiting", None),
        (
            "Opening your browser to sign in…\nvisit: https://claude.example/oauth/authorize?code=true&client_id=x\n",
            "browser",
            Some("https://claude.example/oauth/authorize?code=true&client_id=x"),
        ),
        ("Paste code here if prompted > ", "paste_code", None),
        ("Select login method:\n❯ 1. Google OAuth\n  2. Use a Google Cloud project", "choose_method", None),
        ("Paste the authorization code here > ", "paste_code", None),
        ("Do you trust the files in this folder?\n❯ 1. Yes", "trust_folder", None),
        ("Invalid or expired code", "error", None),
        ("Paste code here if prompted > bad\nInvalid or expired code\nPress Enter to retry", "error", None),
        ("Paste code here if prompted > bad\nInvalid or expired code", "error", None),
        ("\x1b[1mSelect login method\x1b[0m", "choose_method", None),
    ] {
        let seen = signin::read_screen(text, false);
        assert_eq!((seen.phase, seen.url.as_deref()), (phase, url), "{text}");
    }
    // and the vectors
    for case in cases(&golden(), "read_screen") {
        let seen =
            signin::read_screen(case["text"].as_str().expect("text"), case["signed_in"].as_bool().expect("bool"));
        assert_eq!(json!({"phase": seen.phase, "url": seen.url}), case["out"], "{case}");
    }
}

#[test]
fn test_nothing_unknown_is_claimed() {
    assert_eq!(signin::read_screen("some new question we have never seen", false).phase, "waiting");
}

#[test]
fn test_the_powershell_command_quotes_the_folder_and_goes_there() {
    let args = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let cmd = signin::powershell(
        &args(&["claude.cmd", "auth", "login", "--claudeai"]),
        &vec![("CLAUDE_CONFIG_DIR".to_string(), r"C:\Users\O'Neil\acc".to_string())],
        Some(Path::new(r"C:\Users\O'Neil\acc")),
    );
    assert_eq!(
        cmd,
        "$env:CLAUDE_CONFIG_DIR='C:\\Users\\O''Neil\\acc'; Set-Location 'C:\\Users\\O''Neil\\acc'; claude.cmd auth login --claudeai"
    );
    assert_eq!(
        signin::powershell(&args(&[r"C:\Program Files\claude.exe"]), &Vec::new(), None),
        "& 'C:\\Program Files\\claude.exe'"
    );
    for case in cases(&golden(), "powershell") {
        let cwd = case["cwd"].as_str().map(Path::new);
        assert_eq!(json!(signin::powershell(&texts(&case["argv"]), &pairs(&case["env"]), cwd)), case["out"], "{case}");
    }
}

#[test]
fn the_fallback_command_is_the_login_with_the_accounts_variables() {
    for case in cases(&golden(), "fallback_command") {
        let cwd = case["cwd"].as_str().map(Path::new);
        let got = signin::fallback_text(&texts(&case["argv"]), &pairs(&case["env"]), cwd, case["platform"] == "win32");
        assert_eq!(json!(got), case["out"], "{case}");
    }
}
