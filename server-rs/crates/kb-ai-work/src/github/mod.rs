//! GitHub: red CI and review comments on a pull request the board opened go back to the AI that wrote the code
//! (design/screens/ai-board-wave3.md, J; plan D21). Port of `services/ai/github.py`.
//!
//! - Only pull requests the board opened (`worktrees` records them). Nothing is stored about any other.
//! - The app runs on this computer, so there is no webhook: `gh` is asked every few minutes while a pull request is
//!   open (`ops.github.poll_min`, 5 by default).
//! - Red CI: the failing job's log (`gh run view --log-failed`) goes to the ticket's Dev in a run on the ticket's
//!   worktree — but first the same check is looked up on the base branch: when it is red there too, the ticket is not
//!   to blame and the board does not give it to the team.
//! - Review comments from people: the text and the lines go to the AI, which replies on the thread when something
//!   changed. It never resolves a person's thread.
//! - On a pull request the board opened, pushing to that branch and replying on its threads are part of the work: they
//!   happen inside the run without asking, and are recorded in it. Anything else that leaves the board still asks.
//!
//! A project turns this on in its settings (`ops.github.on`); the board sends the failure back to the ticket's team by
//! itself once turned on (`github.auto`), and the two buttons on the card do it by hand.
//!
//! The poll loop is `start` / `stop`: a task that wakes every 60 seconds (`LOOP_EVERY_S`) and ends when `stop` is
//! awaited. `gh` is only ever started with the arguments of the Python code; a test puts a script named `gh` on the
//! `PATH` (nothing here reaches GitHub by itself).

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{ai_watched_pr, ai_worktree};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::proc::{self, Spec};

/// The AI's replies on a thread go out from the person's own gh account: this marker at their end is how the poller
/// knows the board's run wrote them, so they never come back as a person's new comments.
pub const AI_MARK: &str = "<!-- kanban-board-ai -->";

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// The database call failed.
    Db(DbErr),
    /// Any other exception Python lets through (what `runs.deliver_to_ticket` raised, a value of the wrong kind).
    Other(String),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Db(err) => write!(f, "{err}"),
            Error::Other(text) => f.write_str(text),
        }
    }
}

impl std::error::Error for Error {}

fn now() -> String {
    time::now_iso()
}

/// Text from outside the board (a reviewer's comment, a CI log) as data the AI reads, never as instructions.
pub fn fence(source: &str, text: &str) -> String {
    let safe = text.replace("</untrusted>", "<\\/untrusted>").replace("</instruction>", "<\\/instruction>");
    let label = source.replace('"', "'").replace('\n', " ");
    format!("<untrusted source=\"{label}\">\n{safe}\n</untrusted>")
}

/// Run `gh` with `args` in `cwd`: `(return code, stdout when it worked, else stderr or stdout)`. A `gh` that cannot be
/// started or is too slow is `(1, the text of the exception)`.
pub async fn gh(args: &[&str], cwd: &str, timeout: f64) -> (i32, String) {
    let mut argv = vec!["gh".to_string()];
    argv.extend(args.iter().map(|a| (*a).to_string()));
    let spec = Spec { cwd: Some(cwd), ..Spec::default() };
    match proc::run(&argv, &spec, timeout).await {
        Err(err) => (1, err.to_string()),
        Ok(out) => {
            let text = if out.returncode == 0 {
                out.stdout
            } else if !out.stderr.is_empty() {
                out.stderr
            } else {
                out.stdout
            };
            (out.returncode, text)
        }
    }
}

/// Start watching every pull request the board opened that is not watched yet.
pub async fn watch_new(session: &Session) -> Result<usize, Error> {
    let mut added = 0;
    let trees = ai_worktree::Entity::find().filter(ai_worktree::Column::PrNumber.is_not_null()).all(session).await?;
    for wt in trees {
        if ai_watched_pr::Entity::find_by_id(wt.ticket_id.as_str()).one(session).await?.is_none() {
            let mut row = ai_watched_pr::new();
            row.ticket_id = kb_db::sea_orm::ActiveValue::Set(wt.ticket_id.clone());
            row.project_id = kb_db::sea_orm::ActiveValue::Set(wt.project_id.clone());
            row.number = kb_db::sea_orm::ActiveValue::Set(wt.pr_number.unwrap_or(0));
            row.url = kb_db::sea_orm::ActiveValue::Set(wt.pr_url.clone());
            row.branch = kb_db::sea_orm::ActiveValue::Set(wt.branch.clone());
            row.repo = kb_db::sea_orm::ActiveValue::Set(wt.repo.clone());
            row.insert(session).await?;
            added += 1;
        }
    }
    if added > 0 {
        session.commit().await?;
    }
    Ok(added)
}

/// `(c.get(key) or "")` as text; a value that is not text counts as empty (Python would fail on it).
fn text_of<'a>(c: &'a Value, key: &str) -> &'a str {
    c.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The overall state of a pull request's checks and the failing ones.
pub fn rollup(checks: &[Value]) -> (String, Vec<Value>) {
    let failing: Vec<Value> = checks
        .iter()
        .filter(|c| {
            matches!(
                text_of(c, "conclusion").to_uppercase().as_str(),
                "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
            )
        })
        .cloned()
        .collect();
    let pending = checks
        .iter()
        .any(|c| matches!(text_of(c, "status").to_uppercase().as_str(), "IN_PROGRESS" | "QUEUED" | "PENDING"));
    if !failing.is_empty() {
        return ("red".to_string(), failing);
    }
    if pending {
        return ("pending".to_string(), Vec::new());
    }
    (if checks.is_empty() { "none" } else { "green" }.to_string(), Vec::new())
}

/// What `poll` read: the pull request's state, or why it could not be read.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Polled {
    /// `{"error": text}`.
    Error(String),
    /// The pull request as `gh pr view` shows it.
    Read {
        /// `open`, `closed` or `merged`, lower case (empty when gh gave none).
        state: String,
        /// `green`, `red`, `pending` or `none`.
        ci: String,
        /// The failing checks.
        failing: Vec<Value>,
        /// The new comments of people: `{id, author, body, path, line}`.
        comments: Vec<Value>,
        /// `baseRefName`.
        base: Value,
        /// `headRefName`.
        head: Value,
    },
}

impl Polled {
    /// The dict `poll` returns.
    pub fn to_value(&self) -> Value {
        match self {
            Polled::Error(text) => json!({"error": text}),
            Polled::Read { state, ci, failing, comments, base, head } => {
                json!({"state": state, "ci": ci, "failing": failing, "comments": comments, "base": base, "head": head})
            }
        }
    }
}

/// `poll` after gh answered: the JSON `data` of `gh pr view` shaped, with the ids of the comments already seen left
/// out. Python fails on a `data` that is not an object; this gives the error text of that failure.
pub fn shape_poll(data: &Value, seen: &HashSet<String>) -> Result<Polled, Error> {
    let Some(object) = data.as_object() else {
        return Err(Error::Other("'list' object has no attribute 'get'".to_string()));
    };
    let list = |key: &str| -> Vec<Value> {
        match object.get(key) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        }
    };
    let (ci, failing) = rollup(&list("statusCheckRollup"));
    let mut new_comments: Vec<Value> = Vec::new();
    let reviews: Vec<Value> =
        list("reviews").into_iter().filter(|r| !pytext::strip(text_of(r, "body")).is_empty()).collect();
    for c in list("comments").iter().chain(reviews.iter()) {
        let pick = ["id", "url", "createdAt"].iter().find_map(|k| c.get(*k).filter(|v| pyjson::truthy(v)));
        let cid = match pick {
            Some(v) => pyjson::py_str(v),
            None => pyjson::py_str(c.get("createdAt").unwrap_or(&Value::Null)),
        };
        let author = c
            .get("author")
            .filter(|a| pyjson::truthy(a))
            .and_then(|a| a.get("login"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let body = text_of(c, "body");
        if seen.contains(&cid) || author.ends_with("[bot]") || body.contains(AI_MARK) {
            // seen, a bot, or the board's own run replying on the thread
            continue;
        }
        new_comments.push(json!({
            "id": cid,
            "author": author,
            "body": body.chars().take(4000).collect::<String>(),
            "path": c.get("path").cloned().unwrap_or(Value::Null),
            "line": c.get("line").cloned().unwrap_or(Value::Null),
        }));
    }
    Ok(Polled::Read {
        state: text_of(data, "state").to_lowercase(),
        ci,
        failing,
        comments: new_comments,
        base: object.get("baseRefName").cloned().unwrap_or(Value::Null),
        head: object.get("headRefName").cloned().unwrap_or(Value::Null),
    })
}

/// The ids a row's `seen_comments` holds.
fn seen_ids(row: &ai_watched_pr::Model) -> HashSet<String> {
    match kb_ai::store::loads(Some(&row.seen_comments), json!([])) {
        Value::Array(items) => items.into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => HashSet::new(),
    }
}

/// Read the pull request once: its state, its checks, new review comments from people.
pub async fn poll(row: &ai_watched_pr::Model) -> Result<Polled, Error> {
    let number = row.number.to_string();
    let (code, out) = gh(
        &["pr", "view", &number, "--json", "state,statusCheckRollup,reviews,comments,headRefName,baseRefName,url"],
        &row.repo,
        60.0,
    )
    .await;
    if code != 0 {
        return Ok(Polled::Error(pytext::strip(&out).chars().take(200).collect()));
    }
    let Ok(data) = serde_json::from_str::<Value>(&out) else {
        return Ok(Polled::Error("gh answered something that is not JSON".to_string()));
    };
    shape_poll(&data, &seen_ids(row))
}

/// The failing step's log of a check (`gh run view --log-failed`), cut to what fits in a prompt.
pub async fn failure_log(row: &ai_watched_pr::Model, check: &Value) -> String {
    let url = text_of(check, "detailsUrl");
    let name = pyjson::py_str(check.get("name").unwrap_or(&Value::Null));
    let run_id = url.split('/').find(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && p.len() > 6);
    let Some(run_id) = run_id else {
        return format!("{name} failed (no log link).");
    };
    let (code, out) = gh(&["run", "view", run_id, "--log-failed"], &row.repo, 120.0).await;
    let text = if code == 0 { out } else { format!("{name} failed; the log could not be read: {out}") };
    let chars: Vec<char> = text.chars().collect();
    chars[chars.len().saturating_sub(12000)..].iter().collect()
}

/// Whether the same workflow is red on the base branch too (then the ticket is not to blame), or None when it
/// cannot tell (gh failed, or the check is not a GitHub Actions workflow that ran on the base): nobody is blamed on a
/// guess.
///
/// A pull request's check is a job ("name") of a workflow ("workflowName"); `gh run list` lists workflow runs, so
/// the workflow names are compared.
pub async fn base_is_red(row: &ai_watched_pr::Model, base: Option<&str>, check: &Value) -> Option<bool> {
    let workflow = check.get("workflowName").filter(|w| pyjson::truthy(w));
    let (Some(base), Some(workflow)) = (base.filter(|b| !b.is_empty()), workflow) else {
        return None;
    };
    let (code, out) = gh(
        &["run", "list", "--branch", base, "--limit", "20", "--json", "conclusion,status,workflowName"],
        &row.repo,
        60.0,
    )
    .await;
    if code != 0 {
        return None;
    }
    let runs = serde_json::from_str::<Value>(&out).ok()?;
    base_state(&runs, workflow)
}

/// The part of `base_is_red` after gh answered: the newest finished run of `workflow` in the list says it.
pub fn base_state(runs: &Value, workflow: &Value) -> Option<bool> {
    for r in runs.as_array()? {
        if r.get("workflowName") != Some(workflow) || !r.get("conclusion").is_some_and(pyjson::truthy) {
            // another workflow, or one still running
            continue;
        }
        let conclusion = text_of(r, "conclusion").to_lowercase();
        return Some(matches!(conclusion.as_str(), "failure" | "timed_out" | "cancelled" | "action_required"));
    }
    None
}

/// `json.loads(text) or default` on a column.
fn loads_or(text: Option<&str>, default: Value) -> Value {
    let value = kb_ai::store::loads(text, default.clone());
    if pyjson::truthy(&value) { value } else { default }
}

/// Poll the project's open pull requests that are due; returns what changed.
pub async fn tick_project(project_id: &str) -> Result<Vec<Value>, Error> {
    let mut changes: Vec<Value> = Vec::new();
    let (every, rows) = {
        let session = kb_db::session();
        let settings = kb_ai::store::get_settings(&session, project_id).await?;
        let all = kb_ai::ops::get(Some(&settings));
        let cfg =
            all.get("github").filter(|g| pyjson::truthy(g)).and_then(Value::as_object).cloned().unwrap_or_default();
        if !cfg.get("on").is_some_and(pyjson::truthy) {
            return Ok(Vec::new());
        }
        watch_new(&session).await?;
        let minutes = match cfg.get("poll_min").filter(|v| pyjson::truthy(v)) {
            Some(v) => kb_ai::store::py_int(v)
                .ok_or_else(|| Error::Other(format!("invalid literal for int(): {}", pyjson::py_repr(v))))?,
            None => 5,
        };
        let every = chrono::Duration::minutes(minutes.max(1) as i64);
        let rows = ai_watched_pr::Entity::find()
            .filter(ai_watched_pr::Column::ProjectId.eq(project_id))
            .filter(ai_watched_pr::Column::State.ne("closed"))
            .all(&session)
            .await?;
        (every, rows)
    };
    for row in rows {
        if let Some(checked) = row.checked_at.as_deref().filter(|c| !c.is_empty()) {
            let last = kb_ai::store::parse_iso(Some(checked)).ok_or_else(|| {
                Error::Other(format!("Invalid isoformat string: {}", pyjson::py_repr(&json!(checked))))
            })?;
            if chrono::Utc::now() - last.with_timezone(&chrono::Utc) < every {
                continue;
            }
        }
        let got = poll(&row).await?;
        let session = kb_db::session();
        let Some(mut cur) = ai_watched_pr::Entity::find_by_id(row.ticket_id.as_str()).one(&session).await? else {
            continue;
        };
        cur.checked_at = Some(now());
        let (state, ci, failing, comments, base) = match got {
            Polled::Error(text) => {
                cur.last_error = Some(text);
                save_pr(&session, cur).await?;
                continue;
            }
            Polled::Read { state, ci, failing, comments, base, .. } => (state, ci, failing, comments, base),
        };
        cur.last_error = None;
        if state == "merged" || state == "closed" {
            cur.state = "closed".to_string();
        }
        let previous = cur.ci.clone();
        cur.ci = Some(ci.clone());
        if ci == "red" && previous.as_deref() != Some("red") {
            let fail = failing.first().cloned().unwrap_or(Value::Null);
            let base_text = base.as_str();
            let on_base = base_is_red(&cur, base_text, &fail).await;
            // only when the base is known to be green
            let blamed = on_base == Some(false);
            let get = |k: &str| fail.get(k).cloned().unwrap_or(Value::Null);
            cur.red = Some(pyjson::dumps(&json!({
                "check": get("name"),
                "workflow": get("workflowName"),
                "url": get("detailsUrl"),
                "at": now(),
                "blamed": blamed,
                "base_unknown": on_base.is_none(),
                "base": base,
            })));
            changes.push(json!({"kind": "ci_red", "ticket_id": cur.ticket_id, "check": get("name"), "blamed": blamed}));
        }
        if !comments.is_empty() {
            // the ones already given to the team are dropped when new ones come: the card shows the latest batch
            let mut pending: Vec<Value> = match loads_or(Some(&cur.pending_comments), json!([])) {
                Value::Array(items) => {
                    items.into_iter().filter(|c| !c.get("handled_at").is_some_and(pyjson::truthy)).collect()
                }
                _ => Vec::new(),
            };
            pending.extend(comments.iter().cloned());
            let keep_from = pending.len().saturating_sub(50);
            cur.pending_comments = pyjson::dumps(&Value::Array(pending[keep_from..].to_vec()));
            // Python keeps these in a set, whose order is arbitrary; here they keep the order they came in
            let mut seen: Vec<String> = Vec::new();
            let old = match loads_or(Some(&cur.seen_comments), json!([])) {
                Value::Array(items) => items,
                _ => Vec::new(),
            };
            for id in old
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .chain(comments.iter().filter_map(|c| c.get("id").and_then(Value::as_str)).map(str::to_string))
            {
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
            let from = seen.len().saturating_sub(500);
            cur.seen_comments = pyjson::dumps(&json!(seen[from..].to_vec()));
            changes.push(json!({"kind": "review_comments", "ticket_id": cur.ticket_id, "count": comments.len()}));
        }
        save_pr(&session, cur).await?;
    }
    Ok(changes)
}

/// `session.add(row)` and `await session.commit()`.
async fn save_pr(session: &Session, row: ai_watched_pr::Model) -> Result<ai_watched_pr::Model, DbErr> {
    let stored = kb_ai::store::save::<_, ai_watched_pr::Model, ai_watched_pr::ActiveModel>(session, row).await?;
    session.commit().await?;
    Ok(stored)
}

/// Red CI on a pull request the board opened, as a signal the board acts on (and a card).
pub async fn signals(session: &Session, project_id: &str) -> Result<Vec<Value>, Error> {
    let mut out = Vec::new();
    let rows = ai_watched_pr::Entity::find()
        .filter(ai_watched_pr::Column::ProjectId.eq(project_id))
        .filter(ai_watched_pr::Column::Ci.eq("red"))
        .all(session)
        .await?;
    for row in rows {
        let red = loads_or(row.red.as_deref(), json!({}));
        let get = |k: &str| red.get(k).cloned().unwrap_or(Value::Null);
        if !pyjson::truthy(&get("blamed")) || pyjson::truthy(&get("handled_at")) {
            continue;
        }
        let at: String = red.get("at").and_then(Value::as_str).unwrap_or("").chars().take(16).collect();
        let base = match get("base") {
            v if pyjson::truthy(&v) => pyjson::py_str(&v),
            _ => "the base branch".to_string(),
        };
        out.push(json!({
            "kind": "ci_red",
            "key": format!("ci_red:{}:{at}", row.ticket_id),
            "ticket_id": row.ticket_id,
            "title": format!("CI failed on {}'s pull request #{}: {}", row.ticket_id, row.number, pyjson::py_str(&get("check"))),
            "detail": format!("The same check is green on {base}, so it is this change."),
            "data": {"check": get("check"), "url": get("url"), "number": row.number},
            "score": 8,
            "action": "The board gives it to the team",
        }));
    }
    Ok(out)
}

/// A watched pull request for the API.
pub fn to_dict(row: &ai_watched_pr::Model) -> Value {
    json!({
        "ticket_id": row.ticket_id,
        "number": row.number,
        "url": row.url,
        "branch": row.branch,
        "state": row.state,
        "ci": row.ci,
        "red": kb_ai::store::loads(row.red.as_deref(), Value::Null),
        "pending_comments": kb_ai::store::loads(Some(&row.pending_comments), json!([])),
        "checked_at": row.checked_at,
        "last_error": row.last_error,
    })
}

/// The poller wakes this often (seconds).
pub const LOOP_EVERY_S: u64 = 60;

static LOOP: LazyLock<Mutex<Option<JoinHandle<()>>>> = LazyLock::new(|| Mutex::new(None));

/// One round of the poll loop: every project that has a pull request is polled and acted on.
pub async fn round() -> Result<(), Error> {
    let projects: Vec<String> = {
        let session = kb_db::session();
        let rows =
            ai_worktree::Entity::find().filter(ai_worktree::Column::PrNumber.is_not_null()).all(&session).await?;
        let mut seen: Vec<String> = Vec::new();
        for r in rows {
            if !seen.contains(&r.project_id) {
                seen.push(r.project_id);
            }
        }
        seen
    };
    for pid in projects {
        let changes = tick_project(&pid).await?;
        act(&pid, &changes).await?;
    }
    Ok(())
}

async fn poll_loop(every: Duration) {
    loop {
        if let Err(err) = round().await {
            tracing::error!("GitHub poll failed: {err}");
        }
        tokio::time::sleep(every).await;
    }
}

/// Start the GitHub poller (once). Without a running tokio runtime nothing starts.
pub fn start() {
    start_every(Duration::from_secs(LOOP_EVERY_S));
}

/// `start` with another wake-up interval (the tests use a short one).
pub fn start_every(every: Duration) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let mut slot = LOOP.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().is_none_or(JoinHandle::is_finished) {
        *slot = Some(kb_base::ctx::spawn(poll_loop(every)));
    }
}

/// Stop the poller and wait until it is gone.
pub async fn stop() {
    let task = LOOP.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

mod tasks;

pub use tasks::{AUTO_PER_DAY, act, back_to_dev, ci_task, comments_to_dev, review_task};
