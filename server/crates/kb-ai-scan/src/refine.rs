//! Asking the light model to refine the suggestion (`repo_scan.py` lines 715-831: `REFINE_PROMPT`, `_ask_light`,
//! `_claude_account`, `_parse_refined`, `refine_suggestion`).

use std::sync::LazyLock;

use kb_ai_know::knowledge;
use kb_ai_know::plugins::CATALOGUE;
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_account, ai_team};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, TryIntoModel};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::job::text_of;
use crate::pyfs::py_iter;
use crate::seams::{self, AskError};
use crate::suggest::{ROLE_NAMES, role_name, wanted};

/// `REFINE_PROMPT`: what the light model is told; the catalogue and the facts are added after it.
pub const REFINE_PROMPT: &str = include_str!("text/refine_prompt.txt");

/// One call of the light model (Haiku) on the project's Claude Code account.
pub(crate) async fn ask_light_real(prompt: &str, account: Option<&ai_account::Model>) -> Option<String> {
    // `SimpleNamespace(cli_path=None)`: a profile that has no CLI path of its own
    let mut blank = ai_team::new();
    blank.id = Set(String::new());
    blank.project_id = Set(String::new());
    let profile = blank.try_into_model().ok()?;
    knowledge::ask_light_model(prompt, &profile, account).await
}

/// A signed-in Claude Code account of the board (the chosen one first), or None.
pub(crate) async fn claude_account(
    session: &Session,
    account_id: Option<&str>,
) -> Result<Option<ai_account::Model>, DbErr> {
    if let Some(id) = account_id.filter(|id| !id.is_empty()) {
        if let Some(acct) = ai_account::Entity::find_by_id(id).one(session).await? {
            if acct.cli == "claude" {
                return Ok(Some(acct));
            }
        }
    }
    ai_account::Entity::find()
        .filter(ai_account::Column::Cli.eq("claude"))
        .filter(ai_account::Column::Status.eq("signed_in"))
        .order_by_asc(ai_account::Column::CreatedAt)
        .order_by_asc(ai_account::Column::Id)
        .one(session)
        .await
}

static BRACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\{.*\}").expect("a fixed pattern"));

/// The JSON object an answer holds (from its first `{` to its last `}`), or None.
pub fn parse_refined(text: Option<&str>) -> Option<Map<String, Value>> {
    let m = BRACES.find(text.unwrap_or(""))?;
    match pyjson::loads(m.as_str())? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Ask a light model to refine the suggested team and plugins from the scan's facts. Optional and soft: with no Claude
/// Code account, an error or an answer that makes no sense, the code's suggestion comes back unchanged.
pub async fn refine_suggestion(
    session: &Session,
    project_id: &str,
    found: &Value,
    proposal: &Value,
    account_id: Option<&str>,
) -> Value {
    let _ = project_id;
    match refine(session, found, proposal, account_id).await {
        Ok(out) => out,
        Err(why) => {
            // a light-model failure never breaks a scan
            tracing::warn!("repo scan: the light-model refinement failed: {why}");
            proposal.clone()
        }
    }
}

async fn refine(session: &Session, found: &Value, proposal: &Value, account_id: Option<&str>) -> Result<Value, String> {
    let account = claude_account(session, account_id).await.map_err(|e| e.to_string())?;
    let Some(account) = account else { return Ok(proposal.clone()) };
    let mut facts = Map::new();
    for k in ["languages", "frameworks", "monorepo", "ui", "tests", "agent_files"] {
        facts.insert(k.to_string(), found.get(k).cloned().unwrap_or(Value::Null));
    }
    let ui = found.get("ui").is_some_and(pyjson::truthy);
    let catalogue: Vec<String> = CATALOGUE
        .iter()
        .filter(|c| ui || !c.get("ui").is_some_and(pyjson::truthy))
        .map(|c| {
            let what: String = c.get("what").map(text_of).unwrap_or_default().chars().take(60).collect();
            format!("{}: {what}", c.get("key").map(text_of).unwrap_or_default())
        })
        .collect();
    let prompt = format!("{REFINE_PROMPT}{}\nFacts: {}", catalogue.join("; "), pyjson::dumps(&Value::Object(facts)));
    let said = match seams::asker().ask_light(&prompt, Some(&account)).await {
        Ok(said) => said,
        Err(AskError::Failed(why)) => return Err(why),
        Err(AskError::Cancelled) => return Err("cancelled".into()),
    };
    let Some(answer) = parse_refined(said.as_deref()) else { return Ok(proposal.clone()) };
    let team = proposal.get("team").and_then(Value::as_array).ok_or("'team'")?;
    let mut known: Vec<(String, Value)> = Vec::new();
    for t in team {
        let pack = t.get("pack").map(text_of).ok_or("'pack'")?;
        known.push((pack, t.get("name").cloned().ok_or("'name'")?));
    }
    let mut roles: Vec<String> = Vec::new();
    for r in py_iter(answer.get("roles")).map_err(|e| e.to_string())? {
        if let Value::String(r) = r {
            if role_name(&r).is_some() && (ui || !matches!(r.as_str(), "designer" | "user_tester")) {
                roles.push(r);
            }
        }
    }
    let allowed: Vec<String> =
        CATALOGUE.iter().filter(|c| wanted(c, found)).filter_map(|c| c.get("key").map(text_of)).collect();
    let mut keys: Vec<String> = Vec::new();
    for k in py_iter(answer.get("plugins")).map_err(|e| e.to_string())? {
        if let Value::String(k) = k {
            if allowed.contains(&k) {
                keys.push(k);
            }
        }
    }
    let mut out = proposal.as_object().cloned().ok_or("'dict' expected")?;
    if !roles.is_empty() {
        if !roles.iter().any(|r| r == "dev") {
            roles.push("dev".to_string());
        }
        let mut seen: Vec<String> = Vec::new();
        for r in roles {
            if !seen.contains(&r) {
                seen.push(r);
            }
        }
        seen.sort_by_key(|r| ROLE_NAMES.iter().position(|(k, _)| k == r));
        let team: Vec<Value> = seen
            .iter()
            .map(|r| {
                let known_name = known.iter().find(|(p, _)| p == r).map(|(_, n)| n.clone()).filter(pyjson::truthy);
                json!({"pack": r, "name": known_name.unwrap_or_else(|| json!(role_name(r).unwrap_or_default()))})
            })
            .collect();
        out.insert("team".into(), Value::Array(team));
    }
    if !keys.is_empty() {
        let mut unique: Vec<String> = Vec::new();
        for k in keys {
            if !unique.contains(&k) {
                unique.push(k);
            }
        }
        out.insert("plugins".into(), json!(unique));
    }
    let why_text = answer.get("why").filter(|v| pyjson::truthy(v)).map(text_of).unwrap_or_default();
    let why: String = pytext::squash(&why_text).chars().take(300).collect();
    if !why.is_empty() {
        let mut merged = match proposal.get("why") {
            None => Map::new(),
            Some(v) => crate::pyfs::mapping(v).map_err(|e| e.to_string())?,
        };
        merged.insert("refined".into(), json!(why));
        out.insert("why".into(), Value::Object(merged));
    }
    Ok(Value::Object(out))
}
