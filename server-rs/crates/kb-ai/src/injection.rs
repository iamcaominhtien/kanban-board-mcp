//! Text that looks like instructions to an AI (F of the deleted v1 board ai-safety-cost).
//!
//! Detection is a hint for people ("Looks like instructions: treated as plain text"), never a gate: what stops a fooled
//! model is the permission layer. Trust comes from who wrote a text, never from its wording, and there is no "mark as
//! safe".

use std::collections::HashSet;
use std::sync::LazyLock;

use kb_base::{pyjson, pytext};
use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value, json};

/// (pattern, the phrase shown to the person)
static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)",
        r"disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|your)\s+(?:instructions?|rules?)",
        r"\b(?:delete|drop|wipe|erase|remove)\s+(?:the\s+|this\s+|all\s+)?(?:project|board|tickets?|database|repo(?:sitory)?)\b",
        r"\byou\s+are\s+now\b|\bnew\s+instructions?\s*:",
        r"\b(?:reveal|print|show|send)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|api\s*key|secrets?|tokens?)\b",
        r"\b(?:fetch|download|curl|wget|visit)\b[^.\n]{0,60}https?://",
        r"\bfollow\s+(?:it|that|the\s+(?:link|instructions?))\b",
        r"\b(?:change|raise|grant|give)\b[^.\n]{0,30}\b(?:permissions?|admin|owner)\b",
        r"\bapprove\s+(?:it|this|every|all)\b",
    ]
    .iter()
    .map(|p| {
        RegexBuilder::new(p).case_insensitive(true).build().expect("an injection pattern written in the code compiles")
    })
    .collect()
});

/// The suspicious phrases found in a text, each at most once, in order of appearance.
pub fn phrases(text: Option<&str>) -> Vec<String> {
    let text = text.unwrap_or("");
    let mut found: Vec<(usize, String)> = Vec::new();
    for pattern in PATTERNS.iter() {
        if let Some(m) = pattern.find(text) {
            let phrase: String = pytext::strip(m.as_str()).chars().take(80).collect();
            // the position is a character offset in Python; the order of byte offsets is the same
            found.push((m.start(), phrase));
        }
    }
    found.sort();
    found.into_iter().map(|(_, p)| p).collect()
}

/// trusted | data_only | untrusted by who wrote it: project members are trusted, AI members are data only, anyone else
/// (guests, imports, external tools) is untrusted.
pub fn trust_of(author: &str, humans: &HashSet<String>, ai_names: &HashSet<String>) -> &'static str {
    if author == "user" || author == "Board" || humans.contains(author) {
        "trusted"
    } else if ai_names.contains(author) {
        "data_only"
    } else {
        "untrusted"
    }
}

/// `c.get(key) or default` as text (a value that is not a string is shown as Python shows it).
fn text_or(c: &Value, key: &str, default: &str) -> String {
    match c.get(key) {
        Some(v) if pyjson::truthy(v) => pyjson::py_str(v),
        _ => default.to_string(),
    }
}

/// Per comment that looks like instructions or comes from an untrusted source: {comment_id, author, trust, phrases}.
/// Trusted people's comments are only flagged when they look like instructions.
pub fn flags_for_comments(comments: &[Value], humans: &HashSet<String>, ai_names: &HashSet<String>) -> Vec<Value> {
    let mut out = Vec::new();
    for c in comments {
        if c.get("deleted_at").is_some_and(pyjson::truthy) {
            continue;
        }
        let author = text_or(c, "author", "user");
        let trust = trust_of(&author, humans, ai_names);
        let found = if trust != "trusted" { phrases(c.get("text").and_then(Value::as_str)) } else { Vec::new() };
        if trust == "untrusted" || !found.is_empty() {
            let mut entry = Map::new();
            entry.insert("comment_id".into(), c.get("id").cloned().unwrap_or(Value::Null));
            entry.insert("author".into(), json!(author));
            entry.insert("trust".into(), json!(trust));
            entry.insert("phrases".into(), json!(found));
            out.push(Value::Object(entry));
        }
    }
    out
}
