//! Step 4, **create** (`repo_scan.py` lines 1570-1690: `apply`): only when a person presses it, the members from the
//! packs, the project's AI team settings and the plugins.

use std::collections::HashSet;

use kb_ai::{ops, store};
use kb_ai_know::packs;
use kb_ai_know::plugins::{self, CATALOGUE, InstallOpts};
use kb_ai_run::teams;
use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{ai_plugin, ai_project_settings, ai_repo_scan};
use kb_db::sea_orm::ActiveModelTrait;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter};
use serde_json::{Map, Value, json};

use crate::Error;
use crate::job::text_of;
use crate::pyfs::{py_iter, type_name};
use crate::suggest::wanted;

/// `int(value)` of what a person's choice holds.
fn int_of(value: &Value) -> Result<i64, Error> {
    match store::py_int(value) {
        Some(n) => {
            i64::try_from(n).map_err(|_| Error::Other("Python int too large to convert to SQLite INTEGER".into()))
        }
        None => Err(Error::Value(match value {
            Value::String(s) => format!("invalid literal for int() with base 10: {}", pytext::repr(s)),
            other => format!(
                "int() argument must be a string, a bytes-like object or a real number, not '{}'",
                type_name(other)
            ),
        })),
    }
}

/// `value or default` for a choice's key.
fn or_default(choice: &Value, key: &str, default: Value) -> Value {
    choice.get(key).filter(|v| pyjson::truthy(v)).cloned().unwrap_or(default)
}

/// Create what the person confirmed: the members from packs, the project's settings, the plugins.
///
/// `choice` is the suggestion as the person edited it: `{team: [{pack, name}], commands, prepare, base_port, handover,
/// worktrees, plugins: [catalogue keys], account_id, env_path: [folders], checks_off: [commands saved but not checks
/// yet]}`.
pub async fn apply(session: &Session, scan_id: &str, choice: &Value, by: &str) -> Result<Value, Error> {
    let Some(row) = ai_repo_scan::Entity::find_by_id(scan_id).one(session).await? else {
        return Err(Error::Lookup("Scan not found.".into()));
    };
    let mut settings: ai_project_settings::Model = store::get_settings(session, &row.project_id).await?;
    let checks_off: Vec<Value> = py_iter(choice.get("checks_off"))?
        .into_iter()
        .filter(|n| matches!(n.as_str(), Some("test" | "lint" | "build")))
        .collect();
    let env_path: Vec<Value> = py_iter(choice.get("env_path"))?
        .into_iter()
        .filter(pyjson::truthy)
        .map(|p| json!(pytext::strip(&text_of(&p))))
        .filter(|p| !p.as_str().unwrap_or("").is_empty())
        .collect();
    let base_port = int_of(&or_default(choice, "base_port", json!(5180)))?;
    let mut patch = Map::new();
    patch.insert("commands".into(), or_default(choice, "commands", json!({})));
    patch.insert("checks_off".into(), Value::Array(checks_off));
    patch.insert("env_path".into(), Value::Array(env_path));
    patch.insert(
        "worktrees".into(),
        json!({
            "on": choice.get("worktrees").is_some_and(pyjson::truthy),
            "repo": row.folder,
            "prepare": or_default(choice, "prepare", json!("")),
            "base_port": base_port,
            "handover": or_default(choice, "handover", json!("auto")),
        }),
    );
    ops::update(&mut settings, &patch);
    store::save::<_, ai_project_settings::Model, ai_project_settings::ActiveModel>(session, settings.clone()).await?;
    session.commit().await?;
    let mut created: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();

    let team = py_iter(choice.get("team"))?;
    let mut wanted_roles: Vec<String> = Vec::new();
    let mut team_name: Option<Value> = None;
    for item in &team {
        let Some(map) = item.as_object() else {
            return Err(Error::Other(format!("'{}' object has no attribute 'get'", type_name(item))));
        };
        wanted_roles.push(map.get("pack").filter(|v| pyjson::truthy(v)).map(text_of).unwrap_or_default());
        if team_name.is_none() {
            team_name = map.get("name").filter(|v| pyjson::truthy(v)).cloned();
        }
    }
    let pack_key =
        if wanted_roles.iter().any(|r| r == "designer" || r == "user_tester") { "feature_ui" } else { "standard" };
    let team_name = team_name.unwrap_or_else(|| json!("AI team"));
    let mut data = Map::new();
    data.insert("name".into(), team_name.clone());
    data.insert("working_dir".into(), json!(row.folder));
    data.insert("account_id".into(), choice.get("account_id").cloned().unwrap_or(Value::Null));
    data.insert("pack_key".into(), json!(pack_key));
    match teams::create(session, &row.project_id, &data, by).await {
        Ok(member) => created.push(json!({"id": member.id, "name": member.name, "pack": pack_key})),
        Err(e) if e.is_value_error() => skipped.push(json!({"name": team_name, "why": e.to_string()})),
        Err(teams::Error::Db(e)) => return Err(Error::Db(e)),
        Err(e) => return Err(Error::Other(e.to_string())),
    }
    let found = crate::job::loads_object(&row.found);
    let mut wanted_keys: Vec<Value> = py_iter(choice.get("plugins"))?;
    for role_key in &wanted_roles {
        let pack = packs::get_pack(session, &row.project_id, role_key).await?;
        let pack = pack.unwrap_or_default();
        wanted_keys.extend(py_iter(pack.get("plugins"))?);
        wanted_keys.extend(py_iter(pack.get("mcp"))?);
    }
    let mut have: HashSet<String> = ai_plugin::Entity::find()
        .filter(ai_plugin::Column::ProjectId.eq(row.project_id.as_str()))
        .all(session)
        .await?
        .into_iter()
        .map(|p| p.name)
        .collect();
    let mut installed: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut mcp: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for key in wanted_keys {
        let Value::String(key) = key else { continue };
        if seen.contains(&key) {
            continue;
        }
        seen.push(key.clone());
        let Some(entry) = CATALOGUE.iter().find(|c| c.get("key").and_then(Value::as_str) == Some(key.as_str())) else {
            continue;
        };
        if !wanted(entry, &found) {
            continue;
        }
        let entry_name = entry.get("name").map(text_of).unwrap_or_default();
        if entry.get("kind").and_then(Value::as_str) == Some("mcp") {
            // carried on the members by member_body
            mcp.push(json!(entry_name));
            continue;
        }
        let plugin = entry.get("plugin").and_then(Value::as_str);
        if have.contains(&key) || have.contains(&entry_name) || plugin.is_some_and(|p| have.contains(p)) {
            // once per project
            continue;
        }
        let skills: Option<Vec<String>> =
            entry.get("skills").and_then(Value::as_array).map(|items| items.iter().map(text_of).collect());
        let roles: Option<Vec<String>> =
            entry.get("roles").and_then(Value::as_array).map(|items| items.iter().map(text_of).collect());
        let source = entry.get("source").map(text_of).unwrap_or_default();
        let opts = InstallOpts {
            source_kind: "marketplace",
            source: &source,
            plugin,
            skills,
            roles,
            by,
            ..InstallOpts::default()
        };
        match plugins::install(session, &row.project_id, opts).await {
            Ok(plug) => {
                installed.push(json!(plug.name));
                have.insert(plug.name);
            }
            Err(plugins::Error::Plugin(why)) => failed.push(json!({"plugin": key, "why": why})),
            Err(plugins::Error::Db(e)) => return Err(Error::Db(e)),
            Err(e) => return Err(Error::Other(e.to_string())),
        }
    }
    let mut applied = row.into_active_model();
    applied.applied_at = Set(Some(time::now_iso()));
    applied.update(session).await?;
    session.commit().await?;
    Ok(json!({
        "created": created,
        "skipped": skipped,
        "plugins": installed,
        "mcp": mcp,
        "plugin_failures": failed,
        "settings": ops::get(Some(&settings)),
    }))
}
