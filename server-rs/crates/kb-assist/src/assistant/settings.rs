//! Board-wide assistant settings (the `ai_assist_settings` row): feature switches, tone, caps; usage metering
//! (`services/assistant/settings.py`, lines 1 to 211).

use kb_ai::budget;
use kb_ai::store::{loads, now_iso};
use kb_base::{pyjson, time};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_assist_settings, ai_team, ai_usage, docs_ai_settings, member};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::sea_query::{Expr, Func, SimpleExpr};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};

use super::errors::{AssistError, Error};

/// The features a person can switch, and their labels.
pub const FEATURES: [(&str, &str); 5] = [
    ("chat", "Ask AI (chat)"),
    ("drafting", "Drafting in editors"),
    ("health", "Board health"),
    ("docs", "Docs AI"),
    ("sketch", "Sketch AI"),
];
/// What each feature is, in a line.
pub const DESCRIPTIONS: [(&str, &str); 5] = [
    ("chat", "Ask AI dock, ⌘J, answers with sources"),
    ("drafting", "Ask AI, rewrite and continue in every editor"),
    ("health", "Daily insights"),
    ("docs", "Summaries, sections, link suggestions"),
    ("sketch", "Draw and edit sketches with AI"),
];
/// The tones an answer can be asked in.
pub const TONES: [&str; 3] = ["neutral", "friendly", "concise"];
/// The longest style guide kept, in characters.
pub const STYLE_GUIDE_MAX: usize = 1000;

/// `DEFAULT_FEATURES`: every feature is on.
pub fn default_features() -> Map<String, Value> {
    FEATURES.iter().map(|(key, _)| (key.to_string(), json!(true))).collect()
}

/// `DEFAULT_HEALTH`: the board-health schedule of a new board.
pub fn default_health() -> Map<String, Value> {
    let value = json!({
        "on": true,
        "time": "08:00",
        "days": [0, 1, 2, 3, 4],
        "stuck_days": 3,
        "wip_limit": 3,
        "max_insights": 8,
        "return_if_worse": true,
        "weekend": false,
        "badge_toast": true,
    });
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `{**defaults, **loads(raw, {})}`: a stored value that is not an object adds nothing.
fn merged(mut defaults: Map<String, Value>, raw: &str) -> Map<String, Value> {
    if let Value::Object(stored) = loads(Some(raw), json!({})) {
        defaults.extend(stored);
    }
    defaults
}

/// The board-wide assistant settings, created with defaults on first use.
pub async fn get(session: &Session) -> Result<ai_assist_settings::Model, DbErr> {
    if let Some(row) = ai_assist_settings::Entity::find_by_id(1).one(session).await? {
        return Ok(row);
    }
    let mut row = ai_assist_settings::new();
    row.id = Set(1);
    database::insert_missing(session, row).await?;
    session.commit().await?;
    ai_assist_settings::Entity::find_by_id(1)
        .one(session)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("ai_assist_settings 1".to_string()))
}

/// The feature switches, with defaults.
pub fn features(row: &ai_assist_settings::Model) -> Map<String, Value> {
    merged(default_features(), &row.features)
}

/// The board-health schedule, with defaults.
pub fn health_config(row: &ai_assist_settings::Model) -> Map<String, Value> {
    merged(default_health(), &row.health)
}

/// Whether a feature is switched on.
pub async fn feature_on(session: &Session, feature: &str) -> Result<bool, DbErr> {
    Ok(features(&get(session).await?).get(feature).is_none_or(pyjson::truthy))
}

/// `round(x, digits)` as Python rounds a float: the nearest value of the exact number, ties to even.
pub(crate) fn round_to(x: f64, digits: usize) -> f64 {
    format!("{x:.digits$}").parse().unwrap_or(x)
}

/// What the assistants cost this month (one feature, or all).
pub async fn month_spend(session: &Session, feature: Option<&str>) -> Result<f64, DbErr> {
    let sum: Expr = Func::sum(Expr::col(ai_usage::Column::Cost)).into();
    let total: SimpleExpr = Func::coalesce([sum, Expr::val(0.0)]).into();
    let mut stmt =
        ai_usage::Entity::find().filter(ai_usage::Column::CreatedAt.gte(time::iso(&budget::month_start(None))));
    if let Some(feature) = feature.filter(|f| !f.is_empty()) {
        stmt = stmt.filter(ai_usage::Column::Feature.eq(feature));
    }
    let value: Option<f64> =
        stmt.select_only().expr_as(total, "total").into_tuple::<Option<f64>>().one(session).await?.flatten();
    Ok(round_to(value.unwrap_or(0.0), 4))
}

/// The keyword arguments of `record_usage`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Usage<'a> {
    /// Tokens the turn read.
    pub tokens_in: i64,
    /// Tokens the turn wrote.
    pub tokens_out: i64,
    /// What the turn cost.
    pub cost: f64,
    /// The AI team that answered, if one did.
    pub member_id: Option<&'a str>,
}

/// Meter one assistant turn (the usage page sums these).
pub async fn record_usage(
    session: &Session,
    project_id: &str,
    feature: &str,
    person: Option<&str>,
    usage: Usage<'_>,
) -> Result<ai_usage::Model, DbErr> {
    let mut row = ai_usage::new();
    row.project_id = Set(project_id.to_string());
    row.feature = Set(feature.to_string());
    row.member_id = Set(usage.member_id.map(str::to_string));
    row.person = Set(person.map(str::to_string));
    row.cost = Set(usage.cost);
    row.tokens_in = Set(i32::try_from(usage.tokens_in).unwrap_or(i32::MAX));
    row.tokens_out = Set(i32::try_from(usage.tokens_out).unwrap_or(i32::MAX));
    row.metered = Set(false);
    row.created_at = Set(now_iso());
    let row = row.insert(session).await?;
    session.commit().await?;
    Ok(row)
}

/// The project's first AI team: the assistant runs with its account, model and folder when there is one.
pub async fn first_team(session: &Session, project_id: &str) -> Result<Option<(member::Model, ai_team::Model)>, DbErr> {
    let rows = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.eq("ai"))
        .order_by_asc(member::Column::Name)
        .all(session)
        .await?;
    for m in rows {
        if let Some(profile) = ai_team::Entity::find_by_id(m.id.as_str()).one(session).await? {
            if !profile.paused {
                return Ok(Some((m, profile)));
            }
        }
    }
    Ok(None)
}

/// The AI team that answers a request of `feature`. Docs AI answers with the team chosen in Settings › Docs › AI
/// ("AI that answers"); with none chosen, or for any other feature, it is the project's first unpaused team.
///
/// Fails with `AssistError` `paused` when the team chosen for Docs AI is paused (the choice is not silently
/// replaced).
pub async fn answering_team(
    session: &Session,
    project_id: &str,
    feature: &str,
) -> Result<Option<(member::Model, ai_team::Model)>, Error> {
    if feature == "docs" {
        let row = docs_ai_settings::Entity::find_by_id(project_id).one(session).await?;
        if let Some(member_id) = row.and_then(|r| r.member_id).filter(|id| !id.is_empty()) {
            let member = member::Entity::find_by_id(member_id.as_str()).one(session).await?;
            let profile = ai_team::Entity::find_by_id(member_id.as_str()).one(session).await?;
            if let (Some(member), Some(profile)) = (member, profile) {
                if member.project_id == project_id && member.kind == "ai" {
                    if profile.paused {
                        return Err(AssistError::new(
                            "paused",
                            format!(
                                "{} is paused. Resume it in Members, or pick another AI team in Settings › Docs.",
                                member.name
                            ),
                        )
                        .into());
                    }
                    return Ok(Some((member, profile)));
                }
            }
        }
    }
    Ok(first_team(session, project_id).await?)
}

/// Settings › AI for a project, and the dock's state.
pub async fn describe(session: &Session, project_id: &str) -> Result<Map<String, Value>, DbErr> {
    let row = get(session).await?;
    let member = first_team(session, project_id).await?.map(|(member, _profile)| member);
    let switches = features(&row);
    let listed: Vec<Value> = FEATURES
        .iter()
        .map(|(key, label)| {
            let description = DESCRIPTIONS.iter().find(|(k, _)| k == key).map_or("", |(_, d)| *d);
            json!({
                "key": key,
                "label": label,
                "description": description,
                "on": switches.get(*key).cloned().unwrap_or(json!(true)),
            })
        })
        .collect();
    let mut out = Map::new();
    out.insert(
        "board_ai".into(),
        json!({
            "state": "ready",
            "id": member.as_ref().map(|m| m.id.clone()),
            "name": member.as_ref().map_or("Board AI", |m| m.name.as_str()),
            "provider": "claude-code",
            "provider_label": "Claude Code",
            "connection": "local",
            "metered": false,
            "status": null,
        }),
    );
    out.insert("features".into(), Value::Array(listed));
    out.insert("language".into(), json!(row.language));
    out.insert("tone".into(), json!(if row.tone.is_empty() { "neutral" } else { row.tone.as_str() }));
    out.insert("style_guide".into(), json!(row.style_guide));
    out.insert("style_guide_max".into(), json!(STYLE_GUIDE_MAX));
    out.insert("health".into(), Value::Object(health_config(&row)));
    out.insert("sent".into(), json!({}));
    Ok(out)
}

/// `(value or "")[:limit]`: a value that is true and not text cannot be cut (Python's `TypeError`).
fn cut(value: &Value, limit: usize) -> Result<String, Error> {
    match value {
        Value::String(text) => Ok(text.chars().take(limit).collect()),
        other if !pyjson::truthy(other) => Ok(String::new()),
        other => Err(Error::Other(format!("TypeError: {} cannot be cut", pyjson::py_repr(other)))),
    }
}

/// Change the board-wide assistant settings; keys left out stay as they are.
pub async fn update(session: &Session, data: &Map<String, Value>) -> Result<ai_assist_settings::Model, Error> {
    let row = get(session).await?;
    let mut changed = row.clone().into_active_model();
    if let Some(Value::Object(given)) = data.get("features") {
        let mut switches = features(&row);
        for (key, value) in given {
            if FEATURES.iter().any(|(k, _)| k == key) {
                switches.insert(key.clone(), json!(pyjson::truthy(value)));
            }
        }
        changed.features = Set(pyjson::dumps(&switches));
    }
    if let Some(language) = data.get("language") {
        changed.language = Set(cut(language, 40)?);
    }
    if let Some(tone) = data.get("tone").and_then(Value::as_str).filter(|tone| TONES.contains(tone)) {
        changed.tone = Set(tone.to_string());
    }
    if let Some(style_guide) = data.get("style_guide") {
        changed.style_guide = Set(cut(style_guide, STYLE_GUIDE_MAX)?);
    }
    if let Some(Value::Object(given)) = data.get("health") {
        let mut config = health_config(&row);
        config.extend(given.clone());
        changed.health = Set(pyjson::dumps(&config));
    }
    // an update that changes nothing writes nothing
    let row = if changed.is_changed() { changed.update(session).await? } else { row };
    session.commit().await?;
    Ok(row)
}
