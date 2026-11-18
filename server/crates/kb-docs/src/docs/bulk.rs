//! Edits that change many pages at once: the fixes of Docs health's broken-link groups and a rename's plain-text
//! mentions (RichDocsLinks G 40, H 44).
//!
//! A group of broken links is named by what the links point at (the page title and, for a heading or block, its
//! text: `[[Old rules]]`, `[[Data model#Indexes]]`). A fix rewrites every such link of the chosen pages: *Relink*
//! points them at another page, heading or block and keeps the words a link shows of its own; *Remove* keeps the words
//! and drops the link. A rename can also change the plain-text mentions of the old title, block by block, where the
//! person ticked them.
//!
//! Each changed page gets a new published version with a note saying what changed, and its drafts are changed the same
//! way (a draft based on the version just replaced moves to the new one, so the fix is no false conflict), as a rename
//! does with the links it rewrites. A page waiting for (or failed in) its conversion to the rich format is skipped and
//! reported.

use std::collections::HashSet;

use kb_base::activity;
use kb_db::Session;
use kb_db::entities::{docs_draft, docs_page};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, Set};
use serde_json::{Map, Value, json};

use super::body::PageBody;
use super::pages::{all_pages, get_page, latest_version, project};
use super::versions::{check_editable, commit_version, set_draft_body};
use crate::util::casefold;
use crate::{Result, docs_err, docs_search};

/// The words a mention snippet shows around the match, in characters on each side.
const SNIPPET_CHARS: usize = 48;

/// The most plain-text mentions a rename preview lists.
const MAX_MENTIONS: usize = 50;

/// Node types whose text is never a mention (code, formulas, raw HTML).
const NOT_PROSE: &[&str] = &["codeBlock", "mathBlock", "mathInline", "htmlEmbed", "drawio", "excalidraw"];

/// What a broken-link fix does to each link of the group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkFix {
    /// Point the links at another page, or a heading or block of one.
    Relink(LinkTo),
    /// Replace each link by the words it shows.
    Remove,
}

/// Where relinked links point.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LinkTo {
    /// The page (its title is written into the link).
    pub page_id: String,
    /// The heading text, for a link to a heading by its text (`None`: the page itself).
    pub section: Option<String>,
    /// The heading or block id, for a link that follows the block.
    pub block_id: Option<String>,
    /// The heading or block's name, kept with a block link so it can say what was there.
    pub block_label: Option<String>,
}

/// The links a fix changes: those naming `page` (and `anchor`), in `pages`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkGroup {
    /// The page title the links name (compared trimmed and case-folded).
    pub page: String,
    /// The heading or block text the links name; `None` for links to the page itself.
    pub anchor: Option<String>,
    /// The pages whose links change (ids); other pages are left alone.
    pub pages: Vec<String>,
}

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

fn attr_str<'v>(node: &'v Value, key: &str) -> Option<&'v str> {
    node.get("attrs").and_then(|a| a.get(key)).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

fn norm(text: Option<&str>) -> String {
    casefold(text.unwrap_or("").trim())
}

/// Whether a `docRef` or `pageCard` names the group's page and anchor.
fn names_group(node: &Value, page: &str, anchor: &str) -> bool {
    match node_type(node) {
        "docRef" => norm(attr_str(node, "page")) == page && norm(attr_str(node, "section")) == anchor,
        "pageCard" => anchor.is_empty() && norm(attr_str(node, "page")) == page,
        _ => false,
    }
}

/// The words a link shows: its own text, else the page (and heading).
fn shown_words(node: &Value) -> String {
    if let Some(label) = attr_str(node, "label") {
        return label.to_string();
    }
    let page = attr_str(node, "page").unwrap_or("").trim().to_string();
    match attr_str(node, "section") {
        Some(section) => format!("{page} › {}", section.trim()),
        None => page,
    }
}

/// Joins neighbouring text nodes with the same marks (what the editor does when it loads the page).
fn merge_text(children: &mut Vec<Value>) {
    let mut out: Vec<Value> = Vec::with_capacity(children.len());
    for child in children.drain(..) {
        if let Some(last) = out.last_mut() {
            if node_type(last) == "text" && node_type(&child) == "text" && last.get("marks") == child.get("marks") {
                let joined = format!(
                    "{}{}",
                    last.get("text").and_then(Value::as_str).unwrap_or(""),
                    child.get("text").and_then(Value::as_str).unwrap_or("")
                );
                last["text"] = Value::String(joined);
                continue;
            }
        }
        out.push(child);
    }
    *children = out;
}

/// Applies `fix` to the group's links in `doc`; `target_title` is the relink target's current title. Returns how
/// many links changed.
pub fn fix_doc_links(doc: &mut Value, page: &str, anchor: Option<&str>, fix: &LinkFix, target_title: &str) -> usize {
    let page = norm(Some(page));
    let anchor = norm(anchor);
    fn walk(node: &mut Value, page: &str, anchor: &str, fix: &LinkFix, title: &str, count: &mut usize) {
        let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) else {
            return;
        };
        let mut removed = false;
        for child in children.iter_mut() {
            if names_group(child, page, anchor) {
                *count += 1;
                match fix {
                    LinkFix::Relink(to) => relink(child, to, title),
                    LinkFix::Remove => {
                        removed = true;
                        *child = unlinked(child);
                    }
                }
            } else {
                walk(child, page, anchor, fix, title, count);
            }
        }
        if removed {
            merge_text(children);
        }
    }
    let mut count = 0;
    walk(doc, &page, &anchor, fix, target_title, &mut count);
    count
}

fn relink(node: &mut Value, to: &LinkTo, title: &str) {
    let is_card = node_type(node) == "pageCard";
    let Some(attrs) = node.get_mut("attrs").and_then(Value::as_object_mut) else {
        return;
    };
    attrs.insert("page".into(), json!(title));
    attrs.insert("pageId".into(), json!(to.page_id));
    if is_card {
        return;
    }
    attrs.insert("section".into(), json!(to.section));
    attrs.insert("targetBlockId".into(), json!(to.block_id));
    attrs.insert("targetLabel".into(), json!(to.block_label));
}

/// A link replaced by its words: a text node (with the link's marks), or a paragraph for a page card.
fn unlinked(node: &Value) -> Value {
    let words = shown_words(node);
    if node_type(node) == "pageCard" {
        let block_id = node.get("attrs").and_then(|a| a.get("blockId")).cloned().unwrap_or(Value::Null);
        return json!({"type": "paragraph", "attrs": {"blockId": block_id}, "content": [{"type": "text", "text": words}]});
    }
    let mut text = json!({"type": "text", "text": words});
    if let Some(marks) = node.get("marks").filter(|m| m.as_array().is_some_and(|a| !a.is_empty())) {
        text["marks"] = marks.clone();
    }
    text
}

/// The pages to change, checked: each one exists, is live, is in the project and can be edited by the caller.
async fn editable_pages(session: &Session, project_id: &str, ids: &[String]) -> Result<Vec<docs_page::Model>> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            continue;
        }
        let page = get_page(session, id, false, true).await?;
        if page.project_id != project_id {
            return docs_err(404, "page_not_found", "Page not found");
        }
        out.push(page);
    }
    Ok(out)
}

/// What became of one page of a bulk edit.
enum Outcome {
    /// Changed: how many links or mentions, and the page's version now.
    Changed(usize, i32),
    /// Nothing in it to change.
    Untouched,
    /// Not editable now (its conversion to the rich format is pending or failed).
    Skipped(&'static str),
}

/// Applies `edit` to a page's published version (a new version with `note`) and to its drafts.
async fn edit_page(
    session: &Session,
    page: &mut docs_page::Model,
    note: &str,
    edit: &(dyn Fn(&mut Value) -> usize + Sync),
) -> Result<Outcome> {
    if check_editable(page).is_err() {
        return Ok(Outcome::Skipped("not_editable"));
    }
    let actor = activity::current_actor();
    let old_version = page.version;
    let mut published = 0usize;
    if let Some(latest) = latest_version(session, page).await? {
        let body = PageBody::of_version(&latest).into_rich();
        if let Some(mut doc) = body.content.clone() {
            published = edit(&mut doc);
            if published > 0 {
                let title = page.title.clone();
                commit_version(session, page, &PageBody::from_doc(doc), &title, &actor, Some(note), None, false)
                    .await?;
            }
        }
    }
    let drafts =
        docs_draft::Entity::find().filter(docs_draft::Column::PageId.eq(page.id.as_str())).all(session).await?;
    let mut in_drafts = 0usize;
    for d in drafts {
        let Some(mut doc) = PageBody::of_draft(&d).into_rich().content else {
            continue;
        };
        let n = edit(&mut doc);
        let base = d.base_version;
        let mut row = kb_db::edit(d);
        if published > 0 && base == old_version {
            // the fix is in this draft too: no false conflict
            row.base_version = Set(page.version);
        } else if n == 0 {
            continue;
        }
        in_drafts = in_drafts.max(n);
        if n > 0 {
            set_draft_body(&mut row, &PageBody::from_doc(doc));
        }
        row.update(session).await?;
    }
    let changed = if published > 0 { published } else { in_drafts };
    Ok(if changed > 0 { Outcome::Changed(changed, page.version) } else { Outcome::Untouched })
}

/// Fixes a group of broken links in the pages that hold them (`POST /projects/{id}/docs/links/fix`).
///
/// Returns `{links, pages, changed: [{page_id, title, links, version}], skipped: [{page_id, title, reason}]}`:
/// `links` is how many links changed in all, `pages` how many pages.
///
/// # Errors
/// 404 `project_not_found` / `page_not_found` (a page of `group.pages` or the relink target is not in the project or
/// is in the Recycle Bin: `page_deleted` 410), 403 without edit access, 422 `nothing_to_fix` when `group.pages` is
/// empty.
pub async fn fix_links(
    session: &Session,
    project_id: &str,
    group: &LinkGroup,
    fix: &LinkFix,
) -> Result<Map<String, Value>> {
    project(session, project_id, true).await?;
    if group.pages.is_empty() || group.page.trim().is_empty() {
        return docs_err(422, "nothing_to_fix", "Choose the pages whose links to fix");
    }
    let target_title = match fix {
        LinkFix::Relink(to) => {
            let target = get_page(session, &to.page_id, false, false).await?;
            if target.project_id != project_id {
                return docs_err(404, "page_not_found", "Page not found");
            }
            target.title
        }
        LinkFix::Remove => String::new(),
    };
    let pages = editable_pages(session, project_id, &group.pages).await?;
    let label = match &group.anchor {
        Some(a) => format!("{} › {a}", group.page.trim()),
        None => group.page.trim().to_string(),
    };
    let note = match fix {
        LinkFix::Relink(to) => {
            let to_label = match to.section.as_deref().or(to.block_label.as_deref()) {
                Some(s) => format!("{target_title} › {s}"),
                None => target_title.clone(),
            };
            format!("Links to \"{label}\" now point to \"{to_label}\"")
        }
        LinkFix::Remove => format!("Links to \"{label}\" removed (their words kept)"),
    };
    let anchor = group.anchor.clone();
    let page_title = group.page.clone();
    let edit = |doc: &mut Value| fix_doc_links(doc, &page_title, anchor.as_deref(), fix, &target_title);
    let (mut changed, mut skipped, mut total, mut touched) = (Vec::new(), Vec::new(), 0usize, Vec::new());
    for mut page in pages {
        match edit_page(session, &mut page, &note, &edit).await? {
            Outcome::Changed(n, version) => {
                total += n;
                touched.push(page.id.clone());
                changed.push(json!({"page_id": page.id, "title": page.title, "links": n, "version": version}));
            }
            Outcome::Skipped(reason) => {
                skipped.push(json!({"page_id": page.id, "title": page.title, "reason": reason}));
            }
            Outcome::Untouched => {}
        }
    }
    if !touched.is_empty() {
        docs_search::reindex(session, &touched).await?;
    }
    session.commit().await?;
    let mut out = Map::new();
    out.insert("links".into(), json!(total));
    out.insert("pages".into(), json!(changed.len()));
    out.insert("changed".into(), Value::Array(changed));
    out.insert("skipped".into(), Value::Array(skipped));
    Ok(out)
}

/// The byte ranges of `needle` in `hay`, case-insensitive (ASCII and simple Unicode case), not inside a word.
fn find_mentions(hay: &str, needle: &str) -> Vec<(usize, usize)> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Vec::new();
    }
    let lower_hay: Vec<(usize, char)> = hay.char_indices().collect();
    let pattern: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lower_hay.len() {
        let mut j = 0;
        let mut k = i;
        while j < pattern.len() && k < lower_hay.len() {
            let mut lc = lower_hay[k].1.to_lowercase();
            let ok = lc.next() == Some(pattern[j]) && lc.next().is_none();
            if !ok {
                break;
            }
            j += 1;
            k += 1;
        }
        if j == pattern.len() {
            let before_ok = i == 0 || !lower_hay[i - 1].1.is_alphanumeric();
            let after_ok = k >= lower_hay.len() || !lower_hay[k].1.is_alphanumeric();
            if before_ok && after_ok {
                let start = lower_hay[i].0;
                let end = if k < lower_hay.len() { lower_hay[k].0 } else { hay.len() };
                out.push((start, end));
                i = k;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// One block of a page that mentions a title in plain text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    /// The block that holds the words (the nearest block with an id).
    pub block_id: String,
    /// The words before the first mention (up to [`SNIPPET_CHARS`], with "…" when cut).
    pub before: String,
    /// The mention as written.
    pub text: String,
    /// The words after it.
    pub after: String,
    /// How many mentions the block holds.
    pub count: usize,
}

fn tail(text: &str, n: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= n {
        text.to_string()
    } else {
        format!("…{}", chars[chars.len() - n..].iter().collect::<String>())
    }
}

fn head(text: &str, n: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= n { text.to_string() } else { format!("{}…", chars[..n].iter().collect::<String>()) }
}

/// The blocks of `doc` that mention `title` in plain text (not in links, code or formulas), in reading order.
pub fn text_mentions(doc: &Value, title: &str) -> Vec<Mention> {
    fn block_text(node: &Value, out: &mut String) {
        if NOT_PROSE.contains(&node_type(node)) {
            out.push('\n');
            return;
        }
        if node_type(node) == "text" {
            out.push_str(node.get("text").and_then(Value::as_str).unwrap_or(""));
        } else if node_type(node) != "docRef" {
            for c in node.get("content").and_then(Value::as_array).into_iter().flatten() {
                block_text(c, out);
            }
        } else {
            // a link is not plain text; it also splits the words around it
            out.push('\n');
        }
    }
    fn walk(node: &Value, title: &str, out: &mut Vec<Mention>) {
        if NOT_PROSE.contains(&node_type(node)) {
            return;
        }
        let id = node.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str).filter(|s| !s.is_empty());
        let children = node.get("content").and_then(Value::as_array);
        let has_block_child = children.is_some_and(|c| {
            c.iter().any(|ch| ch.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str).is_some())
        });
        if let (Some(id), false) = (id, has_block_child) {
            let mut text = String::new();
            block_text(node, &mut text);
            // text nodes are matched one by one when rewriting, so a mention across a link or a line is no mention
            let found: Vec<(usize, usize)> = text
                .split('\n')
                .scan(0usize, |offset, line| {
                    let base = *offset;
                    *offset += line.len() + 1;
                    Some(find_mentions(line, title).into_iter().map(move |(a, b)| (a + base, b + base)))
                })
                .flatten()
                .collect();
            if let Some(&(a, b)) = found.first() {
                let line_start = text[..a].rfind('\n').map_or(0, |p| p + 1);
                let line_end = text[b..].find('\n').map_or(text.len(), |p| b + p);
                out.push(Mention {
                    block_id: id.to_string(),
                    before: tail(&text[line_start..a], SNIPPET_CHARS),
                    text: text[a..b].to_string(),
                    after: head(&text[b..line_end], SNIPPET_CHARS),
                    count: found.len(),
                });
            }
            return;
        }
        for c in children.into_iter().flatten() {
            walk(c, title, out);
        }
    }
    let mut out = Vec::new();
    walk(doc, title, &mut out);
    out
}

/// Replaces the plain-text mentions of `old_title` by `new_title` in the blocks `block_ids` of `doc` (text nodes one
/// by one, never in links, code or formulas). Returns how many changed.
pub fn rewrite_mentions(doc: &mut Value, old_title: &str, new_title: &str, block_ids: &HashSet<String>) -> usize {
    fn walk(node: &mut Value, inside: bool, old: &str, new: &str, ids: &HashSet<String>, count: &mut usize) {
        if NOT_PROSE.contains(&node_type(node)) {
            return;
        }
        let id = node.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str);
        let inside = match id {
            Some(id) if !id.is_empty() => ids.contains(id),
            _ => inside,
        };
        if inside && node_type(node) == "text" {
            let text = node.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            let found = find_mentions(&text, old);
            if !found.is_empty() {
                let mut out = String::with_capacity(text.len());
                let mut at = 0;
                for (a, b) in &found {
                    out.push_str(&text[at..*a]);
                    out.push_str(new);
                    at = *b;
                }
                out.push_str(&text[at..]);
                node["text"] = Value::String(out);
                *count += found.len();
            }
            return;
        }
        if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
            for c in children {
                walk(c, inside, old, new, ids, count);
            }
        }
    }
    let mut count = 0;
    walk(doc, false, old_title, new_title, block_ids, &mut count);
    count
}

/// The plain-text mentions of `title` in the project's other published pages:
/// `[{page_id, title, parent, block_id, before, text, after, count}]` (at most [`MAX_MENTIONS`] blocks, pages in
/// tree order). `parent` is the title of the page's parent (`None` at the top level).
pub async fn mentions_of(session: &Session, page: &docs_page::Model, title: &str) -> Result<Vec<Value>> {
    let pages = all_pages(session, &page.project_id, false).await?;
    let others: Vec<docs_page::Model> = pages.iter().filter(|p| p.id != page.id && p.version > 0).cloned().collect();
    let docs = docs_search::rich_docs(session, &others).await?;
    let mut out = Vec::new();
    for p in &others {
        let Some(doc) = docs.get(&p.id) else { continue };
        let parent = p.parent_id.as_deref().and_then(|id| pages.iter().find(|x| x.id == id)).map(|x| x.title.clone());
        for m in text_mentions(doc, title) {
            if out.len() >= MAX_MENTIONS {
                return Ok(out);
            }
            out.push(json!({
                "page_id": p.id, "title": p.title, "parent": parent, "block_id": m.block_id,
                "before": m.before, "text": m.text, "after": m.after, "count": m.count,
            }));
        }
    }
    Ok(out)
}

/// Rewrites the plain-text mentions a person ticked in a rename: `(page_id, block_id)` pairs. Returns
/// `(mentions changed, pages changed)`; pages that cannot be edited now are left alone.
///
/// # Errors
/// As [`get_page`] for a page that is gone or not editable by the caller.
pub async fn rename_mentions(
    session: &Session,
    project_id: &str,
    old_title: &str,
    new_title: &str,
    chosen: &[(String, String)],
) -> Result<(usize, usize)> {
    let mut page_ids: Vec<String> = Vec::new();
    for (p, _) in chosen {
        if !page_ids.contains(p) {
            page_ids.push(p.clone());
        }
    }
    let pages = editable_pages(session, project_id, &page_ids).await?;
    let note = format!("Mentions of \"{old_title}\" changed to \"{new_title}\"");
    let (mut total, mut changed_pages, mut touched) = (0usize, 0usize, Vec::new());
    for mut page in pages {
        let ids: HashSet<String> = chosen.iter().filter(|(p, _)| *p == page.id).map(|(_, b)| b.clone()).collect();
        let edit = |doc: &mut Value| rewrite_mentions(doc, old_title, new_title, &ids);
        if let Outcome::Changed(n, _) = edit_page(session, &mut page, &note, &edit).await? {
            total += n;
            changed_pages += 1;
            touched.push(page.id.clone());
        }
    }
    if !touched.is_empty() {
        docs_search::reindex(session, &touched).await?;
    }
    Ok((total, changed_pages))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> Value {
        json!({"type": "text", "text": t})
    }

    fn para(id: &str, content: Value) -> Value {
        json!({"type": "paragraph", "attrs": {"blockId": id}, "content": content})
    }

    fn link(page: &str, section: Option<&str>, label: Option<&str>) -> Value {
        json!({"type": "docRef", "attrs": {"page": page, "section": section, "label": label, "pageId": null,
            "targetBlockId": null, "targetLabel": null}})
    }

    #[test]
    fn relink_points_the_group_at_the_new_page_and_keeps_own_text() {
        let mut doc = json!({"type": "doc", "content": [
            para("b-000001", json!([text("Check "), link("Old rules", None, None), text(" and "),
                link("old rules", None, Some("the rules")), text(" or "), link("Old rules", Some("Intro"), None)])),
        ]});
        let to = LinkTo { page_id: "p2".into(), ..LinkTo::default() };
        let n = fix_doc_links(&mut doc, "Old rules", None, &LinkFix::Relink(to), "Decision log");
        assert_eq!(n, 2);
        let c = &doc["content"][0]["content"];
        assert_eq!(c[1]["attrs"]["page"], "Decision log");
        assert_eq!(c[1]["attrs"]["pageId"], "p2");
        assert_eq!(c[3]["attrs"]["label"], "the rules");
        assert_eq!(c[5]["attrs"]["page"], "Old rules", "a link to a heading is another group");
    }

    #[test]
    fn remove_keeps_the_words_and_joins_the_text() {
        let mut doc = json!({"type": "doc", "content": [
            para("b-000001", json!([text("Check "), link("Old rules", None, None), text(" for the older rules.")])),
            {"type": "pageCard", "attrs": {"blockId": "b-000002", "page": "Old rules", "pageId": null}},
        ]});
        let n = fix_doc_links(&mut doc, "Old rules", None, &LinkFix::Remove, "");
        assert_eq!(n, 2);
        assert_eq!(doc["content"][0]["content"], json!([text("Check Old rules for the older rules.")]));
        assert_eq!(doc["content"][1]["type"], "paragraph");
        assert_eq!(doc["content"][1]["attrs"]["blockId"], "b-000002");
    }

    #[test]
    fn heading_group_matches_only_its_heading() {
        let mut doc = json!({"type": "doc", "content": [
            para("b-000001", json!([link("Data model", Some("Indexes"), None), link("Data model", None, None)])),
        ]});
        let to = LinkTo { page_id: "p1".into(), section: Some("Index plan".into()), ..LinkTo::default() };
        assert_eq!(fix_doc_links(&mut doc, "Data model", Some("indexes"), &LinkFix::Relink(to), "Data model"), 1);
        assert_eq!(doc["content"][0]["content"][0]["attrs"]["section"], "Index plan");
        assert_eq!(doc["content"][0]["content"][1]["attrs"]["section"], Value::Null);
    }

    #[test]
    fn mentions_are_found_by_block_and_rewritten_where_chosen() {
        let mut doc = json!({"type": "doc", "content": [
            para("b-000001", json!([text("The new rate limiting headers ship on Friday.")])),
            para("b-000002", json!([text("Start Rate limiting with free plans; Rate limiting again.")])),
            para("b-000003", json!([text("Ratelimiting is one word; "), link("Rate limiting", None, None)])),
            {"type": "codeBlock", "attrs": {"blockId": "b-000004"}, "content": [text("rate limiting")]},
        ]});
        let found = text_mentions(&doc, "Rate limiting");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].block_id, "b-000001");
        assert_eq!(found[0].before, "The new ");
        assert_eq!(found[0].text, "rate limiting");
        assert_eq!(found[1].count, 2);
        let ids: HashSet<String> = ["b-000002".to_string()].into_iter().collect();
        assert_eq!(rewrite_mentions(&mut doc, "Rate limiting", "Request limits", &ids), 2);
        assert_eq!(
            doc["content"][1]["content"][0]["text"],
            "Start Request limits with free plans; Request limits again."
        );
        assert_eq!(doc["content"][0]["content"][0]["text"], "The new rate limiting headers ship on Friday.");
    }
}
