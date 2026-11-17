//! Public links: "Anyone with the link can read" for one page (design board "Reader", frames 38-46 and 69).
//!
//! A page owner (anyone who can edit the page) turns a link on; it shows the published version only, without the
//! app, the tree, comments or highlights. An admin can switch public links off for the whole project
//! (`allowPublicLinks`), which stops every link of it. A link can expire; a link that is off, expired or whose page
//! is gone answers 404 with no hint of what the page was.

use kb_base::{activity, time};
use kb_db::Session;
use kb_db::entities::{docs_page, docs_public_link};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde_json::{Map, Value, json};

use super::body::PageBody;
use super::pages::{get_page, latest_version, project};
use super::settings::read_settings;
use crate::{Result, docs_err};

/// What a page owner chooses for its link.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct PublicLinkSet {
    /// Turn the link on (true) or off (false).
    pub on: bool,
    /// Show who wrote the page.
    #[serde(default)]
    pub show_names: Option<bool>,
    /// Let search engines index it.
    #[serde(default)]
    pub allow_index: Option<bool>,
    /// `never`, `7d`, `30d` or `90d` from now (default: the project's default).
    #[serde(default)]
    pub expires: Option<String>,
}

fn link_json(l: &docs_public_link::Model) -> Value {
    json!({
        "token": l.token,
        "path": format!("/?public={}", l.token),
        "created_by": l.created_by,
        "created_at": l.created_at,
        "expires_at": l.expires_at,
        "show_names": l.show_names,
        "allow_index": l.allow_index,
    })
}

async fn live_link(session: &Session, page_id: &str) -> Result<Option<docs_public_link::Model>> {
    Ok(docs_public_link::Entity::find()
        .filter(docs_public_link::Column::PageId.eq(page_id))
        .filter(docs_public_link::Column::RevokedAt.is_null())
        .order_by_desc(docs_public_link::Column::CreatedAt)
        .one(session)
        .await?)
}

fn expired(l: &docs_public_link::Model) -> bool {
    l.expires_at.as_deref().is_some_and(|e| !e.is_empty() && e <= time::now_iso().as_str())
}

/// The page's public link state: `{allowed, link}` (`link` null when off).
///
/// # Errors
/// The page errors.
pub async fn public_link(session: &Session, page_id: &str) -> Result<Value> {
    let page = get_page(session, page_id, false, false).await?;
    let project = project(session, &page.project_id, false).await?;
    let allowed = super::space::read(&project).get("allowPublicLinks").and_then(Value::as_bool).unwrap_or(true);
    let link = live_link(session, page_id).await?.filter(|l| !expired(l));
    Ok(json!({"allowed": allowed, "link": link.as_ref().map(link_json)}))
}

/// Turns a page's public link on (a new token, or new options for the live one) or off.
///
/// # Errors
/// 403 `public_links_off` when the project does not allow them; 422 `bad_expiry`; 409 `not_published` for a page
/// never published; the page errors (edit rights).
pub async fn set_public_link(session: &Session, page_id: &str, req: &PublicLinkSet) -> Result<Value> {
    let page = get_page(session, page_id, false, true).await?;
    let project = project(session, &page.project_id, true).await?;
    let space = super::space::read(&project);
    let current = live_link(session, page_id).await?;
    if !req.on {
        if let Some(l) = current {
            let mut row = kb_db::edit(l);
            row.revoked_at = Set(Some(time::now_iso()));
            row.update(session).await?;
            session.commit().await?;
        }
        return public_link(session, page_id).await;
    }
    if !space.get("allowPublicLinks").and_then(Value::as_bool).unwrap_or(true) {
        return docs_err(403, "public_links_off", "Public links are turned off for this project.");
    }
    if page.version == 0 {
        return docs_err(409, "not_published", "Publish the page before you share it publicly.");
    }
    let expiry = req
        .expires
        .clone()
        .or_else(|| space.get("publicLinkExpiry").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "never".into());
    let days = match expiry.as_str() {
        "never" => None,
        "7d" => Some(7),
        "30d" => Some(30),
        "90d" => Some(90),
        _ => return docs_err(422, "bad_expiry", "A link expires never, or after 7, 30 or 90 days"),
    };
    let expires_at = days.map(|d| (chrono::Utc::now() + chrono::Duration::days(d)).to_rfc3339());
    match current.filter(|l| !expired(l)) {
        Some(l) => {
            let mut row = kb_db::edit(l);
            if let Some(v) = req.show_names {
                row.show_names = Set(v);
            }
            if let Some(v) = req.allow_index {
                row.allow_index = Set(v);
            }
            if req.expires.is_some() {
                row.expires_at = Set(expires_at);
            }
            row.update(session).await?;
        }
        None => {
            let mut row = docs_public_link::new();
            row.page_id = Set(page.id.clone());
            row.token = Set(token());
            row.created_by = Set(activity::current_actor());
            row.expires_at = Set(expires_at);
            row.show_names = Set(req.show_names.unwrap_or(false));
            row.allow_index = Set(req.allow_index.unwrap_or(false));
            row.insert(session).await?;
        }
    }
    session.commit().await?;
    public_link(session, page_id).await
}

/// A link token: 32 hex characters from two random uuids (128 bits of randomness).
fn token() -> String {
    let a = uuid_hex();
    a.chars().take(32).collect()
}

fn uuid_hex() -> String {
    format!("{}{}", time::uuid4_hex(), time::uuid4_hex())
}

/// What a public link shows: the published page, without the app (no auth; anyone with the token).
///
/// # Errors
/// 404 `public_link_not_found` for an unknown, revoked or expired token, a deleted or unpublished page, or a
/// project whose public links are off (the same answer for all, so nothing leaks).
pub async fn public_page(session: &Session, token: &str) -> Result<Map<String, Value>> {
    let gone = || docs_err(404, "public_link_not_found", "This link is no longer public.");
    if token.len() != 32 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return gone();
    }
    let Some(link) = docs_public_link::Entity::find()
        .filter(docs_public_link::Column::Token.eq(token))
        .filter(docs_public_link::Column::RevokedAt.is_null())
        .one(session)
        .await?
    else {
        return gone();
    };
    if expired(&link) {
        return gone();
    }
    let Some(page) = docs_page::Entity::find_by_id(link.page_id.as_str()).one(session).await? else { return gone() };
    if page.deleted_at.as_deref().is_some_and(|d| !d.is_empty()) {
        return gone();
    }
    let Some(project) = kb_db::entities::project::Entity::find_by_id(page.project_id.as_str()).one(session).await?
    else {
        return gone();
    };
    if !project.docs_enabled
        || !super::space::read(&project).get("allowPublicLinks").and_then(Value::as_bool).unwrap_or(true)
    {
        return gone();
    }
    let Some(latest) = latest_version(session, &page).await? else { return gone() };
    let body = PageBody::of_version(&latest);
    let mut out = Map::new();
    out.insert("title".into(), json!(page.title));
    out.insert("format".into(), json!(body.format.as_str()));
    out.insert("content".into(), body.content.unwrap_or(Value::Null));
    out.insert("markdown".into(), json!(body.markdown));
    out.insert("settings".into(), Value::Object(read_settings(page.settings.as_deref())));
    out.insert("version".into(), json!(page.version));
    out.insert("updated_at".into(), json!(latest.created_at));
    out.insert("author".into(), if link.show_names { json!(latest.author) } else { Value::Null });
    out.insert("project".into(), if link.show_names { json!(project.name) } else { Value::Null });
    out.insert("allow_index".into(), json!(link.allow_index));
    Ok(out)
}
