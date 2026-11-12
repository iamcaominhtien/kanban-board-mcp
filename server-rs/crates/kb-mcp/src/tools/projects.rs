//! Project tools: reading projects (with members) and managing projects and members.

use serde_json::{Map, Value};

use super::routing::{Op, dispatch, params_of};
use crate::common::{self, ToolError, ToolResult, arg_bool, arg_str, arg_text};
use crate::operations as ops;

/// Start here: list the projects (boards). Most other tools need a project's `id` (a UUID). Each project has a
/// `prefix` that starts its ticket IDs (prefix 'IAM' -> 'IAM-1', 'IAM-2') and may have a linked git `repo_path`
/// (needed by real git branches). With `project_id` you get that project plus `members` [{id, name, color}]; use a
/// member `id` as a ticket `assignee`.
///
/// `project_id`: omit to list every project. A project UUID returns that project with its members.
pub async fn get_projects(args: Map<String, Value>) -> ToolResult {
    let project_id = arg_str(&args, "project_id");
    let projects = ops::list_projects().await?;
    let Some(project_id) = project_id else {
        return Ok(Value::Array(projects));
    };
    for project in &projects {
        if project["id"] == project_id.as_str() {
            let members = {
                let session = common::async_session();
                kb_board::members::list_members(&session, &project_id).await?
            };
            let members: Vec<Value> = members.into_iter().map(ops::members::dump).collect::<Result<_, _>>()?;
            let mut with_members = project.as_object().cloned().unwrap_or_default();
            with_members.insert("members".into(), Value::Array(members));
            return Ok(Value::Object(with_members));
        }
    }
    let shown: Vec<String> = projects
        .iter()
        .take(20)
        .map(|p| format!("{}={}", p["prefix"].as_str().unwrap_or_default(), p["id"].as_str().unwrap_or_default()))
        .collect();
    let shown = if shown.is_empty() { "none".to_string() } else { shown.join(", ") };
    Err(ToolError::Value(format!(
        "Project '{project_id}' not found. Pass a project UUID (not the prefix). Existing: {shown}."
    )))
}

/// `ProjectAction = Literal["create", "update", "add_member", "remove_member"]`: what each action runs and takes.
pub const PROJECT_OPS: &[(&str, Op)] = &[
    (
        "create",
        Op::new(
            |a| {
                Box::pin(async move {
                    let color = arg_str(&a, "color").unwrap_or_else(|| ops::projects::DEFAULT_COLOR.to_string());
                    ops::create_project(&arg_text(&a, "name"), &arg_text(&a, "prefix"), &color).await
                })
            },
            &["name", "prefix"],
            &["color"],
        ),
    ),
    (
        "update",
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::update_project(
                        &arg_text(&a, "project_id"),
                        arg_str(&a, "name"),
                        arg_str(&a, "color"),
                        arg_str(&a, "repo_path"),
                        arg_str(&a, "worktree_template"),
                        arg_bool(&a, "worktree_by_default"),
                    )
                    .await
                })
            },
            &["project_id"],
            &["name", "color", "repo_path", "worktree_template", "worktree_by_default"],
        ),
    ),
    (
        "add_member",
        Op::new(
            |a| {
                Box::pin(async move {
                    let color = arg_str(&a, "color");
                    ops::add_member(&arg_text(&a, "project_id"), &arg_text(&a, "name"), color.as_deref()).await
                })
            },
            &["project_id", "name"],
            &["color"],
        ),
    ),
    (
        "remove_member",
        Op::new(
            |a| Box::pin(async move { ops::remove_member(&arg_text(&a, "project_id"), &arg_text(&a, "member_id")).await }),
            &["project_id", "member_id"],
            &[],
        ),
    ),
];

/// Create or change a project and its members. `action`:
/// - create: name, prefix [, color]. A member 'Admin' is created with it. Returns the project (`id` is a UUID).
/// - update: project_id [, name, color, repo_path, worktree_template, worktree_by_default]. Only the fields you
///   pass change. Returns the project.
/// - add_member: project_id, name [, color]. Returns the member; its `id` is what tickets use as `assignee`.
/// - remove_member: project_id, member_id. Refused (with the reason) while the member has open assigned tickets
///   (reassign them first) or created tickets; closed tickets are unassigned. Returns {"ok": true}.
pub async fn manage_project(args: Map<String, Value>) -> ToolResult {
    let action = arg_text(&args, "action");
    dispatch("manage_project", PROJECT_OPS, &action, params_of(args)).await
}
