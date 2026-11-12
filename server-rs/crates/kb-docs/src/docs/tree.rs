//! Move, duplicate, delete, restore and the Recycle Bin (`services/docs.py` lines 505-835).

use std::collections::{HashMap, HashSet};

use chrono::{Duration, Utc};
use kb_base::{activity, time};
use kb_db::Session;
use kb_db::entities::{
    docs_ai_ignore, docs_ai_job, docs_anchor_aliases, docs_draft, docs_link, docs_page, docs_page_seen,
    docs_title_aliases, docs_version,
};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, Set};
use serde_json::{Map, Value, json};

use super::RECYCLE_DAYS;
use super::pages::{all_pages, clean_title, draft_for, get_page, latest_version, next_position, page_detail, project};
use super::refs::refresh_link_targets;
use crate::{Result, docs_err, docs_search, hooks};

/// All the pages under `page`, depth first (the order `stack.pop()` of the Python code walks them).
pub async fn descendants(session: &Session, page: &docs_page::Model, deleted: bool) -> Result<Vec<docs_page::Model>> {
    let pages = all_pages(session, &page.project_id, deleted).await?;
    let mut by_parent: HashMap<Option<String>, Vec<docs_page::Model>> = HashMap::new();
    for p in pages {
        by_parent.entry(p.parent_id.clone()).or_default().push(p);
    }
    let mut out = Vec::new();
    let mut stack: Vec<docs_page::Model> = by_parent.get(&Some(page.id.clone())).cloned().unwrap_or_default();
    while let Some(cur) = stack.pop() {
        stack.extend(by_parent.get(&Some(cur.id.clone())).cloned().unwrap_or_default());
        out.push(cur);
    }
    Ok(out)
}

/// Move a page under a new parent, optionally next to a sibling.
///
/// `parent_id` is the new parent (none for the top level); `before_id` / `after_id` place it next to a sibling.
/// Fails with 422 if the parent is in another project or the anchor is not a sibling; 409 if the page would move
/// into itself or its sub-pages. Returns the moved page's detail.
pub async fn move_page(
    session: &Session,
    page_id: &str,
    parent_id: Option<&str>,
    before_id: Option<&str>,
    after_id: Option<&str>,
) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, true).await?;
    if let Some(parent_id) = parent_id {
        let parent = get_page(session, parent_id, false, false).await?;
        if parent.project_id != page.project_id {
            return docs_err(422, "bad_parent", "Parent belongs to another project");
        }
        if parent.id == page.id || descendants(session, &page, false).await?.iter().any(|d| d.id == parent.id) {
            return docs_err(409, "cycle", "A page cannot be moved into itself or its own sub-pages");
        }
    }
    let pages = all_pages(session, &page.project_id, false).await?;
    let siblings: Vec<&docs_page::Model> =
        pages.iter().filter(|p| p.parent_id.as_deref() == parent_id && p.id != page.id).collect();
    let mut ids: Vec<String> = siblings.iter().map(|p| p.id.clone()).collect();
    for anchor in [before_id, after_id] {
        if anchor.is_some_and(|a| !ids.iter().any(|i| i == a)) {
            return docs_err(422, "bad_anchor", "Anchor page is not a sibling at the target");
        }
    }
    let idx = if let Some(b) = before_id {
        ids.iter().position(|i| i == b).unwrap_or(ids.len())
    } else if let Some(a) = after_id {
        ids.iter().position(|i| i == a).map_or(ids.len(), |i| i + 1)
    } else {
        ids.len()
    };
    ids.insert(idx, page.id.clone());
    let by_pos: HashMap<&str, i32> = ids.iter().enumerate().map(|(i, id)| (id.as_str(), i as i32)).collect();
    let current: HashMap<&str, i32> = siblings.iter().map(|p| (p.id.as_str(), p.position)).collect();
    let mut me = page.clone().into_active_model();
    me.parent_id = Set(parent_id.map(str::to_string));
    me.updated_at = Set(time::now_iso());
    me.updated_by = Set(activity::current_actor());
    me.position = Set(by_pos[page.id.as_str()]);
    me.update(session).await?;
    for (id, pos) in &by_pos {
        if *id == page.id || current.get(id) == Some(pos) {
            continue;
        }
        let mut sibling = docs_page::ActiveModel { id: Set((*id).to_string()), ..Default::default() };
        sibling.position = Set(*pos);
        sibling.update(session).await?;
    }
    session.commit().await?;
    page_detail(session, page_id).await
}

/// Copy a page, and optionally its sub-pages, as drafts.
///
/// `title` is the title of the copy (default "<title> (copy)"); `parent_id` is used only when `parent_given` (none
/// then means top level). Returns the copy's detail.
pub async fn duplicate_page(
    session: &Session,
    page_id: &str,
    title: Option<&str>,
    parent_id: Option<&str>,
    include_children: bool,
    parent_given: bool,
) -> Result<Map<String, Value>> {
    let src = get_page(session, page_id, false, true).await?;
    let target_parent: Option<String> =
        if parent_given { parent_id.map(str::to_string) } else { src.parent_id.clone() };
    let wanted = match title.filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => format!("{} (copy)", src.title),
    };
    let new_title = clean_title(Some(&wanted))?;
    let root_id = copy_page(session, &src, &new_title, target_parent.as_deref()).await?;
    if include_children {
        copy_children(session, &src, &root_id).await?;
    }
    let root = docs_page::Entity::find_by_id(root_id.as_str()).one(session).await?;
    let mut copied = vec![root_id.clone()];
    if let Some(root) = root {
        copied.extend(descendants(session, &root, false).await?.into_iter().map(|d| d.id));
    }
    docs_search::reindex(session, &copied).await?;
    session.commit().await?;
    page_detail(session, &root_id).await
}

fn copy_children<'a>(
    session: &'a Session,
    src: &'a docs_page::Model,
    new_parent_id: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let pages = all_pages(session, &src.project_id, false).await?;
        let mut children: Vec<&docs_page::Model> =
            pages.iter().filter(|p| p.parent_id.as_deref() == Some(src.id.as_str())).collect();
        children.sort_by_key(|p| p.position);
        for child in children {
            let new_id = copy_page(session, child, &child.title, Some(new_parent_id)).await?;
            copy_children(session, child, &new_id).await?;
        }
        Ok(())
    })
}

async fn copy_page(session: &Session, src: &docs_page::Model, title: &str, parent_id: Option<&str>) -> Result<String> {
    let latest = latest_version(session, src).await?;
    let actor = activity::current_actor();
    let draft = draft_for(session, &src.id, &actor).await?;
    let markdown = match (&latest, &draft) {
        (Some(l), _) => l.markdown.clone(),
        (None, Some(d)) => d.markdown.clone(),
        _ => String::new(),
    };
    let mut page = docs_page::new();
    page.project_id = Set(src.project_id.clone());
    page.parent_id = Set(parent_id.map(str::to_string));
    page.position = Set(next_position(session, &src.project_id, parent_id).await?);
    page.title = Set(title.to_string());
    page.slug = Set(super::pages::unique_slug(session, &src.project_id, title).await?);
    page.created_by = Set(actor.clone());
    page.updated_by = Set(actor.clone());
    let page = page.insert(session).await?;
    let mut draft = docs_draft::new();
    draft.page_id = Set(page.id.clone());
    draft.author = Set(actor);
    draft.title = Set(title.to_string());
    draft.markdown = Set(markdown);
    draft.base_version = Set(0);
    draft.insert(session).await?;
    Ok(page.id)
}

/// Move a page and its sub-pages to the Recycle Bin: `{id, deleted_pages}`.
pub async fn delete_page(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, true).await?;
    let mut subtree = vec![page.clone()];
    subtree.extend(descendants(session, &page, false).await?);
    let (now, actor) = (time::now_iso(), activity::current_actor());
    for p in &subtree {
        let mut row = p.clone().into_active_model();
        row.deleted_at = Set(Some(now.clone()));
        row.deleted_by = Set(Some(actor.clone()));
        row.deleted_root_id = Set(Some(page.id.clone()));
        row.update(session).await?;
    }
    refresh_link_targets(session, &page.project_id).await?;
    docs_search::unindex(session, &subtree.iter().map(|p| p.id.clone()).collect::<Vec<_>>()).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("id".into(), json!(page.id));
    out.insert("deleted_pages".into(), json!(subtree.len()));
    Ok(out)
}

/// Restore a page and its sub-pages from the Recycle Bin: `{id, restored_pages, moved_to_top_level}`.
///
/// Fails with 409 if the page is not in the Recycle Bin.
pub async fn restore_page(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, true, true).await?;
    if page.deleted_at.as_deref().is_none_or(str::is_empty) {
        return docs_err(409, "not_deleted", "Page is not in the Recycle Bin");
    }
    let root = page.deleted_root_id.clone();
    let mut subtree = vec![page.clone()];
    subtree.extend(descendants(session, &page, true).await?);
    subtree.retain(|p| p.deleted_root_id == root);
    let restored_ids: Vec<String> = subtree.iter().map(|p| p.id.clone()).collect();
    let parent = match page.parent_id.as_deref().filter(|p| !p.is_empty()) {
        Some(parent_id) => docs_page::Entity::find_by_id(parent_id).one(session).await?,
        None => None,
    };
    let reparented = parent.is_some_and(|p| p.deleted_at.as_deref().is_some_and(|d| !d.is_empty()));
    let new_position = if reparented { Some(next_position(session, &page.project_id, None).await?) } else { None };
    for p in &subtree {
        let mut row = p.clone().into_active_model();
        if reparented && p.id == page.id {
            row.parent_id = Set(None);
            row.position = Set(new_position.unwrap_or(0));
        }
        row.deleted_at = Set(None);
        row.deleted_by = Set(None);
        row.deleted_root_id = Set(None);
        row.update(session).await?;
    }
    refresh_link_targets(session, &page.project_id).await?;
    docs_search::reindex(session, &restored_ids).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("id".into(), json!(page.id));
    out.insert("restored_pages".into(), json!(restored_ids.iter().collect::<HashSet<_>>().len()));
    out.insert("moved_to_top_level".into(), json!(reparented));
    Ok(out)
}

/// `(now - deleted_at).days`: whole days since, rounded down.
fn days_since(deleted_at: &str) -> i64 {
    match time::parse_iso(deleted_at) {
        Some(p) => (Utc::now() - p.utc()).num_seconds().div_euclid(86_400),
        None => 0,
    }
}

/// List pages in the Recycle Bin, purging the expired ones first.
pub async fn list_deleted(session: &Session, project_id: &str) -> Result<Vec<Value>> {
    project(session, project_id, false).await?;
    purge_expired(session, project_id).await?;
    let pages = all_pages(session, project_id, true).await?;
    let ids: HashSet<&str> = pages.iter().map(|p| p.id.as_str()).collect();
    let mut out: Vec<(String, Value)> = Vec::new();
    for p in &pages {
        // one entry per deletion: the root, plus children whose parent is not deleted with them
        if p.deleted_root_id.as_deref() != Some(p.id.as_str())
            && p.parent_id.as_deref().is_some_and(|x| ids.contains(x))
        {
            continue;
        }
        let count =
            1 + pages.iter().filter(|d| d.deleted_root_id.as_deref() == Some(p.id.as_str()) && d.id != p.id).count();
        let parent = match p.parent_id.as_deref().filter(|x| !x.is_empty()) {
            Some(x) => docs_page::Entity::find_by_id(x).one(session).await?,
            None => None,
        };
        let children: Vec<&str> = pages
            .iter()
            .filter(|d| {
                d.parent_id.as_deref() == Some(p.id.as_str())
                    && d.deleted_root_id.as_deref() == Some(p.id.as_str())
                    && d.id != p.id
            })
            .map(|d| d.title.as_str())
            .collect();
        let deleted_at = p.deleted_at.clone().unwrap_or_else(time::now_iso);
        let days_left = (RECYCLE_DAYS - days_since(&deleted_at)).max(0);
        out.push((
            p.deleted_at.clone().unwrap_or_default(),
            json!({
                "id": p.id,
                "title": p.title,
                "project_id": p.project_id,
                "parent_title": parent.as_ref().map(|x| x.title.clone()),
                "parent_deleted": parent.as_ref().is_some_and(|x| x.deleted_at.as_deref().is_some_and(|d| !d.is_empty())),
                "deleted_at": p.deleted_at,
                "deleted_by": p.deleted_by,
                "page_count": count,
                "child_titles": children,
                "days_left": days_left,
            }),
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

/// Delete pages and everything that hangs off them for good.
pub async fn hard_delete(session: &Session, pages: &[docs_page::Model]) -> Result<()> {
    let ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    docs_search::unindex(session, &ids).await?;
    // late import in Python: docs_comments builds on this module
    if let Some(comments) = hooks::comments() {
        comments.delete_for_pages(session, &ids).await?;
    }
    docs_link::Entity::delete_many().filter(docs_link::Column::SourcePageId.is_in(ids.clone())).exec(session).await?;
    docs_draft::Entity::delete_many().filter(docs_draft::Column::PageId.is_in(ids.clone())).exec(session).await?;
    docs_version::Entity::delete_many().filter(docs_version::Column::PageId.is_in(ids.clone())).exec(session).await?;
    docs_anchor_aliases::Entity::delete_many()
        .filter(docs_anchor_aliases::Column::PageId.is_in(ids.clone()))
        .exec(session)
        .await?;
    docs_title_aliases::Entity::delete_many()
        .filter(docs_title_aliases::Column::PageId.is_in(ids.clone()))
        .exec(session)
        .await?;
    docs_page_seen::Entity::delete_many()
        .filter(docs_page_seen::Column::PageId.is_in(ids.clone()))
        .exec(session)
        .await?;
    // Docs AI rows that belong to the pages (the freshness check and the ignored findings point at the page)
    docs_ai_ignore::Entity::delete_many()
        .filter(docs_ai_ignore::Column::PageId.is_in(ids.clone()))
        .exec(session)
        .await?;
    docs_ai_job::Entity::delete_many().filter(docs_ai_job::Column::PageId.is_in(ids.clone())).exec(session).await?;
    docs_page::Entity::delete_many().filter(docs_page::Column::Id.is_in(ids)).exec(session).await?;
    Ok(())
}

/// Permanently delete a page (and what was deleted with it) that is in the Recycle Bin; 409 if it is not there.
pub async fn purge_page(session: &Session, page_id: &str) -> Result<()> {
    let page = get_page(session, page_id, true, true).await?;
    if page.deleted_at.as_deref().is_none_or(str::is_empty) {
        return docs_err(409, "not_deleted", "Only pages in the Recycle Bin can be deleted forever");
    }
    let mut pages = vec![page.clone()];
    pages.extend(descendants(session, &page, true).await?);
    pages.retain(|p| p.deleted_root_id == page.deleted_root_id);
    hard_delete(session, &pages).await?;
    session.commit().await?;
    Ok(())
}

/// Delete everything in the project's Recycle Bin for good: `{purged}`.
pub async fn empty_recycle_bin(session: &Session, project_id: &str) -> Result<Map<String, Value>> {
    project(session, project_id, true).await?;
    let pages = all_pages(session, project_id, true).await?;
    hard_delete(session, &pages).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("purged".into(), json!(pages.len()));
    Ok(out)
}

/// Permanently delete pages past the retention period; return how many.
pub async fn purge_expired(session: &Session, project_id: &str) -> Result<usize> {
    let cutoff = time::iso(&(Utc::now() - Duration::days(RECYCLE_DAYS)));
    let pages: Vec<docs_page::Model> = all_pages(session, project_id, true)
        .await?
        .into_iter()
        .filter(|p| p.deleted_at.clone().unwrap_or_default() < cutoff)
        .collect();
    hard_delete(session, &pages).await?;
    if !pages.is_empty() {
        session.commit().await?;
    }
    Ok(pages.len())
}
