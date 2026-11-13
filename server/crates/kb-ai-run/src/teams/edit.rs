//! Making, editing, pausing and removing a team (`services/ai/teams.py`, lines 135 to 395).

use kb_ai::audit;
use kb_ai::providers::{merged_config, providers};
use kb_ai::store::{active_runs, get_profile, loads, now_iso};
use kb_ai_know::roles;
use kb_base::{pyjson, pytext};
use kb_board::tickets::{self, TicketUpdate};
use kb_db::Session;
use kb_db::entities::{ai_team, member, ticket};
use kb_db::save_model;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::{
    AI_COLORS, Error, check_name, checked_account, clean_color, clean_name, float_of, int_of, refuse, text_of, truthy,
    validate,
};
use crate::seams::{self, CancelError};

fn audit_entry(member_id: &str, member_name: &str, by: &str, detail: Value) -> audit::Entry {
    audit::Entry {
        member_id: Some(member_id.to_string()),
        member_name: member_name.to_string(),
        on_behalf_of: Some(by.to_string()),
        detail: detail.as_object().cloned().unwrap_or_default(),
        ..Default::default()
    }
}

/// `data.get(key)` as a whole number that fits the column, None for an absent or null value.
fn opt_int(data: &Map<String, Value>, key: &str) -> Result<Option<i32>, Error> {
    match data.get(key).filter(|v| !v.is_null()) {
        Some(value) => int_column(key, value).map(Some),
        None => Ok(None),
    }
}

fn int_column(key: &str, value: &Value) -> Result<i32, Error> {
    i32::try_from(int_of(value)?).map_err(|_| Error::Other(format!("{key} is out of range for its column")))
}

/// `data.get(key)` as a number, None for an absent or null value.
fn opt_float(data: &Map<String, Value>, key: &str) -> Result<Option<f64>, Error> {
    match data.get(key).filter(|v| !v.is_null()) {
        Some(value) => float_of(value).map(Some),
        None => Ok(None),
    }
}

/// `(data.get(key) or "").strip()`.
fn stripped(data: &Map<String, Value>, key: &str) -> String {
    truthy(data, key).map(|v| pytext::strip(&text_of(v)).to_string()).unwrap_or_default()
}

/// `data.get(key) or None`, as text.
fn opt_text(data: &Map<String, Value>, key: &str) -> Option<String> {
    truthy(data, key).map(text_of)
}

/// `verdict["message"]` of a name that is taken.
fn taken(verdict: &Map<String, Value>) -> Option<String> {
    if verdict.get("ok").is_some_and(pyjson::truthy) {
        return None;
    }
    Some(verdict.get("message").map(text_of).unwrap_or_default())
}

/// Make a team: its Member row and its profile.
///
/// Fails with `Error::Team` for invalid data or a duplicate name.
pub async fn create(
    session: &Session,
    project_id: &str,
    data: &Map<String, Value>,
    by: &str,
) -> Result<member::Model, Error> {
    let name = clean_name(&truthy(data, "name").map(text_of).unwrap_or_default())?;
    let verdict = check_name(session, project_id, &name, None).await?;
    if let Some(message) = taken(&verdict) {
        return refuse(message);
    }
    validate(data)?;
    let account_id = checked_account(session, data.get("account_id")).await?;
    let color = match truthy(data, "color") {
        Some(color) => clean_color(&text_of(color))?,
        None => AI_COLORS[0].to_string(),
    };
    let default_model = providers()
        .get("claude-code")
        .and_then(|spec| spec.get("default_model"))
        .and_then(Value::as_str)
        .unwrap_or("sonnet")
        .to_string();
    let mut profile = ai_team::new();
    profile.project_id = Set(project_id.to_string());
    profile.description = Set(stripped(data, "description").chars().take(200).collect());
    profile.cli_path = Set(opt_text(data, "cli_path"));
    profile.working_dir = Set(Some(stripped(data, "working_dir")).filter(|d| !d.is_empty()));
    profile.account_id = Set(account_id);
    profile.model = Set(Some(opt_text(data, "model").unwrap_or(default_model)));
    profile.effort = Set(opt_text(data, "effort"));
    profile.persona = Set(stripped(data, "persona"));
    profile.pack_key = Set(Some(opt_text(data, "pack_key").unwrap_or_else(|| roles::DEFAULT_TEAM_PACK.to_string())));
    let config = truthy(data, "config").and_then(Value::as_object);
    profile.config = Set(pyjson::dumps(&Value::Object(merged_config(config))));
    profile.permission_mode = Set(opt_text(data, "permission_mode").unwrap_or_else(|| "bypass".to_string()));
    profile.max_parallel = Set(match truthy(data, "max_parallel") {
        Some(value) => int_column("max_parallel", value)?,
        None => 2,
    });
    profile.daily_budget = Set(opt_float(data, "daily_budget")?.map(Into::into));
    profile.monthly_cap = Set(opt_float(data, "monthly_cap")?.map(Into::into));
    profile.max_runs_per_day = Set(opt_int(data, "max_runs_per_day")?);
    profile.tokens_per_day = Set(opt_int(data, "tokens_per_day")?);
    profile.cap_per_run = Set(opt_float(data, "cap_per_run")?.map(Into::into));
    profile.scope = Set(opt_text(data, "scope").unwrap_or_else(|| "assigned".to_string()));
    profile.created_by = Set(Some(by.to_string()));

    let mut row = member::new();
    row.id = Set(kb_base::time::uuid4());
    row.project_id = Set(project_id.to_string());
    row.name = Set(name.clone());
    row.color = Set(color);
    row.role = Set("member".to_string());
    row.kind = Set("ai".to_string());
    let member = row.insert(session).await?;
    profile.id = Set(member.id.clone());
    let profile = profile.insert(session).await?;
    session.commit().await?;
    audit::record(
        project_id,
        "team_created",
        "info",
        audit_entry(&member.id, &name, by, json!({"pack": profile.pack_key, "model": profile.model})),
    )
    .await?;
    Ok(member)
}

/// `_EDITABLE`: the columns of the profile `update` sets from the data as they are.
pub const EDITABLE: [&str; 15] = [
    "description",
    "cli_path",
    "working_dir",
    "model",
    "effort",
    "persona",
    "pack_key",
    "permission_mode",
    "max_parallel",
    "daily_budget",
    "monthly_cap",
    "max_runs_per_day",
    "tokens_per_day",
    "cap_per_run",
    "scope",
];

/// `setattr(profile, key, value)` for one of `EDITABLE`. A null for a column that cannot be empty is what the
/// database refuses in Python when the row is saved (a 500).
fn set_field(profile: &mut ai_team::Model, key: &str, value: &Value) -> Result<(), Error> {
    let mut value = value.clone();
    if matches!(key, "description" | "persona" | "working_dir" | "cli_path") && !value.is_null() {
        let text = text_of(&value);
        let text = pytext::strip(&text);
        value = if !text.is_empty() {
            json!(text)
        } else if matches!(key, "working_dir" | "cli_path") {
            Value::Null
        } else {
            json!("")
        };
    }
    let required = || Error::Other(format!("NOT NULL constraint failed: ai_team.{key}"));
    let text = |value: &Value| if value.is_null() { None } else { Some(text_of(value)) };
    let int = |value: &Value| if value.is_null() { Ok(None) } else { int_column(key, value).map(Some) };
    let float = |value: &Value| if value.is_null() { Ok(None) } else { float_of(value).map(Some) };
    match key {
        "description" => profile.description = text(&value).ok_or_else(required)?,
        "cli_path" => profile.cli_path = text(&value),
        "working_dir" => profile.working_dir = text(&value),
        "model" => profile.model = text(&value),
        "effort" => profile.effort = text(&value),
        "persona" => profile.persona = text(&value).ok_or_else(required)?,
        "pack_key" => profile.pack_key = text(&value),
        "permission_mode" => profile.permission_mode = text(&value).ok_or_else(required)?,
        "max_parallel" => profile.max_parallel = int(&value)?.ok_or_else(required)?,
        "daily_budget" => profile.daily_budget = float(&value)?.map(Into::into),
        "monthly_cap" => profile.monthly_cap = float(&value)?.map(Into::into),
        "max_runs_per_day" => profile.max_runs_per_day = int(&value)?,
        "tokens_per_day" => profile.tokens_per_day = int(&value)?,
        "cap_per_run" => profile.cap_per_run = float(&value)?.map(Into::into),
        "scope" => profile.scope = text(&value).ok_or_else(required)?,
        _ => {}
    }
    Ok(())
}

/// Edit a team; only the keys sent change.
pub async fn update(
    session: &Session,
    member_id: &str,
    data: &Map<String, Value>,
    by: &str,
) -> Result<ai_team::Model, Error> {
    let (Some(member_read), Some(profile_read)) = get_profile(session, member_id).await? else {
        return refuse("AI team not found.");
    };
    let (mut member, mut profile) = (member_read.clone(), profile_read.clone());
    if member.kind != "ai" {
        return refuse("AI team not found.");
    }
    validate(data)?;
    let mut member_changed = false;
    if let Some(name) = data.get("name") {
        let name = clean_name(&if pyjson::truthy(name) { text_of(name) } else { String::new() })?;
        let verdict = check_name(session, &member.project_id, &name, Some(member_id)).await?;
        if let Some(message) = taken(&verdict) {
            return refuse(message);
        }
        member.name = name;
        member_changed = true;
    }
    if let Some(color) = truthy(data, "color") {
        member.color = clean_color(&text_of(color))?;
        member_changed = true;
    }
    if data.contains_key("account_id") {
        profile.account_id = checked_account(session, data.get("account_id")).await?;
    }
    for key in EDITABLE {
        if let Some(value) = data.get(key) {
            set_field(&mut profile, key, value)?;
        }
    }
    if let Some(Value::Object(patch)) = data.get("config") {
        let stored = loads(Some(&profile.config), json!({}));
        let mut merged = merged_config(stored.as_object());
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
        profile.config = pyjson::dumps(&Value::Object(merged_config(Some(&merged))));
    }
    if ["cli_path", "working_dir", "account_id"].iter().any(|key| data.contains_key(*key)) {
        profile.health = "unknown".to_string();
        profile.health_detail = None;
        profile.checked_at = None;
    }
    profile.updated_at = now_iso();
    if member_changed {
        member = save_model(session, &member_read, member).await?;
    }
    let profile = save_model(session, &profile_read, profile).await?;
    session.commit().await?;
    let mut fields: Vec<&str> = data.keys().map(String::as_str).filter(|k| *k != "config").collect();
    fields.sort_unstable();
    audit::record(
        &member.project_id,
        "team_updated",
        "info",
        audit_entry(member_id, &member.name, by, json!({"fields": fields})),
    )
    .await?;
    Ok(profile)
}

/// `runs.cancel(...)` with a `runs.RunError` swallowed; nothing happens while `runs` is not there
/// (`hasattr(runs, "cancel")`).
async fn cancel_run(run_id: &str, by: &str, reason: &str) -> Result<(), Error> {
    let Some(runs) = seams::runs() else { return Ok(()) };
    match runs.cancel(run_id, by, reason).await {
        Ok(()) | Err(CancelError::Run(_)) => Ok(()),
        Err(CancelError::Other(message)) => Err(Error::Other(message)),
    }
}

/// Pause (new work queues; the current run finishes or is cancelled) or resume.
pub async fn set_paused(
    session: &Session,
    member_id: &str,
    paused: bool,
    by: &str,
    cancel_current: bool,
    reason: Option<&str>,
) -> Result<ai_team::Model, Error> {
    let (Some(member), Some(read)) = get_profile(session, member_id).await? else {
        return refuse("AI team not found.");
    };
    let mut profile = read.clone();
    profile.paused = paused;
    profile.paused_at = paused.then(now_iso);
    profile.paused_reason = paused
        .then(|| reason.filter(|r| !r.is_empty()).map(str::to_string).unwrap_or_else(|| format!("Paused by {by}")));
    let profile = save_model(session, &read, profile).await?;
    session.commit().await?;
    audit::record(
        &member.project_id,
        if paused { "team_paused" } else { "team_resumed" },
        "info",
        audit_entry(member_id, &member.name, by, json!({"cancel_current": cancel_current})),
    )
    .await?;
    if paused && cancel_current {
        for r in active_runs(session, Some(member_id), None).await? {
            if matches!(r.state.as_str(), "starting" | "running") {
                cancel_run(&r.id, by, &format!("{} was paused by {by}", member.name)).await?;
            }
        }
    } else if let Some(runs) = seams::runs() {
        runs.wake();
    }
    Ok(profile)
}

/// Open tickets and runs in flight that removing the team affects.
pub async fn removal_impact(session: &Session, member_id: &str) -> Result<Map<String, Value>, Error> {
    let open = ticket::Entity::find()
        .filter(ticket::Column::Assignee.eq(member_id))
        .filter(ticket::Column::Status.is_not_in(["done", "wont_do"]))
        .all(session)
        .await?;
    let runs = active_runs(session, Some(member_id), None).await?;
    let mut out = Map::new();
    out.insert(
        "open_tickets".into(),
        open.iter().map(|t| json!({"id": t.id, "title": t.title, "status": t.status})).collect(),
    );
    out.insert(
        "active_runs".into(),
        runs.iter().map(|r| json!({"id": r.id, "ticket_id": r.ticket_id, "state": r.state})).collect(),
    );
    Ok(out)
}

/// Remove a team: its open tickets go to a person or to nobody, its runs are cancelled, the Member row stays as
/// history (kind ai_removed). `tickets` is `"unassign"` (Python's default) or `"reassign"`.
pub async fn remove(
    session: &Session,
    member_id: &str,
    by: &str,
    tickets: &str,
    reassign_to: Option<&str>,
) -> Result<Map<String, Value>, Error> {
    let (Some(member), Some(_profile)) = get_profile(session, member_id).await? else {
        return refuse("AI team not found.");
    };
    if member.kind != "ai" {
        return refuse("AI team not found.");
    }
    let reassign_to = reassign_to.filter(|id| !id.is_empty());
    if tickets == "reassign" {
        let target = match reassign_to {
            Some(id) => member::Entity::find_by_id(id).one(session).await?,
            None => None,
        };
        if !target.is_some_and(|t| t.project_id == member.project_id && t.kind == "human") {
            return refuse("Pick a person to reassign the tickets to.");
        }
    }
    let impact = removal_impact(session, member_id).await?;
    let ids = |key: &str| -> Vec<String> {
        let rows = impact.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        rows.iter().filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_string)).collect()
    };
    let assignee = if tickets == "reassign" { json!(reassign_to) } else { Value::Null };
    for ticket_id in ids("open_tickets") {
        tickets::update_ticket(session, &ticket_id, &TicketUpdate::of("assignee", assignee.clone())).await.map_err(
            |err| match err {
                tickets::Error::Value(message) => Error::Value(message),
                tickets::Error::Db(err) => Error::Db(err),
                tickets::Error::NoResult(message) | tickets::Error::Other(message) => Error::Other(message),
            },
        )?;
    }
    for run_id in ids("active_runs") {
        cancel_run(&run_id, by, &format!("{} was removed by {by}", member.name)).await?;
    }
    let Some(read) = member::Entity::find_by_id(member_id).one(session).await? else {
        return Err(Error::Other(format!("AttributeError: the member {member_id} is gone")));
    };
    let mut member = read.clone();
    member.kind = "ai_removed".to_string();
    let member = save_model(session, &read, member).await?;
    if let Some(read) = ai_team::Entity::find_by_id(member_id).one(session).await? {
        let mut profile = read.clone();
        profile.paused = true;
        save_model(session, &read, profile).await?;
    }
    session.commit().await?;
    audit::record(&member.project_id, "team_removed", "info", audit_entry(member_id, &member.name, by, json!({})))
        .await?;
    let mut out = Map::new();
    out.insert("removed".into(), json!(true));
    Ok(out)
}
