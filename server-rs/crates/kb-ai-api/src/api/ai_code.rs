//! `api/ai_code.py`: REST API of where the AIs work and how code is handed over (design/screens/ai-operations.md I, J,
//! K): worktrees, merge, the hand-over route, a merge conflict, and leaving the synced folder (wave 2 B3).

use axum::Json;
use kb_ai::store::save;
use kb_ai_work::worktrees::{self as svc_worktrees, Error as WorktreeError};
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, activity, pyjson};
use kb_db::entities::{ai_worktree, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// The routes of this file, in the order of the Python file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/ai/worktrees", get_worktrees)
        .get("/tickets/{ticket_id}/ai/worktree", get_ticket_worktree)
        .post("/tickets/{ticket_id}/ai/worktree/remove", post_remove_worktree)
        .post("/tickets/{ticket_id}/ai/worktree/outputs", post_move_outputs)
        .post("/tickets/{ticket_id}/ai/worktree/commit", post_commit_worktree)
        .post("/tickets/{ticket_id}/ai/worktree/keep", post_keep_worktree)
        .post("/projects/{project_id}/ai/worktrees/cleanup", post_cleanup)
        .post("/tickets/{ticket_id}/ai/merge", post_merge)
        .patch("/tickets/{ticket_id}/ai/handover", patch_handover)
        .post("/tickets/{ticket_id}/ai/worktree/open", post_open_worktree)
}

/// `svc_activity.current_actor() or "user"`.
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// A worktree failure nothing catches: a 500 (a database error as well).
fn uncaught(err: WorktreeError) -> ApiError {
    match err {
        WorktreeError::Db(err) => err.into(),
        other => ApiError::internal(other),
    }
}

/// `except WorktreeError as exc: raise HTTPException(409, str(exc))`; any other failure is a 500.
fn conflict(err: WorktreeError) -> ApiError {
    if err.is_worktree_error() { ApiError::conflict(err.to_string()) } else { uncaught(err) }
}

/// `round(x, 1)`: the nearest one-decimal value, a tie going to the even digit as Python's does.
fn round1(x: f64) -> f64 {
    format!("{x:.1}").parse().unwrap_or(x)
}

/// Every worktree of the project with what git says now (uncommitted files, size, ahead of its base).
async fn get_worktrees(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let rows = svc_worktrees::list_for_project(&session, &project_id).await.map_err(uncaught)?;
    // `sum((r.get("live") or {}).get("size_mb") or 0 for r in rows)`: an int 0 while no size is above zero
    let sizes: Vec<f64> = rows
        .iter()
        .filter_map(|r| r.get("live").and_then(|l| l.get("size_mb")).and_then(Value::as_f64))
        .filter(|size| *size != 0.0)
        .collect();
    let total = if sizes.is_empty() { json!(0) } else { json!(round1(sizes.iter().sum())) };
    Ok(Json(json!({"worktrees": rows, "total_mb": total})))
}

/// The ticket's worktree, or null.
async fn get_ticket_worktree(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = ai_worktree::Entity::find_by_id(ticket_id.as_str()).one(&session).await?;
    match row {
        Some(row) if row.state != "removed" => {
            let live = svc_worktrees::status(&row).await.map_err(uncaught)?;
            Ok(Json(svc_worktrees::to_dict(&row, Some(live.to_value()))))
        }
        _ => Ok(Json(Value::Null)),
    }
}

/// Remove a worktree (never with uncommitted work).
#[derive(Debug, Deserialize)]
struct RemoveBody {
    #[serde(default)]
    force: bool,
}

/// Remove the ticket's worktree and give its port back.
async fn post_remove_worktree(
    Path(ticket_id): Path<String>,
    Body(body): Body<RemoveBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = svc_worktrees::remove(&session, &ticket_id, body.force).await.map_err(conflict)?;
    Ok(Json(svc_worktrees::to_dict(&row, None)))
}

/// Move the outputs left in the worktree (untracked screenshots, logs, reports) to the ticket's Workspace.
async fn post_move_outputs(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let result = svc_worktrees::move_outputs(&ticket_id).await.map_err(uncaught)?;
    svc_worktrees::log_tidy(&ticket_id, &result, Some(&by())).await.map_err(uncaught)?;
    Ok(Json(result.to_value()))
}

/// Commit the code left uncommitted in the worktree on its branch (outputs go to the Workspace first).
async fn post_commit_worktree(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(svc_worktrees::commit_now(&ticket_id, &by()).await.map_err(conflict)?))
}

/// The ticket's worktree row, or the 404 of these routes.
async fn worktree_row(ticket_id: &str) -> ApiResult<(kb_db::Session, ai_worktree::Model)> {
    let session = kb_db::session();
    match ai_worktree::Entity::find_by_id(ticket_id).one(&session).await? {
        Some(row) => Ok((session, row)),
        None => Err(ApiError::not_found("This ticket has no worktree.")),
    }
}

/// Keep a finished worktree (Clean up finished skips it).
async fn post_keep_worktree(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let (session, mut row) = worktree_row(&ticket_id).await?;
    row.state = "kept".to_string();
    let row = save::<_, ai_worktree::Model, ai_worktree::ActiveModel>(&session, row).await?;
    session.commit().await?;
    Ok(Json(svc_worktrees::to_dict(&row, None)))
}

/// Why Clean up kept a worktree, in the board's own words.
fn kept_why(exc: &WorktreeError) -> &'static str {
    if exc.to_string().contains("not committed") {
        "Some files are not committed: keep it, or commit them first."
    } else {
        "git could not remove it; the server log says why."
    }
}

/// Clean up finished: remove the worktrees of merged or done tickets that hold nothing uncommitted.
async fn post_cleanup(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let rows = ai_worktree::Entity::find()
        .filter(ai_worktree::Column::ProjectId.eq(project_id.as_str()))
        .filter(ai_worktree::Column::State.is_in(["active", "merged"]))
        .all(&session)
        .await?;
    let (mut removed, mut kept): (Vec<String>, Vec<Value>) = (Vec::new(), Vec::new());
    for row in rows {
        let found = ticket::Entity::find_by_id(row.ticket_id.as_str()).one(&session).await?;
        let finished = row.state == "merged"
            || found.as_ref().is_some_and(|t| matches!(t.status.as_str(), "done" | "wont_do"));
        if !finished {
            continue;
        }
        match svc_worktrees::remove(&session, &row.ticket_id, false).await {
            Ok(_) => removed.push(row.ticket_id.clone()),
            Err(exc) if exc.is_worktree_error() => {
                // a fixed sentence per cause: git's own words go to the log, not to the page
                tracing::info!("Worktree of {} kept: {exc}", row.ticket_id);
                kept.push(json!({"ticket_id": row.ticket_id, "why": kept_why(&exc)}));
            }
            Err(other) => return Err(uncaught(other)),
        }
    }
    Ok(Json(json!({"removed": removed, "kept": kept})))
}

/// Merge the ticket's branch (a person's action; refused while the main checkout is dirty; a conflict is rolled back
/// and becomes a Needs you row).
async fn post_merge(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(svc_worktrees::merge(&ticket_id, &by()).await.map_err(uncaught)?))
}

/// `Literal["auto", "pr", "local", "branch"]`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Route {
    Auto,
    Pr,
    Local,
    Branch,
}

/// This ticket's hand-over route, instead of the project's.
#[derive(Debug, Deserialize)]
struct HandoverBody {
    route: Route,
}

/// Merge here instead (or open a PR, or leave the branch) for this one ticket.
async fn patch_handover(
    Path(ticket_id): Path<String>,
    Body(body): Body<HandoverBody>,
) -> ApiResult<Json<Value>> {
    let (session, mut row) = worktree_row(&ticket_id).await?;
    row.handover = match body.route {
        Route::Auto => None,
        Route::Pr => Some("pr".to_string()),
        Route::Local => Some("local".to_string()),
        Route::Branch => Some("branch".to_string()),
    };
    let row = save::<_, ai_worktree::Model, ai_worktree::ActiveModel>(&session, row).await?;
    session.commit().await?;
    let mut out = match svc_worktrees::to_dict(&row, None) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    out.insert("route".into(), json!(svc_worktrees::route_for(&session, &row).await.map_err(uncaught)?));
    Ok(Json(Value::Object(out)))
}

/// What Python's `OSError` says for a program that could not be started.
fn os_error_text(err: &std::io::Error, program: &str) -> String {
    let text = err.to_string();
    let text = text.rsplit_once(" (os error").map_or(text.as_str(), |(head, _)| head).to_string();
    match err.raw_os_error() {
        Some(code) => format!("[Errno {code}] {text}: {}", pyjson::py_str(&json!(program))),
        None => text,
    }
}

/// Open the worktree's folder in the computer's file manager (the board runs on this computer).
async fn post_open_worktree(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = ai_worktree::Entity::find_by_id(ticket_id.as_str()).one(&session).await?;
    let Some(row) = row.filter(|r| r.state != "removed") else {
        return Err(ApiError::not_found("This ticket has no worktree."));
    };
    let opener = match std::env::consts::OS {
        "macos" => "open",
        "windows" => "explorer",
        _ => "xdg-open",
    };
    // started and left to run (the file manager outlives the request); it is reaped in the background
    let spawned = tokio::process::Command::new(opener)
        .arg(&row.path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(mut child) => {
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
        Err(err) => {
            return Err(ApiError::conflict(format!("Could not open the folder: {}", os_error_text(&err, opener))));
        }
    }
    Ok(Json(json!({"opened": row.path})))
}
