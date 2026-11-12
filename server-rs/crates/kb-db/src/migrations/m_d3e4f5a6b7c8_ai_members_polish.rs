//! `server/alembic/versions/d3e4f5a6b7c8_ai_members_polish.py`
//!
//! AI members: when a rate-limited agent retries, and a glyph and colour of its own.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// Until now nobody could pick a glyph or a colour: every member had the default glyph and a colour handed out in
/// turn. Give each existing member the look of its provider (what the avatar showed before), so nothing changes
/// on screen; from here on the picked glyph and colour are what is drawn everywhere.
const LOOKS: [(&str, &str, &str); 7] = [
    ("claude-code", "asterisk", "#2E6F40"),
    ("anthropic", "asterisk", "#B4791E"),
    ("antigravity", "peak", "#2F6FB0"),
    ("openai", "hex", "#6D5DD3"),
    ("gemini", "spark", "#B0446E"),
    ("custom", "braces", "#5B6B60"),
    ("mcp-client", "plug", "#5B6B60"),
];

/// `upgrade()` of revision `d3e4f5a6b7c8`: add `retry_at` and set each member's glyph and colour from its provider.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, "ALTER TABLE ai_member ADD COLUMN retry_at VARCHAR").await?;
    for (provider, glyph, color) in LOOKS {
        ops::exec_with(
            conn,
            "UPDATE ai_member SET glyph = ? WHERE provider = ? AND glyph = 'spark'",
            vec![glyph.into(), provider.into()],
        )
        .await?;
        ops::exec_with(
            conn,
            "UPDATE member SET color = ? WHERE kind = 'ai' AND id IN (SELECT id FROM ai_member WHERE provider = ?)",
            vec![color.into(), provider.into()],
        )
        .await?;
    }
    Ok(())
}
