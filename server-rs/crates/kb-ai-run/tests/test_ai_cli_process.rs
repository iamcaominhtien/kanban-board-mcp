//! Starting, reading, pausing and stopping the CLI (`services/ai/cli.py`: `CliProcess`, `kill_tree`, `suspend_tree`,
//! `looks_like_cli`, `run_capture`, `detect`, `session_exists`), against the stand-in CLI. The Python suite checks
//! these through whole runs (`test_ai_runs_v2.py`, `test_ai_stop_v2.py`..., which wait for `runs`); these tests check
//! the same behaviour on the process itself, and that nothing a test starts is left running.
#![cfg(unix)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use kb_ai_run::cli::{self, CliProcess};
use kb_ai_run::stream::Parser;
use serde_json::Value;

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn pid_in(file: &std::path::Path) -> Option<i32> {
    std::fs::read_to_string(file).ok()?.trim().parse().ok()
}

async fn next(proc: &CliProcess, seconds: f64) -> Option<String> {
    let mut lines = proc.lines();
    tokio::time::timeout(Duration::from_secs_f64(seconds), lines.next()).await.ok()?.expect("a readable pipe")
}

async fn all_lines(proc: &CliProcess) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(line) = next(proc, 20.0).await {
        out.push(line);
    }
    out
}

async fn gone(what: &str, pid: i32) {
    common::until(what, 8.0, || !common::alive(pid)).await;
}

#[tokio::test]
async fn a_run_is_read_line_by_line_and_ends_with_its_exit_code() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let config = common::tmp_path("config");
    let env = common::fake_env("v2", &[("CLAUDE_CONFIG_DIR", &config.to_string_lossy())]);
    let proc =
        CliProcess::new(common::stream_args("Fix add()", "sess-1"), &repo.to_string_lossy(), Some(env), true, None);
    assert!(proc.pid().is_none() && proc.returncode().is_none() && !proc.running() && !proc.live);
    assert!(proc.wait().await.is_err(), "not started yet");
    let pid = proc.start().await.expect("start");
    assert!(pid > 0 && proc.pid() == Some(pid) && proc.running());
    let mut parser = Parser::new(&repo.to_string_lossy(), None);
    let (mut kinds, mut result, mut session) = (Vec::new(), None, Value::Null);
    for line in all_lines(&proc).await {
        let parsed = parser.parse(&line).expect("a line the parser takes");
        kinds.extend(parsed.rows.iter().map(|r| r["kind"].as_str().expect("kind").to_string()));
        if parsed.ready {
            session = parsed.session_id.clone();
        }
        result = parsed.result.or(result);
    }
    assert_eq!(proc.wait().await.expect("wait"), 0);
    assert!(proc.returncode() == Some(0) && !proc.running());
    assert_eq!(session, "sess-1");
    assert_eq!(kinds, ["edit", "command", "command", "subagent", "command", "text", "report"]);
    let result = result.expect("the lead's result");
    assert_eq!(result["structured"]["status"], "done");
    assert_eq!(parser.agent_types.get("v2agent").map(String::as_str), Some("reviewer"));
    assert!(proc.stderr_tail().is_empty());
    // the CLI kept the conversation in the account's folder, and only there
    assert!(cli::session_exists("sess-1", Some(&config.to_string_lossy()), None));
    assert!(!cli::session_exists("sess-2", Some(&config.to_string_lossy()), None));
    assert!(!cli::session_exists("sess-1", None, Some("claude-code")), "the folder of this computer's login");
    assert!(!cli::session_exists("sess-1", Some(&repo.to_string_lossy()), None));
    assert!(!common::alive(pid));
}

#[tokio::test]
async fn stderr_is_kept_redacted_and_the_exit_code_is_the_clis() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let cwd = repo.to_string_lossy().into_owned();
    let proc = CliProcess::new(common::stream_args("x", "s"), &cwd, Some(common::fake_env("crash", &[])), true, None);
    proc.start().await.expect("start");
    let lines = all_lines(&proc).await;
    assert_eq!(lines.len(), 1, "the init line");
    assert_eq!(proc.wait().await.expect("wait"), 139);
    common::until("stderr", 5.0, || !proc.stderr_tail().is_empty()).await;
    assert_eq!(proc.stderr_tail(), ["Segmentation fault (core dumped)"]);

    let secret = format!("sk-ant-{}", "a1b2c3d4e5f6");
    let noisy = common::script(
        &repo,
        "noisy.sh",
        &format!(
            "i=0; while [ $i -lt 25 ]; do echo \"line $i   \" >&2; i=$((i+1)); done; echo >&2; echo \"key {secret}\" >&2; exit 7"
        ),
        true,
    );
    let proc = CliProcess::new(args(&[&noisy.to_string_lossy()]), &cwd, None, true, None);
    proc.start().await.expect("start");
    assert!(all_lines(&proc).await.is_empty());
    assert_eq!(proc.wait().await.expect("wait"), 7);
    common::until("the last line", 5.0, || proc.stderr_tail().last().is_some_and(|l| l.starts_with("key"))).await;
    let tail = proc.stderr_tail();
    assert_eq!(tail.len(), 20, "the last 20 lines");
    assert_eq!((tail[0].as_str(), tail[18].as_str(), tail[19].as_str()), ("line 6", "line 24", "key sk-••••"));

    // a program that is not there is an error, and leaves nothing behind
    let proc = CliProcess::new(
        args(&["/no/such/claude", "-p", &"x".repeat(400), "--system-prompt", "rules"]),
        &cwd,
        None,
        true,
        None,
    );
    let mut proc = proc;
    proc.max_command_chars = Some(100);
    assert!(proc.start().await.is_err());
    assert!(proc.temp().is_none() && proc.pid().is_none());
}

#[tokio::test]
async fn a_live_cli_takes_messages_until_its_input_is_closed() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let proc = CliProcess::new(
        common::live_args("live-1"),
        &repo.to_string_lossy(),
        Some(common::fake_env("finish", &[])),
        true,
        Some("Fix add()".to_string()),
    );
    proc.start().await.expect("start");
    assert!(proc.live && proc.input_open());
    let result_of = |line: &str| -> Option<String> {
        let ev: Value = serde_json::from_str(line).ok()?;
        (ev["type"] == "result").then(|| ev["result"].as_str().unwrap_or("").to_string())
    };
    let mut first = None;
    while first.is_none() {
        first = result_of(&next(&proc, 10.0).await.expect("the first turn"));
    }
    assert_eq!(first.as_deref(), Some("Fixed add(); tests pass."));
    assert!(proc.running(), "it waits for the next message");
    assert!(proc.send("Cũng sửa tài liệu ✓").await);
    let mut second = None;
    while second.is_none() {
        second = result_of(&next(&proc, 10.0).await.expect("the second turn"));
    }
    assert_eq!(second.as_deref(), Some("Got it: Cũng sửa tài liệu ✓"));
    proc.end_input();
    assert!(!proc.input_open() && !proc.send("too late").await);
    assert_eq!(next(&proc, 10.0).await, None);
    assert_eq!(proc.wait().await.expect("wait"), 0);

    // a CLI that is not live takes no message
    let once = CliProcess::new(
        common::stream_args("x", "s"),
        &repo.to_string_lossy(),
        Some(common::fake_env("finish", &[])),
        true,
        None,
    );
    assert!(!once.send("hello").await);
    once.start().await.expect("start");
    assert!(!once.send("hello").await && !once.input_open());
    once.end_input();
    let _ = all_lines(&once).await;
    assert_eq!(once.wait().await.expect("wait"), 0);
}

#[tokio::test]
async fn kill_stops_the_cli_and_what_it_started() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let pidfile = repo.join("child.pid");
    let env = common::fake_env("spawn", &[("FAKE_CLAUDE_PIDFILE", &pidfile.to_string_lossy())]);
    let proc = CliProcess::new(common::stream_args("x", "s"), &repo.to_string_lossy(), Some(env), true, None);
    let pid = proc.start().await.expect("start");
    assert!(next(&proc, 10.0).await.is_some() && next(&proc, 10.0).await.is_some());
    let child = pid_in(&pidfile).expect("the pid of what the CLI started");
    assert!(common::alive(pid) && common::alive(child));
    proc.kill();
    assert_eq!(proc.wait().await.expect("wait"), -15, "ended by SIGTERM");
    gone("the CLI's child", child).await;
    assert!(!common::alive(pid) && !proc.running());
    proc.kill(); // a second time, on a CLI that is gone: nothing happens
    // safe on nothing and on a pid that is gone
    cli::kill_tree(None);
    cli::kill_tree(Some(0));
    cli::kill_tree(Some(pid));
    assert!(!cli::suspend_tree(None, true) && !cli::suspend_tree(Some(pid), true));
}

#[tokio::test]
async fn what_ignores_sigterm_is_killed_after_the_grace() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let stubborn = common::script(&repo, "stubborn.sh", "trap '' TERM\necho ready\nwhile :; do sleep 1; done", true);
    assert_eq!(cli::kill_grace(), 2.0);
    cli::set_kill_grace(0.3);
    let proc = CliProcess::new(args(&[&stubborn.to_string_lossy()]), &repo.to_string_lossy(), None, true, None);
    let pid = proc.start().await.expect("start");
    assert_eq!(next(&proc, 10.0).await.as_deref(), Some("ready"));
    let asked = std::time::Instant::now();
    proc.kill();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(common::alive(pid), "SIGTERM alone does not end it");
    assert_eq!(proc.wait().await.expect("wait"), -9, "ended by SIGKILL");
    assert!(asked.elapsed() >= Duration::from_millis(280) && asked.elapsed() < Duration::from_secs(5));
    cli::set_kill_grace(2.0);
    gone("the stubborn script", pid).await;
}

#[tokio::test]
async fn a_paused_cli_stops_printing_and_goes_on_when_resumed() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let proc = CliProcess::new(
        common::stream_args("x", "s"),
        &repo.to_string_lossy(),
        Some(common::fake_env("ticks", &[])),
        true,
        None,
    );
    let pid = proc.start().await.expect("start");
    assert!(cli::can_pause());
    let tick = |line: &str| line.contains("tick ");
    while !tick(&next(&proc, 10.0).await.expect("a tick")) {}
    assert!(cli::suspend_tree(Some(pid), true));
    // what was already in the pipe may still arrive; then nothing for much longer than a tick takes
    let mut late = 0;
    while next(&proc, 1.0).await.is_some() {
        late += 1;
        assert!(late <= 3, "a paused CLI went on printing");
    }
    assert!(proc.running());
    assert!(cli::suspend_tree(Some(pid), false));
    assert!(tick(&next(&proc, 5.0).await.expect("a tick after the pause")));
    // a paused run is woken to see the SIGTERM
    assert!(cli::suspend_tree(Some(pid), true));
    proc.kill();
    assert_eq!(proc.wait().await.expect("wait"), -15);
    gone("the paused CLI", pid).await;
}

#[tokio::test]
async fn wait_ends_what_the_cli_left_running() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    // it answers and exits, but a server it started in the background is still there
    let leaves = common::script(&repo, "leaves.sh", "sleep 300 &\necho $! > left.pid\necho done", true);
    let proc = CliProcess::new(args(&[&leaves.to_string_lossy()]), &repo.to_string_lossy(), None, true, None);
    let pid = proc.start().await.expect("start");
    assert_eq!(next(&proc, 10.0).await.as_deref(), Some("done"));
    common::until("the script's exit", 10.0, || proc.returncode().is_some()).await;
    let left = pid_in(&repo.join("left.pid")).expect("the pid of what was left");
    assert!(common::alive(left), "left running by the CLI");
    assert_eq!(proc.wait().await.expect("wait"), 0);
    gone("what the CLI left running", left).await;
    assert!(!common::alive(pid));
}

#[tokio::test]
async fn a_cli_nobody_holds_any_more_is_stopped() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let cwd = repo.to_string_lossy().into_owned();
    // dropped while it runs
    let proc = CliProcess::new(common::stream_args("x", "s"), &cwd, Some(common::fake_env("sleep", &[])), true, None);
    let pid = proc.start().await.expect("start");
    assert!(next(&proc, 10.0).await.is_some());
    drop(proc);
    gone("a dropped CLI", pid).await;

    // the task that ran it is cancelled
    let (tell, told) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let proc =
            CliProcess::new(common::stream_args("x", "s"), &cwd, Some(common::fake_env("silent", &[])), true, None);
        let pid = proc.start().await.expect("start");
        let _ = tell.send(pid);
        while next(&proc, 60.0).await.is_some() {}
        proc.wait().await
    });
    let pid = told.await.expect("the pid");
    assert!(common::alive(pid));
    task.abort();
    gone("the CLI of a cancelled task", pid).await;

    // a wait that is given up ends the CLI's group, as Python's `finally` does
    let repo = common::tmp_path("repo");
    let proc = CliProcess::new(
        common::stream_args("x", "s"),
        &repo.to_string_lossy(),
        Some(common::fake_env("silent", &[])),
        true,
        None,
    );
    let pid = proc.start().await.expect("start");
    assert!(tokio::time::timeout(Duration::from_millis(200), proc.wait()).await.is_err());
    gone("the CLI of a wait that was given up", pid).await;
    assert_eq!(proc.wait().await.expect("wait"), -15);
}

#[tokio::test]
async fn run_capture_gives_the_code_and_the_output_and_stops_what_takes_too_long() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let fake = common::fake_cli();
    let got = cli::run_capture(&args(&[&fake, "--version"]), 20.0, None, None).await.expect("run");
    assert_eq!(got, (0, "9.9.9 (Claude Code)\n".to_string(), String::new()));
    let fails = common::script(&repo, "fails.sh", "pwd; echo \"$ONLY\"; printf 'bad \\377 byte' >&2; exit 3", true);
    let env = vec![("ONLY".to_string(), "this".to_string()), ("PATH".to_string(), "/usr/bin:/bin".to_string())];
    let cwd = repo.to_string_lossy().into_owned();
    let (code, out, err) =
        cli::run_capture(&args(&[&fails.to_string_lossy()]), 20.0, Some(&cwd), Some(&env)).await.expect("run");
    assert_eq!((code, out.as_str(), err.as_str()), (3, format!("{cwd}\nthis\n").as_str(), "bad \u{fffd} byte"));
    assert!(cli::run_capture(&args(&["/no/such/program"]), 5.0, None, None).await.is_err());
    assert!(cli::run_capture(&[], 5.0, None, None).await.is_err());

    // too slow: the whole tree is stopped and the answer says so
    let pidfile = repo.join("hang.pid");
    let mut env = common::fake_env("finish", &[("FAKE_CLAUDE_JSON_HANG", &pidfile.to_string_lossy())]);
    env.retain(|(k, _)| k != "CLAUDE_CONFIG_DIR");
    let one_shot = args(&[&fake, "-p", "ping", "--output-format", "json"]);
    let got = cli::run_capture(&one_shot, 1.5, None, Some(&env)).await.expect("run");
    assert_eq!(got, (-1, String::new(), "Timed out after 1 s".to_string()));
    let pid = pid_in(&pidfile).expect("the pid of the command");
    assert!(!common::alive(pid), "reaped before the call returned");

    // given up by the caller: stopped too
    std::fs::remove_file(&pidfile).expect("remove");
    let call = cli::run_capture(&one_shot, 60.0, None, Some(&env));
    assert!(tokio::time::timeout(Duration::from_millis(800), call).await.is_err());
    let pid = pid_in(&pidfile).expect("the pid of the command");
    gone("a command whose caller gave up", pid).await;
}

#[tokio::test]
async fn detect_says_whether_the_cli_is_there_and_who_is_signed_in() {
    let _lock = common::init().await;
    let fake = common::fake_cli();
    let info = cli::detect("claude-code", "claude", None, None).await.expect("detect");
    assert_eq!(
        Value::Object(info),
        serde_json::json!({
            "found": true,
            "path": fake,
            "checked": ["PATH"],
            "version": "9.9.9 (Claude Code)",
            "logged_in": true,
            "account": "subscription login",
        })
    );
    let out = common::fake_env("logged_out", &[]);
    let info = cli::detect("claude-code", "claude", None, Some(&out)).await.expect("detect");
    assert!(info["logged_in"] == false && info["account"] == "subscription login");
    // an account's environment: the answer is about that account's login
    let folder = common::tmp_path("account");
    let account =
        common::fake_env("finish", &[("FAKE_CLAUDE_ACCOUNTS", "1"), ("CLAUDE_CONFIG_DIR", &folder.to_string_lossy())]);
    let info = cli::detect("claude-code", "claude", None, Some(&account)).await.expect("detect");
    assert!(info["logged_in"] == false && info["account"] == "none");
    common::login(&folder.to_string_lossy(), "an@work.example");
    let info = cli::detect("claude-code", "claude", None, Some(&account)).await.expect("detect");
    assert!(info["logged_in"] == true && info["account"] == "an@work.example · Max plan");
    // another provider is not asked who is signed in
    let info = cli::detect("other", "claude", None, None).await.expect("detect");
    assert!(info["version"] == "9.9.9 (Claude Code)" && info["logged_in"].is_null() && info["account"].is_null());
    // a program that answers `auth status` with something else is not a signed-in CLI
    let tmp = common::tmp_path("odd");
    let odd =
        common::script(&tmp, "claude", "if [ \"$1\" = --version ]; then echo; echo 2.0; else echo '[1]'; fi", true);
    let info = cli::detect("claude-code", "claude", Some(&odd.to_string_lossy()), None).await.expect("detect");
    assert!(info["found"] == true && info["version"] == "2.0" && info["logged_in"].is_null());
    // no CLI
    let missing = tmp.join("nope").to_string_lossy().into_owned();
    let info = cli::detect("claude-code", "claude", Some(&missing), None).await.expect("detect");
    assert_eq!(
        Value::Object(info),
        serde_json::json!({"found": false, "path": null, "checked": [missing], "version": null, "logged_in": null, "account": null})
    );
}

/// `runs.RT` as a later task will hold it: what `kb_ai::power` asks about a run's process.
struct Procs;

impl kb_ai_run::seams::RunProcs for Procs {
    fn proc_alive(&self, run_id: &str) -> Option<bool> {
        (run_id == "run-1").then_some(true)
    }
    fn kill_proc(&self, _run_id: &str) {}
    fn has_task(&self, run_id: &str) -> bool {
        run_id == "run-2"
    }
}

#[tokio::test]
async fn looks_like_cli_knows_a_running_cli_from_another_process() {
    let _lock = common::init().await;
    let repo = common::tmp_path("repo");
    let pidfile = repo.join("child.pid");
    let env = common::fake_env("spawn", &[("FAKE_CLAUDE_PIDFILE", &pidfile.to_string_lossy())]);
    let proc = CliProcess::new(common::stream_args("x", "s"), &repo.to_string_lossy(), Some(env), true, None);
    let pid = proc.start().await.expect("start");
    assert!(next(&proc, 10.0).await.is_some() && next(&proc, 10.0).await.is_some());
    let child = pid_in(&pidfile).expect("the child");
    assert!(cli::looks_like_cli(i64::from(pid), None));
    assert!(cli::looks_like_cli(i64::from(pid), Some("claude")));
    assert!(!cli::looks_like_cli(i64::from(pid), Some("codex")));
    assert!(!cli::looks_like_cli(i64::from(child), None), "what the CLI started is not the CLI");
    assert!(!cli::looks_like_cli(i64::from(std::process::id()), None), "this test is not a CLI");

    // the slot of the base crate: `cli` answers for itself, `runs` is asked through `RunProcs` once it is there
    kb_ai_run::register();
    let runtime = kb_ai::seams::runs_runtime().expect("registered");
    assert!(runtime.looks_like_cli(i64::from(pid)) && !runtime.looks_like_cli(i64::from(child)));
    assert!(runtime.proc_alive("run-1").is_none() && !runtime.has_task("run-2"));
    runtime.kill_proc("run-1");
    kb_ai_run::seams::set_run_procs(Some(Arc::new(Procs)));
    assert!(
        runtime.proc_alive("run-1") == Some(true) && runtime.proc_alive("run-2").is_none() && runtime.has_task("run-2")
    );
    kb_ai_run::seams::set_run_procs(None);
    kb_ai::seams::set_runs_runtime(None);

    proc.kill();
    assert_eq!(proc.wait().await.expect("wait"), -15);
    gone("the CLI's child", child).await;
    assert!(!cli::looks_like_cli(i64::from(pid), None), "a pid that is gone");
}

#[tokio::test]
async fn a_process_of_the_boards_own_group_is_stopped_alone() {
    let _lock = common::init().await;
    // started without a group of its own (a program the board did not start through `CliProcess`)
    let mut child = std::process::Command::new("sleep").arg("300").spawn().expect("sleep");
    let pid = i32::try_from(child.id()).expect("pid");
    assert!(!cli::suspend_tree(Some(pid), true), "never stop our own group");
    cli::kill_tree(Some(pid));
    let status = child.wait().expect("wait");
    assert_eq!(std::os::unix::process::ExitStatusExt::signal(&status), Some(9));
    // and this process is still here to say so
    assert!(cli::low_priority_prefix().is_empty() || cfg!(target_os = "macos"));
    let env = cli::child_env(Some(70));
    let value = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    assert_eq!((value("MCP_TOOL_TIMEOUT"), value("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")), (Some("900000"), Some("70")));
    assert_eq!(value("CLAUDECODE"), None);
}
