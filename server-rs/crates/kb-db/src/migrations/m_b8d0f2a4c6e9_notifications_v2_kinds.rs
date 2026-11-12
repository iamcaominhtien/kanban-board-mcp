//! `server/alembic/versions/b8d0f2a4c6e9_notifications_v2_kinds.py`
//!
//! Notifications: drop the kinds AI v2 no longer sends.
//!
//! KBM-38: the board has no approval layer, so `approval` ("An approval request") and `blocked` ("An AI was blocked by a
//! permission") are gone, and a restart for memory is written on the run instead of being a notification
//! (`run_restarted`). The `story_*` kinds were never sent by anything. Their old rows and events are deleted; nothing
//! reads them any more.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

const KINDS: [&str; 6] = ["approval", "blocked", "run_restarted", "story_plan", "story_blocked", "story_done"];

/// `upgrade()` of revision `b8d0f2a4c6e9`: delete the rows and events of the removed kinds.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    let names = KINDS.map(|k| format!("'{k}'")).join(", ");
    for table in ["notification", "notify_event"] {
        if ops::has_table(conn, table).await? {
            ops::exec(conn, &format!("DELETE FROM {table} WHERE kind IN ({names})")).await?;
        }
    }
    // a person's old mute of one of these kinds would stay in Settings › Muted for a kind that no longer exists
    if ops::has_table(conn, "notify_follow").await? {
        ops::exec(conn, &format!("DELETE FROM notify_follow WHERE scope = 'kind' AND scope_id IN ({names})")).await?;
    }
    Ok(())
}
