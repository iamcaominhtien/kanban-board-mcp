//! RAM and CPU of the AI runs and of the machine (design/screens/ai-resources.md) (`services/ai/resources.py`).
//!
//! One monitor reads every running CLI every 2 s (psutil in Python, the `sysinfo` crate here): the CLI process itself
//! (what the memory limit counts) and what it started (a test, a build: shown apart, never counted). It keeps a short
//! history per run, the peak and the last value (saved with the run), sends a snapshot to whoever watches (the
//! Resources tab streams it), and calls back when a CLI passes the project's memory limit so the run engine can start
//! it again (`runs`).
//!
//! The monitor runs only while a CLI runs or someone watches, so an idle board costs nothing.
//!
//! Differences that come with `sysinfo`: it keeps the processes it read in one `System` (the cache `_procs` and
//! `_process` of the Python module), read at most every 200 ms, and it has no "access denied": a process that can be
//! listed can be read, so `readable` is always true here.
//!
//! The monitor itself (`Monitor`, `MON`, its watchers) is in `monitor`; reading a process and the machine, and what
//! the API returns, are here. Every name of the Python module is `resources::<name>`.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use chrono::Utc;
use kb_ai::runner_link;
use kb_ai::store::{get_settings, loads};
use kb_base::{pyjson, time};
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_agent, member, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

mod monitor;

pub use monitor::{Breach, MON, Monitor, Timing, Watcher};

/// Bytes in a megabyte.
pub const MB: f64 = 1024.0 * 1024.0;
/// how often every CLI is read
pub const SAMPLE_S: f64 = 2.0;
/// a history point every 5 s, 60 points = the last 5 minutes
pub const HISTORY_EVERY_S: f64 = 5.0;
/// How many history points a run keeps.
pub const HISTORY_POINTS: usize = 60;
/// how often the peak and last value are written to the run
pub const SAVE_EVERY_S: f64 = 15.0;
/// how long a project's limit is remembered
pub const LIMIT_TTL_S: f64 = 10.0;
/// restarts by the system before the next breach stops the run
pub const AUTO_RESTARTS: i64 = 2;
/// an ended run stays in the table for 10 minutes
pub const ENDED_SHOWN_S: i64 = 600;

/// The process table as last read, and when (`_procs`: CPU is measured from the previous reading).
struct Procs {
    system: System,
    read_at: Option<Instant>,
}

static PROCS: LazyLock<Mutex<Procs>> = LazyLock::new(|| Mutex::new(Procs { system: System::new(), read_at: None }));

/// Read every process again, unless that was done a moment ago (one reading serves every run of a round, and CPU
/// needs some time between two readings). Returns whether the processes were read now.
fn refresh(procs: &mut Procs, even_if_fresh: bool) -> bool {
    if !even_if_fresh && procs.read_at.is_some_and(|at| at.elapsed() < sysinfo::MINIMUM_CPU_UPDATE_INTERVAL) {
        return false;
    }
    let what = ProcessRefreshKind::nothing().without_tasks().with_memory().with_cpu();
    procs.system.refresh_processes_specifics(ProcessesToUpdate::All, true, what);
    procs.read_at = Some(Instant::now());
    true
}

/// A process that is there and not a zombie (psutil raises `NoSuchProcess` or `ZombieProcess` otherwise).
fn living(system: &System, pid: Pid) -> Option<&sysinfo::Process> {
    system.process(pid).filter(|p| p.status() != ProcessStatus::Zombie)
}

/// `round(x, digits)` as Python rounds a float: to the nearest, from the number's exact value.
fn round_to(x: f64, digits: usize) -> f64 {
    format!("{x:.digits$}").parse().unwrap_or(x)
}

/// What one reading of a run's CLI says.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    /// Memory the CLI process holds, in MB.
    pub cli_rss_mb: Option<f64>,
    /// Memory of everything the CLI started, in MB.
    pub extra_mb: Option<f64>,
    /// CPU of the CLI and its children together, in percent of one core (200 = two cores).
    pub cpu_pct: Option<f64>,
    /// Whether the numbers could be read.
    pub readable: bool,
    /// When it was read (set by the monitor).
    pub at: Option<String>,
}

/// {cli_rss_mb, extra_mb, cpu_pct, readable} for a CLI and what it started; None when it is gone.
///
/// `cpu_pct` is of one core (200 = two cores) over the CLI and its children together.
pub fn read_run(pid: i32) -> Option<Reading> {
    let root = Pid::from_u32(u32::try_from(pid).ok()?);
    let mut procs = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    if !refresh(&mut procs, false) && living(&procs.system, root).is_none() {
        // a CLI started since the last reading is not in it yet
        refresh(&mut procs, true);
    }
    let system = &procs.system;
    let cli = living(system, root)?;
    let rss = cli.memory();
    let mut cpu = f64::from(cli.cpu_usage());
    let mut extra: u64 = 0;
    // `cli.children(recursive=True)`: everything whose line of parents leads to the CLI
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (child, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*child);
        }
    }
    let mut seen: HashSet<Pid> = HashSet::from([root]);
    let mut todo = vec![root];
    while let Some(parent) = todo.pop() {
        for child in children.get(&parent).into_iter().flatten() {
            if !seen.insert(*child) {
                continue;
            }
            todo.push(*child);
            if let Some(kid) = living(system, *child) {
                extra += kid.memory();
                cpu += f64::from(kid.cpu_usage());
            }
        }
    }
    Some(Reading {
        cli_rss_mb: Some(round_to(rss as f64 / MB, 1)),
        extra_mb: Some(round_to(extra as f64 / MB, 1)),
        cpu_pct: Some(round_to(cpu, 1)),
        readable: true,
        at: None,
    })
}

/// RAM and load of the whole machine.
pub fn read_machine() -> Map<String, Value> {
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    let load1 = if cfg!(windows) { Value::Null } else { json!(round_to(System::load_average().one, 2)) };
    let mut out = Map::new();
    out.insert("ram_total_mb".into(), json!((system.total_memory() as f64 / MB).round_ties_even() as i64));
    out.insert("ram_free_mb".into(), json!((system.available_memory() as f64 / MB).round_ties_even() as i64));
    out.insert("load1".into(), load1);
    out.insert("cores".into(), json!(system.cpus().len().max(1)));
    out
}

/// Drop cached Process objects whose process is gone (a long-running server meets many pids).
pub fn forget_dead() {
    let mut procs = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    refresh(&mut procs, true);
}

// ---------------------------------------------------------------------------
// What the API and the MCP tool return
// ---------------------------------------------------------------------------

/// The restarts logged on a run: [{at, rss_mb, limit_mb, by, n}].
pub fn restarts_of(run: &ai_run::Model) -> Vec<Value> {
    match loads(Some(&run.restarts), json!([])) {
        Value::Array(items) => items.into_iter().filter(Value::is_object).collect(),
        _ => Vec::new(),
    }
}

fn row(
    run: &ai_run::Model,
    names: &HashMap<String, String>,
    colors: &HashMap<String, String>,
    tickets: &HashMap<String, String>,
    live: bool,
    working: &HashMap<String, Vec<String>>,
) -> Value {
    let reading = if live { MON.reading(&run.id) } else { None };
    let readable = reading.as_ref().is_none_or(|r| r.readable);
    let peak =
        if live { Some(run.peak_rss_mb.unwrap_or(0.0).max(MON.peak(&run.id).unwrap_or(0.0))) } else { run.peak_rss_mb };
    json!({
        "run_id": run.id,
        "number": run.number,
        "member_id": run.member_id,
        "member_name": names.get(&run.member_id),
        "member_color": colors.get(&run.member_id),
        "ticket_id": run.ticket_id,
        "ticket_title": run.ticket_id.as_ref().and_then(|id| tickets.get(id)),
        "state": run.state,
        "started_at": run.started_at,
        "ended_at": run.ended_at,
        "ended_reason": run.ended_reason,
        "stop_code": run.stop_code,
        // the roles (subagents) that work right now; empty means the lead works alone
        "roles_working": working.get(&run.id).cloned().unwrap_or_default(),
        "live": live,
        "readable": readable,
        "cli_rss_mb": match &reading {
            Some(r) => r.cli_rss_mb,
            None => run.last_rss_mb,
        },
        "extra_mb": reading.as_ref().and_then(|r| r.extra_mb),
        "cpu_pct": reading.as_ref().and_then(|r| r.cpu_pct),
        "peak_rss_mb": peak,
        "restarts": restarts_of(run),
        "history": if live { MON.history(&run.id) } else { Vec::new() },
    })
}

/// The Resources tab: the machine, the project's limits, every running run and the recently ended ones.
pub async fn snapshot(project_id: &str) -> Result<Map<String, Value>, DbErr> {
    let mut machine = read_machine();
    let cutoff = time::iso(&(Utc::now() - chrono::Duration::seconds(ENDED_SHOWN_S)));
    let session = database::session();
    let settings = get_settings(&session, project_id).await?;
    let mut live_ids: Vec<String> =
        MON.live().into_iter().filter(|(_, _, p)| p == project_id).map(|(r, _, _)| r).collect();
    let active = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::State.is_in(["starting", "running"]))
        .all(&session)
        .await?;
    if runner_link::mode() == "process" && !runner_link::in_runner() {
        // the CLIs live in the runner process: the API cannot read them, but a run that works has one. Its numbers
        // are the last ones the runner saved; the live ones reach the app over the event stream (`ai.resources`).
        live_ids.extend(active.iter().filter(|r| r.state == "running").map(|r| r.id.clone()));
    }
    let mut working: HashMap<String, Vec<String>> = HashMap::new();
    if !active.is_empty() {
        let open_agents = ai_run_agent::Entity::find()
            .filter(ai_run_agent::Column::RunId.is_in(active.iter().map(|r| r.id.clone())))
            .filter(ai_run_agent::Column::EndedAt.is_null())
            .all(&session)
            .await?;
        for agent in open_agents {
            working.entry(agent.run_id).or_default().push(agent.agent_type);
        }
    }
    let ended = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::EndedAt.gte(cutoff))
        .filter(ai_run::Column::PeakRssMb.is_not_null())
        .all(&session)
        .await?;
    let active_ids: HashSet<String> = active.iter().map(|a| a.id.clone()).collect();
    let mut runs = active;
    runs.extend(ended.into_iter().filter(|r| !active_ids.contains(&r.id)));
    let member_ids: HashSet<String> = runs.iter().map(|r| r.member_id.clone()).collect();
    let people = if member_ids.is_empty() {
        Vec::new()
    } else {
        member::Entity::find().filter(member::Column::Id.is_in(member_ids)).all(&session).await?
    };
    let names: HashMap<String, String> = people.iter().map(|m| (m.id.clone(), m.name.clone())).collect();
    let colors: HashMap<String, String> = people.iter().map(|m| (m.id.clone(), m.color.clone())).collect();
    let ticket_ids: HashSet<String> = runs.iter().filter_map(|r| r.ticket_id.clone()).collect();
    let tickets: HashMap<String, String> = if ticket_ids.is_empty() {
        HashMap::new()
    } else {
        ticket::Entity::find()
            .filter(ticket::Column::Id.is_in(ticket_ids))
            .all(&session)
            .await?
            .into_iter()
            .map(|t| (t.id, t.title))
            .collect()
    };
    drop(session);
    let mut rows: Vec<Value> =
        runs.iter().map(|r| row(r, &names, &colors, &tickets, live_ids.contains(&r.id), &working)).collect();
    let number = |row: &Value, key: &str| row[key].as_f64().unwrap_or(0.0);
    let is_live = |row: &Value| row["live"] == true;
    rows.sort_by(|a, b| {
        (!is_live(a)).cmp(&!is_live(b)).then(number(b, "cli_rss_mb").total_cmp(&number(a, "cli_rss_mb")))
    });
    // `sum(...)` of nothing, or of runs without a number, is the integer 0 in Python, and `round` keeps it one
    let measured = rows.iter().any(|r| is_live(r) && (r["cli_rss_mb"].is_number() || r["extra_mb"].is_number()));
    let ai_mb = kb_base::pynum::sum(
        rows.iter().filter(|r| is_live(r)).map(|r| number(r, "cli_rss_mb") + number(r, "extra_mb")),
    );
    machine.insert("ai_rss_mb".into(), if measured { json!(round_to(ai_mb, 1)) } else { json!(0) });
    machine.insert("cli_count".into(), json!(rows.iter().filter(|r| is_live(r)).count()));
    let mut out = Map::new();
    out.insert("project_id".into(), json!(project_id));
    out.insert("at".into(), json!(time::now_iso()));
    out.insert("machine".into(), Value::Object(machine));
    out.insert(
        "limits".into(),
        json!({
            "run_memory_limit_mb": settings.run_memory_limit_mb,
            "auto_restarts": AUTO_RESTARTS,
            "board_max_parallel": settings.board_max_parallel,
        }),
    );
    out.insert("runs".into(), Value::Array(rows));
    Ok(out)
}

/// What the AI's card in Now shows about a run: the CLI's RAM and CPU now, its peak and its restarts.
pub fn card_view(run: &ai_run::Model, limit_mb: i64) -> Option<Value> {
    let reading = MON.reading(&run.id);
    if reading.is_none() && run.peak_rss_mb.unwrap_or(0.0) == 0.0 {
        return None;
    }
    let peak = run.peak_rss_mb.unwrap_or(0.0).max(MON.peak(&run.id).unwrap_or(0.0));
    Some(json!({
        "cli_rss_mb": match &reading {
            Some(r) => r.cli_rss_mb,
            None => run.last_rss_mb,
        },
        "extra_mb": reading.as_ref().and_then(|r| r.extra_mb),
        "cpu_pct": reading.as_ref().and_then(|r| r.cpu_pct),
        "peak_rss_mb": if peak == 0.0 { None } else { Some(peak) },
        "readable": reading.as_ref().is_none_or(|r| r.readable),
        "restarts": restarts_of(run).len(),
        "limit_mb": limit_mb,
    }))
}

/// JSON for the `restarts` column.
pub fn dump(value: &Value) -> String {
    pyjson::Dumps::new().ensure_ascii(false).dump(value)
}
