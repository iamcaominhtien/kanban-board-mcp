//! Places where the modules of this crate meet AI-team modules that a later task ports. A slot that is not filled
//! behaves as the Python call would on a board with no run going.
//!
//! | seam | stands for | filled by |
//! |---|---|---|
//! | `RunProcs::proc_alive`, `kill_proc`, `has_task` | `runs.RT.procs.get(run_id)`, `proc.proc.returncode`, `proc.kill()`, `run_id in runs.RT.tasks` (asked by `kb_ai::power` through `kb_ai::seams::RunsRuntime`) | `runs` |
//!
//! `kb_ai::seams::RunsRuntime` is one trait with four calls: `looks_like_cli` belongs to `cli` (ported here), the
//! other three to `runs` (not yet). `register()` of this crate fills the whole trait with `Runtime`, which answers
//! `looks_like_cli` itself and hands the three others to the `RunProcs` slot below; `runs` then only calls
//! `set_run_procs`.
//!
//! Not seams, but set by `runs` when it is ported: `resources::MON.set_on_breach` and `set_on_child_breach` (Python
//! assigns `resources.MON.on_breach` and `on_child_breach`).

use std::sync::{Arc, RwLock};

use kb_ai::seams::RunsRuntime;

/// What `kb_ai::power` asks of the runs' runtime (`services/ai/runs.py`'s `RT`).
pub trait RunProcs: Send + Sync {
    /// `runs.RT.procs.get(run_id)`: `None` when the board holds no process object for the run, else whether the CLI
    /// behind it still runs (`proc.proc is not None and proc.proc.returncode is None`).
    fn proc_alive(&self, run_id: &str) -> Option<bool>;
    /// `runs.RT.procs[run_id].kill()`.
    fn kill_proc(&self, run_id: &str);
    /// `run_id in runs.RT.tasks`: the run's own task is starting or finishing it right now.
    fn has_task(&self, run_id: &str) -> bool;
}

static RUN_PROCS: RwLock<Option<Arc<dyn RunProcs>>> = RwLock::new(None);

/// Fill the runs' part of the runtime (a later call replaces the earlier one, which tests use).
pub fn set_run_procs(procs: Option<Arc<dyn RunProcs>>) {
    *RUN_PROCS.write().unwrap_or_else(|e| e.into_inner()) = procs;
}

/// The runs' part of the runtime, when `runs` has been ported and registered.
pub fn run_procs() -> Option<Arc<dyn RunProcs>> {
    RUN_PROCS.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The `kb_ai::seams::RunsRuntime` this crate registers: `cli` answers for itself, `runs` through `RunProcs`.
pub struct Runtime;

impl RunsRuntime for Runtime {
    fn proc_alive(&self, run_id: &str) -> Option<bool> {
        run_procs().and_then(|procs| procs.proc_alive(run_id))
    }

    fn kill_proc(&self, run_id: &str) {
        if let Some(procs) = run_procs() {
            procs.kill_proc(run_id);
        }
    }

    fn has_task(&self, run_id: &str) -> bool {
        run_procs().is_some_and(|procs| procs.has_task(run_id))
    }

    fn looks_like_cli(&self, pid: i64) -> bool {
        crate::cli::looks_like_cli(pid, None)
    }
}
