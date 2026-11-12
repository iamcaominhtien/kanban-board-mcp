//! What a run leaves in its worktree that a person should see, not the code: screenshots, logs, reports, exports
//! (`worktrees.py`, from `_OUTPUT_DIRS` to `commit_now`, and `_commit_leftovers`). Committed by a hand-over they would
//! land in the product's branch; left loose they keep the worktree from being cleaned. They go to the ticket's
//! Workspace instead (issue #269). Only untracked files count: a changed tracked file is always code.

use std::path::{Path, PathBuf};

use kb_base::pytext;
use kb_db::entities::{ai_run, ai_worktree};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

use super::{Error, after_status, fail, git, git_try, porcelain};

const OUTPUT_DIRS: [&str; 18] = [
    "qa",
    "evidence",
    "screenshots",
    "screenshot",
    "shots",
    "test-results",
    "playwright-report",
    "reports",
    "report",
    "output",
    "outputs",
    "out-qa",
    "artifacts",
    "artefacts",
    ".look",
    "tmp",
    "temp",
    "scratch",
];
const OUTPUT_SUFFIXES: [&str; 7] = [".log", ".har", ".trace", ".webm", ".mov", ".mp4", ".gif"];
// documents and pictures at the top of the worktree are a run's outputs too (code keeps its pictures in a folder)
const TOP_LEVEL_OUTPUTS: [&str; 12] =
    [".png", ".jpg", ".jpeg", ".webp", ".pdf", ".xlsx", ".xls", ".docx", ".pptx", ".csv", ".zip", ".html"];

/// `Path(rel).parts`: the pieces of a relative path, `.` and empty pieces dropped as `pathlib` does.
fn parts(rel: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let absolute = rel.starts_with('/');
    if absolute {
        out.push("/");
    }
    out.extend(rel.split('/').filter(|p| !p.is_empty() && *p != "."));
    out
}

/// `Path(name).suffix`.
fn suffix(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => &name[i..],
        _ => "",
    }
}

/// Whether an untracked file is a run's output (a screenshot, a log, a report) rather than code.
pub fn is_output(rel: &str) -> bool {
    let all = parts(rel);
    let folders: Vec<String> = all.iter().take(all.len().saturating_sub(1)).map(|p| p.to_lowercase()).collect();
    if folders.iter().any(|f| {
        OUTPUT_DIRS.contains(&f.as_str())
            || f.ends_with("_work")
            || f.ends_with("-work")
            || f.ends_with("_output")
            || f.ends_with("-output")
            || f.ends_with("evidence")
    }) {
        return true;
    }
    let suffix = all.last().map(|n| suffix(n).to_lowercase()).unwrap_or_default();
    OUTPUT_SUFFIXES.contains(&suffix.as_str()) || (folders.is_empty() && TOP_LEVEL_OUTPUTS.contains(&suffix.as_str()))
}

/// The untracked outputs among `git status --porcelain` lines.
pub fn outputs_in(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter(|line| line.starts_with("??"))
        .map(|line| after_status(line))
        .filter(|rel| is_output(rel))
        .collect()
}

/// What `move_outputs` returns, in the four shapes the Python dict has.
#[derive(Debug, Clone, PartialEq)]
pub enum MoveOutcome {
    /// `{moved: [], left: [], reason: "This ticket has no worktree."}`.
    NoWorktree,
    /// `{moved: [], left: []}`: nothing to move.
    Nothing,
    /// `{moved: [], left, reason}`: the Workspace is off, so they stay.
    WorkspaceOff {
        /// The outputs that stay in the worktree.
        left: Vec<String>,
    },
    /// `{moved, to}`.
    Moved {
        /// The files moved, as paths below the worktree.
        moved: Vec<String>,
        /// The folder of the Workspace they went to.
        to: String,
    },
}

impl MoveOutcome {
    /// `result.get("moved") or []`.
    pub fn moved(&self) -> &[String] {
        match self {
            MoveOutcome::Moved { moved, .. } => moved,
            _ => &[],
        }
    }

    /// `result.get("left") or []`.
    pub fn left(&self) -> &[String] {
        match self {
            MoveOutcome::WorkspaceOff { left } => left,
            _ => &[],
        }
    }

    /// `result.get("reason")`.
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            MoveOutcome::NoWorktree => Some("This ticket has no worktree."),
            MoveOutcome::WorkspaceOff { .. } => {
                Some("Workspace is off (Settings › Workspace), so they stay in the worktree.")
            }
            _ => None,
        }
    }

    /// The dict, with its keys in the Python order.
    pub fn to_value(&self) -> Value {
        match self {
            MoveOutcome::NoWorktree => json!({"moved": [], "left": [], "reason": self.reason()}),
            MoveOutcome::Nothing => json!({"moved": [], "left": []}),
            MoveOutcome::WorkspaceOff { left } => json!({"moved": [], "left": left, "reason": self.reason()}),
            MoveOutcome::Moved { moved, to } => json!({"moved": moved, "to": to}),
        }
    }
}

fn move_file(src: &Path, target: &Path) -> std::io::Result<()> {
    // `shutil.move`: a rename, or a copy and a delete across file systems
    if std::fs::rename(src, target).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, target)?;
    std::fs::remove_file(src)
}

/// Move the outputs a run left in the ticket's worktree (untracked screenshots, logs, reports) to the ticket's
/// Workspace, under `from-worktree/<date-time>/` with their paths kept, so they are where a person looks and never
/// end up committed. `Moved`, or `left` with a reason when they cannot be moved (Workspace off, no worktree).
pub async fn move_outputs(ticket_id: &str) -> Result<MoveOutcome, Error> {
    let (row, root) = {
        let session = kb_db::session();
        let row = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await?;
        let Some(row) = row.filter(|r| r.state != "removed" && Path::new(&r.path).is_dir()) else {
            return Ok(MoveOutcome::NoWorktree);
        };
        let found = outputs_in(&porcelain(&row.path).await?);
        if found.is_empty() {
            return Ok(MoveOutcome::Nothing);
        }
        let ws = kb_board::workspace::get_workspace_settings(&session).await.map_err(|e| Error::Other(e.to_string()))?;
        if !ws.enabled {
            return Ok(MoveOutcome::WorkspaceOff { left: found });
        }
        let root = kb_board::workspace::init_ticket_workspace(&session, ticket_id)
            .await
            .map_err(|e| Error::Other(e.to_string()))?;
        (row, (root, found))
    };
    let (root, found) = root;
    let dest: PathBuf = root.join("from-worktree").join(chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string());
    let base = std::fs::canonicalize(&row.path).unwrap_or_else(|_| PathBuf::from(&row.path));
    let dest_move = dest.clone();
    let moved = tokio::task::spawn_blocking(move || {
        let mut moved = Vec::new();
        for rel in found {
            let src = std::fs::canonicalize(base.join(&rel)).unwrap_or_else(|_| base.join(&rel));
            if !src.is_file() || !src.starts_with(&base) || src == base {
                continue;
            }
            let target = dest_move.join(&rel);
            if let Some(parent) = target.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            if move_file(&src, &target).is_err() {
                continue;
            }
            moved.push(rel);
            let mut parent = src.parent().map(Path::to_path_buf);
            while let Some(p) = parent {
                let empty = p.is_dir() && std::fs::read_dir(&p).is_ok_and(|mut d| d.next().is_none());
                if p == base || !empty || std::fs::remove_dir(&p).is_err() {
                    break;
                }
                parent = p.parent().map(Path::to_path_buf);
            }
        }
        moved
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))?;
    Ok(MoveOutcome::Moved { moved, to: dest.to_string_lossy().into_owned() })
}

/// The work-log note that tells the team (and the PM) where a run's outputs are now.
pub fn note_for(result: &MoveOutcome, worktree: &str) -> Option<String> {
    let to = match result {
        MoveOutcome::Moved { to, .. } => Some(to.as_str()),
        _ => None,
    };
    note_text(result.moved(), result.left(), to, result.reason(), worktree)
}

/// `_note_for` on the parts of the result dict: `moved`, `left`, `to` and `reason` (any of them may be missing).
pub fn note_text(moved: &[String], left: &[String], to: Option<&str>, reason: Option<&str>, worktree: &str) -> Option<String> {
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    if !moved.is_empty() {
        let names: Vec<String> = moved.iter().take(20).map(|m| format!("- `{m}`")).collect();
        let more = if moved.len() > 20 { format!("\n- … and {} more", moved.len() - 20) } else { String::new() };
        return Some(format!(
            "Moved {} output file{} the run left in the worktree to the ticket's Workspace, `{}`:\n{}{more}\n\n\
             They are not committed; the worktree holds only code.",
            moved.len(),
            plural(moved.len()),
            to.unwrap_or(""),
            names.join("\n"),
        ));
    }
    if !left.is_empty() {
        let names: Vec<String> = left.iter().take(20).map(|m| format!("- `{m}`")).collect();
        let reason = reason.filter(|r| !r.is_empty()).unwrap_or("not moved");
        return Some(format!(
            "{} output file{} the run left are still in the worktree `{worktree}` ({reason}):\n{}\n\nThey keep the \
             worktree from being cleaned: move them, commit them or delete them (the ticket's AI › Code panel).",
            left.len(),
            plural(left.len()),
            names.join("\n"),
        ));
    }
    None
}

/// `_RUN_ENDED`: the states of a run that is over.
pub const RUN_ENDED: [&str; 4] = ["finished", "failed", "cancelled", "timed_out"];

/// A run of the ticket ended: its outputs go from the worktree to the Workspace, and the work log says where.
pub async fn tidy_after_run(ticket_id: &str, run_id: &str) -> Result<Option<MoveOutcome>, Error> {
    let (run, row) = {
        let session = kb_db::session();
        let run = ai_run::Entity::find_by_id(run_id).one(&session).await?;
        let row = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await?;
        (run, row)
    };
    let (Some(run), Some(_row)) = (run, row) else {
        return Ok(None);
    };
    if !RUN_ENDED.contains(&run.state.as_str()) {
        // a run waiting for an answer comes back to its files
        return Ok(None);
    }
    if super::handover::run_is_working(ticket_id).await? {
        // another run works there now; it tidies when it ends
        return Ok(None);
    }
    let result = move_outputs(ticket_id).await?;
    log_tidy(ticket_id, &result, None).await?;
    Ok(Some(result))
}

/// Say in the ticket's work log where the outputs went (or why they stayed).
pub async fn log_tidy(ticket_id: &str, result: &MoveOutcome, by: Option<&str>) -> Result<(), Error> {
    let session = kb_db::session();
    let row = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await?;
    let note = note_for(result, row.as_ref().map_or("", |r| r.path.as_str()));
    if let Some(note) = note {
        let author = by.filter(|b| !b.is_empty()).unwrap_or("Kanban Board");
        kb_board::tickets::add_work_log(&session, ticket_id, kb_board::tickets::NewWorkLog::new(author, "Other", &note))
            .await
            .map_err(|e| Error::Other(e.to_string()))?;
    }
    Ok(())
}

/// A person commits what is left in the worktree on its branch: the code, never the outputs (they go to the
/// Workspace first, or stay out of the commit when it is off). `{committed, moved, left}` or `{committed, left}`.
pub async fn commit_now(ticket_id: &str, by: &str) -> Result<Value, Error> {
    let row = {
        let session = kb_db::session();
        ai_worktree::Entity::find_by_id(ticket_id).one(&session).await?
    };
    let Some(row) = row.filter(|r| r.state != "removed" && Path::new(&r.path).is_dir()) else {
        return fail("This ticket has no worktree.");
    };
    let before = porcelain(&row.path).await?;
    if before.is_empty() {
        return Ok(json!({"committed": false, "moved": [], "left": []}));
    }
    let committed =
        commit_leftovers(&row, &format!("{ticket_id}: changes left in the worktree, committed by {by}")).await?;
    let left = outputs_in(&porcelain(&row.path).await?);
    Ok(json!({"committed": committed, "left": left}))
}

/// Commit what the AI left uncommitted on its branch (a hand-over never drops work). True when it committed. Its
/// outputs (screenshots, logs, reports) go to the Workspace first: they are not code.
pub(crate) async fn commit_leftovers(row: &ai_worktree::Model, message: &str) -> Result<bool, Error> {
    let result = move_outputs(&row.ticket_id).await?;
    log_tidy(&row.ticket_id, &result, None).await?;
    if !result.left().is_empty() {
        // the Workspace is off: an output is still not code, so it is left out of the commit
        git(&row.path, &["add", "-A"]).await?;
        let mut reset = vec!["reset", "-q", "--"];
        reset.extend(result.left().iter().map(String::as_str));
        git_try(&row.path, &reset).await?;
        let st = git_try(&row.path, &["diff", "--cached", "--quiet"]).await?;
        if st.returncode == 0 {
            return Ok(false);
        }
        git_try(&row.path, &["commit", "-m", message, "--no-verify"]).await?;
        return Ok(true);
    }
    let st = git_try(&row.path, &["status", "--porcelain"]).await?;
    if pytext::strip(&st.stdout).is_empty() {
        return Ok(false);
    }
    git(&row.path, &["add", "-A"]).await?;
    git_try(&row.path, &["commit", "-m", message, "--no-verify"]).await?;
    Ok(true)
}
