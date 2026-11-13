//! `tests/test_ai_accounts.py`, the routes of `api/ai_accounts.py`: the account API, who may change an account, and
//! the sign-in terminal against the stand-in CLI. The profile and screen tests of that file are unit tests of
//! `kb-ai-run`; the tests that monkeypatch the pseudo-terminal or the console of the Python module, the one that
//! waits `ORPHAN_S`, and the ones about members that run as an account (`/ai/teams` is not ported) are there too.
//! A team a test needs is a row added to the server's database; what the Python test reads back from
//! `GET /ai/teams/{id}` is read from that row.

mod common;

use std::path::Path;

use common::{
    Refused, account, asks_for_the_code, login, project, says_signed_in, scalar, start, team, terminal, until,
};
use serde_json::{Value, json};

fn folder(a: &Value) -> &Path {
    Path::new(a["folder"].as_str().expect("folder"))
}

#[tokio::test]
async fn test_create_check_rename_and_list() {
    let Some(f) = start("test_create_check_rename_and_list", true, &[]).await else { return };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    assert!(a["status"] == "needs_sign_in" && a["cli"] == "claude" && a["member_count"] == 0);
    assert!(folder(&a).is_dir());
    assert_eq!(folder(&a).parent().and_then(|p| p.canonicalize().ok()), f.accounts.canonicalize().ok());
    // not signed in until the CLI says so
    let id = a["id"].as_str().expect("id");
    assert_eq!(c.post_empty(&format!("/ai/accounts/{id}/check")).await.json()["status"], "needs_sign_in");
    login(&a, "an@work.example");
    let done = c.post_empty(&format!("/ai/accounts/{id}/check")).await.json();
    assert!(done["status"] == "signed_in" && done["email"] == "an@work.example");
    assert_eq!(done["plan"], "max");
    assert_eq!(c.patch(&format!("/ai/accounts/{id}"), json!({"name": "Main"})).await.json()["name"], "Main");
    let listing = c.get("/ai/accounts").await.json();
    let names: Vec<&Value> = listing["accounts"].as_array().expect("accounts").iter().map(|x| &x["name"]).collect();
    assert_eq!(names, vec!["Main"]);
    let clis: Vec<&Value> = listing["clis"].as_array().expect("clis").iter().map(|x| &x["cli"]).collect();
    assert_eq!(clis, vec!["claude"]);
    assert_eq!(listing["terminal"], cfg!(unix));
}

#[tokio::test]
async fn test_names_are_unique_per_computer_and_checked_before_saving() {
    let Some(f) = start("test_names_are_unique_per_computer_and_checked_before_saving", true, &[]).await else {
        return;
    };
    let c = &f.c;
    account(c, "Work Claude").await;
    let dup = c.post("/ai/accounts", json!({"name": "work claude", "cli": "claude"})).await;
    assert!(dup.status == 409 && dup.json()["detail"]["code"] == "name_taken");
    let taken = c.get_query("/ai/accounts/name-check", &[("name", "WORK claude")]).await.json();
    assert_eq!(taken["ok"], false);
    let free = c.get_query("/ai/accounts/name-check", &[("name", "Other")]).await.json();
    assert_eq!(free["ok"], true);
    let blank = c.post("/ai/accounts", json!({"name": "  ", "cli": "claude"})).await;
    assert!(blank.status == 422 && blank.json()["detail"]["code"] == "name_required");
    let unknown = c.post("/ai/accounts", json!({"name": "X", "cli": "vim"})).await;
    assert_eq!(unknown.status, 422);
}

#[tokio::test]
async fn test_other_clis_than_claude_code_are_refused() {
    let Some(f) = start("test_other_clis_than_claude_code_are_refused", true, &[]).await else { return };
    for other in ["agy", "codex", "opencode"] {
        let r = f.c.post("/ai/accounts", json!({"name": "Other", "cli": other})).await;
        assert_eq!(r.status, 422, "{other}");
    }
}

#[tokio::test]
async fn test_a_missing_cli_makes_no_account() {
    // no `claude` anywhere: an empty folder is all `PATH` holds
    let Some(f) = start("test_a_missing_cli_makes_no_account", false, &[]).await else { return };
    let r = f.c.post("/ai/accounts", json!({"name": "Work", "cli": "claude"})).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "cli_missing");
    assert_eq!(f.c.get("/ai/accounts").await.json()["accounts"], json!([]));
}

#[tokio::test]
async fn test_sign_out_keeps_the_account_and_forgets_the_login() {
    let Some(f) = start("test_sign_out_keeps_the_account_and_forgets_the_login", true, &[]).await else { return };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    login(&a, "an@work.example");
    let id = a["id"].as_str().expect("id");
    c.post_empty(&format!("/ai/accounts/{id}/check")).await;
    let out = c.post_empty(&format!("/ai/accounts/{id}/sign-out")).await.json();
    assert!(out["status"] == "needs_sign_in" && out["email"].is_null());
    assert!(!folder(&a).join(".fake-login").exists());
    assert_eq!(c.get("/ai/accounts").await.json()["accounts"].as_array().expect("accounts").len(), 1);
}

#[tokio::test]
async fn test_who_can_change_accounts() {
    // The list is open to everyone; changing an account needs the desktop app (a request from this computer). The
    // Python test calls the app from the address 203.0.113.9; a real server sees every client at 127.0.0.1 and takes
    // the address of a client from `X-Forwarded-For`, as uvicorn does.
    let Some(f) = start("test_who_can_change_accounts", true, &[]).await else { return };
    let a = account(&f.c, "Work Claude").await;
    let id = a["id"].as_str().expect("id");
    let web = f.c.clone().header("X-Forwarded-For", "203.0.113.9");
    assert_eq!(web.get("/ai/accounts").await.status, 200);
    let calls: [(&str, String, Option<Value>); 6] = [
        ("POST", "/ai/accounts".into(), Some(json!({"name": "X", "cli": "claude"}))),
        ("PATCH", format!("/ai/accounts/{id}"), Some(json!({"name": "Y"}))),
        ("POST", format!("/ai/accounts/{id}/check"), None),
        ("POST", format!("/ai/accounts/{id}/sign-out"), None),
        ("POST", format!("/ai/accounts/{id}/signin"), None),
        ("DELETE", format!("/ai/accounts/{id}"), None),
    ];
    for (method, url, body) in calls {
        let body = body.map(|b| b.to_string().into_bytes());
        let r = web.request(method, &url, &[("content-type", "application/json")], body).await;
        assert_eq!(r.status, 403, "{method} {url}");
        assert!(r.detail().as_str().expect("detail").contains("desktop app"));
    }
}

/// `test_removing_an_account_says_what_happens_to_its_members[policy]`.
async fn removing(name: &str, policy: &str, expect_other: bool, expect_paused: bool) {
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let (pid, _) = project(c).await;
    let a = account(c, "Gone").await;
    let other = account(c, "Other").await;
    let m = team(&f.server, &pid, "Claude Code · Backend", json!({"account_id": a["id"]})).await;
    let mut path = format!("/ai/accounts/{}?members={policy}", a["id"].as_str().expect("id"));
    if policy == "other" {
        path.push_str(&format!("&other_id={}", other["id"].as_str().expect("id")));
    }
    let r = c.delete(&path).await;
    assert!(r.status == 200 && r.json()["members_moved"] == 1, "{}", r.text());
    assert!(!folder(&a).exists());
    let account_id = scalar(&f.server, "SELECT account_id FROM ai_team WHERE id = ?", &[json!(m)]).await;
    assert_eq!(account_id, if expect_other { other["id"].clone() } else { Value::Null });
    let paused = scalar(&f.server, "SELECT paused FROM ai_team WHERE id = ?", &[json!(m)]).await;
    assert_eq!(paused == json!(1), expect_paused);
    let names: Vec<Value> = c.get("/ai/accounts").await.json()["accounts"]
        .as_array()
        .expect("accounts")
        .iter()
        .map(|x| x["name"].clone())
        .collect();
    assert_eq!(names, vec![json!("Other")]);
}

#[tokio::test]
async fn test_removing_an_account_says_what_happens_to_its_members_login() {
    removing("test_removing_an_account_says_what_happens_to_its_members_login", "login", false, false).await;
}

#[tokio::test]
async fn test_removing_an_account_says_what_happens_to_its_members_other() {
    removing("test_removing_an_account_says_what_happens_to_its_members_other", "other", true, false).await;
}

#[tokio::test]
async fn test_removing_an_account_says_what_happens_to_its_members_none() {
    removing("test_removing_an_account_says_what_happens_to_its_members_none", "none", false, true).await;
}

#[tokio::test]
async fn test_removing_to_a_missing_or_foreign_account_is_refused() {
    let Some(f) = start("test_removing_to_a_missing_or_foreign_account_is_refused", true, &[]).await else { return };
    let c = &f.c;
    let (pid, _) = project(c).await;
    let a = account(c, "A").await;
    team(&f.server, &pid, "Claude Code · Backend", json!({"account_id": a["id"]})).await;
    let id = a["id"].as_str().expect("id");
    let r = c.delete(&format!("/ai/accounts/{id}?members=other")).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "other_required");
    assert!(folder(&a).exists());
}

// --------------------------------------------------------------------------- the sign-in terminal

#[tokio::test]
async fn test_sign_in_in_a_terminal_ends_signed_in_when_the_cli_says_so() {
    let Some(f) = start("test_sign_in_in_a_terminal_ends_signed_in_when_the_cli_says_so", true, &[]).await else {
        return;
    };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    let id = a["id"].as_str().expect("id");
    assert_eq!(c.post_empty(&format!("/ai/accounts/{id}/signin")).await.json(), json!({"mode": "terminal"}));
    let listing = c.get("/ai/accounts").await.json();
    assert_eq!(listing["accounts"][0]["status"], "signing_in"); // one sign-in per account at a time
    let busy = c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    assert!(busy.status == 409 && busy.json()["detail"]["code"] == "signing_in");
    let mut window = terminal(&f.server, id, &[]).await.expect("the terminal opens");
    let (text, _) = window.drain(asks_for_the_code).await;
    assert!(text.contains("claude.example/oauth"));
    window.write("good\n").await; // what the person pastes
    let (_, state) = window.drain(says_signed_in).await;
    assert_eq!(state["account"]["status"], "signed_in");
    assert_eq!(state["account"]["email"], "an@work.example");
    // the CLI ended by itself
    until(10, async || c.get("/ai/accounts").await.json()["accounts"][0]["signing_in_by"].is_null()).await;
    assert_eq!(c.get(&format!("/ai/accounts/{id}")).await.json()["status"], "signed_in");
    window.close().await;
}

#[tokio::test]
async fn test_a_rejected_code_saves_nothing() {
    let Some(f) = start("test_a_rejected_code_saves_nothing", true, &[]).await else { return };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    let id = a["id"].as_str().expect("id");
    c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    let mut window = terminal(&f.server, id, &[]).await.expect("the terminal opens");
    window.drain(asks_for_the_code).await;
    window.write("bad\n").await;
    let (_, state) = window.drain(|m| m["type"] == "state" && m["ended"] == "exited").await;
    assert!(state["exit_code"] == 1 && state["signed_in"] == false);
    assert_eq!(c.get(&format!("/ai/accounts/{id}")).await.json()["status"], "needs_sign_in");
    window.close().await;
}

#[tokio::test]
async fn test_cancel_stops_the_cli_and_marks_nothing() {
    let Some(f) = start("test_cancel_stops_the_cli_and_marks_nothing", true, &[]).await else { return };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    let id = a["id"].as_str().expect("id");
    c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    let mut window = terminal(&f.server, id, &[]).await.expect("the terminal opens");
    window.drain(asks_for_the_code).await;
    assert_eq!(c.delete(&format!("/ai/accounts/{id}/signin")).await.json(), json!({"stopped": true}));
    // the window is told, and nothing is open any more
    let (_, state) = window.drain(|m| m["type"] == "state" && m["ended"] == "cancelled").await;
    assert_eq!(state["running"], false);
    assert_eq!(c.get("/ai/accounts").await.json()["accounts"][0]["status"], "needs_sign_in");
    assert_eq!(c.delete(&format!("/ai/accounts/{id}/signin")).await.json(), json!({"stopped": false}));
    assert_eq!(c.get(&format!("/ai/accounts/{id}")).await.json()["status"], "needs_sign_in");
    window.close().await;
}

#[tokio::test]
async fn test_the_login_runs_in_the_accounts_own_folder_not_the_one_on_this_computer() {
    let Some(f) = start("test_the_login_runs_in_the_accounts_own_folder_not_the_one_on_this_computer", true, &[]).await
    else {
        return;
    };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    let id = a["id"].as_str().expect("id");
    c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    let mut window = terminal(&f.server, id, &[]).await.expect("the terminal opens");
    window.drain(asks_for_the_code).await;
    window.write("good\n").await;
    window.drain(says_signed_in).await;
    assert!(folder(&a).join(".fake-login").is_file());
    assert!(!f.claude.join(".fake-login").exists());
    window.close().await;
}

#[tokio::test]
async fn test_the_same_login_added_twice_is_noticed_for_claude() {
    let Some(f) = start("test_the_same_login_added_twice_is_noticed_for_claude", true, &[]).await else { return };
    let c = &f.c;
    let first = account(c, "Work Claude").await;
    login(&first, "an@work.example");
    c.post_empty(&format!("/ai/accounts/{}/check", first["id"].as_str().expect("id"))).await;
    let second = account(c, "Copy").await;
    login(&second, "AN@work.example");
    let id = second["id"].as_str().expect("id");
    // the board asks the CLI who is signed in every few seconds while the sign-in is open
    c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    let mut window = terminal(&f.server, id, &[]).await.expect("the terminal opens");
    let (_, state) = window.drain(|m| m["type"] == "state" && m["signed_in"] == true).await;
    assert_eq!(state["duplicate_of"], "Work Claude");
    window.close().await;
    c.delete(&format!("/ai/accounts/{id}/signin")).await;
}

#[tokio::test]
async fn test_the_terminal_only_talks_to_pages_of_this_computer() {
    let Some(f) = start("test_the_terminal_only_talks_to_pages_of_this_computer", true, &[]).await else { return };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    let id = a["id"].as_str().expect("id");
    c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    // a page of this computer; the desktop app loads its UI from a file, so its origin is "null"
    for origin in [None, Some("null"), Some("file://"), Some("http://localhost:5173"), Some("http://127.0.0.1:8080")] {
        let headers: Vec<(&str, &str)> = origin.map(|o| ("Origin", o)).into_iter().collect();
        let window = terminal(&f.server, id, &headers).await.unwrap_or_else(|r| panic!("{origin:?}: refused {r:?}"));
        window.close().await;
    }
    // a page of another website, a client that is not on this computer
    for origin in ["https://evil.example", "http://localhost.evil.example", "", "http://[::2]:80"] {
        let r = terminal(&f.server, id, &[("Origin", origin)]).await.err();
        assert!(matches!(r, Some(Refused(403))), "{origin:?}: {r:?}");
    }
    let r = terminal(&f.server, id, &[("X-Forwarded-For", "10.0.0.5")]).await.err();
    assert!(matches!(r, Some(Refused(403))), "{r:?}");
    // no sign-in is open for this account
    let r = terminal(&f.server, "nobody", &[]).await.err();
    assert!(matches!(r, Some(Refused(403))), "{r:?}");
    c.delete(&format!("/ai/accounts/{id}/signin")).await;
}

#[tokio::test]
async fn test_signing_in_again_to_a_signed_in_account_waits_for_the_login_to_end() {
    let Some(f) = start("test_signing_in_again_to_a_signed_in_account_waits_for_the_login_to_end", true, &[]).await
    else {
        return;
    };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    login(&a, "an@work.example");
    let id = a["id"].as_str().expect("id");
    c.post_empty(&format!("/ai/accounts/{id}/check")).await;
    c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    let mut window = terminal(&f.server, id, &[]).await.expect("the terminal opens");
    // the status said "signed in" before the CLI even asked for a code: that is not the end of this sign-in
    let (_, state) = window.drain(asks_for_the_code).await;
    assert_eq!(state["signed_in"], false);
    window.write("good\n").await;
    window.drain(says_signed_in).await;
    window.close().await;
}

#[tokio::test]
async fn test_done_stops_the_cli_and_asks_it_once_more() {
    let Some(f) = start("test_done_stops_the_cli_and_asks_it_once_more", true, &[]).await else { return };
    let c = &f.c;
    let a = account(c, "Work Claude").await;
    let id = a["id"].as_str().expect("id");
    assert_eq!(c.post_empty(&format!("/ai/accounts/{id}/signin/done")).await.json(), json!({"done": false}));
    c.post_empty(&format!("/ai/accounts/{id}/signin")).await;
    let mut window = terminal(&f.server, id, &[]).await.expect("the terminal opens");
    window.drain(asks_for_the_code).await;
    login(&a, "an@work.example"); // the person signed in elsewhere and presses Done
    assert_eq!(c.post_empty(&format!("/ai/accounts/{id}/signin/done")).await.json(), json!({"done": true}));
    let (_, state) = window.drain(|m| m["type"] == "state" && m["ended"] == "done").await;
    assert_eq!(state["running"], false);
    assert_eq!(c.get(&format!("/ai/accounts/{id}")).await.json()["status"], "signed_in");
    window.close().await;
}
