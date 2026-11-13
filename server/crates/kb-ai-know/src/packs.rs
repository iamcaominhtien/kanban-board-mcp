//! Role packs: everything that makes an AI a role, in one object you can export, import and version
//! (design/screens/ai-team-process.md, C; plan D15). Port of `services/ai/packs.py`.
//!
//! A pack is: who it is (persona), model and effort, its plugins and MCP servers from the catalog, where it may write,
//! what it must hand in, and its limits. There is no permission template, status ceiling or tool list (AI v2: bypass
//! plus a short deny list). Twelve are ready-made; the four presets of `memberPresets.json` are the first four. A
//! project can add its own, and every edit makes a new version so a member keeps the version it was made from until
//! someone updates it.
//!
//! A pack is a `serde_json::Map` (a Python dict, key order kept). The ready-made packs are in `text/packs.json` (every
//! field but the persona) and `text/personas/<key>.txt` (the persona up to the closing `_rules(key)` sentence); the
//! golden test `golden_ai_know` proves the assembled packs equal to Python's.

use std::sync::LazyLock;

use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::{ai_plugin, ai_role_pack};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter};
use serde_json::{Map, Value, json};

use crate::plugins;

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `ValueError`: the text is the message.
    Value(String),
    /// The database call failed.
    Db(DbErr),
    /// An install failed for a reason that is not a `PluginError` (the files, the database).
    Plugin(plugins::Error),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Value(text) => f.write_str(text),
            Error::Db(err) => write!(f, "{err}"),
            Error::Plugin(err) => write!(f, "{err}"),
        }
    }
}

fn value<T>(text: impl Into<String>) -> Result<T, Error> {
    Err(Error::Value(text.into()))
}

/// `FORMAT`: the `format` field of an exported pack.
pub const FORMAT: &str = "kanban-role-pack/1";

/// The ready-made packs' version: raised when their persona or tools change, so a member made from an older one is
/// offered the update (v2: the Designer, BA and PM write the files of a canvas or a diagram, the User tester starts the
/// app, every role knows which drawing to use)
/// v3: the Designer looks at its frames in a browser and starts from tokens; the PM judges design
/// v4: the Designer drops Anthropic's canvas-design (it shadows the board's guide) and Figma
/// v5: the Designer presents a design document (foundations, states side by side, a spec per screen)
/// v6: the Designer explores three directions, reads craft.md, critiques its own screens and gets taste-skill
/// v7: the Designer gets the niche design skills (polish, UI rules, motion, charts)
/// v8: the Designer keeps only motion, chart and checking skills; the guide sets the look
/// v9: every persona points to the board's shared skills (issue #277) instead of repeating them
/// v10: the Designer looks at its frames with docs_read(picture); PM, BA, Designer and Dev point to the draw.io guide;
/// the BA draws a flow with branches, the Dev draws the architecture it documents, not only what it changes (live
/// runs, #267)
/// v11: every role has its own skill (issue #273), and four more roles are ready-made
pub const BUILTIN_VERSION: i64 = 11;

/// `_rules(key)`: how every role works a ticket (stay in it, report the truth, ask, prove it) is in the board's rules
/// and its shared skills (`shared_skills`, issue #277), and each role's craft in its own skill (`role_skills`, issue
/// #273): a persona says who the role is and points to them.
pub fn rules(key: &str) -> String {
    let shared = "How to work a ticket, prove it, ask and work with the other roles: the board's shared skills (`kanban-board:*`).";
    if key == "designer" {
        return shared.to_string(); // its persona opens with its guide already
    }
    let skill = kb_skills::role_skills::skill_of_role()
        .into_iter()
        .find(|(role, _)| *role == key)
        .map(|(_, name)| name)
        .unwrap_or_default();
    format!("Your craft: the skill `kanban-board:{skill}`. {shared}")
}

/// The persona up to the closing `_rules(key)` sentence of each ready-made role.
fn persona_head(key: &str) -> &'static str {
    match key {
        "triage" => include_str!("text/personas/triage.txt"),
        "pm" => include_str!("text/personas/pm.txt"),
        "ba" => include_str!("text/personas/ba.txt"),
        "designer" => include_str!("text/personas/designer.txt"),
        "dev" => include_str!("text/personas/dev.txt"),
        "reviewer" => include_str!("text/personas/reviewer.txt"),
        "qa" => include_str!("text/personas/qa.txt"),
        "user_tester" => include_str!("text/personas/user_tester.txt"),
        "tech_writer" => include_str!("text/personas/tech_writer.txt"),
        "devops" => include_str!("text/personas/devops.txt"),
        "security" => include_str!("text/personas/security.txt"),
        "data_analyst" => include_str!("text/personas/data_analyst.txt"),
        _ => "",
    }
}

/// `BUILTIN`: the twelve ready-made packs, in order.
pub static BUILTIN: LazyLock<Vec<Map<String, Value>>> = LazyLock::new(|| {
    let list: Vec<Map<String, Value>> = serde_json::from_str(include_str!("text/packs.json")).unwrap_or_default();
    list.into_iter()
        .map(|mut pack| {
            let key = pack.get("key").and_then(Value::as_str).unwrap_or_default().to_string();
            pack.insert("persona".into(), Value::String(format!("{}{}", persona_head(&key), rules(&key))));
            pack
        })
        .collect()
});

/// `BUILTIN_KEYS`.
pub static BUILTIN_KEYS: LazyLock<Vec<String>> = LazyLock::new(|| {
    BUILTIN.iter().map(|p| p.get("key").and_then(Value::as_str).unwrap_or_default().to_string()).collect()
});

/// `_FIELDS`: the fields a pack carries.
pub const FIELDS: [&str; 14] = [
    "name",
    "glyph",
    "tagline",
    "model",
    "retry_model",
    "effort",
    "depth_models",
    "writes",
    "hands_in",
    "plugins",
    "mcp",
    "personas",
    "limits",
    "persona",
];

fn is_field(key: &str) -> bool {
    FIELDS.contains(&key)
}

/// A role pack key in words ("user_tester" -> "User tester"); a project's own key as it is.
pub fn role_name(key: Option<&str>) -> String {
    let found = key.and_then(|k| BUILTIN.iter().find(|p| p.get("key").and_then(Value::as_str) == Some(k)));
    match found {
        // `found["name"].split(" (")[0]`
        Some(p) => {
            p.get("name").and_then(Value::as_str).unwrap_or_default().split(" (").next().unwrap_or("").to_string()
        }
        None => key.unwrap_or("").replace('_', " "),
    }
}

fn now() -> String {
    kb_base::time::now_iso()
}

/// A ready-made pack by key (a copy).
pub fn builtin(key: &str) -> Option<Map<String, Value>> {
    BUILTIN.iter().find(|p| p.get("key").and_then(Value::as_str) == Some(key)).cloned()
}

fn body_of(text: &str) -> Map<String, Value> {
    // `json.loads(row.body or "{}")`
    let text = if text.is_empty() { "{}" } else { text };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// A stored pack for the API.
pub fn to_dict(row: &ai_role_pack::Model) -> Map<String, Value> {
    let body = body_of(&row.body);
    let mut out: Map<String, Value> = body.into_iter().filter(|(k, _)| is_field(k)).collect();
    out.insert("id".into(), json!(row.id));
    out.insert("key".into(), json!(row.key));
    out.insert("name".into(), json!(row.name));
    out.insert("project_id".into(), json!(row.project_id));
    out.insert("version".into(), json!(row.version));
    out.insert("builtin".into(), json!(false));
    out.insert("created_at".into(), json!(row.created_at));
    out.insert("updated_at".into(), json!(row.updated_at));
    out.insert("updated_by".into(), json!(row.updated_by));
    out
}

fn builtin_view(base: &Map<String, Value>, key: &str) -> Map<String, Value> {
    let mut out = base.clone();
    out.insert("id".into(), json!(format!("builtin:{key}")));
    out.insert("version".into(), json!(BUILTIN_VERSION));
    out.insert("builtin".into(), json!(true));
    out
}

fn lower(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_lowercase()
}

/// The ready-made packs and the project's own, the project's version winning when it reuses a key.
pub async fn list_packs(session: &Session, project_id: &str) -> Result<Vec<Map<String, Value>>, DbErr> {
    let own = ai_role_pack::Entity::find().filter(ai_role_pack::Column::ProjectId.eq(project_id)).all(session).await?;
    // `{r.key: to_dict(r) for r in own}`: a later row with the same key replaces the earlier one in place
    let mut by_key: Vec<(String, Map<String, Value>)> = Vec::new();
    for r in &own {
        let dict = to_dict(r);
        match by_key.iter_mut().find(|(k, _)| *k == r.key) {
            Some(slot) => slot.1 = dict,
            None => by_key.push((r.key.clone(), dict)),
        }
    }
    let mut out = Vec::new();
    for p in BUILTIN.iter() {
        let key = p.get("key").and_then(Value::as_str).unwrap_or_default();
        match by_key.iter().position(|(k, _)| k == key) {
            Some(at) => out.push(by_key.remove(at).1),
            None => out.push(builtin_view(p, key)),
        }
    }
    let mut rest: Vec<Map<String, Value>> = by_key.into_iter().map(|(_, v)| v).collect();
    rest.sort_by_key(|p| lower(p.get("name").unwrap_or(&Value::Null)));
    out.extend(rest);
    Ok(out)
}

async fn row_of(session: &Session, project_id: &str, key: &str) -> Result<Option<ai_role_pack::Model>, DbErr> {
    ai_role_pack::Entity::find()
        .filter(ai_role_pack::Column::ProjectId.eq(project_id))
        .filter(ai_role_pack::Column::Key.eq(key))
        .one(session)
        .await
}

/// One pack by key: the project's own version, else the ready-made one.
pub async fn get_pack(session: &Session, project_id: &str, key: &str) -> Result<Option<Map<String, Value>>, DbErr> {
    if let Some(row) = row_of(session, project_id, key).await? {
        return Ok(Some(to_dict(&row)));
    }
    Ok(builtin(key).map(|found| builtin_view(&found, key)))
}

/// `str(value)` of the values a pack field may hold.
fn text_of(value: &Value) -> String {
    pyjson::py_str(value)
}

fn get_truthy<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key).filter(|v| pyjson::truthy(v))
}

/// Only a pack's known fields, checked.
pub fn clean(body: &Map<String, Value>) -> Result<Map<String, Value>, Error> {
    let mut out: Map<String, Value> = Map::new();
    for k in FIELDS {
        if let Some(v) = body.get(k) {
            out.insert(k.to_string(), v.clone());
        }
    }
    // `not str(out.get("name") or "").strip()`
    let name = get_truthy(&out, "name").map(text_of).unwrap_or_default();
    if kb_base::pytext::strip(&name).is_empty() {
        return value("A pack needs a name.");
    }
    if let Some(model) = get_truthy(&out, "model") {
        let known = ["haiku", "sonnet", "opus"].iter().any(|m| model.as_str() == Some(m));
        if !known && !text_of(model).contains('-') {
            return value("The model is haiku, sonnet, opus or a full model id.");
        }
    }
    if let Some(effort) = get_truthy(&out, "effort") {
        let known = ["low", "medium", "high", "xhigh", "max"].iter().any(|m| effort.as_str() == Some(m));
        if !known {
            return value("The effort is low, medium, high, xhigh or max.");
        }
    }
    for key in ["plugins", "mcp", "personas"] {
        match out.get(key) {
            // the edit dialog sends `personas: null` for every pack without personas (all but the User tester):
            // nothing to change, not a bad value (it refused every save of the PM pack with a 422)
            Some(Value::Null) => {
                out.shift_remove(key);
            }
            Some(Value::Array(_)) | None => {}
            Some(_) => return value(format!("{key} must be a list.")),
        }
    }
    Ok(out)
}

/// `re.sub(r"[^a-z0-9_]+", "_", (key or "").lower()).strip("_")`.
fn slug(key: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in key.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out.trim_matches('_').to_string()
}

/// Create or edit the project's pack `key` (editing a ready-made one makes the project's own copy). Every save is a new
/// version; the earlier one goes into the history.
pub async fn save_pack(
    session: &Session,
    project_id: &str,
    key: &str,
    body: &Map<String, Value>,
    by: &str,
) -> Result<Map<String, Value>, Error> {
    let key = slug(key);
    if key.is_empty() {
        return value("A pack needs a key.");
    }
    let fields = clean(body)?;
    let stored = row_of(session, project_id, &key).await?;
    let (existing, merged, fallback_name, mut row) = match stored {
        None => {
            let base = builtin(&key).unwrap_or_default();
            let name = get_truthy(&fields, "name")
                .or_else(|| get_truthy(&base, "name"))
                .map(text_of)
                .unwrap_or_else(|| key.clone());
            let mut row = ai_role_pack::new();
            row.project_id = Set(project_id.to_string());
            row.key = Set(key.clone());
            let mut merged: Map<String, Value> = base.into_iter().filter(|(k, _)| is_field(k)).collect();
            for (k, v) in fields {
                merged.insert(k, v);
            }
            (None, merged, name, row)
        }
        Some(current) => {
            let mut history: Vec<Value> =
                match serde_json::from_str::<Value>(if current.history.is_empty() { "[]" } else { &current.history }) {
                    Ok(Value::Array(items)) => items,
                    _ => Vec::new(),
                };
            history.push(json!({
                "version": current.version,
                "body": Value::Object(body_of(&current.body)),
                "at": current.updated_at,
                "by": current.updated_by,
            }));
            let keep = history.len().saturating_sub(20);
            let mut merged = body_of(&current.body);
            for (k, v) in fields {
                merged.insert(k, v);
            }
            let mut row = ai_role_pack::ActiveModel::from(current.clone());
            row.history = Set(pyjson::dumps(&history[keep..].to_vec()));
            row.version = Set(current.version + 1);
            let name = current.name.clone();
            (Some(current), merged, name, row)
        }
    };
    row.name = Set(get_truthy(&merged, "name").map(text_of).unwrap_or(fallback_name));
    row.body = Set(pyjson::dumps(&Value::Object(merged)));
    row.updated_at = Set(now());
    row.updated_by = Set(Some(by.to_string()));
    let saved = match existing {
        None => row.insert(session).await?,
        Some(read) => {
            // only what differs from the row as it was read
            let mut changed = kb_db::edit(read);
            *changed = row;
            changed.update(session).await?
        }
    };
    session.commit().await?;
    Ok(to_dict(&saved))
}

/// Remove the project's own pack (a ready-made one comes back in its place).
pub async fn delete_pack(session: &Session, project_id: &str, key: &str) -> Result<bool, DbErr> {
    let Some(row) = row_of(session, project_id, key).await? else { return Ok(false) };
    row.delete(session).await?;
    session.commit().await?;
    Ok(true)
}

/// One file that carries the whole pack.
pub fn export(pack: &Map<String, Value>) -> Value {
    let mut inner = Map::new();
    for k in FIELDS {
        if let Some(v) = pack.get(k) {
            inner.insert(k.to_string(), v.clone());
        }
    }
    json!({
        "format": FORMAT,
        "key": pack.get("key").cloned().unwrap_or(Value::Null),
        "version": pack.get("version").cloned().unwrap_or(json!(1)),
        "pack": Value::Object(inner),
    })
}

/// Import a pack file into the project. Returns `{pack, missing}`: the plugins and MCP servers it names that the project
/// does not have yet, so the screen can say what it could not find.
pub async fn import_pack(session: &Session, project_id: &str, data: &Value, by: &str) -> Result<Value, Error> {
    let Some(obj) = data.as_object().filter(|o| o.get("format") == Some(&json!(FORMAT))) else {
        return value("This is not a role pack file.");
    };
    let pack_body: Map<String, Value> = match obj.get("pack") {
        Some(Value::Object(p)) => p.clone(),
        _ => Map::new(),
    };
    let key_value =
        get_truthy(obj, "key").cloned().unwrap_or_else(|| pack_body.get("name").cloned().unwrap_or(json!("")));
    let key = match &key_value {
        Value::String(s) => s.clone(),
        other => text_of(other),
    };
    let pack = save_pack(session, project_id, &key, &pack_body, by).await?;
    let installed: std::collections::HashSet<String> = ai_plugin::Entity::find()
        .filter(ai_plugin::Column::ProjectId.eq(project_id))
        .all(session)
        .await?
        .into_iter()
        .map(|p| p.name)
        .collect();
    let missing: Vec<Value> = match pack.get("plugins") {
        Some(Value::Array(items)) => {
            items.iter().filter(|p| !p.as_str().is_some_and(|name| installed.contains(name))).cloned().collect()
        }
        _ => Vec::new(),
    };
    Ok(json!({"pack": Value::Object(pack), "missing": missing}))
}

/// The catalogue of plugins and MCP servers (imported late: plugins imports packs).
pub fn plugins_catalogue() -> &'static [Map<String, Value>] {
    &plugins::CATALOGUE
}

/// The catalogue plugins a pack names, installed on the project once (a member made from the pack gets them by its
/// role). MCP servers ride on the member itself (member_body). Returns what was installed and what failed.
pub async fn install_plugins(
    session: &Session,
    project_id: &str,
    pack: &Map<String, Value>,
    by: &str,
) -> Result<Value, Error> {
    let mut have: std::collections::HashSet<String> = ai_plugin::Entity::find()
        .filter(ai_plugin::Column::ProjectId.eq(project_id))
        .all(session)
        .await?
        .into_iter()
        .map(|p| p.name)
        .collect();
    let mut installed: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let keys: Vec<Value> = match pack.get("plugins") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    for key in keys {
        let Some(key) = key.as_str() else { continue };
        let Some(entry) = plugins::CATALOGUE.iter().find(|c| c.get("key").and_then(Value::as_str) == Some(key)) else {
            continue;
        };
        if entry.get("kind").and_then(Value::as_str) != Some("plugin") {
            continue;
        }
        let name = entry.get("name").and_then(Value::as_str).unwrap_or_default();
        let plugin = entry.get("plugin").and_then(Value::as_str);
        if have.contains(key) || have.contains(name) || plugin.is_some_and(|p| have.contains(p)) {
            continue;
        }
        let opts = plugins::InstallOpts {
            source_kind: "marketplace",
            source: entry.get("source").and_then(Value::as_str).unwrap_or_default(),
            ref_: None,
            plugin,
            skills: string_list(entry.get("skills")),
            roles: string_list(entry.get("roles")),
            default_on: false,
            by,
        };
        match plugins::install(session, project_id, opts).await {
            Ok(plug) => {
                have.insert(plug.name.clone());
                installed.push(json!(plug.name));
            }
            Err(plugins::Error::Plugin(why)) => failed.push(json!({"plugin": key, "why": why})),
            Err(other) => return Err(Error::Plugin(other)),
        }
    }
    Ok(json!({"installed": installed, "failed": failed}))
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        Some(Value::Array(items)) => Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
        _ => None,
    }
}
