//! Budget checks shared by the scheduler, the API loop and the member status: the agent's daily budget, monthly cap
//! and tokens per day, the board's daily cap, monthly budget and tokens, and the run counts of automatic runs: the
//! board's runs per day (scheduled runs) and the runners' scheduled runs per day. A run a person starts
//! (an assignment, a question, a message) is never counted against a run limit. "Today" starts at local midnight and
//! the month on the 1st, local time (C of the deleted v1 board ai-safety-cost).
//! A person can raise today's cap (an approved "Raise cap"); the raise ends at midnight.
//!
//! Every function that reads the clock or the computer's time zone has an `_in` form that takes the zone (and the
//! moment): the plain one is that form with `Local` and now. The golden vectors and the tests of day boundaries
//! use the `_in` forms.

use chrono::{DateTime, Datelike, Days, FixedOffset, Local, NaiveDate, NaiveDateTime, Offset, TimeZone, Utc};
use kb_base::time;
use kb_db::Session;
use kb_db::entities::{ai_project_settings, ai_run, ai_team, ai_usage};
use kb_db::sea_orm::sea_query::{Expr, ExprTrait, Func, SimpleExpr};
use kb_db::sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};

/// The time of day `00:00:00` of `date` in the fixed offset of `now` (Python's `now.replace(hour=0, ...)` keeps the
/// offset the zone had at `now`, so a day that changes offset still starts at the offset `now` has).
fn midnight_at_offset(date: NaiveDate, offset: FixedOffset) -> DateTime<Utc> {
    let naive = date.and_time(chrono::NaiveTime::MIN);
    offset.from_local_datetime(&naive).single().map_or_else(|| Utc.from_utc_datetime(&naive), |d| d.with_timezone(&Utc))
}

/// `datetime.now().astimezone()` as a moment in the fixed offset the zone has then.
fn aware_local<Z: TimeZone>(tz: &Z, at: DateTime<Utc>) -> DateTime<FixedOffset> {
    at.with_timezone(tz).fixed_offset()
}

/// Local midnight, in UTC.
pub fn today_start() -> DateTime<Utc> {
    today_start_in(&Local, Utc::now())
}

/// `today_start` for the zone `tz` at the moment `now`.
pub fn today_start_in<Z: TimeZone>(tz: &Z, now: DateTime<Utc>) -> DateTime<Utc> {
    let local = aware_local(tz, now);
    midnight_at_offset(local.date_naive(), *local.offset())
}

/// The local calendar day as YYYY-MM-DD.
pub fn day_key(at: Option<DateTime<FixedOffset>>) -> String {
    day_key_in(&Local, at.map(|a| a.with_timezone(&Utc)), Utc::now())
}

/// `day_key` for the zone `tz`; `now` is the moment used when `at` is None.
pub fn day_key_in<Z: TimeZone>(tz: &Z, at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> String {
    iso_date(aware_local(tz, at.unwrap_or(now)).date_naive())
}

/// `date.isoformat()`.
fn iso_date(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// The 1st of this month (of `at`, default now) at local midnight, in UTC.
pub fn month_start(at: Option<DateTime<Utc>>) -> DateTime<Utc> {
    month_start_in(&Local, at, Utc::now())
}

/// `month_start` for the zone `tz`.
pub fn month_start_in<Z: TimeZone>(tz: &Z, at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> DateTime<Utc> {
    let local = aware_local(tz, at.unwrap_or(now));
    let first = local.date_naive().with_day(1).unwrap_or_else(|| local.date_naive());
    midnight_at_offset(first, *local.offset())
}

/// The local calendar date (YYYY-MM-DD) of a stored UTC time, so "today" rolls over at local midnight.
pub fn local_day(iso: Option<&str>) -> Option<String> {
    local_day_in(&Local, iso)
}

/// `local_day` for the zone `tz`.
pub fn local_day_in<Z: TimeZone>(tz: &Z, iso: Option<&str>) -> Option<String> {
    let dt = crate::store::parse_iso(Some(iso?))?;
    Some(iso_date(aware_local(tz, dt.with_timezone(&Utc)).date_naive()))
}

/// A naive local time as an instant, the way `datetime.astimezone()` reads a naive datetime (fold 0): a time that
/// occurs twice is the first one; a time that does not exist (the clock skipped it) is read with the offset in force
/// before the skip.
pub(crate) fn local_naive_to_utc<Z: TimeZone>(tz: &Z, naive: NaiveDateTime) -> DateTime<Utc> {
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => dt.with_timezone(&Utc),
        chrono::LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc),
        chrono::LocalResult::None => {
            // the offset just before the gap
            let before = naive - chrono::Duration::hours(24);
            let offset = match tz.from_local_datetime(&before) {
                chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => dt.offset().fix(),
                chrono::LocalResult::None => FixedOffset::east_opt(0).unwrap_or_else(|| Utc.fix()),
            };
            (naive - chrono::Duration::seconds(i64::from(offset.local_minus_utc()))).and_utc()
        }
    }
}

/// (local date, start, end) in UTC of the local calendar day `days_ago` days back; DST-safe because the day is counted
/// on the calendar and each midnight is resolved on its own.
pub fn day_bounds(days_ago: u64) -> (String, DateTime<Utc>, DateTime<Utc>) {
    day_bounds_in(&Local, days_ago, Utc::now())
}

/// `day_bounds` for the zone `tz` at the moment `now`.
pub fn day_bounds_in<Z: TimeZone>(tz: &Z, days_ago: u64, now: DateTime<Utc>) -> (String, DateTime<Utc>, DateTime<Utc>) {
    let today = aware_local(tz, now).date_naive();
    let day = today.checked_sub_days(Days::new(days_ago)).unwrap_or(today);
    let next = day.checked_add_days(Days::new(1)).unwrap_or(day);
    (
        iso_date(day),
        local_naive_to_utc(tz, day.and_time(chrono::NaiveTime::MIN)),
        local_naive_to_utc(tz, next.and_time(chrono::NaiveTime::MIN)),
    )
}

fn iso(dt: &DateTime<Utc>) -> String {
    time::iso(dt)
}

/// `COALESCE(SUM(col), 0)`.
fn sum_or_zero(column: impl ColumnTrait, zero: f64) -> SimpleExpr {
    let sum: Expr = Func::sum(Expr::col(column)).into();
    let zero: Expr = Expr::val(zero);
    Func::coalesce([sum, zero]).into()
}

async fn float_sum<E: EntityTrait>(
    session: &Session,
    select: kb_db::sea_orm::Select<E>,
    expr: SimpleExpr,
) -> Result<f64, DbErr> {
    let value: Option<f64> =
        select.select_only().expr_as(expr, "total").into_tuple::<Option<f64>>().one(session).await?.flatten();
    Ok(value.unwrap_or(0.0))
}

/// Metered spend since `since`: runs of one agent or one project, plus its one-shot calls. `whole_group` counts the
/// agent's copies in other projects too (its budget is one).
pub async fn spent(
    session: &Session,
    since: DateTime<Utc>,
    member_id: Option<&str>,
    project_id: Option<&str>,
    until: Option<DateTime<Utc>>,
    _whole_group: bool,
) -> Result<f64, DbErr> {
    let member_id = member_id.filter(|m| !m.is_empty());
    let project_id = project_id.filter(|p| !p.is_empty());
    let mut stmt = ai_run::Entity::find()
        .filter(ai_run::Column::Metered.eq(true))
        .filter(ai_run::Column::StartedAt.gte(iso(&since)));
    if let Some(until) = until {
        stmt = stmt.filter(ai_run::Column::StartedAt.lt(iso(&until)));
    }
    if let Some(member_id) = member_id {
        stmt = stmt.filter(ai_run::Column::MemberId.is_in([member_id]));
    }
    if let Some(project_id) = project_id {
        stmt = stmt.filter(ai_run::Column::ProjectId.eq(project_id));
    }
    let runs = float_sum(session, stmt, sum_or_zero(ai_run::Column::CostUsd, 0.0)).await?;
    let Some(member_id) = member_id else {
        let Some(project_id) = project_id else { return Ok(runs) };
        // The project's one-shot calls (chat, drafts, editor help) count toward the board's caps too
        let mut calls = ai_usage::Entity::find()
            .filter(ai_usage::Column::Metered.eq(true))
            .filter(ai_usage::Column::ProjectId.eq(project_id))
            .filter(ai_usage::Column::CreatedAt.gte(iso(&since)));
        if let Some(until) = until {
            calls = calls.filter(ai_usage::Column::CreatedAt.lt(iso(&until)));
        }
        return Ok(runs + float_sum(session, calls, sum_or_zero(ai_usage::Column::Cost, 0.0)).await?);
    };
    // The agent's own one-shot calls (Board AI answers, schedule reviews, dry runs) spend its budget too
    let mut calls = ai_usage::Entity::find()
        .filter(ai_usage::Column::Metered.eq(true))
        .filter(ai_usage::Column::MemberId.is_in([member_id]))
        .filter(ai_usage::Column::CreatedAt.gte(iso(&since)));
    if let Some(until) = until {
        calls = calls.filter(ai_usage::Column::CreatedAt.lt(iso(&until)));
    }
    Ok(runs + float_sum(session, calls, sum_or_zero(ai_usage::Column::Cost, 0.0)).await?)
}

/// True once a run (or one-shot call) of the project has reported a real cost. Users are on a subscription (quota, not
/// money), so the money caps of the project settings are shown only after this (owner decision C-12).
pub async fn reports_cost(session: &Session, project_id: &str) -> Result<bool, DbErr> {
    let run = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Metered.eq(true))
        .filter(ai_run::Column::CostUsd.gt(0.0))
        .limit(1)
        .one(session)
        .await?;
    if run.is_some() {
        return Ok(true);
    }
    let call = ai_usage::Entity::find()
        .filter(ai_usage::Column::ProjectId.eq(project_id))
        .filter(ai_usage::Column::Metered.eq(true))
        .filter(ai_usage::Column::Cost.gt(0.0))
        .limit(1)
        .one(session)
        .await?;
    Ok(call.is_some())
}

/// Tokens (in + out) of metered runs since `since`.
pub async fn tokens_since(
    session: &Session,
    since: DateTime<Utc>,
    member_id: Option<&str>,
    project_id: Option<&str>,
) -> Result<i64, DbErr> {
    let mut stmt = ai_run::Entity::find()
        .filter(ai_run::Column::Metered.eq(true))
        .filter(ai_run::Column::StartedAt.gte(iso(&since)));
    if let Some(member_id) = member_id.filter(|m| !m.is_empty()) {
        stmt = stmt.filter(ai_run::Column::MemberId.eq(member_id));
    }
    if let Some(project_id) = project_id.filter(|p| !p.is_empty()) {
        stmt = stmt.filter(ai_run::Column::ProjectId.eq(project_id));
    }
    let tokens: Expr = Expr::col(ai_run::Column::TokensIn).add(Expr::col(ai_run::Column::TokensOut));
    let total: Expr = Func::sum(tokens).into();
    let sum = Func::coalesce([total, Expr::val(0)]);
    let value: Option<i64> =
        stmt.select_only().expr_as(sum, "total").into_tuple::<Option<i64>>().one(session).await?.flatten();
    Ok(value.unwrap_or(0))
}

/// `schedule` for a run a schedule starts, else `person`.
pub fn run_kind(run: &ai_run::Model) -> &'static str {
    if run.trigger == "schedule" { "schedule" } else { "person" }
}

/// Automatic runs the agent (or the whole project) started today. `kinds` picks which: `schedule` and `ai` (the
/// default `["schedule", "ai"]`); runs a person starts are not counted.
pub async fn runs_today(
    session: &Session,
    member_id: Option<&str>,
    project_id: Option<&str>,
    kinds: &[&str],
) -> Result<i64, DbErr> {
    runs_today_since(session, today_start(), member_id, project_id, kinds).await
}

/// `runs_today` with the start of the day given.
pub async fn runs_today_since(
    session: &Session,
    start: DateTime<Utc>,
    member_id: Option<&str>,
    project_id: Option<&str>,
    kinds: &[&str],
) -> Result<i64, DbErr> {
    let mut stmt = ai_run::Entity::find().filter(ai_run::Column::StartedAt.gte(iso(&start)));
    let scheduled = ai_run::Column::Trigger.eq("schedule");
    // a run another AI, a Docs page or GitHub started: nobody sat there either
    let chained = ai_run::Column::Trigger.is_in(["message", "ai_message", "docs_threads", "ci_red", "review_comments"]);
    stmt = if kinds == ["schedule"] {
        stmt.filter(scheduled)
    } else {
        stmt.filter(Condition::any().add(scheduled).add(chained))
    };
    if let Some(member_id) = member_id.filter(|m| !m.is_empty()) {
        stmt = stmt.filter(ai_run::Column::MemberId.eq(member_id));
    }
    if let Some(project_id) = project_id.filter(|p| !p.is_empty()) {
        stmt = stmt.filter(ai_run::Column::ProjectId.eq(project_id));
    }
    let count = kb_db::sea_orm::PaginatorTrait::count(stmt, session).await?;
    Ok(count as i64)
}

fn hit(label: &str, reason: String, scope: &str, kind: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("label".into(), json!(label));
    out.insert("reason".into(), json!(reason));
    out.insert("scope".into(), json!(scope));
    out.insert("kind".into(), json!(kind));
    out
}

/// Why a limit stops new runs of this team: `{label, reason, scope: agent | board, kind}`, or None. AI v2 has no money
/// budgets or caps (a team runs on a signed-in CLI): only the scheduled runs per day of a team (`kind` "runs") can stop
/// a run. They stop automatic runs only: pass the `run_kind` of the run that wants to start (`schedule`, `ai` or
/// `person`).
pub async fn blocked_detail(
    session: &Session,
    profile: &ai_team::Model,
    settings: &ai_project_settings::Model,
    run_kind: Option<&str>,
) -> Result<Option<Map<String, Value>>, DbErr> {
    let board_runs = settings.board_runs_per_day;
    // The board's runs per day protects what is billed by the call. A member on a person's own CLI is not held to it:
    // a team of them handing work to each other would otherwise stop at the cap with only "waiting" to show for it.
    if let Some(board_runs) = board_runs.filter(|b| *b != 0) {
        if matches!(run_kind, Some("schedule" | "ai")) && profile.connection != "local" {
            let n = runs_today(session, None, Some(&profile.project_id), &["schedule", "ai"]).await?;
            if n >= i64::from(board_runs) {
                return Ok(Some(hit(
                    "Runs per day used up",
                    format!(
                        "Board scheduled and AI-started runs per day used up ({n} of {board_runs}); resets at 00:00"
                    ),
                    "board",
                    "runs",
                )));
            }
        }
    }
    if profile.connection == "local" {
        if let Some(max) = profile.max_runs_per_day.filter(|m| *m != 0) {
            if run_kind == Some("schedule") {
                let n = runs_today(session, Some(&profile.id), None, &["schedule"]).await?;
                if n >= i64::from(max) {
                    return Ok(Some(hit(
                        "Runs per day used up",
                        format!("Scheduled runs per day used up ({n} of {max}); resets at 00:00"),
                        "agent",
                        "runs",
                    )));
                }
            }
        }
        return Ok(None);
    }
    Ok(None)
}

/// (label, reason) when a budget or limit stops new runs of this agent, else None.
pub async fn blocked(
    session: &Session,
    profile: &ai_team::Model,
    settings: &ai_project_settings::Model,
    run_kind: Option<&str>,
) -> Result<Option<(String, String)>, DbErr> {
    let hit = blocked_detail(session, profile, settings, run_kind).await?;
    Ok(hit.map(|h| {
        let get = |k: &str| h.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        (get("label"), get("reason"))
    }))
}
