//! `services/idea_space.py`, lines 635-783: merging an idea into another, undoing a merge, and votes.

use chrono::Duration;
use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::idea_vote;
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, ModelTrait};
use kb_doctext::pystr::rstrip;
use serde_json::{Map, Value, json};

use super::stages::{close_advice, snapshot};
use super::{get, get_or_raise, json_or, legacy_status_for_stage, now, save};
use crate::error::{Error, rule_error, value_error};
use crate::idea_tickets::{add_trail, reload};
use crate::model::Idea;

/// How long a merge can be undone (`MERGE_UNDO_MINUTES`).
pub const MERGE_UNDO_MINUTES: i64 = 10;

/// Merge an idea into another: its text and source are added to the target, the votes carry over, and the source is
/// archived as merged. The merge can be undone for `MERGE_UNDO_MINUTES`. Returns the target idea.
///
/// Fails with `IdeaRuleError`: `merge_self`, `not_allowed` (either idea is Building, Shipped or Archived).
pub async fn merge(session: &Session, source_id: &str, target_id: &str, author: Option<&str>) -> Result<Idea, Error> {
    if source_id == target_id {
        return rule_error("merge_self", "An idea cannot be merged into itself");
    }
    let mut source = get_or_raise(session, source_id).await?;
    let mut target = get_or_raise(session, target_id).await?;
    for idea in [&source, &target] {
        if !super::OPEN_STAGES.contains(&idea.row.stage.as_str()) {
            return rule_error("not_allowed", format!("{} is {} and cannot be merged", idea.row.id, idea.row.stage));
        }
    }
    let now = now();
    let existing: Vec<&str> = target.vote_records.iter().map(|v| v.voter.as_str()).collect();
    let mut added: Vec<String> =
        source.vote_records.iter().filter(|v| !existing.contains(&v.voter.as_str())).map(|v| v.voter.clone()).collect();
    if let Some(author) = author.filter(|a| !a.is_empty()) {
        if !existing.contains(&author) && !added.iter().any(|a| a == author) {
            added.push(author.to_string());
        }
    }
    let source_snapshot = snapshot(&source.row);
    let mut undo = Map::new();
    undo.insert("source".into(), json!(source.row.id));
    undo.insert("source_snapshot".into(), Value::Object(source_snapshot.clone()));
    undo.insert("target_body".into(), json!(target.row.body));
    undo.insert("votes".into(), json!(added));
    undo.insert("at".into(), json!(now));
    let text = if source.row.body.is_empty() { &source.row.description } else { &source.row.body };
    let mut piece =
        rstrip(&format!("\n\n---\n**Merged from {}: {}**\n\n{}", source.row.id, source.row.title, text)).to_string();
    if !source.row.source_ref.is_empty() && source.row.source_ref != "{}" {
        let reference = json_or(&source.row.source_ref, json!({}));
        let quote = get(&reference, "quote");
        if pyjson::truthy(quote) {
            piece.push_str(&format!("\n\n> {}", pyjson::py_str(quote)));
        }
    }
    target.row.body = pytext::strip(&format!("{}{piece}", target.row.body)).to_string();
    for voter in &added {
        let mut vote = idea_vote::new();
        vote.idea_id = Set(target.row.id.clone());
        vote.voter = Set(voter.clone());
        vote.created_at = Set(now.clone());
        vote.insert(session).await?;
    }
    target.row.merge_undo = super::dumps_map(&undo);
    let label = format!("Merged {} “{}” into this idea", source.row.id, source.row.title);
    let mut meta = Map::new();
    meta.insert("source".into(), json!(source.row.id));
    add_trail(&mut target.row, &label, &now, author, Some("merge"), Some(meta), false);
    save(session, &mut target).await?;

    source.row.stage = "archived".to_string();
    source.row.idea_status = "dropped".to_string();
    source.row.stage_changed_at = Some(now.clone());
    source.row.archive_reason = Some("already_exists".to_string());
    source.row.archive_note = Some(format!("Merged into {}", target.row.id));
    source.row.merged_into_id = Some(target.row.id.clone());
    source.row.merged_at = Some(now.clone());
    source.row.park_until = None;
    let label = format!("Merged into {} “{}”", target.row.id, target.row.title);
    let mut meta = Map::new();
    meta.insert("target".into(), json!(target.row.id));
    meta.insert("from".into(), source_snapshot["stage"].clone());
    add_trail(&mut source.row, &label, &now, author, Some("merge"), Some(meta), false);
    save(session, &mut source).await?;
    close_advice(session, &source.row.id, Some("merge")).await?;
    reload(session, &target.row.id).await
}

/// Undo the last merge into `target_id`, within `MERGE_UNDO_MINUTES` of it.
///
/// Fails with `IdeaRuleError`: `nothing_to_undo` or `undo_expired`.
pub async fn undo_merge(session: &Session, target_id: &str, author: Option<&str>) -> Result<Idea, Error> {
    let mut target = get_or_raise(session, target_id).await?;
    let undo = json_or(&target.row.merge_undo, json!({}));
    if !pyjson::truthy(&undo) {
        return rule_error("nothing_to_undo", "There is no merge to undo");
    }
    let Some(at_text) = get(&undo, "at").as_str() else {
        return Err(Error::Other("KeyError: 'at'".to_string()));
    };
    let Some(parsed) = time::parse_iso(at_text) else {
        return value_error(format!("Invalid isoformat string: {}", pytext::repr(at_text)));
    };
    let time::Parsed::Aware(at) = parsed else {
        return Err(Error::Other("can't subtract offset-naive and offset-aware datetimes".to_string()));
    };
    if chrono::Utc::now() - at.with_timezone(&chrono::Utc) > Duration::minutes(MERGE_UNDO_MINUTES) {
        return rule_error(
            "undo_expired",
            format!("A merge can be undone for {MERGE_UNDO_MINUTES} minutes; after that, split it by hand"),
        );
    }
    let now = now();
    let key = |name: &str| -> Result<&Value, Error> {
        undo.get(name).ok_or_else(|| Error::Other(format!("KeyError: '{name}'")))
    };
    target.row.body = key("target_body")?.as_str().unwrap_or("").to_string();
    let voters: Vec<&str> =
        key("votes")?.as_array().map(|v| v.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    for vote in target.vote_records.clone() {
        if voters.contains(&vote.voter.as_str()) {
            vote.delete(session).await?;
        }
    }
    target.row.merge_undo = "{}".to_string();
    let source_id = key("source")?.as_str().unwrap_or("").to_string();
    let label = format!("Undid the merge of {source_id}");
    let mut meta = Map::new();
    meta.insert("source".into(), json!(source_id));
    meta.insert("undo".into(), json!(true));
    add_trail(&mut target.row, &label, &now, author, Some("merge"), Some(meta), false);
    save(session, &mut target).await?;

    let mut source = get_or_raise(session, &source_id).await?;
    let snap = key("source_snapshot")?;
    let Some(stage) = get(snap, "stage").as_str() else {
        return Err(Error::Other("KeyError: 'stage'".to_string()));
    };
    source.row.stage = stage.to_string();
    source.row.idea_status = match get(snap, "idea_status").as_str().filter(|s| !s.is_empty()) {
        Some(status) => status.to_string(),
        None => legacy_status_for_stage(stage)?.to_string(),
    };
    let text = |name: &str| get(snap, name).as_str().map(str::to_string);
    source.row.park_until = text("park_until");
    source.row.archive_reason = text("archive_reason");
    source.row.archive_note = text("archive_note");
    source.row.merged_into_id = None;
    source.row.merged_at = None;
    source.row.stage_changed_at = Some(now.clone());
    let label = format!("Merge into {} undone", target.row.id);
    let mut meta = Map::new();
    meta.insert("target".into(), json!(target.row.id));
    meta.insert("undo".into(), json!(true));
    add_trail(&mut source.row, &label, &now, author, Some("merge"), Some(meta), false);
    save(session, &mut source).await?;
    reload(session, &target.row.id).await
}

/// Add or remove one person's "I want this" (one per person per idea).
pub async fn vote(session: &Session, idea_id: &str, voter: &str, on: bool) -> Result<Idea, Error> {
    let voter = pytext::strip(voter);
    if voter.is_empty() {
        return value_error("voter cannot be empty");
    }
    let mut idea = get_or_raise(session, idea_id).await?;
    let have = idea.vote_records.iter().find(|v| v.voter == voter).cloned();
    if on && have.is_none() {
        let mut row = idea_vote::new();
        row.idea_id = Set(idea.row.id.clone());
        row.voter = Set(voter.to_string());
        row.insert(session).await?;
        add_trail(&mut idea.row, &format!("{voter} wants this"), &now(), Some(voter), Some("vote"), None, false);
    } else if let (false, Some(have)) = (on, have) {
        have.delete(session).await?;
        add_trail(
            &mut idea.row,
            &format!("{voter} no longer wants this"),
            &now(),
            Some(voter),
            Some("vote"),
            None,
            false,
        );
    } else {
        return Ok(idea);
    }
    save(session, &mut idea).await
}
