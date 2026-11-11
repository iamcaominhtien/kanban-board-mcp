//! Writing a changed row the way the Python session does: `session.add(row)` on a loaded row updates only the
//! columns that changed.

use kb_db::Session;
use kb_db::entities::notification;
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue};

use crate::error::Result;

/// UPDATE the columns of a `Notification` that differ between `before` (as loaded) and `after` (as changed).
pub async fn save_notification(
    session: &Session,
    before: &notification::Model,
    after: &notification::Model,
) -> Result<()> {
    let mut am = notification::ActiveModel {
        id: ActiveValue::Unchanged(before.id.clone()),
        ..<notification::ActiveModel as kb_db::sea_orm::ActiveModelTrait>::default()
    };
    let mut changed = false;
    macro_rules! diff {
        ($($field:ident),* $(,)?) => {$(
            if before.$field != after.$field {
                am.$field = ActiveValue::Set(after.$field.clone());
                changed = true;
            }
        )*};
    }
    diff!(
        recipient,
        event_id,
        last_event_id,
        project_id,
        kind,
        needs,
        group_key,
        count,
        items,
        target_kind,
        target_id,
        ticket_id,
        page_id,
        member_id,
        actor,
        title,
        body,
        data,
        inapp,
        desktop,
        read_at,
        done_at,
        done_reason,
        done_by,
        snoozed_until,
        cleared_at,
        created_at,
        updated_at,
    );
    if changed {
        am.update(session).await?;
    }
    Ok(())
}
