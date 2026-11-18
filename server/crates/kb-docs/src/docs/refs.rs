//! Aliases, resolving `[[references]]` and the link index (`services/docs.py` lines 1335-1657).

use std::collections::{HashMap, HashSet};

use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::{docs_anchor_aliases, docs_link, docs_page, docs_title_aliases, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, Set};
use kb_doctext::docs_text::{heading_anchors, parse_references, slugify};
use serde_json::{Map, Value, json};

use super::pages::{all_pages, opt, project};
use crate::util::nfc;
use crate::{Error, Result, docs_search};

/// `{page id: {old slug: new slug}}` for the pages' renamed headings.
pub async fn aliases_by_page(
    session: &Session,
    page_ids: &[String],
) -> Result<HashMap<String, HashMap<String, String>>> {
    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    if page_ids.is_empty() {
        return Ok(out);
    }
    let rows = docs_anchor_aliases::Entity::find()
        .filter(docs_anchor_aliases::Column::PageId.is_in(page_ids.to_vec()))
        .all(session)
        .await?;
    for a in rows {
        out.entry(a.page_id).or_default().insert(a.old_slug, a.new_slug);
    }
    Ok(out)
}

/// Old (lower-cased) titles of renamed pages mapped to the page id they now belong to.
pub async fn title_aliases(session: &Session, page_ids: &[String]) -> Result<HashMap<String, String>> {
    if page_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = docs_title_aliases::Entity::find()
        .filter(docs_title_aliases::Column::PageId.is_in(page_ids.to_vec()))
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|a| (a.old_title, a.page_id)).collect())
}

/// Keep `[[old_title]]` resolving to the page after a rename (tickets link by page id).
pub async fn remember_title(
    session: &Session,
    page: &docs_page::Model,
    old_title: &str,
    new_title: &str,
) -> Result<()> {
    let rows = docs_title_aliases::Entity::find()
        .filter(docs_title_aliases::Column::PageId.eq(page.id.as_str()))
        .all(session)
        .await?;
    let old = kb_base::pytext::strip(old_title).to_lowercase();
    let new = kb_base::pytext::strip(new_title).to_lowercase();
    let have: HashMap<String, docs_title_aliases::Model> = rows.into_iter().map(|a| (a.old_title.clone(), a)).collect();
    if let Some(live) = have.get(&new) {
        // renamed back: the title is live again
        live.clone().delete(session).await?;
    }
    if old != new && !have.contains_key(&old) {
        let mut row = docs_title_aliases::new();
        row.page_id = Set(page.id.clone());
        row.old_title = Set(old);
        row.insert(session).await?;
    }
    Ok(())
}

/// The current slug a renamed heading's old slug leads to (chains are followed).
fn follow_alias(wanted: &str, slugs: &HashMap<String, String>, aliases: &HashMap<String, String>) -> Option<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut cur = wanted.to_string();
    while aliases.contains_key(&cur) && !seen.contains(&cur) {
        seen.push(cur.clone());
        cur = aliases[&cur].clone();
        if slugs.contains_key(&cur) {
            return Some(cur);
        }
    }
    None
}

/// The headings of each page: `{page id: [(slug, text)]}`.
pub type Headings = HashMap<String, Vec<(String, String)>>;

/// What one `[[reference]]` or Markdown link asks for.
pub struct PageRef<'a> {
    /// The title as written.
    pub title: &'a str,
    /// The `#section` part.
    pub anchor: Option<&'a str>,
    /// A Markdown link by slug or page id: the title may also be a slug, the slug of a title or an id.
    pub by_slug: bool,
}

/// The live pages by id and by lower-cased title, built once for a batch of `resolve_page_ref` calls (rebuilding
/// them for each reference was most of the cost of resolving a long page's links).
pub struct PageIndex<'a> {
    pages: &'a [docs_page::Model],
    by_id: HashMap<&'a str, &'a docs_page::Model>,
    by_title: HashMap<String, Vec<&'a docs_page::Model>>,
}

impl<'a> PageIndex<'a> {
    /// The index of `pages`.
    pub fn new(pages: &'a [docs_page::Model]) -> Self {
        let by_id = pages.iter().map(|p| (p.id.as_str(), p)).collect();
        let mut by_title: HashMap<String, Vec<&docs_page::Model>> = HashMap::new();
        for p in pages {
            by_title.entry(p.title.to_lowercase()).or_default().push(p);
        }
        Self { pages, by_id, by_title }
    }
}

/// Resolve one page reference against the live pages and the Recycle Bin.
///
/// Returns `{status, ...}`: `ok`, `ambiguous`, `section_missing`, `in_bin` or `missing`. `index` is a `PageIndex` of
/// `pages` when the caller resolves many.
pub fn resolve_page_ref(
    pages: &[docs_page::Model],
    deleted: &[docs_page::Model],
    request: &PageRef<'_>,
    headings_of: &Headings,
    aliases: Option<&HashMap<String, HashMap<String, String>>>,
    old_titles: Option<&HashMap<String, String>>,
    index: Option<&PageIndex<'_>>,
) -> Map<String, Value> {
    let title = request.title;
    let needle = kb_base::pytext::strip(title).to_lowercase();
    let own;
    let index = match index {
        Some(index) if std::ptr::eq(index.pages, pages) => index,
        _ => {
            own = PageIndex::new(pages);
            &own
        }
    };
    let by_id = &index.by_id;

    let depth = |p: &docs_page::Model| -> usize {
        let (mut d, mut cur) = (0, p);
        while let Some(parent) = cur.parent_id.as_deref().and_then(|x| by_id.get(x)) {
            d += 1;
            cur = parent;
        }
        d
    };
    let path_of = |p: &docs_page::Model| -> String {
        let mut parts = vec![p.title.clone()];
        let mut cur = p;
        while let Some(parent) = cur.parent_id.as_deref().and_then(|x| by_id.get(x)) {
            cur = parent;
            parts.insert(0, cur.title.clone());
        }
        parts.join("/")
    };

    let mut matches: Vec<&docs_page::Model> = index.by_title.get(&needle).cloned().unwrap_or_default();
    let mut status = "ok";
    if matches.is_empty() && needle.contains('/') {
        matches = pages.iter().filter(|p| path_of(p).to_lowercase().ends_with(&needle)).collect();
    }
    if matches.is_empty() {
        if let Some(id) = old_titles.and_then(|o| o.get(&needle)) {
            // old title of a renamed page
            matches = pages.iter().filter(|p| p.id == *id).collect();
        }
    }
    if matches.is_empty() && request.by_slug {
        // A Markdown link by slug or page id (`[Overview](tong-quan)`, `/docs/overview`): the slug a page got at
        // creation stays after a rename, so it is matched first, then the slug of the current title.
        let key = slugify(&nfc(&needle));
        if !key.is_empty() {
            let stripped = kb_base::pytext::strip(title);
            matches = pages.iter().filter(|p| p.id == stripped || nfc(&p.slug) == key).collect();
            if matches.is_empty() {
                matches = pages.iter().filter(|p| slugify(&nfc(&p.title.to_lowercase())) == key).collect();
            }
        }
    }
    let mut out = Map::new();
    if matches.is_empty() {
        if let Some(gone) = deleted.iter().find(|p| p.title.to_lowercase() == needle) {
            out.insert("status".into(), json!("in_bin"));
            out.insert("title".into(), json!(title));
            out.insert("page_id".into(), json!(gone.id));
            out.insert("deleted_at".into(), opt(&gone.deleted_at));
            out.insert("deleted_by".into(), opt(&gone.deleted_by));
            return out;
        }
        out.insert("status".into(), json!("missing"));
        out.insert("title".into(), json!(title));
        return out;
    }
    if matches.len() > 1 {
        matches.sort_by_key(|p| (depth(p), p.position));
        if depth(matches[0]) == depth(matches[1]) {
            status = "ambiguous";
        }
    }
    let page = matches[0];
    out.insert("status".into(), json!(status));
    out.insert("page_id".into(), json!(page.id));
    out.insert("title".into(), json!(page.title));
    out.insert("slug".into(), json!(page.slug));
    out.insert("path".into(), json!(path_of(page)));
    out.insert("published".into(), json!(page.version > 0));
    if let Some(anchor) = request.anchor.filter(|a| !a.is_empty()) {
        let slugs: HashMap<String, String> =
            headings_of.get(&page.id).map(|v| v.iter().cloned().collect()).unwrap_or_default();
        let mut wanted = slugify(anchor);
        if !slugs.contains_key(&wanted) {
            let none = HashMap::new();
            let alias_map = aliases.and_then(|a| a.get(&page.id)).unwrap_or(&none);
            if let Some(renamed) = follow_alias(&wanted, &slugs, alias_map) {
                wanted = renamed;
                out.insert("anchor_renamed".into(), json!(true));
            }
        }
        if let Some(text) = slugs.get(&wanted) {
            out.insert("anchor".into(), json!(wanted));
            out.insert("section".into(), json!(text));
        } else {
            out.insert("status".into(), json!("section_missing"));
            out.insert("anchor".into(), json!(wanted));
        }
    }
    out
}

/// The headings of each page's published content (or oldest draft).
pub async fn headings_by_page(session: &Session, pages: &[docs_page::Model]) -> Result<Headings> {
    let published: Vec<docs_page::Model> = pages.iter().filter(|p| p.version > 0).cloned().collect();
    let contents = docs_search::contents(session, &published).await?;
    Ok(pages
        .iter()
        .map(|p| {
            let heads = contents
                .get(&p.id)
                .map(|md| heading_anchors(md).into_iter().map(|h| (h.slug, h.text)).collect())
                .unwrap_or_default();
            (p.id.clone(), heads)
        })
        .collect())
}

/// `(title, anchor, by_slug)` of a reference, as `anchor_headings` reads them.
pub type AnchorRef<'a> = (&'a str, Option<&'a str>, bool);

/// `headings_by_page` for only the pages that references with an anchor land on, the only headings
/// `resolve_page_ref` reads: loading and parsing every page of a big space made each page open slow.
pub async fn anchor_headings(
    session: &Session,
    pages: &[docs_page::Model],
    deleted: &[docs_page::Model],
    refs: &[AnchorRef<'_>],
    aliases: Option<&HashMap<String, HashMap<String, String>>>,
    old_titles: Option<&HashMap<String, String>>,
) -> Result<Headings> {
    let mut targets: HashSet<String> = HashSet::new();
    let index = PageIndex::new(pages);
    let none = Headings::new();
    for (title, anchor, by_slug) in refs {
        if anchor.is_some_and(|a| !a.is_empty()) {
            let request = PageRef { title, anchor: None, by_slug: *by_slug };
            let res = resolve_page_ref(pages, deleted, &request, &none, aliases, old_titles, Some(&index));
            if let Some(id) = str_of_map(&res, "page_id") {
                targets.insert(id.to_string());
            }
        }
    }
    let wanted: Vec<docs_page::Model> = pages.iter().filter(|p| targets.contains(&p.id)).cloned().collect();
    headings_by_page(session, &wanted).await
}

/// A request value that is a string (anything else reads as absent).
fn str_of<'a>(r: &'a Value, key: &str) -> Option<&'a str> {
    r.get(key).and_then(Value::as_str)
}

/// Resolve `[[page]]` and ticket references to their current state.
///
/// `refs` are requests, each `{kind: "page", title, anchor}` or `{kind: "ticket", key}`. A page request with
/// `by_slug: true` comes from a Markdown link (`[Overview](tong-quan)`): its title may also be the page's slug, the
/// slug of its title or its id. A `[[Title]]` reference matches by title only, so renaming a page away still breaks
/// it. With `from_ticket` the references are written in a ticket, which links by page id: the old title of a
/// renamed page still resolves. One result per request: status, title, path and, for tickets, their state.
///
/// A link of a rich page also sends the ids it stores (`page_id`, `block_id`): the page is then found by its id
/// whatever its title is now, and the result names the heading or block (`block`: `{block_id, kind, label, detail,
/// slug?}`); a heading link follows the heading when it was renamed (`anchor`, `section` are its current ones). A
/// block that is gone gives the status `block_missing` (with `block_id`).
pub async fn resolve_refs(
    session: &Session,
    project_id: &str,
    refs: &[Value],
    from_ticket: bool,
) -> Result<Vec<Value>> {
    project(session, project_id, false).await?;
    let pages = all_pages(session, project_id, false).await?;
    let deleted = all_pages(session, project_id, true).await?;
    let page_ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
    let aliases = aliases_by_page(session, &page_ids).await?;
    let renamed = if from_ticket { Some(title_aliases(session, &page_ids).await?) } else { None };
    let mut anchored: Vec<AnchorRef<'_>> = Vec::new();
    for r in refs.iter().filter(|r| str_of(r, "kind") != Some("ticket")) {
        // `r.get("title", "")`: a title that is not text fails in Python (a 500)
        let title = match r.get("title") {
            None => "",
            Some(Value::String(s)) => s.as_str(),
            Some(_) => return Err(Error::Other("title is not a string".to_string())),
        };
        anchored.push((title, str_of(r, "anchor"), r.get("by_slug").is_some_and(pyjson::truthy)));
    }
    // a link that stores its page's id follows the page, whatever its title is now
    let by_id: HashMap<&str, &docs_page::Model> = pages.iter().map(|p| (p.id.as_str(), p)).collect();
    let gone_by_id: HashMap<&str, &docs_page::Model> = deleted.iter().map(|p| (p.id.as_str(), p)).collect();
    let live_title =
        |r: &Value| -> Option<String> { str_of(r, "page_id").and_then(|id| by_id.get(id)).map(|p| p.title.clone()) };
    let titles: Vec<Option<String>> = refs.iter().map(live_title).collect();
    for (i, r) in refs.iter().enumerate().filter(|(_, r)| str_of(r, "kind") != Some("ticket")) {
        if let Some(t) = &titles[i] {
            anchored.push((t.as_str(), str_of(r, "anchor"), false));
        }
    }
    let headings = anchor_headings(session, &pages, &deleted, &anchored, Some(&aliases), renamed.as_ref()).await?;
    // the documents of the pages that block links point at
    let block_pages: Vec<docs_page::Model> = refs
        .iter()
        .filter(|r| str_of(r, "block_id").is_some_and(|b| !b.is_empty()))
        .filter_map(|r| str_of(r, "page_id").and_then(|id| by_id.get(id)).map(|p| (*p).clone()))
        .collect();
    let docs = docs_search::rich_docs(session, &block_pages).await?;
    let keys: Vec<String> = refs
        .iter()
        .filter(|r| str_of(r, "kind") == Some("ticket"))
        .filter_map(|r| str_of(r, "key").filter(|k| !k.is_empty()).map(str::to_string))
        .collect();
    let mut tickets: HashMap<String, ticket::Model> = HashMap::new();
    if !keys.is_empty() {
        let rows = ticket::Entity::find()
            .filter(ticket::Column::ProjectId.eq(project_id))
            .filter(ticket::Column::Id.is_in(keys))
            .all(session)
            .await?;
        tickets = rows.into_iter().map(|t| (t.id.clone(), t)).collect();
    }
    let index = PageIndex::new(&pages);
    let mut out = Vec::new();
    for r in refs {
        if str_of(r, "kind") == Some("ticket") {
            let t = tickets.get(str_of(r, "key").unwrap_or(""));
            let mut m = Map::new();
            m.insert("kind".into(), json!("ticket"));
            m.insert("key".into(), r.get("key").cloned().unwrap_or(Value::Null));
            m.insert("status".into(), json!(if t.is_some() { "ok" } else { "missing" }));
            if let Some(t) = t {
                m.insert("title".into(), json!(t.title));
                m.insert("ticket_status".into(), json!(t.status));
            }
            out.push(Value::Object(m));
        } else {
            // `r.get("title", "")`: a title that is not text fails in Python (a 500)
            let title = match r.get("title") {
                None => "",
                Some(Value::String(s)) => s.as_str(),
                Some(_) => return Err(Error::Other("title is not a string".to_string())),
            };
            let i = out.len();
            let stored_id = str_of(r, "page_id").filter(|id| !id.is_empty());
            if let (None, Some(gone)) = (&titles[i], stored_id.and_then(|id| gone_by_id.get(id))) {
                // the page the link stores is in the Recycle Bin
                let mut m = Map::new();
                m.insert("kind".into(), json!("page"));
                m.insert("status".into(), json!("in_bin"));
                m.insert("title".into(), json!(title));
                m.insert("page_id".into(), json!(gone.id));
                m.insert("deleted_at".into(), opt(&gone.deleted_at));
                m.insert("deleted_by".into(), opt(&gone.deleted_by));
                out.push(Value::Object(m));
                continue;
            }
            let title = titles[i].as_deref().unwrap_or(title);
            let request =
                PageRef { title, anchor: str_of(r, "anchor"), by_slug: r.get("by_slug").is_some_and(pyjson::truthy) };
            let mut res =
                resolve_page_ref(&pages, &deleted, &request, &headings, Some(&aliases), renamed.as_ref(), Some(&index));
            if let Some(block_id) = str_of(r, "block_id").filter(|b| !b.is_empty()) {
                resolve_block(&mut res, block_id, &docs);
            }
            let mut m = Map::new();
            m.insert("kind".into(), json!("page"));
            m.extend(res);
            out.push(Value::Object(m));
        }
    }
    Ok(out)
}

/// Names the heading or block a resolved page link points at (`block`), or marks it `block_missing`; `docs` holds
/// the documents of the pages block links point at. A heading link takes the heading's current text and slug.
fn resolve_block(res: &mut Map<String, Value>, block_id: &str, docs: &HashMap<String, Value>) {
    if !matches!(str_of_map(res, "status"), Some("ok" | "section_missing" | "ambiguous")) {
        return;
    }
    let Some(page_id) = str_of_map(res, "page_id") else { return };
    let Some(doc) = docs.get(page_id) else { return };
    match super::blocks::describe_target(doc, block_id) {
        Some(target) => {
            if target.get("kind").and_then(Value::as_str) == Some("heading") {
                if res.get("section").and_then(Value::as_str) != target.get("label").and_then(Value::as_str)
                    && res.contains_key("anchor")
                {
                    res.insert("anchor_renamed".into(), json!(true));
                }
                res.insert("anchor".into(), target.get("slug").cloned().unwrap_or(Value::Null));
                res.insert("section".into(), target.get("label").cloned().unwrap_or(Value::Null));
                if str_of_map(res, "status") == Some("section_missing") {
                    res.insert("status".into(), json!("ok"));
                }
            }
            res.insert("block".into(), target);
        }
        None => {
            res.insert("status".into(), json!("block_missing"));
            res.insert("block_id".into(), json!(block_id));
        }
    }
}

/// Rebuild a page's outgoing reference rows from its Markdown.
pub async fn reindex_links(session: &Session, page: &docs_page::Model, markdown: &str) -> Result<()> {
    reindex_links_of(session, page, markdown, None).await
}

/// Rebuild a page's outgoing reference rows from its Markdown and, for a rich page, its document: each row then
/// names the top-level block it is written in (`source_block_id`), and a link that stores ids points at its page by
/// id and at its heading or block (`target_block_id`).
pub async fn reindex_links_of(
    session: &Session,
    page: &docs_page::Model,
    markdown: &str,
    doc: Option<&Value>,
) -> Result<()> {
    docs_link::Entity::delete_many()
        .filter(docs_link::Column::SourcePageId.eq(page.id.as_str()))
        .filter(docs_link::Column::Origin.eq("page"))
        .exec(session)
        .await?;
    let refs = parse_references(markdown);
    if refs.is_empty() {
        return Ok(());
    }
    let mut requests: Vec<Value> = refs.iter().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)).collect();
    let sites = match doc {
        Some(doc) => {
            let keys: Vec<(bool, String)> = requests
                .iter()
                .map(|r| {
                    let page_ref = str_of(r, "kind") != Some("ticket");
                    let key = if page_ref { str_of(r, "title") } else { str_of(r, "key") };
                    (page_ref, key.unwrap_or("").to_string())
                })
                .collect();
            super::blocks::match_sites(doc, &keys)
        }
        None => vec![None; requests.len()],
    };
    for (r, site) in requests.iter_mut().zip(sites.iter()) {
        if let (Some(obj), Some(super::blocks::SiteTarget::Page { page_id, block_id, .. })) =
            (r.as_object_mut(), site.as_ref().map(|s| &s.target))
        {
            if let Some(id) = page_id {
                obj.insert("page_id".into(), json!(id));
            }
            if let Some(id) = block_id {
                obj.insert("block_id".into(), json!(id));
            }
        }
    }
    let resolved = resolve_refs(session, &page.project_id, &requests, false).await?;
    for ((r, res), site) in requests.iter().zip(resolved.iter()).zip(sites.iter()) {
        let mut row = docs_link::new();
        row.source_page_id = Set(page.id.clone());
        row.source_block_id = Set(site.as_ref().and_then(|s| s.block_id.clone()));
        row.target_block_id = Set(str_of(r, "block_id").map(str::to_string));
        row.source_section = Set(str_of(r, "section").map(str::to_string));
        row.snippet = Set(str_of(r, "snippet").unwrap_or("").to_string());
        if str_of(r, "kind") == Some("ticket") {
            if str_of(res, "status") != Some("ok") {
                continue;
            }
            row.target_ticket_id = Set(str_of(r, "key").map(str::to_string));
        } else {
            row.target_page_id = Set(str_of(res, "page_id").map(str::to_string));
            row.target_title = Set(str_of(r, "title").map(str::to_string));
            row.target_anchor = Set(str_of(r, "anchor").map(str::to_string));
            row.display_text = Set(str_of(r, "display").map(str::to_string));
        }
        row.insert(session).await?;
    }
    Ok(())
}

/// Re-point indexed [[links]] after pages appear, change title, are deleted or restored.
///
/// A link written before its target existed (or while it was in the Recycle Bin) is resolved here, so
/// "Referenced by" stays right without re-publishing the source.
pub async fn refresh_link_targets(session: &Session, project_id: &str) -> Result<()> {
    let pages = all_pages(session, project_id, false).await?;
    let deleted = all_pages(session, project_id, true).await?;
    let ids: Vec<String> = pages.iter().chain(deleted.iter()).map(|p| p.id.clone()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let aliases = aliases_by_page(session, &pages.iter().map(|p| p.id.clone()).collect::<Vec<_>>()).await?;
    let links = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.is_in(ids))
        .filter(docs_link::Column::TargetTitle.is_not_null())
        .all(session)
        .await?;
    let anchored: Vec<AnchorRef<'_>> =
        links.iter().map(|l| (l.target_title.as_deref().unwrap_or(""), l.target_anchor.as_deref(), false)).collect();
    let headings = anchor_headings(session, &pages, &deleted, &anchored, Some(&aliases), None).await?;
    let index = PageIndex::new(&pages);
    for link in links {
        let request = PageRef {
            title: link.target_title.as_deref().unwrap_or(""),
            anchor: link.target_anchor.as_deref(),
            by_slug: false,
        };
        let res = resolve_page_ref(&pages, &deleted, &request, &headings, Some(&aliases), None, Some(&index));
        let mut new_target = str_of_map(&res, "page_id").map(str::to_string);
        // a link to a heading or block of a rich page stores its page's id: it follows the page, whatever its title
        let by_id = link.target_block_id.is_some()
            && link.target_page_id.as_deref().is_some_and(|id| pages.iter().any(|p| p.id == id));
        if by_id {
            new_target = link.target_page_id.clone();
        }
        if new_target != link.target_page_id {
            let mut row = kb_db::edit(link);
            row.target_page_id = Set(new_target);
            row.update(session).await?;
        }
    }
    Ok(())
}

fn str_of_map<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str)
}
