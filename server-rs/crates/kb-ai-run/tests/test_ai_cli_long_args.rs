//! `server/tests/test_ai_cli_long_args.py`: a long prompt or system prompt must not travel on the command line:
//! Windows refuses a command over 8191 characters through the `claude.cmd` shim and over 32767 at all ("command line
//! is too long", WinError 206).
//!
//! The Python tests lower `cli._MAX_COMMAND_CHARS` and set `cli.sys.platform`; here the limit and the platform are
//! arguments (`spill_long_args_with`, `CliProcess::max_command_chars`). The program the process tests start is a
//! shell script that keeps its arguments, its input and the system prompt file where the test reads them (the Python
//! tests use a Python script that prints them as JSON).
#![cfg(unix)]

mod common;

use std::path::Path;

use kb_ai_run::cli::{self, CliProcess};

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// A program that writes each argument to `arg<N>`, its input to `stdin` and the file after `--system-prompt-file`
/// to `system`, in its working folder, then prints one line.
const ECHO: &str = r#"i=0
while [ $# -gt 0 ]; do
  printf '%s' "$1" > "arg$i"
  if [ "$1" = "--system-prompt-file" ]; then cat "$2" > system; fi
  i=$((i+1))
  shift
done
cat > stdin
echo "{\"args\": $i}""#;

struct Got {
    argv: Vec<String>,
    stdin: String,
    system: Option<String>,
}

fn got(folder: &Path) -> Got {
    let mut argv = Vec::new();
    while let Ok(arg) = std::fs::read_to_string(folder.join(format!("arg{}", argv.len()))) {
        argv.push(arg);
    }
    Got {
        argv,
        stdin: std::fs::read_to_string(folder.join("stdin")).expect("stdin"),
        system: std::fs::read_to_string(folder.join("system")).ok(),
    }
}

async fn lines_of(proc: &CliProcess) -> Vec<String> {
    let mut lines = proc.lines();
    let mut out = Vec::new();
    while let Some(line) = lines.next().await.expect("a line") {
        out.push(line);
    }
    out
}

#[test]
fn test_a_short_command_is_left_alone() {
    let a = args(&["claude", "-p", "hi", "--system-prompt", "be brief"]);
    assert_eq!(cli::spill_long_args(&a, true).expect("spill"), (a, None, None));
}

#[test]
fn test_a_long_prompt_and_system_prompt_leave_the_command_line() {
    let (prompt, system) = ("p".repeat(500), "s".repeat(500));
    let a = args(&["claude", "-p", &prompt, "--output-format", "stream-json", "--system-prompt", &system]);
    let (out, stdin_text, folder) = cli::spill_long_args_with(&a, true, false, 200).expect("spill");
    let folder = folder.expect("a temp folder");
    assert_eq!(stdin_text.as_deref(), Some(prompt.as_str()));
    assert_eq!(&out[..3], &args(&["claude", "-p", "--output-format"])[..]);
    assert!(!out.contains(&"--system-prompt".to_string()) && !out.contains(&prompt) && !out.contains(&system));
    let file = &out[out.iter().position(|a| a == "--system-prompt-file").expect("the file flag") + 1];
    assert_eq!(std::fs::read_to_string(file).expect("the file"), system);
    assert!(out.join(" ").len() < 200);
    std::fs::remove_dir_all(folder).expect("remove");
    assert_eq!(a[2], prompt); // the caller's list is not touched
}

#[test]
fn test_append_system_prompt_goes_to_its_own_file_flag() {
    let rules = "rules ✓".repeat(20);
    let a = args(&["claude", "-p", &"x".repeat(300), "--append-system-prompt", &rules]);
    let (out, stdin_text, folder) = cli::spill_long_args_with(&a, true, false, 100).expect("spill");
    assert_eq!(stdin_text, Some("x".repeat(300)));
    let file = &out[out.iter().position(|a| a == "--append-system-prompt-file").expect("the file flag") + 1];
    assert_eq!(std::fs::read_to_string(file).expect("the file"), rules);
    std::fs::remove_dir_all(folder.expect("a temp folder")).expect("remove");
}

#[tokio::test]
async fn test_the_process_gets_the_prompt_on_stdin_and_the_system_prompt_in_a_file() {
    let _lock = common::init().await;
    let tmp = common::tmp_path("long-args");
    let script = common::script(&tmp, "echo.sh", ECHO, true);
    let (prompt, system) = ("Tôi cần AI ✓ ".repeat(400), "Rules. ".repeat(400));
    let mut proc = CliProcess::new(
        args(&[&script.to_string_lossy(), "-p", &prompt, "--system-prompt", &system]),
        &tmp.to_string_lossy(),
        None,
        true,
        None,
    );
    proc.max_command_chars = Some(300);
    proc.start().await.expect("start");
    let temp = proc.temp().expect("a temp folder");
    assert!(Path::new(&temp).is_dir());
    let lines = lines_of(&proc).await;
    assert_eq!(proc.wait().await.expect("wait"), 0);
    assert_eq!(lines, ["{\"args\": 3}"]);
    let g = got(&tmp);
    assert!(g.stdin == prompt && g.system.as_deref() == Some(system.as_str()));
    assert!(!g.argv.contains(&prompt) && !g.argv.contains(&system));
    assert!(!Path::new(&temp).exists()); // removed once the CLI has ended
    assert_eq!(proc.temp(), None);
}

#[tokio::test]
async fn test_a_short_command_still_gets_no_stdin() {
    let _lock = common::init().await;
    let tmp = common::tmp_path("short-args");
    let script = common::script(&tmp, "echo.sh", ECHO, true);
    let proc = CliProcess::new(
        args(&[&script.to_string_lossy(), "-p", "hello", "--system-prompt", "sys"]),
        &tmp.to_string_lossy(),
        None,
        true,
        None,
    );
    proc.start().await.expect("start");
    let _ = lines_of(&proc).await;
    proc.wait().await.expect("wait");
    let g = got(&tmp);
    assert!(g.stdin.is_empty() && g.argv[..2] == args(&["-p", "hello"])[..]);
    assert_eq!(g.system, None);
}

#[test]
fn test_behind_a_windows_cmd_shim_even_a_short_multiline_prompt_leaves_the_command_line() {
    let prompt = "line one\nline two & more | %PATH%";
    let a = args(&[r"C:\npm\claude.cmd", "-p", prompt, "--system-prompt", "rules\nmore"]);
    let (out, stdin_text, folder) =
        cli::spill_long_args_with(&a, true, true, cli::max_command_chars(true)).expect("spill");
    assert_eq!(stdin_text.as_deref(), Some(prompt));
    assert!(out[1] == "-p" && out.contains(&"--system-prompt-file".to_string()));
    assert!(!out.contains(&prompt.to_string()));
    std::fs::remove_dir_all(folder.expect("a temp folder")).expect("remove");
    // a native claude.exe takes short arguments as they are
    let a = args(&[r"C:\bin\claude.exe", "-p", prompt]);
    assert_eq!(
        cli::spill_long_args_with(&a, true, true, cli::max_command_chars(true)).expect("spill"),
        (a, None, None)
    );
}

/// Not in the Python file: a live run's stdin carries its messages, so only the system prompt moves.
#[tokio::test]
async fn a_live_process_keeps_its_stdin_for_messages_and_moves_only_the_system_prompt() {
    let _lock = common::init().await;
    let tmp = common::tmp_path("live-args");
    let script = common::script(&tmp, "echo.sh", ECHO, true);
    let system = "Rules. ".repeat(100);
    let mut proc = CliProcess::new(
        args(&[&script.to_string_lossy(), "-p", "--system-prompt", &system]),
        &tmp.to_string_lossy(),
        None,
        true,
        Some("Xin chào ✓".to_string()),
    );
    proc.max_command_chars = Some(200);
    proc.start().await.expect("start");
    assert!(proc.live && proc.input_open());
    assert!(proc.send("second").await);
    proc.end_input();
    assert!(!proc.input_open() && !proc.send("third").await);
    let _ = lines_of(&proc).await;
    assert_eq!(proc.wait().await.expect("wait"), 0);
    let g = got(&tmp);
    assert_eq!(g.system.as_deref(), Some(system.as_str()));
    let sent: Vec<serde_json::Value> = g.stdin.lines().map(|l| serde_json::from_str(l).expect("a message")).collect();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["message"]["content"][0]["text"], "Xin chào ✓");
    assert_eq!(
        sent[1],
        serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "second"}]}})
    );
    // as `json.dumps` writes it: ASCII only
    assert!(g.stdin.is_ascii() && g.stdin.starts_with("{\"type\": \"user\", \"message\": {\"role\": \"user\", "));
}
