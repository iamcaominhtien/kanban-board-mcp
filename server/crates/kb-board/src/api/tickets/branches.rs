//! `api/tickets.py`, lines 1099-1276: the branches of a ticket, the commit graph and the details of a commit of the
//! linked repository.
//!
//! `GET /tickets/{ticket_id}/branches/base` is registered before the routes of one branch. In FastAPI a PATCH or a
//! DELETE of that path falls through to `/tickets/{ticket_id}/branches/{branch_id}` with the branch id `base`;
//! axum would answer 405 for it, so those two methods are served on the literal path too (not listed: they are
//! the same routes).

use axum::Json;
use axum::http::StatusCode;
use axum::routing;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiResult, Routes};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{bad_request, changed, given, int, not_found, optional_int, query_bool, query_int, uncaught};
use crate::schemas::TicketRead;
use crate::tickets::schemas::literal;
use crate::tickets::{
    BranchChanges, NewBranch, add_branch, checkout_branch, default_base_branch, delete_branch, get_branch_graph,
    get_commit_detail, list_branches, update_branch,
};

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        .get("/tickets/{ticket_id}/graph", get_ticket_graph)
        .get("/tickets/{ticket_id}/commits/{rev}", get_ticket_commit)
        .get("/tickets/{ticket_id}/branches/base", get_ticket_default_base)
        .hidden("PATCH", "/tickets/{ticket_id}/branches/base", routing::patch(patch_branch_base))
        .hidden("DELETE", "/tickets/{ticket_id}/branches/base", routing::delete(del_branch_base))
        .get("/tickets/{ticket_id}/branches", get_ticket_branches)
        .post("/tickets/{ticket_id}/branches", post_branch)
        .patch("/tickets/{ticket_id}/branches/{branch_id}", patch_branch)
        .delete("/tickets/{ticket_id}/branches/{branch_id}", del_branch)
        .post("/tickets/{ticket_id}/branches/{branch_id}/checkout", post_checkout_branch)
}

literal! {
    /// `Literal["baseline", "open", "merged", "stale", "archived"]`.
    BranchStatus {
        Baseline => "baseline",
        Open => "open",
        Merged => "merged",
        Stale => "stale",
        Archived => "archived",
    }
}

fn default_branch_from() -> String {
    "main".to_string()
}

fn default_status() -> BranchStatus {
    BranchStatus::Open
}

/// Request body to add a branch.
#[derive(Debug, Deserialize)]
struct BranchCreateBody {
    name: String,
    #[serde(default = "default_branch_from")]
    branch_from: String,
    #[serde(default = "default_status")]
    status: BranchStatus,
    #[serde(default)]
    pr_url: Option<String>,
    #[serde(default)]
    commit_hash: Option<String>,
    #[serde(default)]
    linked_ticket_id: Option<String>,
    #[serde(default, deserialize_with = "int")]
    ahead_count: i64,
    #[serde(default, deserialize_with = "int")]
    behind_count: i64,
    #[serde(default)]
    create_worktree: bool,
    #[serde(default)]
    worktree_path: Option<String>,
}

/// Request body to update a branch.
#[derive(Debug, Deserialize)]
struct BranchUpdateBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    branch_from: Option<String>,
    #[serde(default)]
    status: Option<BranchStatus>,
    #[serde(default)]
    pr_url: Option<String>,
    #[serde(default)]
    commit_hash: Option<String>,
    #[serde(default)]
    linked_ticket_id: Option<String>,
    #[serde(default, deserialize_with = "optional_int")]
    ahead_count: Option<i64>,
    #[serde(default, deserialize_with = "optional_int")]
    behind_count: Option<i64>,
    #[serde(default)]
    remove_worktree: bool,
    #[serde(default)]
    worktree_path: Option<String>,
}

/// The query of `GET /tickets/{ticket_id}/graph`.
#[derive(Debug, Deserialize)]
struct GraphQuery {
    #[serde(default, deserialize_with = "given")]
    limit: Option<String>,
}

/// Get the commit graph of the ticket's linked repo.
async fn get_ticket_graph(
    Path(ticket_id): Path<String>,
    Query(query): Query<GraphQuery>,
) -> ApiResult<Json<Map<String, Value>>> {
    let limit = query_int("limit", query.limit.as_deref(), 80)?;
    let session = kb_db::session();
    let graph = get_branch_graph(&session, &ticket_id, limit).await.map_err(bad_request)?;
    graph.map(Json).ok_or_else(not_found)
}

/// Get details of one commit.
async fn get_ticket_commit(Path((ticket_id, rev)): Path<(String, String)>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let detail = get_commit_detail(&session, &ticket_id, &rev).await.map_err(bad_request)?;
    detail.map(Json).ok_or_else(not_found)
}

/// The branch a new branch starts from by default (the repository's main, master or checked-out branch).
async fn get_ticket_default_base(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let base = default_base_branch(&session, &ticket_id).await.map_err(uncaught)?;
    base.map(Json).ok_or_else(not_found)
}

/// List a ticket's branches.
async fn get_ticket_branches(Path(ticket_id): Path<String>) -> ApiResult<Json<Vec<Value>>> {
    let session = kb_db::session();
    let branches = list_branches(&session, &ticket_id).await.map_err(uncaught)?;
    branches.map(Json).ok_or_else(not_found)
}

/// Add a branch to a ticket.
async fn post_branch(
    Path(ticket_id): Path<String>,
    Body(body): Body<BranchCreateBody>,
) -> ApiResult<(StatusCode, Json<TicketRead>)> {
    let session = kb_db::session();
    let new = NewBranch {
        name: &body.name,
        branch_from: &body.branch_from,
        status: body.status.as_str(),
        pr_url: body.pr_url.as_deref(),
        commit_hash: body.commit_hash.as_deref(),
        linked_ticket_id: body.linked_ticket_id.as_deref(),
        ahead_count: body.ahead_count,
        behind_count: body.behind_count,
        create_worktree: body.create_worktree,
        worktree_path: body.worktree_path.as_deref(),
        adopt: false,
    };
    let ticket = add_branch(&session, &ticket_id, new).await.map_err(bad_request)?;
    Ok((StatusCode::CREATED, changed(ticket).await?))
}

/// Update a branch.
async fn patch_branch(
    Path((ticket_id, branch_id)): Path<(String, String)>,
    Body(body): Body<BranchUpdateBody>,
) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let changes = BranchChanges {
        name: body.name.as_deref(),
        status: body.status.map(BranchStatus::as_str),
        branch_from: body.branch_from.as_deref(),
        pr_url: body.pr_url.as_deref(),
        commit_hash: body.commit_hash.as_deref(),
        linked_ticket_id: body.linked_ticket_id.as_deref(),
        ahead_count: body.ahead_count,
        behind_count: body.behind_count,
        remove_worktree: body.remove_worktree,
        worktree_path: body.worktree_path.as_deref(),
    };
    let ticket = update_branch(&session, &ticket_id, &branch_id, changes).await.map_err(bad_request)?;
    changed(ticket).await
}

/// `PATCH /tickets/{ticket_id}/branches/base`: the branch whose id is `base`.
async fn patch_branch_base(Path(ticket_id): Path<String>, body: Body<BranchUpdateBody>) -> ApiResult<Json<TicketRead>> {
    patch_branch(Path((ticket_id, "base".to_string())), body).await
}

/// The query of `DELETE /tickets/{ticket_id}/branches/{branch_id}`.
#[derive(Debug, Deserialize)]
struct DeleteQuery {
    #[serde(default, deserialize_with = "given")]
    remove_worktree: Option<String>,
    #[serde(default, deserialize_with = "given")]
    delete_git_branch: Option<String>,
    #[serde(default, deserialize_with = "given")]
    force: Option<String>,
}

/// Delete a branch record.
async fn del_branch(
    Path((ticket_id, branch_id)): Path<(String, String)>,
    Query(query): Query<DeleteQuery>,
) -> ApiResult<Json<TicketRead>> {
    let remove_worktree = query_bool("remove_worktree", query.remove_worktree.as_deref(), false)?;
    let delete_git_branch = query_bool("delete_git_branch", query.delete_git_branch.as_deref(), false)?;
    let force = query_bool("force", query.force.as_deref(), false)?;
    let session = kb_db::session();
    let ticket = delete_branch(&session, &ticket_id, &branch_id, remove_worktree, delete_git_branch, force)
        .await
        .map_err(bad_request)?;
    changed(ticket).await
}

/// `DELETE /tickets/{ticket_id}/branches/base`: the branch whose id is `base`.
async fn del_branch_base(Path(ticket_id): Path<String>, query: Query<DeleteQuery>) -> ApiResult<Json<TicketRead>> {
    del_branch(Path((ticket_id, "base".to_string())), query).await
}

/// Check out a ticket's branch in the linked repo.
async fn post_checkout_branch(Path((ticket_id, branch_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = checkout_branch(&session, &ticket_id, &branch_id).await.map_err(bad_request)?;
    changed(ticket).await
}
