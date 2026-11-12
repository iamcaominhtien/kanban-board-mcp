//! Runner detection and health (`services/ai/teams.py`, lines 398 to 526).

use chrono::Utc;
use kb_ai::audit;
use kb_ai::providers::providers;
use kb_ai::store::{get_profile, now_iso, parse_iso, save};
use kb_base::pyjson;
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_account, ai_team, member};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

use super::{ACCOUNT_STALE_S, Error, HEALTH_STALE_S, refuse, text_of};
use crate::{accounts, cli, seams};

/// `PROVIDERS["claude-code"]`.
fn spec() -> Map<String, Value> {
    providers().get("claude-code").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn binary_of(spec: &Map<String, Value>) -> String {
    spec.get("binary").and_then(Value::as_str).unwrap_or("claude").to_string()
}

/// Is Claude Code installed and signed in on this computer (for the account, when the team runs as one)?
pub async fn detect_local(
    session: Option<&Session>,
    cli_path: Option<&str>,
    account_id: Option<&str>,
) -> Result<Map<String, Value>, Error> {
    let account = match (session, account_id.filter(|id| !id.is_empty())) {
        (Some(session), Some(id)) => ai_account::Entity::find_by_id(id).one(session).await?,
        _ => None,
    };
    let env = match &account {
        Some(account) => {
            let base = cli::child_env(None);
            Some(accounts::env_for(account, &base).await.map_err(|err| Error::Other(err.to_string()))?)
        }
        None => None,
    };
    let spec = spec();
    let mut info = cli::detect("claude-code", &binary_of(&spec), cli_path, env.as_ref())
        .await
        .map_err(|err| Error::Other(err.to_string()))?;
    if let Some(account) = &account {
        if info.get("found").is_some_and(pyjson::truthy) {
            info.insert("logged_in".into(), json!(account.status == "signed_in"));
            let parts: Vec<&str> =
                [account.email.as_deref(), account.plan.as_deref()].into_iter().flatten().filter(|x| !x.is_empty()).collect();
            let who = parts.join(" · ");
            info.insert("account".into(), json!(if who.is_empty() { account.name.clone() } else { who }));
        }
    }
    info.insert("install".into(), spec.get("install").cloned().unwrap_or(Value::Null));
    info.insert("guide_url".into(), spec.get("guide_url").cloned().unwrap_or(Value::Null));
    Ok(info)
}

/// Check the team's runner and sign-in and record its health.
pub async fn test_connection(session: &Session, member_id: &str) -> Result<Map<String, Value>, Error> {
    let (Some(_member), Some(mut profile)) = get_profile(session, member_id).await? else {
        return refuse("AI team not found.");
    };
    let info = detect_local(Some(session), profile.cli_path.as_deref(), profile.account_id.as_deref()).await?;
    apply_health(&mut profile, &info).await;
    profile.checked_at = Some(now_iso());
    let profile = save(session, profile).await?;
    session.commit().await?;
    // a usage limit is not a missing or signed-out runner
    let ok = matches!(profile.health.as_str(), "ok" | "rate_limited");
    let message = if ok {
        let version = info.get("version").filter(|v| pyjson::truthy(v)).map(|v| format!("{} ", text_of(v)));
        let account = info.get("account").filter(|v| pyjson::truthy(v)).map(text_of);
        format!(
            "Claude Code {}is installed{}",
            version.unwrap_or_default(),
            match account {
                Some(account) => format!(" and signed in ({account})."),
                None => ".".to_string(),
            }
        )
    } else {
        profile
            .health_detail
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "Claude Code cannot run for this team.".to_string())
    };
    let mut out = info;
    out.insert("ok".into(), json!(ok));
    out.insert("message".into(), json!(message));
    out.insert("health".into(), json!(profile.health));
    out.insert("health_detail".into(), json!(profile.health_detail));
    Ok(out)
}

/// `_apply_health`: what a detection says about the team's runner, put on the profile (the caller saves it).
pub async fn apply_health(profile: &mut ai_team::Model, info: &Map<String, Value>) {
    let binary = binary_of(&spec());
    if !info.get("found").is_some_and(pyjson::truthy) {
        profile.health = "runner_missing".to_string();
        profile.health_detail = Some(cli::missing(&binary, profile.cli_path.as_deref()).await);
    } else if info.get("logged_in") == Some(&Value::Bool(false)) {
        profile.health = "not_logged_in".to_string();
        profile.health_detail = Some("Claude Code is installed but not signed in. Sign the account in.".to_string());
    } else if profile.health != "rate_limited" {
        // a usage limit the last run hit is only cleared by the next run that ends well (`note_run_outcome`): the
        // runner is found and signed in, which says nothing about the account's quota
        profile.health = "ok".to_string();
        profile.health_detail = None;
    }
}

/// Record on the team what a run's end says about its quota: a run that ended on a usage limit (429) sets
/// `health = "rate_limited"` (the "Rate-limited" status of `status_of`); the next run that finishes clears it.
/// Returns true when the team's health changed (the caller saves it).
pub fn note_run_outcome(
    profile: &mut ai_team::Model,
    state: &str,
    stop_code: Option<&str>,
    reason: Option<&str>,
) -> bool {
    if state == "failed" && stop_code == Some("rate_limited") {
        profile.health = "rate_limited".to_string();
        profile.health_detail = reason.map(str::to_string);
        return true;
    }
    if state == "finished" && profile.health == "rate_limited" {
        profile.health = "ok".to_string();
        profile.health_detail = None;
        return true;
    }
    false
}

/// Re-detect what changes without anyone touching the board: a runner uninstalled or reinstalled, a sign-in that
/// expired or came back. Returns how many teams changed state.
///
/// Python keeps the teams it read before the accounts were checked in its session, where a row an account's check
/// changed (`accounts.follow`) is the same object; here each team is read again when its turn comes. And where Python
/// leaves a changed team for the next commit of the loop, the row is written and committed at once: the audit entry
/// that follows has a session of its own, which must not wait for this one's write.
pub async fn health_check() -> Result<usize, Error> {
    let mut changed = 0;
    let now = Utc::now();
    let session = database::session();
    let ids: Vec<String> = ai_team::Entity::find().all(&session).await?.into_iter().map(|t| t.id).collect();
    accounts::check_all(&session, Some(ACCOUNT_STALE_S)).await.map_err(|err| Error::Other(err.to_string()))?;
    for id in ids {
        let Some(mut profile) = ai_team::Entity::find_by_id(id.as_str()).one(&session).await? else { continue };
        let Some(member) = member::Entity::find_by_id(id.as_str()).one(&session).await? else { continue };
        if member.kind != "ai" {
            continue;
        }
        let before = profile.health.clone();
        let stale = match parse_iso(profile.checked_at.as_deref()) {
            None => true,
            Some(checked) => {
                let age = now.signed_duration_since(checked);
                (age.num_microseconds().unwrap_or(i64::MAX) as f64) / 1e6 > HEALTH_STALE_S
            }
        };
        if profile.health == "ok" && !stale {
            continue;
        }
        session.commit().await?; // no write lock while the CLI is asked
        let info = detect_local(Some(&session), profile.cli_path.as_deref(), profile.account_id.as_deref()).await?;
        apply_health(&mut profile, &info).await;
        profile.checked_at = Some(now_iso());
        let profile = save(&session, profile).await?;
        session.commit().await?;
        if profile.health != before {
            changed += 1;
            audit::record(
                &profile.project_id,
                "team_health",
                "info",
                audit::Entry {
                    member_id: Some(profile.id.clone()),
                    member_name: member.name.clone(),
                    on_behalf_of: Some("board".to_string()),
                    detail: json!({"from": before, "to": profile.health}).as_object().cloned().unwrap_or_default(),
                    ..Default::default()
                },
            )
            .await?;
        }
    }
    session.commit().await?;
    if changed > 0 {
        if let Some(runs) = seams::runs() {
            runs.wake();
        }
    }
    Ok(changed)
}
