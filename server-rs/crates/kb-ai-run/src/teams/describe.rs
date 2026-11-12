//! Describing a team for the API (`services/ai/teams.py`, lines 529 to 733).

use chrono::Utc;
use kb_ai::audit::round4;
use kb_ai::providers::merged_config;
use kb_ai::store::{active_runs, get_settings, loads};
use kb_ai_know::roles;
use kb_db::Session;
use kb_db::entities::{ai_account, ai_project_settings, ai_run, ai_team, member, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use super::Error;

/// The one status a row shows, most blocking first.
pub fn status_of(
    member: &member::Model,
    profile: &ai_team::Model,
    runs: &[ai_run::Model],
    settings: &ai_project_settings::Model,
) -> Value {
    // a run that waits for an answer still holds the team's ticket: the card says Running, as the design draws it
    let running: Vec<&ai_run::Model> =
        runs.iter().filter(|r| matches!(r.state.as_str(), "starting" | "running" | "needs_input")).collect();
    if member.kind == "ai_removed" {
        return json!({"code": "removed", "label": "Removed", "detail": null});
    }
    if profile.health == "not_logged_in" {
        return json!({"code": "not_logged_in", "label": "Not signed in", "detail": profile.health_detail});
    }
    if profile.health == "runner_missing" {
        return json!({"code": "runner_missing", "label": "Runner not detected", "detail": profile.health_detail});
    }
    if profile.health == "rate_limited" {
        return json!({"code": "rate_limited", "label": "Rate-limited", "detail": profile.health_detail});
    }
    if settings.paused_all {
        return json!({"code": "paused_all", "label": "AI paused", "detail": settings.paused_reason});
    }
    if profile.paused {
        return json!({"code": "paused", "label": "Paused", "detail": profile.paused_reason});
    }
    if let Some(first) = running.first() {
        return json!({
            "code": "running",
            "label": "Running",
            "detail": first.ticket_id,
            "ticket_id": first.ticket_id,
        });
    }
    json!({"code": "idle", "label": "Idle", "detail": null})
}

/// `_account_ref`: the account a team runs as, as the team's card shows it.
async fn account_ref(session: &Session, profile: &ai_team::Model) -> Result<Value, Error> {
    let Some(account_id) = profile.account_id.as_deref().filter(|id| !id.is_empty()) else {
        return Ok(Value::Null);
    };
    let Some(account) = ai_account::Entity::find_by_id(account_id).one(session).await? else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "id": account.id,
        "name": account.name,
        "status": account.status,
        "email": account.email,
        "plan": account.plan,
        "method": account.method,
    }))
}

/// `_usage_today`: the runs the team started since midnight UTC, their estimated cost and their tokens.
async fn usage_today(session: &Session, member_id: &str) -> Result<Value, Error> {
    let day = Utc::now().date_naive().to_string();
    let rows = ai_run::Entity::find()
        .filter(ai_run::Column::MemberId.eq(member_id))
        .filter(ai_run::Column::StartedAt.gte(day))
        .all(session)
        .await?;
    // `sum(r.cost_usd or 0 for r in rows)`: an int 0 while no run has a cost, as Python's sum gives
    let cost: f64 = rows.iter().map(|r| r.cost_usd).sum();
    let cost = if rows.iter().all(|r| r.cost_usd == 0.0) { json!(0) } else { json!(round4(cost)) };
    let tokens: i64 = rows.iter().map(|r| i64::from(r.tokens_in) + i64::from(r.tokens_out)).sum();
    Ok(json!({"runs_today": rows.len(), "cost_today": cost, "tokens_today": tokens}))
}

/// A team for the API. `settings`: the project's AI settings when the caller already has them.
pub async fn describe(
    session: &Session,
    member: &member::Model,
    profile: &ai_team::Model,
    settings: Option<&ai_project_settings::Model>,
) -> Result<Map<String, Value>, Error> {
    let own;
    let settings = match settings {
        Some(settings) => settings,
        None => {
            own = get_settings(session, &member.project_id).await?;
            &own
        }
    };
    let runs = active_runs(session, Some(&member.id), None).await?;
    let last = ai_run::Entity::find()
        .filter(ai_run::Column::MemberId.eq(member.id.as_str()))
        .filter(ai_run::Column::EndedAt.is_not_null())
        .order_by_desc(ai_run::Column::EndedAt)
        .limit(1)
        .one(session)
        .await?;
    let assigned = ticket::Entity::find()
        .filter(ticket::Column::Assignee.eq(member.id.as_str()))
        .filter(ticket::Column::Status.is_not_in(["done", "wont_do"]))
        .all(session)
        .await?;
    let stored = loads(Some(&profile.config), json!({}));
    let config = merged_config(stored.as_object());
    let team_roles = roles::roles_for(Some(session), &member.project_id, profile.pack_key.as_deref(), &config).await?;
    let mut titles: Vec<ticket::Model> = assigned.clone();
    for r in &runs {
        if let Some(ticket_id) = r.ticket_id.as_deref().filter(|id| !id.is_empty()) {
            if !titles.iter().any(|t| t.id == ticket_id) {
                if let Some(t) = ticket::Entity::find_by_id(ticket_id).one(session).await? {
                    titles.push(t);
                }
            }
        }
    }
    let title_of = |ticket_id: Option<&str>| titles.iter().find(|t| Some(t.id.as_str()) == ticket_id);
    let pack = roles::team_pack(profile.pack_key.as_deref().unwrap_or(""));
    let mut out = Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.to_string(), value);
    };
    put("id", json!(member.id));
    put("project_id", json!(member.project_id));
    put("name", json!(member.name));
    put("color", json!(member.color));
    put("kind", json!(member.kind));
    put("provider", json!("claude-code"));
    put("description", json!(profile.description));
    put("cli_path", json!(profile.cli_path));
    put("working_dir", json!(profile.working_dir));
    put("model", json!(profile.model));
    put("effort", json!(profile.effort));
    put("persona", json!(profile.persona));
    put("pack_key", json!(profile.pack_key));
    put(
        "pack_name",
        match pack {
            Some(pack) => pack.get("name").cloned().unwrap_or(Value::Null),
            None => json!(profile.pack_key),
        },
    );
    put("roles", Value::Array(roles::public(&team_roles)));
    put("config", Value::Object(config));
    put("permission_mode", json!(profile.permission_mode));
    put("max_parallel", json!(profile.max_parallel));
    put("daily_budget", json!(profile.daily_budget));
    put("monthly_cap", json!(profile.monthly_cap));
    put("max_runs_per_day", json!(profile.max_runs_per_day));
    put("tokens_per_day", json!(profile.tokens_per_day));
    put("cap_per_run", json!(profile.cap_per_run));
    put("scope", json!(profile.scope));
    put("paused", json!(profile.paused));
    put("paused_at", json!(profile.paused_at));
    put("paused_reason", json!(profile.paused_reason));
    put("health", json!(profile.health));
    put("health_detail", json!(profile.health_detail));
    put("checked_at", json!(profile.checked_at));
    put("mcp_last_used_at", json!(profile.mcp_last_used_at));
    put("account_id", json!(profile.account_id));
    put("account_ref", account_ref(session, profile).await?);
    put("status", status_of(member, profile, &runs, settings));
    put(
        "running",
        runs.iter()
            .map(|r| {
                let t = title_of(r.ticket_id.as_deref());
                json!({
                    "run_id": r.id,
                    "ticket_id": r.ticket_id,
                    "ticket_title": t.map(|t| t.title.clone()),
                    "ticket_status": t.map(|t| t.status.clone()),
                    "state": r.state,
                    "number": r.number,
                    "started_at": r.started_at,
                })
            })
            .collect(),
    );
    put("slots_in_use", json!(runs.iter().filter(|r| matches!(r.state.as_str(), "starting" | "running")).count()));
    put("queued", json!(runs.iter().filter(|r| r.state == "queued").count()));
    put("assigned", assigned.iter().map(|t| json!({"id": t.id, "title": t.title, "status": t.status})).collect());
    put("usage", usage_today(session, &member.id).await?);
    put(
        "last_run",
        match &last {
            Some(last) => json!({
                "ticket_id": last.ticket_id,
                "state": last.state,
                "number": last.number,
                "ended_at": last.ended_at,
            }),
            None => Value::Null,
        },
    );
    put("created_by", json!(profile.created_by));
    put("created_at", json!(profile.created_at));
    put("updated_at", json!(profile.updated_at));
    Ok(out)
}

/// The project's teams, described.
pub async fn list_teams(
    session: &Session,
    project_id: &str,
    include_removed: bool,
) -> Result<Vec<Map<String, Value>>, Error> {
    let kinds: &[&str] = if include_removed { &["ai", "ai_removed"] } else { &["ai"] };
    let members = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.is_in(kinds.iter().copied()))
        .all(session)
        .await?;
    let settings = get_settings(session, project_id).await?;
    let mut out = Vec::new();
    for m in &members {
        if let Some(profile) = ai_team::Entity::find_by_id(m.id.as_str()).one(session).await? {
            out.push(describe(session, m, &profile, Some(&settings)).await?);
        }
    }
    out.sort_by(|a, b| {
        let at = |d: &Map<String, Value>| d.get("created_at").and_then(Value::as_str).unwrap_or("").to_string();
        at(a).cmp(&at(b))
    });
    Ok(out)
}
