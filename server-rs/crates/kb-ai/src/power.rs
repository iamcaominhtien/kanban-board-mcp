//! The computer's sleep (plan: "Máy ngủ"). The desktop app keeps the machine awake while an AI runs and, when the
//! machine wakes, asks the board to look at every run it thinks is running: a CLI that did not survive the sleep is ended
//! the way the board ends one whose process died (the reader sees the end and the retry and watchdog paths take over).

use kb_db::database;
use kb_db::entities::ai_run;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter};
use kb_db::Session;
use serde_json::{Map, Value, json};

use crate::seams::{self, BOARD_CLOSED};
use crate::store::now_iso;
use crate::{runner_link, steps, transcripts};

/// A run waiting for a person (needs_input) or queued behind a pause or a cap does not need the machine; one queued
/// for a free slot starts as soon as a running one ends, which keeps it awake meanwhile.
pub const LIVE: [&str; 2] = ["starting", "running"];

/// How many runs are starting or running.
pub async fn active_runs(session: &Session) -> Result<u64, DbErr> {
    ai_run::Entity::find().filter(ai_run::Column::State.is_in(LIVE)).count(session).await
}

fn ids(list: &[String]) -> Value {
    json!(list)
}

/// Check each run the board thinks is running. Returns `{"checked": n, "alive": [...], "dead": [...], "orphans":
/// [...]}`: `dead` had a CLI process of the board's that is gone (it is stopped so the run is resumed or ended by its
/// kind), `orphans` have no process or task at all (ended as after a crash).
pub async fn after_wake(session: &Session) -> Result<Map<String, Value>, DbErr> {
    let mut out = Map::new();
    if runner_link::mode() == "process" && !runner_link::in_runner() {
        runner_link::command("*", "wake", None, false).await?;
        out.insert("checked".into(), json!(0));
        out.insert("alive".into(), json!([]));
        out.insert("dead".into(), json!([]));
        out.insert("orphans".into(), json!([]));
        out.insert("deferred".into(), json!(true));
        return Ok(out);
    }
    let rows = ai_run::Entity::find().filter(ai_run::Column::State.is_in(["starting", "running"])).all(session).await?;
    let runtime = seams::runs_runtime();
    let (mut alive, mut dead, mut orphans) = (Vec::<String>::new(), Vec::<String>::new(), Vec::<String>::new());
    for run in &rows {
        match runtime.as_ref().and_then(|r| r.proc_alive(&run.id)) {
            Some(true) => alive.push(run.id.clone()),
            Some(false) => {
                dead.push(run.id.clone());
                transcripts::note(&run.id, "sleep", "The computer woke up; the CLI did not survive.", None);
                let row = json!({"kind": "start", "title": "The computer woke up; the CLI did not survive."});
                let _ = steps::append(&run.id, vec![row], steps::Extras::default()).await;
                // the reader sees the end: the run is resumed or ended by its kind
                if let Some(runtime) = &runtime {
                    runtime.kill_proc(&run.id);
                }
            }
            None => {
                if runtime.as_ref().is_some_and(|r| r.has_task(&run.id)) {
                    // being started or finished right now: the run's own task owns it
                    alive.push(run.id.clone());
                } else if run.pid.is_some_and(|pid| pid != 0)
                    && runtime.as_ref().is_some_and(|r| r.looks_like_cli(i64::from(run.pid.unwrap_or(0))))
                {
                    alive.push(run.id.clone());
                } else {
                    orphans.push(run.id.clone());
                }
            }
        }
    }
    if !orphans.is_empty() {
        end_orphans(&orphans).await?;
    }
    out.insert("checked".into(), json!(rows.len()));
    out.insert("alive".into(), ids(&alive));
    out.insert("dead".into(), ids(&dead));
    out.insert("orphans".into(), ids(&orphans));
    Ok(out)
}

/// Runs with no process and no task of the board's: ended as after a crash (only these: `recover_on_startup` would
/// also kill CLIs it finds by pid, and a run reached here by pid is alive).
async fn end_orphans(run_ids: &[String]) -> Result<(), DbErr> {
    let session = database::session();
    let runtime = seams::runs_runtime();
    for run_id in run_ids {
        let Some(run) = ai_run::Entity::find_by_id(run_id.as_str()).one(&session).await? else { continue };
        if !matches!(run.state.as_str(), "starting" | "running") || runtime.as_ref().is_some_and(|r| r.has_task(run_id)) {
            continue;
        }
        let mut row = run.into_active_model();
        row.state = kb_db::sea_orm::ActiveValue::Set("failed".into());
        row.ended_at = kb_db::sea_orm::ActiveValue::Set(Some(now_iso()));
        row.ended_reason = kb_db::sea_orm::ActiveValue::Set(Some(
            "The computer slept and this run's CLI did not survive. Retry to start a new run.".into(),
        ));
        row.ended_by = kb_db::sea_orm::ActiveValue::Set(Some("board".into()));
        row.stop_code = kb_db::sea_orm::ActiveValue::Set(Some(BOARD_CLOSED.into()));
        row.token_hash = kb_db::sea_orm::ActiveValue::Set(None);
        row.update(&session).await?;
    }
    session.commit().await
}
