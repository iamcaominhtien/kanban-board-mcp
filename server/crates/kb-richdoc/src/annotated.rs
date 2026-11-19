//! The annotated Markdown flavour (README "The two Markdown flavours" and "Annotated attribute names"): the MCP
//! view of a page and the input of block edits.
//!
//! Writing: one marker line `<!-- #b-xxxxxx [type] key=value … -->` before every top-level block, the block in
//! plain Markdown with inline spans for marks plain Markdown cannot hold. Each block is read back before it is
//! written; when its Markdown cannot reproduce it exactly (even with block syntax at line starts escaped), it is
//! written as a placeholder line that keeps its id.
//!
//! Reading: the blocks under a marker take its id and attributes; nested blocks keep the ids and the attributes
//! plain Markdown cannot show from the block of the same id in `existing` (by position); placeholders are taken
//! from `existing`.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::chars::{is_space, trim};
use crate::ids::{block_id, is_block_id, set_block_id};
use crate::md::build::parse_blocks;
use crate::md::write::{annotated_block, embed_line, plain_line};
use crate::schema::{AttrSpec, AttrType, attr, canonical, same, schema};
use crate::{IdSource, RichDocError, SeqIds};

// ---------------------------------------------------------------- attribute names and values

/// The annotated name of a schema attribute of a node type (README "Annotated attribute names").
pub fn short_name(node_type: &str, attr_name: &str) -> String {
    let s = match (node_type, attr_name) {
        ("image", "width") => "px",
        ("image" | "diagram" | "video", "widthPct") => "width",
        ("image", "wrapGap") => "gap",
        (_, "textAlign") => "align",
        (_, "lineHeight") => "line-height",
        (_, "spaceBefore") => "before",
        (_, "spaceAfter") => "after",
        (_, "dropCap") => "dropcap",
        (_, "listStyle") => "style",
        (_, "language") => "lang",
        (_, "filename") => "file",
        (_, "lineNumbers") => "numbers",
        (_, "highlightLines") => "lines",
        (_, "runScripts") => "scripts",
        (_, "pageId") => "page-id",
        (_, "targetBlockId") => "target",
        (_, "targetLabel") => "target-label",
        (_, other) => other,
    };
    s.to_string()
}

/// The schema attribute an annotated name (or the schema name itself) stands for on a node type.
pub fn schema_name(node_type: &str, key: &str) -> Option<String> {
    let spec = schema().nodes.get(node_type)?;
    if key != "blockId" && spec.attrs.contains_key(key) && short_name(node_type, key) == key {
        return Some(key.to_string());
    }
    let found = spec.attrs.keys().find(|k| *k != "blockId" && short_name(node_type, k) == key);
    if let Some(k) = found {
        return Some(k.clone());
    }
    // the schema name is accepted too
    (key != "blockId" && spec.attrs.contains_key(key)).then(|| key.to_string())
}

/// A string value as written in a marker or span: bare when it is a plain word, else a JSON string (with `-->`
/// made safe for an HTML comment).
pub fn quote(v: &str) -> String {
    let bare = !v.is_empty()
        && !matches!(v, "null" | "true" | "false")
        && v.parse::<f64>().is_err()
        && v.chars().all(|c| !is_space(c) && !matches!(c, '"' | '\'' | '=' | '<' | '>' | '`' | '{' | '}' | '\\'))
        && !v.contains("--");
    if bare {
        return v.to_string();
    }
    let j = serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    j.replace("--", "-\\u002d").replace('>', "\\u003e")
}

/// Any JSON value as written in a marker or span.
pub fn quote_value(v: &Value) -> String {
    match v {
        Value::String(s) => quote(s),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => quote(&other.to_string()),
    }
}

/// Reads a value at `i` of an attribute list (`"json string"` or a bare word up to a space or `}`): the text,
/// whether it was quoted and the position after it. `None` for a broken quoted value.
pub fn read_value(b: &[char], i: usize) -> Option<(String, bool, usize)> {
    if b.get(i) == Some(&'"') {
        let mut j = i + 1;
        while j < b.len() {
            match b[j] {
                '\\' => j += 2,
                '"' => break,
                '\n' => return None,
                _ => j += 1,
            }
        }
        if j >= b.len() {
            return None;
        }
        let lit: String = b[i..=j].iter().collect();
        let v: String = serde_json::from_str(&lit).ok()?;
        return Some((v, true, j + 1));
    }
    let mut j = i;
    while j < b.len() && !is_space(b[j]) && b[j] != '}' {
        j += 1;
    }
    Some((b[i..j].iter().collect(), false, j))
}

/// Converts a marker value to the attribute's type: a quoted value is a string (or JSON for objects and arrays), a
/// bare one is typed by the schema.
fn typed_value(text: &str, quoted: bool, spec: &AttrSpec) -> Option<Value> {
    if quoted {
        let s = text;
        return match &spec.ty {
            AttrType::ObjectOrNull | AttrType::ArrayOrNull => serde_json::from_str(s).ok(),
            AttrType::Number { .. } | AttrType::NumberOrNull => num_value(s),
            AttrType::Enum(vals) if vals.iter().any(Value::is_number) => num_value(s).or(Some(Value::String(s.into()))),
            _ => Some(Value::String(s.to_string())),
        };
    }
    if text == "null" {
        let nullable = match &spec.ty {
            AttrType::Enum(vals) => vals.iter().any(Value::is_null),
            AttrType::String | AttrType::Boolean | AttrType::Number { .. } => false,
            _ => true,
        };
        if nullable {
            return Some(Value::Null);
        }
    }
    match &spec.ty {
        AttrType::Boolean => match text {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        },
        AttrType::Number { .. } | AttrType::NumberOrNull => num_value(text),
        AttrType::Enum(vals) => {
            if vals.iter().any(Value::is_number) {
                if let Some(n) = num_value(text) {
                    return Some(n);
                }
            }
            Some(Value::String(text.to_string()))
        }
        AttrType::ObjectOrNull | AttrType::ArrayOrNull => serde_json::from_str(text).ok(),
        AttrType::String | AttrType::StringOrNull => Some(Value::String(text.to_string())),
    }
}

fn num_value(s: &str) -> Option<Value> {
    let n: f64 = s.trim().parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Some(Value::from(n as i64))
    } else {
        serde_json::Number::from_f64(n).map(Value::Number)
    }
}

fn check_typed(node_type: &str, key: &str, v: &Value) -> bool {
    crate::schema::check_attr(node_type, key, v).is_ok()
}

// ---------------------------------------------------------------- markers

/// A marker line read from the input.
#[derive(Debug, Clone, Default)]
struct Marker {
    id: Option<String>,
    word: Option<String>,
    pairs: Vec<(String, String, bool)>,
}

#[derive(Debug, Clone)]
enum MarkerLine {
    Block(Marker),
    Column(Option<String>),
    ColumnsEnd,
}

/// Parses a line that is an HTML comment as a marker. `Ok(None)` for a comment that is not a marker (prose); a
/// comment that starts like a marker (`#id`, a block type, `column`, `/columns` or `key=value`) but is broken is a
/// [`RichDocError::Syntax`].
fn parse_marker(line: &str) -> Result<Option<MarkerLine>, RichDocError> {
    let t = trim(line);
    let Some(inner) = t.strip_prefix("<!--").and_then(|r| r.strip_suffix("-->")) else { return Ok(None) };
    if inner.contains("-->") {
        return Ok(None);
    }
    let body = trim(inner);
    if body == "/columns" {
        return Ok(Some(MarkerLine::ColumnsEnd));
    }
    // the guide's names for a block (`<!-- divider style=thick -->`, `<!-- picture placement=floatRight -->`) stand
    // for its type, as agents write them
    let (word, rest) = body.split_once(char::is_whitespace).unwrap_or((body, ""));
    let named = block_alias(word).map(|ty| format!("{ty} {rest}"));
    let body = named.as_deref().unwrap_or(body);
    let chars: Vec<char> = body.chars().collect();
    let first: String = chars.iter().take_while(|c| !is_space(**c)).collect();
    let pair_like = first
        .split_once('=')
        .is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let looks = first.starts_with('#') || first == "column" || schema().nodes.contains_key(first.as_str()) || pair_like;
    if !looks {
        return Ok(None);
    }
    let broken = |why: &str| RichDocError::Syntax(format!("broken marker {t}: {why}"));
    let mut i = 0;
    let mut m = Marker::default();
    let mut first_token = true;
    while i < chars.len() {
        while i < chars.len() && is_space(chars[i]) {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let st = i;
        while i < chars.len() && !is_space(chars[i]) && chars[i] != '=' {
            i += 1;
        }
        let word: String = chars[st..i].iter().collect();
        if chars.get(i) == Some(&'=') {
            let Some((v, quoted, next)) = read_value(&chars, i + 1) else {
                return Err(broken("a quoted value is not closed"));
            };
            m.pairs.push((word, v, quoted));
            i = next;
        } else if let Some(id) = word.strip_prefix('#') {
            if !first_token {
                return Err(broken("the id must come first"));
            }
            if !is_block_id(id) {
                return Err(broken(&format!("{id} is not a block id (b- and 6 hex digits)")));
            }
            m.id = Some(id.to_string());
        } else {
            if m.word.is_some() || !m.pairs.is_empty() {
                return Err(broken(&format!("unexpected {word}")));
            }
            if word != "column" && !schema().nodes.contains_key(word.as_str()) {
                return Err(broken(&format!("unknown block type {word}")));
            }
            m.word = Some(word);
        }
        first_token = false;
    }
    if m.word.as_deref() == Some("column") {
        if !m.pairs.is_empty() {
            return Err(broken("a column has no attributes"));
        }
        return Ok(Some(MarkerLine::Column(m.id)));
    }
    Ok(Some(MarkerLine::Block(m)))
}

/// The block type a name of the guide stands for in a marker (`divider` for `horizontalRule`), or `None`.
fn block_alias(word: &str) -> Option<&'static str> {
    Some(match word {
        "divider" | "rule" => "horizontalRule",
        "picture" | "img" => "image",
        "quote" => "blockquote",
        "code" => "codeBlock",
        "math" => "mathBlock",
        "pullquote" => "pullQuote",
        _ => return None,
    })
}

/// A marker line; empty when it would say nothing (a block without id or attributes).
fn marker_text(id: Option<&str>, word: Option<&str>, pairs: &[(String, String)]) -> String {
    let mut parts = Vec::new();
    if let Some(id) = id {
        parts.push(format!("#{id}"));
    }
    if let Some(w) = word {
        parts.push(w.to_string());
    }
    for (k, v) in pairs {
        parts.push(format!("{k}={v}"));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("<!-- {} -->", parts.join(" "))
}

// ---------------------------------------------------------------- conversions and placeholders

/// Node types plain Markdown has no form for: always a placeholder.
const PLACEHOLDER_TYPES: &[&str] = &["video", "htmlEmbed", "linkEmbed"];

/// Whether a top-level block is a placeholder (no Markdown form): video, HTML embed, link card, merged table.
pub fn is_placeholder(block: &Value) -> bool {
    let t = block.get("type").and_then(Value::as_str).unwrap_or("");
    PLACEHOLDER_TYPES.contains(&t) || (t == "table" && has_merged_cells(block))
}

fn has_merged_cells(table: &Value) -> bool {
    children(table).iter().any(|row| {
        children(row).iter().any(|c| {
            let span = |k: &str| attr(c, k).as_f64().unwrap_or(1.0);
            span("colspan") > 1.0 || span("rowspan") > 1.0
        })
    })
}

fn children(n: &Value) -> &[Value] {
    match n.get("content") {
        Some(Value::Array(c)) => c,
        _ => &[],
    }
}

fn ty(n: &Value) -> &str {
    n.get("type").and_then(Value::as_str).unwrap_or("")
}

/// The placeholder line of a block (README: `[embed: <kind> · <title>]`).
fn placeholder_line(block: &Value) -> String {
    let s = |k: &str| attr(block, k).as_str().unwrap_or("").to_string();
    let first = |v: &[String]| v.iter().find(|x| !x.is_empty()).cloned().unwrap_or_default();
    match ty(block) {
        "video" => embed_line("video", &first(&[s("title"), s("caption"), s("src")])),
        "htmlEmbed" => embed_line("HTML embed", &s("title")),
        "linkEmbed" => embed_line("link", &first(&[s("title"), s("url")])),
        "table" if has_merged_cells(block) => {
            let title = children(block)
                .first()
                .map(|row| children(row).iter().map(|c| crate::text::cell_text(c, 0)).collect::<Vec<_>>().join(" | "))
                .unwrap_or_default();
            embed_line("table with merged cells", &title)
        }
        t => {
            let text = crate::text::doc_to_text(&json!({"type": "doc", "content": [block]}));
            let line = plain_line(text.lines().next().unwrap_or(""));
            let short: String = line.chars().take(80).collect();
            embed_line(t, &short)
        }
    }
}

/// Whether a block read from Markdown is a placeholder line `[embed: …]` (whatever the line's text was read as).
fn is_embed_line(block: &Value) -> bool {
    if ty(block) != "paragraph" {
        return false;
    }
    let text = crate::text::inline_text(block, 0);
    text.starts_with("[embed: ") && text.ends_with(']') && !text.contains('\n')
}

/// Turns a block read from Markdown into `target` when the plain flavour reads that type as another one (a file
/// card reads as a paragraph with a link, a pull quote as a blockquote…). `None` when the shape does not fit.
fn convert(block: Value, target: &str) -> Option<Value> {
    let t = ty(&block).to_string();
    if t == target {
        return Some(block);
    }
    let c = children(&block);
    match (t.as_str(), target) {
        ("paragraph", "fileCard") => {
            let link = c.first()?.get("marks")?.as_array()?.iter().find(|m| m["type"] == "link")?.clone();
            let all_linked = c.iter().all(|n| {
                n["type"] == "text"
                    && n.get("marks").and_then(Value::as_array).is_some_and(|ms| ms.iter().any(|m| m == &link))
            });
            if !all_linked {
                return None;
            }
            let name: String = c.iter().map(|n| n["text"].as_str().unwrap_or("")).collect();
            let src = link["attrs"]["href"].as_str().unwrap_or("").to_string();
            Some(json!({"type": "fileCard", "attrs": {"src": src, "name": name}}))
        }
        ("paragraph", "pageCard") if c.len() == 1 && c[0]["type"] == "docRef" => {
            Some(json!({"type": "pageCard", "attrs": {"page": attr(&c[0], "page")}}))
        }
        ("paragraph", "ticketCard") if c.len() == 1 && c[0]["type"] == "ticketRef" => {
            Some(json!({"type": "ticketCard", "attrs": {"key": attr(&c[0], "key")}}))
        }
        ("paragraph", "ticketCard") if c.len() == 1 && c[0]["type"] == "text" && c[0].get("marks").is_none() => {
            Some(json!({"type": "ticketCard", "attrs": {"key": c[0]["text"]}}))
        }
        ("paragraph", "pageCard") if c.is_empty() => Some(json!({"type": "pageCard"})),
        ("paragraph", "ticketCard") if c.is_empty() => Some(json!({"type": "ticketCard"})),
        ("blockquote", "pullQuote") if c.len() <= 1 && c.first().is_none_or(|p| ty(p) == "paragraph") => {
            let inner = c.first().map(|p| children(p).to_vec()).unwrap_or_default();
            let mut n = json!({"type": "pullQuote"});
            if !inner.is_empty() {
                n["content"] = Value::Array(inner);
            }
            Some(n)
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- restoring nested blocks

/// The attributes plain Markdown holds for a node type: these come from the Markdown, the others from the page.
fn markdown_held(node_type: &str) -> &'static [&'static str] {
    match node_type {
        "heading" => &["level"],
        "codeBlock" => &["language"],
        "orderedList" => &["start", "type"],
        "taskItem" => &["checked"],
        "image" => &["src", "alt", "title", "width"],
        "callout" => &["kind"],
        "diagram" | "sketch" => &["id", "label"],
        "canvas" => &["id", "label", "fragment"],
        "mathBlock" => &["latex"],
        "fileCard" => &["src", "name"],
        "pageCard" => &["page"],
        "ticketCard" => &["key"],
        "tableCell" | "tableHeader" => &["align"],
        _ => &[],
    }
}

/// The column alignments a table writes (the first set alignment of each column).
fn column_aligns(table: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for row in children(table) {
        for (i, c) in children(row).iter().enumerate() {
            if out.len() <= i {
                out.push(Value::Null);
            }
            if out[i].is_null() {
                out[i] = attr(c, "align").clone();
            }
        }
    }
    out
}

/// Gives the nested blocks of `new` the ids and page-only attributes of the blocks at the same place in `old`.
fn restore(new: &mut Value, old: &Value, depth: usize) {
    if depth > crate::schema::MAX_DOC_DEPTH * 2 {
        return;
    }
    let same_aligns = ty(new) == "table" && column_aligns(new) == column_aligns(old);
    let old_kids = children(old).to_vec();
    let Some(new_kids) = new.get_mut("content").and_then(Value::as_array_mut) else { return };
    for (i, nk) in new_kids.iter_mut().enumerate() {
        let Some(ok) = old_kids.get(i) else { break };
        if ty(nk) != ty(ok) || ty(nk) == "text" {
            continue;
        }
        if crate::ids::carries_block_id(ty(nk)) {
            restore_attrs(nk, ok, same_aligns);
        }
        restore(nk, ok, depth + 1);
    }
}

/// The attributes of a nested block: the page's, except those its Markdown holds.
fn restore_attrs(new: &mut Value, old: &Value, same_aligns: bool) {
    let t = ty(new).to_string();
    let Some(spec) = schema().nodes.get(&t) else { return };
    let held = markdown_held(&t);
    let mut attrs = Map::new();
    for k in spec.attrs.keys() {
        let from_md = held.contains(&k.as_str()) && !(k == "align" && same_aligns);
        let mut v = if from_md { attr(new, k).clone() } else { attr(old, k).clone() };
        if t == "callout" && k == "kind" && attr(old, k) == "custom" && v == "info" {
            v = Value::String("custom".into());
        }
        attrs.insert(k.clone(), v);
    }
    if let Some(obj) = new.as_object_mut() {
        obj.insert("attrs".into(), Value::Object(attrs));
    }
}

// ---------------------------------------------------------------- reading

/// The page's top-level blocks by id (the first holder of an id).
fn index(existing: Option<&Value>) -> HashMap<String, &Value> {
    let mut map = HashMap::new();
    if let Some(doc) = existing {
        for b in crate::ids::top_level(doc) {
            if let Some(id) = block_id(b) {
                map.entry(id.to_string()).or_insert(b);
            }
        }
    }
    map
}

/// Reads the blocks of annotated Markdown, with the page's blocks at hand.
struct Reader<'a> {
    existing: HashMap<String, &'a Value>,
    errors: Vec<String>,
}

impl<'a> Reader<'a> {
    fn new(existing: HashMap<String, &'a Value>) -> Self {
        Reader { existing, errors: Vec::new() }
    }

    /// The blocks of one chunk of Markdown under an optional marker.
    fn chunk(&mut self, marker: Option<&Marker>, text: &str) -> Result<Vec<Value>, RichDocError> {
        let text = trim_blank_lines(text);
        let text = text.as_str();
        let (mut blocks, errors) = if text.is_empty() { (Vec::new(), Vec::new()) } else { parse_blocks(text, true) };
        if let Some(e) = errors.into_iter().next() {
            return Err(RichDocError::Syntax(format!("broken span: {e}")));
        }
        let Some(m) = marker else { return Ok(blocks) };
        // a placeholder line is recognised as written, whatever its title would read as
        if m.word.is_some() && !text.contains('\n') && text.starts_with("[embed: ") && text.ends_with(']') {
            let id =
                m.id.clone().ok_or_else(|| RichDocError::Syntax("a placeholder marker needs the block id".into()))?;
            let mut block = (*self.existing.get(&id).ok_or_else(|| RichDocError::NoBlock(id.clone()))?).clone();
            self.apply_pairs(&mut block, &m.pairs)?;
            return Ok(vec![block]);
        }
        let first = if blocks.is_empty() { None } else { Some(blocks.remove(0)) };
        let word = m.word.as_deref();
        let mut block = match (first, word) {
            (None, None | Some("paragraph")) => json!({"type": "paragraph"}),
            (None, Some(w)) if schema().nodes.get(w).is_some_and(|n| n.content.is_none()) => json!({"type": w}),
            (None, Some(w)) => return Err(RichDocError::Syntax(format!("the {w} marker is followed by no block"))),
            (Some(b), Some(_)) if is_embed_line(&b) => {
                let id =
                    m.id.clone()
                        .ok_or_else(|| RichDocError::Syntax("a placeholder marker needs the block id".into()))?;
                let found = self.existing.get(&id).ok_or_else(|| RichDocError::NoBlock(id.clone()))?;
                (*found).clone()
            }
            (Some(_), Some(w)) if PLACEHOLDER_TYPES.contains(&w) => {
                return Err(RichDocError::Placeholder(format!(
                    "a {w} block has no Markdown form: keep its placeholder line `[embed: …]` or delete the block"
                )));
            }
            (Some(b), Some(w)) if schema().nodes.contains_key(w) => match convert(b.clone(), w) {
                Some(c) => c,
                None if ty(&b) == w => b,
                None => b,
            },
            (Some(_), Some(w)) => return Err(RichDocError::Syntax(format!("unknown block type {w} in a marker"))),
            (Some(b), None) => b,
        };
        // nested blocks from the page's block of the same id
        if let Some(id) = &m.id {
            if let Some(old) = self.existing.get(id) {
                if ty(old) == ty(&block) && !is_placeholder(old) {
                    restore(&mut block, old, 0);
                }
            }
            set_block_id(&mut block, id);
        }
        self.apply_pairs(&mut block, &m.pairs)?;
        // a block the Markdown leaves as it was keeps the page's JSON exactly (white space at mark edges and other
        // details plain Markdown cannot show are not lost)
        if let Some(old) = m.id.as_ref().and_then(|id| self.existing.get(id)) {
            if unchanged(&block, old) {
                block = (*old).clone();
            }
        }
        let mut out = vec![block];
        out.extend(blocks);
        Ok(out)
    }

    /// The marker's attributes on a block.
    fn apply_pairs(&mut self, block: &mut Value, pairs: &[(String, String, bool)]) -> Result<(), RichDocError> {
        let t = ty(block).to_string();
        for (k, raw, quoted) in pairs {
            let name =
                schema_name(&t, k).ok_or_else(|| RichDocError::Syntax(format!("a {t} block has no attribute {k}")))?;
            let spec = &schema().nodes[&t].attrs[&name];
            let v = typed_value(raw, *quoted, spec)
                .filter(|v| check_typed(&t, &name, v))
                .ok_or_else(|| RichDocError::Syntax(format!("{k}={raw} is not a valid value for a {t} block")))?;
            if let Some(obj) = block.as_object_mut() {
                let attrs = obj.entry("attrs").or_insert_with(|| Value::Object(Map::new()));
                if let Some(a) = attrs.as_object_mut() {
                    a.insert(name, v);
                }
            }
        }
        Ok(())
    }
}

/// Whether a block read from Markdown is the page's block as it was: same type and attributes, and the same
/// annotated Markdown.
fn unchanged(block: &Value, old: &Value) -> bool {
    if ty(block) != ty(old) || is_placeholder(old) {
        return false;
    }
    let attrs = |n: &Value| canonical(&json!({"type": ty(n), "attrs": n.get("attrs").cloned().unwrap_or(Value::Null)}));
    if attrs(block) != attrs(old) {
        return false;
    }
    let old = canonical(old);
    let new = canonical(block);
    annotated_block(&new, false) == annotated_block(&old, false)
}

/// Removes leading and trailing blank lines (the last line keeps its own trailing spaces).
fn trim_blank_lines(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let blank = |l: &&str| l.chars().all(|c| c == ' ' || c == '\t' || c == '\r');
    let Some(first) = lines.iter().position(|l| !blank(l)) else { return String::new() };
    let last = lines.iter().rposition(|l| !blank(l)).unwrap_or(first);
    lines[first..=last].join("\n")
}

/// Whether a line scan is inside fenced code (how markers are told from code).
#[derive(Default)]
struct FenceState(Option<(char, usize)>);

impl FenceState {
    fn feed(&mut self, line: &str) {
        let t = line.trim_start_matches(' ');
        if line.len() - t.len() > 3 {
            return;
        }
        let ch = t.chars().next().unwrap_or(' ');
        if ch != '`' && ch != '~' {
            return;
        }
        let run = t.chars().take_while(|c| *c == ch).count();
        if run < 3 {
            return;
        }
        match self.0 {
            None => self.0 = Some((ch, run)),
            Some((fc, fr)) if fc == ch && run >= fr && trim(&t[run..]).is_empty() => self.0 = None,
            _ => {}
        }
    }

    fn open(&self) -> bool {
        self.0.is_some()
    }
}

/// Whether a chunk leaves the marker scan inside fenced code (its markers would hide the next block's).
fn leaves_fence_open(chunk: &str) -> bool {
    let mut f = FenceState::default();
    for line in chunk.split('\n') {
        f.feed(line);
    }
    f.open()
}

/// Splits annotated Markdown into marker lines and the text between them (markers inside fenced code do not
/// count).
fn segments(md: &str) -> Result<Vec<(Option<MarkerLine>, String)>, RichDocError> {
    let md = md.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<(Option<MarkerLine>, String)> = vec![(None, String::new())];
    let mut fence = FenceState::default();
    for line in md.split('\n') {
        fence.feed(line);
        let t = line.trim_start_matches(' ');
        if !fence.open() && t.starts_with("<!--") {
            if let Some(m) = parse_marker(line)? {
                out.push((Some(m), String::new()));
                continue;
            }
        }
        if let Some(last) = out.last_mut() {
            if !last.1.is_empty() || last.0.is_some() {
                last.1.push('\n');
            }
            last.1.push_str(line);
        }
    }
    Ok(out)
}

/// One open `columns` block while reading.
struct Frame {
    node: Value,
    columns: Vec<Value>,
}

/// Reads annotated Markdown into a page (ids not yet completed).
fn read(md: &str, existing: Option<&Value>) -> Result<Value, RichDocError> {
    read_indexed(md, index(existing))
}

fn read_indexed(md: &str, existing: HashMap<String, &Value>) -> Result<Value, RichDocError> {
    let mut reader = Reader::new(existing);
    let mut top: Vec<Value> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    fn emit(top: &mut Vec<Value>, stack: &mut [Frame], blocks: Vec<Value>) {
        if blocks.is_empty() {
            return;
        }
        match stack.last_mut() {
            None => top.extend(blocks),
            Some(f) => {
                if f.columns.is_empty() {
                    f.columns.push(json!({"type": "column", "content": []}));
                }
                if let Some(col) = f.columns.last_mut() {
                    if let Some(c) = col.get_mut("content").and_then(Value::as_array_mut) {
                        c.extend(blocks);
                    }
                }
            }
        }
    }
    fn close(top: &mut Vec<Value>, stack: &mut Vec<Frame>) {
        if let Some(mut f) = stack.pop() {
            f.node["content"] = Value::Array(f.columns);
            let node = f.node;
            emit(top, stack, vec![node]);
        }
    }
    for (marker, text) in segments(md)? {
        match marker {
            None => {
                let blocks = reader.chunk(None, &text)?;
                emit(&mut top, &mut stack, blocks);
            }
            Some(MarkerLine::Block(m)) if m.word.as_deref() == Some("columns") => {
                let mut node = json!({"type": "columns"});
                if let Some(id) = &m.id {
                    set_block_id(&mut node, id);
                }
                reader.apply_pairs(&mut node, &m.pairs)?;
                stack.push(Frame { node, columns: Vec::new() });
                let blocks = reader.chunk(None, &text)?;
                emit(&mut top, &mut stack, blocks);
            }
            Some(MarkerLine::Block(m)) => {
                let blocks = reader.chunk(Some(&m), &text)?;
                emit(&mut top, &mut stack, blocks);
            }
            Some(MarkerLine::Column(id)) => {
                let Some(f) = stack.last_mut() else {
                    return Err(RichDocError::Syntax("<!-- column --> outside a columns block".into()));
                };
                let mut col = json!({"type": "column", "content": []});
                if let Some(id) = id {
                    set_block_id(&mut col, &id);
                }
                f.columns.push(col);
                let blocks = reader.chunk(None, &text)?;
                emit(&mut top, &mut stack, blocks);
            }
            Some(MarkerLine::ColumnsEnd) => {
                if stack.is_empty() {
                    return Err(RichDocError::Syntax("<!-- /columns --> without a columns block".into()));
                }
                close(&mut top, &mut stack);
                let blocks = reader.chunk(None, &text)?;
                emit(&mut top, &mut stack, blocks);
            }
        }
    }
    while !stack.is_empty() {
        close(&mut top, &mut stack);
    }
    if let Some(e) = reader.errors.into_iter().next() {
        return Err(RichDocError::Syntax(e));
    }
    Ok(json!({"type": "doc", "content": top}))
}

/// Gives every empty column an empty paragraph (a column holds at least one block).
pub fn fill_empty_columns(n: &mut Value) {
    let is_column = ty(n) == "column";
    if let Some(c) = n.get_mut("content").and_then(Value::as_array_mut) {
        for ch in c.iter_mut() {
            fill_empty_columns(ch);
        }
        if is_column && c.is_empty() {
            c.push(json!({"type": "paragraph"}));
        }
    }
}

/// Reads annotated Markdown into its top-level blocks (canonical, ids not completed): the blocks of an edit.
///
/// # Errors
/// As [`annotated_to_doc`].
pub fn read_blocks(md: &str, existing: Option<&Value>) -> Result<Vec<Value>, RichDocError> {
    let doc = canonical(&read(md, existing)?);
    Ok(children(&doc).to_vec())
}

/// Reads annotated (or plain) Markdown into a canonical page with complete, unique ids.
pub fn annotated_to_doc(md: &str, existing: Option<&Value>, ids: &mut dyn IdSource) -> Result<Value, RichDocError> {
    let mut doc = read(md, existing)?;
    fill_empty_columns(&mut doc);
    if children(&doc).is_empty() {
        doc["content"] = json!([{"type": "paragraph"}]);
    }
    let mut doc = canonical(&doc);
    crate::ids::ensure(&mut doc, ids);
    Ok(doc)
}

// ---------------------------------------------------------------- writing

/// Whether every block-carrying node of `n` has a valid id.
fn all_ids_valid(n: &Value) -> bool {
    let t = ty(n);
    if crate::ids::carries_block_id(t) && !block_id(n).is_some_and(is_block_id) {
        return false;
    }
    children(n).iter().all(all_ids_valid)
}

fn strip_ids(n: &Value) -> Value {
    let mut v = n.clone();
    crate::ids::strip(&mut v);
    v
}

/// The marker attributes a block needs: those its Markdown does not give back.
fn marker_pairs(block: &Value, back: Option<&Value>) -> Vec<(String, String)> {
    let t = ty(block);
    let Some(spec) = schema().nodes.get(t) else { return Vec::new() };
    let mut out = Vec::new();
    for (k, a) in &spec.attrs {
        if k == "blockId" {
            continue;
        }
        let actual = attr(block, k);
        let given = back.map_or(&a.default, |b| attr(b, k));
        if !same(actual, given) {
            out.push((short_name(t, k), quote_value(actual)));
        }
    }
    out.sort();
    out
}

/// The annotated chunk of one block (marker and Markdown), verified to read back as the block.
fn write_block(block: &Value, page: &Value) -> String {
    let id = block_id(block).filter(|i| is_block_id(i));
    let t = ty(block);
    if is_placeholder(block) {
        return format!("{}\n{}", marker_text(id, Some(t), &[]), placeholder_line(block));
    }
    for escape_lines in [false, true] {
        let md = if t == "paragraph" && children(block).is_empty() {
            String::new()
        } else {
            annotated_block(block, escape_lines)
        };
        let (parsed, _) = if md.is_empty() { (Vec::new(), Vec::new()) } else { parse_blocks(&md, true) };
        let back = match parsed.first() {
            None if t == "paragraph" => Some(json!({"type": "paragraph"})),
            None => None,
            Some(b) => convert(b.clone(), t),
        };
        let word = match (&back, parsed.first()) {
            (Some(_), Some(b)) if ty(b) != t => Some(t),
            (None, None) => Some(t),
            _ => None,
        };
        let pairs = marker_pairs(block, back.as_ref());
        let marker = marker_text(id, word, &pairs);
        let chunk = match (marker.is_empty(), md.is_empty()) {
            (true, _) => md.clone(),
            (false, true) => marker,
            (false, false) => format!("{marker}\n{md}"),
        };
        if chunk.is_empty() {
            // a new, empty paragraph: an explicit empty marker keeps it
            return "<!-- paragraph -->".into();
        }
        if verify(&chunk, block, page) && !leaves_fence_open(&chunk) {
            return chunk;
        }
    }
    format!("{}\n{}", marker_text(id, Some(t), &[]), placeholder_line(block))
}

/// Whether a chunk reads back as exactly `block`.
fn verify(chunk: &str, block: &Value, page: &Value) -> bool {
    // the chunk can only refer to its own block: index that one rather than the whole page
    let _ = page;
    let mut own = HashMap::new();
    if let Some(id) = block_id(block) {
        own.insert(id.to_string(), block);
    }
    let Ok(doc) = read_indexed(chunk, own) else { return false };
    let mut doc = canonical(&doc);
    crate::ids::ensure(&mut doc, &mut SeqIds(0xf0_0000));
    let got = children(&doc);
    if got.len() != 1 {
        return false;
    }
    let want = canonical(block);
    if all_ids_valid(&want) { got[0] == want } else { strip_ids(&got[0]) == strip_ids(&want) }
}

fn write_blocks(blocks: &[Value], page: &Value, out: &mut Vec<String>, depth: usize) {
    for b in blocks {
        if ty(b) == "columns" && depth < crate::schema::MAX_DOC_DEPTH {
            let id = block_id(b).filter(|i| is_block_id(i));
            let pairs = marker_pairs(b, None);
            out.push(marker_text(id, Some("columns"), &pairs));
            for col in children(b) {
                let cid = block_id(col).filter(|i| is_block_id(i));
                out.push(marker_text(cid, Some("column"), &[]));
                write_blocks(children(col), page, out, depth + 1);
            }
            out.push("<!-- /columns -->".into());
        } else {
            out.push(write_block(b, page));
        }
    }
}

/// Writes a page as annotated Markdown.
pub fn doc_to_annotated(doc: &Value) -> String {
    let page = canonical(doc);
    let mut out = Vec::new();
    write_blocks(children(&page), &page, &mut out, 0);
    out.join("\n\n")
}
