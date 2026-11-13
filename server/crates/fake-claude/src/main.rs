//! A stand-in for the `claude` CLI used by the AI runner tests. `FAKE_CLAUDE_MODE` picks the behaviour.
//!
//! A port of `server/tests/fixtures/fake_claude.py`, statement by statement and in the same order, so the two can be
//! read side by side; `tests/golden.rs` runs both and compares what they print. Where the Python script ends with an
//! uncaught exception (a missing `--session-id`, a closed stdin at the sign-in prompt) this program prints one line on
//! stderr and exits 1, as Python does after its traceback.

use std::io::{IsTerminal, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio, exit};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fake_claude::pyjson::dumps;
use serde_json::{Map, Value, json};

/// The argument that makes this program the idle child a mode starts (Python: `python -c "import time; time.sleep(300)"`).
const SLEEP_CHILD: &str = "__sleep-child";

/// `os.environ.get(name)`.
fn env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
}

/// `os.environ.get(name)` when it is truthy (set and not empty).
fn env_set(name: &str) -> Option<String> {
    env(name).filter(|v| !v.is_empty())
}

/// `os.environ.get(name, default)`.
fn env_or(name: &str, default: &str) -> String {
    env(name).unwrap_or_else(|| default.to_string())
}

/// What an uncaught Python exception does: a line on stderr, exit code 1.
fn crash(what: &str) -> ! {
    eprintln!("Traceback (most recent call last):\n{what}");
    exit(1)
}

/// `print(text, flush=True)`.
fn print_line(text: &str) {
    let mut out = std::io::stdout().lock();
    if out.write_all(text.as_bytes()).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush()).is_err() {
        // BrokenPipeError: the reader went away
        exit(1);
    }
}

/// `print(json.dumps(obj), flush=True)`.
fn emit(obj: Value) {
    print_line(&dumps(&obj));
}

/// `time.time()`.
fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// `time.sleep(seconds)`.
fn sleep(seconds: f64) {
    if seconds > 0.0 && seconds.is_finite() {
        std::thread::sleep(Duration::from_secs_f64(seconds));
    }
}

/// `float(text)` for the values the tests give; a crash where Python raises `ValueError`.
fn py_float(text: &str) -> f64 {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    match lower.trim_start_matches(['+', '-']) {
        "inf" | "infinity" => return if lower.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY },
        "nan" => return f64::NAN,
        _ => {}
    }
    match t.replace('_', "").parse::<f64>() {
        Ok(f) if !lower.contains("inf") && !lower.contains("nan") => f,
        _ => crash(&format!("ValueError: could not convert string to float: '{text}'")),
    }
}

/// `open(path, "a")` then `write(text)`.
fn append(path: &str, text: &str) {
    let done = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .and_then(|mut fh| fh.write_all(text.as_bytes()));
    if let Err(e) = done {
        crash(&format!("OSError: {e}: '{path}'"));
    }
}

/// `open(path, "w")` then `write(text)`.
fn write(path: &str, text: &str) {
    if let Err(e) = std::fs::write(path, text) {
        crash(&format!("OSError: {e}: '{path}'"));
    }
}

/// `os.getcwd()`.
fn getcwd() -> String {
    std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `os.path.join(a, b)` for a relative `b`.
fn join(a: &str, b: &str) -> String {
    Path::new(a).join(b).to_string_lossy().into_owned()
}

/// `text.splitlines()`: Python also breaks a line at `\r`, `\v`, `\f`, FS, GS, RS, NEL, LS and PS.
fn splitlines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if !matches!(
            c,
            '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}'
        ) {
            continue;
        }
        lines.push(&text[start..i]);
        let mut end = i + c.len_utf8();
        if c == '\r' {
            if let Some(&(j, '\n')) = chars.peek() {
                chars.next();
                end = j + 1;
            }
        }
        start = end;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// `str.strip()` (Python's whitespace: Rust's plus FS, GS, RS and US).
fn strip(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// The idle process a mode starts and leaves running: this program again, sleeping. `tail` is what follows on its
/// command line (the command the AI "ran"), as the Python script appends it after `-c <code>`.
fn spawn_sleeper(tail: &[&str]) -> std::process::Child {
    let exe = std::env::current_exe().unwrap_or_else(|e| crash(&format!("OSError: {e}")));
    Command::new(exe).arg(SLEEP_CHILD).arg("300").args(tail).spawn().unwrap_or_else(|e| crash(&format!("OSError: {e}")))
}

/// `sys.stdin` as the Python script reads it: text lines out of a buffer filled by single reads of up to 8192 bytes,
/// so `select` (which looks at the descriptor, not at the buffer) sees the same thing in both programs.
struct Stdin {
    buffer: Vec<u8>,
    eof: bool,
}

impl Stdin {
    fn new() -> Self {
        Self { buffer: Vec::new(), eof: false }
    }

    /// `sys.stdin.readline()`: a line with its line end, or what is left at the end of input (`""` then).
    fn readline(&mut self) -> String {
        loop {
            if let Some(at) = self.buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=at).collect();
                return String::from_utf8_lossy(&line).into_owned();
            }
            if self.eof {
                let rest = std::mem::take(&mut self.buffer);
                return String::from_utf8_lossy(&rest).into_owned();
            }
            let mut chunk = [0u8; 8192];
            match std::io::stdin().lock().read(&mut chunk) {
                Ok(0) | Err(_) => self.eof = true,
                Ok(n) => self.buffer.extend_from_slice(&chunk[..n]),
            }
        }
    }

    /// `select.select([sys.stdin], [], [], seconds)`: whether the descriptor has something to read (or is at its end).
    #[cfg(unix)]
    fn ready(&self, seconds: f64) -> bool {
        use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
        use std::os::fd::AsFd;
        let stdin = std::io::stdin();
        let mut fds = [PollFd::new(stdin.as_fd(), PollFlags::POLLIN)];
        let millis = u16::try_from((seconds * 1000.0) as u64).unwrap_or(u16::MAX);
        matches!(poll(&mut fds, PollTimeout::from(millis)), Ok(n) if n > 0)
    }

    /// Windows has no `select` on a pipe (the Python script fails there): the next line is simply waited for.
    #[cfg(not(unix))]
    fn ready(&self, _seconds: f64) -> bool {
        true
    }
}

/// `json.loads(line)["message"]["content"][0]["text"]`: `Ok(None)` where Python raises one of the errors the script
/// catches (`ValueError`, `KeyError`, `IndexError`), `Err` where it raises `TypeError`, which the script does not catch.
fn message_text(line: &str) -> Result<Option<Value>, String> {
    let Ok(value) = serde_json::from_str::<Value>(line) else { return Ok(None) };
    let step = |value: &Value, key: &str| -> Result<Option<Value>, String> {
        match value {
            Value::Object(map) => Ok(map.get(key).cloned()),
            _ => Err(format!("TypeError: indices must be integers or slices, not str ({key})")),
        }
    };
    let Some(message) = step(&value, "message")? else { return Ok(None) };
    let Some(content) = step(&message, "content")? else { return Ok(None) };
    let first = match &content {
        Value::Array(items) => match items.first() {
            Some(first) => first.clone(),
            None => return Ok(None),
        },
        // a dict has no key 0 (KeyError)
        Value::Object(_) => return Ok(None),
        Value::String(s) => match s.chars().next() {
            Some(c) => Value::String(c.to_string()),
            None => return Ok(None),
        },
        _ => return Err("TypeError: object is not subscriptable".into()),
    };
    step(&first, "text")
}

/// The prompt as text: the script uses it with `in` and `split`, which need a `str`.
fn text_or_crash(value: Option<Value>) -> String {
    match value {
        None => String::new(),
        Some(Value::String(s)) => s,
        Some(other) => crash(&format!("TypeError: the prompt is not text: {other}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    if args.first().map(String::as_str) == Some(SLEEP_CHILD) {
        sleep(args.get(1).and_then(|s| s.parse().ok()).unwrap_or(300.0));
        return;
    }
    let mut mode = env_or("FAKE_CLAUDE_MODE", "finish");
    let has = |flag: &str| args.iter().any(|a| a == flag);
    let index = |flag: &str| args.iter().position(|a| a == flag);
    let first_two = |a: &str, b: &str| args.len() >= 2 && args[0] == a && args[1] == b;

    if args.first().map(String::as_str) == Some("--version") {
        print_line("9.9.9 (Claude Code)");
        exit(0);
    }
    // With FAKE_CLAUDE_ACCOUNTS=1 a login is the file <CLAUDE_CONFIG_DIR>/.fake-login (its text is the email), so tests
    // can have several accounts that are signed in or out independently, like the real CLI with CLAUDE_CONFIG_DIR.
    let accounts_on = env("FAKE_CLAUDE_ACCOUNTS").as_deref() == Some("1");
    let login_file = join(&env_or("CLAUDE_CONFIG_DIR", ""), ".fake-login");
    if first_two("auth", "status") {
        if accounts_on {
            let ok = Path::new(&login_file).is_file();
            let email = if ok {
                match std::fs::read_to_string(&login_file) {
                    Ok(text) => json!(strip(&text)),
                    Err(e) => crash(&format!("OSError: {e}")),
                }
            } else {
                Value::Null
            };
            emit(json!({
                "loggedIn": ok,
                "authMethod": if ok { "claude.ai" } else { "none" },
                "email": email,
                "subscriptionType": if ok { json!("max") } else { Value::Null },
            }));
            exit(0);
        }
        emit(json!({"loggedIn": mode != "logged_out", "authMethod": "oauth_token"}));
        exit(0);
    }
    if first_two("auth", "logout") {
        if accounts_on && Path::new(&login_file).is_file() {
            if let Err(e) = std::fs::remove_file(&login_file) {
                crash(&format!("OSError: {e}"));
            }
        }
        exit(0);
    }
    if first_two("auth", "login") {
        // the sign-in the board runs in a terminal
        auth_login(&login_file);
    }
    if let Some(at) = index("--output-format") {
        let Some(format) = args.get(at + 1) else { crash("IndexError: list index out of range") };
        if format == "json" {
            if let Some(record) = env_set("FAKE_CLAUDE_CONFIG_RECORD") {
                // a test run records which account it ran as
                append(&record, &format!("{}\n", env_or("CLAUDE_CONFIG_DIR", "")));
            }
            if mode == "logged_out" {
                emit(json!({"type": "result", "is_error": true, "result": "Not logged in · Please run /login"}));
                exit(1);
            }
            if let Some(hang) = env_set("FAKE_CLAUDE_JSON_HANG") {
                // a light model that never answers: its pid goes to that file, so a test can see it is not left behind
                write(&hang, &std::process::id().to_string());
                sleep(300.0);
            }
            // a one-shot call (a light model's diagnosis or lesson): FAKE_CLAUDE_JSON_RESULT is its answer
            emit(json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "result": env_or("FAKE_CLAUDE_JSON_RESULT", "pong"),
            }));
            exit(0);
        }
    }

    if let Some(record) = env_set("FAKE_CLAUDE_RECORD") {
        append(&record, &format!("{}\n", dumps(&json!(args))));
    }
    if let Some(config_record) = env_set("FAKE_CLAUDE_CONFIG_RECORD") {
        append(&config_record, &format!("{}\n", env_or("CLAUDE_CONFIG_DIR", "")));
    }
    if let Some(cwd_record) = env_set("FAKE_CLAUDE_CWD_RECORD") {
        // where the run works, and the port it was given (worktrees)
        append(&cwd_record, &format!("{}\n", dumps(&json!({"cwd": getcwd(), "port": env("PORT")}))));
    }
    if let Some(leave) = env_set("FAKE_CLAUDE_LEAVE") {
        // the run leaves files in its folder without committing them (a QA's screenshots, a stray script)
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&leave) else {
            crash("ValueError: FAKE_CLAUDE_LEAVE is not a JSON list")
        };
        for rel in items {
            let Value::String(rel) = rel else { crash("TypeError: a path of FAKE_CLAUDE_LEAVE is not text") };
            let full = join(&getcwd(), &rel);
            if let Some(parent) = Path::new(&full).parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    crash(&format!("OSError: {e}"));
                }
            }
            write(&full, "left by the run");
        }
    }
    if let Some(commit) = env_set("FAKE_CLAUDE_COMMIT") {
        // the AI changes a file and commits it on its branch
        write(&join(&getcwd(), "calc.py"), &commit);
        let git = |argv: &[&str]| {
            if let Err(e) = Command::new("git").args(argv).stdin(Stdio::inherit()).output() {
                crash(&format!("FileNotFoundError: git: {e}"));
            }
        };
        git(&["add", "-A"]);
        git(&["-c", "user.email=ai@test", "-c", "user.name=AI", "commit", "-m", "AI change"]);
    }
    if let Some(env_record) = env_set("FAKE_CLAUDE_ENV_RECORD") {
        append(&env_record, &format!("{}\n", env_or("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "")));
    }
    let session = match index("--session-id").or_else(|| index("--resume")) {
        Some(at) => match args.get(at + 1) {
            Some(value) => value.clone(),
            None => crash("IndexError: list index out of range"),
        },
        None => crash("ValueError: '--resume' is not in list"),
    };
    if mode == "no_conversation" && has("--resume") {
        // the CLI cannot find the conversation (other folder)
        emit(json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": format!("No conversation found with session ID: {session}"),
        }));
        exit(1);
    }
    if mode == "run_logged_out" {
        // the session expired between two runs
        eprintln!("Not logged in. Please log in with claude auth login");
        exit(1);
    }
    if let Some(config_dir) = env_set("CLAUDE_CONFIG_DIR") {
        // the real CLI keeps each conversation as a file; the runner checks for it before resuming
        let folder = Path::new(&config_dir).join("projects").join("fake");
        if let Err(e) = std::fs::create_dir_all(&folder) {
            crash(&format!("OSError: {e}"));
        }
        append(&folder.join(format!("{session}.jsonl")).to_string_lossy(), "");
    }
    emit(json!({"type": "system", "subtype": "init", "session_id": session, "model": "claude-haiku-test"}));
    if let Some(text) = env_set("FAKE_CLAUDE_TEXT_MESSAGE") {
        // an event whose `message` is plain text, not an object (seen from a real CLI)
        emit(json!({"type": "system", "message": text}));
    }
    if env_set("FAKE_CLAUDE_RED_TESTS").is_some() {
        // a test command that fails, its summary coloured as pytest prints it on a terminal
        emit(json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "id": "red", "name": "Bash", "input": {"command": "python3 -m pytest -q"}}
            ]},
        }));
        emit(json!({
            "type": "user",
            "message": {"content": [{
                "type": "tool_result",
                "tool_use_id": "red",
                "is_error": true,
                "content": "Exit code 1\n\x1b[31mFAILED\x1b[0m tests/test_calc.py::test_add\n\
                            \x1b[31m\x1b[1m1 failed\x1b[0m, \x1b[32m3 passed\x1b[0m in 0.10s",
            }]},
        }));
    }
    if mode == "silent" {
        sleep(300.0);
    }
    if mode == "spawn" {
        let Some(pidfile) = env("FAKE_CLAUDE_PIDFILE") else { crash("KeyError: 'FAKE_CLAUDE_PIDFILE'") };
        // left running on purpose: the test checks that the board stops it with the CLI
        #[allow(clippy::zombie_processes)]
        let child = spawn_sleeper(&[]);
        write(&pidfile, &child.id().to_string());
        emit(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Working…"}]}}));
        sleep(300.0);
    }
    let quota_used = env_set("FAKE_CLAUDE_QUOTA");
    if quota_used.is_some() || mode == "window" {
        // Claude Code reports the account's usage window in every run (spike S5)
        let rejected = mode == "window";
        let utilization = quota_used.as_deref().map_or(0.3, py_float);
        let now = now() as i64;
        emit(json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": if rejected { "rejected" } else { "allowed" },
                "resetsAt": now + 3600,
                "rateLimitType": if rejected { "seven_day" } else { "five_hour" },
                "unifiedWindows": {
                    "five_hour": {"utilization": utilization, "resetsAt": now + 1800, "status": "allowed"},
                    "seven_day": {
                        "utilization": if rejected { 1.0 } else { 0.1 },
                        "resetsAt": now + 3600,
                        "status": if rejected { "rejected" } else { "allowed" },
                    },
                },
            },
        }));
    }
    if mode == "window" {
        emit(json!({
            "type": "result",
            "subtype": "success",
            "is_error": true,
            "api_error": "usage_limit_reached",
            "api_error_status": 429,
            "result": "You've hit your weekly limit · resets 4pm (Asia/Saigon)",
        }));
        exit(1);
    }
    if mode == "network" {
        emit(json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "api_error_status": 529,
            "result": "API Error: 529 Overloaded",
        }));
        exit(1);
    }
    if mode == "crash" {
        eprintln!("Segmentation fault (core dumped)");
        exit(139);
    }
    // the prompt and later messages arrive on stdin as stream-json
    let live = has("--input-format");
    let mut stdin = Stdin::new();
    let prompt_text = if live {
        match message_text(&stdin.readline()) {
            Ok(text) => text_or_crash(text),
            Err(why) => crash(&why),
        }
    } else {
        match index("-p") {
            Some(at) if at + 1 < args.len() => args[at + 1].clone(),
            _ => String::new(),
        }
    };
    if mode == "too_long" && !prompt_text.contains("hand-over") {
        // the conversation is too long until the board starts a fresh one with a hand-over note
        emit(json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "Prompt is too long",
        }));
        exit(1);
    }
    if mode == "dev_server" {
        // the AI starts a server in the foreground and the tool call never returns
        emit(json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "id": "srv", "name": "Bash", "input": {"command": "npm run dev"}}
            ]},
        }));
        // its command line carries the command the AI ran, as a shell would
        let mut server = spawn_sleeper(&["npm", "run", "dev"]);
        if let Some(pidfile) = env_set("FAKE_CLAUDE_PIDFILE") {
            write(&pidfile, &server.id().to_string());
        }
        if env_set("FAKE_CLAUDE_HEARTBEAT").is_some() {
            // the real CLI says it is alive while a Bash call runs (every 30 s; here every 0.1 s)
            while matches!(server.try_wait(), Ok(None)) {
                emit(json!({
                    "type": "tool_progress",
                    "tool_use_id": "srv-heartbeat-0",
                    "tool_name": "Bash",
                    "parent_tool_use_id": "srv",
                    "elapsed_time_seconds": 30,
                    "heartbeat": true,
                }));
                sleep(0.1);
            }
        }
        let _ = server.wait(); // until the board stops it
        emit(json!({
            "type": "user",
            "message": {"content": [
                {"type": "tool_result", "tool_use_id": "srv", "is_error": true, "content": "Command was killed"}
            ]},
        }));
    }
    if mode == "skill" || env_set("FAKE_CLAUDE_SKILL").is_some() {
        // a run that uses a skill and a subagent (the board counts them from the stream)
        emit(json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "id": "s1", "name": "Skill", "input": {"skill": "tdd:red-green"}},
                {
                    "type": "tool_use",
                    "id": "s2",
                    "name": "Task",
                    "input": {
                        "subagent_type": "Explore",
                        "description": "Find the add() callers",
                        "prompt": "Where is add() used?",
                    },
                },
            ]},
        }));
    }
    if mode == "sleep" {
        emit(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Thinking about it"}]}}));
        sleep(300.0);
    }
    emit(json!({
        "type": "assistant",
        "message": {"content": [
            {
                "type": "tool_use",
                "id": "t1",
                "name": "Edit",
                "input": {"file_path": join(&getcwd(), "calc.py"), "old_string": "a - b", "new_string": "a + b"},
            },
            {
                "type": "tool_use",
                "id": "t2",
                "name": "Bash",
                "input": {"command": "pytest -q API_TOKEN=sk-ant\x2dsecret123456"},
            },
        ]},
    }));
    emit(json!({
        "type": "user",
        "message": {"content": [{
            "type": "tool_result",
            "tool_use_id": "t2",
            "is_error": false,
            "content": "$ pytest -q\n..F.\nFAILED tests/test_calc.py::test_sub\n1 failed, 3 passed in 0.12s\n",
        }]},
    }));
    if mode == "ticks" {
        // one step every 0.2 s for a while: the pause / resume tests watch the steps stop and continue
        for i in 0..60 {
            emit(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": format!("tick {i}")}]}}));
            sleep(0.2);
        }
    }
    if mode == "rate_limit" {
        emit(json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "API Error: 429 rate_limit_error. Retry after 30 seconds.",
        }));
        exit(1);
    }
    if let Some(fail_left) = env_set("FAKE_CLAUDE_FAIL_FILE") {
        if Path::new(&fail_left).exists() && prompt_text.contains(&env_or("FAKE_CLAUDE_FAIL_STEP", "")) {
            // the step's run fails this many more times (the number in the file), then works
            let text = std::fs::read_to_string(&fail_left).unwrap_or_else(|e| crash(&format!("OSError: {e}")));
            let text = strip(&text);
            let left: i64 = if text.is_empty() {
                0
            } else {
                text.replace('_', "").parse().unwrap_or_else(|_| crash("ValueError: invalid literal for int()"))
            };
            if left > 0 {
                write(&fail_left, &(left - 1).to_string());
                mode = "fail".to_string();
            }
        }
    }
    if mode == "fail" {
        emit(json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "Something broke",
        }));
        exit(1);
    }
    if mode == "wait_question" {
        // the test posts a question for this run while it waits, then lets it exit (FAKE_CLAUDE_GATE: once that file
        // exists, which the test creates right after asking)
        let gate = env_set("FAKE_CLAUDE_GATE");
        let end = now() + py_float(&env_or("FAKE_CLAUDE_WAIT", if gate.is_some() { "10" } else { "1.5" }));
        while now() < end && !gate.as_deref().is_some_and(|g| Path::new(g).exists()) {
            sleep(0.02);
        }
    }
    if mode == "assistant" {
        assistant_turn(&args, &prompt_text, &session);
    }
    let mut v2_report: Option<Value> = None;
    if mode.starts_with("v2") {
        v2_report = Some(v2_turn(&mode, &args, &prompt_text, live, &mut stdin));
    }
    let mut final_text = "Fixed add(); tests pass.".to_string();
    // Workflow roles answer from their prompt: a reviewer's verdicts come in order from FAKE_CLAUDE_REVIEW_FILE (one
    // per line), a coordinator rules with FAKE_CLAUDE_RULING, Triage sets FAKE_CLAUDE_DEPTH
    let coordinator = prompt_text.contains("You are the coordinator");
    let wait_for = |gate: Option<String>| {
        let end = now() + 20.0;
        while let Some(g) = gate.as_deref() {
            if now() >= end || Path::new(g).exists() {
                break;
            }
            sleep(0.02);
        }
    };
    if let Some(path) = env_set("FAKE_CLAUDE_REVIEW_FILE").filter(|_| prompt_text.contains("Review depth:")) {
        let text = if Path::new(&path).exists() {
            std::fs::read_to_string(&path).unwrap_or_else(|e| crash(&format!("OSError: {e}")))
        } else {
            String::new()
        };
        let lines = splitlines(&text);
        let verdict = lines.first().copied().unwrap_or("PASS");
        write(&path, &lines.iter().skip(1).copied().collect::<Vec<_>>().join("\n"));
        final_text = format!("Reviewed the change.\nVERDICT: {verdict}");
    } else if prompt_text.contains("as the person would") && coordinator {
        final_text = format!(
            "Looked at the design.\nDECISION: {}",
            env_or("FAKE_CLAUDE_APPROVAL", "APPROVE every state is drawn")
        );
    } else if prompt_text.contains("failed twice") && coordinator {
        final_text =
            format!("Looked at it.\nDECISION: {}", env_or("FAKE_CLAUDE_DECISION", "RETRY run the tests with -x first"));
    } else if env_set("FAKE_CLAUDE_PLAN_AFTER_ANSWER").is_some()
        && has("--resume")
        && !prompt_text.contains("every ticket of Story")
    {
        // the PM asked the person a question while planning; resumed with the answer, it ends with its plan
        final_text = format!("Planned it with your answer.\n{}", env_or("FAKE_CLAUDE_PLAN", ""));
    } else if prompt_text.contains("you own Story") {
        // the PM plans a Story: the test creates the children while it "works", then lets it end (FAKE_CLAUDE_PLAN_GATE)
        wait_for(env_set("FAKE_CLAUDE_PLAN_GATE"));
        final_text = format!("Planned it.\n{}", env_or("FAKE_CLAUDE_PLAN", ""));
    } else if prompt_text.contains("every ticket of Story") {
        final_text = format!("Checked every criterion.\n{}", env_or("FAKE_CLAUDE_STORY_REVIEW", "REVIEW: PASS"));
    } else if prompt_text.contains("Split it by feature") {
        // the test creates the pieces while the coordinator "works", then lets it end (FAKE_CLAUDE_SPLIT_GATE)
        wait_for(env_set("FAKE_CLAUDE_SPLIT_GATE"));
        final_text = format!("Split it.\nSPLIT: {}", env_or("FAKE_CLAUDE_SPLIT_KEYS", "none"));
    } else if coordinator {
        final_text = format!(
            "Read both sides.\nVERDICT: {}\nThe criterion asks for it.",
            env_or("FAKE_CLAUDE_RULING", "REVIEWER")
        );
    } else if prompt_text.contains("DEPTH: light")
        && (env_set("FAKE_CLAUDE_DEPTH").is_some()
            || env_set("FAKE_CLAUDE_WORKFLOW").is_some()
            || env_set("FAKE_CLAUDE_SPLIT").is_some())
    {
        final_text = format!("Sorted it.\nDEPTH: {}", env_or("FAKE_CLAUDE_DEPTH", "standard"));
        if let Some(workflow) = env_set("FAKE_CLAUDE_WORKFLOW") {
            final_text += &format!("\nWORKFLOW: {workflow}");
        }
        if let Some(split) = env_set("FAKE_CLAUDE_SPLIT") {
            final_text += &format!("\nSPLIT: {split}");
        }
    }
    if env_set("FAKE_CLAUDE_HANDOFF").is_some() {
        if let Some((_, after)) = prompt_text.split_once("You are doing the step “") {
            // a workflow step ends with its handoff note (issue #272); FAKE_CLAUDE_PROMPTS keeps each step's prompt
            let step = after.split_once('”').map_or(after, |(step, _)| step);
            if let Some(prompts) = env_set("FAKE_CLAUDE_PROMPTS") {
                append(&prompts, &format!("{}\n", dumps(&json!({"step": step, "prompt": prompt_text}))));
            }
            final_text += &format!(
                "\n\nHANDOFF\nDone: {step} is done by the fake.\nWhere: notes/{}.md\nLeft: Nothing.\nCheck: the {step} part first.",
                step.to_lowercase()
            );
        }
    }
    // `if v2_report`: a report is a dict with keys, so it is always true when there is one
    let mut result = Map::new();
    result.insert("type".into(), json!("result"));
    result.insert("subtype".into(), json!("success"));
    result.insert("is_error".into(), json!(false));
    result.insert("result".into(), json!(v2_report.as_ref().map_or(final_text, dumps)));
    if let Some(report) = &v2_report {
        result.insert("structured_output".into(), report.clone());
    }
    result.insert("total_cost_usd".into(), json!(0.01));
    result.insert("usage".into(), json!({"input_tokens": 100, "output_tokens": 20}));
    result.insert("session_id".into(), json!(session));
    emit(Value::Object(result));
    if mode == "linger" {
        // it answered, but a server it started in the background keeps it open (a web server to look at its frames)
        // left running on purpose: the test checks that the board stops it with the CLI
        #[allow(clippy::zombie_processes)]
        let server = spawn_sleeper(&["http.server"]);
        if let Some(pidfile) = env_set("FAKE_CLAUDE_PIDFILE") {
            write(&pidfile, &server.id().to_string());
        }
        sleep(300.0);
    }
    if live {
        // messages a person sent while it worked, each one more turn
        loop {
            let line = stdin.readline();
            if line.is_empty() {
                break;
            }
            let text = match message_text(&line) {
                Ok(Some(text)) => text,
                Ok(None) => continue,
                Err(why) => crash(&why),
            };
            emit(json!({"type": "user", "isReplay": true, "message": {"content": [{"type": "text", "text": text}]}}));
            emit(json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "result": format!("Got it: {}", fake_claude::pyjson::py_str(&text)),
                "session_id": session,
            }));
        }
    }
}

/// `claude auth login`: the sign-in the board runs in a terminal.
fn auth_login(login_file: &str) -> ! {
    {
        // `print` without a flush, then one with: both reach the terminal before the prompt
        let mut out = std::io::stdout().lock();
        let _ = out.write_all("Opening your browser to sign in…\n".as_bytes());
        let _ = out
            .write_all(b"If it does not open, visit: https://claude.example/oauth/authorize?code=true&client_id=x\n");
        let _ = out.flush();
    }
    // `input(prompt)`: on a terminal Python writes the prompt to stderr, otherwise to stdout
    let prompt = "Paste code here if prompted > ";
    if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(prompt.as_bytes());
        let _ = err.flush();
    } else {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(prompt.as_bytes());
        let _ = out.flush();
    }
    let mut stdin = Stdin::new();
    let line = stdin.readline();
    if line.is_empty() {
        crash("EOFError: EOF when reading a line");
    }
    let code = line.strip_suffix('\n').unwrap_or(&line);
    if strip(code) != "good" {
        print_line("Invalid or expired code");
        exit(1);
    }
    write(login_file, &env_or("FAKE_CLAUDE_EMAIL", "an@work.example"));
    print_line("Login successful");
    exit(0)
}

/// An assistant turn (AI v2 stage 7): one board read, then the answer; FAKE_CLAUDE_ASSISTANT_JSON is the structured
/// answer, FAKE_CLAUDE_ASSISTANT_TEXT the plain one; FAKE_CLAUDE_PROMPTS keeps each prompt it was given.
fn assistant_turn(args: &[String], prompt_text: &str, session: &str) -> ! {
    if let Some(prompts) = env_set("FAKE_CLAUDE_PROMPTS") {
        append(&prompts, &format!("{}\n", dumps(&json!({"prompt": prompt_text, "args": args}))));
    }
    emit(json!({
        "type": "assistant",
        "message": {"content": [
            {"type": "tool_use", "id": "as1", "name": "mcp__kanban__docs_read", "input": {"action": "list"}}
        ]},
    }));
    emit(json!({
        "type": "user",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "as1", "is_error": false, "content": "[]"}
        ]},
    }));
    if let Some(wait) = env_set("FAKE_CLAUDE_ASSISTANT_WAIT") {
        sleep(py_float(&wait));
    }
    let mut structured: Option<Value> = None;
    if let Some(by_skill) = env_set("FAKE_CLAUDE_ASSISTANT_BY_SKILL") {
        let Ok(Value::Object(table)) = serde_json::from_str::<Value>(&by_skill) else {
            crash("ValueError: FAKE_CLAUDE_ASSISTANT_BY_SKILL is not a JSON object")
        };
        for (key, value) in table {
            if prompt_text.contains(&format!(":{key}`")) {
                // a null answer is `None`: the next source is asked
                structured = Some(value).filter(|v| !v.is_null());
                break;
            }
        }
    }
    if structured.is_none() {
        if let Some(text) = env_set("FAKE_CLAUDE_ASSISTANT_JSON") {
            let value = serde_json::from_str::<Value>(&text)
                .unwrap_or_else(|_| crash("ValueError: FAKE_CLAUDE_ASSISTANT_JSON is not JSON"));
            structured = Some(value).filter(|v| !v.is_null());
        }
    }
    let answer = env_or("FAKE_CLAUDE_ASSISTANT_TEXT", "Here is the answer.");
    let mut result = Map::new();
    result.insert("type".into(), json!("result"));
    result.insert("subtype".into(), json!("success"));
    result.insert("is_error".into(), json!(false));
    result.insert("result".into(), json!(structured.as_ref().map_or(answer, dumps)));
    if let Some(structured) = &structured {
        result.insert("structured_output".into(), structured.clone());
    }
    result.insert("total_cost_usd".into(), json!(0.02));
    result.insert("usage".into(), json!({"input_tokens": 200, "output_tokens": 40}));
    result.insert("session_id".into(), json!(session));
    emit(Value::Object(result));
    exit(0)
}

/// AI v2: the lead runs a command, asks a subagent (its events carry parent_tool_use_id), and ends with the structured
/// report (--json-schema). FAKE_CLAUDE_V2_WAIT_MESSAGE: wait for one message on stdin first. Returns the report.
fn v2_turn(mode: &str, args: &[String], prompt_text: &str, live: bool, stdin: &mut Stdin) -> Value {
    emit(json!({
        "type": "assistant",
        "message": {"content": [
            {"type": "tool_use", "id": "v2cmd", "name": "Bash", "input": {"command": "pytest -q"}}
        ]},
    }));
    emit(json!({
        "type": "user",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "v2cmd", "is_error": false, "content": "4 passed in 0.10s\n"}
        ]},
    }));
    emit(json!({
        "type": "assistant",
        "message": {"content": [{
            "type": "tool_use",
            "id": "v2agent",
            "name": "Agent",
            "input": {"subagent_type": "reviewer", "description": "Review the diff"},
        }]},
    }));
    emit(json!({
        "type": "assistant",
        "parent_tool_use_id": "v2agent",
        "message": {"content": [
            {"type": "tool_use", "id": "v2sub", "name": "Bash", "input": {"command": "git diff --stat"}}
        ]},
    }));
    emit(json!({
        "type": "user",
        "parent_tool_use_id": "v2agent",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "v2sub", "is_error": false, "content": " 1 file changed"}
        ]},
    }));
    emit(json!({
        "type": "assistant",
        "parent_tool_use_id": "v2agent",
        "message": {"content": [{"type": "text", "text": "Looks good: one small change, tests pass."}]},
    }));
    emit(json!({
        "type": "user",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "v2agent", "is_error": false, "content": "Looks good."}
        ]},
    }));
    let mut heard = String::new();
    if live && env_set("FAKE_CLAUDE_V2_WAIT_MESSAGE").is_some() {
        let end = now() + py_float(&env_or("FAKE_CLAUDE_WAIT", "10"));
        while now() < end {
            if stdin.ready(0.05) {
                heard = match message_text(&stdin.readline()) {
                    Ok(text) => text_or_crash(text),
                    Err(why) => crash(&why),
                };
                break;
            }
        }
    }
    let report = if mode == "v2_ask" {
        json!({
            "status": "question",
            "summary": "I need to know the database.",
            "asks": ["Which database: SQLite or PostgreSQL?"],
        })
    } else if let Some((_, after)) =
        prompt_text.split_once("answered your question").filter(|_| args.iter().any(|a| a == "--resume"))
    {
        let head: String = after.chars().take(120).collect();
        json!({"status": "done", "summary": format!("Done with your answer: {}", strip(&head)), "lessons": []})
    } else {
        let heard = if heard.is_empty() { String::new() } else { format!(" Heard: {heard}") };
        json!({
            "status": "done",
            "summary": format!("Fixed add(); tests pass.{heard}"),
            "branch": format!("ai/{}", env_or("FAKE_CLAUDE_V2_BRANCH", "test")),
            "tests": {"passed": 4, "failed": 0, "command": "pytest -q"},
            "lessons": ["Run pytest -q from the server folder."],
            "open_items": [],
        })
    };
    emit(json!({
        "type": "assistant",
        "message": {"content": [
            {"type": "tool_use", "id": "v2out", "name": "StructuredOutput", "input": report.clone()}
        ]},
    }));
    report
}
