//! Health (design/screens/ai-team-review.md, B and E; AI v2): is the AI team healthy, per team
//! (`services/ai/health.py`).
//!
//! One page, computed on the server from what the board keeps; nothing is stored. Five measures, for the project and
//! for each team (cost exists per run only, so there is no row per role):
//!
//! - **reliability**: runs that finished OK of the runs that ended (failed, timed out and cancelled count against).
//!   Runs the team did not cause (the board closed, the ticket was deleted or reassigned) are left out. 85% or more
//!   good, 70 to 85% watch, below 70% fix (the design's term table).
//! - **autonomy**: touches per ticket, from the tab You stepped in. The design measured the share of completed
//!   tickets with no touch; v2 asks for touches per ticket, which is not the same number, so its thresholds are ours:
//!   under 1 good, 1 to 2 watch, over 2 fix. The share of tickets with no touch at all is shown beside it.
//! - **speed**: median run duration and median time from the assignment to Review. The design gives it no
//!   thresholds, so it has no verdict.
//! - **quality**: how often work the AI finished is sent back: tickets a run finished that a person reopened
//!   afterwards (from the ticket's reopen history). Under 10% good, 10 to 20% watch, over 20% fix (the design's "sent
//!   back" terms). A Reviewer's findings are counted where a run's report lists them (`findings`, one line each) and
//!   shown only when a run reported some.
//! - **cost**: money and tokens against the team's caps: this range's spend, the average per run, runs over the cap
//!   of one run and the last 30 days against the monthly cap. Under 70% of the cap good, 70 to 90% watch, over 90%
//!   fix; a team with no monthly cap has no verdict. Runs that report no price show tokens, never $0.
//!
//! Under `MIN_RUNS` runs there is no verdict (the numbers show). "What to fix" has at most five items, each with its
//! evidence and an action that opens the exact setting, run, team, ticket or tab.
//!
//! The Python module is one file; here it is this file (lines 1 to 247 and 521 to 717: the measures and the page)
//! and `fixes` (250 to 518: `_fixes`, `_sentence`, `_reason`).

use std::collections::{HashMap, HashSet};

use chrono::Duration;
use kb_ai::store::{loads, parse_iso};
use kb_base::{pyjson, time};
use kb_db::Session;
use kb_db::entities::{ai_project_settings, ai_run, ai_team, member, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use crate::pynum::{round_int, round_to, rounded_sum_or_zero};
use crate::{clock, touches};

mod fixes;

pub use fixes::{fixes, reason, sentence};

/// The ranges of the page and their days.
pub const RANGES: [(&str, i64); 2] = [("7d", 7), ("30d", 30)];
/// under this many runs the numbers show and the verdict waits
pub const MIN_RUNS: usize = 10;
/// The most items "What to fix" lists.
pub const MAX_FIXES: usize = 5;
/// The states of a run that is over.
pub const ENDED: [&str; 4] = ["finished", "failed", "cancelled", "timed_out"];
/// runs that ended for a reason that is not the team's doing
pub const NOT_THE_TEAM: [&str; 3] = ["board_closed", "deleted", "reassigned"];

/// a rule shows only with this many cases (the design: "shown only with 3 or more cases"; a memory stop is clear at
/// 2)
pub const MIN_CASES: usize = 3;
/// How many memory stops of one ticket make a finding.
pub const MIN_CASES_MEMORY: usize = 2;

/// good / watch / fix for a value against the two limits (None when there is no value).
pub fn verdict_of(value: Option<f64>, good: f64, watch: f64, higher_is_better: bool) -> Option<&'static str> {
    let value = value?;
    Some(if higher_is_better {
        if value >= good {
            "good"
        } else if value >= watch {
            "watch"
        } else {
            "fix"
        }
    } else if value < good {
        "good"
    } else if value <= watch {
        "watch"
    } else {
        "fix"
    })
}

/// `_median`: `round(statistics.median(values), 1)`, or None for no values.
pub fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut data = values.to_vec();
    data.sort_by(f64::total_cmp);
    let n = data.len();
    let mid = if n % 2 == 1 { data[n / 2] } else { (data[n / 2 - 1] + data[n / 2]) / 2.0 };
    Some(round_to(mid, 1))
}

/// `_secs`: the seconds from `a` to `b`, or None when either is no time or `b` is before `a`.
pub fn secs(a: Option<&str>, b: Option<&str>) -> Option<f64> {
    let (x, y) = (parse_iso(a)?, parse_iso(b)?);
    (y >= x).then(|| touches::seconds_between(&x, &y))
}

/// `_priced`: whether the run reports a price.
fn priced(r: &ai_run::Model) -> bool {
    r.metered || r.cost_usd > 0.0
}

fn not_the_team(r: &ai_run::Model) -> bool {
    r.stop_code.as_deref().is_some_and(|code| NOT_THE_TEAM.contains(&code))
}

/// `loads(text, [])` as a list of the dicts in it.
fn dicts_of(text: &str) -> Vec<Map<String, Value>> {
    match loads(Some(text), json!([])) {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|e| match e {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// A truthy text of a dict.
fn text_at<'a>(e: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    e.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `_ticket_times`: the ticket's assignments (to, at) and the times it moved into Review, from its activity log.
pub fn ticket_times(t: Option<&ticket::Model>) -> (Vec<(String, String)>, Vec<String>) {
    let (mut assigned, mut review) = (Vec::new(), Vec::new());
    for e in dicts_of(t.map_or("[]", |t| t.activity_log.as_str())) {
        let field = e.get("field").and_then(Value::as_str);
        match (field, text_at(&e, "to"), text_at(&e, "at")) {
            (Some("assignee"), Some(to), Some(at)) => assigned.push((to.to_string(), at.to_string())),
            (Some("status"), Some("review"), Some(at)) => review.push(at.to_string()),
            _ => {}
        }
    }
    (assigned, review)
}

/// `_reopens_after`: how many times the ticket was reopened after this time (and before `until`), from its reopen
/// history.
pub fn reopens_after(t: Option<&ticket::Model>, after: Option<&str>, until: Option<&str>) -> usize {
    let (Some(t), Some(after)) = (t, after.filter(|a| !a.is_empty())) else { return 0 };
    dicts_of(&t.reopen_history)
        .iter()
        .filter_map(|e| text_at(e, "at"))
        .filter(|at| *at >= after && until.is_none_or(|until| *at < until))
        .count()
}

/// `_first_finish`: for each ticket, when the first run of these that finished OK on it ended (in the order the
/// tickets are first met).
pub fn first_finish(runs: &[&ai_run::Model]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for r in runs {
        let (Some(ticket_id), Some(ended_at)) =
            (r.ticket_id.as_deref().filter(|t| !t.is_empty()), r.ended_at.as_deref().filter(|e| !e.is_empty()))
        else {
            continue;
        };
        if r.state != "finished" {
            continue;
        }
        match out.iter_mut().find(|(id, _)| id == ticket_id) {
            Some((_, at)) if ended_at < at.as_str() => *at = ended_at.to_string(),
            Some(_) => {}
            None => out.push((ticket_id.to_string(), ended_at.to_string())),
        }
    }
    out
}

/// What `measures` takes besides the runs, the touches and the tickets.
#[derive(Clone, Copy)]
pub struct MeasureOpts<'a> {
    /// The team the runs are of (None: the whole project).
    pub team: Option<&'a ai_team::Model>,
    /// What the last 30 days cost.
    pub month_spend: &'a [f64],
    /// Whether there are enough runs for a verdict.
    pub judged: bool,
    /// Reopens count only before this time (the range before the current one).
    pub until: Option<&'a str>,
}

/// The five measures of a set of runs (one team's, or the project's) and of the touches that belong to it.
/// `month_spend` is the costs of the last 30 days' runs, which Python sums before the call.
pub fn measures(
    runs: &[&ai_run::Model],
    tks: &[&Map<String, Value>],
    tickets: &HashMap<String, ticket::Model>,
    opts: MeasureOpts<'_>,
) -> Value {
    let MeasureOpts { team, month_spend, judged, until } = opts;
    let ended: Vec<&ai_run::Model> =
        runs.iter().copied().filter(|r| ENDED.contains(&r.state.as_str()) && !not_the_team(r)).collect();
    let ok: Vec<&ai_run::Model> = ended.iter().copied().filter(|r| r.state == "finished").collect();
    let rel = (!ended.is_empty()).then(|| ok.len() as f64 / ended.len() as f64);

    let ticket_ids: HashSet<&str> =
        runs.iter().filter_map(|r| r.ticket_id.as_deref()).filter(|t| !t.is_empty()).collect();
    let touched: HashSet<&str> = tks.iter().filter_map(|t| text_at(t, "ticket_id")).collect();
    let on_tickets = tks.iter().filter(|t| text_at(t, "ticket_id").is_some_and(|id| ticket_ids.contains(id))).count();
    let raw_per_ticket = (!ticket_ids.is_empty()).then(|| on_tickets as f64 / ticket_ids.len() as f64);
    let per_ticket = raw_per_ticket.map(|raw| round_to(raw, 1));
    let clean = ticket_ids.difference(&touched).count();

    let durations: Vec<f64> = runs
        .iter()
        .filter(|r| ENDED.contains(&r.state.as_str()))
        .filter_map(|r| secs(r.started_at.as_deref(), r.ended_at.as_deref()))
        .collect();
    let mut to_review: Vec<f64> = Vec::new();
    let mut queued_by_ticket: HashMap<&str, Vec<&str>> = HashMap::new();
    for r in runs {
        if let Some(ticket_id) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            queued_by_ticket.entry(ticket_id).or_default().push(r.queued_at.as_str());
        }
    }
    for tid in &ticket_ids {
        let mine = queued_by_ticket.get(tid).cloned().unwrap_or_default();
        let (assigned, review) = ticket_times(tickets.get(*tid));
        let mut start: Option<String> = mine.iter().min().map(|s| s.to_string());
        if let Some(team) = team {
            let before = assigned
                .iter()
                .filter(|(to, at)| *to == team.id && start.as_ref().is_none_or(|start| at <= start))
                .map(|(_, at)| at)
                .max();
            if let Some(before) = before {
                start = Some(before.clone());
            }
        }
        let Some(start) = start.filter(|s| !s.is_empty()) else { continue };
        let Some(first) = review.iter().filter(|at| **at >= start).min() else { continue };
        if let Some(d) = secs(Some(&start), Some(first)) {
            to_review.push(d);
        }
    }

    // work the AI finished that a person then reopened (reopens after the first finish, not the ticket's whole life)
    let first = first_finish(&ok);
    let reopened = first.iter().filter(|(tid, at)| reopens_after(tickets.get(tid), Some(at), until) > 0).count();
    let quality = (!first.is_empty()).then(|| reopened as f64 / first.len() as f64);
    // a Reviewer's findings, where the lead's final report lists them
    let findings: Vec<usize> = runs
        .iter()
        .filter_map(|r| match loads(Some(&r.report), json!({})) {
            Value::Object(report) => match report.get("findings") {
                Some(Value::Array(f)) if !f.is_empty() => Some(f.len()),
                _ => None,
            },
            _ => None,
        })
        .collect();

    let priced_runs: Vec<&ai_run::Model> = runs.iter().copied().filter(|r| priced(r)).collect();
    let costs: Vec<f64> = runs.iter().map(|r| r.cost_usd.get()).collect();
    let spend = rounded_sum_or_zero(&costs, 2);
    let spend_f = spend.as_f64().unwrap_or(0.0);
    let tokens: i64 = runs.iter().map(|r| i64::from(r.tokens_in) + i64::from(r.tokens_out)).sum();
    let cap_run = team.and_then(|t| t.cap_per_run);
    let over = priced_runs.iter().filter(|r| cap_run.is_some_and(|cap| cap != 0.0 && r.cost_usd > cap)).count();
    let monthly = team.and_then(|t| t.monthly_cap);
    let month_total = crate::pynum::sum(month_spend.iter().copied());
    let share = monthly.filter(|m| *m != 0.0).map(|monthly| round_to(month_total / monthly, 3));
    let mut cost_verdict = verdict_of(share, 0.7, 0.9, false);
    if over != 0 && matches!(cost_verdict, None | Some("good")) {
        cost_verdict = Some("watch");
    }

    let v = |value: Option<f64>, good: f64, watch: f64, hib: bool| {
        if judged { verdict_of(value, good, watch, hib) } else { None }
    };
    let count = |state: &str| ended.iter().filter(|r| r.state == state).count();
    json!({
        "reliability": {
            "value": rel.map(|rel| round_to(rel, 3)),
            "verdict": v(rel, 0.85, 0.7, true),
            "ok": ok.len(),
            "ended": ended.len(),
            "failed": count("failed"),
            "timed_out": count("timed_out"),
            "cancelled": count("cancelled"),
        },
        "autonomy": {
            "value": per_ticket,
            "verdict": v(raw_per_ticket, 1.0, 2.0, false),
            "touches": on_tickets,
            "touches_all": tks.len(),
            "tickets": ticket_ids.len(),
            "clean": clean,
            "avoidable": tks.iter().filter(|t| t.get("mark").and_then(Value::as_str) == Some("avoidable")).count(),
        },
        "speed": {
            "run_median_s": median(&durations),
            "to_review_median_s": median(&to_review),
            "to_review_tickets": to_review.len(),
            "verdict": null,
        },
        "quality": {
            "value": quality.map(|q| round_to(q, 3)),
            "verdict": v(quality, 0.1, 0.2, false),
            "reopened": reopened,
            "finished_tickets": first.len(),
            "findings": (!findings.is_empty()).then(|| findings.iter().sum::<usize>()),
            "runs_with_findings": findings.len(),
        },
        "cost": {
            "usd": spend,
            "tokens": tokens,
            "runs": runs.len(),
            "priced_runs": priced_runs.len(),
            "tokens_only_runs": runs.len() - priced_runs.len(),
            "per_run": (!priced_runs.is_empty()).then(|| round_to(spend_f / priced_runs.len() as f64, 2)),
            "tokens_per_run": (!runs.is_empty()).then(|| round_int(tokens as f64 / runs.len() as f64)),
            "cap_per_run": cap_run,
            "runs_over_cap": over,
            "monthly_cap": monthly,
            "month_spend": rounded_sum_or_zero(month_spend, 2),
            "month_share": share,
            "verdict": if judged { cost_verdict } else { None },
        },
    })
}

/// `_state_of`: the worst verdict of a set of measures (speed has none).
fn state_of(m: &Value) -> &'static str {
    let vs: Vec<&str> =
        ["reliability", "autonomy", "quality", "cost"].iter().filter_map(|k| m[*k]["verdict"].as_str()).collect();
    if vs.contains(&"fix") {
        "fix"
    } else if vs.contains(&"watch") {
        "watch"
    } else {
        "good"
    }
}

/// The Health page: a verdict, five measures with the change since the range before, a row per team, what to fix.
/// Python's default `range_key`: "7d".
pub async fn health(session: &Session, project_id: &str, range_key: &str) -> Result<Map<String, Value>, DbErr> {
    let (key, days) = RANGES.iter().find(|(k, _)| *k == range_key).copied().unwrap_or(RANGES[0]);
    let span = Duration::days(days);
    let until = clock::now();
    let since = until - span;
    let prev_since = since - span;
    let (iso, prev_iso) = (time::iso(&since), time::iso(&prev_since));

    let members = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.is_in(["ai", "ai_removed"]))
        .all(session)
        .await?;
    let profiles: HashMap<String, ai_team::Model> = ai_team::Entity::find()
        .filter(ai_team::Column::ProjectId.eq(project_id))
        .all(session)
        .await?
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect();
    let month_start = until - Duration::days(30);
    let all_runs = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Kind.eq("team"))
        .filter(ai_run::Column::QueuedAt.gte(time::iso(&prev_since.min(month_start))))
        .all(session)
        .await?;
    let runs: Vec<&ai_run::Model> = all_runs.iter().filter(|r| r.queued_at >= iso).collect();
    let prev_runs: Vec<&ai_run::Model> =
        all_runs.iter().filter(|r| prev_iso <= r.queued_at && r.queued_at < iso).collect();
    let month_iso = time::iso(&month_start);
    let ticket_ids: HashSet<&str> =
        all_runs.iter().filter_map(|r| r.ticket_id.as_deref()).filter(|t| !t.is_empty()).collect();
    let tickets: HashMap<String, ticket::Model> = if ticket_ids.is_empty() {
        HashMap::new()
    } else {
        ticket::Entity::find()
            .filter(ticket::Column::Id.is_in(ticket_ids.iter().copied()))
            .all(session)
            .await?
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect()
    };
    let settings = ai_project_settings::Entity::find_by_id(project_id).one(session).await?;
    let memory_limit = settings.map_or(4096, |s| i64::from(s.run_memory_limit_mb));

    let all_touches = touches::collect(session, project_id, prev_since, None).await?;
    let tks: Vec<&Map<String, Value>> =
        all_touches.iter().filter(|t| text_at(t, "at").is_some_and(|at| at >= iso.as_str())).collect();
    let prev_tks: Vec<&Map<String, Value>> =
        all_touches.iter().filter(|t| text_at(t, "at").is_some_and(|at| at < iso.as_str())).collect();

    let month_spend = |team_id: Option<&str>| -> Vec<f64> {
        all_runs
            .iter()
            .filter(|r| r.queued_at >= month_iso && team_id.is_none_or(|id| r.member_id == id))
            .map(|r| r.cost_usd.get())
            .collect()
    };

    // (in the order the members were read, as Python's dict keeps it)
    let mut rows: Vec<(String, Value)> = Vec::new();
    for m in &members {
        let team_id = m.id.as_str();
        let mine: Vec<&ai_run::Model> = runs.iter().copied().filter(|r| r.member_id == team_id).collect();
        if m.kind == "ai_removed" && mine.is_empty() {
            continue;
        }
        let mt: Vec<&Map<String, Value>> = tks
            .iter()
            .copied()
            .filter(|t| t["team_ids"].as_array().is_some_and(|ids| ids.iter().any(|i| i.as_str() == Some(team_id))))
            .collect();
        let judged = mine.len() >= MIN_RUNS;
        let spend = month_spend(Some(team_id));
        let ms = measures(
            &mine,
            &mt,
            &tickets,
            MeasureOpts { team: profiles.get(team_id), month_spend: &spend, judged, until: None },
        );
        let status = if mine.is_empty() {
            "idle"
        } else if !judged {
            "too_few"
        } else {
            match state_of(&ms) {
                "good" => "healthy",
                other => other,
            }
        };
        rows.push((
            team_id.to_string(),
            json!({
                "id": team_id,
                "name": m.name,
                "removed": m.kind == "ai_removed",
                "runs": mine.len(),
                "judged": judged,
                "status": status,
                "paused": profiles.get(team_id).is_some_and(|p| p.paused),
                "measures": ms,
            }),
        ));
    }

    let judged = runs.len() >= MIN_RUNS;
    let spend = month_spend(None);
    let mut total =
        measures(&runs, &tks, &tickets, MeasureOpts { team: None, month_spend: &spend, judged, until: None });
    // the project's cost verdict follows its teams' caps: the worst of them
    let team_costs: Vec<&str> = rows.iter().filter_map(|(_, r)| r["measures"]["cost"]["verdict"].as_str()).collect();
    total["cost"]["verdict"] = if team_costs.contains(&"fix") {
        json!("fix")
    } else if team_costs.contains(&"watch") {
        json!("watch")
    } else if !team_costs.is_empty() {
        json!("good")
    } else {
        Value::Null
    };
    let prev_total = measures(
        &prev_runs,
        &prev_tks,
        &tickets,
        MeasureOpts { team: None, month_spend: &[], judged: false, until: Some(&iso) },
    );
    let teams: HashMap<&str, &member::Model> = members.iter().map(|m| (m.id.as_str(), m)).collect();
    let found = if !runs.is_empty() || !tks.is_empty() {
        fixes(&runs, &tks, &teams, &rows, &tickets, memory_limit, &iso)
    } else {
        Vec::new()
    };

    let vs: Vec<&str> =
        ["reliability", "autonomy", "quality", "cost"].iter().filter_map(|k| total[*k]["verdict"].as_str()).collect();
    let count = |name: &str| vs.iter().filter(|v| **v == name).count();
    let counts = json!({"good": count("good"), "watch": count("watch"), "fix": count("fix")});
    let mut state = if !judged {
        "unknown"
    } else if count("fix") != 0 {
        "fix"
    } else if count("watch") != 0 {
        "watch"
    } else {
        "good"
    };
    if state != "unknown" && found.iter().any(|f| f["severity"] == "fix") {
        state = "fix";
    }
    let bad: Vec<String> = rows
        .iter()
        .filter(|(_, r)| r["status"] == "fix")
        .map(|(_, r)| r["name"].as_str().unwrap_or("").to_string())
        .collect();
    let title = match state {
        "good" => "Healthy",
        "watch" => "Needs attention",
        "fix" => "Needs fixing",
        _ => "Not enough to judge yet",
    };
    let text = if runs.is_empty() {
        "No AI work in this range, so there is nothing to judge yet.".to_string()
    } else if !judged {
        format!(
            "Only {} run{} in this range. The numbers show; the verdict waits for {MIN_RUNS} runs.",
            runs.len(),
            if runs.len() != 1 { "s" } else { "" }
        )
    } else {
        sentence(&total, Some(&prev_total), &found, &bad)
    };
    let mut team_rows: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
    team_rows.sort_by(|a, b| {
        let key = |r: &Value| (-(r["runs"].as_i64().unwrap_or(0)), r["name"].as_str().unwrap_or("").to_string());
        key(a).cmp(&key(b))
    });
    let run_tickets: HashSet<&str> =
        runs.iter().filter_map(|r| r.ticket_id.as_deref()).filter(|t| !t.is_empty()).collect();

    let mut out = Map::new();
    out.insert("range".into(), json!(key));
    out.insert("since".into(), json!(iso));
    out.insert("until".into(), json!(time::iso(&until)));
    out.insert("runs".into(), json!(runs.len()));
    out.insert("tickets".into(), json!(run_tickets.len()));
    out.insert("min_runs".into(), json!(MIN_RUNS));
    out.insert("can_judge".into(), json!(judged));
    out.insert("has_teams".into(), json!(members.iter().any(|m| m.kind == "ai")));
    out.insert("state".into(), json!(state));
    out.insert("title".into(), json!(title));
    out.insert("text".into(), json!(text));
    out.insert("counts".into(), counts);
    let previous = json!({
        "reliability": prev_total["reliability"]["value"],
        "autonomy": prev_total["autonomy"]["value"],
        "quality": prev_total["quality"]["value"],
        "run_median_s": prev_total["speed"]["run_median_s"],
        "usd": prev_total["cost"]["usd"],
        "priced_runs": prev_total["cost"]["priced_runs"],
        "tokens": prev_total["cost"]["tokens"],
        "runs": prev_runs.len(),
    });
    out.insert("measures".into(), total);
    out.insert("previous".into(), previous);
    out.insert("teams".into(), Value::Array(team_rows));
    out.insert("fixes".into(), Value::Array(found));
    Ok(out)
}

/// `str(value)` of a JSON value, `default` for a falsy one (`value or default`).
pub(crate) fn text_or(value: Option<&Value>, default: &str) -> String {
    match value.filter(|v| pyjson::truthy(v)) {
        Some(Value::String(s)) => s.clone(),
        Some(other) => pyjson::py_str(other),
        None => default.to_string(),
    }
}
