//! What the sign-in window says besides the terminal: the status bar's reading of the CLI's latest output, and the
//! command a person runs by hand when no terminal can be opened.

use std::path::Path;
use std::sync::LazyLock;

use kb_ai::profiles::Env;
use kb_base::{pypath, pytext};
use regex::Regex;

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("\x1b\\[[0-9;?]*[A-Za-z]|\x1b\\][^\x07]*\x07|\x1b[()][A-Z0-9]").expect("the escape pattern compiles")
});
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("https?://[^\\s\x1b\"'<>)]+").expect("the link pattern compiles"));

/// What the status bar says the CLI is waiting for, and the last link it printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    /// waiting | error | trust_folder | paste_code | choose_method | browser
    pub phase: &'static str,
    /// The last link on the screen.
    pub url: Option<String>,
}

fn found(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).expect("a pattern written in the code compiles").is_match(text)
}

/// Best-effort reading of the CLI's latest output: what it is waiting for and the last link it printed.
///
/// The terminal stays fully usable whatever this says; it only decides which sentence the status bar shows.
pub fn read_screen(text: &str, signed_in: bool) -> Screen {
    let clean = ANSI.replace_all(text, "").replace('\r', "\n");
    let count = clean.chars().count();
    let tail: String = clean.chars().skip(count.saturating_sub(2500)).collect();
    let lines: Vec<&str> =
        pytext::splitlines(&tail).into_iter().map(pytext::strip).filter(|ln| !ln.is_empty()).collect();
    let last = &lines[lines.len().saturating_sub(6)..];
    let recent = last.join("\n").to_lowercase();
    let urls: Vec<&str> = URL.find_iter(&tail).map(|m| m.as_str()).collect();
    let mut phase = "waiting";
    // the newest lines decide: an old prompt above a rejection no longer counts
    let newest = last[last.len().saturating_sub(2)..].join("\n").to_lowercase();
    if found("invalid|expired|rejected|denied|failed|error", &newest) {
        phase = "error";
    } else if found("do you trust|trust the files|trust this folder", &recent) {
        phase = "trust_folder";
    } else if found("(paste|enter|type).{0,40}(code|token)|authorization code", &recent) && !signed_in {
        phase = "paste_code";
    } else if found("select .{0,20}method|login method|choose .{0,20}(method|how)", &recent) {
        phase = "choose_method";
    } else if !urls.is_empty() && !signed_in {
        phase = "browser";
    } else if found("invalid|expired|rejected|denied|failed", &recent) {
        phase = "error";
    }
    Screen { phase, url: urls.last().map(|u| u.to_string()) }
}

/// `shlex.quote(s)`.
pub fn shlex_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    let safe = |c: char| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c);
    if s.chars().all(safe) {
        return s.to_string();
    }
    // use single quotes, and put single quotes into double quotes
    // the string $'b is then quoted as '$'"'"'b'
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// `fallback_command` once the profile gave the command, its variables and its folder; `windows` picks PowerShell.
pub fn fallback_text(argv: &[String], env: &Env, cwd: Option<&Path>, windows: bool) -> String {
    let mut argv = argv.to_vec();
    if let Some(first) = argv.first_mut() {
        *first = pypath::basename(first).to_string();
    }
    if windows {
        return powershell(&argv, env, cwd);
    }
    let prefix = env.iter().map(|(k, v)| format!("{k}={}", shlex_quote(v))).collect::<Vec<_>>().join(" ");
    let cmd = argv.iter().map(|a| shlex_quote(a)).collect::<Vec<_>>().join(" ");
    if let Some(cwd) = cwd.filter(|c| !c.as_os_str().is_empty()) {
        let run = if prefix.is_empty() { cmd } else { format!("env {prefix} {cmd}") };
        return format!("cd {} && {run}", shlex_quote(&cwd.to_string_lossy()));
    }
    pytext::strip(&format!("{prefix} {cmd}")).to_string()
}

/// A PowerShell string literal: single quotes, a quote inside doubled.
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The sign-in command for PowerShell (the Windows Terminal default): the account's variables, its folder, then
/// the login. `&` runs a quoted program name.
pub fn powershell(argv: &[String], env: &Env, cwd: Option<&Path>) -> String {
    let mut parts: Vec<String> = env.iter().map(|(k, v)| format!("$env:{k}={}", ps_quote(v))).collect();
    if let Some(cwd) = cwd.filter(|c| !c.as_os_str().is_empty()) {
        parts.push(format!("Set-Location {}", ps_quote(&cwd.to_string_lossy())));
    }
    let first = argv.first().map(String::as_str).unwrap_or("");
    let program = if found(r"^[\w.-]+$", first) { first.to_string() } else { format!("& {}", ps_quote(first)) };
    let mut command = vec![program];
    command.extend(argv.iter().skip(1).cloned());
    parts.push(command.join(" "));
    parts.join("; ")
}
