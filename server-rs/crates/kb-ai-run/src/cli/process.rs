//! Process control: stopping and pausing a CLI with everything it started, telling a leftover CLI from a reused
//! pid, and moving long arguments off the command line.
//!
//! How a CLI is kept from outliving the board. It is started as the leader of a process group of its own
//! (`popen_kwargs`), so one signal reaches it and all it started. `kill_tree` wakes the group (SIGCONT), asks it to end
//! (SIGTERM) and kills what is left two seconds later (SIGKILL, from a timer thread). `running::CliProcess` does the
//! rest: it reaps the CLI, ends what the CLI left in its group, and stops the tree when it is dropped.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::LOCAL_CLIS;

/// How long after SIGTERM whatever is left of a process group is killed (`threading.Timer(2.0, _force)`), in
/// milliseconds.
static KILL_GRACE_MS: AtomicU64 = AtomicU64::new(2000);

/// Change the wait between SIGTERM and SIGKILL in `kill_tree` (tests shorten it; 2 seconds otherwise).
pub fn set_kill_grace(seconds: f64) {
    KILL_GRACE_MS.store((seconds.max(0.0) * 1000.0) as u64, Ordering::SeqCst);
}

/// The wait between SIGTERM and SIGKILL in `kill_tree`, in seconds.
pub fn kill_grace() -> f64 {
    KILL_GRACE_MS.load(Ordering::SeqCst) as f64 / 1000.0
}

/// Stop a process and everything it started (its process group); safe on an already-dead pid.
pub fn kill_tree(pid: Option<i32>) {
    let Some(pid) = pid.filter(|pid| *pid != 0) else { return };
    kill_tree_of(pid);
}

#[cfg(unix)]
fn kill_tree_of(pid: i32) {
    use nix::sys::signal::{Signal, kill, killpg};
    use nix::unistd::{Pid, getpgid};
    let Ok(pgid) = getpgid(Some(Pid::from_raw(pid))) else { return };
    if getpgid(None).is_ok_and(|own| own == pgid) {
        // never our own group
        let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
        return;
    }
    // a paused run must wake up to see the SIGTERM
    if killpg(pgid, Signal::SIGCONT).is_err() || killpg(pgid, Signal::SIGTERM).is_err() {
        return;
    }
    // Whatever ignored SIGTERM is killed 2 s later, without blocking the event loop
    let grace = Duration::from_millis(KILL_GRACE_MS.load(Ordering::SeqCst));
    let timer = std::thread::Builder::new().name("kill-tree".into()).spawn(move || {
        std::thread::sleep(grace);
        let _ = killpg(pgid, Signal::SIGKILL);
    });
    if timer.is_err() {
        // no thread to wait on: do not leave the tree to its own will
        let _ = killpg(pgid, Signal::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_tree_of(pid: i32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .output();
}

/// Whether a run's CLI can be paused on this computer (a stopped process group needs POSIX signals).
pub fn can_pause() -> bool {
    !cfg!(windows)
}

/// Pause (SIGSTOP) or continue (SIGCONT) a process and everything it started; False when it is gone.
pub fn suspend_tree(pid: Option<i32>, stop: bool) -> bool {
    let Some(pid) = pid.filter(|pid| *pid != 0) else { return false };
    if !can_pause() {
        return false;
    }
    suspend_tree_of(pid, stop)
}

#[cfg(unix)]
fn suspend_tree_of(pid: i32, stop: bool) -> bool {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::{Pid, getpgid};
    let Ok(pgid) = getpgid(Some(Pid::from_raw(pid))) else { return false };
    if getpgid(None).is_ok_and(|own| own == pgid) {
        // never stop our own group
        return false;
    }
    killpg(pgid, if stop { Signal::SIGSTOP } else { Signal::SIGCONT }).is_ok()
}

#[cfg(windows)]
fn suspend_tree_of(_pid: i32, _stop: bool) -> bool {
    false
}

/// `subprocess.run(argv, capture_output=True, timeout=seconds, check=False).stdout`, or None when the program cannot
/// be started or does not answer in time.
fn capture_stdout(argv: &[&str], seconds: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let (program, rest) = argv.split_first()?;
    let mut child = std::process::Command::new(program)
        .args(rest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}

/// The command line of a process, or None when it cannot be read.
fn command_line(pid: i64) -> Option<String> {
    #[cfg(windows)]
    {
        // No /proc on Windows: ask for the process's command line (once per leftover run, at startup)
        let ask = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
        let out = capture_stdout(&["powershell", "-NoProfile", "-Command", &ask], 15)?;
        Some(String::from_utf8_lossy(&out).into_owned())
    }
    #[cfg(not(windows))]
    {
        match std::fs::read(format!("/proc/{pid}/cmdline")) {
            Ok(raw) => {
                let raw: Vec<u8> = raw.into_iter().map(|b| if b == 0 { b' ' } else { b }).collect();
                Some(String::from_utf8_lossy(&raw).into_owned())
            }
            Err(_) => {
                // no /proc (macOS, BSD): ask ps for the command line
                let out = capture_stdout(&["ps", "-o", "command=", "-p", &pid.to_string()], 10)?;
                Some(String::from_utf8_lossy(&out).into_owned())
            }
        }
    }
}

/// Whether a command line is one of our CLI processes: it names the CLI and one of the output-format flags.
pub fn command_looks_like_cli(cmd: &str, binary: Option<&str>) -> bool {
    let named = match binary.filter(|b| !b.is_empty()) {
        Some(binary) => cmd.contains(binary),
        None => LOCAL_CLIS.iter().any(|n| cmd.contains(n)),
    };
    named && ["--output-format", "--json", "--format"].iter().any(|f| cmd.contains(f))
}

/// Is `pid` still one of our CLI processes? Used before killing a run left over from a crash, so a reused
/// pid is never killed by mistake.
pub fn looks_like_cli(pid: i64, binary: Option<&str>) -> bool {
    command_line(pid).is_some_and(|cmd| command_looks_like_cli(&cmd, binary))
}

// Windows runs the CLI through its `claude.cmd` shim, and cmd.exe refuses a command line over 8191 characters
// ("The command line is too long", exit 1); CreateProcess itself stops at 32767 (WinError 206). Linux and macOS
// cap one argument at 128 KB. A long ticket or chat history in the prompt or system prompt goes over, so past
// these sizes they travel by stdin and a file instead. Through that shim they always do: cmd.exe cuts an argument at
// its first line break (the CLI then exits 0 without an answer) and reads `&`, `|` and `%` in it as commands.
/// The longest command line that stays as it is (`_MAX_COMMAND_CHARS`), for Windows or not.
pub const fn max_command_chars(windows: bool) -> usize {
    if windows { 6000 } else { 100_000 }
}

/// flag -> the flag that takes the same text from a file
const FILE_FLAGS: [(&str, &str); 2] =
    [("--system-prompt", "--system-prompt-file"), ("--append-system-prompt", "--append-system-prompt-file")];

/// Whether Windows starts this command through cmd.exe (a `.cmd` or `.bat` shim such as npm's claude.cmd).
fn through_cmd_exe(args: &[String], windows: bool) -> bool {
    windows
        && args.first().is_some_and(|first| {
            let lower = first.to_lowercase();
            lower.ends_with(".cmd") || lower.ends_with(".bat")
        })
}

/// `subprocess.list2cmdline(args)`: the command line as the Microsoft C runtime reads it back.
pub fn list2cmdline(args: &[String]) -> String {
    let mut result = String::new();
    for arg in args {
        let mut backslashes = 0usize;
        if !result.is_empty() {
            result.push(' ');
        }
        let needquote = arg.contains(' ') || arg.contains('\t') || arg.is_empty();
        if needquote {
            result.push('"');
        }
        for c in arg.chars() {
            if c == '\\' {
                // Don't know if we need to double yet.
                backslashes += 1;
            } else if c == '"' {
                // Double backslashes.
                result.push_str(&"\\".repeat(backslashes * 2));
                backslashes = 0;
                result.push_str("\\\"");
            } else {
                // Normal char
                result.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                result.push(c);
            }
        }
        // Add remaining backslashes, if any.
        result.push_str(&"\\".repeat(backslashes));
        if needquote {
            result.push_str(&"\\".repeat(backslashes));
            result.push('"');
        }
    }
    result
}

/// Move a long prompt and system prompt off the command line.
///
/// Returns (args to run, text for stdin or None, temp folder holding the system prompt file or None). Short commands
/// come back unchanged, except behind a Windows `.cmd` shim. `-p <text>` becomes a bare `-p` (the CLI then reads the
/// prompt from stdin); `--system-prompt <text>` becomes `--system-prompt-file <path>`. `prompt_on_stdin=False` (a live
/// run: its stdin carries stream-json and `-p` takes no text) moves only the system prompts.
pub fn spill_long_args(
    args: &[String],
    prompt_on_stdin: bool,
) -> std::io::Result<(Vec<String>, Option<String>, Option<String>)> {
    spill_long_args_with(args, prompt_on_stdin, cfg!(windows), max_command_chars(cfg!(windows)))
}

/// `spill_long_args` for a platform (`windows`) and a longest command line given (the Python tests set
/// `cli.sys.platform` and `cli._MAX_COMMAND_CHARS`).
pub fn spill_long_args_with(
    args: &[String],
    prompt_on_stdin: bool,
    windows: bool,
    max_chars: usize,
) -> std::io::Result<(Vec<String>, Option<String>, Option<String>)> {
    if !through_cmd_exe(args, windows)
        // counted in bytes: Linux limits one argument to 128 KB, and a character may take up to four
        && list2cmdline(args).len() <= max_chars
    {
        return Ok((args.to_vec(), None, None));
    }
    let mut out = args.to_vec();
    let mut stdin_text: Option<String> = None;
    let mut folder: Option<String> = None;
    let prompt_flag = if prompt_on_stdin { Some(("-p", None)) } else { None };
    for (flag, file_flag) in prompt_flag.into_iter().chain(FILE_FLAGS.iter().map(|(flag, file)| (*flag, Some(*file)))) {
        let Some(i) = out.iter().position(|a| a == flag).filter(|i| i + 1 < out.len()) else { continue };
        let text = out[i + 1].clone();
        let Some(file_flag) = file_flag else {
            stdin_text = Some(text);
            out.remove(i + 1);
            continue;
        };
        let dir = match &folder {
            Some(dir) => dir.clone(),
            None => {
                let made = tempfile::Builder::new().prefix("kanban-cli-").tempdir()?.keep();
                let made = made.to_string_lossy().into_owned();
                folder = Some(made.clone());
                made
            }
        };
        let path = kb_base::pypath::join(&dir, &format!("{}.txt", flag.trim_start_matches('-')));
        std::fs::write(&path, text)?;
        out.splice(i..i + 2, [file_flag.to_string(), path]);
    }
    Ok((out, stdin_text, folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list2cmdline_quotes_as_the_c_runtime_reads() {
        let args = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(list2cmdline(&args(&["a b", "c", ""])), "\"a b\" c \"\"");
        assert_eq!(list2cmdline(&args(&["a\\b", "a\\\"b", "end\\"])), "a\\b a\\\\\\\"b end\\");
        assert_eq!(list2cmdline(&args(&["sp ace\\"])), "\"sp ace\\\\\"");
    }
}
