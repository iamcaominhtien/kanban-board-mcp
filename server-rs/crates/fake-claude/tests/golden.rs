//! The Rust `fake-claude` against the Python script it was ported from (`server/tests/fixtures/fake_claude.py`): each
//! mode and subcommand is run in both with the same arguments, environment and input, each in its own temporary
//! folder, and what they print (stdout, stderr), their exit code and the files they leave are compared.
//!
//! The Python script is run with `server/.venv/bin/python`; where that is not installed the test says so and passes.
//! Times (`resetsAt`) and the folder's path are masked before comparing. Where Python ends with a traceback only the
//! exit code and "something on stderr" are compared.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;

const STREAM: [&str; 6] = ["-p", "Fix add()", "--output-format", "stream-json", "--session-id", "sess-1"];

#[derive(Clone, Copy, PartialEq)]
enum Stop {
    /// The program ends by itself.
    Exit,
    /// It never ends: stop it (and what it started) once it printed this many lines.
    AfterLines(usize),
    /// It waits for the process whose pid it wrote to `pid`: stop that one, then it ends by itself.
    KillPidfile,
    /// It never ends and prints nothing: stop it once the file `pid` is there.
    AfterPidfile,
}

struct Case {
    name: &'static str,
    args: Vec<String>,
    env: Vec<(&'static str, String)>,
    /// What is written to stdin, each piece after a wait in milliseconds; `None`: no stdin (`/dev/null`).
    stdin: Option<Vec<(u64, String)>>,
    stop: Stop,
    /// Files made in the folder before the run (`<DIR>` in a value of `env` and here is the folder).
    files: Vec<(&'static str, &'static str)>,
    /// Python ends with a traceback here: stderr is only checked for having text.
    traceback: bool,
    /// Lines that repeat while the program waits are compared once.
    dedupe: bool,
    git: bool,
}

fn case(name: &'static str, args: &[&str]) -> Case {
    Case {
        name,
        args: args.iter().map(|a| a.to_string()).collect(),
        env: Vec::new(),
        stdin: None,
        stop: Stop::Exit,
        files: Vec::new(),
        traceback: false,
        dedupe: false,
        git: false,
    }
}

impl Case {
    fn env(mut self, key: &'static str, value: &str) -> Self {
        self.env.push((key, value.to_string()));
        self
    }
    fn mode(self, mode: &str) -> Self {
        self.env("FAKE_CLAUDE_MODE", mode)
    }
    fn stdin(mut self, pieces: &[(u64, &str)]) -> Self {
        self.stdin = Some(pieces.iter().map(|(wait, text)| (*wait, text.to_string())).collect());
        self
    }
    fn stop(mut self, stop: Stop) -> Self {
        self.stop = stop;
        self
    }
    fn file(mut self, path: &'static str, text: &'static str) -> Self {
        self.files.push((path, text));
        self
    }
    fn traceback(mut self) -> Self {
        self.traceback = true;
        self
    }
    fn dedupe(mut self) -> Self {
        self.dedupe = true;
        self
    }
    fn git(mut self) -> Self {
        self.git = true;
        self
    }
}

fn stream(name: &'static str) -> Case {
    case(name, &STREAM)
}

fn prompt(name: &'static str, text: &str) -> Case {
    case(name, &["-p", text, "--output-format", "stream-json", "--session-id", "sess-1"])
}

fn user_line(text: &str) -> String {
    format!("{{\"type\": \"user\", \"message\": {{\"role\": \"user\", \"content\": [{{\"type\": \"text\", \"text\": \"{text}\"}}]}}}}\n")
}

fn cases() -> Vec<Case> {
    let live = ["--input-format", "stream-json", "--output-format", "stream-json", "--session-id", "live-1"];
    let resume = ["-p", "The person answered your question:  use SQLite  ", "--output-format", "stream-json", "--resume", "sess-9"];
    vec![
        case("version", &["--version"]),
        case("version with more arguments", &["--version", "--verbose"]),
        case("auth status", &["auth", "status"]),
        case("auth status json flag", &["auth", "status", "--json"]),
        case("auth status logged out", &["auth", "status"]).mode("logged_out"),
        case("accounts: status without a login", &["auth", "status", "--json"]).env("FAKE_CLAUDE_ACCOUNTS", "1"),
        case("accounts: status with a login", &["auth", "status", "--json"])
            .env("FAKE_CLAUDE_ACCOUNTS", "1")
            .file("config/.fake-login", "  an@work.example\n"),
        case("accounts: logout", &["auth", "logout"])
            .env("FAKE_CLAUDE_ACCOUNTS", "1")
            .file("config/.fake-login", "an@work.example"),
        case("logout without accounts keeps the file", &["auth", "logout"]).file("config/.fake-login", "x"),
        case("login with the good code", &["auth", "login", "--claudeai"]).stdin(&[(0, "good\n")]).file("config/keep", ""),
        case("login with the good code and spaces", &["auth", "login"])
            .stdin(&[(0, "  good \r\n")])
            .env("FAKE_CLAUDE_EMAIL", "bình@work.example")
            .file("config/keep", ""),
        case("login with a bad code", &["auth", "login"]).stdin(&[(0, "bad\n")]).file("config/keep", ""),
        case("login with no input", &["auth", "login"]).stdin(&[]).traceback(),
        case("one shot", &["-p", "ping", "--output-format", "json"]),
        case("one shot logged out", &["-p", "ping", "--output-format", "json"])
            .mode("logged_out")
            .env("FAKE_CLAUDE_CONFIG_RECORD", "<DIR>/config-record"),
        case("one shot answer", &["--output-format", "json", "-p", "x"]).env("FAKE_CLAUDE_JSON_RESULT", "{\"cause\": \"Tests đỏ ✓\"}"),
        case("one shot that hangs", &["-p", "ping", "--output-format", "json"])
            .env("FAKE_CLAUDE_JSON_HANG", "<DIR>/pid")
            .stop(Stop::AfterPidfile),
        case("output format without a value", &["--output-format"]).traceback(),
        case("no session", &["-p", "x"]).traceback(),
        case("session flag without a value", &["-p", "x", "--session-id"]).traceback(),
        stream("finish"),
        stream("finish with an empty mode").mode(""),
        stream("an unknown mode finishes").mode("whatever"),
        stream("records")
            .env("FAKE_CLAUDE_RECORD", "<DIR>/record")
            .env("FAKE_CLAUDE_CONFIG_RECORD", "<DIR>/config-record")
            .env("FAKE_CLAUDE_CWD_RECORD", "<DIR>/cwd-record")
            .env("FAKE_CLAUDE_ENV_RECORD", "<DIR>/env-record")
            .env("PORT", "4173")
            .env("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "70"),
        stream("records without the values").env("FAKE_CLAUDE_CWD_RECORD", "<DIR>/cwd-record").env("FAKE_CLAUDE_ENV_RECORD", "<DIR>/env-record"),
        case("records unicode arguments", &["-p", "Sửa lỗi ✓ 😀 \"q\"", "--output-format", "stream-json", "--session-id", "s"])
            .env("FAKE_CLAUDE_RECORD", "<DIR>/record"),
        stream("leaves files").env("FAKE_CLAUDE_LEAVE", "[\"shots/a.png\", \"stray.py\"]"),
        stream("commits").env("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b\n").git(),
        stream("no config dir").env("CLAUDE_CONFIG_DIR", ""),
        stream("text message").env("FAKE_CLAUDE_TEXT_MESSAGE", "plain text, not an object"),
        stream("red tests").env("FAKE_CLAUDE_RED_TESTS", "1"),
        stream("skill by variable").env("FAKE_CLAUDE_SKILL", "1"),
        stream("skill").mode("skill"),
        stream("quota").env("FAKE_CLAUDE_QUOTA", "0.95"),
        stream("quota whole number").env("FAKE_CLAUDE_QUOTA", "1"),
        stream("quota tiny").env("FAKE_CLAUDE_QUOTA", "0.00001"),
        stream("window").mode("window"),
        stream("window with quota").mode("window").env("FAKE_CLAUDE_QUOTA", "0.5"),
        case("no conversation on resume", &["-p", "x", "--output-format", "stream-json", "--resume", "gone-1"]).mode("no_conversation"),
        stream("no conversation on a new session").mode("no_conversation"),
        stream("run logged out").mode("run_logged_out"),
        stream("silent").mode("silent").stop(Stop::AfterLines(1)),
        stream("spawn").mode("spawn").env("FAKE_CLAUDE_PIDFILE", "<DIR>/pid").stop(Stop::AfterLines(2)),
        stream("spawn without a pid file").mode("spawn").traceback(),
        stream("network").mode("network"),
        stream("crash").mode("crash"),
        stream("too long").mode("too_long"),
        prompt("too long with a hand-over", "Here is the hand-over note").mode("too_long"),
        stream("dev server").mode("dev_server").env("FAKE_CLAUDE_PIDFILE", "<DIR>/pid").stop(Stop::KillPidfile),
        stream("dev server with a heartbeat")
            .mode("dev_server")
            .env("FAKE_CLAUDE_PIDFILE", "<DIR>/pid")
            .env("FAKE_CLAUDE_HEARTBEAT", "1")
            .stop(Stop::KillPidfile)
            .dedupe(),
        stream("sleep").mode("sleep").stop(Stop::AfterLines(2)),
        stream("ticks").mode("ticks"),
        stream("rate limit").mode("rate_limit"),
        stream("fail").mode("fail"),
        prompt("fails once more", "Do the Build step").env("FAKE_CLAUDE_FAIL_FILE", "<DIR>/left").env("FAKE_CLAUDE_FAIL_STEP", "Build").file("left", " 2\n"),
        prompt("fail file at zero", "Do the Build step").env("FAKE_CLAUDE_FAIL_FILE", "<DIR>/left").env("FAKE_CLAUDE_FAIL_STEP", "Build").file("left", "0"),
        prompt("fail file empty", "Do the Build step").env("FAKE_CLAUDE_FAIL_FILE", "<DIR>/left").file("left", ""),
        prompt("fail file for another step", "Do the Test step").env("FAKE_CLAUDE_FAIL_FILE", "<DIR>/left").env("FAKE_CLAUDE_FAIL_STEP", "Build").file("left", "3"),
        stream("fail file missing").env("FAKE_CLAUDE_FAIL_FILE", "<DIR>/left"),
        stream("wait question").mode("wait_question").env("FAKE_CLAUDE_WAIT", "0.2"),
        stream("wait question with the gate open").mode("wait_question").env("FAKE_CLAUDE_GATE", "<DIR>/gate").file("gate", ""),
        stream("assistant").mode("assistant"),
        stream("assistant text").mode("assistant").env("FAKE_CLAUDE_ASSISTANT_TEXT", "Câu trả lời.").env("FAKE_CLAUDE_PROMPTS", "<DIR>/prompts"),
        stream("assistant json")
            .mode("assistant")
            .env("FAKE_CLAUDE_ASSISTANT_JSON", "{\"title\": \"Kế hoạch\", \"n\": 2, \"ratio\": 0.5, \"big\": 1e+20, \"items\": [null, true, {\"a\": []}]}")
            .env("FAKE_CLAUDE_ASSISTANT_WAIT", "0.05"),
        stream("assistant json null").mode("assistant").env("FAKE_CLAUDE_ASSISTANT_JSON", "null"),
        prompt("assistant by skill", "Use the skill `kanban:outline` now")
            .mode("assistant")
            .env("FAKE_CLAUDE_ASSISTANT_BY_SKILL", "{\"draft\": {\"x\": 1}, \"outline\": {\"sections\": [\"A\", \"B\"]}}")
            .env("FAKE_CLAUDE_ASSISTANT_JSON", "{\"fallback\": true}"),
        prompt("assistant by skill without a match", "Use the skill `kanban:other` now")
            .mode("assistant")
            .env("FAKE_CLAUDE_ASSISTANT_BY_SKILL", "{\"draft\": {\"x\": 1}}")
            .env("FAKE_CLAUDE_ASSISTANT_JSON", "{\"fallback\": true}"),
        stream("v2").mode("v2"),
        stream("v2 branch").mode("v2").env("FAKE_CLAUDE_V2_BRANCH", "kan-12-fix"),
        stream("v2 ask").mode("v2_ask"),
        stream("v2 anything").mode("v2_team"),
        case("v2 resumed with the answer", &resume).mode("v2"),
        case("v2 ask resumed", &resume).mode("v2_ask"),
        case("live", &live).stdin(&[(0, &user_line("Fix add()")), (150, &user_line("Also the docs")), (0, "not json\n"), (0, "{\"message\": {}}\n"), (0, &user_line("Cảm ơn ✓"))]),
        case("live with an empty input", &live).stdin(&[]),
        case("live with a prompt that is not json", &live).stdin(&[(0, "hello\n")]),
        case("live v2 hears a message", &live)
            .mode("v2")
            .env("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")
            .stdin(&[(0, &user_line("Fix add()")), (400, &user_line("Use pytest -x")), (300, &user_line("One more"))]),
        case("live v2 hears nothing", &live)
            .mode("v2")
            .env("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")
            .env("FAKE_CLAUDE_WAIT", "0.3")
            .stdin(&[(0, &user_line("Fix add()")), (900, "")]),
        case("live v2 input ends while it waits", &live)
            .mode("v2")
            .env("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")
            .stdin(&[(0, &user_line("Fix add()"))]),
        stream("linger").mode("linger").env("FAKE_CLAUDE_PIDFILE", "<DIR>/pid").stop(Stop::AfterLines(4)),
        prompt("review verdicts", "Review depth: standard").env("FAKE_CLAUDE_REVIEW_FILE", "<DIR>/verdicts").file("verdicts", "FAIL the test is missing\nPASS\n"),
        prompt("review verdicts last", "Review depth: standard").env("FAKE_CLAUDE_REVIEW_FILE", "<DIR>/verdicts").file("verdicts", "PASS"),
        prompt("review without a file", "Review depth: light").env("FAKE_CLAUDE_REVIEW_FILE", "<DIR>/verdicts"),
        prompt("approval", "You are the coordinator. Look as the person would."),
        prompt("approval set", "You are the coordinator. Look as the person would.").env("FAKE_CLAUDE_APPROVAL", "REJECT the empty state is missing"),
        prompt("decision", "You are the coordinator. It failed twice."),
        prompt("decision set", "You are the coordinator. It failed twice.").env("FAKE_CLAUDE_DECISION", "STOP"),
        case("plan after the answer", &["-p", "Here is the answer", "--output-format", "stream-json", "--resume", "s"])
            .env("FAKE_CLAUDE_PLAN_AFTER_ANSWER", "1")
            .env("FAKE_CLAUDE_PLAN", "PLAN: KAN-2, KAN-3"),
        prompt("plan a story", "you own Story KAN-1").env("FAKE_CLAUDE_PLAN", "PLAN: KAN-2").env("FAKE_CLAUDE_PLAN_GATE", "<DIR>/gate").file("gate", ""),
        prompt("plan a story without a gate", "you own Story KAN-1"),
        prompt("story review", "Check every ticket of Story KAN-1"),
        prompt("story review set", "Check every ticket of Story KAN-1").env("FAKE_CLAUDE_STORY_REVIEW", "REVIEW: FAIL KAN-3"),
        prompt("split", "Split it by feature").env("FAKE_CLAUDE_SPLIT_GATE", "<DIR>/gate").env("FAKE_CLAUDE_SPLIT_KEYS", "KAN-4, KAN-5").file("gate", ""),
        prompt("ruling", "You are the coordinator. Rule."),
        prompt("ruling set", "You are the coordinator. Rule.").env("FAKE_CLAUDE_RULING", "AUTHOR"),
        prompt("depth", "Answer with DEPTH: light or more").env("FAKE_CLAUDE_DEPTH", "deep"),
        prompt("depth with workflow and split", "Answer with DEPTH: light or more").env("FAKE_CLAUDE_WORKFLOW", "bugfix").env("FAKE_CLAUDE_SPLIT", "yes"),
        prompt("depth without a variable", "Answer with DEPTH: light or more"),
        prompt("handoff", "You are doing the step “Build”. Go.").env("FAKE_CLAUDE_HANDOFF", "1").env("FAKE_CLAUDE_PROMPTS", "<DIR>/prompts"),
        prompt("handoff without the closing quote", "You are doing the step “Thiết Kế").env("FAKE_CLAUDE_HANDOFF", "1"),
        prompt("handoff off", "You are doing the step “Build”. Go."),
    ]
}

struct Outcome {
    stdout: Vec<String>,
    stderr: String,
    code: Option<i32>,
    files: BTreeMap<String, String>,
}

fn python() -> Option<(PathBuf, PathBuf)> {
    let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server");
    let python = server.join(".venv/bin/python");
    let script = server.join("tests/fixtures/fake_claude.py");
    (python.exists() && script.exists()).then_some((python, script))
}

fn snapshot(root: &Path, dir: &Path, mask: &dyn Fn(&str) -> String, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(root).expect("inside the folder").to_string_lossy().into_owned();
        if rel == ".git" || rel == "pid" || rel == "home" {
            continue;
        }
        if path.is_dir() {
            out.insert(format!("{rel}/"), String::new());
            snapshot(root, &path, mask, out);
        } else {
            out.insert(rel, mask(&String::from_utf8_lossy(&std::fs::read(&path).unwrap_or_default())));
        }
    }
}

fn wait_for(what: &str, deadline: Instant, mut ready: impl FnMut() -> bool) {
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn run(case: &Case, program: &[&Path]) -> Outcome {
    let dir = tempfile::tempdir().expect("temporary folder");
    let root = dir.path().canonicalize().expect("real path");
    let root_text = root.to_string_lossy().into_owned();
    let here = |text: &str| text.replace("<DIR>", &root_text);
    std::fs::create_dir_all(root.join("home")).expect("home");
    for (path, text) in &case.files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().expect("parent")).expect("folder");
        std::fs::write(full, text).expect("file");
    }
    std::fs::write(root.join("calc.py"), "def add(a, b):\n    return a - b\n").expect("calc.py");
    let system_path = "/usr/local/bin:/usr/bin:/bin";
    if case.git {
        for argv in [vec!["init", "-q"], vec!["add", "-A"], vec!["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "-m", "first"]] {
            let done = Command::new("git").args(&argv).current_dir(&root).env("HOME", root.join("home")).output().expect("git");
            assert!(done.status.success(), "git {argv:?}: {}", String::from_utf8_lossy(&done.stderr));
        }
    }
    let mut command = Command::new(program[0]);
    command.args(&program[1..]).args(&case.args).current_dir(&root).env_clear();
    command.env("PATH", system_path).env("HOME", root.join("home")).env("CLAUDE_CONFIG_DIR", root.join("config"));
    command.env("PYTHONDONTWRITEBYTECODE", "1").env("LC_ALL", "C.UTF-8").env("PYTHONIOENCODING", "utf-8");
    for (key, value) in &case.env {
        command.env(key, here(value));
    }
    command.stdin(if case.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = command.spawn().expect("the program starts");
    let group = Pid::from_raw(i32::try_from(child.id()).expect("pid"));
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let out_reader = {
        let (lines, stdout) = (lines.clone(), child.stdout.take().expect("stdout"));
        std::thread::spawn(move || {
            // by bytes: the prompt of the sign-in has no line end
            let mut reader = BufReader::new(stdout);
            loop {
                let mut raw = Vec::new();
                match reader.read_until(b'\n', &mut raw) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => lines.lock().expect("lock").push(String::from_utf8_lossy(&raw).into_owned()),
                }
            }
        })
    };
    let err_reader = {
        let mut stderr = child.stderr.take().expect("stderr");
        std::thread::spawn(move || {
            let mut text = String::new();
            let mut raw = Vec::new();
            let _ = stderr.read_to_end(&mut raw);
            text.push_str(&String::from_utf8_lossy(&raw));
            text
        })
    };
    let writer = case.stdin.clone().map(|pieces| {
        let mut stdin = child.stdin.take().expect("stdin");
        std::thread::spawn(move || {
            for (wait, text) in pieces {
                std::thread::sleep(Duration::from_millis(wait));
                if stdin.write_all(text.as_bytes()).and_then(|()| stdin.flush()).is_err() {
                    break;
                }
            }
        })
    });
    let deadline = Instant::now() + Duration::from_secs(40);
    let pidfile = root.join("pid");
    let pid_in_file = || std::fs::read_to_string(&pidfile).ok().and_then(|t| t.trim().parse::<i32>().ok());
    match case.stop {
        Stop::Exit => {}
        Stop::AfterLines(n) => {
            wait_for("the lines", deadline, || lines.lock().expect("lock").len() >= n);
            if case.env.iter().any(|(k, _)| *k == "FAKE_CLAUDE_PIDFILE") {
                wait_for("the pid file", deadline, || pid_in_file().is_some());
                // what it started is alive, and is one of its own group (stopped with it below)
                assert!(kill(Pid::from_raw(pid_in_file().expect("pid")), None).is_ok(), "{}: the child runs", case.name);
            }
            std::thread::sleep(Duration::from_millis(150)); // nothing more may follow
            let _ = killpg(group, Signal::SIGKILL);
        }
        Stop::AfterPidfile => {
            wait_for("the pid file", deadline, || pid_in_file().is_some());
            assert_eq!(pid_in_file(), Some(group.as_raw()), "{}: its own pid", case.name);
            std::thread::sleep(Duration::from_millis(150));
            let _ = killpg(group, Signal::SIGKILL);
        }
        Stop::KillPidfile => {
            wait_for("the pid file", deadline, || pid_in_file().is_some());
            std::thread::sleep(Duration::from_millis(350));
            let _ = kill(Pid::from_raw(pid_in_file().expect("pid")), Signal::SIGKILL);
        }
    }
    let status = loop {
        if let Some(status) = child.try_wait().expect("wait") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = killpg(group, Signal::SIGKILL);
            panic!("{}: {:?} did not end", case.name, program[0]);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let _ = killpg(group, Signal::SIGKILL); // whatever is left of its group
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let _ = out_reader.join();
    let stderr = err_reader.join().unwrap_or_default();
    let resets = regex::Regex::new(r#""resetsAt": \d+"#).expect("pattern");
    let mask = |text: &str| resets.replace_all(&text.replace(&root_text, "<DIR>"), "\"resetsAt\": 0").into_owned();
    let mut stdout: Vec<String> = lines.lock().expect("lock").iter().map(|l| mask(l)).collect();
    if case.dedupe {
        stdout.dedup();
    }
    let mut files = BTreeMap::new();
    snapshot(&root, &root, &mask, &mut files);
    if case.git {
        let log = Command::new("git").args(["log", "--format=%an <%ae> %s"]).current_dir(&root).output().expect("git log");
        files.insert("(git log)".into(), String::from_utf8_lossy(&log.stdout).into_owned());
        let dirty = Command::new("git").args(["status", "--porcelain"]).current_dir(&root).output().expect("git status");
        files.insert("(git status)".into(), String::from_utf8_lossy(&dirty.stdout).into_owned());
    }
    let code = status.code().or_else(|| status.signal().map(|s| -s));
    Outcome { stdout, stderr: mask(&stderr), code, files }
}

#[test]
fn the_rust_fake_prints_what_the_python_script_prints_in_every_mode() {
    let Some((python, script)) = python() else {
        eprintln!("skipped: server/.venv/bin/python is not installed, so there is no Python script to compare with");
        return;
    };
    let rust = PathBuf::from(env!("CARGO_BIN_EXE_fake-claude"));
    let cases = cases();
    let total = cases.len();
    // a few at a time: some cases wait on purpose
    let cases = Arc::new(Mutex::new(cases.into_iter().collect::<std::collections::VecDeque<_>>()));
    let failures: Arc<Mutex<Vec<String>>> = Arc::default();
    let workers: Vec<_> = (0..6)
        .map(|_| {
            let (cases, failures) = (cases.clone(), failures.clone());
            let (python, script, rust) = (python.clone(), script.clone(), rust.clone());
            std::thread::spawn(move || {
                loop {
                    let Some(case) = cases.lock().expect("lock").pop_front() else { break };
                    let py = run(&case, &[&python, &script]);
                    let rs = run(&case, &[&rust]);
                    let mut wrong = Vec::new();
                    if py.stdout != rs.stdout {
                        wrong.push(format!("stdout\n  python: {:?}\n  rust:   {:?}", py.stdout, rs.stdout));
                    }
                    if py.code != rs.code {
                        wrong.push(format!("exit code: python {:?}, rust {:?}", py.code, rs.code));
                    }
                    if case.traceback {
                        if py.stderr.is_empty() || rs.stderr.is_empty() {
                            wrong.push(format!("stderr should say why: python {:?}, rust {:?}", py.stderr, rs.stderr));
                        }
                    } else if py.stderr != rs.stderr {
                        wrong.push(format!("stderr\n  python: {:?}\n  rust:   {:?}", py.stderr, rs.stderr));
                    }
                    if py.files != rs.files {
                        wrong.push(format!("files\n  python: {:?}\n  rust:   {:?}", py.files, rs.files));
                    }
                    if !wrong.is_empty() {
                        failures.lock().expect("lock").push(format!("{}:\n{}", case.name, wrong.join("\n")));
                    }
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().expect("a worker");
    }
    let failures = failures.lock().expect("lock");
    assert!(failures.is_empty(), "{} of {total} cases differ:\n\n{}", failures.len(), failures.join("\n\n"));
}

#[test]
fn the_library_finds_the_program_and_installs_it_under_another_name() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let bin = fake_claude::bin_path();
    assert!(bin.is_file());
    let claude = fake_claude::install(dir.path(), "claude");
    let out = Command::new(&claude).arg("--version").env_clear().output().expect("the fake runs");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "9.9.9 (Claude Code)\n");
}
