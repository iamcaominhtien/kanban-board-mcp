//! Hand-over (design J): the pull request, the merge on this machine, and what the ticket's moves start
//! (`worktrees.py`, from `guess_route` to `_spawn`).

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use async_trait::async_trait;
use kb_base::{pytext, time};
use kb_db::entities::{ai_run, ai_worktree, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::outputs::commit_leftovers;
use super::{Error, commit_row, git, git_try, git_with, is_github, remove};
use crate::proc::{self, Spec};

/// What the Python tests put in place of `worktrees.on_review` and `worktrees.merge` (a monkeypatch). Empty in the
/// app: the real functions run.
#[async_trait]
pub trait Handover: Send + Sync {
    /// Stands for `worktrees.on_review(ticket_id)`.
    async fn on_review(&self, ticket_id: &str) -> Result<Option<Value>, Error>;
    /// Stands for `worktrees.merge(ticket_id, by=by)`.
    async fn merge(&self, ticket_id: &str, by: &str) -> Result<Value, Error>;
}

static HANDOVER: RwLock<Option<Arc<dyn Handover>>> = RwLock::new(None);

/// Replace the hand-over calls of `on_status` and `after_run` (tests only; `None` puts the real ones back).
pub fn set_handover(handover: Option<Arc<dyn Handover>>) {
    *HANDOVER.write().unwrap_or_else(|e| e.into_inner()) = handover;
}

fn handover() -> Option<Arc<dyn Handover>> {
    HANDOVER.read().unwrap_or_else(|e| e.into_inner()).clone()
}

async fn call_on_review(ticket_id: &str) -> Result<Option<Value>, Error> {
    match handover() {
        Some(h) => h.on_review(ticket_id).await,
        None => on_review(ticket_id).await,
    }
}

async fn call_merge(ticket_id: &str, by: &str) -> Result<Value, Error> {
    match handover() {
        Some(h) => h.merge(ticket_id, by).await,
        None => merge(ticket_id, by).await,
    }
}

/// `shutil.which("gh")` on this process's PATH.
fn gh_on_path() -> bool {
    let path = std::env::var("PATH").unwrap_or_else(|_| "/bin:/usr/bin".to_string());
    crate::project_env::which("gh", &path).is_some()
}

/// auto → pr (a GitHub remote and gh signed in), local (no remote), or branch (another host).
pub async fn guess_route(repo: &str) -> Result<String, Error> {
    let remote = pytext::strip(&git_try(repo, &["remote", "get-url", "origin"]).await?.stdout).to_string();
    if remote.is_empty() {
        return Ok("local".to_string());
    }
    if is_github(Some(&remote)) && gh_on_path() {
        let argv = ["gh".to_string(), "auth".to_string(), "status".to_string()];
        let spec = Spec { cwd: Some(repo), ..Spec::default() };
        if let Ok(auth) = proc::run(&argv, &spec, 20.0).await {
            if auth.returncode == 0 {
                return Ok("pr".to_string());
            }
        }
    }
    Ok("branch".to_string())
}

/// The hand-over route of a ticket: its own override, else the project's, guessed when auto.
pub async fn route_for(session: &kb_db::Session, row: &ai_worktree::Model) -> Result<String, Error> {
    if let Some(own) = row.handover.as_deref().filter(|h| !h.is_empty() && *h != "auto") {
        return Ok(own.to_string());
    }
    let settings = kb_ai::store::get_settings(session, &row.project_id).await?;
    let all = kb_ai::ops::get(Some(&settings));
    let chosen = all
        .get("worktrees")
        .and_then(|w| w.get("handover"))
        .filter(|h| kb_base::pyjson::truthy(h))
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string();
    if chosen != "auto" { Ok(chosen) } else { guess_route(&row.repo).await }
}

static PULL_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/pull/(\d+)").expect("a fixed pattern"));

/// The ticket reached Review: push the branch, and open a draft pull request when the route says so.
pub async fn on_review(ticket_id: &str) -> Result<Option<Value>, Error> {
    let (row, ticket, route) = {
        let session = kb_db::session();
        let row = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await?;
        let ticket = ticket::Entity::find_by_id(ticket_id).one(&session).await?;
        let (Some(row), Some(ticket)) = (row, ticket) else {
            return Ok(None);
        };
        if row.state != "active" {
            return Ok(None);
        }
        let route = route_for(&session, &row).await?;
        (row, ticket, route)
    };
    if route == "local" {
        return Ok(Some(json!({"route": route})));
    }
    commit_leftovers(&row, &format!("{ticket_id}: work in progress handed over for review")).await?;
    let push = git_with(&row.path, &["push", "-u", "origin", &row.branch], 180.0, false).await?;
    if push.returncode != 0 {
        let text: String = pytext::strip(&push.stderr).chars().take(200).collect();
        return Ok(Some(json!({"route": route, "error": format!("git push failed: {text}")})));
    }
    if route != "pr" || row.pr_url.as_deref().is_some_and(|u| !u.is_empty()) {
        return Ok(Some(json!({"route": route, "pushed": true})));
    }
    let body = format!(
        "{}\n\nOpened by the Kanban board for {ticket_id}. It becomes ready for review when the ticket reaches Done.",
        ticket.description
    );
    let argv: Vec<String> = [
        "gh",
        "pr",
        "create",
        "--draft",
        "--head",
        &row.branch,
        "--base",
        &row.base,
        "--title",
        &format!("{ticket_id}: {}", ticket.title),
        "--body",
        pytext::strip(&body),
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    let spec = Spec { cwd: Some(&row.path), ..Spec::default() };
    let out = match proc::run(&argv, &spec, 120.0).await {
        Ok(out) => out,
        Err(err) => {
            let text: String = err.to_string().chars().take(200).collect();
            return Ok(Some(json!({"route": route, "error": text})));
        }
    };
    if out.returncode != 0 {
        let text: String = pytext::strip(&out.stderr).chars().take(200).collect();
        return Ok(Some(json!({"route": route, "error": format!("gh pr create failed: {text}")})));
    }
    let stdout = pytext::strip(&out.stdout);
    let url: Option<String> =
        if stdout.is_empty() { None } else { pytext::splitlines(stdout).last().map(|l| (*l).to_string()) };
    let session = kb_db::session();
    if let Some(mut row) = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await? {
        row.pr_url = url.clone();
        row.pr_number = PULL_NUMBER
            .captures(url.as_deref().unwrap_or(""))
            .and_then(|m| kb_ai::store::py_int(&Value::String(m[1].to_string())))
            .and_then(|n| i32::try_from(n).ok());
        commit_row(&session, row).await?;
    }
    Ok(Some(json!({"route": route, "pr_url": url})))
}

/// Merge a ticket's branch into the main checkout (only when a person asks). Refused while the main checkout is
/// dirty; a conflict is rolled back, the worktree is left exactly as it was, and a Needs you row offers who resolves
/// it. On success the worktree is removed and its port given back.
///
/// Returns `{"merged": bool, "conflict": [...files], "refused": "why"}` (and the other keys of the routes).
pub async fn merge(ticket_id: &str, _by: &str) -> Result<Value, Error> {
    let (row, route) = {
        let session = kb_db::session();
        let row = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await?;
        let Some(row) = row.filter(|r| matches!(r.state.as_str(), "active" | "conflict" | "kept")) else {
            return Ok(json!({"merged": false, "refused": "This ticket has no worktree to merge."}));
        };
        let route = route_for(&session, &row).await?;
        (row, route)
    };
    if route == "pr" {
        if row.pr_number.is_some_and(|n| n != 0) {
            let argv: Vec<String> = ["gh", "pr", "ready", &row.pr_number.unwrap_or(0).to_string()]
                .iter()
                .map(|s| (*s).to_string())
                .collect();
            let spec = Spec { cwd: Some(&row.path), ..Spec::default() };
            proc::run(&argv, &spec, 60.0).await?;
        }
        return Ok(json!({"merged": false, "pr_ready": row.pr_number.is_some_and(|n| n != 0), "pr_url": row.pr_url}));
    }
    if route == "branch" {
        commit_leftovers(&row, &format!("{ticket_id}: done")).await?;
        git_with(&row.path, &["push", "-u", "origin", &row.branch], 180.0, false).await?;
        return Ok(json!({"merged": false, "pushed": true}));
    }
    let status = git_try(&row.repo, &["status", "--porcelain"]).await?;
    let own_name = Path::new(&row.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dirty: Vec<String> = pytext::splitlines(&status.stdout)
        .into_iter()
        .filter(|d| !pytext::strip(d).is_empty())
        .map(super::after_status)
        .filter(|d| !d.starts_with(&own_name))
        .collect();
    if !dirty.is_empty() {
        let shown: Vec<&str> = dirty.iter().take(8).map(String::as_str).collect();
        return Ok(json!({
            "merged": false,
            "refused": format!("The main checkout has uncommitted changes: {}", shown.join(", ")),
        }));
    }
    commit_leftovers(&row, &format!("{ticket_id}: done")).await?;
    let current = pytext::strip(&git(&row.repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?.stdout).to_string();
    if current != row.base {
        return Ok(json!({
            "merged": false,
            "refused": format!("The main checkout is on {current}, not {}.", row.base),
        }));
    }
    let message = format!("Merge {ticket_id}: {}", row.branch);
    let out =
        git_with(&row.repo, &["merge", "--no-ff", "--no-edit", &row.branch, "-m", &message], 300.0, false).await?;
    if out.returncode != 0 {
        let diff = git_try(&row.repo, &["diff", "--name-only", "--diff-filter=U"]).await?;
        let files: Vec<String> = pytext::split(&diff.stdout).into_iter().map(str::to_string).collect();
        git_try(&row.repo, &["merge", "--abort"]).await?;
        if files.is_empty() {
            // not a conflict (a hook, a lock, git itself): say what git said instead of naming no files
            let text: String = out.problem().chars().take(300).collect();
            return Ok(json!({"merged": false, "refused": format!("git could not merge: {text}")}));
        }
        let session = kb_db::session();
        if let Some(mut row) = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await? {
            let shown: Vec<&String> = files.iter().take(50).collect();
            row.state = "conflict".to_string();
            row.conflict_files = kb_base::pyjson::dumps(&json!(shown));
            let row = commit_row(&session, row).await?;
            let recipients = kb_notify::owners_and_admins(&session, Some(&row.project_id))
                .await
                .map_err(|e| Error::Other(e.to_string()))?;
            let first: Vec<&str> = files.iter().take(4).map(String::as_str).collect();
            let mut data = Map::new();
            data.insert("files".into(), json!(shown));
            let fields = kb_notify::EmitFields {
                project_id: Some(row.project_id.clone()),
                recipients,
                title: format!("{ticket_id} cannot be merged: {} has moved", row.base),
                body: Some(format!(
                    "{} file{} from {}: {}. The merge was not started, so the worktree is exactly as the AI left it.",
                    files.len(),
                    if files.len() != 1 { "s differ" } else { " differs" },
                    row.base,
                    first.join(", "),
                )),
                target_kind: Some("ticket".to_string()),
                target_id: Some(ticket_id.to_string()),
                ticket_id: Some(ticket_id.to_string()),
                data: Some(data),
                ..kb_notify::EmitFields::default()
            };
            kb_notify::emit("merge_conflict", Some(&session), fields).await.map_err(|e| Error::Other(e.to_string()))?;
        }
        return Ok(json!({"merged": false, "conflict": files}));
    }
    let session = kb_db::session();
    if let Some(mut row) = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await? {
        row.merged_at = Some(time::now_iso());
        row.state = "merged".to_string();
        commit_row(&session, row).await?;
        match remove(&session, ticket_id, false).await {
            Ok(_) => {}
            Err(err) if err.is_worktree_error() => {
                if let Some(mut row) = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await? {
                    row.state = "merged".to_string();
                    commit_row(&session, row).await?;
                }
            }
            Err(other) => return Err(other),
        }
    }
    Ok(json!({"merged": true}))
}

// tickets moved to Review while their run was still working: handed over when it stops
static DEFERRED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// `worktrees._DEFERRED.clear()`.
pub fn clear_deferred() {
    DEFERRED.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

fn deferred_has(ticket_id: &str) -> bool {
    DEFERRED.lock().unwrap_or_else(|e| e.into_inner()).contains(ticket_id)
}

fn deferred_add(ticket_id: &str) {
    DEFERRED.lock().unwrap_or_else(|e| e.into_inner()).insert(ticket_id.to_string());
}

fn deferred_discard(ticket_id: &str) {
    DEFERRED.lock().unwrap_or_else(|e| e.into_inner()).remove(ticket_id);
}

/// `_spawn`: run `fut` in the background (`kb_base::ctx::spawn`, a copy of the current context); nothing happens when
/// no runtime is running.
fn spawn_task<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    kb_base::ctx::spawn(fut);
}

/// Hand-over on the ticket's moves: Review pushes (and opens the draft PR), Done merges or marks the PR ready, but
/// only when a person moved it. In the background, never in the request.
///
/// A move to Review the Board AI made (a turn of its chat, or a change that carries "suggested by") hands nothing over:
/// a push and a pull request post outside the board, which the Board AI never does by itself, and its Undo could not
/// take them back. The person's own move to Review (or the AI member's that worked on the ticket) does.
pub fn on_status(ticket_id: &str, status: &str, previous: &str, by_ai: bool) {
    if status == previous || !matches!(status, "review" | "done") {
        return;
    }
    if status == "done" && by_ai {
        // no AI ever merges (D7)
        return;
    }
    // `act._suggested.get()`: an entry made now names who suggested the change when somebody did
    let suggested =
        kb_base::activity::entry("", Value::Null, Value::Null, None, None, None).get("suggested_by").is_some();
    if status == "review" && suggested {
        // a Board AI move (Done is always asked first, so a person confirmed that one)
        return;
    }
    let ctx = kb_ai::guard::current();
    if status == "review" && ctx.is_some_and(|c| c.trigger == "assistant") {
        // the Board AI's chat acts at once only on what Undo can take back: a push and a PR it cannot
        return;
    }
    let ticket_id = ticket_id.to_string();
    let review = status == "review";
    spawn_task(async move {
        let outcome: Result<(), Error> = async {
            if review {
                // the AI may have moved its own ticket mid-run: while its CLI may still be writing, the hand-over
                // waits for the run to stop (`after_run`); whichever side finds it free takes it, once
                deferred_add(&ticket_id);
                if run_is_working(&ticket_id).await? || !deferred_has(&ticket_id) {
                    return Ok(());
                }
                deferred_discard(&ticket_id);
                call_on_review(&ticket_id).await?;
            } else {
                call_merge(&ticket_id, "person").await?;
            }
            Ok(())
        }
        .await;
        if let Err(err) = outcome {
            // a hand-over that fails must never disturb the board
            tracing::error!("Hand-over of {ticket_id} failed: {err}");
        }
    });
}

/// Whether a CLI run is working in the ticket's worktree right now.
pub(crate) async fn run_is_working(ticket_id: &str) -> Result<bool, Error> {
    let session = kb_db::session();
    let row = ai_run::Entity::find()
        .filter(ai_run::Column::TicketId.eq(ticket_id))
        .filter(ai_run::Column::State.is_in(["starting", "running"]))
        .one(&session)
        .await?;
    Ok(row.is_some())
}

/// A run of the ticket stopped (its CLI exited): a Review hand-over that waited for it goes now, if the ticket is
/// still in Review and nothing else works in its worktree.
pub fn after_run(ticket_id: &str) {
    if !deferred_has(ticket_id) {
        return;
    }
    let ticket_id = ticket_id.to_string();
    spawn_task(async move {
        let outcome: Result<(), Error> = async {
            if run_is_working(&ticket_id).await? || !deferred_has(&ticket_id) {
                // another run took the worktree (it hands over when that one stops), or it was taken
                return Ok(());
            }
            deferred_discard(&ticket_id);
            let status = {
                let session = kb_db::session();
                ticket::Entity::find_by_id(ticket_id.as_str()).one(&session).await?.map(|t| t.status)
            };
            if status.as_deref() == Some("review") {
                call_on_review(&ticket_id).await?;
            }
            Ok(())
        }
        .await;
        if let Err(err) = outcome {
            tracing::error!("Hand-over of {ticket_id} failed: {err}");
        }
    });
}

/// `tidy_after_run` in the background, never failing the run's end.
pub fn tidy_later(ticket_id: Option<&str>, run_id: &str) {
    let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) else {
        return;
    };
    let (ticket_id, run_id) = (ticket_id.to_string(), run_id.to_string());
    spawn_task(async move {
        if let Err(err) = super::outputs::tidy_after_run(&ticket_id, &run_id).await {
            // tidying must never disturb the board
            tracing::error!("Tidying the worktree of {ticket_id} failed: {err}");
        }
    });
}
