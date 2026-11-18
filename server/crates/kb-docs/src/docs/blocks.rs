//! Headings and blocks of a rich page as link targets, and the links a rich page holds, block by block.
//!
//! A link to a heading or a block stores the page id and the block id (`docRef` attributes `pageId` and
//! `targetBlockId`), so it follows the heading or block when it is renamed or moved. These helpers read a page's
//! document to list what can be linked (`[[Page#` in the editor, "Link a doc" on a ticket), to name a block a link
//! points at ("Limits · table"), and to find which top-level block each link of a page sits in (Referenced by).

use std::collections::HashMap;

use kb_doctext::docs_text::slugify;
use serde_json::{Value, json};

/// The longest label made from a block's own words, in characters.
const LABEL_CHARS: usize = 60;

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

fn attr<'v>(node: &'v Value, key: &str) -> &'v str {
    node.get("attrs").and_then(|a| a.get(key)).and_then(Value::as_str).unwrap_or("")
}

fn children(node: &Value) -> &[Value] {
    match node.get("content") {
        Some(Value::Array(c)) => c,
        _ => &[],
    }
}

/// The block id a node holds (`None` when it has none).
pub fn block_id_of(node: &Value) -> Option<&str> {
    node.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Returns the plain text of one block, one line per text block (as the page's `text` projection writes it).
pub fn block_text(node: &Value) -> String {
    kb_richdoc::doc_to_text(&json!({"type": "doc", "content": [node]}))
}

/// The first line of a text, cut to about `LABEL_CHARS` characters.
fn first_words(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() <= LABEL_CHARS {
        return line.to_string();
    }
    let cut: String = line.chars().take(LABEL_CHARS).collect();
    format!("{}…", cut.trim_end())
}

/// Returns the block with this id anywhere in the document (top-level or nested).
pub fn find_block<'a>(doc: &'a Value, id: &str) -> Option<&'a Value> {
    for child in children(doc) {
        if block_id_of(child) == Some(id) {
            return Some(child);
        }
        if let Some(found) = find_block(child, id) {
            return Some(found);
        }
    }
    None
}

/// The kind of a block as a link target and a search marker: `heading`, `table`, `image`, `code`, `callout`,
/// `diagram`, `sketch`, `canvas`, `video`, `embed`, `link`, `file`, `formula`, `quote`, `list` or `text`.
pub fn block_kind(node: &Value) -> &'static str {
    match node_type(node) {
        "heading" => "heading",
        "table" => "table",
        "image" => "image",
        "codeBlock" => "code",
        "callout" => "callout",
        "diagram" => "diagram",
        "sketch" => "sketch",
        "canvas" => "canvas",
        "video" => "video",
        "htmlEmbed" => "embed",
        "linkEmbed" => "link",
        "fileCard" => "file",
        "mathBlock" => "formula",
        "blockquote" | "pullQuote" => "quote",
        "bulletList" | "orderedList" | "taskList" => "list",
        _ => "text",
    }
}

/// Whether a block is worth linking on its own (captioned, named, tables, images, code, callouts, embeds).
fn linkable(node: &Value) -> bool {
    matches!(
        node_type(node),
        "table"
            | "image"
            | "codeBlock"
            | "callout"
            | "diagram"
            | "sketch"
            | "canvas"
            | "video"
            | "htmlEmbed"
            | "linkEmbed"
            | "fileCard"
            | "mathBlock"
            | "pullQuote"
    )
}

/// A heading a link can point at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadingTarget {
    /// The heading's block id.
    pub block_id: String,
    /// 1 to 6.
    pub level: u64,
    /// The heading's text.
    pub text: String,
    /// Its anchor slug (`docs-<slug>` in the page), numbered like the Markdown headings when repeated.
    pub slug: String,
    /// The text of the closest heading above it with a lower level, if any.
    pub under: Option<String>,
}

/// A block (not a heading) a link can point at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockTarget {
    /// The block's id.
    pub block_id: String,
    /// What it is (`block_kind`).
    pub kind: &'static str,
    /// The words that name it: a caption, a title, a file name, the heading right above a table, or its first words.
    pub label: String,
    /// What it holds, for the list: "Table · 3 columns, 3 rows", "Image · caption", "Code · http".
    pub detail: String,
    /// The heading it sits under, if any.
    pub section: Option<String>,
}

/// Names a block and says what it holds: `(label, detail)`. `heading_above` is the text of the heading right
/// before it (a table is named after it).
fn describe(node: &Value, heading_above: Option<&str>) -> (String, String) {
    let text = block_text(node);
    let named = |values: &[&str]| values.iter().map(|v| v.trim()).find(|v| !v.is_empty()).map(str::to_string);
    match node_type(node) {
        "table" => {
            let rows = children(node);
            let cols = rows.first().map(|r| children(r).len()).unwrap_or(0);
            let label = heading_above.map(str::to_string).unwrap_or_else(|| first_words(&text));
            let detail = format!(
                "Table · {cols} column{}, {} row{}",
                if cols == 1 { "" } else { "s" },
                rows.len(),
                if rows.len() == 1 { "" } else { "s" }
            );
            (label, detail)
        }
        "image" => {
            let caption = attr(node, "caption").trim();
            let label = named(&[caption, attr(node, "alt")]).unwrap_or_else(|| "Image".to_string());
            (label, if caption.is_empty() { "Image".into() } else { "Image · caption".into() })
        }
        "codeBlock" => {
            let lang = attr(node, "language").trim();
            let label = named(&[attr(node, "filename")]).unwrap_or_else(|| first_words(&text));
            (label, if lang.is_empty() { "Code".into() } else { format!("Code · {lang}") })
        }
        "callout" => (named(&[attr(node, "title")]).unwrap_or_else(|| first_words(&text)), "Callout".into()),
        "diagram" => (named(&[attr(node, "label")]).unwrap_or_else(|| "Diagram".into()), "Diagram · draw.io".into()),
        "sketch" => (named(&[attr(node, "label")]).unwrap_or_else(|| "Sketch".into()), "Sketch".into()),
        "canvas" => (named(&[attr(node, "label")]).unwrap_or_else(|| "Canvas".into()), "Canvas".into()),
        "video" => (
            named(&[attr(node, "title"), attr(node, "caption"), attr(node, "src")]).unwrap_or_else(|| "Video".into()),
            "Video".into(),
        ),
        "htmlEmbed" => (named(&[attr(node, "title")]).unwrap_or_else(|| "HTML embed".into()), "HTML embed".into()),
        "linkEmbed" => {
            (named(&[attr(node, "title"), attr(node, "url")]).unwrap_or_else(|| "Link".into()), "Link".into())
        }
        "fileCard" => (named(&[attr(node, "name"), attr(node, "src")]).unwrap_or_else(|| "File".into()), "File".into()),
        "mathBlock" => (first_words(attr(node, "latex")), "Formula".into()),
        "pullQuote" | "blockquote" => (first_words(&text), "Quote".into()),
        "heading" => (first_words(&text), "Heading".into()),
        _ => (first_words(&text), "Text".into()),
    }
}

/// The headings and the blocks worth linking of a page, in reading order (`[[Page#` lists them).
pub fn link_targets(doc: &Value) -> (Vec<HeadingTarget>, Vec<BlockTarget>) {
    let mut headings: Vec<HeadingTarget> = Vec::new();
    let mut blocks: Vec<BlockTarget> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    // the open headings by level, to say which one a heading sits under
    let mut open: Vec<(u64, String)> = Vec::new();
    let mut previous_heading: Option<String> = None;
    for node in kb_richdoc::top_level_blocks(doc) {
        let ty = node_type(node);
        if ty == "columns" {
            continue;
        }
        let Some(id) = block_id_of(node) else {
            previous_heading = None;
            continue;
        };
        if ty == "heading" {
            let level = node.get("attrs").and_then(|a| a.get("level")).and_then(Value::as_u64).unwrap_or(1);
            let text = block_text(node).replace('\n', " ").trim().to_string();
            let mut base = slugify(&text);
            if base.is_empty() {
                base = "section".to_string();
            }
            let count = seen.get(&base).copied().unwrap_or(0) + 1;
            seen.insert(base.clone(), count);
            let slug = if count == 1 { base } else { format!("{base}-{count}") };
            open.retain(|(l, _)| *l < level);
            let under = open.last().map(|(_, t)| t.clone());
            open.push((level, text.clone()));
            headings.push(HeadingTarget { block_id: id.to_string(), level, text: text.clone(), slug, under });
            previous_heading = Some(text);
            continue;
        }
        if linkable(node) {
            let (label, detail) = describe(node, previous_heading.as_deref());
            let section = open.last().map(|(_, t)| t.clone());
            blocks.push(BlockTarget { block_id: id.to_string(), kind: block_kind(node), label, detail, section });
        }
        previous_heading = None;
    }
    (headings, blocks)
}

/// What a link to block `id` of this page points at: `{block_id, kind, label, detail, slug?}` (`slug` for a heading),
/// or `None` when the page has no such block.
pub fn describe_target(doc: &Value, id: &str) -> Option<Value> {
    let (headings, blocks) = link_targets(doc);
    if let Some(h) = headings.iter().find(|h| h.block_id == id) {
        return Some(json!({
            "block_id": h.block_id, "kind": "heading", "label": h.text, "detail": format!("H{}", h.level),
            "slug": h.slug,
        }));
    }
    if let Some(b) = blocks.iter().find(|b| b.block_id == id) {
        return Some(json!({"block_id": b.block_id, "kind": b.kind, "label": b.label, "detail": b.detail}));
    }
    let node = find_block(doc, id)?;
    let (label, detail) = describe(node, None);
    Some(json!({"block_id": id, "kind": block_kind(node), "label": label, "detail": detail}))
}

/// What a link written in a page points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SiteTarget {
    /// A page, or a heading or block of one (`docRef`, `pageCard`).
    Page {
        /// The page title as stored with the link.
        title: String,
        /// The heading text, when the link names one.
        section: Option<String>,
        /// The page id stored with the link (links made in the editor have one).
        page_id: Option<String>,
        /// The block id stored with the link.
        block_id: Option<String>,
    },
    /// A ticket (`ticketRef`, `ticketCard`).
    Ticket(String),
}

/// One link of a rich page and the top-level block it is written in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSite {
    /// The id of the top-level block that holds the link.
    pub block_id: Option<String>,
    /// Where it points.
    pub target: SiteTarget,
}

fn collect_sites(node: &Value, top: Option<&str>, out: &mut Vec<LinkSite>) {
    let opt = |k: &str| Some(attr(node, k).to_string()).filter(|s| !s.is_empty());
    match node_type(node) {
        "docRef" | "pageCard" => {
            let title = attr(node, "page").to_string();
            if !title.trim().is_empty() || opt("pageId").is_some() {
                out.push(LinkSite {
                    block_id: top.map(str::to_string),
                    target: SiteTarget::Page {
                        title,
                        section: opt("section"),
                        page_id: opt("pageId"),
                        block_id: opt("targetBlockId"),
                    },
                });
            }
        }
        "ticketRef" | "ticketCard" => {
            if let Some(key) = opt("key") {
                out.push(LinkSite { block_id: top.map(str::to_string), target: SiteTarget::Ticket(key) });
            }
        }
        _ => {
            for child in children(node) {
                collect_sites(child, top, out);
            }
        }
    }
}

/// The page and ticket links of a rich page, in reading order, each with the top-level block that holds it.
pub fn link_sites(doc: &Value) -> Vec<LinkSite> {
    let mut out = Vec::new();
    for node in kb_richdoc::top_level_blocks(doc) {
        if node_type(node) == "columns" {
            continue;
        }
        let top = block_id_of(node);
        if matches!(node_type(node), "pageCard" | "ticketCard") {
            collect_sites(node, top, &mut out);
            continue;
        }
        for child in children(node) {
            collect_sites(child, top, &mut out);
        }
    }
    out
}

/// The words of a rich page that its Markdown projection leaves out (picture captions, video titles and
/// descriptions, embed titles), one per line: search reads them too.
pub fn search_extras(doc: &Value) -> String {
    fn walk(node: &Value, out: &mut Vec<String>) {
        let keys: &[&str] = match node_type(node) {
            "image" => &["caption"],
            "video" => &["title", "caption", "description"],
            "htmlEmbed" => &["title"],
            "linkEmbed" => &["title", "description"],
            _ => &[],
        };
        for k in keys {
            let v = attr(node, k).trim();
            if !v.is_empty() {
                out.push(v.replace('\n', " "));
            }
        }
        for child in children(node) {
            walk(child, out);
        }
    }
    let mut out = Vec::new();
    walk(doc, &mut out);
    out.join("\n")
}

/// Points every link to page `page_id` at `new_title` (the title stored with the link, which the Markdown
/// projection writes); returns how many changed. Links follow a page by its id, so this only keeps their text right.
pub fn retitle_links_by_id(doc: &mut Value, page_id: &str, new_title: &str) -> usize {
    fn walk(node: &mut Value, page_id: &str, new_title: &str, count: &mut usize) {
        let is_link = matches!(node.get("type").and_then(Value::as_str), Some("docRef" | "pageCard"));
        if is_link {
            if let Some(attrs) = node.get_mut("attrs").and_then(Value::as_object_mut) {
                let hit = attrs.get("pageId").and_then(Value::as_str) == Some(page_id)
                    && attrs.get("page").and_then(Value::as_str) != Some(new_title);
                if hit {
                    attrs.insert("page".into(), Value::String(new_title.to_string()));
                    *count += 1;
                }
            }
        }
        if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
            for child in children {
                walk(child, page_id, new_title, count);
            }
        }
    }
    let mut count = 0;
    walk(doc, page_id, new_title, &mut count);
    count
}

/// The section slugs of a page's top-level blocks: `(block, slug of the heading it sits under)`, numbered like
/// `link_targets` numbers them (a heading sits in its own section).
fn blocks_with_sections(doc: &Value) -> Vec<(&Value, Option<String>)> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut current: Option<String> = None;
    let mut out = Vec::new();
    for node in kb_richdoc::top_level_blocks(doc) {
        if node_type(node) == "columns" {
            continue;
        }
        if node_type(node) == "heading" {
            let text = block_text(node).replace('\n', " ").trim().to_string();
            let mut base = slugify(&text);
            if base.is_empty() {
                base = "section".to_string();
            }
            let count = seen.get(&base).copied().unwrap_or(0) + 1;
            seen.insert(base.clone(), count);
            current = Some(if count == 1 { base } else { format!("{base}-{count}") });
        }
        out.push((node, current.clone()));
    }
    out
}

/// The text a search snippet shows, without its marks, ellipses and escapes: the words to look for in a block.
fn snippet_words(snippet: &str) -> String {
    let plain = snippet.replace("<mark>", "").replace("</mark>", "");
    let plain = plain.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&");
    plain.trim().trim_start_matches('…').trim_end_matches('…').trim().to_string()
}

/// The top-level block a search match sits in, and its kind: the first block of the match's section (`slug`, `None`
/// before the first heading) whose text holds the snippet's words, else the first one that holds a term.
pub fn block_of_match(
    doc: &Value,
    slug: Option<&str>,
    snippet: &str,
    terms: &[String],
) -> Option<(String, &'static str)> {
    let words = snippet_words(snippet).to_lowercase();
    let terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();
    let in_section: Vec<(&Value, String)> = blocks_with_sections(doc)
        .into_iter()
        .filter(|(_, s)| s.as_deref() == slug)
        .filter_map(|(node, _)| block_id_of(node).map(|_| (node, block_text(node).to_lowercase())))
        .collect();
    let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let wanted = squash(&words);
    let hit = in_section
        .iter()
        .find(|(_, text)| !wanted.is_empty() && squash(text).contains(&wanted))
        .or_else(|| in_section.iter().find(|(_, text)| terms.iter().any(|t| text.contains(t.as_str()))))?;
    Some((block_id_of(hit.0)?.to_string(), block_kind(hit.0)))
}

/// Two blocks of two pages that say much the same (Docs health · Overlaps, block by block).
#[derive(Debug, Clone, PartialEq)]
pub struct AlikeBlocks {
    /// The block of the first page, its kind and the words that name it.
    pub a: (String, &'static str, String),
    /// The block of the second page, its kind and the words that name it.
    pub b: (String, &'static str, String),
    /// How much of their text is the same, 0 to 100.
    pub percent: u32,
}

/// The fewest words a block needs to be compared.
const ALIKE_MIN_WORDS: usize = 8;

fn shingle_set(text: &str) -> std::collections::HashSet<String> {
    let words: Vec<String> =
        text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    if words.len() < ALIKE_MIN_WORDS {
        return std::collections::HashSet::new();
    }
    words.windows(3).map(|w| w.join(" ")).collect()
}

/// The top-level blocks (headings left out) of two pages whose text is at least `min` (0 to 1) the same, by runs of
/// three words; each block of `a` is paired with its most alike block of `b`, most alike pairs first.
pub fn alike_blocks(a: &Value, b: &Value, min: f64) -> Vec<AlikeBlocks> {
    let named = |doc: &Value| -> Vec<(String, &'static str, String, std::collections::HashSet<String>)> {
        kb_richdoc::top_level_blocks(doc)
            .into_iter()
            .filter(|n| node_type(n) != "heading")
            .filter_map(|n| {
                let id = block_id_of(n)?.to_string();
                let text = block_text(n);
                let set = shingle_set(&text);
                (!set.is_empty()).then(|| (id, block_kind(n), first_words(&text), set))
            })
            .collect()
    };
    let (left, right) = (named(a), named(b));
    let mut out = Vec::new();
    for (aid, akind, alabel, aset) in &left {
        let best = right
            .iter()
            .map(|(bid, bkind, blabel, bset)| {
                let union = aset.union(bset).count().max(1);
                (aset.intersection(bset).count() as f64 / union as f64, bid, bkind, blabel)
            })
            .max_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
        if let Some((sim, bid, bkind, blabel)) = best {
            if sim >= min {
                out.push(AlikeBlocks {
                    a: (aid.clone(), akind, alabel.clone()),
                    b: (bid.clone(), *bkind, blabel.clone()),
                    percent: (sim * 100.0).round() as u32,
                });
            }
        }
    }
    out.sort_by_key(|x| std::cmp::Reverse(x.percent));
    out
}

/// A table row a search match sits in (States4 I 62 "Table · row 2").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableRowHit {
    /// The row's number, from 1, the header row counted.
    pub row: usize,
    /// The text of each of its cells.
    pub cells: Vec<String>,
}

/// The row of table `block_id` that holds the snippet's words (else the first that holds a term); `None` when the
/// block is not a table or no row holds them.
pub fn table_row_of(doc: &Value, block_id: &str, snippet: &str, terms: &[String]) -> Option<TableRowHit> {
    let table = find_block(doc, block_id).filter(|n| node_type(n) == "table")?;
    let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let wanted = squash(&snippet_words(snippet));
    let rows: Vec<(Vec<String>, String)> = children(table)
        .iter()
        .filter(|r| node_type(r) == "tableRow")
        .map(|r| {
            let cells: Vec<String> =
                children(r).iter().map(|c| block_text(c).split_whitespace().collect::<Vec<_>>().join(" ")).collect();
            let joined = squash(&cells.join(" "));
            (cells, joined)
        })
        .collect();
    let terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();
    let at = rows
        .iter()
        .position(|(_, text)| !wanted.is_empty() && (text.contains(&wanted) || wanted.contains(text.as_str())))
        .or_else(|| rows.iter().position(|(_, text)| terms.iter().any(|t| text.contains(t.as_str()))))?;
    Some(TableRowHit { row: at + 1, cells: rows[at].0.clone() })
}

/// A picture or video whose caption, description or alt text holds a term (search reads them, the Markdown
/// projection leaves some out).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptionHit {
    /// The block's id.
    pub block_id: String,
    /// `image` or `video`.
    pub kind: &'static str,
    /// Which words matched: `caption`, `alt` (an image's description) or `title`.
    pub field: &'static str,
    /// Those words.
    pub text: String,
    /// The heading it sits under (text and slug), if any.
    pub section: Option<(String, String)>,
}

/// The pictures and videos of a page whose caption, description or title holds one of `terms` (lower-cased
/// comparison), in reading order, one per block.
pub fn caption_hits(doc: &Value, terms: &[String]) -> Vec<CaptionHit> {
    let terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).filter(|t| !t.is_empty()).collect();
    let (headings, _) = link_targets(doc);
    let mut out = Vec::new();
    for (node, slug) in blocks_with_sections(doc) {
        let fields: &[(&str, &'static str)] = match node_type(node) {
            "image" => &[("caption", "caption"), ("alt", "alt")],
            "video" => &[("title", "title"), ("caption", "caption"), ("description", "alt")],
            _ => continue,
        };
        let Some(id) = block_id_of(node) else { continue };
        for (key, field) in fields {
            let text = attr(node, key).trim();
            if text.is_empty() || !terms.iter().any(|t| text.to_lowercase().contains(t.as_str())) {
                continue;
            }
            let section = slug
                .as_ref()
                .and_then(|s| headings.iter().find(|h| &h.slug == s).map(|h| (h.text.clone(), h.slug.clone())));
            out.push(CaptionHit {
                block_id: id.to_string(),
                kind: block_kind(node),
                field,
                text: text.replace('\n', " "),
                section,
            });
            break;
        }
    }
    out
}

/// What a link written in a page needs from the page it sits in: for each page reference of `parse_references`
/// (in the same order) and each ticket reference, the link of the rich page it stands for.
///
/// The Markdown projection writes a page link as `[[Title…]]` (its ids are left out), so the references are matched
/// with the links of the document in reading order: a page reference with the next page link of the same title, a
/// ticket reference with the next link to that ticket (a key typed as text has none: its block is the first block,
/// from the last match on, whose text holds the key).
pub fn match_sites(doc: &Value, refs: &[(bool, String)]) -> Vec<Option<LinkSite>> {
    let sites = link_sites(doc);
    let mut used = vec![false; sites.len()];
    let blocks: Vec<(Option<&str>, String)> = kb_richdoc::top_level_blocks(doc)
        .into_iter()
        .filter(|n| node_type(n) != "columns")
        .map(|n| (block_id_of(n), block_text(n)))
        .collect();
    let mut text_cursor = 0;
    let mut out = Vec::new();
    for (is_page, key) in refs {
        let wanted = key.trim().to_lowercase();
        let found = sites.iter().enumerate().position(|(i, site)| {
            !used[i]
                && match &site.target {
                    SiteTarget::Page { title, .. } => *is_page && title.trim().to_lowercase() == wanted,
                    SiteTarget::Ticket(k) => !*is_page && k.to_lowercase() == wanted,
                }
        });
        match found {
            Some(i) => {
                used[i] = true;
                out.push(Some(sites[i].clone()));
            }
            None if !*is_page => {
                let at = blocks.iter().skip(text_cursor).position(|(_, t)| t.contains(key.as_str()));
                match at {
                    Some(k) => {
                        text_cursor += k;
                        let id = blocks[text_cursor].0.map(str::to_string);
                        out.push(Some(LinkSite { block_id: id, target: SiteTarget::Ticket(key.clone()) }));
                    }
                    None => out.push(None),
                }
            }
            None => out.push(None),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Value {
        json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"blockId": "b-000001", "level": 2}, "content": [{"type": "text", "text": "Limits"}]},
            {"type": "table", "attrs": {"blockId": "b-000002"}, "content": [
                {"type": "tableRow", "content": [
                    {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Plan"}]}]},
                    {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Rate"}]}]}
                ]},
                {"type": "tableRow", "content": [
                    {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Free"}]}]},
                    {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "60"}]}]}
                ]}
            ]},
            {"type": "heading", "attrs": {"blockId": "b-000003", "level": 3}, "content": [{"type": "text", "text": "Tokens"}]},
            {"type": "paragraph", "attrs": {"blockId": "b-000004"}, "content": [
                {"type": "text", "text": "See "},
                {"type": "docRef", "attrs": {"page": "Auth", "pageId": "pg1", "targetBlockId": "b-0000aa"}},
                {"type": "text", "text": " and "},
                {"type": "ticketRef", "attrs": {"key": "KAN-1"}}
            ]},
            {"type": "image", "attrs": {"blockId": "b-000005", "src": "/x.png", "alt": "A chart", "caption": "Figure 2"}},
            {"type": "codeBlock", "attrs": {"blockId": "b-000006", "language": "http"}, "content": [{"type": "text", "text": "GET /x\nHost: y"}]}
        ]})
    }

    #[test]
    fn targets_list_headings_and_the_blocks_worth_linking() {
        let (headings, blocks) = link_targets(&page());
        assert_eq!(headings.len(), 2);
        assert_eq!((headings[1].text.as_str(), headings[1].under.as_deref()), ("Tokens", Some("Limits")));
        assert_eq!(headings[0].slug, "limits");
        let labels: Vec<(&str, &str, &str)> =
            blocks.iter().map(|b| (b.kind, b.label.as_str(), b.detail.as_str())).collect();
        assert_eq!(
            labels,
            vec![
                ("table", "Limits", "Table · 2 columns, 2 rows"),
                ("image", "Figure 2", "Image · caption"),
                ("code", "GET /x", "Code · http"),
            ]
        );
        assert_eq!(describe_target(&page(), "b-000003").unwrap()["slug"], "tokens");
        assert!(describe_target(&page(), "b-ffffff").is_none());
    }

    #[test]
    fn sites_name_their_block_and_extras_hold_captions() {
        let sites = link_sites(&page());
        assert_eq!(sites.len(), 2);
        assert_eq!(sites[0].block_id.as_deref(), Some("b-000004"));
        assert!(
            matches!(&sites[0].target, SiteTarget::Page { page_id: Some(p), block_id: Some(b), .. } if p == "pg1" && b == "b-0000aa")
        );
        assert_eq!(sites[1].target, SiteTarget::Ticket("KAN-1".into()));
        assert_eq!(search_extras(&page()), "Figure 2");
        let mut doc = page();
        assert_eq!(retitle_links_by_id(&mut doc, "pg1", "Authentication"), 1);
        assert_eq!(doc["content"][3]["content"][1]["attrs"]["page"], "Authentication");
    }

    #[test]
    fn matches_land_on_their_block() {
        let terms = vec!["free".to_string()];
        let got = block_of_match(&page(), Some("limits"), "<mark>Free</mark> 60", &terms);
        assert_eq!(got, Some(("b-000002".to_string(), "table")));
        let heading = block_of_match(&page(), Some("tokens"), "<mark>Tokens</mark>", &["tokens".to_string()]);
        assert_eq!(heading, Some(("b-000003".to_string(), "heading")));
        assert_eq!(block_of_match(&page(), None, "nothing", &terms), None);
    }

    #[test]
    fn alike_blocks_pair_the_paragraphs_that_say_the_same() {
        let para =
            |id: &str, t: &str| json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [text_node(t)]});
        let a = json!({"type": "doc", "content": [
            para("b-0000a1", "Every route counts requests per token in a sliding one minute window"),
            para("b-0000a2", "Short one")
        ]});
        let b = json!({"type": "doc", "content": [
            para("b-0000b1", "Something else entirely that has nothing in common with the other text"),
            para("b-0000b2", "Every route counts requests per token in a sliding one minute window too")
        ]});
        let got = alike_blocks(&a, &b, 0.6);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].a.0.as_str(), got[0].b.0.as_str(), got[0].a.1), ("b-0000a1", "b-0000b2", "text"));
        assert!(got[0].percent >= 80, "{}", got[0].percent);
    }

    fn text_node(t: &str) -> Value {
        json!({"type": "text", "text": t})
    }

    #[test]
    fn a_table_match_names_its_row() {
        let terms = vec!["free".to_string()];
        let hit = table_row_of(&page(), "b-000002", "<mark>Free</mark> 60", &terms);
        assert_eq!(hit, Some(TableRowHit { row: 2, cells: vec!["Free".into(), "60".into()] }));
        assert_eq!(table_row_of(&page(), "b-000002", "Plan", &["plan".to_string()]).map(|h| h.row), Some(1));
        assert_eq!(table_row_of(&page(), "b-000006", "GET", &["get".to_string()]), None);
    }

    #[test]
    fn captions_are_searched_and_sites_follow_the_markdown_order() {
        let hits = caption_hits(&page(), &["figure".to_string()]);
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].block_id.as_str(), hits[0].kind, hits[0].field), ("b-000005", "image", "caption"));
        assert_eq!(hits[0].section, Some(("Tokens".to_string(), "tokens".to_string())));
        assert_eq!(caption_hits(&page(), &["chart".to_string()])[0].field, "alt");
        let sites = match_sites(&page(), &[(false, "KAN-1".into()), (true, "auth".into()), (true, "Gone".into())]);
        assert_eq!(sites[0].as_ref().and_then(|s| s.block_id.as_deref()), Some("b-000004"));
        assert!(
            matches!(&sites[1], Some(LinkSite { target: SiteTarget::Page { page_id: Some(p), .. }, .. }) if p == "pg1")
        );
        assert!(sites[2].is_none());
    }
}
