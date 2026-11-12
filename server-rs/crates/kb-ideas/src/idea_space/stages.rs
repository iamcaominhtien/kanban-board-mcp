//! `services/idea_space.py`, lines 296-487: moving an idea between stages by a person's decision, taking the last
//! move back, and parking several ideas at once.

use chrono::{Datelike, NaiveDate, Utc};
use kb_db::Session;
use kb_db::entities::{idea_advice, idea_ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::{get, get_or_raise, json_or, legacy_status_for_stage, now, save};
use crate::error::{Error, rule_error, rule_error_with, value_error};
use crate::idea_tickets::{DEFAULT_AUTHOR, add_trail};
use crate::model::{ARCHIVE_REASONS, IDEA_STAGES, Idea, idea_readiness, save_model};

/// Where an idea may move from each stage (`_MOVES`).
fn moves(from: &str) -> &'static [&'static str] {
    match from {
        "inbox" => &["exploring", "parked", "archived"],
        "exploring" => &["ready", "parked", "archived"],
        "ready" => &["exploring", "parked", "archived"],
        "parked" => &["inbox", "exploring", "ready", "archived"],
        "shipped" => &["exploring", "archived"],
        "archived" => &["inbox", "exploring"],
        _ => &[],
    }
}

/// `_snapshot(idea)` as a dict: the fields a stage move changes, so the move can be undone.
pub(crate) fn snapshot(idea: &idea_ticket::Model) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("stage".into(), json!(idea.stage));
    out.insert("idea_status".into(), json!(idea.idea_status));
    out.insert("park_until".into(), json!(idea.park_until));
    out.insert("park_note".into(), json!(idea.park_note));
    out.insert("archive_reason".into(), json!(idea.archive_reason));
    out.insert("archive_note".into(), json!(idea.archive_note));
    out.insert("stage_changed_at".into(), json!(idea.stage_changed_at));
    out.insert("after".into(), Value::Null);
    out
}

/// `date.fromisoformat(text)` of Python 3.12: `YYYY-MM-DD`, `YYYYMMDD`, and the ISO week forms `YYYY-Www-D`,
/// `YYYYWwwD`, `YYYY-Www` and `YYYYWww`. None where Python raises `ValueError`.
pub(crate) fn date_from_iso(text: &str) -> Option<NaiveDate> {
    let c: Vec<char> = text.chars().collect();
    let digits = |from: usize, to: usize| -> Option<u32> {
        let part = c.get(from..to)?;
        if part.iter().all(char::is_ascii_digit) { part.iter().collect::<String>().parse().ok() } else { None }
    };
    let ymd = |y: u32, m: u32, d: u32| NaiveDate::from_ymd_opt(i32::try_from(y).ok()?, m, d).filter(|d| d.year() >= 1);
    let week = |y: u32, w: u32, d: u32| {
        if w == 0 || w > 53 || d == 0 || d > 7 {
            return None;
        }
        let weekday = chrono::Weekday::try_from(u8::try_from(d - 1).ok()?).ok()?;
        NaiveDate::from_isoywd_opt(i32::try_from(y).ok()?, w, weekday).filter(|d| d.year() >= 1)
    };
    match (c.len(), c.get(4), c.get(5)) {
        (10, Some('-'), Some('W')) if c.get(8) == Some(&'-') => week(digits(0, 4)?, digits(6, 8)?, digits(9, 10)?),
        (10, Some('-'), _) if c.get(7) == Some(&'-') => ymd(digits(0, 4)?, digits(5, 7)?, digits(8, 10)?),
        (8, Some('W'), _) => week(digits(0, 4)?, digits(5, 7)?, digits(7, 8)?),
        (8, Some('-'), Some('W')) => week(digits(0, 4)?, digits(6, 8)?, 1),
        (8, _, _) => ymd(digits(0, 4)?, digits(4, 6)?, digits(6, 8)?),
        (7, Some('W'), _) => week(digits(0, 4)?, digits(5, 7)?, 1),
        _ => None,
    }
}

/// `_parse_date(value)`: the date to come back on, as `YYYY-MM-DD`.
fn parse_date(value: Option<&str>) -> Result<String, Error> {
    let stripped = kb_base::pytext::strip(value.unwrap_or(""));
    let head: String = stripped.chars().take(10).collect();
    let Some(parsed) = date_from_iso(&head) else {
        return rule_error("park_needs_date", "Parking needs a date (YYYY-MM-DD)");
    };
    if parsed < Utc::now().date_naive() {
        return rule_error("park_date_past", "The date to come back on is in the past");
    }
    Ok(parsed.format("%Y-%m-%d").to_string())
}

/// What an Inbox idea's open AI advice says to do, for each stage the idea may be moved to (`_ADVICE_FOR_STAGE`).
fn advice_for_stage(stage: &str) -> Option<&'static str> {
    match stage {
        "exploring" => Some("keep"),
        "parked" => Some("park"),
        "archived" => Some("archive"),
        _ => None,
    }
}

/// `_close_advice`: the idea left the Inbox: its open AI advice is accepted when the person did what it said,
/// ignored if not.
pub(crate) async fn close_advice(session: &Session, idea_id: &str, action: Option<&str>) -> Result<(), Error> {
    let rows = idea_advice::Entity::find()
        .filter(idea_advice::Column::IdeaId.eq(idea_id))
        .filter(idea_advice::Column::State.eq("open"))
        .all(session)
        .await?;
    for advice in &rows {
        let mut changed = advice.clone();
        changed.state = if Some(advice.action.as_str()) == action { "accepted" } else { "ignored" }.to_string();
        save_model(session, advice, changed).await?;
    }
    if !rows.is_empty() {
        session.commit().await?;
    }
    Ok(())
}

/// The arguments of `move_stage` after the session, the idea and the stage, with the Python defaults.
#[derive(Debug, Clone)]
pub struct MoveStage<'a> {
    /// Who decided.
    pub author: Option<&'a str>,
    /// Date (YYYY-MM-DD) the idea returns to the Inbox; required for Parked.
    pub park_until: Option<&'a str>,
    /// Why it was parked.
    pub park_note: Option<&'a str>,
    /// One of `ARCHIVE_REASONS`; required for Archived.
    pub archive_reason: Option<&'a str>,
    /// An optional note others see when they search.
    pub archive_note: Option<&'a str>,
    /// Move to Ready although the readiness checks are not met.
    pub force: bool,
    /// A short label recorded in the activity ("Keep", "Triage", "Drag").
    pub via: Option<&'a str>,
}

impl Default for MoveStage<'_> {
    fn default() -> Self {
        Self {
            author: Some(DEFAULT_AUTHOR),
            park_until: None,
            park_note: None,
            archive_reason: None,
            archive_note: None,
            force: false,
            via: None,
        }
    }
}

/// Move an idea to another stage by a person's decision (Keep, Park, Archive, Restore, drag).
///
/// `to_stage`: Building and Shipped are never reached this way: Promote and the ticket do that. Fails with
/// `IdeaRuleError` (code building_locked, not_allowed, not_ready, park_needs_date, park_date_past,
/// archive_needs_reason or use_promote) and with `ValueError` if the idea or stage does not exist.
pub async fn move_stage(session: &Session, idea_id: &str, to_stage: &str, args: &MoveStage<'_>) -> Result<Idea, Error> {
    if !IDEA_STAGES.contains(&to_stage) {
        return value_error(format!("Unknown stage '{to_stage}'"));
    }
    let mut idea = get_or_raise(session, idea_id).await?;
    if idea.row.stage == to_stage {
        return Ok(idea);
    }
    if idea.row.stage == "building" {
        return rule_error(
            "building_locked",
            "Not allowed while the ticket is open. Close or remove the ticket first.",
        );
    }
    if to_stage == "building" {
        return rule_error("use_promote", "Promote the idea to make it Building");
    }
    if !moves(&idea.row.stage).contains(&to_stage) {
        return rule_error("not_allowed", format!("An idea cannot move from {} to {to_stage}", idea.row.stage));
    }

    let readiness = idea_readiness(idea.assumptions());
    let ready = readiness["state"] == "ready";
    if to_stage == "ready" && !ready && !args.force {
        let mut extra = Map::new();
        extra.insert("readiness".into(), Value::Object(readiness));
        return rule_error_with("not_ready", "Not every high-impact assumption is validated yet", extra);
    }
    let mut until = String::new();
    if to_stage == "parked" {
        until = parse_date(args.park_until)?;
    }
    if to_stage == "archived" {
        if !args.archive_reason.is_some_and(|reason| ARCHIVE_REASONS.contains(&reason)) {
            return rule_error(
                "archive_needs_reason",
                format!("Archiving needs a reason: {}", ARCHIVE_REASONS.join(", ")),
            );
        }
    }

    let now = now();
    let before = idea.row.stage.clone();
    let mut snap = snapshot(&idea.row);
    idea.row.stage = to_stage.to_string();
    idea.row.idea_status = legacy_status_for_stage(to_stage)?.to_string();
    idea.row.stage_changed_at = Some(now.clone());
    idea.row.park_until = (to_stage == "parked").then_some(until);
    idea.row.park_note =
        if to_stage == "parked" { args.park_note.filter(|n| !n.is_empty()).map(str::to_string) } else { None };
    idea.row.archive_reason = if to_stage == "archived" { args.archive_reason.map(str::to_string) } else { None };
    idea.row.archive_note =
        if to_stage == "archived" { args.archive_note.filter(|n| !n.is_empty()).map(str::to_string) } else { None };
    snap.insert("after".into(), json!(now));
    idea.row.prev_state = super::dumps_map(&snap);

    let mut label = format!("Stage: {before} → {to_stage}");
    if to_stage == "parked" {
        label.push_str(&format!(" until {}", idea.row.park_until.as_deref().unwrap_or("None")));
    }
    if to_stage == "archived" {
        label.push_str(&format!(" ({})", args.archive_reason.unwrap_or("").replace('_', " ")));
    }
    if to_stage == "ready" && !ready {
        label.push_str(" without the checks");
    }
    let mut meta = Map::new();
    meta.insert("from".into(), json!(before));
    meta.insert("to".into(), json!(to_stage));
    if let Some(via) = args.via.filter(|v| !v.is_empty()) {
        meta.insert("via".into(), json!(via));
    }
    add_trail(&mut idea.row, &label, &now, args.author, Some("stage"), Some(meta), false);
    let saved = save(session, &mut idea).await?;
    if before == "inbox" {
        close_advice(session, idea_id, advice_for_stage(to_stage)).await?;
    }
    Ok(saved)
}

/// Take back the last stage move (the Z key in triage).
///
/// Fails with `IdeaRuleError`: `nothing_to_undo` when there is no move to take back, or `building_locked`.
pub async fn undo_last_move(session: &Session, idea_id: &str, author: Option<&str>) -> Result<Idea, Error> {
    let mut idea = get_or_raise(session, idea_id).await?;
    let snap = json_or(&idea.row.prev_state, json!({}));
    let snap_stage_changed = get(&snap, "after");
    let stage_changed_at = idea.row.stage_changed_at.as_deref().map_or(Value::Null, |s| json!(s));
    if !kb_base::pyjson::truthy(&snap) || *snap_stage_changed != stage_changed_at {
        return rule_error("nothing_to_undo", "There is no move to undo");
    }
    if idea.row.stage == "building" {
        return rule_error("building_locked", "The idea has been promoted since");
    }
    let now = now();
    let before = idea.row.stage.clone();
    let Some(stage) = snap.get("stage").and_then(Value::as_str) else {
        return Err(Error::Other("KeyError: 'stage'".to_string()));
    };
    idea.row.stage = stage.to_string();
    idea.row.idea_status = match get(&snap, "idea_status").as_str().filter(|s| !s.is_empty()) {
        Some(status) => status.to_string(),
        None => legacy_status_for_stage(&idea.row.stage)?.to_string(),
    };
    let text = |key: &str| get(&snap, key).as_str().map(str::to_string);
    idea.row.park_until = text("park_until");
    idea.row.park_note = text("park_note");
    idea.row.archive_reason = text("archive_reason");
    idea.row.archive_note = text("archive_note");
    idea.row.stage_changed_at = Some(now.clone());
    idea.row.prev_state = "{}".to_string();
    let mut meta = Map::new();
    meta.insert("from".into(), json!(before));
    meta.insert("to".into(), json!(idea.row.stage));
    meta.insert("undo".into(), json!(true));
    let label = format!("Undid the move: {before} → {}", idea.row.stage);
    add_trail(&mut idea.row, &label, &now, author, Some("stage"), Some(meta), false);
    save(session, &mut idea).await
}

/// Park several ideas in one step ("Park all for a month").
pub async fn park_many(
    session: &Session,
    idea_ids: &[String],
    park_until: &str,
    author: Option<&str>,
    park_note: Option<&str>,
) -> Result<Vec<Idea>, Error> {
    let mut out = Vec::new();
    for id in idea_ids {
        let args =
            MoveStage { author, park_until: Some(park_until), park_note, via: Some("Park all"), ..Default::default() };
        out.push(move_stage(session, id, "parked", &args).await?);
    }
    Ok(out)
}
