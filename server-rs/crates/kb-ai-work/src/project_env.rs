//! The environment a project's commands run in (design/screens/ai-repo-commands.md, D3). Port of
//! `services/ai/project_env.py`.
//!
//! An app opened from the Dock or Finder starts with a short PATH (`/usr/bin:/bin:/usr/sbin:/sbin`): it does not see
//! Homebrew, nvm, Volta or `~/.local/bin`, so `npm` or `uv` are "not found" although the person has them. A
//! project keeps a list of extra folders (`ops.env_path`) that go in front of the PATH for everything the project
//! runs: the wizard's trial, a ticket's prepare command, the workflow checks and the AI members' own runs. Other projects
//! and the app itself keep their own PATH.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use kb_base::{pyjson, pypath, pytext};
use kb_db::entities::ai_project_settings;
use regex::Regex;
use serde_json::{Value, json};

/// Where command-line tools are usually installed, beyond what a short PATH has. Globs are expanded newest first
/// (nvm keeps one folder per Node version).
pub const TOOL_DIRS: [&str; 20] = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "~/.local/bin",
    "~/.cargo/bin",
    "~/.volta/bin",
    "~/.bun/bin",
    "~/.deno/bin",
    "~/.npm-global/bin",
    "~/.yarn/bin",
    "~/.pyenv/shims",
    "~/.rbenv/shims",
    "~/.asdf/shims",
    "~/.local/share/mise/shims",
    "~/.local/share/pnpm",
    "~/Library/pnpm",
    "~/go/bin",
    "/usr/local/go/bin",
    "~/.nvm/versions/node/*/bin",
    "~/.local/share/fnm/node-versions/*/installation/bin",
];

/// Words a shell line starts a segment with that are not a program to look for.
pub const NOT_PROGRAMS: [&str; 23] = [
    "cd", "export", "set", "true", "false", "exit", "test", "[", "if", "then", "else", "fi", "for", "do", "done",
    "while", "echo", "env", "time", "nice", "sudo", "source", ".",
];

fn is_not_program(word: &str) -> bool {
    NOT_PROGRAMS.contains(&word)
}

/// `os.pathsep`.
fn pathsep() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

/// The project's extra PATH folders (`ops.env_path`), cleaned: strings, no empties, no repeats.
pub fn extra(settings: Option<&ai_project_settings::Model>) -> Vec<String> {
    let cfg = kb_ai::ops::get(settings);
    let raw = cfg.get("env_path").cloned().unwrap_or(Value::Null);
    // `ops.get(settings).get("env_path") or []`
    let Value::Array(items) = raw else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in &items {
        // `str(p or "").strip()` is the test, `str(p).strip()` the value
        if !pyjson::truthy(item) {
            continue;
        }
        let text = match item {
            Value::String(s) => s.clone(),
            other => pyjson::py_str(other),
        };
        let text = pytext::strip(&text).to_string();
        if text.is_empty() || out.contains(&text) {
            continue;
        }
        out.push(text);
    }
    out
}

/// A copy of `base` (default: this process's environment) with `folders` in front of its PATH.
pub fn with_path(base: Option<&HashMap<String, String>>, folders: Option<&[String]>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = match base {
        Some(base) => base.clone(),
        None => std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect(),
    };
    let Some(folders) = folders.filter(|f| !f.is_empty()) else {
        return env;
    };
    let front = folders.iter().map(|f| pypath::expanduser(f));
    let current = env.get("PATH").cloned().unwrap_or_default();
    let rest = current.split(pathsep()).filter(|p| !p.is_empty()).map(str::to_string);
    let mut joined: Vec<String> = Vec::new();
    for part in front.chain(rest) {
        if !joined.contains(&part) {
            joined.push(part);
        }
    }
    env.insert("PATH".to_string(), joined.join(&pathsep().to_string()));
    env
}

static SEGMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&&|\|\||[;|&\n()]").expect("a fixed pattern"));
static ASSIGNMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").expect("a fixed pattern"));

/// The programs a shell line runs: the first word of each segment (`npm --prefix ui ci && uv sync` → npm, uv).
/// Variable assignments (`PATH=… npm`) and plain shell words are skipped.
pub fn programs(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for seg in SEGMENTS.split(command) {
        let mut words = pytext::split(pytext::strip(seg));
        while words.first().is_some_and(|w| ASSIGNMENT.is_match(w)) {
            words.remove(0);
        }
        let Some(first) = words.first() else {
            continue;
        };
        let word = first.trim_matches(['\'', '"']);
        if word.is_empty() || is_not_program(word) {
            continue;
        }
        if word.contains('/') {
            // a path: ./gradlew, bin/test — nothing to look for
            continue;
        }
        if !out.iter().any(|w| w == word) {
            out.push(word.to_string());
        }
    }
    out
}

/// `_version_key`: the first three numbers after the last `versions` in the path.
pub fn version_key(path: &str) -> Vec<u64> {
    static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").expect("a fixed pattern"));
    let tail = path.rsplit_once("versions").map_or(path, |(_, tail)| tail);
    DIGITS.find_iter(tail).take(3).map(|m| m.as_str().parse::<u64>().unwrap_or(u64::MAX)).collect()
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The folders of `TOOL_DIRS` that exist, a glob expanded newest first.
pub fn candidates() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for pattern in TOOL_DIRS {
        let path = pypath::expanduser(pattern);
        if let Some((base, tail)) = path.split_once('*') {
            let parent = PathBuf::from(base);
            if parent.is_dir() {
                // `parent.glob("*" + tail)`: every entry of the parent, then the rest of the pattern below it
                let mut found: Vec<PathBuf> = std::fs::read_dir(&parent)
                    .map(|entries| {
                        entries
                            .filter_map(Result::ok)
                            .map(|e| {
                                let mut p = e.path();
                                for part in tail.split('/').filter(|s| !s.is_empty()) {
                                    p.push(part);
                                }
                                p
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                // the scan order is the system's; the names make the order of equal versions certain
                found.sort_by_key(|p| path_text(p));
                // `sorted(..., reverse=True)` keeps equal elements in their order
                found.sort_by(|a, b| version_key(&path_text(b)).cmp(&version_key(&path_text(a))));
                dirs.extend(found.into_iter().filter(|p| p.is_dir()));
            }
        } else if Path::new(&path).is_dir() {
            dirs.push(PathBuf::from(path));
        }
    }
    dirs
}

/// `os.access(path, os.X_OK)` for a regular file: some execute bit is set.
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// `shutil.which(program, path=path)`.
pub fn which(program: &str, path: &str) -> Option<String> {
    let ok = |candidate: &Path| candidate.exists() && is_executable(candidate) && !candidate.is_dir();
    if !pypath::dirname(program).is_empty() {
        return ok(Path::new(program)).then(|| program.to_string());
    }
    if path.is_empty() {
        return None;
    }
    let mut seen: Vec<&str> = Vec::new();
    for dir in path.split(pathsep()) {
        if seen.contains(&dir) {
            continue;
        }
        seen.push(dir);
        let candidate = pypath::join(dir, program);
        if ok(Path::new(&candidate)) {
            return Some(candidate);
        }
    }
    None
}

/// The folder that holds `program` when it is not on `path`; None when it is on it, or nowhere to be found.
pub fn find(program: &str, path: &str) -> Option<String> {
    if which(program, path).is_some() {
        return None;
    }
    for folder in candidates() {
        let cand = folder.join(program);
        if cand.is_file() && is_executable(&cand) {
            return Some(folder.to_string_lossy().into_owned());
        }
    }
    None
}

/// For each program the commands run that `path` does not have, the folder where it is:
/// `[{"path": "/opt/homebrew/bin", "program": "npm"}]`. A program found nowhere is left out (the trial then says
/// "command not found", which is the truth).
pub fn missing_folders(commands: &[String], path: &str) -> Vec<Value> {
    let mut out: Vec<(String, String)> = Vec::new();
    for cmd in commands {
        for prog in programs(cmd) {
            if let Some(folder) = find(&prog, path) {
                if !out.iter().any(|(f, _)| *f == folder) {
                    out.push((folder, prog));
                }
            }
        }
    }
    out.into_iter().map(|(path, program)| json!({"path": path, "program": program})).collect()
}
