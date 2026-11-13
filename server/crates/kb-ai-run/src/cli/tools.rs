//! Claude Code stream-json → run steps: what one tool call of the CLI is called in the list of steps, and what a tool
//! result says (test counts, plain text).

use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use kb_base::{pyjson, pytext};
use regex::Regex;
use serde_json::{Map, Value, json};

/// Where the Python code raises (`TypeError`, `AttributeError`) because a value of the CLI's JSON has a type the
/// code does not expect: the text says what. Python lets it end the run's reading loop; so does the caller here.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Raised(pub String);

pub(crate) fn raised<T>(what: impl Into<String>) -> Result<T, Raised> {
    Err(Raised(what.into()))
}

static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);

/// An event's `message` when it is an object; a CLI may print one as plain text, which holds no blocks.
pub fn message_of(ev: &Value) -> &Map<String, Value> {
    match ev.get("message") {
        Some(Value::Object(msg)) => msg,
        _ => &EMPTY,
    }
}

/// `message_of` for an event already known to be an object.
pub(crate) fn message_of_map(ev: &Map<String, Value>) -> &Map<String, Value> {
    match ev.get("message") {
        Some(Value::Object(msg)) => msg,
        _ => &EMPTY,
    }
}

/// `value or ""` as text for a call that needs a `str` (`split`, `splitlines`): a false value is the empty text, a
/// true one that is not text raises.
pub(crate) fn text_or_empty<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a str, Raised> {
    match value {
        Some(Value::String(s)) => Ok(s),
        Some(other) if pyjson::truthy(other) => raised(format!("AttributeError: {what} is not text")),
        _ => Ok(""),
    }
}

/// `_short(text, n)`: one line, cut to `n` characters with an ellipsis.
pub fn short(text: &str, n: usize) -> String {
    let text = pytext::squash(text);
    if text.chars().count() <= n {
        return text;
    }
    let mut cut: String = text.chars().take(n.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// `Path(path).resolve()`: absolute, without `.`, `..` or symbolic links; a part that does not exist is kept as
/// written. (`kb_base::pypath::realpath` is the same walk, for async callers.)
fn resolve(path: &str) -> PathBuf {
    let start = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut todo: Vec<std::ffi::OsString> = Vec::new();
    let mut resolved = PathBuf::new();
    let push_parts = |todo: &mut Vec<std::ffi::OsString>, resolved: &mut PathBuf, path: &Path| {
        let mut parts = Vec::new();
        for part in path.components() {
            match part {
                Component::Prefix(_) | Component::RootDir => {
                    *resolved = PathBuf::from(part.as_os_str());
                    parts.clear();
                }
                Component::CurDir => {}
                other => parts.push(other.as_os_str().to_os_string()),
            }
        }
        todo.extend(parts.into_iter().rev());
    };
    push_parts(&mut todo, &mut resolved, &start);
    // a loop of links ends here, as the kernel's limit ends it for Python
    let mut links_left = 40;
    while let Some(part) = todo.pop() {
        if part == ".." {
            resolved.pop();
            continue;
        }
        let candidate = resolved.join(&part);
        let target = match std::fs::symlink_metadata(&candidate) {
            Ok(meta) if meta.file_type().is_symlink() && links_left > 0 => std::fs::read_link(&candidate).ok(),
            _ => None,
        };
        match target {
            Some(target) => {
                links_left -= 1;
                push_parts(&mut todo, &mut resolved, &target);
            }
            None => resolved = candidate,
        }
    }
    resolved
}

/// `_rel(path, cwd)`: the path as seen from the run's folder, or as it is when it lies outside.
pub fn rel(path: &str, cwd: &str) -> String {
    if path.contains('\0') || cwd.contains('\0') {
        return path.to_string(); // ValueError: embedded null byte
    }
    let (full, base) = (resolve(path), resolve(cwd));
    match full.strip_prefix(&base) {
        Ok(inside) if inside.as_os_str().is_empty() => ".".to_string(),
        Ok(inside) => inside.to_string_lossy().into_owned(),
        Err(_) => path.to_string(),
    }
}

/// `inp.get("file_path", "")` given to `Path(...)`: text, or a `TypeError`.
fn file_path(inp: &Map<String, Value>) -> Result<&str, Raised> {
    match inp.get("file_path") {
        None => Ok(""),
        Some(Value::String(s)) => Ok(s),
        Some(_) => raised("TypeError: file_path is not text"),
    }
}

/// `len((value or "").splitlines())`.
fn line_count(value: Option<&Value>, what: &str) -> Result<usize, Raised> {
    Ok(pytext::splitlines(text_or_empty(value, what)?).len())
}

/// (kind, text, file change) for one tool call of the CLI.
pub fn describe_tool(
    name: &str,
    inp: &Map<String, Value>,
    cwd: &str,
) -> Result<(String, String, Option<Value>), Raised> {
    if name == "Edit" || name == "MultiEdit" {
        let path = rel(file_path(inp)?, cwd);
        let (mut added, mut removed) = (0usize, 0usize);
        let mut count = |e: &Value| -> Result<(), Raised> {
            let Value::Object(e) = e else { return raised("AttributeError: an edit is not an object") };
            added += line_count(e.get("new_string"), "new_string")?;
            removed += line_count(e.get("old_string"), "old_string")?;
            Ok(())
        };
        match inp.get("edits").filter(|v| pyjson::truthy(v)) {
            Some(Value::Array(edits)) => {
                // `sum(... new_string ...)` runs over every edit before `sum(... old_string ...)`: only which error
                // comes first could differ, and both are the same error
                for e in edits {
                    count(e)?;
                }
            }
            Some(_) => return raised("TypeError: edits is not a list of objects"),
            None => count(&Value::Object(inp.clone()))?,
        }
        let change = json!({"path": path, "added": added, "removed": removed, "new": false});
        return Ok(("edit".into(), format!("Edited {path}"), Some(change)));
    }
    if name == "Write" {
        let path = rel(file_path(inp)?, cwd);
        let added = line_count(inp.get("content"), "content")?;
        let change = json!({"path": path, "added": added, "removed": 0, "new": true});
        return Ok(("create".into(), format!("Wrote {path}"), Some(change)));
    }
    if name == "Read" {
        return Ok(("read".into(), format!("Read {}", rel(file_path(inp)?, cwd)), None));
    }
    // `inp.get(key, "")` given to `_short`: a missing key is "", a false value too, a true one must be text
    if name == "Bash" {
        return Ok((
            "command".into(),
            format!("Ran {}", short(text_or_empty(inp.get("command"), "command")?, 120)),
            None,
        ));
    }
    if name == "Grep" || name == "Glob" {
        let pattern = short(text_or_empty(inp.get("pattern"), "pattern")?, 80);
        return Ok(("search".into(), format!("Searched {pattern}"), None));
    }
    let truthy = |key: &str| inp.get(key).filter(|v| pyjson::truthy(v));
    if name == "Skill" {
        if let Some(skill) = truthy("skill") {
            return Ok(("skill".into(), format!("Used the skill {}", short(&pyjson::py_str(skill), 80)), None));
        }
    }
    if name == "Task" || name == "Agent" {
        let who = truthy("subagent_type").map_or_else(|| "a subagent".to_string(), pyjson::py_str);
        let what = truthy("description").or_else(|| truthy("prompt")).map(pyjson::py_str).unwrap_or_default();
        return Ok(("subagent".into(), short(&format!("Asked {who}: {what}"), 160), None));
    }
    if name.starts_with("mcp__") {
        let tool = name.split("__").last().unwrap_or("");
        let mut label: Vec<&str> = Vec::new();
        if !tool.is_empty() {
            label.push(tool);
        }
        for key in ["item", "action"] {
            match truthy(key) {
                Some(Value::String(s)) => label.push(s),
                Some(_) => return raised(format!("TypeError: {key} is not text")),
                None => {}
            }
        }
        let target = truthy("ticket_id").or_else(|| truthy("project_id")).map(pyjson::py_str).unwrap_or_default();
        return Ok(("board".into(), format!("board.{}({target})", label.join(".")), None));
    }
    let dumped: String = pyjson::dumps(&Value::Object(inp.clone())).chars().take(200).collect();
    Ok(("tool".into(), format!("{name} {}", short(&dumped, 80)), None))
}

static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("\x1b\\[[0-9;?]*[A-Za-z]").expect("the colour pattern compiles"));

/// Text without terminal colour codes (pytest colours its summary: "\x1b[32m6 passed\x1b[0m").
pub fn strip_ansi(text: &str) -> String {
    ANSI.replace_all(text, "").into_owned()
}

static PASSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b([0-9]+) (?:passed|passing)\b").expect("the pattern compiles"));
static FAILED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b([0-9]+) (?:failed|failing)\b").expect("the pattern compiles"));
static FAILING_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(?:FAILED|FAIL|✗|×)\s+(\S.{0,120})$").expect("the pattern compiles"));

/// `int(text)` of a run of digits, as a JSON number (a count no test run reaches becomes a float).
fn count_of(text: &str) -> Value {
    text.parse::<u64>().map_or_else(|_| json!(text.parse::<f64>().unwrap_or(0.0)), |n| json!(n))
}

/// Pass and fail counts read from a test command's output (pytest, jest, vitest, mocha, ...), or None when the
/// output does not look like a test run.
pub fn parse_tests(output: &str) -> Option<Value> {
    // a colour code right before the count leaves no word boundary
    let output = strip_ansi(output);
    let passed = PASSED.captures_iter(&output).last().map(|c| count_of(&c[1]));
    let failed = FAILED.captures_iter(&output).last().map(|c| count_of(&c[1]));
    if passed.is_none() && failed.is_none() {
        return None;
    }
    let failing: Vec<&str> = FAILING_NAME
        .captures_iter(&output)
        .filter_map(|c| c.get(1))
        .map(|m| pytext::strip(m.as_str()))
        .take(5)
        .collect();
    Some(json!({"passed": passed.unwrap_or(json!(0)), "failed": failed.unwrap_or(json!(0)), "failing": failing}))
}

/// `_result_text(content)`: the text of a tool result, whose content is text or a list of text blocks.
pub fn result_text(content: Option<&Value>) -> Result<String, Raised> {
    match content {
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<&str> = Vec::new();
            for block in blocks {
                if let Value::Object(block) = block {
                    match block.get("text") {
                        None => parts.push(""),
                        Some(Value::String(s)) => parts.push(s),
                        Some(_) => return raised("TypeError: the text of a result block is not text"),
                    }
                }
            }
            Ok(parts.join("\n"))
        }
        Some(other) if pyjson::truthy(other) => Ok(pyjson::py_str(other)),
        _ => Ok(String::new()),
    }
}
