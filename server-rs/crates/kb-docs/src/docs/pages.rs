//! Pages: lookup, tree, create, paths (`services/docs.py` lines 63-503).

use std::collections::{HashMap, HashSet};

use kb_base::{activity, pyjson};
use kb_db::Session;
use kb_db::entities::{docs_draft, docs_page, docs_version, project as project_table};
use kb_db::sea_orm::sea_query::{Alias, Query};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, Set};
use kb_doctext::docs_access;
use kb_doctext::docs_text::{DocsError, heading_anchors, slugify};
use serde_json::{Map, Value, json};

use super::{MAX_MARKDOWN, MAX_TITLE, templates};
use crate::util::nfc;
use crate::{Result, docs_err, docs_search};

/// `Option<String>` as JSON.
pub(crate) fn opt(value: &Option<String>) -> Value {
    value.as_ref().map(|s| json!(s)).unwrap_or(Value::Null)
}

/// The headings of a Markdown text as `[{level, text, slug}]`.
pub(crate) fn headings_json(markdown: &str) -> Vec<Value> {
    heading_anchors(markdown).into_iter().map(|h| json!({"level": h.level, "text": h.text, "slug": h.slug})).collect()
}

/// `_project`: the project of a Docs call, when Docs is on and the actor may read (or, with `edit`, edit) it.
///
/// Fails with 404 `project_not_found`, 403 `docs_disabled` or what `docs_access` refuses.
pub async fn project(session: &Session, project_id: &str, edit: bool) -> Result<project_table::Model> {
    let Some(project) = project_table::Entity::find_by_id(project_id).one(session).await? else {
        return docs_err(404, "project_not_found", "Project not found");
    };
    if !project.docs_enabled {
        let members = docs_access::members_of(session, &project.id).await?;
        return Err(DocsError::new(403, "docs_disabled", "Docs are turned off for this project")
            .with("role", docs_access::role_in(&members, &activity::current_actor()))
            .into());
    }
    if edit {
        docs_access::require_editor(session, &project).await?;
    } else {
        docs_access::require_reader(session, &project).await?;
    }
    Ok(project)
}

/// Return a page, raising if it is missing or deleted.
///
/// `include_deleted` allows a page that is in the Recycle Bin; `edit` says the caller is about to change the page,
/// so the actor must be allowed to edit. Fails with 404 if missing; 410 if deleted and `include_deleted` is false;
/// 403 when the actor may not read (or, with `edit`, may not edit) the project's Docs.
pub async fn get_page(session: &Session, page_id: &str, include_deleted: bool, edit: bool) -> Result<docs_page::Model> {
    let Some(page) = docs_page::Entity::find_by_id(page_id).one(session).await? else {
        return docs_err(404, "page_not_found", "Page not found");
    };
    project(session, &page.project_id, edit).await?;
    if page.deleted_at.as_deref().is_some_and(|d| !d.is_empty()) && !include_deleted {
        return Err(DocsError::new(410, "page_deleted", "Page is in the Recycle Bin")
            .with("deleted_by", opt(&page.deleted_by))
            .with("deleted_at", opt(&page.deleted_at))
            .into());
    }
    Ok(page)
}

/// A project's live (or, with `deleted`, binned) pages in tree order.
pub async fn all_pages(session: &Session, project_id: &str, deleted: bool) -> Result<Vec<docs_page::Model>> {
    let stmt = docs_page::Entity::find().filter(docs_page::Column::ProjectId.eq(project_id));
    let stmt = if deleted {
        stmt.filter(docs_page::Column::DeletedAt.is_not_null())
    } else {
        stmt.filter(docs_page::Column::DeletedAt.is_null())
    };
    Ok(stmt.order_by_asc(docs_page::Column::Position).order_by_asc(docs_page::Column::CreatedAt).all(session).await?)
}

/// A slug no page of the project has (deleted pages keep theirs).
pub async fn unique_slug(session: &Session, project_id: &str, title: &str) -> Result<String> {
    let slug = slugify(title);
    let base = if slug.is_empty() { "page".to_string() } else { slug };
    let taken: HashSet<String> = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(project_id))
        .all(session)
        .await?
        .into_iter()
        .map(|p| p.slug)
        .collect();
    let (mut slug, mut n) = (base.clone(), 1);
    while taken.contains(&slug) {
        n += 1;
        slug = format!("{base}-{n}");
    }
    Ok(slug)
}

/// `_clean_title`: a title is required, at most `MAX_TITLE` characters.
pub fn clean_title(title: Option<&str>) -> Result<String> {
    let title = kb_base::pytext::strip(title.unwrap_or(""));
    if title.is_empty() {
        return docs_err(422, "title_required", "Give the page a title");
    }
    if title.chars().count() > MAX_TITLE {
        return docs_err(422, "title_too_long", format!("Title is limited to {MAX_TITLE} characters"));
    }
    Ok(title.to_string())
}

/// `_check_markdown`: 413 for a page over `MAX_MARKDOWN` characters.
pub fn check_markdown(markdown: &str) -> Result<()> {
    if markdown.chars().count() > MAX_MARKDOWN {
        return docs_err(413, "too_large", "Page is too large");
    }
    Ok(())
}

/// The position after the last sibling under `parent_id`.
pub async fn next_position(session: &Session, project_id: &str, parent_id: Option<&str>) -> Result<i32> {
    let pages = all_pages(session, project_id, false).await?;
    Ok(pages.iter().filter(|p| p.parent_id.as_deref() == parent_id).map(|p| p.position).max().map_or(0, |m| m + 1))
}

/// The author's draft of a page.
pub async fn draft_for(session: &Session, page_id: &str, author: &str) -> Result<Option<docs_draft::Model>> {
    Ok(docs_draft::Entity::find()
        .filter(docs_draft::Column::PageId.eq(page_id))
        .filter(docs_draft::Column::Author.eq(author))
        .one(session)
        .await?)
}

/// The published version a page is at (none before its first publish).
pub async fn latest_version(session: &Session, page: &docs_page::Model) -> Result<Option<docs_version::Model>> {
    if page.version == 0 {
        return Ok(None);
    }
    Ok(docs_version::Entity::find()
        .filter(docs_version::Column::PageId.eq(page.id.as_str()))
        .filter(docs_version::Column::Version.eq(page.version))
        .one(session)
        .await?)
}

/// Return the project's pages as a flat, ordered tree with draft and edit info.
pub async fn list_tree(session: &Session, project_id: &str) -> Result<Vec<Value>> {
    project(session, project_id, false).await?;
    let pages = all_pages(session, project_id, false).await?;
    let author = activity::current_actor();
    let ids: Vec<String> =
        if pages.is_empty() { vec![String::new()] } else { pages.iter().map(|p| p.id.clone()).collect() };
    let drafted: HashSet<String> = docs_draft::Entity::find()
        .filter(docs_draft::Column::Author.eq(author))
        .filter(docs_draft::Column::PageId.is_in(ids))
        .all(session)
        .await?
        .into_iter()
        .map(|d| d.page_id)
        .collect();
    Ok(pages
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "parent_id": p.parent_id,
                "position": p.position,
                "title": p.title,
                "slug": p.slug,
                "status": p.status,
                "version": p.version,
                "has_draft": drafted.contains(&p.id),
                "updated_at": p.updated_at,
                "kind": p.kind,
            })
        })
        .collect())
}

/// Create a page under a parent, with a unique slug.
///
/// `template` is the template id for the starting content ("blank" by default); `markdown` overrides it. Fails with
/// 422 if the parent is in another project or the template is unknown. Returns the new page's detail.
pub async fn create_page(
    session: &Session,
    project_id: &str,
    title: &str,
    parent_id: Option<&str>,
    template: &str,
    markdown: Option<&str>,
) -> Result<Map<String, Value>> {
    project(session, project_id, true).await?;
    let title = clean_title(Some(title))?;
    if let Some(parent_id) = parent_id {
        let parent = get_page(session, parent_id, false, false).await?;
        if parent.project_id != project_id {
            return docs_err(422, "bad_parent", "Parent belongs to another project");
        }
    }
    let markdown = match markdown {
        Some(m) => m.to_string(),
        None => match templates().into_iter().find(|(k, _)| k == template) {
            Some((_, tpl)) => tpl.markdown,
            None => return docs_err(422, "bad_template", format!("Unknown template '{template}'")),
        },
    };
    check_markdown(&markdown)?;
    let actor = activity::current_actor();
    let mut page = docs_page::new();
    page.project_id = Set(project_id.to_string());
    page.parent_id = Set(parent_id.map(str::to_string));
    page.position = Set(next_position(session, project_id, parent_id).await?);
    page.title = Set(title.clone());
    page.slug = Set(unique_slug(session, project_id, &title).await?);
    page.created_by = Set(actor.clone());
    page.updated_by = Set(actor.clone());
    let page = page.insert(session).await?;
    let mut draft = docs_draft::new();
    draft.page_id = Set(page.id.clone());
    draft.author = Set(actor);
    draft.title = Set(title);
    draft.markdown = Set(markdown);
    draft.base_version = Set(0);
    draft.insert(session).await?;
    docs_search::reindex(session, std::slice::from_ref(&page.id)).await?;
    session.commit().await?;
    page_detail(session, &page.id).await
}

/// `_path`: a page's ancestors as `[{id, title, slug}]`, root first.
pub async fn path(session: &Session, page: &docs_page::Model) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    let mut cur = page.clone();
    let mut seen: HashSet<String> = HashSet::from([page.id.clone()]);
    while let Some(parent_id) = cur.parent_id.clone().filter(|p| !p.is_empty() && !seen.contains(p)) {
        let Some(parent) = docs_page::Entity::find_by_id(parent_id.as_str()).one(session).await? else { break };
        out.insert(0, json!({"id": parent.id, "title": parent.title, "slug": parent.slug}));
        seen.insert(parent.id.clone());
        cur = parent;
    }
    Ok(out)
}

/// `_path_key`: one part of a slug path.
pub fn path_key(title: &str) -> String {
    let slug = slugify(&nfc(title));
    if slug.is_empty() { "page".to_string() } else { slug }
}

/// Each page's slug path from its current titles (`architecture/api`, AC-4), by id.
pub fn slug_paths(pages: &[docs_page::Model]) -> Vec<(String, String)> {
    let by_id: HashMap<&str, &docs_page::Model> = pages.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut out: HashMap<String, String> = HashMap::new();

    fn of(
        p: &docs_page::Model,
        by_id: &HashMap<&str, &docs_page::Model>,
        out: &mut HashMap<String, String>,
        seen: &mut Vec<String>,
    ) -> String {
        if let Some(done) = out.get(&p.id) {
            return done.clone();
        }
        let path = match by_id.get(p.parent_id.as_deref().unwrap_or("")) {
            Some(parent) if !seen.contains(&parent.id) => {
                seen.push(p.id.clone());
                let up = of(parent, by_id, out, seen);
                seen.pop();
                format!("{up}/{}", path_key(&p.title))
            }
            _ => path_key(&p.title),
        };
        out.insert(p.id.clone(), path.clone());
        path
    }

    for p in pages {
        of(p, &by_id, &mut out, &mut Vec::new());
    }
    pages.iter().filter_map(|p| out.get(&p.id).map(|v| (p.id.clone(), v.clone()))).collect()
}

/// The page's slug path for a share link, or None when another page of the space has the same one (two pages
/// titled alike under one parent): the link then stays the page id.
///
/// The same path `slug_paths` gives, without loading the whole space: the page's ancestors give the path, then the
/// pages that could share it are only the top-level pages and the children of each match, level by level.
pub async fn slug_path(session: &Session, page: &docs_page::Model) -> Result<Option<String>> {
    let mut chain = vec![page.clone()];
    let mut seen: HashSet<String> = HashSet::from([page.id.clone()]);
    let mut cur = page.clone();
    while let Some(parent_id) = cur.parent_id.clone().filter(|p| !p.is_empty() && !seen.contains(p)) {
        let parent = docs_page::Entity::find_by_id(parent_id.as_str()).one(session).await?;
        let Some(parent) = parent.filter(|p| p.deleted_at.is_none() && p.project_id == page.project_id) else { break };
        chain.insert(0, parent.clone());
        seen.insert(parent.id.clone());
        cur = parent;
    }
    let keys: Vec<String> = chain.iter().map(|p| path_key(&p.title)).collect();
    let live = Query::select()
        .column(Alias::new("id"))
        .from(Alias::new("docs_page"))
        .and_where(sea_cond_project(&page.project_id))
        .and_where(sea_cond_live())
        .to_owned();
    // top level: no parent, or a parent that is deleted or gone (`slug_paths` reads those pages as top level)
    let mut level: Vec<docs_page::Model> = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(page.project_id.as_str()))
        .filter(docs_page::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(docs_page::Column::ParentId.is_null())
                .add(docs_page::Column::ParentId.not_in_subquery(live)),
        )
        .all(session)
        .await?
        .into_iter()
        .filter(|p| path_key(&p.title) == keys[0])
        .collect();
    for key in &keys[1..] {
        if level.is_empty() {
            break;
        }
        level = docs_page::Entity::find()
            .filter(docs_page::Column::ProjectId.eq(page.project_id.as_str()))
            .filter(docs_page::Column::DeletedAt.is_null())
            .filter(docs_page::Column::ParentId.is_in(level.iter().map(|x| x.id.clone()).collect::<Vec<_>>()))
            .all(session)
            .await?
            .into_iter()
            .filter(|p| path_key(&p.title) == *key)
            .collect();
    }
    if level.len() != 1 || level[0].id != page.id {
        return Ok(None);
    }
    Ok(Some(keys.join("/")))
}

fn sea_cond_project(project_id: &str) -> kb_db::sea_orm::sea_query::SimpleExpr {
    use kb_db::sea_orm::sea_query::{Expr, ExprTrait};
    Expr::col(Alias::new("project_id")).eq(project_id)
}

fn sea_cond_live() -> kb_db::sea_orm::sea_query::SimpleExpr {
    use kb_db::sea_orm::sea_query::{Expr, ExprTrait};
    Expr::col(Alias::new("deleted_at")).is_null()
}

/// The page a slug path names (`?docs=architecture/api`, AC-4).
///
/// A rename changes the path; the old one keeps resolving: each part may also be a title the page had before (the
/// titles a rename remembers for `[[links]]`) or the slug the page got when it was made. A path that matches more
/// than one page, or none, is not found (404).
pub async fn page_by_path(session: &Session, project_id: &str, path: &str) -> Result<Map<String, Value>> {
    let parts: Vec<String> = path.trim_matches('/').split('/').filter(|x| !x.is_empty()).map(nfc).collect();
    if parts.is_empty() {
        return docs_err(404, "page_not_found", "No page at this link");
    }
    let pages = all_pages(session, project_id, false).await?;
    let joined = parts.join("/");
    let exact: Vec<String> = slug_paths(&pages).into_iter().filter(|(_, v)| *v == joined).map(|(id, _)| id).collect();
    if exact.len() == 1 {
        return page_detail(session, &exact[0]).await;
    }
    let mut olds: HashMap<String, HashSet<String>> = HashMap::new();
    for (old_title, pid) in
        super::refs::title_aliases(session, &pages.iter().map(|p| p.id.clone()).collect::<Vec<_>>()).await?
    {
        olds.entry(pid).or_default().insert(path_key(&old_title));
    }
    let names = |p: &docs_page::Model| -> HashSet<String> {
        let mut set: HashSet<String> = olds.get(&p.id).cloned().unwrap_or_default();
        set.insert(path_key(&p.title));
        set.insert(p.slug.clone());
        set
    };
    let ids: HashSet<&str> = pages.iter().map(|p| p.id.as_str()).collect();
    let mut kids: HashMap<Option<&str>, Vec<&docs_page::Model>> = HashMap::new();
    for p in &pages {
        let key = p.parent_id.as_deref().filter(|x| ids.contains(x));
        kids.entry(key).or_default().push(p);
    }
    let mut level: Vec<&docs_page::Model> = kids
        .get(&None)
        .map(|v| v.as_slice())
        .unwrap_or(&[])
        .iter()
        .copied()
        .filter(|p| names(p).contains(&parts[0]))
        .collect();
    for part in &parts[1..] {
        level = level
            .iter()
            .flat_map(|p| kids.get(&Some(p.id.as_str())).map(|v| v.as_slice()).unwrap_or(&[]).iter().copied())
            .filter(|k| names(k).contains(part))
            .collect();
    }
    if level.len() != 1 {
        // the page may have moved: its creation slug is unique in the space
        level = pages.iter().filter(|p| p.slug == parts[parts.len() - 1]).collect();
    }
    if level.len() != 1 {
        return docs_err(404, "page_not_found", "No page at this link");
    }
    page_detail(session, &level[0].id).await
}

/// `_json_or_none`: parsed JSON, or none for an empty or broken text.
pub(crate) fn json_or_none(raw: Option<&str>) -> Value {
    match raw.filter(|r| !r.is_empty()) {
        Some(raw) => pyjson::loads(raw).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// Return a page with its published content, the caller's draft and stats.
pub async fn page_detail(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let actor = activity::current_actor();
    let latest = latest_version(session, &page).await?;
    let draft = draft_for(session, &page.id, &actor).await?;
    let markdown = latest.as_ref().map(|l| l.markdown.clone()).unwrap_or_default();
    let unpublished =
        draft.as_ref().is_some_and(|d| page.version > 0 && (d.markdown != markdown || d.title != page.title));
    let mut out = Map::new();
    out.insert("id".into(), json!(page.id));
    out.insert("project_id".into(), json!(page.project_id));
    out.insert("parent_id".into(), json!(page.parent_id));
    out.insert("title".into(), json!(page.title));
    out.insert("slug".into(), json!(page.slug));
    // the share link's path from the current titles (AC-4); None when another page has the same path
    out.insert("slug_path".into(), json!(slug_path(session, &page).await?));
    out.insert("status".into(), json!(page.status));
    out.insert("version".into(), json!(page.version));
    out.insert("markdown".into(), json!(markdown));
    out.insert("headings".into(), Value::Array(headings_json(&markdown)));
    out.insert("path".into(), Value::Array(path(session, &page).await?));
    out.insert("created_by".into(), json!(page.created_by));
    out.insert(
        "updated_by".into(),
        json!(latest.as_ref().map(|l| l.author.clone()).unwrap_or(page.updated_by.clone())),
    );
    out.insert(
        "updated_at".into(),
        json!(latest.as_ref().map(|l| l.created_at.clone()).unwrap_or(page.updated_at.clone())),
    );
    out.insert("created_at".into(), json!(page.created_at));
    out.insert("stats".into(), super::tickets::page_stats(session, &page, &markdown).await?);
    out.insert("has_unpublished_changes".into(), json!(unpublished));
    out.insert("kind".into(), json!(page.kind));
    out.insert(
        "draft".into(),
        match &draft {
            Some(d) => json!({
                "title": d.title,
                "markdown": d.markdown,
                "base_version": d.base_version,
                "saves": d.saves,
                "updated_at": d.updated_at,
                "author": d.author,
                "ai_source": json_or_none(d.ai_source.as_deref()),
            }),
            None => Value::Null,
        },
    );
    Ok(out)
}

/// Return a page's detail by its slug (404 if no page has that slug).
pub async fn page_by_slug(session: &Session, project_id: &str, slug: &str) -> Result<Map<String, Value>> {
    let page = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(project_id))
        .filter(docs_page::Column::Slug.eq(slug))
        .one(session)
        .await?;
    match page {
        Some(page) => page_detail(session, &page.id).await,
        None => docs_err(404, "page_not_found", format!("No page at '{slug}'")),
    }
}
