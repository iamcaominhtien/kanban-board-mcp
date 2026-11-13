//! Project member operations.

use kb_board::members as svc_members;
use kb_board::schemas::MemberRead;
use serde_json::{Value, json};

use crate::common::{self, ToolError, ToolResult, notify_on_success};

/// `MemberRead.model_validate(member).model_dump()`.
pub(crate) fn dump(member: kb_db::entities::member::Model) -> ToolResult {
    Ok(serde_json::to_value(MemberRead::from(member))?)
}

/// List a project's members: {id, name, color, project_id, created_at}. Use a member `id` as `assignee`.
pub async fn list_members(project_id: &str) -> Result<Vec<Value>, ToolError> {
    let session = common::async_session();
    let members = svc_members::list_members(&session, project_id).await?;
    members.into_iter().map(dump).collect()
}

/// Add a member to a project so tickets can be assigned to them. Returns the member (with its `id`).
///
/// `name`: display name. `color`: hex avatar color; auto-assigned when omitted.
pub async fn add_member(project_id: &str, name: &str, color: Option<&str>) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        // `svc_members.create_member(session, project_id, name, color)`: the role and the commit are its defaults
        let member = svc_members::create_member(&session, project_id, name, color, "member", true).await?;
        dump(member)
    })
    .await
}

/// Remove a member from a project. Their assigned tickets become unassigned first; refused when the member created
/// tickets. Returns {"ok": true}.
pub async fn remove_member(project_id: &str, member_id: &str) -> ToolResult {
    notify_on_success(async {
        let removed = {
            let session = common::async_session();
            svc_members::remove_member(&session, project_id, member_id).await.map_err(|err| match err {
                svc_members::Error::Value(message) => ToolError::Value(message),
                svc_members::Error::Db(err) => err.into(),
            })?
        };
        if !removed {
            return Err(ToolError::Value(format!(
                "Member '{member_id}' not found in this project. Use get_projects(project_id) to see member ids."
            )));
        }
        Ok(json!({"ok": true}))
    })
    .await
}
