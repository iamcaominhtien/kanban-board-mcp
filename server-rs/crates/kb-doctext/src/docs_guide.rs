//! `services/docs_guide.py`: how an AI works in Docs (issue #268): one text, two doors.
//!
//! Claude Code runs get it as the `docs-pages` skill of the board's plugin (`services/ai/board_skills.py`); any other
//! agent reads the same text with `docs_read(action='docs_guide')`, because Claude Code keeps only the first 10,000
//! characters of the MCP instructions. A test checks the two are the same text.
//!
//! The Markdown section says what the editor keeps exactly as written, so a page an AI writes renders as a person
//! would have written it in the editor, and a person's later edit in the editor does not rewrite it.

use serde_json::{Map, Value};

/// Front matter of the `docs-pages` skill: the guide below follows it.
pub const SKILL_HEADER: &str = include_str!("text/docs_guide_skill_header.md");

/// The guide, character for character as Python has it (`text/docs_guide.md`).
pub const GUIDE: &str = include_str!("text/docs_guide.md");

/// The text `docs_read(action='docs_guide')` returns: `{"guide": GUIDE}`.
pub fn guide() -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("guide".to_string(), Value::String(GUIDE.to_string()));
    out
}
