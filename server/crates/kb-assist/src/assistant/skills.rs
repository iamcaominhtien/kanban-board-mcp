//! The assistants' feature skills (`assets/skills/<name>/SKILL.md`, the files of `services/assistant/skills/`
//! unchanged), shipped to a run as one plugin (`kanban-assistant`), and the JSON schema each feature asks its answer
//! in (`services/assistant/skills.py`, lines 1 to 231).

use std::path::Path;
use std::sync::LazyLock;

use kb_ai_run::launch;
use kb_base::{pyjson, time};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

/// The name of the plugin the feature skills travel in.
pub const PLUGIN: &str = "kanban-assistant";

/// `SOURCE`: every feature skill and its SKILL.md, by name (the order `sorted()` gives the folder names).
const SOURCE: [(&str, &str); 25] = [
    ("board-ask", include_str!("../../assets/skills/board-ask/SKILL.md")),
    ("board-health", include_str!("../../assets/skills/board-health/SKILL.md")),
    ("db-fix", include_str!("../../assets/skills/db-fix/SKILL.md")),
    ("docs-ask", include_str!("../../assets/skills/docs-ask/SKILL.md")),
    ("docs-check", include_str!("../../assets/skills/docs-check/SKILL.md")),
    ("docs-diagram", include_str!("../../assets/skills/docs-diagram/SKILL.md")),
    ("docs-explain", include_str!("../../assets/skills/docs-explain/SKILL.md")),
    ("docs-fix", include_str!("../../assets/skills/docs-fix/SKILL.md")),
    ("docs-freshness", include_str!("../../assets/skills/docs-freshness/SKILL.md")),
    ("docs-history", include_str!("../../assets/skills/docs-history/SKILL.md")),
    ("docs-route", include_str!("../../assets/skills/docs-route/SKILL.md")),
    ("docs-summarise", include_str!("../../assets/skills/docs-summarise/SKILL.md")),
    ("docs-thread", include_str!("../../assets/skills/docs-thread/SKILL.md")),
    ("docs-tickets", include_str!("../../assets/skills/docs-tickets/SKILL.md")),
    ("docs-translate", include_str!("../../assets/skills/docs-translate/SKILL.md")),
    ("docs-write", include_str!("../../assets/skills/docs-write/SKILL.md")),
    ("editor-write", include_str!("../../assets/skills/editor-write/SKILL.md")),
    ("idea-ask", include_str!("../../assets/skills/idea-ask/SKILL.md")),
    ("idea-digest", include_str!("../../assets/skills/idea-digest/SKILL.md")),
    ("idea-prepare-ticket", include_str!("../../assets/skills/idea-prepare-ticket/SKILL.md")),
    ("idea-shape", include_str!("../../assets/skills/idea-shape/SKILL.md")),
    ("idea-triage", include_str!("../../assets/skills/idea-triage/SKILL.md")),
    ("schedule-dry-run", include_str!("../../assets/skills/schedule-dry-run/SKILL.md")),
    ("session-summary", include_str!("../../assets/skills/session-summary/SKILL.md")),
    ("sketch-ask", include_str!("../../assets/skills/sketch-ask/SKILL.md")),
];

/// The names of the feature skills.
pub fn names() -> Vec<&'static str> {
    SOURCE.iter().map(|(name, _)| *name).collect()
}

/// A skill's SKILL.md (None for a name that is not a skill; Python fails to open the file).
pub fn text_of(name: &str) -> Option<&'static str> {
    SOURCE.iter().find(|(key, _)| *key == name).map(|(_, text)| *text)
}

/// `_version`: the first 12 hex digits of the SHA-1 of every name and text.
pub fn version() -> String {
    let mut h = Sha1::new();
    for (name, text) in SOURCE {
        h.update(name.as_bytes());
        h.update(text.as_bytes());
    }
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    hex[..12].to_string()
}

/// The plugin folder with every feature skill, written once per version of their text.
///
/// It is built in a folder of its own and renamed into place, so two processes (the board and its runner, or two
/// test runs) never see a half-written plugin and never delete each other's.
pub fn plugin_dir() -> std::io::Result<String> {
    let version = version();
    let parent = launch::data_root()?.join("assistant-skills");
    let root = parent.join(&version);
    if root.join(".ready").exists() {
        return Ok(root.to_string_lossy().into_owned());
    }
    let tmp = parent.join(format!("{version}.tmp-{}-{}", std::process::id(), &time::uuid4_hex()[..6]));
    std::fs::create_dir_all(tmp.join(".claude-plugin"))?;
    std::fs::write(
        tmp.join(".claude-plugin").join("plugin.json"),
        pyjson::dumps(&json!({
            "name": PLUGIN,
            "version": "2.0.0",
            "description": "The board's assistants: Docs, Board, Ideas, editors, sketches.",
        })),
    )?;
    for (name, text) in SOURCE {
        std::fs::create_dir_all(tmp.join("skills").join(name))?;
        std::fs::write(tmp.join("skills").join(name).join("SKILL.md"), text)?;
    }
    std::fs::write(tmp.join(".ready"), "ok")?;
    if let Err(err) = std::fs::rename(&tmp, &root) {
        // another process finished first: use its copy
        let _ = std::fs::remove_dir_all(&tmp);
        if !Path::new(&root).join(".ready").exists() {
            return Err(err);
        }
    }
    Ok(root.to_string_lossy().into_owned())
}

/// `_obj`: an object schema with these properties; `required` lists the ones that must be there.
fn obj(props: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": props, "required": required})
}

/// `_S`: a text.
fn s() -> Value {
    json!({"type": "string"})
}

/// `_A`: a list of texts.
fn a() -> Value {
    json!({"type": "array", "items": {"type": "string"}})
}

/// The JSON schema of each skill that answers with JSON, in the order of the Python dict.
pub static SCHEMAS: LazyLock<Map<String, Value>> = LazyLock::new(|| {
    let mut out = Map::new();
    let mut put = |name: &str, schema: Value| {
        out.insert(name.to_string(), schema);
    };
    put(
        "docs-check",
        obj(
            json!({
                "findings": {
                    "type": "array",
                    "items": obj(
                        json!({"kind": s(), "quote": s(), "section": s(), "message": s(), "suggestion": s()}),
                        &["kind", "quote", "message"],
                    ),
                }
            }),
            &["findings"],
        ),
    );
    put("docs-fix", obj(json!({"old": s(), "new": s()}), &["old", "new"]));
    put("docs-summarise", obj(json!({"text": s(), "title": s()}), &["text"]));
    put("session-summary", obj(json!({"title": s(), "summary": s()}), &["title", "summary"]));
    put("docs-explain", obj(json!({"text": s()}), &["text"]));
    put("docs-translate", obj(json!({"markdown": s(), "language": s()}), &["markdown"]));
    put(
        "docs-ask",
        obj(
            json!({
                "answer": s(),
                "verdict": {"type": "string", "enum": ["answered", "not_covered", "conflict"]},
                "citations": {
                    "type": "array",
                    "items": obj(json!({"page_id": s(), "title": s(), "section": s()}), &[]),
                },
                "pages_read": {"type": "integer"},
            }),
            &["answer", "verdict"],
        ),
    );
    put("docs-write", obj(json!({"page_id": s(), "title": s(), "gaps": a()}), &["page_id", "title"]));
    put(
        "docs-diagram",
        obj(
            json!({"diagram_id": s(), "label": s(), "markdown": s(), "changed": {"type": "boolean"}}),
            &["diagram_id", "markdown"],
        ),
    );
    put("docs-history", obj(json!({"summary": s(), "note": s(), "lines": a()}), &[]));
    put(
        "docs-tickets",
        obj(
            json!({
                "drafts": {
                    "type": "array",
                    "items": obj(json!({"title": s(), "text": s(), "type": s(), "line": s()}), &["title"]),
                },
                "skipped": {"type": "array", "items": obj(json!({"line": s(), "why": s()}), &[])},
            }),
            &["drafts"],
        ),
    );
    put(
        "docs-freshness",
        obj(
            json!({
                "state": {"type": "string", "enum": ["ok", "stale"]},
                "reasons": {
                    "type": "array",
                    "items": obj(json!({"quote": s(), "source": s(), "why": s()}), &[]),
                },
            }),
            &["state"],
        ),
    );
    put("docs-thread", obj(json!({"reply": s(), "posted": {"type": "boolean"}}), &["reply"]));
    put("docs-route", obj(json!({"decision": s(), "ticket_id": s(), "reason": s()}), &["decision"]));
    put(
        "board-health",
        obj(
            json!({
                "insights": {
                    "type": "array",
                    "items": obj(
                        json!({
                            "kind": s(),
                            "ticket_id": s(),
                            "title": s(),
                            "detail": s(),
                            "score": {"type": "integer"},
                            "data": {"type": "object"},
                        }),
                        &["kind", "title"],
                    ),
                },
                "summary": s(),
            }),
            &["insights"],
        ),
    );
    put(
        "idea-triage",
        obj(
            json!({
                "action": {"type": "string", "enum": ["keep", "park", "merge", "archive", "none"]},
                "reason": s(),
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "target_id": s(),
                "park_days": {"type": "integer"},
                "archive_reason": s(),
            }),
            &["action", "reason", "confidence"],
        ),
    );
    put("idea-shape", json!({"type": "object"}));
    put(
        "idea-ask",
        obj(
            json!({
                "answer": s(),
                "sources": {"type": "array", "items": obj(json!({"id": s(), "title": s()}), &[])},
                "actions": {
                    "type": "array",
                    "items": obj(json!({"label": s(), "kind": s(), "idea_ids": a()}), &[]),
                },
            }),
            &["answer"],
        ),
    );
    put(
        "idea-prepare-ticket",
        obj(
            json!({"title": s(), "description": s(), "acceptance_criteria": a(), "sub_tickets": a()}),
            &["title", "description"],
        ),
    );
    put(
        "idea-digest",
        obj(
            json!({
                "text": s(),
                "items": {
                    "type": "array",
                    "items": obj(json!({"kind": s(), "idea_ids": a(), "text": s()}), &[]),
                },
            }),
            &["text"],
        ),
    );
    put("editor-write", obj(json!({"text": s()}), &["text"]));
    put(
        "sketch-ask",
        obj(
            json!({"answer": s(), "ideas": a(), "shapes": {"type": "array", "items": {"type": "object"}}}),
            &["answer"],
        ),
    );
    put(
        "db-fix",
        obj(
            json!({
                "cause": s(),
                "statements": a(),
                "affects": s(),
                "other_columns": a(),
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "answer": s(),
            }),
            &["cause", "statements"],
        ),
    );
    put("schedule-dry-run", obj(json!({"text": s()}), &["text"]));
    out
});

/// The JSON schema a skill's answer is asked in, or None for plain text.
pub fn schema_for(name: &str) -> Option<&'static Value> {
    SCHEMAS.get(name)
}
