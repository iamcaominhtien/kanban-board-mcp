//! `server/alembic/versions/d2f4a6c8e0b1_docs_rich_format.py`
//!
//! Rich Docs, phase 1b: the columns a page needs to be stored as rich JSON next to its Markdown.
//!
//! A version and a draft get `format` (`md` or `rich`), `content` (the page as rich JSON) and `text` (its plain
//! text). A page gets its `settings` (JSON) and the state of its conversion to the rich format. A comment thread
//! can anchor to a block, and a link can name the block it starts from and the one it points at. Nothing is
//! converted here: every existing row keeps `format = 'md'`, and the conversion runs later as a background job.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult, Types};

/// `upgrade()` of revision `d2f4a6c8e0b1`: add each column the table lacks, so it can run again on MySQL.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    let types = Types::of(conn);
    let format = format!("{} {}", types.s, types.not_null_default("'md'"));
    let rich: [(&str, &str); 3] = [("format", &format), ("content", types.t), ("text", types.t)];
    for table in ["docs_version", "docs_draft"] {
        ops::add_missing_columns(conn, table, &rich).await?;
    }
    ops::add_missing_columns(
        conn,
        "docs_page",
        &[("settings", types.t), ("convert_state", types.s), ("convert_error", types.t)],
    )
    .await?;
    ops::add_missing_columns(conn, "docs_comment_thread", &[("anchor_block_id", types.s)]).await?;
    ops::add_missing_columns(conn, "docs_link", &[("source_block_id", types.s), ("target_block_id", types.s)]).await?;
    Ok(())
}
