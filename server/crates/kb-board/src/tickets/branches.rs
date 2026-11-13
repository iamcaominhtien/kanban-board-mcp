//! `services/tickets.py`, lines 1972-2495: the branches of a ticket. A branch is a record on the ticket; when the
//! project (or the ticket) is linked to a git repository the branch is also created, renamed, checked out and
//! deleted there (`crate::git_repo`), and what the board shows comes from the repository.

use kb_base::{activity as act, pytext, time};
use kb_db::Session;
use kb_db::entities::{project, ticket};
use kb_db::sea_orm::{DbErr, EntityTrait};
use serde_json::{Map, Value, json};

use super::{Error, commit, dumps, field, loads, put, value_error};
use crate::git_repo::{self, GitError};
use kb_base::pyjson::truthy;

/// The branch statuses, in the order `sorted(VALID_BRANCH_STATUSES)` gives (Python keeps a set and sorts it for
/// the message).
pub const VALID_BRANCH_STATUSES: [&str; 5] = ["archived", "baseline", "merged", "open", "stale"];

/// `ValueError(f"Invalid branch status ...")`.
fn invalid_status<T>(status: &str) -> Result<T, Error> {
    let valid: Vec<String> = VALID_BRANCH_STATUSES.iter().map(|name| pytext::repr(name)).collect();
    value_error(format!("Invalid branch status '{status}'. Valid statuses: [{}]", valid.join(", ")))
}

/// `br["name"]`: the name of a stored branch (a record without one is Python's `KeyError`).
fn name_of(branch: &Value) -> Result<&str, Error> {
    field(branch, "name").as_str().ok_or_else(|| Error::Other("KeyError: 'name'".to_string()))
}

/// Return a ticket's branches, or None if the ticket is missing.
pub async fn list_branches(session: &Session, ticket_id: &str) -> Result<Option<Vec<Value>>, Error> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut branches = loads(&ticket.branches)?;
    if let Some(repo_path) = project_repo_path(session, &ticket).await? {
        branches = sync_branches_with_git(&repo_path, branches).await?;
    }
    Ok(Some(branches))
}

/// The branch a new branch of this ticket starts from by default, or None if the ticket is missing.
///
/// Returns `{"base": name}` with the repository's default base (main, else master, else the checked-out branch),
/// or `{"base": None}` when no repository is linked or it cannot be read.
pub async fn default_base_branch(session: &Session, ticket_id: &str) -> Result<Option<Value>, Error> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let Some(repo_path) = project_repo_path(session, &ticket).await? else {
        return Ok(Some(json!({"base": null})));
    };
    let base = match git_repo::open_repo(&repo_path).await {
        Ok(repo) => git_repo::default_base_branch(&repo).await,
        Err(_) => None,
    };
    Ok(Some(json!({"base": base})))
}

/// Effective repo for a ticket: its own override, else the project's.
pub(crate) async fn project_repo_path(session: &Session, ticket: &ticket::Model) -> Result<Option<String>, DbErr> {
    if let Some(repo_path) = ticket.repo_path.as_deref().filter(|path| !path.is_empty()) {
        return Ok(Some(repo_path.to_string()));
    }
    let project = project::Entity::find_by_id(ticket.project_id.as_str()).one(session).await?;
    // an empty path is no repository for every caller (`if repo_path:`)
    Ok(project.and_then(|p| p.repo_path).filter(|path| !path.is_empty()))
}

/// Overlay live commit hash and ahead/behind counts from the git repo.
async fn sync_branches_with_git(repo_path: &str, branches: Vec<Value>) -> Result<Vec<Value>, Error> {
    let repo = git_repo::open_repo(repo_path).await?;
    let current = git_repo::current_branch(&repo).await;
    let mut synced = Vec::with_capacity(branches.len());
    for mut br in branches {
        let is_current = *field(&br, "name") == json!(current);
        put(&mut br, "is_current", json!(is_current));
        put(&mut br, "isCurrent", json!(is_current));
        if field(&br, "status").as_str() != Some("baseline") {
            let base = git_repo::resolve_base(&repo, field(&br, "branch_from").as_str()).await;
            let info = match git_repo::branch_info(&repo, name_of(&br)?, &base).await {
                Ok(info) => info,
                Err(GitError::Repo(_) | GitError::Command(_)) => {
                    // Branch not in this repo (e.g. repo was changed): keep stored values
                    put(&mut br, "in_repo", json!(false));
                    put(&mut br, "inRepo", json!(false));
                    synced.push(br);
                    continue;
                }
                Err(other) => return Err(other.into()),
            };
            put(&mut br, "in_repo", json!(true));
            put(&mut br, "inRepo", json!(true));
            put(&mut br, "commit_hash", json!(info.commit_hash));
            put(&mut br, "commitHash", json!(info.commit_hash));
            put(&mut br, "ahead_count", json!(info.ahead_count));
            put(&mut br, "aheadCount", json!(info.ahead_count));
            put(&mut br, "behind_count", json!(info.behind_count));
            put(&mut br, "behindCount", json!(info.behind_count));
        }
        synced.push(br);
    }
    Ok(synced)
}

/// The arguments of `add_branch` after the session and the ticket, with the Python defaults.
#[derive(Debug, Clone)]
pub struct NewBranch<'a> {
    /// Branch name.
    pub name: &'a str,
    /// Branch to start from.
    pub branch_from: &'a str,
    /// Branch status, one of the valid branch statuses.
    pub status: &'a str,
    /// Pull request link.
    pub pr_url: Option<&'a str>,
    /// Head commit.
    pub commit_hash: Option<&'a str>,
    /// Another ticket this branch also serves.
    pub linked_ticket_id: Option<&'a str>,
    /// Commits ahead of `branch_from`.
    pub ahead_count: i64,
    /// Commits behind `branch_from`.
    pub behind_count: i64,
    /// Also create a git worktree.
    pub create_worktree: bool,
    /// Worktree location; defaults to the configured template.
    pub worktree_path: Option<&'a str>,
    /// A branch that already exists in the repo (an outside agent's work) is recorded as it is instead of refused.
    pub adopt: bool,
}

impl<'a> NewBranch<'a> {
    /// An open branch from main, with nothing else set.
    pub fn new(name: &'a str) -> Self {
        Self {
            name,
            branch_from: "main",
            status: "open",
            pr_url: None,
            commit_hash: None,
            linked_ticket_id: None,
            ahead_count: 0,
            behind_count: 0,
            create_worktree: false,
            worktree_path: None,
            adopt: false,
        }
    }
}

/// Record a branch on a ticket, creating it (and optionally a worktree) in the linked repo. `adopt`: a branch
/// that already exists in the repo (an outside agent's work) is recorded as it is instead of refused.
///
/// Returns the updated ticket, or None if it does not exist. Fails with `ValueError` if the status is invalid or
/// a worktree is requested without a linked repo.
pub async fn add_branch(
    session: &Session,
    ticket_id: &str,
    new: NewBranch<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let (name, status) = (new.name, new.status);
    if !VALID_BRANCH_STATUSES.contains(&status) {
        return invalid_status(status);
    }
    let mut branches = loads(&ticket.branches)?;
    let repo_path = project_repo_path(session, &ticket).await?;
    let mut resolved_worktree_path: Option<String> = None;
    let worktree_path = new.worktree_path.map(pytext::strip).filter(|path| !path.is_empty());
    let wants_worktree = new.create_worktree || worktree_path.is_some();
    if wants_worktree && repo_path.is_none() {
        return value_error("A git worktree needs a linked repository: set a repo path on the project or ticket first");
    }
    let mut branch_from = new.branch_from.to_string();
    let mut commit_hash = new.commit_hash.map(str::to_string);
    let (mut ahead_count, mut behind_count) = (new.ahead_count, new.behind_count);
    if let Some(repo_path) = repo_path.as_deref() {
        // Real git repo linked: create the branch there and use its true state.
        // "main" is the form's default; a repository whose default branch is master starts from master instead
        let repo = git_repo::open_repo(repo_path).await?;
        let base = git_repo::resolve_base(&repo, Some(new.branch_from)).await;
        let info = if new.adopt && git_repo::branch_exists(&repo, name).await {
            git_repo::branch_info(&repo, name, &base).await?
        } else {
            git_repo::create_branch(&repo, name, &base).await?
        };
        branch_from = base;
        commit_hash = Some(info.commit_hash);
        ahead_count = info.ahead_count;
        behind_count = info.behind_count;

        if new.create_worktree {
            let project = project::Entity::find_by_id(ticket.project_id.as_str()).one(session).await?;
            let prefix = project.as_ref().map_or("PRJ", |p| p.prefix.as_str());
            let template = match worktree_path {
                Some(path) => path,
                None => project
                    .as_ref()
                    .and_then(|p| p.worktree_template.as_deref())
                    .filter(|template| !template.is_empty())
                    .unwrap_or("../worktrees/{project}/{ticket_id}-{branch}"),
            };
            let target_wt = git_repo::resolve_worktree_path(template, repo_path, prefix, &ticket.id, name);

            let made = match git_repo::open_repo(repo_path).await {
                Ok(repo) => git_repo::add_worktree(&repo, &target_wt, name).await,
                Err(err) => Err(err),
            };
            match made {
                Ok(path) => resolved_worktree_path = Some(path),
                Err(err) => {
                    // Don't leave an orphan branch behind when the worktree can't be made
                    let repo = git_repo::open_repo(repo_path).await?;
                    git_repo::delete_branch(&repo, name, true).await?;
                    return Err(err.into());
                }
            }
        }
    }

    let now_iso = time::now_iso();
    let new_branch = json!({
        "id": time::uuid4(),
        "name": name,
        "status": status,
        "branch_from": branch_from,
        "branchFrom": branch_from,
        "pr_url": new.pr_url,
        "prUrl": new.pr_url,
        "commit_hash": commit_hash,
        "commitHash": commit_hash,
        "linked_ticket_id": new.linked_ticket_id,
        "linkedTicketId": new.linked_ticket_id,
        "ahead_count": ahead_count,
        "aheadCount": ahead_count,
        "behind_count": behind_count,
        "behindCount": behind_count,
        "worktree_path": resolved_worktree_path,
        "worktreePath": resolved_worktree_path,
        "created_at": now_iso,
        "createdAt": now_iso,
        "updated_at": now_iso,
        "updatedAt": now_iso,
    });
    branches.push(new_branch);
    ticket.branches = dumps(&branches);

    let mut activity = loads(&ticket.activity_log)?;
    activity.push(act::entry("branch", Value::Null, json!(name), None, None, Some(&now_iso)));
    ticket.activity_log = dumps(&activity);

    ticket.updated_at = now_iso;
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Apply/verify the git side of a branch update before the board record changes.
async fn git_guard_update(
    repo_path: &str,
    br: &Value,
    new_name: Option<&str>,
    new_status: Option<&str>,
    base: Option<&str>,
) -> Result<(), Error> {
    let repo = git_repo::open_repo(repo_path).await?;
    let old_name = name_of(br)?;
    if !git_repo::branch_exists(&repo, old_name).await {
        return Ok(()); // branch isn't in this repo (e.g. repo changed): board-only update
    }
    if new_status == Some("merged") && field(br, "status").as_str() != Some("merged") {
        let base_ref = base.filter(|base| !base.is_empty()).unwrap_or("main");
        if !git_repo::is_merged(&repo, old_name, base_ref).await? {
            return value_error(format!(
                "'{old_name}' still has commits that are not in '{base_ref}'; merge it in git first"
            ));
        }
    }
    if let Some(new_name) = new_name.filter(|name| !name.is_empty() && *name != old_name) {
        git_repo::rename_branch(&repo, old_name, new_name).await?;
    }
    Ok(())
}

/// The arguments of `update_branch` after the branch's id: only the fields that are given are changed.
#[derive(Debug, Clone, Default)]
pub struct BranchChanges<'a> {
    /// New name (renamed in the repo too when linked).
    pub name: Option<&'a str>,
    /// New status.
    pub status: Option<&'a str>,
    /// New base branch.
    pub branch_from: Option<&'a str>,
    /// New pull request link.
    pub pr_url: Option<&'a str>,
    /// New head commit.
    pub commit_hash: Option<&'a str>,
    /// Another ticket this branch also serves.
    pub linked_ticket_id: Option<&'a str>,
    /// Commits ahead of the base.
    pub ahead_count: Option<i64>,
    /// Commits behind the base.
    pub behind_count: Option<i64>,
    /// Remove the branch's git worktree.
    pub remove_worktree: bool,
    /// New worktree location.
    pub worktree_path: Option<&'a str>,
}

/// Update a branch; only the fields you pass are changed.
///
/// Returns the updated ticket, or None if the ticket or branch does not exist. Fails with `ValueError` if the
/// status is invalid.
pub async fn update_branch(
    session: &Session,
    ticket_id: &str,
    branch_id: &str,
    changes: BranchChanges<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let (name, status) = (changes.name, changes.status);
    if let Some(status) = status.filter(|status| !VALID_BRANCH_STATUSES.contains(status)) {
        return invalid_status(status);
    }
    let mut branches = loads(&ticket.branches)?;
    let mut found = false;
    let now_iso = time::now_iso();
    let repo_for_git = project_repo_path(session, &ticket).await?;
    for br in &mut branches {
        if field(br, "id").as_str() == Some(branch_id) {
            found = true;
            let old_name = field(br, "name").clone();
            let old_status = field(br, "status").clone();
            let had_worktree = field(br, "worktree_path").clone();
            if let Some(repo_for_git) = repo_for_git.as_deref() {
                if field(br, "status").as_str() != Some("baseline") {
                    let base = match changes.branch_from {
                        Some(base) => Some(base.to_string()),
                        None => field(br, "branch_from").as_str().map(str::to_string),
                    };
                    git_guard_update(repo_for_git, br, name, status, base.as_deref()).await?;
                }
            }
            if let Some(name) = name {
                put(br, "name", json!(name));
            }
            if let Some(status) = status {
                put(br, "status", json!(status));
            }
            if let Some(branch_from) = changes.branch_from {
                put(br, "branch_from", json!(branch_from));
                put(br, "branchFrom", json!(branch_from));
            }
            if let Some(pr_url) = changes.pr_url {
                put(br, "pr_url", json!(pr_url));
                put(br, "prUrl", json!(pr_url));
            }
            if let Some(commit_hash) = changes.commit_hash {
                put(br, "commit_hash", json!(commit_hash));
                put(br, "commitHash", json!(commit_hash));
            }
            if let Some(linked_ticket_id) = changes.linked_ticket_id {
                put(br, "linked_ticket_id", json!(linked_ticket_id));
                put(br, "linkedTicketId", json!(linked_ticket_id));
            }
            if let Some(ahead_count) = changes.ahead_count {
                put(br, "ahead_count", json!(ahead_count));
                put(br, "aheadCount", json!(ahead_count));
            }
            if let Some(behind_count) = changes.behind_count {
                put(br, "behind_count", json!(behind_count));
                put(br, "behindCount", json!(behind_count));
            }
            if changes.remove_worktree && truthy(field(br, "worktree_path")) {
                if let Some(repo_path) = project_repo_path(session, &ticket).await? {
                    let wt = field(br, "worktree_path").as_str().unwrap_or_default().to_string();
                    // Errors propagate: the board must not claim the worktree is gone
                    let repo = git_repo::open_repo(&repo_path).await?;
                    git_repo::remove_worktree(&repo, &wt, true).await?;
                }
                put(br, "worktree_path", Value::Null);
                put(br, "worktreePath", Value::Null);
            } else if let Some(worktree_path) = changes.worktree_path {
                let kept = Some(worktree_path).filter(|path| !pytext::strip(path).is_empty());
                put(br, "worktree_path", json!(kept));
                put(br, "worktreePath", json!(kept));
            }
            put(br, "updated_at", json!(now_iso));
            put(br, "updatedAt", json!(now_iso));
            let log = &mut ticket.activity_log;
            if let Some(name) = name.filter(|name| old_name.as_str() != Some(name)) {
                act::record(log, "branch", old_name, json!(name), None, None);
            }
            if let Some(status) = status.filter(|status| old_status.as_str() != Some(status)) {
                act::record(log, "branch_status", old_status, json!(status), field(br, "name").as_str(), None);
            }
            if truthy(&had_worktree) && !truthy(field(br, "worktree_path")) {
                act::record(log, "branch_worktree", had_worktree, Value::Null, field(br, "name").as_str(), None);
            }
            break;
        }
    }
    if !found {
        return Ok(None);
    }
    ticket.branches = dumps(&branches);
    ticket.updated_at = now_iso;
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Remove a branch record, optionally with its worktree and git branch.
///
/// `remove_worktree`: also remove its git worktree. `delete_git_branch`: also delete the branch in the repo.
/// `force`: force deletion of an unmerged branch.
///
/// Returns the updated ticket (also when no branch has this id), or None if the ticket does not exist.
pub async fn delete_branch(
    session: &Session,
    ticket_id: &str,
    branch_id: &str,
    remove_worktree: bool,
    delete_git_branch: bool,
    force: bool,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut branches = loads(&ticket.branches)?;
    let target = branches.iter().find(|b| field(b, "id").as_str() == Some(branch_id)).cloned();
    let repo_path = project_repo_path(session, &ticket).await?;
    if let (Some(repo_path), Some(target)) = (repo_path.as_deref(), &target) {
        // Git first: if any step fails, raise before the board record is touched.
        let repo = git_repo::open_repo(repo_path).await?;
        if remove_worktree && truthy(field(target, "worktree_path")) {
            let wt = field(target, "worktree_path").as_str().unwrap_or_default();
            git_repo::remove_worktree(&repo, wt, true).await?;
        }
        if delete_git_branch && field(target, "status").as_str() != Some("baseline") {
            git_repo::delete_branch(&repo, name_of(target)?, force).await?;
        }
    }

    if let Some(target) = &target {
        act::record(&mut ticket.activity_log, "branch", field(target, "name").clone(), Value::Null, None, None);
    }
    branches.retain(|br| field(br, "id").as_str() != Some(branch_id));
    ticket.branches = dumps(&branches);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Check out a ticket branch in the linked repository's main working tree.
///
/// Returns the updated ticket, or None if the ticket or branch does not exist. Fails with `ValueError` if no
/// repository is linked.
pub async fn checkout_branch(
    session: &Session,
    ticket_id: &str,
    branch_id: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let branches = loads(&ticket.branches)?;
    let Some(target) = branches.iter().find(|b| field(b, "id").as_str() == Some(branch_id)) else {
        return Ok(None);
    };
    let Some(repo_path) = project_repo_path(session, &ticket).await? else {
        return value_error("Link a git repository to this project or ticket before checking out branches");
    };
    let name = name_of(target)?;
    let repo = git_repo::open_repo(&repo_path).await?;
    git_repo::checkout_branch(&repo, name).await?;
    act::record(&mut ticket.activity_log, "branch_checkout", Value::Null, json!(name), None, None);
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Return the commit graph for the ticket's branches; `linked` is False without a repo.
///
/// `limit` is the maximum number of commits (80 in Python when not given). Returns the graph data, or None if the
/// ticket does not exist.
pub async fn get_branch_graph(
    session: &Session,
    ticket_id: &str,
    limit: i64,
) -> Result<Option<Map<String, Value>>, Error> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let empty = |linked: bool| match json!({"linked": linked, "commits": [], "lane_count": 1, "truncated": false}) {
        Value::Object(graph) => graph,
        _ => Map::new(),
    };
    let Some(repo_path) = project_repo_path(session, &ticket).await? else {
        return Ok(Some(empty(false)));
    };
    let branches = loads(&ticket.branches)?;
    let limit = limit.clamp(1, git_repo::HARD_LIMIT as i64) as usize;

    let repo = git_repo::open_repo(&repo_path).await?;
    let mut present: Vec<String> = Vec::new();
    for b in branches.iter().filter(|b| field(b, "status").as_str() != Some("baseline")) {
        let name = name_of(b)?;
        if git_repo::branch_exists(&repo, name).await {
            present.push(name.to_string());
        }
    }
    let mut bases: Vec<String> = Vec::new();
    for b in &branches {
        let base = field(b, "branch_from").as_str().unwrap_or("");
        if !base.is_empty() && !bases.iter().any(|b| b == base) && !present.iter().any(|p| p == base) {
            match git_repo::resolve_ref(&repo, base).await {
                Ok(_) => bases.push(base.to_string()),
                Err(GitError::Repo(_)) => {}
                Err(other) => return Err(other.into()),
            }
        }
    }
    if bases.is_empty() {
        let current = git_repo::current_branch(&repo).await;
        for candidate in [Some("main"), Some("master"), current.as_deref()] {
            if let Some(candidate) = candidate.filter(|c| !c.is_empty()) {
                if git_repo::branch_exists(&repo, candidate).await {
                    bases.push(candidate.to_string());
                    break;
                }
            }
        }
    }
    if bases.is_empty() {
        return Ok(Some(empty(true)));
    }
    let mut graph = git_repo::commit_graph(&repo, &bases, &present, limit).await?;
    graph.insert("linked".into(), json!(true));
    graph.insert("branches".into(), json!(present));
    Ok(Some(graph))
}

/// Return details of a commit in the ticket's linked repo.
///
/// `rev` is a commit hash or revision. Returns the commit details, or None if the ticket does not exist. Fails
/// with `ValueError` if no repository is linked.
pub async fn get_commit_detail(
    session: &Session,
    ticket_id: &str,
    rev: &str,
) -> Result<Option<Map<String, Value>>, Error> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let Some(repo_path) = project_repo_path(session, &ticket).await? else {
        return value_error("Link a git repository to this project or ticket first");
    };
    let repo = git_repo::open_repo(&repo_path).await?;
    Ok(Some(git_repo::commit_detail(&repo, rev, git_repo::MAX_DETAIL_FILES).await?))
}
