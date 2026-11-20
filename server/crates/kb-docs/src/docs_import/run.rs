//! The import itself and the post-import pass (`services/docs_import.py` lines 390-533).

use kb_base::activity;
use kb_db::Session;
use kb_db::entities::{docs_draft, docs_page};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait};
use kb_doctext::docs_text::{Reference, parse_references};
use serde_json::{Map, Value, json};

use super::build_plan;
use crate::docs::{
    commit_version, next_position, project, refresh_link_targets, reindex_links, resolve_refs, unique_slug,
};
use crate::{Result, docs_search};

/// Create the planned pages as drafts, or publish them when `publish` is set.
///
/// `files` are `(path, bytes)` pairs; `parent_id` the page to import under (None for the top level); `on_conflict`
/// `copy` or `skip` for pages that already exist; `publish` publishes version 1 of each page instead of leaving
/// drafts. Returns `{created, failed, skipped}` with per-file results.
pub async fn run_import(
    session: &Session,
    project_id: &str,
    files: &[(String, Vec<u8>)],
    parent_id: Option<&str>,
    on_conflict: &str,
    publish: bool,
) -> Result<Map<String, Value>> {
    project(session, project_id, true).await?;
    let mut plan = build_plan(session, project_id, files, parent_id, on_conflict).await?;
    let actor = activity::current_actor();
    let mut created: Vec<Value> = Vec::new();
    let mut pages: Vec<(docs_page::Model, crate::docs::PageBody, docs_draft::Model)> = Vec::new();
    // by key: a later node with the same key replaces the earlier in Python's dictionary
    let mut by_key: std::collections::HashMap<Vec<String>, usize> = std::collections::HashMap::new();
    for &n in &plan.ordered {
        by_key.insert(plan.arena[n].key.clone(), n);
    }
    for &n in &plan.ordered.clone() {
        if let Some(existing) = plan.arena[n].existing_id.clone() {
            plan.arena[n].page_id = Some(existing);
            continue;
        }
        let mut parent_page_id = parent_id.map(str::to_string);
        if let Some(parent_key) = plan.arena[n].parent_key.clone() {
            parent_page_id = plan.arena[by_key[&parent_key]].page_id.clone();
        }
        let title = plan.arena[n].title.clone();
        let body = plan.arena[n].body.clone();
        let mut page = docs_page::new();
        page.project_id = Set(project_id.to_string());
        page.parent_id = Set(parent_page_id.clone());
        page.position = Set(next_position(session, project_id, parent_page_id.as_deref()).await?);
        page.title = Set(title.clone());
        page.slug = Set(unique_slug(session, project_id, &title).await?);
        page.created_by = Set(actor.clone());
        page.updated_by = Set(actor.clone());
        let page = page.insert(session).await?;
        let mut draft = docs_draft::new();
        draft.page_id = Set(page.id.clone());
        draft.author = Set(actor.clone());
        draft.title = Set(title.clone());
        let rich = imported_body(&body);
        crate::docs::versions::set_draft_body(&mut draft, &rich);
        draft.base_version = Set(0);
        let draft = draft.insert(session).await?;
        plan.arena[n].page_id = Some(page.id.clone());
        let path = plan.arena[n].key.join("/");
        created.push(json!({"path": path, "page_id": page.id, "title": title}));
        pages.push((page, rich, draft));
    }
    if publish {
        for (mut page, markdown, draft) in pages {
            let title = page.title.clone();
            commit_version(session, &mut page, &markdown, &title, &actor, Some("Imported"), Some(draft), false).await?;
        }
        refresh_link_targets(session, project_id).await?;
    }
    let ids: Vec<String> = created.iter().filter_map(|c| c["page_id"].as_str().map(str::to_string)).collect();
    docs_search::reindex(session, &ids).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("created".into(), Value::Array(created));
    out.insert(
        "failed".into(),
        Value::Array(
            plan.entries
                .iter()
                .filter(|e| e.error.is_some())
                .map(|e| json!({"path": e.path, "message": e.error}))
                .collect(),
        ),
    );
    out.insert(
        "skipped".into(),
        Value::Array(
            plan.entries
                .iter()
                .filter(|e| e.skipped)
                .map(|e| json!({"path": e.path, "message": e.messages.join("; ")}))
                .collect(),
        ),
    );
    Ok(out)
}

/// Post-import pass: rebuild the link index of the pages and re-point pending links.
///
/// `page_ids` are the pages created by the import. Returns `{pages, links_resolved, links_unresolved}`.
pub async fn resolve_pages(session: &Session, project_id: &str, page_ids: &[String]) -> Result<Map<String, Value>> {
    project(session, project_id, true).await?;
    let (mut resolved, mut unresolved, mut count) = (0, 0, 0);
    let mut live: Vec<docs_page::Model> = Vec::new();
    for pid in page_ids {
        let Some(page) = docs_page::Entity::find_by_id(pid.as_str()).one(session).await? else { continue };
        if page.deleted_at.as_deref().is_some_and(|d| !d.is_empty()) || page.project_id != project_id {
            continue;
        }
        live.push(page);
    }
    let contents = docs_search::contents(session, &live).await?;
    for page in &live {
        let markdown = contents.get(&page.id).map(String::as_str).unwrap_or("");
        count += 1;
        if page.version > 0 {
            reindex_links(session, page, markdown).await?;
        }
        let refs: Vec<Value> = parse_references(markdown)
            .into_iter()
            .filter(|r| matches!(r, Reference::Page(_)))
            .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
            .collect();
        let results =
            if refs.is_empty() { Vec::new() } else { resolve_refs(session, project_id, &refs, false).await? };
        for res in results {
            if matches!(res["status"].as_str(), Some("ok" | "ambiguous" | "section_missing")) {
                resolved += 1;
            } else {
                unresolved += 1;
            }
        }
    }
    refresh_link_targets(session, project_id).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("pages".into(), json!(count));
    out.insert("links_resolved".into(), json!(resolved));
    out.insert("links_unresolved".into(), json!(unresolved));
    Ok(out)
}

/// The page of an imported Markdown file: a file written in the annotated flavour (the MCP view of a page, with
/// `<!-- #b-… -->` or `<!-- htmlEmbed -->` markers) is read with its markers, so an HTML embed written as its marker
/// and an ```html code block comes back as an embed; plain Markdown, or annotated Markdown that cannot be read, is
/// read as plain Markdown.
pub(crate) fn imported_body(markdown: &str) -> crate::docs::PageBody {
    if kb_richdoc::has_markers(markdown) {
        if let Ok(doc) = kb_richdoc::annotated_to_doc(markdown, None, &mut kb_richdoc::RandomIds) {
            return crate::docs::PageBody::from_doc(doc);
        }
    }
    crate::docs::PageBody::from_markdown(markdown, &mut kb_richdoc::RandomIds)
}

#[cfg(test)]
mod tests {
    use super::imported_body;

    #[test]
    fn annotated_files_keep_their_embeds() {
        let md = "# Globe\n\n<!-- htmlEmbed title=Globe height=600 -->\n```html\n<canvas></canvas>\n```\n\n\
                  <!-- htmlEmbed src=/docs/sites/ab12cd34ef56/index.html -->\n\nAfter.";
        let body = imported_body(md);
        let doc = body.content.expect("a rich page");
        let c = doc["content"].as_array().expect("blocks");
        assert_eq!(c[1]["type"], "htmlEmbed");
        assert_eq!(c[1]["attrs"]["html"], "<canvas></canvas>");
        assert_eq!(c[1]["attrs"]["height"], 600);
        assert_eq!(c[2]["attrs"]["src"], "/docs/sites/ab12cd34ef56/index.html");
        assert_eq!(c[3]["type"], "paragraph");
    }

    #[test]
    fn plain_and_broken_files_read_as_plain_markdown() {
        // a prose comment is not a marker
        let doc = imported_body("<!-- a note -->\n\n```html\n<b>x</b>\n```").content.expect("a rich page");
        assert!(doc["content"].as_array().expect("blocks").iter().any(|b| b["type"] == "codeBlock"));
        // a broken marker: the file is read as plain Markdown
        let doc = imported_body("<!-- #b-12 htmlEmbed -->\n```html\n<b>x</b>\n```").content.expect("a rich page");
        assert!(doc["content"].as_array().expect("blocks").iter().all(|b| b["type"] != "htmlEmbed"));
        // markers inside fenced code do not count
        assert!(!kb_richdoc::has_markers("```\n<!-- #b-000001 -->\n```"));
        assert!(kb_richdoc::has_markers("<!-- #b-000001 -->\nx"));
    }
}
