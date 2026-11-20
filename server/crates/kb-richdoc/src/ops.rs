//! Block-level edits of a document: what `docs_write(action='edit')` applies for an AI team.
//!
//! Edits address top-level blocks (README "Block ids") by id. Ids of blocks already on the page never change;
//! blocks an edit brings in get fresh ids (the first block of a `Replace` takes the replaced block's id).

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::annotated::{is_placeholder, read_blocks, schema_name};
use crate::ids::{Fresh, block_id, carries_block_id, is_block_id, set_block_id};
use crate::schema::{MAX_DOC_DEPTH, canonical, check_attr};
use crate::{IdSource, RichDocError};

/// One edit of one top-level block.
#[derive(Debug, Clone, PartialEq)]
pub enum BlockOp {
    /// Replace the block with the blocks of an annotated Markdown fragment (the first new block keeps the id).
    Replace { block_id: String, markdown: String },
    /// Insert the blocks of an annotated Markdown fragment after the block (`None`: at the start of the page).
    InsertAfter { block_id: Option<String>, markdown: String },
    /// Remove the block (the only way to remove a placeholder block).
    Delete { block_id: String },
    /// Set or clear attributes of the block (`null` clears one); unknown attributes are refused. `type` changes the
    /// block's kind: `htmlEmbed` turns a code block into an HTML embed whose page is the code (the other attributes
    /// are then the embed's).
    SetAttrs { block_id: String, attrs: Map<String, Value> },
    /// Set or clear attributes of some cells of a table block: `cells` is a cell (`B2`) or a range (`A1:C3`), a
    /// column letter and a 1-based row as a spreadsheet names them (row 1 is the first row, the header row when
    /// there is one; a merged cell counts once, where it starts).
    SetCellAttrs { block_id: String, cells: String, attrs: Map<String, Value> },
}

/// The spreadsheet letter of a 0-based column (`0` is `A`, `26` is `AA`).
pub fn column_letter(col: usize) -> String {
    let mut n = col + 1;
    let mut out = Vec::new();
    while n > 0 {
        let r = (n - 1) % 26;
        out.push(char::from(b'A' + u8::try_from(r).unwrap_or(0)));
        n = (n - 1) / 26;
    }
    out.iter().rev().collect()
}

/// The cells a range names: `(first row, first column, last row, last column)`, 0-based and inclusive.
///
/// # Errors
/// [`RichDocError::Invalid`] for a range that is not `B2` or `A1:C3`.
pub fn cell_range(cells: &str) -> Result<(usize, usize, usize, usize), RichDocError> {
    fn one(c: &str) -> Option<(usize, usize)> {
        let c = c.trim();
        let letters: String = c.chars().take_while(char::is_ascii_alphabetic).collect();
        let digits = &c[letters.len()..];
        if letters.is_empty() || letters.len() > 2 || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let col = letters.to_ascii_uppercase().bytes().fold(0usize, |n, b| n * 26 + usize::from(b - b'A' + 1)) - 1;
        let row = digits.parse::<usize>().ok()?.checked_sub(1)?;
        Some((row, col))
    }
    let bad = || RichDocError::Invalid(format!("cells: '{cells}' is not a cell (B2) or a range (A1:C3)"));
    let (a, b) = cells.split_once(':').unwrap_or((cells, cells));
    let ((r1, c1), (r2, c2)) = (one(a).ok_or_else(bad)?, one(b).ok_or_else(bad)?);
    Ok((r1.min(r2), c1.min(c2), r1.max(r2), c1.max(c2)))
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

/// Where a top-level block sits: the path of the container (indices from the doc: `columns`, then `column`…) and
/// its index in that container.
type Place = (Vec<usize>, usize);

/// Finds a top-level block by id.
fn find(doc: &Value, id: &str) -> Option<Place> {
    fn walk(container: &Value, path: &mut Vec<usize>, id: &str, depth: usize) -> Option<Place> {
        for (i, b) in children(container).iter().enumerate() {
            if block_id(b) == Some(id) {
                return Some((path.clone(), i));
            }
            if ty(b) == "columns" && depth < MAX_DOC_DEPTH {
                for (c, col) in children(b).iter().enumerate() {
                    path.push(i);
                    path.push(c);
                    if let Some(p) = walk(col, path, id, depth + 1) {
                        return Some(p);
                    }
                    path.pop();
                    path.pop();
                }
            }
        }
        None
    }
    walk(doc, &mut Vec::new(), id, 0)
}

/// The content array of the container at `path`.
fn container_mut<'a>(doc: &'a mut Value, path: &[usize]) -> Option<&'a mut Vec<Value>> {
    let mut node = doc;
    for i in path {
        node = node.get_mut("content")?.as_array_mut()?.get_mut(*i)?;
    }
    // a container left empty has no `content` key in canonical form
    node.as_object_mut()?.entry("content").or_insert_with(|| Value::Array(Vec::new())).as_array_mut()
}

fn get<'a>(doc: &'a Value, place: &Place) -> Option<&'a Value> {
    let mut node = doc;
    for i in &place.0 {
        node = children(node).get(*i)?;
    }
    children(node).get(place.1)
}

/// Every block id in a node.
fn ids_in(n: &Value, out: &mut HashSet<String>) {
    if let Some(id) = block_id(n) {
        out.insert(id.to_string());
    }
    for c in children(n) {
        ids_in(c, out);
    }
}

/// Removes ids that are taken elsewhere on the page (an edit never takes an id another block holds).
fn drop_taken_ids(n: &mut Value, taken: &HashSet<String>) {
    if let Some(id) = block_id(n) {
        if taken.contains(id) {
            if let Some(a) = n.get_mut("attrs").and_then(Value::as_object_mut) {
                a.remove("blockId");
            }
        }
    }
    if let Some(Value::Array(c)) = n.get_mut("content") {
        for ch in c {
            drop_taken_ids(ch, taken);
        }
    }
}

fn remove_top_id(n: &mut Value) {
    if let Some(a) = n.get_mut("attrs").and_then(Value::as_object_mut) {
        a.remove("blockId");
    }
}

/// The blocks of an edit's fragment.
fn fragment(markdown: &str, doc: &Value) -> Result<Vec<Value>, RichDocError> {
    if crate::chars::trim(markdown).is_empty() {
        return Err(RichDocError::Syntax("the Markdown of the edit holds no block".into()));
    }
    let mut blocks = read_blocks(markdown, Some(doc))?;
    for b in &mut blocks {
        crate::annotated::fill_empty_columns(b);
    }
    if blocks.is_empty() {
        return Err(RichDocError::Syntax("the Markdown of the edit holds no block".into()));
    }
    Ok(blocks)
}

/// Gives every node without a valid id a fresh one, avoiding the ids already used.
fn complete_ids(doc: &mut Value, ids: &mut dyn IdSource) {
    let mut taken = HashSet::new();
    ids_in(doc, &mut taken);
    let mut fresh = Fresh::new(ids, taken);
    fn fill(n: &mut Value, fresh: &mut Fresh, seen: &mut HashSet<String>) {
        if carries_block_id(ty(n)) {
            let ok = block_id(n).is_some_and(|id| is_block_id(id) && !seen.contains(id));
            if ok {
                if let Some(id) = block_id(n) {
                    seen.insert(id.to_string());
                }
            } else {
                let id = fresh.next();
                seen.insert(id.clone());
                set_block_id(n, &id);
            }
        }
        if let Some(Value::Array(c)) = n.get_mut("content") {
            for ch in c {
                fill(ch, fresh, seen);
            }
        }
    }
    let mut seen = HashSet::new();
    fill(doc, &mut fresh, &mut seen);
}

/// Keeps containers valid after a removal: an empty column or page gets an empty paragraph.
fn fill_empty(doc: &mut Value, path: &[usize]) {
    if let Some(c) = container_mut(doc, path) {
        if c.is_empty() {
            c.push(json!({"type": "paragraph"}));
        }
    }
}

fn no_block(id: &str) -> RichDocError {
    RichDocError::NoBlock(id.to_string())
}

/// Applies edits in order to a copy of `doc` and returns it.
///
/// # Errors
/// [`RichDocError::NoBlock`] for an unknown id, [`RichDocError::Syntax`] for a broken fragment,
/// [`RichDocError::Invalid`] for an attribute the block does not have.
pub fn apply(doc: &Value, edits: &[BlockOp], ids: &mut dyn IdSource) -> Result<Value, RichDocError> {
    let mut doc = canonical(&crate::schema::clamp(doc));
    for edit in edits {
        match edit {
            BlockOp::Replace { block_id: id, markdown } => {
                let place = find(&doc, id).ok_or_else(|| no_block(id))?;
                let target = get(&doc, &place).cloned().unwrap_or(Value::Null);
                let mut blocks = fragment(markdown, &doc)?;
                // a placeholder is replaced only by a block of the kind it is (a new HTML embed or video written
                // under its marker); a Markdown block or an `[embed: …]` line would lose or fake it
                if is_placeholder(&target) && !(is_placeholder(&blocks[0]) && ty(&blocks[0]) == ty(&target)) {
                    return Err(RichDocError::Placeholder(format!(
                        "block {id} is a {} that Markdown cannot hold: it can only be deleted, or replaced by a new \
                         one of the same kind written under its marker (`<!-- htmlEmbed title=… height=… -->` then \
                         an ```html code block)",
                        ty(&target)
                    )));
                }
                // ids held elsewhere on the page stay there
                let mut own = HashSet::new();
                ids_in(&target, &mut own);
                let mut taken = HashSet::new();
                ids_in(&doc, &mut taken);
                let taken: HashSet<String> = taken.difference(&own).cloned().collect();
                for (k, b) in blocks.iter_mut().enumerate() {
                    if k > 0 {
                        remove_top_id(b);
                    }
                    drop_taken_ids(b, &taken);
                }
                set_block_id(&mut blocks[0], id);
                let c = container_mut(&mut doc, &place.0).ok_or_else(|| no_block(id))?;
                c.splice(place.1..=place.1, blocks);
            }
            BlockOp::InsertAfter { block_id: after, markdown } => {
                let place = match after {
                    Some(id) => {
                        let (path, i) = find(&doc, id).ok_or_else(|| no_block(id))?;
                        (path, i + 1)
                    }
                    None => (Vec::new(), 0),
                };
                let mut blocks = fragment(markdown, &doc)?;
                let mut taken = HashSet::new();
                ids_in(&doc, &mut taken);
                for b in &mut blocks {
                    remove_top_id(b);
                    drop_taken_ids(b, &taken);
                }
                let c = container_mut(&mut doc, &place.0)
                    .ok_or_else(|| RichDocError::Invalid("the page has no content".into()))?;
                let at = place.1.min(c.len());
                c.splice(at..at, blocks);
            }
            BlockOp::Delete { block_id: id } => {
                let (path, i) = find(&doc, id).ok_or_else(|| no_block(id))?;
                let c = container_mut(&mut doc, &path).ok_or_else(|| no_block(id))?;
                c.remove(i);
                fill_empty(&mut doc, &path);
            }
            BlockOp::SetAttrs { block_id: id, attrs } => {
                let place = find(&doc, id).ok_or_else(|| no_block(id))?;
                let target = get(&doc, &place).ok_or_else(|| no_block(id))?;
                let from = ty(target).to_string();
                // `type` turns the block into another kind (only a code block into an HTML embed of its code)
                let turned = match attrs.get("type") {
                    None => None,
                    Some(Value::String(to)) if *to == from => None,
                    Some(Value::String(to)) if from == "codeBlock" && to == "htmlEmbed" => {
                        let code: String = children(target).iter().filter_map(|n| n["text"].as_str()).collect();
                        Some(json!({"type": "htmlEmbed", "attrs": {"blockId": id, "html": code}}))
                    }
                    Some(other) => {
                        return Err(RichDocError::Invalid(format!(
                            "type: a {from} block cannot become {other}; only a codeBlock can be turned into an \
                             htmlEmbed (its code becomes the embed's page)"
                        )));
                    }
                };
                let t = turned.as_ref().map_or(from.clone(), |n| ty(n).to_string());
                let mut updates: Vec<(String, Value)> = Vec::new();
                for (k, v) in attrs.iter().filter(|(k, _)| k.as_str() != "type") {
                    let name = schema_name(&t, k)
                        .ok_or_else(|| RichDocError::Invalid(format!("a {t} block has no attribute {k}")))?;
                    if !v.is_null() {
                        check_attr(&t, &name, v)?;
                    }
                    updates.push((name, v.clone()));
                }
                let c = container_mut(&mut doc, &place.0).ok_or_else(|| no_block(id))?;
                let node = c.get_mut(place.1).ok_or_else(|| no_block(id))?;
                if let Some(n) = turned {
                    *node = n;
                }
                if let Some(obj) = node.as_object_mut() {
                    let a = obj.entry("attrs").or_insert_with(|| Value::Object(Map::new()));
                    if let Some(a) = a.as_object_mut() {
                        for (k, v) in updates {
                            if v.is_null() {
                                a.remove(&k);
                            } else {
                                a.insert(k, v);
                            }
                        }
                    }
                }
            }
            BlockOp::SetCellAttrs { block_id: id, cells, attrs } => {
                let (r1, c1, r2, c2) = cell_range(cells)?;
                let place = find(&doc, id).ok_or_else(|| no_block(id))?;
                let target = get(&doc, &place).ok_or_else(|| no_block(id))?;
                if ty(target) != "table" {
                    return Err(RichDocError::Invalid(format!(
                        "cells works on a table; block {id} is a {}",
                        ty(target)
                    )));
                }
                let mut updates: Vec<(String, Value)> = Vec::new();
                for (k, v) in attrs {
                    let name = schema_name("tableCell", k)
                        .ok_or_else(|| RichDocError::Invalid(format!("a table cell has no attribute {k}")))?;
                    if matches!(name.as_str(), "colspan" | "rowspan" | "colwidth") {
                        return Err(RichDocError::Invalid(format!(
                            "{k} is the table's shape, not a cell's format: merging cells is done in the editor"
                        )));
                    }
                    if !v.is_null() {
                        check_attr("tableCell", &name, v)?;
                    }
                    updates.push((name, v.clone()));
                }
                let c = container_mut(&mut doc, &place.0).ok_or_else(|| no_block(id))?;
                let table = c.get_mut(place.1).ok_or_else(|| no_block(id))?;
                let rows = table.get_mut("content").and_then(Value::as_array_mut);
                let rows = rows.ok_or_else(|| RichDocError::Invalid(format!("table {id} has no rows")))?;
                let (n_rows, n_cols) = (rows.len(), rows.iter().map(|r| children(r).len()).max().unwrap_or(0));
                if r2 >= n_rows || c2 >= n_cols {
                    return Err(RichDocError::Invalid(format!(
                        "cells: '{cells}' is outside the table ({n_rows} rows, {n_cols} columns: A1:{}{n_rows})",
                        column_letter(n_cols.saturating_sub(1))
                    )));
                }
                for row in &mut rows[r1..=r2] {
                    let Some(cells) = row.get_mut("content").and_then(Value::as_array_mut) else { continue };
                    for cell in cells.iter_mut().skip(c1).take(c2 + 1 - c1) {
                        let Some(obj) = cell.as_object_mut() else { continue };
                        let a = obj.entry("attrs").or_insert_with(|| Value::Object(Map::new()));
                        if let Some(a) = a.as_object_mut() {
                            for (k, v) in &updates {
                                if v.is_null() {
                                    a.remove(k);
                                } else {
                                    a.insert(k.clone(), v.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
        doc = canonical(&doc);
    }
    fill_empty(&mut doc, &[]);
    complete_ids(&mut doc, ids);
    Ok(canonical(&doc))
}

/// Replaces the whole page with annotated Markdown (`docs_write(action='update')`): blocks with a known id keep
/// it, and placeholder blocks of `doc` that the Markdown leaves out are kept where they were.
///
/// A marker naming an id the page does not have gives a fresh id; a placeholder left out goes back after the
/// nearest block before it (in reading order) that the new page still has, or first in its column or page.
///
/// # Errors
/// As [`crate::annotated_to_doc`].
pub fn replace_page(doc: &Value, markdown: &str, ids: &mut dyn IdSource) -> Result<Value, RichDocError> {
    let old = canonical(&crate::schema::clamp(doc));
    let blocks = read_blocks(markdown, Some(&old))?;
    let mut new = json!({"type": "doc", "content": blocks});
    // ids the page does not know are not taken over
    let mut known = HashSet::new();
    ids_in(&old, &mut known);
    fn drop_unknown(n: &mut Value, known: &HashSet<String>) {
        if let Some(id) = block_id(n) {
            if !known.contains(id) {
                if let Some(a) = n.get_mut("attrs").and_then(Value::as_object_mut) {
                    a.remove("blockId");
                }
            }
        }
        if let Some(Value::Array(c)) = n.get_mut("content") {
            for ch in c {
                drop_unknown(ch, known);
            }
        }
    }
    drop_unknown(&mut new, &known);
    // placeholders left out stay where they were
    let present = |d: &Value, id: &str| find(d, id).is_some();
    let old_top: Vec<&Value> = crate::ids::top_level(&old);
    for p in &old_top {
        if !is_placeholder(p) {
            continue;
        }
        let Some(pid) = block_id(p) else { continue };
        if present(&new, pid) {
            continue;
        }
        let Some((old_path, old_i)) = find(&old, pid) else { continue };
        // the nearest earlier sibling the new page still has
        let siblings: Vec<&Value> = {
            let mut node = &old;
            for i in &old_path {
                node = &children(node)[*i];
            }
            children(node).iter().collect()
        };
        let anchor = siblings[..old_i].iter().rev().filter_map(|b| block_id(b)).find(|id| present(&new, id));
        match anchor.and_then(|a| find(&new, a)) {
            Some((path, i)) => {
                if let Some(c) = container_mut(&mut new, &path) {
                    c.insert(i + 1, (*p).clone());
                }
            }
            None => {
                // first in its column (when that column is still there) or first on the page
                let column_id = if old_path.len() >= 2 {
                    let mut node = &old;
                    for i in &old_path {
                        node = &children(node)[*i];
                    }
                    block_id(node).map(str::to_string)
                } else {
                    None
                };
                let column_place = column_id.and_then(|cid| find_column(&new, &cid));
                match column_place.and_then(|path| container_mut(&mut new, &path)) {
                    Some(c) => c.insert(0, (*p).clone()),
                    None => {
                        if let Some(c) = container_mut(&mut new, &[]) {
                            c.insert(0, (*p).clone());
                        }
                    }
                }
            }
        }
    }
    crate::annotated::fill_empty_columns(&mut new);
    fill_empty(&mut new, &[]);
    let mut new = canonical(&new);
    complete_ids(&mut new, ids);
    Ok(canonical(&new))
}

/// The path of a column (by id) among the page's `columns` blocks.
fn find_column(doc: &Value, column_id: &str) -> Option<Vec<usize>> {
    fn walk(container: &Value, path: &mut Vec<usize>, id: &str, depth: usize) -> Option<Vec<usize>> {
        for (i, b) in children(container).iter().enumerate() {
            if ty(b) == "columns" && depth < MAX_DOC_DEPTH {
                for (c, col) in children(b).iter().enumerate() {
                    path.push(i);
                    path.push(c);
                    if block_id(col) == Some(id) {
                        return Some(path.clone());
                    }
                    if let Some(p) = walk(col, path, id, depth + 1) {
                        return Some(p);
                    }
                    path.pop();
                    path.pop();
                }
            }
        }
        None
    }
    walk(doc, &mut Vec::new(), column_id, 0)
}
