//! Project operations.

use kb_board::projects as svc_projects;
use kb_board::schemas::{ProjectCreate, ProjectRead, ProjectUpdate};
use serde_json::Value;

use crate::common::{self, ToolError, ToolResult, notify_on_success};

/// What a project service call fails with, as the tool reports it.
pub(crate) fn project_error(err: svc_projects::Error) -> ToolError {
    match err {
        svc_projects::Error::Value(message) => ToolError::Value(message),
        svc_projects::Error::Db(err) => err.into(),
        svc_projects::Error::Other(message) => ToolError::Other(message),
    }
}

/// `ProjectRead.model_validate(project).model_dump()`.
fn dump(project: kb_db::entities::project::Model) -> ToolResult {
    Ok(serde_json::to_value(ProjectRead::from(project))?)
}

/// List all projects (boards). Start here: most other tools need a project's `id` (a UUID).
/// Each project has a `prefix` that starts its ticket IDs (prefix 'IAM' -> tickets 'IAM-1', 'IAM-2'),
/// and may have a linked git `repo_path` (needed by the branch tools).
pub async fn list_projects() -> Result<Vec<Value>, ToolError> {
    let session = common::async_session();
    let projects = svc_projects::list_projects(&session).await?;
    projects.into_iter().map(dump).collect()
}

/// The default of `create_project`'s `color`.
pub const DEFAULT_COLOR: &str = "#6366f1";

/// Create a project (board). A member named 'Admin' is created with it. Returns the project with its `id` (UUID).
///
/// `name`: display name, e.g. 'My App'. `prefix`: ticket-ID prefix: uppercase letters/digits, at most 6 chars,
/// unique (e.g. 'MYAPP'); lower-case input is upper-cased. `color`: hex accent color, e.g. '#6366f1'.
pub async fn create_project(name: &str, prefix: &str, color: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let data = ProjectCreate { name: name.to_string(), prefix: prefix.to_uppercase(), color: color.to_string() };
        let project = svc_projects::create_project(&session, &data).await.map_err(project_error)?;
        dump(project)
    })
    .await
}

/// Change a project's name, color or git settings. Only the fields you pass change. Returns the project.
///
/// `repo_path`: absolute path of a local git repository to link to this project (required before add_branch can
/// create real git branches); an empty string unlinks it. `worktree_template`: default path template for git
/// worktrees, e.g. '../worktrees/{project}/{ticket_id}-{branch}'. `worktree_by_default`: create a worktree by
/// default for new branches.
pub async fn update_project(
    project_id: &str,
    name: Option<String>,
    color: Option<String>,
    repo_path: Option<String>,
    worktree_template: Option<String>,
    worktree_by_default: Option<bool>,
) -> ToolResult {
    notify_on_success(async {
        let data = ProjectUpdate {
            name,
            color,
            repo_path,
            worktree_template,
            worktree_by_default,
            ..ProjectUpdate::default()
        };
        let session = common::async_session();
        let project = svc_projects::update_project(&session, project_id, &data).await.map_err(project_error)?;
        let Some(project) = project else {
            return Err(ToolError::Value(format!(
                "Project '{project_id}' not found. Use get_projects to see project ids."
            )));
        };
        dump(project)
    })
    .await
}
