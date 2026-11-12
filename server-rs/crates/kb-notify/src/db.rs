//! Writing a changed row the way the Python session does: `session.add(row)` on a loaded row updates only the
//! columns that changed.

use kb_db::Session;
use kb_db::entities::notification;

use crate::error::Result;

/// UPDATE the columns of a `Notification` that differ between `before` (as loaded) and `after` (as changed).
pub async fn save_notification(
    session: &Session,
    before: &notification::Model,
    after: &notification::Model,
) -> Result<()> {
    kb_db::save_model(session, before, after.clone()).await?;
    Ok(())
}
