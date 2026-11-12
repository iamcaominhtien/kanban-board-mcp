//! Rename preview and delete preview (`services/docs.py` lines 2212-2427).

use std::collections::{HashMap, HashSet};

use kb_base::{activity, time};
use kb_db::Session;
use kb_db::entities::{docs_draft, docs_link, docs_page};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, Set};
use kb_doctext::docs_text::{count_page_links, rewrite_page_links};
use serde_json::{Map, Value, json};

use super::pages::{all_pages, clean_title, draft_for, get_page, latest_version, page_detail};
use super::refs::{Headings, PageRef, refresh_link_targets, remember_title, resolve_page_ref};
use super::tickets::ticket_mentions;
use super::tree::descendants;
use super::versions::commit_version;
use crate::{Result, docs_err, docs_search};

/// A page that holds links to a title about to change.
struct Affected {
    page: docs_page::Model,
    drafts: Vec<docs_draft::Model>,
    count: usize,
}

/// Other pages whose published text or drafts hold [[old_title]] links that resolve to `page`.
async fn links_to_rename(session: &Session, page: &docs_page::Model, old_title: &str) -> Result<Vec<Affected>> {
    let pages = all_pages(session, &page.project_id, false).await?;
    let request = PageRef { title: old_title, anchor: None, by_slug: false };
    let res = resolve_page_ref(&pages, &[], &request, &Headings::new(), None, None);
    if res.get("page_id").and_then(Value::as_str) != Some(page.id.as_str()) {
        // another page with the same title wins that link; nothing to repoint
        return Ok(Vec::new());
    }
    let others: Vec<docs_page::Model> = pages.iter().filter(|p| p.id != page.id).cloned().collect();
    let published_pages: Vec<docs_page::Model> = others.iter().filter(|p| p.version > 0).cloned().collect();
    let contents = docs_search::contents(session, &published_pages).await?;
    let ids: Vec<String> =
        if others.is_empty() { vec![String::new()] } else { others.iter().map(|p| p.id.clone()).collect() };
    let drafts = docs_draft::Entity::find().filter(docs_draft::Column::PageId.is_in(ids)).all(session).await?;
    let mut drafts_by_page: HashMap<String, Vec<docs_draft::Model>> = HashMap::new();
    for d in drafts {
        drafts_by_page.entry(d.page_id.clone()).or_default().push(d);
    }
    let mut out = Vec::new();
    for p in others {
        let mine = drafts_by_page.remove(&p.id).unwrap_or_default();
        let published = if p.version > 0 {
            count_page_links(contents.get(&p.id).map(String::as_str).unwrap_or(""), old_title)
        } else {
            0
        };
        let in_drafts = mine.iter().map(|d| count_page_links(&d.markdown, old_title)).max().unwrap_or(0);
        let count = if p.version > 0 { published } else { in_drafts };
        if published > 0 || in_drafts > 0 {
            let count = if count > 0 { count } else { in_drafts };
            out.push(Affected { page: p, drafts: mine, count });
        }
    }
    Ok(out)
}

/// Preview which pages a rename would rewrite links in: `{affected_pages, total}`.
pub async fn rename_preview(session: &Session, page_id: &str, title: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let new_title = clean_title(Some(title))?;
    let mut out = Map::new();
    if new_title == page.title {
        out.insert("affected_pages".into(), json!([]));
        out.insert("total".into(), json!(0));
        return Ok(out);
    }
    let affected = links_to_rename(session, &page, &page.title).await?;
    let mut rows: Vec<(String, Value, usize)> = affected
        .iter()
        .map(|a| {
            (
                a.page.title.to_lowercase(),
                json!({"page_id": a.page.id, "title": a.page.title, "count": a.count}),
                a.count,
            )
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let total: usize = rows.iter().map(|r| r.2).sum();
    out.insert("affected_pages".into(), Value::Array(rows.into_iter().map(|r| r.1).collect()));
    out.insert("total".into(), json!(total));
    Ok(out)
}

/// A title can be written as a `[[link]]` unless it holds `[`, `]`, `|` or `#`.
fn not_linkable(title: &str) -> bool {
    title.contains(['[', ']', '|', '#'])
}

/// Rename a page, optionally rewriting `[[links]]` that point to it.
///
/// `rewrite_links` updates `[[old title]]` links in other pages. Fails with 422 if the title cannot be written as a
/// `[[link]]` while rewriting links. Returns the renamed page's detail with `rewritten` and `rewritten_pages`.
pub async fn rename_page(
    session: &Session,
    page_id: &str,
    title: &str,
    rewrite_links: bool,
) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, true).await?;
    let new_title = clean_title(Some(title))?;
    let old_title = page.title.clone();
    let actor = activity::current_actor();
    let mut affected: Vec<Affected> = Vec::new();
    if rewrite_links && new_title != old_title {
        if not_linkable(&new_title) {
            return docs_err(
                422,
                "title_not_linkable",
                "A title with [, ], | or # cannot be written as a [[link]]; rename without updating links",
            );
        }
        affected = links_to_rename(session, &page, &old_title).await?;
    }
    let mut row = page.clone().into_active_model();
    row.title = Set(new_title.clone());
    row.updated_at = Set(time::now_iso());
    row.updated_by = Set(actor.clone());
    let page = row.update(session).await?;
    remember_title(session, &page, &old_title, &new_title).await?;
    if let Some(draft) = draft_for(session, &page.id, &actor).await? {
        let mut d = draft.into_active_model();
        d.title = Set(page.title.clone());
        d.update(session).await?;
    }
    let (mut rewritten_links, mut rewritten_pages) = (0usize, 0usize);
    let mut touched = vec![page.id.clone()];
    for item in affected {
        let mut src = item.page;
        let (old_version, mut published_n) = (src.version, 0usize);
        if src.version > 0 {
            if let Some(latest) = latest_version(session, &src).await? {
                let (new_md, n) = rewrite_page_links(&latest.markdown, &old_title, &new_title);
                published_n = n;
                if published_n > 0 {
                    let title = src.title.clone();
                    commit_version(
                        session,
                        &mut src,
                        &new_md,
                        &title,
                        &actor,
                        Some(&format!("Link to \"{new_title}\" updated")),
                        None,
                        false,
                    )
                    .await?;
                }
            }
        }
        let mut draft_n = 0usize;
        for d in item.drafts {
            let (new_md, n) = rewrite_page_links(&d.markdown, &old_title, &new_title);
            if n == 0 {
                continue;
            }
            draft_n = draft_n.max(n);
            let base = d.base_version;
            let mut active = d.into_active_model();
            if published_n > 0 && base == old_version {
                // the rewrite is in this draft too: no false conflict
                active.base_version = Set(src.version);
            }
            active.markdown = Set(new_md);
            active.update(session).await?;
        }
        if published_n > 0 || draft_n > 0 {
            rewritten_links += if published_n > 0 { published_n } else { draft_n };
            rewritten_pages += 1;
            touched.push(src.id.clone());
        }
    }
    refresh_link_targets(session, &page.project_id).await?;
    docs_search::reindex(session, &touched).await?;
    session.commit().await?;
    let mut detail = page_detail(session, page_id).await?;
    detail.insert("rewritten".into(), json!(rewritten_links));
    detail.insert("rewritten_pages".into(), json!(rewritten_pages));
    Ok(detail)
}

/// Preview the sub-pages, inbound links and tickets a delete would affect.
pub async fn delete_preview(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let subtree = descendants(session, &page, false).await?;
    let mut ids: Vec<String> = vec![page.id.clone()];
    ids.extend(subtree.iter().map(|p| p.id.clone()));
    let id_set: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let rows = docs_link::Entity::find()
        .filter(docs_link::Column::TargetPageId.is_in(ids.clone()))
        .filter(docs_link::Column::Origin.eq("page"))
        .all(session)
        .await?;
    let mut link_counts: Vec<(String, usize)> = Vec::new();
    for link in rows {
        if id_set.contains(link.source_page_id.as_str()) {
            continue;
        }
        match link_counts.iter_mut().find(|(s, _)| *s == link.source_page_id) {
            Some(entry) => entry.1 += 1,
            None => link_counts.push((link.source_page_id, 1)),
        }
    }
    let mut linking: Vec<(usize, String, Value)> = Vec::new();
    for (sid, n) in link_counts {
        let src = docs_page::Entity::find_by_id(sid.as_str()).one(session).await?;
        let Some(src) = src.filter(|s| s.deleted_at.as_deref().is_none_or(str::is_empty)) else { continue };
        let parent = match src.parent_id.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => docs_page::Entity::find_by_id(p).one(session).await?,
            None => None,
        };
        linking.push((
            n,
            src.title.to_lowercase(),
            json!({"page_id": src.id, "title": src.title, "parent": parent.map(|p| p.title), "count": n}),
        ));
    }
    linking.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut tickets: HashSet<String> = ticket_mentions(session, &page.project_id)
        .await?
        .into_iter()
        .filter(|m| id_set.contains(m.page_id.as_str()))
        .map(|m| m.ticket.id)
        .collect();
    let manual = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.is_in(ids.clone()))
        .filter(docs_link::Column::Origin.eq("manual"))
        .filter(docs_link::Column::TargetTicketId.is_not_null())
        .all(session)
        .await?;
    tickets.extend(manual.into_iter().filter_map(|l| l.target_ticket_id).filter(|t| !t.is_empty()));
    let live = linking.len();
    let mut children = subtree.clone();
    children.sort_by(|a, b| (a.position, &a.title).cmp(&(b.position, &b.title)));
    let mut pages_out = vec![json!({"id": page.id, "title": page.title, "role": "this"})];
    pages_out.extend(children.iter().map(|p| json!({"id": p.id, "title": p.title, "role": "child"})));
    let mut out = Map::new();
    out.insert("pages".into(), Value::Array(pages_out));
    out.insert("linking_pages".into(), json!(live));
    out.insert("linking".into(), Value::Array(linking.into_iter().take(5).map(|l| l.2).collect()));
    out.insert("linking_tickets".into(), json!(tickets.len()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::not_linkable;

    #[test]
    fn titles_with_link_syntax_are_not_linkable() {
        assert!(not_linkable("a|b") && not_linkable("a#b") && not_linkable("[x]"));
        assert!(!not_linkable("Plain title"));
    }
}
