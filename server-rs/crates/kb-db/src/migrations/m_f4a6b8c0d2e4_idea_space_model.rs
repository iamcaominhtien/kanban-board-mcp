//! `server/alembic/versions/f4a6b8c0d2e4_idea_space_model.py`
//!
//! idea_space_model: stages, assumption records, evidence, votes; existing ideas converted once

use std::path::{Path, PathBuf};

use sea_orm::sqlx::sqlite::SqliteConnectOptions;
use sea_orm::sqlx::{self, ConnectOptions as _, Connection as _};
use sea_orm::{ConnectionTrait, QueryResult, Value};
use serde_json::{Map, Value as Json, json};

use kb_base::{pyjson, pytext, time};

use super::ops::{self, StepResult, Table};
use crate::database::DatabaseError;

const IMPORT_REASON: &str = "Imported from the old Idea Space";

/// `upgrade()` of revision `f4a6b8c0d2e4`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    backup_database(conn).await?;

    // batch_alter_table("idea_ticket"): project_id becomes nullable, which SQLite cannot change in place, so the
    // table is written again with the new columns, as Alembic's batch mode did
    let mut table = Table::reflect(conn, "idea_ticket").await?;
    table.column("project_id")?.not_null = false;
    table.add_column("stage", "VARCHAR", true, Some("'inbox'"));
    table.add_column("park_until", "VARCHAR", false, None);
    table.add_column("archive_reason", "VARCHAR", false, None);
    table.add_column("source", "VARCHAR", true, Some("'manual'"));
    table.add_column("body", "VARCHAR", true, Some("''"));
    table.add_column("details", "VARCHAR", true, Some("''"));
    for name in [
        "created_by",
        "owner",
        "park_note",
        "archive_note",
        "stage_changed_at",
        "merged_into_id",
        "merged_at",
        "shipped_at",
        "outcome",
        "outcome_note",
        "former_ticket_id",
        "effort_guess",
    ] {
        table.add_column(name, "VARCHAR", false, None);
    }
    for name in ["source_ref", "prev_state", "merge_undo"] {
        table.add_column(name, "VARCHAR", true, Some("'{}'"));
    }
    table.add_column("workspace_retention", "VARCHAR", true, Some("'open_then_30'"));
    table.rebuild(conn).await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_ticket_stage ON idea_ticket (stage)").await?;
    ops::exec(conn, r"CREATE TABLE idea_assumption (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	position INTEGER DEFAULT '0' NOT NULL, 
	text VARCHAR NOT NULL, 
	impact VARCHAR DEFAULT 'medium' NOT NULL, 
	status VARCHAR DEFAULT 'untested' NOT NULL, 
	test_ticket_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_assumption_idea_id ON idea_assumption (idea_id)").await?;
    ops::exec(conn, r"CREATE TABLE idea_evidence (
	id VARCHAR NOT NULL, 
	assumption_id VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'link' NOT NULL, 
	title VARCHAR DEFAULT '' NOT NULL, 
	ref VARCHAR DEFAULT '' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(assumption_id) REFERENCES idea_assumption (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_evidence_assumption_id ON idea_evidence (assumption_id)").await?;
    ops::exec(conn, r"CREATE TABLE idea_comment (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	author VARCHAR, 
	body VARCHAR DEFAULT '' NOT NULL, 
	ai BOOLEAN DEFAULT 0 NOT NULL, 
	run_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	edited_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_comment_idea_id ON idea_comment (idea_id)").await?;
    ops::exec(conn, r"CREATE TABLE idea_log_entry (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'note' NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	author VARCHAR, 
	ai BOOLEAN DEFAULT 0 NOT NULL, 
	pinned BOOLEAN DEFAULT 0 NOT NULL, 
	assumption_id VARCHAR, 
	attachments VARCHAR DEFAULT '[]' NOT NULL, 
	ticket_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_log_entry_idea_id ON idea_log_entry (idea_id)").await?;
    ops::exec(conn, r"CREATE TABLE idea_vote (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	voter VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_vote_idea_id ON idea_vote (idea_id)").await?;
    ops::exec(conn, r"CREATE UNIQUE INDEX uq_idea_vote_idea_voter ON idea_vote (idea_id, voter)").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN from_idea_id VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN tests_assumption_id VARCHAR").await?;
    ops::exec(conn, r"CREATE INDEX ix_ticket_from_idea_id ON ticket (from_idea_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ticket_tests_assumption_id ON ticket (tests_assumption_id)").await?;
    convert_ideas(conn).await
}

/// `Path.with_name(f"{source.stem}.before-idea-space-{stamp}.db")`.
fn backup_path(source: &Path, stamp: &str) -> PathBuf {
    let stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    source.with_file_name(format!("{stem}.before-idea-space-{stamp}.db"))
}

/// Copy the database next to itself before the ideas are converted (only when there are ideas).
///
/// A failed copy stops the migration: converting without the safety copy is not worth the risk. The copy is made
/// through a second, read-only connection, so it holds the database as it was before this upgrade began (the
/// upgrade's own changes are not committed yet).
async fn backup_database<C: ConnectionTrait>(conn: &C) -> StepResult {
    let count = match ops::rows(conn, "SELECT COUNT(*) AS n FROM idea_ticket", vec![]).await?.first() {
        Some(row) => row.try_get::<i64>("", "n")?,
        None => 0,
    };
    if count == 0 {
        return Ok(());
    }
    let mut file = None;
    for row in ops::rows(conn, "PRAGMA database_list", vec![]).await? {
        let name: String = row.try_get("", "name")?;
        let path: Option<String> = row.try_get("", "file")?;
        if name == "main" {
            if let Some(path) = path.filter(|p| !p.is_empty()) {
                file = Some(path);
                break;
            }
        }
    }
    // an in-memory database has nothing to copy
    let Some(file) = file else { return Ok(()) };
    let source = PathBuf::from(file);
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let target = backup_path(&source, &stamp);
    let failed = |err: &dyn std::fmt::Display| {
        DatabaseError::Other(format!("Could not back up the database to {} before converting the ideas: {err}", target.display()))
    };
    // the copy replaces a file of the same name (Python's backup wrote over it)
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| failed(&e))?;
    }
    let options = SqliteConnectOptions::new().filename(&source).read_only(true).disable_statement_logging();
    let mut reader = sqlx::SqliteConnection::connect_with(&options).await.map_err(|e| failed(&e))?;
    let copied = sqlx::query("VACUUM INTO ?").bind(target.to_string_lossy().into_owned()).execute(&mut reader).await;
    let _ = reader.close().await;
    copied.map_err(|e| failed(&e))?;
    tracing::info!("Backed up {count} ideas to {} before converting them", target.display());
    Ok(())
}

/// `_loads`: the list in a JSON column, empty when it is missing, unreadable or not a list.
fn loads(value: Option<&str>) -> Vec<Json> {
    match value.filter(|v| !v.is_empty()).and_then(pyjson::loads) {
        Some(Json::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn text(row: &QueryResult, column: &str) -> Result<Option<String>, sea_orm::DbErr> {
    row.try_get::<Option<String>>("", column)
}

/// A value read from JSON, given to a statement the way Python's SQLite driver took it. Lists and objects cannot be
/// bound: Python's migration stopped there, and so does this one.
fn bind(value: &Json, what: &str) -> Result<Value, DatabaseError> {
    match value {
        Json::Null => Ok(Value::String(None)),
        Json::Bool(b) => Ok(i64::from(*b).into()),
        Json::String(s) => Ok(s.clone().into()),
        Json::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => Ok(i.into()),
            (None, Some(f)) if n.is_f64() => Ok(f.into()),
            _ => Err(DatabaseError::Other(format!("{what}: the number {n} is too large for SQLite"))),
        },
        Json::Array(_) | Json::Object(_) => {
            Err(DatabaseError::Other(format!("{what}: a list or an object cannot be stored as a value")))
        }
    }
}

/// `entry.get(key) or fallback`, as a statement value.
fn bind_or(entry: &Map<String, Json>, key: &str, fallback: Value, what: &str) -> Result<Value, DatabaseError> {
    match entry.get(key) {
        Some(value) if pyjson::truthy(value) => bind(value, what),
        _ => Ok(fallback),
    }
}

/// `str(entry.get("text", "")).strip()`.
fn entry_text(entry: &Map<String, Json>) -> String {
    match entry.get("text") {
        Some(value) => pytext::strip(&pyjson::py_str(value)).to_string(),
        None => String::new(),
    }
}

/// What the stage of an old idea depends on.
struct Old<'a> {
    status: Option<&'a str>,
    promoted_to: Option<&'a str>,
    trail_len: usize,
    has_microthoughts: bool,
    has_assumptions: bool,
}

/// The stage an old idea becomes (design: idea-promote-migration.md, "What happens to existing ideas").
fn stage_of(old: &Old<'_>, ticket_status: Option<&str>, has_ticket: bool) -> &'static str {
    match old.status {
        Some("dropped") => "archived",
        Some("approved") => {
            if old.promoted_to.is_none_or(str::is_empty) {
                return "ready";
            }
            // its ticket is gone: the idea is ready to be promoted again
            if !has_ticket {
                return "ready";
            }
            match ticket_status {
                Some("done") => "shipped",
                Some("wont_do") => "exploring",
                _ => "building",
            }
        }
        Some("draft") => {
            let untouched = old.trail_len <= 1 && !old.has_microthoughts && !old.has_assumptions;
            if untouched { "inbox" } else { "exploring" }
        }
        // in_review, and anything unknown
        _ => "exploring",
    }
}

fn body_of(problem_statement: Option<&str>, description: Option<&str>) -> String {
    let problem = pytext::strip(problem_statement.unwrap_or(""));
    let description = pytext::strip(description.unwrap_or(""));
    let mut parts = Vec::new();
    if !problem.is_empty() {
        parts.push(format!("## Problem\n\n{problem}"));
    }
    if !description.is_empty() {
        parts.push(description.to_string());
    }
    parts.join("\n\n")
}

fn details_of(energy: Option<&str>, scores: (i64, i64, i64)) -> String {
    let mut lines = Vec::new();
    if let Some(energy) = energy.filter(|e| !e.is_empty()) {
        lines.push(format!("Energy: {energy}"));
    }
    if scores != (3, 3, 3) {
        lines.push(format!("ICE: impact {}, effort {}, confidence {}", scores.0, scores.1, scores.2));
    }
    lines.join("\n")
}

/// `_ASSUMPTION_STATUS.get(a.get("status"), "untested")`.
fn assumption_status(value: Option<&Json>) -> Result<&'static str, DatabaseError> {
    match value {
        Some(Json::String(s)) => Ok(match s.as_str() {
            "validated" => "validated",
            "invalidated" => "disproved",
            _ => "untested",
        }),
        // Python cannot look a list or an object up in a dict (unhashable): its migration stopped here
        Some(Json::Array(_) | Json::Object(_)) => {
            Err(DatabaseError::Other("An assumption's status is a list or an object, not a text.".to_string()))
        }
        _ => Ok("untested"),
    }
}

/// Convert every existing idea once: stage, page body, details and assumption records.
async fn convert_ideas<C: ConnectionTrait>(conn: &C) -> StepResult {
    let now = time::now_iso();
    let ideas = ops::rows(conn, "SELECT * FROM idea_ticket", vec![]).await?;
    for row in ideas {
        let id = text(&row, "id")?;
        let status = text(&row, "idea_status")?;
        let original_promoted_to = text(&row, "promoted_to_ticket_id")?;
        let created_at = text(&row, "created_at")?;
        let updated_at = text(&row, "updated_at")?;
        let mut trail = loads(text(&row, "activity_trail")?.as_deref());
        let microthoughts = loads(text(&row, "microthoughts")?.as_deref());
        let assumptions = loads(text(&row, "assumptions")?.as_deref());

        let mut ticket_status: Option<String> = None;
        let mut has_ticket = false;
        if let Some(ticket_id) = original_promoted_to.as_deref().filter(|t| !t.is_empty()) {
            let found = ops::rows(conn, "SELECT status FROM ticket WHERE id = ?", vec![ticket_id.into()]).await?;
            if let Some(found) = found.first() {
                has_ticket = true;
                ticket_status = found.try_get::<Option<String>>("", "status")?;
            }
        }
        let old = Old {
            status: status.as_deref(),
            promoted_to: original_promoted_to.as_deref(),
            trail_len: trail.len(),
            has_microthoughts: !microthoughts.is_empty(),
            has_assumptions: !assumptions.is_empty(),
        };
        let mut stage = stage_of(&old, ticket_status.as_deref(), has_ticket);
        let revisit = text(&row, "revisit_date")?;
        let revisit = pytext::strip(revisit.as_deref().unwrap_or(""));
        let mut park_until: Option<String> = None;
        if !revisit.is_empty() && matches!(stage, "inbox" | "exploring" | "ready") {
            stage = "parked";
            park_until = Some(revisit.to_string());
        }
        let mut promoted_to = original_promoted_to.clone();
        let mut promoted_at = text(&row, "promoted_at")?;
        let promoted = promoted_to.as_deref().is_some_and(|p| !p.is_empty());
        let mut note = format!("Converted to the new Idea Space (stage: {stage})");
        if status.as_deref() == Some("approved") && promoted && !has_ticket {
            promoted_to = None;
            promoted_at = None;
            note.push_str(&format!(
                "; {} no longer exists, the link was cleared",
                original_promoted_to.as_deref().unwrap_or("")
            ));
        } else if stage == "exploring" && ticket_status.as_deref() == Some("wont_do") {
            note.push_str(&format!("; {} was dropped", promoted_to.as_deref().unwrap_or("None")));
        }
        trail.push(json!({"id": time::uuid4(), "label": note, "at": now, "author": "system"}));

        let problem_statement = text(&row, "problem_statement")?;
        let description = text(&row, "description")?;
        let energy = text(&row, "idea_energy")?;
        let scores = (
            row.try_get::<i64>("", "ice_impact")?,
            row.try_get::<i64>("", "ice_effort")?,
            row.try_get::<i64>("", "ice_confidence")?,
        );
        let changed_at = updated_at.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| now.clone());
        ops::exec_with(
            conn,
            "UPDATE idea_ticket SET stage = ?, park_until = ?, \
             archive_reason = ?, source = 'import', body = ?, \
             details = ?, promoted_to_ticket_id = ?, \
             promoted_at = ?, activity_trail = ?, \
             stage_changed_at = ? WHERE id = ?",
            vec![
                stage.into(),
                park_until.into(),
                (stage == "archived").then_some(IMPORT_REASON).into(),
                body_of(problem_statement.as_deref(), description.as_deref()).into(),
                details_of(energy.as_deref(), scores).into(),
                promoted_to.clone().into(),
                promoted_at.into(),
                pyjson::dumps(&trail).into(),
                changed_at.into(),
                id.clone().into(),
            ],
        )
        .await?;
        if matches!(stage, "building" | "shipped") {
            if let Some(ticket_id) = promoted_to.filter(|p| !p.is_empty()) {
                ops::exec_with(
                    conn,
                    "UPDATE ticket SET from_idea_id = ? WHERE id = ?",
                    vec![id.clone().into(), ticket_id.into()],
                )
                .await?;
            }
        }
        for thought in &microthoughts {
            let Some(thought) = thought.as_object() else { continue };
            let body = entry_text(thought);
            if body.is_empty() {
                continue;
            }
            ops::exec_with(
                conn,
                "INSERT INTO idea_comment (id, idea_id, author, body, ai, created_at) \
                 VALUES (?, ?, NULL, ?, 0, ?)",
                vec![
                    bind_or(thought, "id", time::uuid4().into(), "A quick thought's id")?,
                    id.clone().into(),
                    body.into(),
                    bind_or(thought, "at", created_at.clone().into(), "A quick thought's time")?,
                ],
            )
            .await?;
        }
        for (position, assumption) in assumptions.iter().enumerate() {
            let Some(assumption) = assumption.as_object() else { continue };
            let body = entry_text(assumption);
            if body.is_empty() {
                continue;
            }
            let stamp = bind_or(assumption, "at", created_at.clone().into(), "An assumption's time")?;
            ops::exec_with(
                conn,
                "INSERT INTO idea_assumption (id, idea_id, position, text, impact, \
                 status, test_ticket_id, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, 'medium', ?, NULL, ?, ?)",
                vec![
                    bind_or(assumption, "id", time::uuid4().into(), "An assumption's id")?,
                    id.clone().into(),
                    (position as i64).into(),
                    body.into(),
                    assumption_status(assumption.get("status"))?.into(),
                    stamp.clone(),
                    stamp,
                ],
            )
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backup_sits_next_to_the_database() {
        assert_eq!(
            backup_path(Path::new("/data/kanban.db"), "20260102-030405"),
            Path::new("/data/kanban.before-idea-space-20260102-030405.db")
        );
        assert_eq!(backup_path(Path::new("/data/board"), "s"), Path::new("/data/board.before-idea-space-s.db"));
    }

    #[test]
    fn an_old_idea_gets_the_stage_the_design_gives_it() {
        let old = |status, promoted_to, trail_len| Old {
            status,
            promoted_to,
            trail_len,
            has_microthoughts: false,
            has_assumptions: false,
        };
        assert_eq!(stage_of(&old(Some("dropped"), None, 0), None, false), "archived");
        assert_eq!(stage_of(&old(Some("approved"), None, 0), None, false), "ready");
        assert_eq!(stage_of(&old(Some("approved"), Some("T-1"), 0), None, false), "ready");
        assert_eq!(stage_of(&old(Some("approved"), Some("T-1"), 0), Some("done"), true), "shipped");
        assert_eq!(stage_of(&old(Some("approved"), Some("T-1"), 0), Some("wont_do"), true), "exploring");
        assert_eq!(stage_of(&old(Some("approved"), Some("T-1"), 0), Some("todo"), true), "building");
        assert_eq!(stage_of(&old(Some("draft"), None, 1), None, false), "inbox");
        assert_eq!(stage_of(&old(Some("draft"), None, 2), None, false), "exploring");
        assert_eq!(stage_of(&old(Some("in_review"), None, 0), None, false), "exploring");
        assert_eq!(stage_of(&old(None, None, 0), None, false), "exploring");
        assert_eq!(body_of(Some(" why "), Some(" what ")), "## Problem\n\nwhy\n\nwhat");
        assert_eq!(details_of(Some("high"), (3, 4, 3)), "Energy: high\nICE: impact 3, effort 4, confidence 3");
        assert_eq!(details_of(None, (3, 3, 3)), "");
    }
}
