//! Project settings of the AI team v2 (docs/specs/ai-v2.md), in one JSON column (`AiProjectSettings.ops`) merged over
//! defaults, so a project that never touched them reads the defaults.

use kb_base::pyjson;
use kb_db::entities::ai_project_settings;
use serde_json::{Map, Value, json};

/// `DEFAULTS`: every key a project may set, with its default. The comments are the Python ones.
pub fn defaults() -> Map<String, Value> {
    let value = json!({
        // at most this many kept lessons go into a run's prompt
        "lessons_in_prompt": 20,
        // A run keeps its own notes across runs (its role's, and on its ticket) and reads them back (issue #274)
        "ai_notes": true,
        // Start Claude Code with its input open (stream-json), so a message reaches a running AI at its next turn (D20,
        // spike S6). Off: a message rides on the AI's next board call.
        "live_messages": true,
        // The share (%) of a session's context window at which Claude Code compacts it by itself, while the AI keeps
        // working (it pauses a few seconds between two steps). None: Claude Code's own level.
        "auto_compact_pct": null,
        // The board's own skills (services/ai/board_skills.py) switched off for every member or for one (issue #277):
        // [{skill, on, members_on, members_off}]; a skill not listed is on for everyone. A list, as above.
        "board_skills": [],
        // Phase 4: worktrees and hand-over
        "worktrees": {
            "on": false,
            // the main checkout; None: the member's working folder
            "repo": null,
            // e.g. "npm ci" or "uv sync", run once in a new worktree
            "prepare": "",
            "base_port": 5180,
            // auto | pr | local | branch
            "handover": "auto",
            // None: the repository's current branch
            "base_branch": null,
        },
        // the project's checks (the Checks step, the scan)
        "commands": {"test": "", "lint": "", "build": ""},
        // Commands saved but not run as checks yet (a repository whose own tests already fail would otherwise send every
        // ticket back to Dev): names out of test, lint, build (design/screens/ai-repo-commands.md, D2/D5)
        "checks_off": [],
        // Extra folders put in front of the PATH for everything this project runs: the wizard's trial, a ticket's prepare,
        // the checks and the AI members' runs (services/ai/project_env.py). An app opened from the Dock does not see
        // Homebrew or nvm without them.
        "env_path": [],
        // also search the shared store
        "knowledge_shared": false,
        // auto: red CI the PR's own change caused, and review comments on it, go to the ticket's Dev by themselves (D21)
        "github": {"on": false, "poll_min": 5, "auto": true},
    });
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The value of a decimal digit of any script (`int("٤٥")` is 45): the characters of Unicode category Nd.
fn decimal_digit(c: char) -> Option<u32> {
    const ZEROS: [u32; 65] = [
        0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66, 0xDE6, 0xE50, 0xED0,
        0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90, 0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620,
        0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10, 0x104A0, 0x10D30, 0x11066, 0x110F0, 0x11136, 0x111D0,
        0x112F0, 0x11450, 0x114D0, 0x11650, 0x116C0, 0x11730, 0x118E0, 0x11950, 0x11C50, 0x11D50, 0x11DA0, 0x16A60,
        0x16AC0, 0x16B50, 0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6, 0x1E140, 0x1E2F0, 0x1E950,
    ];
    let code = c as u32;
    ZEROS
        .iter()
        .find(|zero| (**zero..**zero + 10).contains(&code))
        .map(|zero| code - zero)
        .or_else(|| (0x1FBF0..0x1FBFA).contains(&code).then(|| code - 0x1FBF0))
}

/// Python's `int(value)` for the JSON values a setting may hold: `None` where Python raises.
pub(crate) fn py_int(value: &Value) -> Option<i128> {
    match value {
        Value::Bool(b) => Some(i128::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Some(i128::from(i)),
            None => match n.as_u64() {
                Some(u) => Some(i128::from(u)),
                None => n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i128),
            },
        },
        Value::String(s) => {
            let text = kb_base::pytext::strip(s);
            let (sign, digits) = match text.strip_prefix('-') {
                Some(rest) => (-1, rest),
                None => (1, text.strip_prefix('+').unwrap_or(text)),
            };
            // underscores are allowed between digits, as in a Python literal
            let ok = !digits.is_empty()
                && !digits.starts_with('_')
                && !digits.ends_with('_')
                && !digits.contains("__")
                && digits.chars().all(|c| c == '_' || decimal_digit(c).is_some());
            if !ok {
                return None;
            }
            let mut n: i128 = 0;
            for c in digits.chars().filter(|c| *c != '_') {
                n = n.checked_mul(10)?.checked_add(i128::from(decimal_digit(c)?))?;
            }
            Some(sign * n)
        }
        _ => None,
    }
}

/// The auto-compact level of `get()`'s result as a whole percent between 30 and 95, or None for the CLI's own.
pub fn auto_compact_pct(cfg: &Map<String, Value>) -> Option<i64> {
    let raw = cfg.get("auto_compact_pct").cloned().unwrap_or(Value::Null);
    // `int(cfg.get("auto_compact_pct") or 0)`
    let value = if pyjson::truthy(&raw) { py_int(&raw)? } else { 0 };
    if value == 0 { None } else { Some(value.clamp(30, 95) as i64) }
}

fn merge(base: &Map<String, Value>, over: &Map<String, Value>) -> Map<String, Value> {
    let mut out = base.clone();
    for (k, v) in over {
        match (v, out.get(k)) {
            (Value::Object(inner), Some(Value::Object(current))) => {
                let merged = merge(current, inner);
                out.insert(k.clone(), Value::Object(merged));
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

fn stored_of(ops: Option<&str>) -> Map<String, Value> {
    let text = ops.filter(|o| !o.is_empty());
    match text.and_then(|t| serde_json::from_str::<Value>(t).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// The project's settings over the defaults.
pub fn get(settings: Option<&ai_project_settings::Model>) -> Map<String, Value> {
    merge(&defaults(), &stored_of(settings.map(|s| s.ops.as_str())))
}

/// Merge `patch` into the stored settings (only known keys); returns the full result. The caller saves
/// `settings.ops` (it is changed here, as the Python function changes the row).
pub fn update(settings: &mut ai_project_settings::Model, patch: &Map<String, Value>) -> Map<String, Value> {
    let known = defaults();
    let stored = stored_of(Some(&settings.ops));
    let clean: Map<String, Value> =
        patch.iter().filter(|(k, _)| known.contains_key(*k)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let merged = merge(&stored, &clean);
    settings.ops = pyjson::dumps(&Value::Object(merged.clone()));
    merge(&known, &merged)
}
