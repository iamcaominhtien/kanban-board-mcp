//! `server/alembic/versions/e6a8c0d2f4b6_docs_ai_v1_leftovers.py`
//!
//! Docs AI: drop what v1 left (proposals, read scope, edits mode, hide-from-AI, guidance pages).
//!
//! KBM-24: `docs_ai_settings` loses `read_scope`, `picked_pages`, `edits_mode`, `proposal_days` and `guidance_limit`;
//! `docs_page` loses `ai_hidden` and `ai_guidance`. AI v2 edits pages directly (the page's history undoes it), reads what the
//! person can read, and no run reads guidance pages. A "page proposal" notification (nothing makes them any more) is removed.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

const SETTINGS_COLUMNS: [&str; 5] = ["read_scope", "picked_pages", "edits_mode", "proposal_days", "guidance_limit"];
const PAGE_COLUMNS: [&str; 2] = ["ai_hidden", "ai_guidance"];

/// `_drop`: drop the columns of `names` the table has. On SQLite Alembic's batch mode wrote the table again
/// without them; none of these columns is in a key or an index, so DROP COLUMN leaves the same table.
async fn drop_columns<C: ConnectionTrait>(conn: &C, table: &str, names: &[&str]) -> Result<(), sea_orm::DbErr> {
    let have = ops::columns(conn, table).await?;
    for name in names {
        if have.iter().any(|c| c == name) {
            ops::exec(conn, &format!("ALTER TABLE {table} DROP COLUMN {name}")).await?;
        }
    }
    Ok(())
}

/// `upgrade()` of revision `e6a8c0d2f4b6`: drop the columns that are still there (a database made from the models
/// never had them).
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    drop_columns(conn, "docs_ai_settings", &SETTINGS_COLUMNS).await?;
    drop_columns(conn, "docs_page", &PAGE_COLUMNS).await?;
    ops::exec(conn, "DELETE FROM notification WHERE kind = 'page_proposal'").await?;
    Ok(())
}
