//! Scanning a project's repository to propose how the AI team should work in it (`services/ai/repo_scan.py`).
//! Built on the other AI crates.
//!
//! The Python file is one module of 1690 lines; here it is split along its sections, each file naming the lines it
//! ports, and every public function is re-exported from the crate root under its Python name:
//!
//! | file | Python lines | what |
//! |---|---|---|
//! | `pyfs` | 62-74, and the `pathlib` / `os.walk` order | `_read`, `_json`, `rglob`, `os.walk`, `str(Path)` |
//! | `detect` | 37-296 | `_ci_commands`, `fingerprint`, `_committed`, `scan` |
//! | `suggest` | 299-438 | `_dir`, `_npm`, `_py`, `_pkg_cmd`, `_wanted`, `suggest` |
//! | `trial` | 441-655 | `classify`, `_Scratch`, `_run_one`, `try_commands`, `_try` |
//! | `run` | 658-712 | `run_scan` |
//! | `refine` | 715-831 | `refine_suggestion` and its light-model helpers |
//! | `job` | 834-1220, 1221-1466 | the AI sets up the commands: `_Job`, `ai_status`, `start_job`, `cancel_job`, `_run_job`, `_job_body` |
//! | `rows` | 1468-1567 | `latest`, `to_api`, `rescan_if_changed`, `sweep`, `to_dict` |
//! | `apply` | 1570-1690 | `apply` |
//! | `seams` | | the calls tests replace (`_ask_light`, `_ask_ai`, `ai_status`) |
//! | `cancel` | | what `task.cancel()` and `asyncio.wait_for` do to a job |
//!
//! The app calls `sweep` every 30 minutes (`_rescan_loop` in `server/main.py`):
//! `kb_ai_scan::sweep(kb_db::database::session).await`.
//!
//! Python values that are plain dicts and lists stay `serde_json::Value`s here (the scan's result is shown to people,
//! stored as JSON and fed to the AI: its key order is part of it).

pub mod apply;
pub mod cancel;
pub mod detect;
pub mod job;
pub mod pyfs;
pub mod refine;
pub mod rows;
pub mod run;
pub mod seams;
pub mod suggest;
pub mod trial;

pub use apply::apply;
pub use detect::{FP_NAMES, TRIAL_TIMEOUT_S, fingerprint, scan};
pub use job::{
    COMMANDS, JOB_LIMIT_S, LOG_KEEP, ai_status, cancel_job, code_proposal, describe_tool, parse_proposal, running,
    start_job,
};
pub use refine::{REFINE_PROMPT, parse_refined, refine_suggestion};
pub use rows::{latest, rescan_if_changed, sweep, to_api, to_dict};
pub use run::run_scan;
pub use suggest::suggest;
pub use trial::{CHECKS, classify, try_, try_commands, why_wrong};

use kb_db::sea_orm::DbErr;

/// What a function of this crate fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `ValueError`: no such folder, a folder the AI members could not work in, a CLI that is not there: the message
    /// is shown as it is.
    #[error("{0}")]
    Value(String),
    /// `LookupError`: "Scan not found."
    #[error("{0}")]
    Lookup(String),
    /// `JobRunning`: a job already runs for this scan.
    #[error("{0}")]
    JobRunning(String),
    /// Any other exception Python lets through (`OSError`, `TypeError`, `RuntimeError`...): its text.
    #[error("{0}")]
    Other(String),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// The job was told to stop (`asyncio.CancelledError` inside the job's task): only ever seen inside a job.
    #[error("cancelled")]
    Cancelled,
}
