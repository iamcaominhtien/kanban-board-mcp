//! `server/tests/test_ai_accounts.py` after the profile tests (those are in `kb-ai`): AI accounts as separate logins of
//! one CLI, members that run as an account, and the sign-in terminal against the stand-in CLI.
//!
//! The Python tests go through the account routes (`api/ai_accounts.py`), which a later task ports. Here each test
//! keeps its name and calls what its route calls (`accounts::create` for `POST /ai/accounts`, `signin::start` for
//! `POST /ai/accounts/{id}/signin`, `signin::stop` for the `DELETE`...); what only the route does (status codes,
//! "only from this computer", the name check, the WebSocket) is left for that task and listed at the end of this file.
//! The reading of the terminal and the PowerShell command (`test_the_status_bar_reads_the_terminal_best_effort`,
//! `test_nothing_unknown_is_claimed`, `test_the_powershell_command_quotes_the_folder_and_goes_there`) are in
//! `golden_accounts.rs`, next to the vectors.
#![cfg(unix)]

mod common;

use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kb_ai_run::accounts::{self, AccountError, Error};
use kb_ai_run::cli;
use kb_ai_run::signin::{self, Queue, SignIn};
use kb_db::database;
use kb_db::entities::{ai_account, ai_team};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};
use tokio::sync::MutexGuard;

/// The fixture `fake_cli`: `claude` resolves to the stand-in CLI, accounts live in a temporary folder and each has its
/// own login file; no account, no member and no open sign-in from an earlier test.
async fn fake_cli() -> MutexGuard<'static, ()> {
    let lock = common::init_with(&[("FAKE_CLAUDE_ACCOUNTS", "1")]).await;
    signin::stop_all().await;
    common::clear::<ai_account::Entity>().await;
    common::clear::<ai_team::Entity>().await;
    let _ = std::fs::remove_dir_all(accounts::root());
    cli::set_find_cli_hook(None);
    signin::set_timing(Some(signin::Timing { poll_s: 0.2, ..signin::Timing::default() }));
    signin::set_pty(None);
    signin::set_console(None);
    signin::set_open_console(None);
    lock
}

async fn account(name: &str) -> ai_account::Model {
    let session = database::session();
    accounts::create(&session, name, "claude", "user").await.expect("an account")
}

async fn stored(id: &str) -> ai_account::Model {
    accounts::get(&database::session(), id).await.expect("the account")
}

async fn check(id: &str) -> ai_account::Model {
    let session = database::session();
    let row = accounts::get(&session, id).await.expect("the account");
    accounts::check(&session, row, "check").await.expect("check")
}

async fn team_row(id: &str) -> ai_team::Model {
    ai_team::Entity::find_by_id(id).one(&database::session()).await.expect("query").expect("the team")
}

fn code(result: Result<impl Sized, Error>) -> String {
    match result {
        Err(Error::Account(AccountError { code, .. })) => code,
        Err(other) => panic!("another error: {other}"),
        Ok(_) => panic!("not refused"),
    }
}

/// `_login(account, email)`.
fn login(account: &ai_account::Model, email: &str) {
    common::login(&account.folder, email);
}

// --------------------------------------------------------------------------- the account API

#[tokio::test]
async fn test_create_check_rename_and_list() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    let shown = accounts::to_dict(&a, None, None).expect("dict");
    assert!(shown["status"] == "needs_sign_in" && shown["cli"] == "claude" && shown["member_count"] == 0);
    assert!(
        Path::new(&a.folder).is_dir()
            && Path::new(&a.folder).parent() == Some(common::folder().join("accounts").as_path())
    );
    assert_eq!(a.created_by.as_deref(), Some("user"));
    // not signed in until the CLI says so
    assert_eq!(check(&a.id).await.status, "needs_sign_in");
    login(&a, "an@work.example");
    let done = check(&a.id).await;
    assert!(done.status == "signed_in" && done.email.as_deref() == Some("an@work.example"));
    assert_eq!(done.plan.as_deref(), Some("max"));
    assert_eq!(
        (done.method.as_deref(), done.status_detail.as_deref()),
        (Some("subscription"), Some("signed in (claude.ai, max)"))
    );
    let session = database::session();
    assert_eq!(accounts::rename(&session, &a.id, "  Main ").await.expect("rename").name, "Main");
    let listing = accounts::list_all(&session).await.expect("list");
    assert_eq!(listing.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["Main"]);
    let clis = accounts::cli_cards().await;
    assert_eq!(clis.iter().map(|x| x["cli"].as_str().expect("cli")).collect::<Vec<_>>(), ["claude"]);
    assert!(clis[0]["found"] == true && clis[0]["runnable"] == true && clis[0]["unavailable"].is_null());
    assert_eq!(signin::pty_available(), cfg!(unix)); // "terminal" of the listing
    assert!(!signin::console_available());
}

#[tokio::test]
async fn test_names_are_unique_per_computer_and_checked_before_saving() {
    let _lock = fake_cli().await;
    account("Work Claude").await;
    let session = database::session();
    assert_eq!(code(accounts::create(&session, "work claude", "claude", "user").await), "name_taken");
    assert_eq!(code(accounts::create(&session, "  ", "claude", "user").await), "name_required");
    assert_eq!(code(accounts::create(&session, "X", "vim", "user").await), "bad_cli");
    assert_eq!(code(accounts::create(&session, &"x".repeat(61), "claude", "user").await), "name_too_long");
    let other = accounts::create(&session, "Other", "claude", "user").await.expect("another name");
    assert_eq!(code(accounts::rename(&session, &other.id, "WORK  claude").await), "name_taken");
    assert_eq!(accounts::rename(&session, &other.id, "other").await.expect("its own name").name, "other");
    assert_eq!(code(accounts::rename(&session, "acct_none", "Y").await), "not_found");
    assert_eq!(accounts::list_all(&session).await.expect("list").len(), 2);
}

#[tokio::test]
async fn test_other_clis_than_claude_code_are_refused() {
    let _lock = fake_cli().await;
    let session = database::session();
    for other in ["agy", "codex", "opencode"] {
        assert_eq!(code(accounts::create(&session, "Other", other, "user").await), "bad_cli", "{other}");
    }
}

#[tokio::test]
async fn test_a_missing_cli_makes_no_account() {
    let _lock = fake_cli().await;
    cli::set_find_cli_hook(Some(Arc::new(|_binary, _explicit| Some((None, Vec::new())))));
    let session = database::session();
    let refused = accounts::create(&session, "Work", "claude", "user").await;
    match &refused {
        Err(Error::Account(e)) => assert_eq!(e.message, "“claude” was not found on this computer."),
        _ => panic!("not refused"),
    }
    assert_eq!(code(refused), "cli_missing");
    assert!(accounts::list_all(&session).await.expect("list").is_empty());
    assert!(accounts::cli_cards().await[0]["found"] == false);
    cli::set_find_cli_hook(None);
}

#[tokio::test]
async fn test_sign_out_keeps_the_account_and_forgets_the_login() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    login(&a, "an@work.example");
    check(&a.id).await;
    let session = database::session();
    let out = accounts::sign_out(&session, &a.id).await.expect("sign out");
    assert!(out.status == "needs_sign_in" && out.email.is_none());
    assert_eq!(out.status_detail.as_deref(), Some("Signed out"));
    assert!(!Path::new(&a.folder).join(".fake-login").exists());
    assert_eq!(accounts::list_all(&session).await.expect("list").len(), 1);
}

// --------------------------------------------------------------------------- members on an account

async fn removing(policy: &str, expect_other: bool, expect_paused: bool) {
    let _lock = fake_cli().await;
    let (pid, _) = common::project().await;
    let a = account("Gone").await;
    let other = account("Other").await;
    let opts = common::TeamOpts { account_id: Some(a.id.clone()), ..common::TeamOpts::default() };
    let (m, _) = common::team(&pid, "Claude Code · Backend", opts).await;
    let session = database::session();
    let other_id = (policy == "other").then_some(other.id.as_str());
    assert_eq!(accounts::remove(&session, &a.id, policy, other_id).await.expect("remove"), 1); // members_moved
    assert!(!Path::new(&a.folder).exists());
    let after = team_row(&m.id).await;
    assert_eq!(after.account_id, expect_other.then(|| other.id.clone()));
    assert_eq!(after.paused, expect_paused);
    if expect_paused {
        assert_eq!(after.paused_reason.as_deref(), Some("Account Gone was removed: choose an account"));
    }
    let names: Vec<String> = accounts::list_all(&session).await.expect("list").into_iter().map(|x| x.name).collect();
    assert_eq!(names, ["Other"]);
}

#[tokio::test]
async fn test_removing_an_account_says_what_happens_to_its_members_login() {
    removing("login", false, false).await;
}

#[tokio::test]
async fn test_removing_an_account_says_what_happens_to_its_members_other() {
    removing("other", true, false).await;
}

#[tokio::test]
async fn test_removing_an_account_says_what_happens_to_its_members_none() {
    removing("none", false, true).await;
}

#[tokio::test]
async fn test_removing_to_a_missing_or_foreign_account_is_refused() {
    let _lock = fake_cli().await;
    let (pid, _) = common::project().await;
    let a = account("A").await;
    common::team(
        &pid,
        "Claude Code · Backend",
        common::TeamOpts { account_id: Some(a.id.clone()), ..common::TeamOpts::default() },
    )
    .await;
    let session = database::session();
    assert_eq!(code(accounts::remove(&session, &a.id, "other", None).await), "other_required");
    assert_eq!(code(accounts::remove(&session, &a.id, "other", Some(&a.id)).await), "other_required");
    assert_eq!(code(accounts::remove(&session, &a.id, "other", Some("acct_nope")).await), "not_found");
    assert_eq!(code(accounts::remove(&database::session(), &a.id, "away", None).await), "members");
    assert!(Path::new(&a.folder).exists());
    // an account nobody uses goes whatever the choice says
    let free = account("Free").await;
    assert_eq!(accounts::remove(&database::session(), &free.id, "away", None).await.expect("remove"), 0);
}

// --------------------------------------------------------------------------- the sign-in terminal

/// Collect messages until `until(msg)` is true; returns (text so far, last state) (`_drain`).
async fn drain(q: &Queue, until: impl Fn(&Value) -> bool) -> (String, Value) {
    let (mut text, mut state) = (String::new(), Value::Null);
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), q.get()).await.expect("a message in time");
        if msg["type"] == "out" {
            text += msg["data"].as_str().expect("data");
        } else {
            state = msg.clone();
        }
        if until(&msg) {
            return (text, state);
        }
    }
}

fn wants_code(m: &Value) -> bool {
    m["type"] == "state" && m["phase"] == "paste_code"
}

fn says_signed_in(m: &Value) -> bool {
    m["type"] == "state" && m["signed_in"] == true
}

async fn open(a: &ai_account::Model) -> Arc<SignIn> {
    let s = signin::start(&stored(&a.id).await, "user", 80, 24).await.expect("the terminal opens");
    assert!(!s.console);
    s
}

#[tokio::test]
async fn test_sign_in_in_a_terminal_ends_signed_in_when_the_cli_says_so() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    let started = open(&a).await;
    let s = signin::active(&a.id).expect("an open sign-in");
    assert!(Arc::ptr_eq(&s, &started));
    assert_eq!(s.argv[1..], ["auth", "login", "--claudeai"]);
    let listing = accounts::to_dict(&stored(&a.id).await, None, signin::signing_in_by(&a.id).as_deref()).expect("dict");
    assert!(listing["status"] == "signing_in" && listing["signing_in_by"] == "user"); // one sign-in per account at a time
    match signin::start(&stored(&a.id).await, "someone else", 80, 24).await {
        Err(signin::Error::Busy(busy)) => {
            assert_eq!((busy.by.as_str(), busy.to_string().as_str()), ("user", "user is signing in to this account"))
        }
        _ => panic!("a second sign-in was not refused"),
    }
    let q = signin::attach(&s);
    let (text, _) = drain(&q, wants_code).await;
    assert!(text.contains("claude.example/oauth"));
    signin::write(&s, "good\n"); // what the person pastes
    let (_, state) = drain(&q, says_signed_in).await;
    assert_eq!(state["account"]["status"], "signed_in");
    assert_eq!(state["account"]["email"], "an@work.example");
    common::until("the CLI ends by itself", 10.0, || signin::active(&a.id).is_none()).await;
    assert_eq!(stored(&a.id).await.status, "signed_in");
    assert_eq!((s.ended().as_deref(), s.exit_code(), s.poll()), (Some("exited"), Some(0), Some(0)));
}

#[tokio::test]
async fn test_a_rejected_code_saves_nothing() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    let s = open(&a).await;
    let q = signin::attach(&s);
    drain(&q, wants_code).await;
    signin::write(&s, "bad\n");
    let (_, state) = drain(&q, |m| m["type"] == "state" && m["ended"] == "exited").await;
    assert!(state["exit_code"] == 1 && state["signed_in"] == false);
    assert!(state["running"] == false);
    assert_eq!(stored(&a.id).await.status, "needs_sign_in");
}

#[tokio::test]
async fn test_cancel_stops_the_cli_and_marks_nothing() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    let s = open(&a).await;
    let pid = s.pid().expect("the login's pid");
    assert!(common::alive(pid));
    signin::stop(&s, "cancelled").await; // DELETE /ai/accounts/{id}/signin
    common::until("the login's exit", 10.0, || s.poll().is_some()).await;
    assert!(signin::active(&a.id).is_none() && signin::session(&a.id).is_none());
    assert!(!common::alive(pid));
    assert_eq!(s.ended().as_deref(), Some("cancelled"));
    assert_eq!(stored(&a.id).await.status, "needs_sign_in");
    // what is typed after the end goes nowhere
    signin::write(&s, "good\n");
    signin::resize(&s, 100, 30);
}

#[tokio::test]
async fn test_the_login_runs_in_the_accounts_own_folder_not_the_one_on_this_computer() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    let s = open(&a).await;
    let q = signin::attach(&s);
    drain(&q, wants_code).await;
    signin::resize(&s, 120, 40);
    signin::resize(&s, 5, 2); // refused sizes change nothing
    signin::write(&s, "good\n");
    drain(&q, says_signed_in).await;
    assert!(Path::new(&a.folder).join(".fake-login").is_file());
    assert!(!common::folder().join("claude-config").join(".fake-login").exists());
}

#[tokio::test]
async fn test_without_a_pseudo_terminal_the_window_gets_the_command_to_run_itself() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    signin::set_pty(Some(false));
    match signin::start(&a, "user", 80, 24).await {
        Err(signin::Error::Pty(why)) => assert_eq!(why.to_string(), "No pseudo-terminal on this platform"),
        _ => panic!("no fallback"),
    }
    let command = signin::fallback_command(&a).await.expect("the command"); // "mode": "fallback"
    assert!(command.contains(&format!("CLAUDE_CONFIG_DIR={}", a.folder)) || command.contains(&a.folder));
    assert!(command.contains("auth login --claudeai"));
    assert!(signin::active(&a.id).is_none());
    // and the same bar polls the CLI until it reports signed in
    login(&a, "an@work.example");
    assert_eq!(check(&a.id).await.status, "signed_in");
}

#[tokio::test]
async fn test_on_windows_the_sign_in_opens_in_a_console_window_of_its_own() {
    // Windows has no pseudo-terminal: the login opens in its own console window (the account's folder in its
    // environment), the board asks the CLI until it is signed in, and the command is there in case no window appears.
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    signin::set_pty(Some(false));
    signin::set_console(Some(true));
    let opened: Arc<Mutex<Option<(Vec<String>, Vec<(String, String)>)>>> = Arc::default();
    let seen = opened.clone();
    signin::set_open_console(Some(Arc::new(move |argv, cwd, env| {
        // the person answers in the window that opened
        *seen.lock().expect("lock") = Some((argv.to_vec(), env.clone()));
        let mut proc = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(cwd)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k, v)))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()?;
        let mut stdin = proc.stdin.take().expect("stdin");
        stdin.write_all(b"good\n")?;
        stdin.flush()?;
        Ok(proc)
    })));
    assert!(signin::console_available()); // "console" of the listing
    let s = signin::start(&a, "user", 80, 24).await.expect("the console opens");
    assert!(s.console); // "mode": "console"
    assert!(signin::fallback_command(&a).await.expect("the command").contains("auth login --claudeai"));
    let (argv, env) = opened.lock().expect("lock").clone().expect("the window was opened");
    assert_eq!(argv[1..], ["auth", "login", "--claudeai"]);
    assert_eq!(env.iter().find(|(k, _)| k == "CLAUDE_CONFIG_DIR").map(|(_, v)| v.as_str()), Some(a.folder.as_str()));
    let s = signin::session(&a.id).unwrap_or(s);
    common::until("the board asks the CLI after the login ended", 10.0, || s.signed_in()).await;
    assert!(s.ended().as_deref() == Some("exited") && s.exit_code() == Some(0));
    assert_eq!(stored(&a.id).await.status, "signed_in");
}

#[tokio::test]
async fn test_cancelling_a_sign_in_in_a_console_window_closes_it() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    signin::set_pty(Some(false));
    signin::set_console(Some(true));
    signin::set_open_console(Some(Arc::new(|argv, cwd, env| {
        use std::os::unix::process::CommandExt;
        std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(cwd)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k, v)))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .process_group(0)
            .spawn()
    })));
    signin::start(&a, "user", 80, 24).await.expect("the console opens");
    let s = signin::active(&a.id).expect("an open sign-in");
    assert!(s.console);
    let pid = s.pid().expect("pid");
    signin::stop(&s, "cancelled").await;
    common::until("the window's exit", 10.0, || s.poll().is_some()).await;
    assert!(!common::alive(pid));
    assert_eq!(stored(&a.id).await.status, "needs_sign_in");
}

#[tokio::test]
async fn test_a_window_that_cannot_open_falls_back_to_the_command() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    signin::set_pty(Some(false));
    signin::set_console(Some(true));
    signin::set_open_console(Some(Arc::new(|_argv, _cwd, _env| Err(std::io::Error::other("no console")))));
    match signin::start(&a, "user", 80, 24).await {
        Err(signin::Error::Pty(why)) => assert_eq!(why.to_string(), "Could not open a window for the CLI (no console)"),
        _ => panic!("no fallback"),
    }
    assert!(signin::fallback_command(&a).await.expect("the command").contains("auth login --claudeai"));
    assert!(signin::active(&a.id).is_none());
}

#[tokio::test]
async fn test_the_same_login_added_twice_is_noticed_for_claude() {
    let _lock = fake_cli().await;
    let first = account("Work Claude").await;
    login(&first, "an@work.example");
    check(&first.id).await;
    let second = account("Copy").await;
    login(&second, "AN@work.example");
    let s = SignIn::new(&second.id, "user", vec!["x".to_string()]);
    signin::check(&s).await.expect("check");
    assert!(s.signed_in() && s.duplicate_of().as_deref() == Some("Work Claude"));
    assert_eq!(s.account().expect("the account")["email"], "AN@work.example");
}

#[tokio::test]
async fn test_the_fallback_command_names_the_accounts_folder() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    let command = signin::fallback_command(&a).await.expect("the command");
    assert!(command.contains(&a.folder) && command.trim_end().ends_with("auth login --claudeai"));
    assert_eq!(command, format!("CLAUDE_CONFIG_DIR={} claude auth login --claudeai", a.folder));
}

#[tokio::test]
async fn test_a_sign_in_whose_window_was_closed_is_stopped() {
    let _lock = fake_cli().await;
    signin::set_timing(Some(signin::Timing { poll_s: 0.2, orphan_s: 0.3, ..signin::Timing::default() }));
    let a = account("Work Claude").await;
    let s = open(&a).await;
    let q = signin::attach(&s);
    signin::detach(&s, &q); // the tab was closed
    common::until("the orphan is stopped", 10.0, || signin::active(&a.id).is_none()).await;
    assert_eq!(s.ended().as_deref(), Some("cancelled"));
    // the process is told to stop and exits a moment later, on a busy machine not at once
    common::until("the login's exit", 10.0, || s.poll().is_some()).await;
    // a window that comes back in time keeps it
    let s = open(&a).await;
    signin::detach(&s, &signin::attach(&s));
    signin::attach(&s);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(signin::active(&a.id).is_some_and(|open| Arc::ptr_eq(&open, &s)));
    let pid = s.pid().expect("pid");
    signin::stop(&s, "cancelled").await;
    common::until("the login's exit", 10.0, || !common::alive(pid)).await;
}

#[tokio::test]
async fn test_signing_in_again_to_a_signed_in_account_waits_for_the_login_to_end() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    login(&a, "an@work.example");
    check(&a.id).await;
    let s = open(&a).await;
    assert!(s.was_signed_in);
    signin::check(&s).await.expect("check");
    assert!(!s.signed_in()); // the status said "signed in" before the CLI even asked for a code
    let q = signin::attach(&s);
    drain(&q, wants_code).await;
    signin::write(&s, "good\n");
    drain(&q, says_signed_in).await;
    signin::stop(&s, "cancelled").await;
}

// --------------------------------------------------------------------------- not in the Python file

/// "Done" (`POST .../signin/done`): the CLI is stopped while it still asks, and asked once more who is signed in.
#[tokio::test]
async fn done_stops_the_cli_and_asks_it_once_more() {
    let _lock = fake_cli().await;
    let a = account("Work Claude").await;
    login(&a, "an@work.example");
    check(&a.id).await;
    let s = open(&a).await;
    let q = signin::attach(&s);
    drain(&q, wants_code).await;
    let pid = s.pid().expect("pid");
    signin::stop(&s, "done").await;
    assert!(
        s.ended().as_deref() == Some("done") && s.signed_in(),
        "the person said it is done, and the CLI says signed in"
    );
    let (_, state) = drain(&q, |m| m["type"] == "state" && m["ended"] == "done").await;
    assert!(state["running"] == false && state["exit_code"].is_null());
    common::until("the login's exit", 10.0, || !common::alive(pid)).await;
    assert!(signin::session(&a.id).is_none());
}

/// The board is closing: every open sign-in is stopped, and a late window gets what the terminal showed so far.
#[tokio::test]
async fn stop_all_leaves_no_login_running_and_a_late_window_replays_the_terminal() {
    let _lock = fake_cli().await;
    let (a, b) = (account("One").await, account("Two").await);
    let (sa, sb) = (open(&a).await, open(&b).await);
    let first = signin::attach(&sa);
    drain(&first, wants_code).await;
    // a second window attaches late: the output so far, then the state
    let late = signin::attach(&sa);
    let replay = late.get_nowait().expect("the output so far");
    assert!(
        replay["type"] == "out" && replay["data"].as_str().expect("data").contains("Opening your browser to sign in…")
    );
    let state = late.get_nowait().expect("the state");
    assert!(state["type"] == "state" && state["phase"] == "paste_code" && state["running"] == true);
    assert_eq!(state["url"], "https://claude.example/oauth/authorize?code=true&client_id=x");
    assert!(late.get_nowait().is_none());
    let pids = [sa.pid().expect("pid"), sb.pid().expect("pid")];
    signin::stop_all().await;
    assert!(signin::active(&a.id).is_none() && signin::active(&b.id).is_none());
    for pid in pids {
        common::until("a login's exit", 10.0, || !common::alive(pid)).await;
    }
}

/// `check_all`, `mark_signed_out` and `follow`: the members of an account follow its sign-in.
#[tokio::test]
async fn members_follow_the_sign_in_of_their_account() {
    let _lock = fake_cli().await;
    let (pid, _) = common::project().await;
    let (pid2, _) = common::project().await;
    let a = account("Work").await;
    let b = account("Home").await;
    let on = |id: &str| common::TeamOpts { account_id: Some(id.to_string()), ..common::TeamOpts::default() };
    let (m1, _) = common::team(&pid, "Backend", on(&a.id)).await;
    let (m2, _) = common::team(&pid2, "Frontend", on(&a.id)).await;
    let (m3, _) = common::team(&pid, "Docs", common::TeamOpts::default()).await;
    let session = database::session();
    // both accounts are signed out: their members are held, a member on this computer's login is not
    assert_eq!(accounts::check_all(&session, None).await.expect("check all"), 0, "nothing changed state");
    assert_eq!(team_row(&m1.id).await.health, "not_logged_in");
    assert_eq!(team_row(&m1.id).await.health_detail.as_deref(), Some("The account Work needs to sign in."));
    assert_eq!(team_row(&m3.id).await.health, "unknown");
    // one signs in: checked again, its members are free
    login(&a, "an@work.example");
    assert_eq!(accounts::check_all(&session, None).await.expect("check all"), 1);
    assert_eq!((team_row(&m1.id).await.health.as_str(), team_row(&m2.id).await.health.as_str()), ("ok", "ok"));
    assert!(team_row(&m1.id).await.health_detail.is_none());
    // checked a moment ago: skipped
    std::fs::remove_file(Path::new(&a.folder).join(".fake-login")).expect("signed out behind the board's back");
    assert_eq!(accounts::check_all(&session, Some(3600.0)).await.expect("check all"), 0);
    assert_eq!(stored(&a.id).await.status, "signed_in");
    assert_eq!(accounts::check_all(&session, Some(0.0)).await.expect("check all"), 1, "0 means no limit");
    let found = stored(&a.id).await;
    assert_eq!((found.status.as_str(), found.signed_out_how.as_deref()), ("needs_sign_in", Some("check")));
    assert!(found.signed_out_at.is_some() && found.email.as_deref() == Some("an@work.example"));
    assert_eq!(team_row(&m2.id).await.health, "not_logged_in");
    // a run failed with a sign-in error
    login(&b, "home@work.example");
    let b = check(&b.id).await;
    let marked = accounts::mark_signed_out(&session, b, "run", None).await.expect("mark");
    assert_eq!(
        (marked.status.as_str(), marked.status_detail.as_deref(), marked.signed_out_how.as_deref()),
        ("needs_sign_in", Some("Session expired"), Some("run"))
    );
    let again = accounts::mark_signed_out(&session, marked.clone(), "check", Some("other")).await.expect("mark");
    assert_eq!(again, marked, "already signed out: nothing changes");

    // who uses what
    let counts = accounts::counts(&session, Some(&pid)).await.expect("counts");
    assert_eq!(
        counts.get(&a.id),
        Some(&json!({
            "here": [{"id": m1.id, "name": "Backend", "project_id": pid}],
            "elsewhere": [{"id": m2.id, "name": "Frontend", "project_id": pid2}],
        }))
    );
    assert!(counts.get(&marked.id).is_none());
    let shown = accounts::to_dict(&stored(&a.id).await, counts.get(&a.id), None).expect("dict");
    assert!(shown["member_count"] == 2 && shown["members_here"][0]["name"] == "Backend");
    assert_eq!(accounts::config_dir_for_member(&session, &m1.id).await.expect("dir"), Some(a.folder.clone()));
    assert_eq!(accounts::config_dir_for_member(&session, &m3.id).await.expect("dir"), None);
    assert_eq!(accounts::config_dir_for_member(&session, "nobody").await.expect("dir"), None);

    // choosing the account of a member
    assert_eq!(accounts::assign(&session, &m3.id, Some(&a.id)).await.expect("assign").account_id, Some(a.id.clone()));
    assert_eq!(accounts::assign(&session, &m3.id, None).await.expect("assign").account_id, None);
    assert_eq!(code(accounts::assign(&session, "nobody", Some(&a.id)).await), "member_not_found");
    assert_eq!(code(accounts::assign(&session, &m3.id, Some("acct_nope")).await), "not_found");
    let (remote, _) = common::team(
        &pid,
        "Remote",
        common::TeamOpts { connection: Some("remote".into()), ..common::TeamOpts::default() },
    )
    .await;
    assert_eq!(code(accounts::assign(&session, &remote.id, Some(&a.id)).await), "not_local");
    let (codex, _) =
        common::team(&pid, "Codex", common::TeamOpts { provider: Some("codex".into()), ..common::TeamOpts::default() })
            .await;
    match accounts::assign(&session, &codex.id, Some(&a.id)).await {
        Err(Error::Account(e)) => assert_eq!(
            (e.message.as_str(), e.code.as_str()),
            ("Work is an account of Claude Code, not codex.", "wrong_cli")
        ),
        _ => panic!("not refused"),
    }

    // the environment of a run as this account: its folder, and no variable that would override its login
    let base = vec![("PATH".to_string(), "/usr/bin".to_string()), ("ANTHROPIC_API_KEY".to_string(), "k".to_string())];
    let env = accounts::env_for(&stored(&a.id).await, &base).await.expect("env");
    assert_eq!(
        env,
        [("PATH".to_string(), "/usr/bin".to_string()), ("CLAUDE_CONFIG_DIR".to_string(), a.folder.clone())]
    );
    assert_eq!(accounts::binary_of(&stored(&a.id).await).await.expect("binary"), Some(common::fake_cli()));
}

/// The CLI's version is read in the background and shown once it is known (ACC-5).
#[tokio::test]
async fn the_version_of_a_cli_appears_once_it_was_read() {
    let _lock = fake_cli().await;
    accounts::forget_versions();
    assert_eq!(accounts::cli_version(None), None);
    assert_eq!(accounts::cli_version(Some("/no/such/claude")), None);
    assert!(accounts::cli_cards().await[0]["version"].is_null(), "not known yet: the page does not wait");
    let fake = common::fake_cli();
    common::until("the version", 10.0, || accounts::cli_version(Some(&fake)).is_some()).await;
    assert_eq!(accounts::cli_cards().await[0]["version"], "9.9.9");
    // a CLI that gives no version is asked once, then left alone for a while
    let tmp = common::tmp_path("mute");
    let mute = common::script(&tmp, "claude", &format!("echo started >> {}/asked; exit 1", tmp.display()), true);
    let mute = mute.to_string_lossy().into_owned();
    assert_eq!(accounts::cli_version(Some(&mute)), None);
    common::until("the first try", 10.0, || tmp.join("asked").exists()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(accounts::cli_version(Some(&mute)), None);
    assert_eq!(std::fs::read_to_string(tmp.join("asked")).expect("asked"), "started\n", "asked once");
    accounts::forget_versions();
}

// Left for the task that ports `api/ai_accounts.py` (they are about the routes themselves):
// - test_who_can_change_accounts (403 for a request that is not from this computer)
// - test_the_terminal_only_talks_to_pages_of_this_computer (`_origin_ok` of the WebSocket)
// - the HTTP sides of the tests above: status codes (201, 409, 422, 404), the `detail` objects, `GET /ai/accounts`
//   (`accounts`, `clis`, `platform`, `terminal`, `console`), `GET /ai/accounts/name-check`, `PUT /ai/teams/{id}/account`,
//   `GET /ai/accounts-on-this-computer`, `{"mode": "terminal" | "console" | "fallback"}`, `touches.record_signin`.
