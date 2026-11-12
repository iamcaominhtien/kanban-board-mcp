//! The roles of a team (AI v2): the ready-made role packs become the subagents of the team's lead. Port of
//! `services/ai/roles.py`.
//!
//! A role is `{key, name, description, prompt, model, effort, tools}`. A team picks a *team pack* (a set of roles) and
//! may override or add roles in its config (`config["roles"]`). `agents_json` turns the roles into what `claude
//! --agents` takes; `agent_markdown` writes one `agents/<key>.md` of the team's plugin.

use std::sync::LazyLock;

use kb_base::pyjson;
use kb_db::Session;
use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value, json};

use crate::packs;

/// A role (subagent definition): a dict.
pub type Role = Map<String, Value>;

/// `DEFAULT_TEAM_PACK`.
pub const DEFAULT_TEAM_PACK: &str = "standard";

/// `TEAM_PACKS`: which roles a team brings. The lead itself is not a role: it is the team's main session.
pub static TEAM_PACKS: LazyLock<Vec<(String, Map<String, Value>)>> = LazyLock::new(|| {
    fn pack(name: &str, description: &str, roles: Vec<&str>) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("name".into(), json!(name));
        m.insert("description".into(), json!(description));
        m.insert("roles".into(), json!(roles));
        m
    }
    let everyone: Vec<&str> = packs::BUILTIN_KEYS.iter().map(String::as_str).filter(|k| *k != "triage").collect();
    vec![
        (
            "standard".into(),
            pack(
                "Standard feature",
                "Dev, Reviewer and QA: the lead codes, a fresh Reviewer reads the diff, QA checks it.",
                vec!["dev", "reviewer", "qa"],
            ),
        ),
        ("bugfix".into(), pack("Quick fix", "Dev and Reviewer for a small, obvious change.", vec!["dev", "reviewer"])),
        (
            "feature_ui".into(),
            pack(
                "Feature with a UI",
                "PM, Designer, Dev, Reviewer, QA and a User tester.",
                vec!["pm", "designer", "dev", "reviewer", "qa", "user_tester"],
            ),
        ),
        (
            "research".into(),
            pack("Research", "PM, BA and Dev: find out, write it down, propose tickets.", vec!["pm", "ba", "dev"]),
        ),
        ("docs".into(), pack("Documentation", "Tech writer and Reviewer.", vec!["tech_writer", "reviewer"])),
        ("full".into(), pack("Everyone", "Every ready-made role except Triage.", everyone)),
    ]
});

/// The team pack `key`, if it is one.
pub fn team_pack(key: &str) -> Option<&'static Map<String, Value>> {
    TEAM_PACKS.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn truthy(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| pyjson::truthy(v))
}

/// `a or b` for two optional JSON values.
fn first_truthy<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    truthy(a).or_else(|| truthy(b))
}

/// A role (subagent definition) from a ready-made or project role pack.
pub fn role_from_pack(pack: &Map<String, Value>) -> Role {
    let key = pack.get("key").cloned().unwrap_or(Value::Null);
    let writes = truthy(pack.get("writes")).cloned().unwrap_or_else(|| json!("nothing"));
    let persona = match truthy(pack.get("persona")) {
        Some(Value::String(s)) => kb_base::pytext::strip(s).to_string(),
        _ => String::new(),
    };
    let mut out = Map::new();
    out.insert("key".into(), key.clone());
    out.insert("name".into(), truthy(pack.get("name")).cloned().unwrap_or_else(|| key.clone()));
    out.insert(
        "description".into(),
        first_truthy(pack.get("tagline"), pack.get("name")).cloned().unwrap_or_else(|| key.clone()),
    );
    out.insert("prompt".into(), json!(persona));
    out.insert("model".into(), pack.get("model").cloned().unwrap_or(Value::Null));
    out.insert("effort".into(), pack.get("effort").cloned().unwrap_or(Value::Null));
    // no tool list: a role has every tool of the run (bypass plus a short deny list, docs/specs/ai-v2.md §2). A list
    // here cut a role off from the Skill tool (its own guide) and the board's MCP tools.
    out.insert("tools".into(), Value::Null);
    out.insert("writes".into(), writes);
    out
}

/// Every ready-made role, for the pack editor.
pub fn catalogue() -> Vec<Role> {
    packs::BUILTIN.iter().map(role_from_pack).collect()
}

/// The team packs, for the team wizard.
pub fn team_packs() -> Vec<Map<String, Value>> {
    TEAM_PACKS
        .iter()
        .map(|(key, tp)| {
            let mut m = Map::new();
            m.insert("key".into(), json!(key));
            for (k, v) in tp {
                m.insert(k.clone(), v.clone());
            }
            m
        })
        .collect()
}

fn builtin_role(key: &str) -> Option<Role> {
    packs::builtin(key).map(|pack| role_from_pack(&pack))
}

fn roles_of_team_pack(key: &str) -> Vec<Role> {
    let listed = team_pack(key).and_then(|tp| tp.get("roles")).and_then(Value::as_array).cloned().unwrap_or_default();
    listed.iter().filter_map(|k| k.as_str().and_then(builtin_role)).collect()
}

fn role_key(role: &Role) -> String {
    role.get("key").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The roles of a team: its pack's roles (a team pack, or a project pack that lists `roles`), then the overrides and
/// additions of `config["roles"]` (a list of role dicts; a dict with only `key` repeats the ready-made role). An
/// override with `"off": true` drops the role.
pub async fn roles_for(
    session: Option<&Session>,
    project_id: &str,
    pack_key: Option<&str>,
    config: &Map<String, Value>,
) -> Result<Vec<Role>, DbErr> {
    let key = pack_key.filter(|k| !k.is_empty()).unwrap_or(DEFAULT_TEAM_PACK);
    let base: Vec<Role> = if team_pack(key).is_some() {
        roles_of_team_pack(key)
    } else {
        let row = match session {
            Some(s) => packs::get_pack(s, project_id, key).await?,
            None => None,
        };
        let listed = row.as_ref().and_then(|r| truthy(r.get("roles"))).and_then(Value::as_array).cloned();
        match (listed, row) {
            (Some(listed), _) if !listed.is_empty() => listed
                .iter()
                .filter_map(Value::as_object)
                .filter(|r| truthy(r.get("key")).is_some())
                .map(|r| {
                    let mut merged =
                        builtin_role(r.get("key").and_then(Value::as_str).unwrap_or("")).unwrap_or_default();
                    for (k, v) in r {
                        merged.insert(k.clone(), v.clone());
                    }
                    merged
                })
                .collect(),
            (_, Some(mut row)) => {
                let k = truthy(row.get("key")).cloned().unwrap_or_else(|| json!(key));
                row.insert("key".into(), k);
                vec![role_from_pack(&row)]
            }
            _ => roles_of_team_pack(DEFAULT_TEAM_PACK),
        }
    };
    let mut by_key: Vec<(String, Role)> = Vec::new();
    for r in &base {
        let k = role_key(r);
        match by_key.iter_mut().find(|(have, _)| *have == k) {
            Some(slot) => slot.1 = r.clone(),
            None => by_key.push((k, r.clone())),
        }
    }
    let mut order: Vec<String> = base.iter().map(role_key).collect();
    let items = match truthy(config.get("roles")) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    for item in &items {
        let Some(item) = item.as_object() else { continue };
        let Some(k) = truthy(item.get("key")).and_then(Value::as_str) else { continue };
        let k = k.to_string();
        if truthy(item.get("off")).is_some() {
            by_key.retain(|(have, _)| *have != k);
            continue;
        }
        let current = by_key
            .iter()
            .find(|(have, _)| *have == k)
            .map(|(_, r)| r.clone())
            .or_else(|| builtin_role(&k))
            .unwrap_or_else(|| {
                let mut m = Map::new();
                m.insert("key".into(), json!(k));
                m.insert("name".into(), json!(k));
                m.insert("description".into(), json!(k));
                m.insert("prompt".into(), json!(""));
                m.insert("model".into(), Value::Null);
                m.insert("effort".into(), Value::Null);
                m.insert("tools".into(), Value::Null);
                m.insert("writes".into(), json!("nothing"));
                m
            });
        let mut merged = current;
        for (kk, v) in item {
            if kk != "off" {
                merged.insert(kk.clone(), v.clone());
            }
        }
        match by_key.iter_mut().find(|(have, _)| *have == k) {
            Some(slot) => slot.1 = merged,
            None => by_key.push((k.clone(), merged)),
        }
        if !order.contains(&k) {
            order.push(k);
        }
    }
    Ok(order.iter().filter_map(|k| by_key.iter().find(|(have, _)| have == k).map(|(_, r)| r.clone())).collect())
}

/// The text `x` of `(a, b, c)` kept by `"\n\n".join(x for x in ... if x)`.
fn join_nonempty(parts: &[&str]) -> String {
    parts.iter().copied().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

fn prompt_of(role: &Role) -> String {
    match truthy(role.get("prompt")) {
        Some(Value::String(s)) => s.clone(),
        Some(other) => pyjson::py_str(other),
        None => String::new(),
    }
}

/// What `claude --agents` takes: `{name: {description, prompt, model?, tools?}}`.
pub fn agents_json(roles: &[Role], board_rules: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for r in roles {
        let key = r.get("key").cloned().unwrap_or(Value::Null);
        let skill = kb_skills::role_skills::ROLE_SKILLS
            .iter()
            .find(|(k, _n, _d, _b)| key.as_str() == Some(*k))
            .map(|(_k, n, _d, _b)| *n);
        let guide = match skill {
            Some(n) => format!(
                "Your role's guide is the skill `kanban-board:{n}`: open it with the Skill tool before you start."
            ),
            None => String::new(),
        };
        let mut spec = Map::new();
        spec.insert(
            "description".into(),
            first_truthy(r.get("description"), Some(&key)).cloned().unwrap_or(Value::Null),
        );
        spec.insert("prompt".into(), json!(join_nonempty(&[&prompt_of(r), &guide, board_rules])));
        if let Some(model) = truthy(r.get("model")) {
            spec.insert("model".into(), model.clone());
        }
        if let Some(Value::Array(tools)) = truthy(r.get("tools")) {
            spec.insert("tools".into(), Value::Array(tools.clone()));
        }
        out.insert(pyjson::py_str(&key), Value::Object(spec));
    }
    out
}

/// One `agents/<key>.md` of a plugin: frontmatter (name, description, model, tools) and the prompt.
pub fn agent_markdown(role: &Role, board_rules: &str) -> String {
    let key = role.get("key").cloned().unwrap_or(Value::Null);
    let description = first_truthy(role.get("description"), Some(&key)).cloned().unwrap_or(Value::Null);
    let mut lines = vec![
        "---".to_string(),
        format!("name: {}", pyjson::py_str(&key)),
        format!("description: {}", pyjson::dumps(&description)),
    ];
    if let Some(model) = truthy(role.get("model")) {
        lines.push(format!("model: {}", pyjson::py_str(model)));
    }
    if let Some(Value::Array(tools)) = truthy(role.get("tools")) {
        let names: Vec<String> = tools.iter().map(pyjson::py_str).collect();
        lines.push(format!("tools: {}", names.join(", ")));
    }
    lines.push("---".to_string());
    let body = join_nonempty(&[&prompt_of(role), board_rules]);
    format!("{}\n\n{}\n", lines.join("\n"), body)
}

/// The roles as the API shows them.
pub fn public(roles: &[Role]) -> Vec<Value> {
    roles
        .iter()
        .map(|r| {
            let get = |k: &str| r.get(k).cloned().unwrap_or(Value::Null);
            json!({
                "key": get("key"),
                "name": get("name"),
                "description": get("description"),
                "prompt": get("prompt"),
                "model": get("model"),
                "effort": get("effort"),
                "tools": get("tools"),
                "writes": get("writes"),
            })
        })
        .collect()
}
