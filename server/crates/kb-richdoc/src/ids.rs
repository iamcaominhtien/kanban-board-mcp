//! Block ids (README "Block ids"): which nodes carry one, how they are made and kept unique.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::schema::INLINE_NODES;
use crate::{IdSource, RandomIds, SeqIds};

/// Returns whether `id` is a valid block id (`b-` and 6 lower-case hex digits).
pub fn is_block_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 8 && b.starts_with(b"b-") && b[2..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

/// Returns whether a node of this type carries a block id (every node that is not `doc` and not inline).
pub fn carries_block_id(ty: &str) -> bool {
    !ty.is_empty() && ty != "doc" && !INLINE_NODES.contains(&ty)
}

impl IdSource for RandomIds {
    fn next_id(&mut self) -> String {
        let b = uuid::Uuid::new_v4().into_bytes();
        format!("b-{:02x}{:02x}{:02x}", b[0], b[1], b[2])
    }
}

impl IdSource for SeqIds {
    fn next_id(&mut self) -> String {
        let id = format!("b-{:06x}", self.0);
        self.0 = self.0.wrapping_add(1);
        id
    }
}

/// The block id a node holds, if it is a string.
pub fn block_id(node: &Value) -> Option<&str> {
    node.get("attrs")?.get("blockId")?.as_str()
}

/// Sets `blockId` on a node, keeping its attribute keys sorted.
pub fn set_block_id(node: &mut Value, id: &str) {
    let Some(obj) = node.as_object_mut() else { return };
    let mut attrs: Map<String, Value> = obj.get("attrs").and_then(Value::as_object).cloned().unwrap_or_default();
    attrs.insert("blockId".into(), Value::String(id.to_string()));
    let mut keys: Vec<String> = attrs.keys().cloned().collect();
    keys.sort();
    let sorted: Map<String, Value> = keys.into_iter().filter_map(|k| attrs.remove(&k).map(|v| (k, v))).collect();
    // keep `type` first, then attrs
    let mut out = Map::new();
    if let Some(t) = obj.remove("type") {
        out.insert("type".into(), t);
    }
    out.insert("attrs".into(), Value::Object(sorted));
    obj.remove("attrs");
    for (k, v) in std::mem::take(obj) {
        out.insert(k, v);
    }
    *obj = out;
}

/// Hands out ids that are valid and not yet taken.
pub struct Fresh<'a> {
    ids: &'a mut dyn IdSource,
    taken: HashSet<String>,
    scan: u32,
}

impl<'a> Fresh<'a> {
    /// A generator avoiding `taken`.
    pub fn new(ids: &'a mut dyn IdSource, taken: HashSet<String>) -> Self {
        Fresh { ids, taken, scan: 0 }
    }

    /// A new id.
    pub fn next(&mut self) -> String {
        for _ in 0..256 {
            let id = self.ids.next_id();
            if is_block_id(&id) && !self.taken.contains(&id) {
                self.taken.insert(id.clone());
                return id;
            }
        }
        // the source keeps failing: take the first free id in order
        while self.scan < 0x0100_0000 {
            let id = format!("b-{:06x}", self.scan);
            self.scan += 1;
            if !self.taken.contains(&id) {
                self.taken.insert(id.clone());
                return id;
            }
        }
        // every id of the format is taken: reuse one (a page never holds 16M blocks)
        "b-ffffff".to_string()
    }
}

/// The valid ids of a page, first holder only, in document order (the nodes keeping theirs are marked by path).
fn collect(node: &Value, taken: &mut HashSet<String>, keep: &mut HashSet<*const Value>, depth: usize) {
    if depth > crate::schema::MAX_DOC_DEPTH * 2 {
        return;
    }
    let ty = node.get("type").and_then(Value::as_str).unwrap_or("");
    if carries_block_id(ty) {
        if let Some(id) = block_id(node) {
            if is_block_id(id) && taken.insert(id.to_string()) {
                keep.insert(node as *const Value);
            }
        }
    }
    if let Some(Value::Array(c)) = node.get("content") {
        for ch in c {
            collect(ch, taken, keep, depth + 1);
        }
    }
}

fn assign(node: &mut Value, keep: &HashSet<*const Value>, fresh: &mut Fresh, depth: usize) -> bool {
    if depth > crate::schema::MAX_DOC_DEPTH * 2 {
        return false;
    }
    let mut changed = false;
    let ty = node.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    if carries_block_id(&ty) && !keep.contains(&(node as *const Value)) {
        let id = fresh.next();
        set_block_id(node, &id);
        changed = true;
    }
    if let Some(Value::Array(c)) = node.get_mut("content") {
        for ch in c.iter_mut() {
            changed |= assign(ch, keep, fresh, depth + 1);
        }
    }
    changed
}

/// Gives every block a valid, unique id; the first holder of a duplicated id keeps it. Returns whether anything
/// changed.
pub fn ensure(doc: &mut Value, ids: &mut dyn IdSource) -> bool {
    let mut taken = HashSet::new();
    let mut keep = HashSet::new();
    collect(doc, &mut taken, &mut keep, 0);
    let mut fresh = Fresh::new(ids, taken);
    assign(doc, &keep, &mut fresh, 0)
}

/// Removes every `blockId` (an `attrs` left empty is dropped).
pub fn strip(node: &mut Value) {
    if let Some(obj) = node.as_object_mut() {
        if let Some(Value::Object(a)) = obj.get_mut("attrs") {
            a.remove("blockId");
            if a.is_empty() {
                obj.remove("attrs");
            }
        }
        if let Some(Value::Array(c)) = obj.get_mut("content") {
            for ch in c.iter_mut() {
                strip(ch);
            }
        }
    }
}

/// The top-level blocks: the doc's children, a `columns` block followed by its columns' blocks.
pub fn top_level(doc: &Value) -> Vec<&Value> {
    let mut out = Vec::new();
    fn visit<'v>(parent: &'v Value, out: &mut Vec<&'v Value>) {
        if let Some(Value::Array(c)) = parent.get("content") {
            for ch in c {
                out.push(ch);
                if ch.get("type").and_then(Value::as_str) == Some("columns") {
                    if let Some(Value::Array(cols)) = ch.get("content") {
                        for col in cols {
                            visit(col, out);
                        }
                    }
                }
            }
        }
    }
    visit(doc, &mut out);
    out
}
