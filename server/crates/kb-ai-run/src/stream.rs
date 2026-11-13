//! Claude Code's `--output-format stream-json` → step rows (AI v2) (`services/ai/stream.py`).
//!
//! Every event may belong to the lead or to a subagent (`parent_tool_use_id`, the lead's Agent tool call that started
//! it). The parser keeps which Agent call started which role, so a step says who did it; the lead's final `result`
//! carries the structured report (`--json-schema`); messages between sessions and hook events become steps too.
//!
//! The rows, agents and results are JSON objects with the keys of the Python dicts, in their order: they go to
//! `kb_ai::steps` as they are. Where the Python parser raises on a value of an unexpected type (a number where the
//! CLI writes text), `parse` gives `Err(Raised)`; Python lets that end the reading of the run.

use std::collections::HashMap;
use std::sync::LazyLock;

use chrono::{Datelike, TimeZone, Utc};
use kb_ai::quota;
use kb_ai::store::py_int;
use kb_base::secrets::redact;
use kb_base::{pyjson, pytext, time};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::cli::{self, Raised, raised};

static CROSS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<cross-session-message\s+from="([^"]*)"[^>]*>(.*?)</cross-session-message>"#)
        .expect("the message pattern compiles")
});
static EXIT_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Exit code ([0-9]+)").expect("the exit code pattern compiles"));
const TASK_ENDED: [&str; 4] = ["completed", "failed", "killed", "stopped"];
/// the CLI loading its own deferred tools: not a step of the work
const RELAY_TOOLS: [&str; 1] = ["ToolSearch"];

/// What one line of the stream gave (the dict `Parser.parse` returns).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    /// Step rows: `{kind, title, tool?, detail?, output?, agent_id, tool_id?, parent_tool_id?}`.
    pub rows: Vec<Value>,
    /// Subagents seen or changed: `{id | claude_id, agent_type?, reopen?, ended?, at?, last_text?}`.
    pub agents: Vec<Value>,
    /// Background tasks that started or ended: `{id, type, event}`.
    pub tasks: Vec<Value>,
    /// File changes: `{path, added, removed, new}`.
    pub files: Vec<Value>,
    /// Tool results: `{tool_id, output, is_error, exit_code, tests, agent_id}`.
    pub results: Vec<Value>,
    /// The lead's final result, or None.
    pub result: Option<Value>,
    /// The session id an `init` or a `result` names (whatever the CLI wrote; null otherwise).
    pub session_id: Value,
    /// The CLI said it is ready (`init`).
    pub ready: bool,
    /// The model `init` names.
    pub model: Value,
    /// Tokens the lead's context holds after this message.
    pub context_used: Option<Value>,
    /// The largest context window the `result` names.
    pub context_window: Option<Value>,
    /// A reading of the account's usage windows (`quota.parse_event`).
    pub rate_limit: Option<Map<String, Value>>,
    /// Messages from other sessions: `{peer, text, agent_id}`.
    pub messages_in: Vec<Value>,
    /// Messages sent to other sessions: `{peer, text, agent_id}`.
    pub messages_out: Vec<Value>,
    /// What `init` loaded: `{agents, plugins, tools}`.
    pub init: Option<Value>,
}

impl Parsed {
    /// The dict of the Python parser, keys in its order.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("rows".into(), json!(self.rows));
        out.insert("agents".into(), json!(self.agents));
        out.insert("tasks".into(), json!(self.tasks));
        out.insert("files".into(), json!(self.files));
        out.insert("results".into(), json!(self.results));
        out.insert("result".into(), json!(self.result));
        out.insert("session_id".into(), self.session_id.clone());
        out.insert("ready".into(), json!(self.ready));
        out.insert("model".into(), self.model.clone());
        out.insert("context_used".into(), json!(self.context_used));
        out.insert("context_window".into(), json!(self.context_window));
        out.insert("rate_limit".into(), json!(self.rate_limit));
        out.insert("messages_in".into(), json!(self.messages_in));
        out.insert("messages_out".into(), json!(self.messages_out));
        out.insert("init".into(), json!(self.init));
        Value::Object(out)
    }
}

/// `ev.get(key)`: null when the key is missing.
fn get(map: &Map<String, Value>, key: &str) -> Value {
    map.get(key).cloned().unwrap_or(Value::Null)
}

/// `ev.get(key)` when it is truthy.
fn truthy<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key).filter(|v| pyjson::truthy(v))
}

/// `value or {}` followed by `.get(...)`: the object, an empty one for a false value, a raise for anything else.
fn dict_or_empty<'a>(value: Option<&'a Value>, what: &str) -> Result<Option<&'a Map<String, Value>>, Raised> {
    match value {
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(other) if pyjson::truthy(other) => raised(format!("AttributeError: {what} is not an object")),
        _ => Ok(None),
    }
}

/// `for x in value or []`: the items of a list. Text and objects are iterated too in Python (characters, keys), which
/// are never the objects the loops look for; a true value that cannot be iterated raises.
fn items<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a [Value], Raised> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        Some(Value::Number(_) | Value::Bool(true)) if value.is_some_and(pyjson::truthy) => {
            raised(format!("TypeError: {what} is not iterable"))
        }
        _ => Ok(&[]),
    }
}

/// `int(value or 0)`.
fn int_or_zero(value: Option<&Value>, what: &str) -> Result<i128, Raised> {
    match value.filter(|v| pyjson::truthy(v)) {
        Some(value) => py_int(value).ok_or_else(|| Raised(format!("ValueError: {what} is not a number"))),
        None => Ok(0),
    }
}

/// `float(value or 0)`.
fn float_or_zero(value: Option<&Value>, what: &str) -> Result<f64, Raised> {
    match value.filter(|v| pyjson::truthy(v)) {
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(0.0)),
        Some(Value::Bool(b)) => Ok(f64::from(u8::from(*b))),
        Some(Value::String(s)) => {
            pytext::strip(s).parse::<f64>().map_err(|_| Raised(format!("ValueError: {what} is not a number")))
        }
        Some(_) => raised(format!("TypeError: {what} is not a number")),
        None => Ok(0.0),
    }
}

/// An integer as a JSON number.
fn number(value: i128) -> Value {
    match (i64::try_from(value), u64::try_from(value)) {
        (Ok(n), _) => json!(n),
        (_, Ok(n)) => json!(n),
        _ => json!(value as f64),
    }
}

/// `f"{n:,}"`.
fn thousands(n: i128) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// `isinstance(value, int)`: a whole JSON number or a bool.
fn as_int(value: Option<&Value>) -> Option<i128> {
    match value {
        Some(Value::Bool(b)) => Some(i128::from(*b)),
        Some(Value::Number(n)) => n.as_i64().map(i128::from).or_else(|| n.as_u64().map(i128::from)),
        _ => None,
    }
}

/// A value as a dict key (`agent_types[tool_id]`): text is itself; other values Python can hash get a name no id has;
/// a list or an object cannot be a key (`TypeError`).
fn key_of(value: &Value) -> Result<String, Raised> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Array(_) | Value::Object(_) => raised("TypeError: unhashable type"),
        other => Ok(format!("\u{0}{other}")),
    }
}

/// `datetime.fromtimestamp(ms / 1000, UTC).isoformat()`.
fn iso_of_millis(ms: f64) -> Result<String, Raised> {
    let seconds = ms / 1000.0;
    if !seconds.is_finite() {
        return raised("ValueError: cannot convert float NaN or infinity to a time");
    }
    // as CPython splits a float time: whole seconds, and microseconds rounded half to even
    let mut whole = seconds.trunc();
    let mut micros = ((seconds - whole) * 1e6).round_ties_even();
    if micros >= 1e6 {
        micros -= 1e6;
        whole += 1.0;
    } else if micros < 0.0 {
        micros += 1e6;
        whole -= 1.0;
    }
    if whole.abs() > 1e12 {
        return raised("OverflowError: timestamp out of range");
    }
    let dt = Utc.timestamp_opt(whole as i64, micros as u32 * 1000).single();
    match dt.filter(|dt| (1..=9999).contains(&dt.year())) {
        Some(dt) => Ok(time::iso(&dt)),
        None => raised("ValueError: year is out of range"),
    }
}

/// Stateful: one per run (a resumed run keeps a new one; the agents it knew come back from the rows).
#[derive(Debug, Clone)]
pub struct Parser {
    /// The folder the run works in: file paths are shown from there.
    pub cwd: String,
    /// The roles of the subagents the run knows, by Agent call id.
    pub agent_types: HashMap<String, String>,
}

impl Parser {
    /// `agent_types`: the roles of the subagents a resumed run already knows, by Agent call id.
    pub fn new(cwd: &str, agent_types: Option<HashMap<String, String>>) -> Self {
        Self { cwd: cwd.to_string(), agent_types: agent_types.unwrap_or_default() }
    }

    /// One line → {rows, agents, files, results, result, session_id, ready, model, context_used, context_window,
    /// rate_limit, messages_in, messages_out}.
    pub fn parse(&mut self, line: &str) -> Result<Parsed, Raised> {
        let mut out = Parsed::default();
        let line = pytext::strip(line);
        if !line.starts_with('{') {
            return Ok(out);
        }
        let Ok(Value::Object(ev)) = serde_json::from_str::<Value>(line) else { return Ok(out) };
        let kind = ev.get("type").and_then(Value::as_str).unwrap_or("");
        let parent = truthy(&ev, "parent_tool_use_id").cloned().unwrap_or(Value::Null);
        let agent_id = parent;
        if kind == "system" {
            let sub = ev.get("subtype").and_then(Value::as_str).unwrap_or("");
            if sub == "init" {
                out.ready = true;
                out.session_id = get(&ev, "session_id");
                out.model = get(&ev, "model");
                let plugins: Vec<Value> = items(ev.get("plugins"), "plugins")?
                    .iter()
                    .filter_map(Value::as_object)
                    .map(|p| get(p, "name"))
                    .collect();
                out.init = Some(json!({
                    "agents": truthy(&ev, "agents").cloned().unwrap_or_else(|| json!([])),
                    "plugins": plugins,
                    "tools": truthy(&ev, "tools").cloned().unwrap_or_else(|| json!([])),
                }));
            } else if sub == "compact_boundary" {
                let meta = dict_or_empty(ev.get("compact_metadata"), "compact_metadata")?;
                let before = as_int(meta.and_then(|m| m.get("pre_tokens")));
                let after = as_int(meta.and_then(|m| m.get("post_tokens")));
                let mut title = "Long session compacted".to_string();
                if let (Some(before), Some(after)) = (before, after) {
                    title += &format!(" ({} → {} tokens)", thousands(before), thousands(after));
                }
                out.rows.push(json!({"kind": "compact", "title": title, "agent_id": agent_id}));
            } else if matches!(sub, "task_started" | "task_updated" | "task_notification") {
                self.task(&ev, sub, &mut out)?;
            } else if matches!(sub, "hook_event" | "hook") || truthy(&ev, "hook_event_name").is_some() {
                out.rows.push(Self::hook_row(&ev, &agent_id));
            }
        } else if kind == "rate_limit_event" {
            out.rate_limit = quota::parse_event(&Value::Object(ev));
        } else if kind == "assistant" {
            self.assistant(&ev, &agent_id, &mut out)?;
        } else if kind == "user" {
            Self::user(&ev, &agent_id, &mut out)?;
        } else if kind == "result" {
            let res = Self::result(&ev)?;
            let empty = |key: &str| !pyjson::truthy(&res[key]);
            let no_turns = match &res["turns"] {
                Value::Number(n) => n.as_f64() == Some(0.0),
                Value::Bool(b) => !b,
                _ => false,
            };
            // An empty turn the CLI ran by itself when a session was resumed (it handled a notification left by a
            // role of the earlier run): it is not the lead's answer. Taking it for the answer closed the CLI 20 s
            // later, in the middle of the lead's real work, and the run ended with "Finished." (RES-9, runs 2 and 3).
            let skipped = no_turns && empty("text") && empty("structured") && empty("is_error");
            out.result = if skipped { None } else { Some(res) };
            out.session_id = get(&ev, "session_id");
            let mut windows: Vec<i128> = Vec::new();
            if let Some(usage) = dict_or_empty(ev.get("modelUsage"), "modelUsage")? {
                for m in usage.values().filter_map(Value::as_object) {
                    windows.push(int_or_zero(m.get("contextWindow"), "contextWindow")?);
                }
            }
            out.context_window = windows.into_iter().max().filter(|max| *max != 0).map(number);
        } else if truthy(&ev, "hook_event_name").is_some() {
            out.rows.push(Self::hook_row(&ev, &agent_id));
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- pieces

    /// The CLI keeps a book of every background task of the lead: `task_started` (a role is `local_agent`, a command
    /// `local_bash`; a role carries its `subagent_type` and the lead's Agent call in `tool_use_id`), `task_updated`
    /// with the end, and `task_notification`. A role woken again starts the same task id once more. This is the
    /// board's source for when a role starts, works and ends: it needs no hook.
    fn task(&self, ev: &Map<String, Value>, sub: &str, out: &mut Parsed) -> Result<(), Raised> {
        let Some(task) = truthy(ev, "task_id") else { return Ok(()) };
        let task = pyjson::py_str(task);
        if sub == "task_started" {
            let kind = get(ev, "task_type");
            out.tasks.push(json!({"id": task, "type": kind, "event": "started"}));
            if kind == "local_agent" {
                let call = get(ev, "tool_use_id");
                let known = self.agent_types.contains_key(&key_of(&call)?);
                out.agents.push(json!({
                    "id": if known { call } else { Value::Null },
                    "claude_id": task,
                    "agent_type": truthy(ev, "subagent_type").map(pyjson::py_str).unwrap_or_default(),
                    "reopen": true,
                }));
            }
            return Ok(());
        }
        let patch = if sub == "task_updated" { dict_or_empty(ev.get("patch"), "patch")? } else { None };
        // an empty patch is false: the status is then the event's own
        let patch = patch.filter(|p| !p.is_empty());
        let status = match patch {
            Some(patch) => patch.get("status"),
            None => ev.get("status"),
        };
        if !status.and_then(Value::as_str).is_some_and(|s| TASK_ENDED.contains(&s)) {
            return Ok(());
        }
        out.tasks.push(json!({"id": task, "type": null, "event": "ended"}));
        let mut entry = Map::new();
        entry.insert("claude_id".into(), json!(task));
        entry.insert("ended".into(), json!(true));
        let end = match patch.and_then(|p| p.get("end_time")) {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::Bool(b)) => Some(f64::from(u8::from(*b))),
            _ => None,
        };
        if let Some(end) = end {
            entry.insert("at".into(), json!(iso_of_millis(end)?));
        }
        out.agents.push(Value::Object(entry));
        Ok(())
    }

    fn hook_row(ev: &Map<String, Value>, agent_id: &Value) -> Value {
        let name =
            truthy(ev, "hook_event_name").or_else(|| truthy(ev, "event")).map_or("hook".to_string(), pyjson::py_str);
        let tool = get(ev, "tool_name");
        let title = if pyjson::truthy(&tool) { format!("{name} {}", pyjson::py_str(&tool)) } else { name };
        let mut detail = Map::new();
        for k in ["hook_event_name", "agent_id", "agent_type", "tool_name"] {
            if let Some(v) = truthy(ev, k) {
                detail.insert(k.to_string(), v.clone());
            }
        }
        json!({
            "kind": "hook",
            "title": title.chars().take(200).collect::<String>(),
            "tool": tool,
            "detail": detail,
            "agent_id": agent_id,
        })
    }

    fn assistant(&mut self, ev: &Map<String, Value>, agent_id: &Value, out: &mut Parsed) -> Result<(), Raised> {
        let msg = cli::message_of_map(ev);
        let usage = dict_or_empty(msg.get("usage"), "usage")?;
        let mut held: i128 = 0;
        for k in ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] {
            held += int_or_zero(usage.and_then(|u| u.get(k)), k)?;
        }
        if held != 0 && agent_id.is_null() {
            out.context_used = Some(number(held));
        }
        let empty = Map::new();
        for block in items(msg.get("content"), "content")? {
            let Value::Object(block) = block else { continue };
            let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
            if btype == "tool_use" {
                let name = truthy(block, "name").cloned().unwrap_or_else(|| json!(""));
                let inp = match block.get("input") {
                    Some(Value::Object(inp)) => inp,
                    _ => &empty,
                };
                let tool_id = get(block, "id");
                let tool_name = name.as_str().unwrap_or("\u{0}");
                let or = |keys: [&str; 2]| keys.iter().find_map(|k| truthy(inp, k));
                if RELAY_TOOLS.contains(&tool_name) {
                    continue;
                }
                if tool_name == "Agent" || tool_name == "Task" {
                    let role = truthy(inp, "subagent_type").map_or("general-purpose".to_string(), pyjson::py_str);
                    if pyjson::truthy(&tool_id) {
                        self.agent_types.insert(key_of(&tool_id)?, role.clone());
                        out.agents.push(json!({"id": tool_id, "agent_type": role}));
                    }
                    let what = or(["description", "prompt"]).map(pyjson::py_str).unwrap_or_default();
                    out.rows.push(json!({
                        "kind": "subagent",
                        "title": redact(&format!("Asked {role}: {}", cli::short(&what, 140))),
                        "tool": name,
                        "detail": {"subagent_type": role, "description": get(inp, "description")},
                        "agent_id": agent_id,
                        "tool_id": tool_id,
                    }));
                    continue;
                }
                if tool_name == "SendMessage" {
                    let to = or(["to", "recipient"]).map(pyjson::py_str).unwrap_or_default();
                    let text = or(["message", "content"]).map(pyjson::py_str).unwrap_or_default();
                    out.messages_out.push(json!({"peer": to, "text": text, "agent_id": agent_id}));
                    out.rows.push(json!({
                        "kind": "message",
                        "title": redact(&format!("Sent to {to}: {}", cli::short(&text, 140))),
                        "tool": name,
                        "detail": {"direction": "out", "peer": to},
                        "agent_id": agent_id,
                        "tool_id": tool_id,
                    }));
                    continue;
                }
                if tool_name == "StructuredOutput" {
                    out.rows.push(json!({
                        "kind": "report",
                        "title": "Wrote the final report",
                        "tool": name,
                        "agent_id": agent_id,
                        "tool_id": tool_id,
                    }));
                    continue;
                }
                if matches!(tool_name, "TaskCreate" | "TaskUpdate" | "TodoWrite") {
                    let subject = or(["subject", "description"]).map_or_else(|| tool_name.to_string(), pyjson::py_str);
                    out.rows.push(json!({
                        "kind": "plan",
                        "title": redact(&cli::short(&subject, 160)),
                        "tool": name,
                        "detail": {"input": inp},
                        "agent_id": agent_id,
                        "tool_id": tool_id,
                    }));
                    continue;
                }
                let Some(tool_name) = name.as_str() else {
                    return raised("AttributeError: the name of a tool is not text");
                };
                let (k, text, change) = cli::describe_tool(tool_name, inp, &self.cwd)?;
                let mut detail = Map::new();
                if k == "command" {
                    let command = truthy(inp, "command").map(pyjson::py_str).unwrap_or_default();
                    detail.insert("command".into(), json!(redact(&command).chars().take(2000).collect::<String>()));
                }
                if let Some(change) = change {
                    for k2 in ["path", "added", "removed", "new"] {
                        if let Some(v) = change.get(k2) {
                            detail.insert(k2.to_string(), v.clone());
                        }
                    }
                    out.files.push(change);
                }
                out.rows.push(json!({
                    "kind": k,
                    "title": redact(&text),
                    "tool": name,
                    "detail": detail,
                    "agent_id": agent_id,
                    "tool_id": tool_id,
                }));
            } else if btype == "text" {
                let text = pytext::strip(cli::text_or_empty(block.get("text"), "the text of a block")?);
                if text.is_empty() {
                    continue;
                }
                let title = redact(&cli::short(text, 300));
                let mut row = Map::new();
                row.insert("kind".into(), json!("text"));
                row.insert("title".into(), json!(title));
                row.insert("agent_id".into(), agent_id.clone());
                if text.chars().count() > 300 {
                    row.insert("output".into(), json!(redact(text)));
                }
                out.rows.push(Value::Object(row));
                if pyjson::truthy(agent_id) {
                    out.agents.push(json!({"id": agent_id, "last_text": title}));
                }
            }
        }
        Ok(())
    }

    fn user(ev: &Map<String, Value>, agent_id: &Value, out: &mut Parsed) -> Result<(), Raised> {
        if truthy(ev, "isReplay").is_some() {
            return Ok(()); // a live run's own message echoed back (--replay-user-messages)
        }
        let msg = cli::message_of_map(ev);
        let content = msg.get("content");
        if let Some(Value::String(content)) = content {
            Self::user_text(content, agent_id, out);
            return Ok(());
        }
        for block in items(content, "content")? {
            let Value::Object(block) = block else { continue };
            let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
            if btype == "tool_result" {
                let text = cli::strip_ansi(&cli::result_text(block.get("content"))?);
                let is_error = truthy(block, "is_error").is_some();
                let exit_code = match EXIT_CODE.captures(&text) {
                    Some(code) => code[1]
                        .parse::<i64>()
                        .map_or_else(|_| json!(code[1].parse::<f64>().unwrap_or(0.0)), |n| json!(n)),
                    None => json!(i32::from(is_error)),
                };
                out.results.push(json!({
                    "tool_id": get(block, "tool_use_id"),
                    "output": redact(&text),
                    "is_error": is_error,
                    "exit_code": exit_code,
                    "tests": cli::parse_tests(&text),
                    "agent_id": agent_id,
                }));
                if is_error {
                    out.rows.push(json!({
                        "kind": "error",
                        "title": redact(&cli::short(&text, 240)),
                        "agent_id": agent_id,
                        "parent_tool_id": get(block, "tool_use_id"),
                    }));
                }
            } else if btype == "text" {
                let text = match truthy(block, "text") {
                    Some(Value::String(text)) => text.as_str(),
                    Some(_) => return raised("TypeError: the text of a block is not text"),
                    None => "",
                };
                Self::user_text(text, agent_id, out);
            }
        }
        Ok(())
    }

    fn user_text(text: &str, agent_id: &Value, out: &mut Parsed) {
        for m in CROSS.captures_iter(text) {
            let (peer, body) = (&m[1], pytext::strip(&m[2]));
            out.messages_in.push(json!({"peer": peer, "text": body, "agent_id": agent_id}));
            let long = body.chars().count() > 140;
            out.rows.push(json!({
                "kind": "message",
                "title": redact(&format!("From {peer}: {}", cli::short(body, 140))),
                "detail": {"direction": "in", "peer": peer},
                "output": if long { json!(redact(body)) } else { Value::Null },
                "agent_id": agent_id,
            }));
        }
    }

    fn result(ev: &Map<String, Value>) -> Result<Value, Raised> {
        let usage = dict_or_empty(ev.get("usage"), "usage")?;
        let mut structured = get(ev, "structured_output");
        let text = truthy(ev, "result").cloned().unwrap_or_else(|| json!(""));
        if structured.is_null() {
            if let Value::String(text) = &text {
                if pytext::strip(text).starts_with('{') {
                    structured = serde_json::from_str(text).unwrap_or(Value::Null);
                }
            }
        }
        let tokens = |key: &str| int_or_zero(usage.and_then(|u| u.get(key)), key);
        let (input, created, read) =
            (tokens("input_tokens")?, tokens("cache_creation_input_tokens")?, tokens("cache_read_input_tokens")?);
        let subtype = get(ev, "subtype");
        let mut denials: Vec<Value> = Vec::new();
        for d in items(ev.get("permission_denials"), "permission_denials")? {
            let Value::Object(d) = d else { continue };
            let Some(tool) = truthy(d, "tool_name") else { continue };
            let input = match d.get("tool_input") {
                Some(Value::Object(input)) => Value::Object(input.clone()),
                _ => json!({}),
            };
            denials.push(json!({"tool": pyjson::py_str(tool), "input": input}));
        }
        let cost = float_or_zero(ev.get("total_cost_usd"), "total_cost_usd")?;
        Ok(json!({
            "is_error": truthy(ev, "is_error").is_some() || !(subtype.is_null() || subtype == "success"),
            "subtype": subtype,
            "text": redact(&match &text {
                Value::String(text) => text.clone(),
                other => pyjson::dumps(other),
            }),
            "structured": if structured.is_object() { structured } else { Value::Null },
            "cost_usd": cost,
            "tokens_in": number(input + created + read),
            "tokens_cached": number(created + read),
            "tokens_out": number(tokens("output_tokens")?),
            "turns": get(ev, "num_turns"),
            "api_error": get(ev, "api_error"),
            "api_status": get(ev, "api_error_status"),
            "denials": denials,
        }))
    }
}
