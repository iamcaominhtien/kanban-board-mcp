//! Docs operations (`operations/docs.py`): the wiki-like page tree of a project, its comments, import, and the file
//! upload the Docs tools offer.

use std::collections::HashSet;

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use kb_base::{activity, ctx, pytext};
use kb_db::Session;
use kb_docs::Error as DocsFailure;
use kb_docs::docs_comments::Anchor;
use kb_docs::docs_search::SearchParams;
use kb_docs::{docs, docs_comments, docs_import, docs_search, docs_work};
use kb_doctext::{docs_anchors, docs_edit};
use kb_files::{pathlib, uploads};
use serde_json::{Map, Value, json};

use super::docs_rich;
use crate::common::{self, ToolError, ToolResult, notify_on_success};

/// `_docs_error`: a failure of the Docs service as the tool words it: the message, a full stop, and for a conflict
/// what to do next.
pub fn docs_error(err: DocsFailure) -> ToolError {
    match err {
        DocsFailure::Docs(exc) => {
            let hint = if exc.code == "conflict" {
                " Call docs_read(action='get') again, re-apply your edit on the new version, and retry."
            } else {
                ""
            };
            ToolError::Value(format!("{}.{hint}", exc.message))
        }
        DocsFailure::Value(message) => ToolError::Value(message),
        DocsFailure::Db(err) => err.into(),
        DocsFailure::Other(message) => ToolError::Other(message),
        // an assistant's refusal (`AssistError`, `DocsAiError`): `str(exc)` is its message, the `detail` of the body
        DocsFailure::Json { status, body } => {
            let message = match body.get("detail") {
                Some(Value::String(text)) => text.clone(),
                _ => kb_base::pyjson::py_str(&body),
            };
            if status < 500 { ToolError::Value(message) } else { ToolError::Other(message) }
        }
    }
}

/// `markdown` with each picture an AI run names by a path in its working folder copied into the board, like a test
/// case's proof (`kb_board::proofs`); a person's text is kept as written. A picture the page already held stays as
/// written when its file is not there (an imported page's `images/…`), so the AI can still edit that page.
pub async fn with_pictures(session: &Session, markdown: &str, page_id: Option<&str>) -> Result<String, ToolError> {
    if !markdown.contains("](") {
        return Ok(markdown.to_string());
    }
    let Some(folder) = common::attach_folder().await? else {
        return Ok(markdown.to_string());
    };
    let mut keep: HashSet<String> = HashSet::new();
    if let Some(page_id) = page_id {
        let current = docs::page_detail(session, page_id).await.map_err(docs_error)?;
        keep = kb_board::proofs::targets(current.get("markdown").and_then(Value::as_str)).into_iter().collect();
    }
    let localized = kb_board::proofs::localize(Some(markdown), &folder, true, &keep)
        .await
        .map_err(|err| ToolError::Value(err.0))?;
    Ok(localized.unwrap_or_default())
}

/// A page as the operations return it: the listed keys, in that order.
fn pick(page: &Map<String, Value>, keys: &[&str]) -> Value {
    Value::Object(keys.iter().map(|k| (k.to_string(), page.get(*k).cloned().unwrap_or(Value::Null))).collect())
}

/// List a project's Docs pages as a flat tree in reading order: [{id, parent_id, title, status}] (a page comes right
/// after its parent and its earlier siblings, as the tree shows it).
pub async fn list_docs_pages(project_id: &str) -> ToolResult {
    let session = common::async_session();
    let tree = docs::list_tree(&session, project_id).await.map_err(docs_error)?;
    let keys = ["id", "parent_id", "title", "status"];
    Ok(Value::Array(in_reading_order(&tree).into_iter().map(|n| pick(n, &keys)).collect()))
}

/// The pages of a flat tree (`{id, parent_id, position}` each) in reading order: depth first, siblings by position.
/// A page whose parent is not in the list is a root.
pub fn in_reading_order(tree: &[Value]) -> Vec<&Map<String, Value>> {
    let nodes: Vec<&Map<String, Value>> = tree.iter().filter_map(Value::as_object).collect();
    let text = |n: &Map<String, Value>, key: &str| n.get(key).and_then(Value::as_str).map(str::to_string);
    let ids: HashSet<String> = nodes.iter().filter_map(|n| text(n, "id")).collect();
    let mut kids: std::collections::HashMap<Option<String>, Vec<&Map<String, Value>>> = Default::default();
    for n in &nodes {
        let parent = text(n, "parent_id").filter(|p| ids.contains(p));
        kids.entry(parent).or_default().push(n);
    }
    for list in kids.values_mut() {
        list.sort_by(|a, b| {
            let pos = |n: &Map<String, Value>| n.get("position").and_then(Value::as_f64).unwrap_or(0.0);
            pos(a).total_cmp(&pos(b))
        });
    }
    let mut out = Vec::with_capacity(nodes.len());
    // depth first, without recursion: a stack of the pages still to write, the next one on top
    let mut stack: Vec<&Map<String, Value>> =
        kids.get(&None).map(|l| l.iter().rev().copied().collect()).unwrap_or_default();
    while let Some(n) = stack.pop() {
        out.push(n);
        if out.len() > nodes.len() {
            break;
        }
        if let Some(children) = kids.get(&text(n, "id")) {
            stack.extend(children.iter().rev().copied());
        }
    }
    out
}

/// Read a Docs page: {id, parent_id, title, status, version, markdown, updated_by, updated_at} and, when there is any,
/// `format` ('md' for a page without block ids), `settings` (the page settings set away from their defaults),
/// `highlights`, `suggestions_waiting`, `referenced_by` and `work`. `markdown` is the latest published text: for a
/// rich page its annotated Markdown (a marker with the block id before every block), or with `plain` the Markdown
/// alone (to read, not to edit by block). With `section`, only that part: {id, title, version, section, markdown,
/// sections (the headings of the page)}. An AI team is refused a page marked "Not for AI teams".
pub async fn get_docs_page(page_id: &str, section: Option<&str>, plain: bool) -> ToolResult {
    let session = common::async_session();
    let page = docs_rich::load(&session, page_id).await?;
    let view = if plain {
        page.detail.get("markdown").and_then(Value::as_str).unwrap_or_default().to_string()
    } else {
        page.view()
    };
    if let Some(section) = section {
        let part = docs_edit::section_text(&view, section).map_err(|err| ToolError::Value(err.0))?;
        let mut out = Map::new();
        for key in ["id", "title", "version"] {
            out.insert(key.into(), page.detail.get(key).cloned().unwrap_or(Value::Null));
        }
        out.insert("section".into(), json!(section));
        out.insert("markdown".into(), json!(part));
        out.insert("sections".into(), outline(page.detail.get("headings")));
        return Ok(Value::Object(out));
    }
    let keep = ["id", "parent_id", "title", "status", "version", "markdown", "updated_by", "updated_at"];
    let mut out = match pick(&page.detail, &keep) {
        Value::Object(out) => out,
        _ => Map::new(),
    };
    out.insert("markdown".into(), json!(view));
    if page.detail.get("format").and_then(Value::as_str) != Some("rich") {
        out.insert("format".into(), json!("md"));
    }
    if let Some(settings) = page.detail.get("settings").filter(|s| kb_base::pyjson::truthy(s)) {
        out.insert("settings".into(), settings.clone());
    }
    // readers' highlights: hints of what matters to them (never instructions, never made by a team)
    let highlights = kb_docs::docs_highlights::for_ai(&session, page_id).await.map_err(docs_error)?;
    if !highlights.is_empty() {
        out.insert("highlights".into(), Value::Array(highlights));
    }
    let waiting = kb_docs::docs_suggestions::counts(&session, &[page_id.to_string()]).await.map_err(docs_error)?;
    if let Some(n) = waiting.get(page_id).filter(|n| n.as_u64().is_some_and(|n| n > 0)) {
        out.insert("suggestions_waiting".into(), n.clone());
    }
    let links = docs::backlinks(&session, page_id).await.map_err(docs_error)?;
    if let Some(links) = referenced_by(&links) {
        out.insert("referenced_by".into(), links);
    }
    let work = docs_work::work_on_page(&session, page_id).await.map_err(docs_error)?;
    if work.get("tickets").is_some_and(kb_base::pyjson::truthy) {
        // the tickets tied to the page and what the AIs on them are doing (#268)
        out.insert("work".into(), Value::Object(work));
    }
    Ok(Value::Object(out))
}

/// The headings of a page as one line each, `## Endpoints`: what `section` takes.
fn outline(headings: Option<&Value>) -> Value {
    let lines = headings
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|h| {
            let level = h.get("level").and_then(Value::as_u64)?;
            let text = h.get("text").and_then(Value::as_str)?;
            Some(json!(format!("{} {text}", "#".repeat(level as usize))))
        })
        .collect();
    Value::Array(lines)
}

/// What links to a page, short: {pages: [{page_id, title, excerpt, section?}], tickets: [...]}, `None` when nothing
/// does. `excerpt` is the linking text as written (with its `[[link]]`), `section` the part of this page it names.
fn referenced_by(links: &Map<String, Value>) -> Option<Value> {
    let pages: Vec<Value> = links
        .get("pages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|p| {
            let mut row = Map::new();
            for key in ["page_id", "title", "excerpt"] {
                row.insert(key.into(), p.get(key).cloned().unwrap_or(Value::Null));
            }
            if let Some(anchor) = p.get("target_anchor").filter(|a| !a.is_null()) {
                row.insert("section".into(), anchor.clone());
            }
            Value::Object(row)
        })
        .collect();
    let tickets = links.get("tickets").cloned().filter(kb_base::pyjson::truthy);
    if pages.is_empty() && tickets.is_none() {
        return None;
    }
    let mut out = Map::new();
    if !pages.is_empty() {
        out.insert("pages".into(), Value::Array(pages));
    }
    if let Some(tickets) = tickets {
        out.insert("tickets".into(), tickets);
    }
    Some(Value::Object(out))
}

/// Read one block of a rich page: {page_id, version, block_id, type, markdown (its annotated Markdown; null for a
/// list item, a table cell or a column)}, plus `block` (its JSON) when Markdown cannot hold it (a placeholder: a
/// video, an HTML embed, a table with merged cells…) and, for a table, `cells`: the format of each formatted cell by
/// its spreadsheet name (`{"B2": {"background": "green"}}`).
pub async fn get_docs_block(page_id: &str, block_id: &str) -> ToolResult {
    let session = common::async_session();
    let page = docs_rich::load(&session, page_id).await?;
    let Some(doc) = &page.doc else {
        return Err(ToolError::value("This page is not in the rich format: it has no block ids. Read it with get."));
    };
    let Some(node) = docs_rich::find_block(doc, block_id) else {
        return Err(docs_rich::richdoc_error(kb_richdoc::RichDocError::NoBlock(block_id.to_string())));
    };
    let markdown = docs_rich::block_view(node);
    let mut out = Map::new();
    out.insert("page_id".into(), json!(page_id));
    out.insert("version".into(), page.detail.get("version").cloned().unwrap_or(Value::Null));
    out.insert("block_id".into(), json!(block_id));
    out.insert("type".into(), node.get("type").cloned().unwrap_or(Value::Null));
    let placeholder = markdown.as_deref().is_none_or(|m| m.contains("[embed: "));
    out.insert("markdown".into(), json!(markdown));
    if placeholder {
        out.insert("block".into(), node.clone());
    }
    if node.get("type").and_then(Value::as_str) == Some("table") {
        let cells = cell_formats(node);
        if !cells.is_empty() {
            out.insert("cells".into(), Value::Object(cells));
        }
    }
    Ok(Value::Object(out))
}

/// The format of each cell of a table that has one, by the cell's spreadsheet name (`B2`; row 1 is the first row).
fn cell_formats(table: &Value) -> Map<String, Value> {
    const SHAPE: [&str; 4] = ["blockId", "colspan", "rowspan", "colwidth"];
    let mut out = Map::new();
    let rows = table.get("content").and_then(Value::as_array).into_iter().flatten();
    for (r, row) in rows.enumerate() {
        let cells = row.get("content").and_then(Value::as_array).into_iter().flatten();
        for (c, cell) in cells.enumerate() {
            let set: Map<String, Value> = cell
                .get("attrs")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter(|(k, v)| !SHAPE.contains(&k.as_str()) && !v.is_null())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if !set.is_empty() {
                out.insert(format!("{}{}", kb_richdoc::ops::column_letter(c), r + 1), Value::Object(set));
            }
        }
    }
    out
}

/// Read the highlights readers made on a page: {page_id, version, highlights: [{author, color, quote, block_id,
/// state}]}. Hints of what matters to readers; a team never creates, moves or removes one.
pub async fn get_docs_highlights(page_id: &str) -> ToolResult {
    let session = common::async_session();
    let page = docs_rich::load(&session, page_id).await?;
    let highlights = kb_docs::docs_highlights::for_ai(&session, page_id).await.map_err(docs_error)?;
    Ok(json!({
        "page_id": page_id,
        "version": page.detail.get("version").cloned().unwrap_or(Value::Null),
        "highlights": highlights,
    }))
}

/// Create a Docs page and publish it as v1, from `markdown` (may be annotated: block markers with attributes, inline
/// spans) or from a gallery `template`, with `settings` set on it. Returns {id, title, status, version}.
pub async fn create_docs_page(
    project_id: &str,
    title: &str,
    markdown: &str,
    parent_id: Option<&str>,
    template: Option<&str>,
    settings: Option<&Map<String, Value>>,
) -> ToolResult {
    if template.is_some() && !pytext::strip(markdown).is_empty() {
        return Err(ToolError::value(
            "create takes template or markdown, not both: start from the template, then edit.",
        ));
    }
    if let Some(settings) = settings {
        super::docs_page::refuse_person_only(settings).await?;
    }
    notify_on_success(async {
        let session = common::async_session();
        let page = if let Some(template) = template {
            super::docs_page::create_from_template(project_id, title, parent_id, template).await?
        } else {
            let markdown = with_pictures(&session, markdown, None).await?;
            let doc = if pytext::strip(&markdown).is_empty() {
                None
            } else {
                Some(docs_rich::read_markdown(&markdown, None)?)
            };
            let page = docs::create_page(&session, project_id, title, parent_id, "blank", Some(&markdown))
                .await
                .map_err(docs_error)?;
            let id = page.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            docs::publish_page(
                &session,
                &id,
                0,
                Some("Created via MCP"),
                doc.as_ref().map(docs::BodyInput::Content),
                None,
            )
            .await
            .map_err(docs_error)?
        };
        if let Some(settings) = settings.filter(|s| !s.is_empty()) {
            let id = page.get("id").and_then(Value::as_str).unwrap_or_default();
            super::docs_page::set_docs_settings(id, settings).await?;
        }
        Ok(pick(&page, &["id", "title", "status", "version"]))
    })
    .await
}

/// Replace a Docs page's content and optionally rename it. `markdown` is the whole page as annotated Markdown:
/// blocks whose marker names an id of the page keep it, and placeholders it leaves out stay where they were. An AI
/// team's change becomes suggestions unless the page applies it directly. Returns {id, title, version, published}
/// (plus mode, suggestions, left_alone, message for an AI team; kept: the placeholders left out and kept).
pub async fn update_docs_page(
    page_id: &str,
    markdown: &str,
    base_version: i64,
    note: Option<&str>,
    publish: bool,
    title: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let markdown = with_pictures(&session, markdown, Some(page_id)).await?;
        let page = docs_rich::load(&session, page_id).await?;
        if let Some(title) = title {
            if pytext::strip(title) != page.detail.get("title").and_then(Value::as_str).unwrap_or_default() {
                docs::rename_page(&session, page_id, title, true, None).await.map_err(docs_error)?;
            }
        }
        let doc = match &page.doc {
            Some(current) => kb_richdoc::ops::replace_page(current, &markdown, &mut kb_richdoc::RandomIds)
                .map_err(docs_rich::richdoc_error)?,
            None => docs_rich::read_markdown(&markdown, None)?,
        };
        let kept: Vec<String> = match &page.doc {
            Some(_) => docs_rich::placeholders(&page.view())
                .into_iter()
                .filter(|(id, _)| !markdown.contains(id.as_str()))
                .map(|(id, kind)| format!("{id} ({kind})"))
                .collect(),
            None => Vec::new(),
        };
        let mut out = docs_rich::save(&session, page_id, &doc, base_version, note, publish).await?;
        if !kept.is_empty() {
            out.insert("kept".into(), json!(kept));
        }
        Ok(Value::Object(out))
    })
    .await
}

/// Move a Docs page under another page (or to the top level), after or before a sibling (`after_id` / `before_id`
/// alone: at that sibling's level). Moving into itself or its own sub-pages is rejected.
pub async fn move_docs_page(
    page_id: &str,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    before_id: Option<&str>,
) -> ToolResult {
    if after_id.is_some() && before_id.is_some() {
        return Err(ToolError::value("move: give after_id or before_id, not both."));
    }
    notify_on_success(async {
        let session = common::async_session();
        // next to a sibling without a parent named: the sibling's parent (its level of the tree)
        let sibling = after_id.or(before_id);
        let sibling_parent = match (parent_id, sibling) {
            (None, Some(sibling)) => docs::page_detail(&session, sibling)
                .await
                .map_err(docs_error)?
                .get("parent_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        };
        let parent_id = parent_id.or(sibling_parent.as_deref());
        let page = docs::move_page(&session, page_id, parent_id, before_id, after_id).await.map_err(docs_error)?;
        Ok(pick(&page, &["id", "title", "parent_id"]))
    })
    .await
}

/// Copy a Docs page as a new draft (no history). Returns the copy {id, title, slug, status}.
pub async fn duplicate_docs_page(page_id: &str, include_children: bool, title: Option<&str>) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let page =
            docs::duplicate_page(&session, page_id, title, None, include_children, false).await.map_err(docs_error)?;
        Ok(pick(&page, &["id", "title", "slug", "status"]))
    })
    .await
}

/// Soft-delete a Docs page and its sub-pages into the Recycle Bin (kept 30 days; restore_docs_page undoes it).
pub async fn delete_docs_page(page_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        Ok(Value::Object(docs::delete_page(&session, page_id).await.map_err(docs_error)?))
    })
    .await
}

/// Restore a deleted Docs page (with the sub-pages deleted together with it) from the Recycle Bin.
pub async fn restore_docs_page(page_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        Ok(Value::Object(docs::restore_page(&session, page_id).await.map_err(docs_error)?))
    })
    .await
}

/// List deleted Docs pages still in the Recycle Bin: [{id, title, page_count, deleted_at, deleted_by, days_left}].
pub async fn list_docs_recycle_bin(project_id: &str) -> ToolResult {
    let session = common::async_session();
    Ok(Value::Array(docs::list_deleted(&session, project_id).await.map_err(docs_error)?))
}

/// List a Docs page's published versions, newest first: [{version, author, note, created_at, words}].
pub async fn list_docs_versions(page_id: &str, limit: Option<i64>) -> ToolResult {
    let session = common::async_session();
    let mut all = docs::list_versions(&session, page_id).await.map_err(docs_error)?;
    all.truncate(usize::try_from(limit.unwrap_or(20).max(1)).unwrap_or(20));
    Ok(Value::Array(all))
}

/// Read one old version of a Docs page (markdown), or what changed between two versions: {from, to, added, removed,
/// diff}, `diff` being the changed lines (`-` old, `+` new) with one line of context, parts apart by `…`.
pub async fn get_docs_version(page_id: &str, version: i64, compare_to: Option<i64>) -> ToolResult {
    let session = common::async_session();
    let out = match compare_to {
        Some(other) => docs::diff_versions(&session, page_id, version, other).await.map(|d| short_diff(&d)),
        // the Markdown is what an agent reads; the rich JSON beside it is the app's
        None => docs::get_version(&session, page_id, version).await.map(|mut v| {
            v.remove("content");
            v
        }),
    };
    Ok(Value::Object(out.map_err(docs_error)?))
}

/// A line diff as the changed lines with one line of context around each run of changes.
fn short_diff(diff: &Map<String, Value>) -> Map<String, Value> {
    let rows: Vec<(&str, &str)> = diff
        .get("rows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| {
            (
                r.get("type").and_then(Value::as_str).unwrap_or("same"),
                r.get("text").and_then(Value::as_str).unwrap_or(""),
            )
        })
        .collect();
    let changed = |i: usize| rows.get(i).is_some_and(|(t, _)| *t != "same");
    let shown: Vec<bool> = (0..rows.len()).map(|i| changed(i) || (i > 0 && changed(i - 1)) || changed(i + 1)).collect();
    let mut lines: Vec<String> = Vec::new();
    for (i, (kind, text)) in rows.iter().enumerate() {
        if !shown[i] {
            continue;
        }
        if i > 0 && !shown[i - 1] && !lines.is_empty() {
            lines.push("…".into());
        }
        let mark = match *kind {
            "add" => '+',
            "del" => '-',
            _ => ' ',
        };
        lines.push(format!("{mark} {text}"));
    }
    let mut out = Map::new();
    for key in ["from", "to", "added", "removed"] {
        out.insert(key.into(), diff.get(key).cloned().unwrap_or(Value::Null));
    }
    out.insert("diff".into(), json!(lines.join("\n")));
    out
}

/// Publish an old version of a Docs page again as a new version (history is kept). Returns {id, title, version}.
pub async fn restore_docs_version(page_id: &str, version: i64) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let page = docs::restore_version(&session, page_id, version, None).await.map_err(docs_error)?;
        Ok(pick(&page, &["id", "title", "version"]))
    })
    .await
}

/// Check whether [[page]] / ticket references resolve: status ok, missing, section_missing, in_bin or ambiguous.
pub async fn resolve_docs_links(project_id: &str, refs: &[String]) -> ToolResult {
    let mut parsed: Vec<Value> = Vec::new();
    for reference in refs {
        let found = docs::parse_references(reference);
        let Some(item) = found.into_iter().next() else {
            return Err(ToolError::Value(format!("'{reference}' is not a [[Page]] link or a ticket key")));
        };
        parsed.push(match item {
            kb_doctext::docs_text::Reference::Page(page) => {
                json!({"kind": "page", "title": page.title, "anchor": page.anchor})
            }
            kb_doctext::docs_text::Reference::Ticket(ticket) => json!({"kind": "ticket", "key": ticket.key}),
        });
    }
    let session = common::async_session();
    Ok(Value::Array(docs::resolve_refs(&session, project_id, &parsed, false).await.map_err(docs_error)?))
}

/// Full-text search over Docs pages (title, headings, body) with snippets. Returns {total, pages, tickets}.
pub async fn search_docs(project_id: &str, query: &str, scope: &str, limit: i64) -> ToolResult {
    let session = common::async_session();
    let params = SearchParams { scope: scope.to_string(), limit, ..SearchParams::default() };
    let res = docs_search::search(&session, project_id, query, &params).await.map_err(docs_error)?;
    let mut out = Map::new();
    for key in ["total", "pages", "tickets"] {
        if let Some(value) = res.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    // the block of each match (the UI opens a result at it) is not part of the tool's answer
    if let Some(Value::Array(pages)) = out.get_mut("pages") {
        for page in pages {
            without_keys(page.get_mut("matches"), &["block_id", "kind", "field", "row", "cells"]);
        }
    }
    Ok(Value::Object(out))
}

/// Removes `keys` from each object of a JSON array (anything else is left as it is).
fn without_keys(rows: Option<&mut Value>, keys: &[&str]) {
    if let Some(Value::Array(rows)) = rows {
        for row in rows.iter_mut().filter_map(Value::as_object_mut) {
            for key in keys {
                row.remove(*key);
            }
        }
    }
}

/// The Markdown files below `root`, as `sorted(root.rglob("*"))` lists them (by path parts), as `(relative name,
/// first MAX_FILE_BYTES + 1 bytes)`.
fn local_markdown(root: &std::path::Path) -> Result<Vec<(String, Vec<u8>)>, ToolError> {
    use std::io::Read;

    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(listing) = std::fs::read_dir(dir) else { return };
        for entry in listing.flatten() {
            let path = entry.path();
            out.push(path.clone());
            // `rglob` does not go into a link to a folder
            if path.is_dir() && !std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                walk(&path, out);
            }
        }
    }

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if root.is_file() {
        candidates.push(root.to_path_buf());
    } else {
        walk(root, &mut candidates);
        candidates.sort_by(|a, b| a.components().cmp(b.components()));
    }
    let mut files = Vec::new();
    for file in candidates {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let suffix = pathlib::suffix_of_name(&name).to_lowercase();
        if !file.is_file() || ![".md", ".markdown"].contains(&suffix.as_str()) {
            continue;
        }
        let rel =
            if root.is_file() { name } else { file.strip_prefix(root).unwrap_or(&file).to_string_lossy().into_owned() };
        let mut data = Vec::new();
        let handle =
            std::fs::File::open(&file).map_err(|err| ToolError::Other(format!("{}: {err}", file.display())))?;
        handle
            .take(docs_import::MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|err| ToolError::Other(format!("{}: {err}", file.display())))?;
        files.push((rel, data));
    }
    Ok(files)
}

/// Import local Markdown files as new Docs pages, published (or as your drafts with publish=false), keeping folders
/// as a tree. Returns {created, failed, skipped, published}.
pub async fn import_docs(project_id: &str, path: &str, parent_id: Option<&str>, publish: bool) -> ToolResult {
    notify_on_success(async {
        let root = std::path::PathBuf::from(kb_base::pypath::expanduser(path));
        if !root.exists() {
            return Err(ToolError::Value(format!("Path not found: {path}")));
        }
        let files = local_markdown(&root)?;
        if files.is_empty() {
            return Err(ToolError::value("No .md or .markdown files found at that path"));
        }
        let session = common::async_session();
        let mut out = docs_import::run_import(&session, project_id, &files, parent_id, "copy", publish)
            .await
            .map_err(docs_error)?;
        out.insert("published".into(), json!(publish));
        if !publish && out.get("created").is_some_and(kb_base::pyjson::truthy) {
            out.insert(
                "note".into(),
                json!(
                    "The pages are your drafts: their published text is still empty. Publish each with \
                     docs_write(update, markdown, base_version=0); an edit before that works on the empty page."
                ),
            );
        }
        Ok(Value::Object(out))
    })
    .await
}

/// Link a Docs page to a ticket manually (shown under 'Linked docs' on the ticket).
pub async fn link_ticket_doc(ticket_id: &str, page_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let linked = kb_docs::docs::link_ticket_doc(&session, ticket_id, page_id).await.map_err(docs_error)?;
        Ok(Value::Object(linked))
    })
    .await
}

/// Remove a manual link between a Docs page and a ticket.
pub async fn unlink_ticket_doc(ticket_id: &str, page_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let removed = kb_docs::docs::unlink_ticket_doc(&session, ticket_id, page_id).await.map_err(docs_error)?;
        Ok(Value::Object(removed))
    })
    .await
}

/// `_thread_brief`: a thread without the UI-only fields (permissions, unread dot, anchor position) and without the
/// board's lines about its text changing.
fn thread_brief(t: &Map<String, Value>) -> Value {
    let get = |key: &str| t.get(key).cloned().unwrap_or(Value::Null);
    let comments: Vec<Value> = t
        .get("comments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                // the line a publish writes when it changed the thread's text ("Text rewritten in v4") is the
                // board's, not something a person said
                .filter(|c| c["ai"]["kind"].as_str() != Some("anchor"))
                .map(|c| {
                    json!({
                        "id": c["id"],
                        "author": c["author"],
                        "body": c["body"],
                        "created_at": c["created_at"],
                        "edited_at": c["edited_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = Map::new();
    out.insert("id".into(), get("id"));
    out.insert("kind".into(), get("kind"));
    out.insert("status".into(), get("status"));
    out.insert("comments".into(), Value::Array(comments));
    if t.get("kind").and_then(Value::as_str) == Some("inline") {
        out.insert("number".into(), get("number"));
        out.insert("quote".into(), t["anchor"]["quote"].clone());
        out.insert("anchor_state".into(), t["anchor"]["state"].clone());
    }
    if t.get("resolved_by").is_some_and(kb_base::pyjson::truthy) {
        out.insert("resolved_by".into(), get("resolved_by"));
    }
    Value::Object(out)
}

/// List a Docs page's comment threads: {threads: [{id, kind: inline|page, status, number, quote, anchor_state:
/// attached|orphaned, comments}], counts}.
pub async fn list_docs_comments(page_id: &str, state: &str) -> ToolResult {
    let token = activity::set_actor(Some(activity::AGENT_ACTOR));
    let result = async {
        let session = common::async_session();
        let res = docs_comments::list_comments(&session, page_id, state, None).await.map_err(docs_error)?;
        let threads: Vec<Value> = res
            .get("threads")
            .and_then(Value::as_array)
            .map(|list| list.iter().map(|t| thread_brief(t.as_object().unwrap_or(&Map::new()))).collect())
            .unwrap_or_default();
        Ok(json!({"threads": threads, "counts": res.get("counts").cloned().unwrap_or(Value::Null)}))
    }
    .await;
    ctx::reset(token);
    result
}

/// `_comment_call`: a thread of the service, briefly.
fn comment_call(thread: kb_docs::Result<Map<String, Value>>) -> ToolResult {
    thread.map(|t| thread_brief(&t)).map_err(docs_error)
}

/// Comment on a Docs page: inline on `quote` (highlighted for people), or on the page as a whole. Returns the thread.
pub async fn add_docs_comment(page_id: &str, body: &str, quote: Option<&str>) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let Some(quote) = quote else {
            return comment_call(docs_comments::create_thread(&session, page_id, "page", body, None, None).await);
        };
        let page = docs::page_detail(&session, page_id).await.map_err(docs_error)?;
        let blocks = docs_anchors::blocks_of(page.get("markdown").and_then(Value::as_str).unwrap_or_default());
        let hit = docs_anchors::find_anchor(&blocks, quote, "", "", None).filter(|hit| hit.exact);
        let Some(hit) = hit else {
            return Err(ToolError::value(
                "That text is not in the published page. Copy it exactly from docs_read(action='get') (plain text, \
                 within one paragraph, list item or table cell), or omit quote to comment on the page.",
            ));
        };
        let anchor =
            Anchor { quote: hit.quote, prefix: hit.prefix, suffix: hit.suffix, section: hit.section, block_id: None };
        comment_call(docs_comments::create_thread(&session, page_id, "inline", body, Some(&anchor), None).await)
    })
    .await
}

/// Reply in a Docs comment thread. Returns the thread.
pub async fn reply_docs_comment(thread_id: &str, body: &str) -> ToolResult {
    notify_on_success(async {
        let run = kb_ai::guard::current();
        // a run on a ticket answers from its conversation there: the reply says which ticket (a chat's or a Docs
        // answer's token has no run of its own)
        let ai = run
            .filter(|run| run.ticket_id.as_deref().is_some_and(|t| !t.is_empty()) && run.run_id.starts_with("run_"))
            .map(|run| {
                json!({
                    "kind": "ticket",
                    "member_id": run.member_id,
                    "ticket_id": run.ticket_id,
                    "run_id": run.run_id,
                })
            });
        let session = common::async_session();
        comment_call(docs_comments::add_reply(&session, thread_id, body, ai.as_ref()).await)
    })
    .await
}

/// Edit a Docs comment written by the agent. Returns the thread.
pub async fn edit_docs_comment(comment_id: &str, body: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        comment_call(docs_comments::edit_comment(&session, comment_id, body).await)
    })
    .await
}

/// Delete a Docs comment written by the agent; deleting a thread's first comment deletes the whole thread.
pub async fn delete_docs_comment(comment_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        Ok(Value::Object(docs_comments::delete_comment(&session, comment_id).await.map_err(docs_error)?))
    })
    .await
}

/// Resolve an inline Docs comment thread (it leaves the page and stays in the Resolved tab).
pub async fn resolve_docs_comment(thread_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        comment_call(docs_comments::set_status(&session, thread_id, "resolved").await)
    })
    .await
}

/// Reopen a resolved inline Docs comment thread.
pub async fn reopen_docs_comment(thread_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        comment_call(docs_comments::set_status(&session, thread_id, "open").await)
    })
    .await
}

/// The largest file `upload` stores.
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

/// `{url, name, size, type, markdown, stored_in...}` of a stored file.
fn stored_reply(url: &str, clean: &str, size: u64, suffix: &str) -> Value {
    let label = clean.replace(['[', ']'], "");
    let image = uploads::SUPPORTED_IMAGE_EXTENSIONS.contains(&suffix);
    let mut out = Map::new();
    out.insert("url".into(), json!(url));
    out.insert("name".into(), json!(clean));
    out.insert("size".into(), json!(size));
    out.insert("type".into(), json!(uploads::mime_by_extension(suffix).unwrap_or("application/octet-stream")));
    out.insert(
        "markdown".into(),
        json!(if image { format!("![{label}]({url})") } else { format!("[{label}]({url})") }),
    );
    out.extend(uploads::storage_info());
    Value::Object(out)
}

/// `_stored`: write `content` to the uploads folder under a unique name.
fn stored(name: &str, content: &[u8]) -> ToolResult {
    let clean: String = pathlib::name(name).chars().take(200).collect();
    let suffix = pathlib::suffix_of_name(&clean).to_lowercase();
    if uploads::mime_by_extension(&suffix).is_none() {
        let shown = if suffix.is_empty() { "a file without an extension" } else { suffix.as_str() };
        return Err(ToolError::Value(format!(
            "{clean}: {shown} is not a type the board stores (png, jpg, webp, gif, svg, pdf, txt, log, json, csv, \
             md, xlsx, docx, pptx, zip, mp4 …)."
        )));
    }
    if kb_board::proofs::never_copied(&clean) {
        return Err(ToolError::Value(format!("{clean}: this kind of file (a key or a secret) is never stored.")));
    }
    if content.len() > MAX_UPLOAD_BYTES {
        return Err(ToolError::Value(format!("{clean}: larger than {} MB.", MAX_UPLOAD_BYTES / (1024 * 1024))));
    }
    let name_on_disk = uploads::build_upload_filename(&clean);
    std::fs::write(uploads::get_uploads_dir(true).join(&name_on_disk), content)
        .map_err(|err| ToolError::Other(err.to_string()))?;
    Ok(stored_reply(&format!("/uploads/{name_on_disk}"), &clean, content.len() as u64, &suffix))
}

/// Store a file (a picture, a PDF, a sheet, a log…) on the board. Returns {url, name, size, type, markdown,
/// stored_in}: put `markdown` in a page, a description or a comment to show it. A folder, a `.zip` or an `.html`
/// file becomes a site for an HTML embed instead: {id, url, entry, files, bytes, markdown} (`markdown` is the
/// embed's marker line).
pub async fn upload_file(path: Option<&str>, data: Option<&str>, name: Option<&str>) -> ToolResult {
    if path.is_none() == data.is_none() {
        return Err(ToolError::value("upload: give path (a local file) or data (base64 with name), not both."));
    }
    if let Some(data) = data {
        let Some(name) = name.filter(|n| !n.is_empty()) else {
            return Err(ToolError::value("upload: data needs name (with its extension, e.g. 'flow.png')."));
        };
        let engine = GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            GeneralPurposeConfig::new()
                .with_decode_allow_trailing_bits(true)
                .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
        );
        let content = engine.decode(data).map_err(|_| ToolError::value("upload: data is not valid base64."))?;
        // a web page (one .html file, or a .zip of a site) becomes a site an HTML embed shows
        if super::docs_sites::is_site_file(name) {
            return super::docs_sites::site_from_data(name, content).await;
        }
        return stored(name, &content);
    }
    let path = path.unwrap_or_default();
    // a folder, a .zip or an .html file becomes a site an HTML embed shows
    if let Some(site) = super::docs_sites::site_from_path(path, name).await? {
        return Ok(site);
    }
    // the same rule as an attachment (ticket_items(item='attachment')): an AI run names a file in its working folders
    // or the ticket's Workspace, an agent outside a board run by its absolute path; keys, `.env` and dot folders never
    let Some(folder) = common::attach_folder().await? else {
        return Err(ToolError::value(
            "upload: this run has no working folder; send the file as data (base64) with name.",
        ));
    };
    let url = kb_board::proofs::ingest_file(path, &folder).await.map_err(|err| ToolError::Value(err.0))?;
    let on_disk = pathlib::name(&url).to_string();
    let size = std::fs::metadata(uploads::get_uploads_dir(true).join(&on_disk))
        .map_err(|err| ToolError::Other(err.to_string()))?
        .len();
    let clean = pathlib::name(name.filter(|n| !n.is_empty()).unwrap_or(path)).to_string();
    let suffix = pathlib::suffix_of_name(&on_disk).to_lowercase();
    Ok(stored_reply(&url, &clean, size, &suffix))
}
