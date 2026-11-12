//! Who gets a plugin and what a run is told about it (`plugins.py`: `role_of`, `on_for`, `team_role_keys`,
//! `catalogue_entry_for`, `skills_block`, `dirs_for`, `set_member`, `usage`, `to_dict`).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use kb_ai::providers::merged_config;
use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::{ai_plugin, ai_skill_use, ai_team};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

use super::{CATALOGUE, Error, loads};
use crate::roles;

fn object_of(text: &str) -> Map<String, Value> {
    match loads(Some(text), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn strings_of(value: Value) -> Vec<String> {
    match value {
        Value::Array(items) => {
            items.iter().map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| pyjson::py_str(v))).collect()
        }
        _ => Vec::new(),
    }
}

/// The member's role pack key (set when it was made from a pack), or None.
pub fn role_of(profile: &ai_team::Model) -> Option<String> {
    let cfg = object_of(&profile.config);
    let role = cfg.get("role").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).map(str::to_string);
    role.or_else(|| {
        cfg.get("pack")
            .filter(|v| pyjson::truthy(v))
            .and_then(|p| p.get("key"))
            .filter(|v| pyjson::truthy(v))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

/// Whether a team gets the plugin: its own switch, else the project default, else one of its roles (AI v2: a team has
/// several roles, its subagents; `role_keys` are their keys). Without `role_keys`, the team's own role key.
pub fn on_for(row: &ai_plugin::Model, profile: &ai_team::Model, role_keys: Option<&HashSet<String>>) -> bool {
    let overrides = object_of(&row.members);
    if let Some(v) = overrides.get(&profile.id) {
        return pyjson::truthy(v);
    }
    if row.default_on {
        return true;
    }
    let wanted: HashSet<String> = strings_of(loads(Some(&row.roles), json!([]))).into_iter().collect();
    match role_keys {
        Some(keys) => wanted.iter().any(|w| keys.contains(w)),
        None => role_of(profile).is_some_and(|r| wanted.contains(&r)),
    }
}

/// The keys of the team's roles (its pack's, with the team's own changes).
pub async fn team_role_keys(session: &Session, profile: &ai_team::Model) -> Result<HashSet<String>, DbErr> {
    let raw = object_of(&profile.config);
    let config = merged_config(Some(&raw));
    let found = roles::roles_for(Some(session), &profile.project_id, profile.pack_key.as_deref(), &config).await?;
    Ok(found.iter().filter_map(|r| r.get("key").and_then(Value::as_str).map(str::to_string)).collect())
}

fn norm_source(source: &str) -> String {
    let trimmed = kb_base::pytext::strip(source).trim_end_matches('/');
    trimmed.strip_suffix(".git").unwrap_or(trimmed).to_lowercase()
}

/// The catalogue entry a plugin was installed from: same source, same marketplace entry, its skills.
pub fn catalogue_entry_for(row: &ai_plugin::Model) -> Option<&'static Map<String, Value>> {
    let have: HashSet<String> = strings_of(loads(Some(&row.skills), json!([]))).into_iter().collect();
    let mine = norm_source(&row.source);
    for e in CATALOGUE.iter() {
        if e.get("kind").and_then(Value::as_str) != Some("plugin") {
            continue;
        }
        if norm_source(e.get("source").and_then(Value::as_str).unwrap_or("")) != mine {
            continue;
        }
        let entry_plugin = e.get("plugin").filter(|v| pyjson::truthy(v)).and_then(Value::as_str);
        let row_plugin = row.plugin.as_deref().filter(|p| !p.is_empty());
        if entry_plugin != row_plugin && entry_plugin.is_some() {
            continue;
        }
        let wanted: HashSet<String> = strings_of(e.get("skills").cloned().unwrap_or(Value::Null)).into_iter().collect();
        if !wanted.is_empty() && !wanted.iter().any(|w| have.contains(w)) {
            continue;
        }
        return Some(e);
    }
    None
}

fn has_folder(row: &ai_plugin::Model) -> bool {
    row.path.as_deref().is_some_and(|p| !p.is_empty() && Path::new(p).is_dir())
}

/// The skills a member's run loads, by the exact name the Skill tool takes and with the work each one covers. A run that
/// is only handed plugin folders seldom opens one (a live Designer run had 12 and opened none of them).
pub async fn skills_block(
    session: &Session,
    profile: &ai_team::Model,
    role_keys: Option<&HashSet<String>>,
) -> Result<String, DbErr> {
    let rows = ai_plugin::Entity::find()
        .filter(ai_plugin::Column::ProjectId.eq(profile.project_id.as_str()))
        .all(session)
        .await?;
    let keys = match role_keys {
        Some(k) => k.clone(),
        None => team_role_keys(session, profile).await?,
    };
    let mut lines = Vec::new();
    for r in &rows {
        if !(has_folder(r) && on_for(r, profile, Some(&keys))) {
            continue;
        }
        let names = strings_of(loads(Some(&r.skills), json!([])));
        if names.is_empty() {
            continue;
        }
        let entry = catalogue_entry_for(r);
        let listed: Vec<String> = names.iter().map(|n| format!("`{}:{}`", r.name, n)).collect();
        let listed = listed.join(", ");
        match entry.and_then(|e| e.get("use")).filter(|v| pyjson::truthy(v)).and_then(Value::as_str) {
            Some(u) => lines.push(format!("- {listed}: {u}")),
            None => lines.push(format!("- {listed}")),
        }
    }
    if lines.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(
        "Skills the project installed for your team, beside the board's own. When you or a role reach the work one \
covers, open it with the Skill tool by the exact name below. Where one disagrees with a board skill \
(`kanban-board:…`), the board's wins. Your report names the skills you opened.\n{}",
        lines.join("\n")
    ))
}

/// The plugin folders a team's run loads.
pub async fn dirs_for(
    session: &Session,
    profile: &ai_team::Model,
    role_keys: Option<&HashSet<String>>,
) -> Result<Vec<String>, DbErr> {
    let keys = match role_keys {
        Some(k) => k.clone(),
        None => team_role_keys(session, profile).await?,
    };
    let rows = ai_plugin::Entity::find()
        .filter(ai_plugin::Column::ProjectId.eq(profile.project_id.as_str()))
        .all(session)
        .await?;
    Ok(rows
        .iter()
        .filter(|r| has_folder(r) && on_for(r, profile, Some(&keys)))
        .filter_map(|r| r.path.clone())
        .collect())
}

/// A member's own switch (None: follow the project default again).
pub async fn set_member(
    session: &Session,
    row: ai_plugin::Model,
    member_id: &str,
    on: Option<bool>,
) -> Result<ai_plugin::Model, Error> {
    let mut overrides = object_of(&row.members);
    match on {
        None => {
            overrides.shift_remove(member_id);
        }
        Some(on) => {
            overrides.insert(member_id.to_string(), json!(on));
        }
    }
    let mut active = kb_db::edit(row);
    active.members = Set(pyjson::dumps(&Value::Object(overrides)));
    let saved = active.update(session).await?;
    session.commit().await?;
    Ok(saved)
}

/// Real use of each plugin's skills, from the run stream: `{plugin name: {uses, by_member: {id: n}, last}}`.
pub async fn usage(session: &Session, project_id: &str) -> Result<Map<String, Value>, DbErr> {
    let rows = ai_skill_use::Entity::find()
        .filter(ai_skill_use::Column::ProjectId.eq(project_id))
        .order_by_asc(ai_skill_use::Column::Id)
        .all(session)
        .await?;
    // (name, uses, by_member in first-seen order, last)
    let mut out: Vec<(String, i64, Vec<(String, i64)>, String)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for u in rows {
        let name = u.plugin.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| u.name.clone());
        let i = *at.entry(name.clone()).or_insert_with(|| {
            out.push((name.clone(), 0, Vec::new(), String::new()));
            out.len() - 1
        });
        out[i].1 += 1;
        if let Some(member) = u.member_id.filter(|m| !m.is_empty()) {
            match out[i].2.iter_mut().find(|(m, _)| *m == member) {
                Some(slot) => slot.1 += 1,
                None => out[i].2.push((member, 1)),
            }
        }
        if u.at > out[i].3 {
            out[i].3 = u.at;
        }
    }
    let mut result = Map::new();
    for (name, uses, by_member, last) in out {
        let by: Map<String, Value> = by_member.into_iter().map(|(m, n)| (m, json!(n))).collect();
        result.insert(
            name,
            json!({"uses": uses, "by_member": Value::Object(by), "last": if last.is_empty() { Value::Null } else { json!(last) }}),
        );
    }
    Ok(result)
}

/// A plugin for the API.
pub fn to_dict(row: &ai_plugin::Model, used: Option<&Value>) -> Value {
    let members: Vec<Value> =
        object_of(&row.members).into_iter().map(|(k, v)| json!({"member_id": k, "on": v})).collect();
    let by_member: Vec<Value> = match used.and_then(|u| u.get("by_member")) {
        Some(Value::Object(m)) => m.iter().map(|(k, n)| json!({"member_id": k, "uses": n})).collect(),
        _ => Vec::new(),
    };
    let previous = loads(row.previous.as_deref(), Value::Null);
    json!({
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "source_kind": row.source_kind,
        "source": row.source,
        "ref": row.r#ref,
        "plugin": row.plugin,
        "commit": row.commit,
        "version": row.version,
        "description": row.description,
        "skills": loads(Some(&row.skills), json!([])),
        "hooks": row.hooks,
        "mcp": row.mcp,
        "size_bytes": row.size_bytes,
        "pinned": row.pinned,
        "default_on": row.default_on,
        "roles": loads(Some(&row.roles), json!([])),
        // lists, not dicts keyed by member id: the UI client camel-cases object keys, which would change an id
        "members": members,
        "has_previous": pyjson::truthy(&previous),
        "installed_by": row.installed_by,
        "installed_at": row.installed_at,
        "updated_at": row.updated_at,
        "used": {
            "uses": used.and_then(|u| u.get("uses")).cloned().filter(pyjson::truthy).unwrap_or(json!(0)),
            "by_member": by_member,
            "last": used.and_then(|u| u.get("last")).cloned().unwrap_or(Value::Null),
        },
    })
}
