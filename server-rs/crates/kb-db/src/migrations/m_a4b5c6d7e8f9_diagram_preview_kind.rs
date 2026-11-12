//! `server/alembic/versions/a4b5c6d7e8f9_diagram_preview_kind.py`
//!
//! diagram_version.preview_kind: who drew a diagram's SVG preview (editor, agent or basic)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a4b5c6d7e8f9`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE diagram_version ADD COLUMN preview_kind VARCHAR DEFAULT 'editor' NOT NULL").await?;
    Ok(())
}
