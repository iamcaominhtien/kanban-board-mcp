//! The page schema (`contract/richdoc/schema.json`, embedded): node and mark attributes with their defaults, the
//! canonical JSON form and document validation.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::RichDocError;

/// The schema file, as the UI reads it.
pub const SCHEMA_JSON: &str = include_str!("../../../contract/richdoc/schema.json");

/// Marks in canonical order (`schema.json` `marks`).
pub const MARK_ORDER: &[&str] =
    &["bold", "italic", "strike", "code", "underline", "superscript", "subscript", "link", "highlight", "textStyle"];

/// Node types that are inline (they carry no block id).
pub const INLINE_NODES: &[&str] = &["text", "hardBreak", "docRef", "ticketRef", "mathInline"];

/// How deep a page may nest (deeper documents are refused by [`validate`]).
pub const MAX_DOC_DEPTH: usize = 128;

/// The type of an attribute value.
#[derive(Debug, Clone, PartialEq)]
pub enum AttrType {
    /// One of the listed values.
    Enum(Vec<Value>),
    /// A number, optionally bounded.
    Number { min: Option<f64>, max: Option<f64> },
    /// A number or null.
    NumberOrNull,
    /// A string.
    String,
    /// A string or null.
    StringOrNull,
    /// `true` or `false`.
    Boolean,
    /// An array or null.
    ArrayOrNull,
    /// An object or null.
    ObjectOrNull,
}

/// One attribute of a node or mark.
#[derive(Debug, Clone)]
pub struct AttrSpec {
    /// The value it has when left out.
    pub default: Value,
    /// What values it takes.
    pub ty: AttrType,
}

/// One node type.
#[derive(Debug, Clone)]
pub struct NodeSpec {
    /// The content expression (`None` for a leaf).
    pub content: Option<String>,
    /// The groups it belongs to (`block`, `inline`, `list`).
    pub groups: Vec<String>,
    /// Its attributes by name.
    pub attrs: BTreeMap<String, AttrSpec>,
}

/// The parsed schema.
#[derive(Debug)]
pub struct Schema {
    /// Node types by name.
    pub nodes: BTreeMap<String, NodeSpec>,
    /// Mark types by name: their attributes.
    pub marks: BTreeMap<String, BTreeMap<String, AttrSpec>>,
    /// `formatVersion`.
    pub format_version: u64,
}

fn parse_attrs(v: &Value) -> BTreeMap<String, AttrSpec> {
    let mut out = BTreeMap::new();
    let Some(obj) = v.as_object() else { return out };
    for (name, spec) in obj {
        let default = spec.get("default").cloned().unwrap_or(Value::Null);
        let ty = match spec.get("type").and_then(Value::as_str).unwrap_or("string|null") {
            "enum" => AttrType::Enum(spec.get("values").and_then(Value::as_array).cloned().unwrap_or_default()),
            "number" => AttrType::Number {
                min: spec.get("min").and_then(Value::as_f64),
                max: spec.get("max").and_then(Value::as_f64),
            },
            "number|null" => AttrType::NumberOrNull,
            "string" => AttrType::String,
            "boolean" => AttrType::Boolean,
            "array|null" => AttrType::ArrayOrNull,
            "object|null" => AttrType::ObjectOrNull,
            _ => AttrType::StringOrNull,
        };
        out.insert(name.clone(), AttrSpec { default, ty });
    }
    out
}

/// Parses a `schema.json` document.
///
/// # Errors
/// A text naming what is missing when the file is not a schema.
pub fn parse_schema(text: &str) -> Result<Schema, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let nodes_v = v.get("nodes").and_then(Value::as_object).ok_or("no nodes")?;
    let mut nodes = BTreeMap::new();
    for (name, spec) in nodes_v {
        let groups = spec
            .get("group")
            .and_then(Value::as_str)
            .map(|g| g.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default();
        let content = spec.get("content").and_then(Value::as_str).map(str::to_string);
        let attrs = match spec.get("attrs") {
            Some(Value::String(s)) => {
                // "same as tableCell"
                let other = s.trim_start_matches("same as ").trim();
                nodes_v.get(other).and_then(|o| o.get("attrs")).map(parse_attrs).unwrap_or_default()
            }
            Some(a) => parse_attrs(a),
            None => BTreeMap::new(),
        };
        nodes.insert(name.clone(), NodeSpec { content, groups, attrs });
    }
    let mut marks = BTreeMap::new();
    for (name, spec) in v.get("marks").and_then(Value::as_object).ok_or("no marks")? {
        marks.insert(name.clone(), spec.get("attrs").map(parse_attrs).unwrap_or_default());
    }
    let format_version = v.get("formatVersion").and_then(Value::as_u64).ok_or("no formatVersion")?;
    Ok(Schema { nodes, marks, format_version })
}

/// How deep a node tree goes (counted without recursion, so any input is safe).
fn depth_of(node: &Value) -> usize {
    let mut max = 0;
    let mut stack: Vec<(&Value, usize)> = vec![(node, 1)];
    while let Some((n, d)) = stack.pop() {
        max = max.max(d);
        if let Some(Value::Array(c)) = n.get("content") {
            for ch in c {
                stack.push((ch, d + 1));
            }
        }
    }
    max
}

fn truncate(node: &Value, left: usize) -> Value {
    let Some(obj) = node.as_object() else { return node.clone() };
    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        if k == "content" {
            if left > 1 {
                if let Value::Array(c) = v {
                    out.insert(k.clone(), Value::Array(c.iter().map(|ch| truncate(ch, left - 1)).collect()));
                    continue;
                }
            }
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    Value::Object(out)
}

/// The page cut below [`MAX_DOC_DEPTH`] plus a margin (a valid page is never cut), so the writers' recursion is
/// bounded whatever JSON they are given.
pub fn clamp(doc: &Value) -> Cow<'_, Value> {
    const LIMIT: usize = MAX_DOC_DEPTH + 16;
    if depth_of(doc) <= LIMIT { Cow::Borrowed(doc) } else { Cow::Owned(truncate(doc, LIMIT)) }
}

/// The embedded schema.
pub fn schema() -> &'static Schema {
    static S: OnceLock<Schema> = OnceLock::new();
    S.get_or_init(|| parse_schema(SCHEMA_JSON).expect("the embedded schema.json is valid (checked by a test)"))
}

/// JSON equality where numbers compare by value (`0` equals `0.0`), as `JSON.stringify` compares them.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// The attributes of a node or mark in canonical form: defaults and `null`s left out where they are the default,
/// keys sorted. `None` when nothing is left.
fn canonical_attrs(attrs: Option<&Value>, spec: Option<&BTreeMap<String, AttrSpec>>) -> Option<Value> {
    let obj = attrs?.as_object()?;
    let mut keys: Vec<&String> = obj
        .keys()
        .filter(|k| {
            let v = &obj[*k];
            match spec.and_then(|s| s.get(*k)) {
                Some(a) => !same(v, &a.default),
                None => true,
            }
        })
        .collect();
    keys.sort();
    if keys.is_empty() {
        return None;
    }
    let mut out = Map::new();
    for k in keys {
        out.insert(k.clone(), obj[k].clone());
    }
    Some(Value::Object(out))
}

fn mark_rank(t: &str) -> usize {
    MARK_ORDER.iter().position(|m| *m == t).unwrap_or(MARK_ORDER.len())
}

/// The canonical form of a page (README "Canonical JSON").
pub fn canonical(node: &Value) -> Value {
    canonical_at(node, 0)
}

fn canonical_at(node: &Value, depth: usize) -> Value {
    let s = schema();
    let mut out = Map::new();
    let ty = node.get("type").cloned().unwrap_or(Value::Null);
    out.insert("type".into(), ty.clone());
    let spec = ty.as_str().and_then(|t| s.nodes.get(t)).map(|n| &n.attrs);
    if let Some(a) = canonical_attrs(node.get("attrs"), spec) {
        out.insert("attrs".into(), a);
    }
    if let Some(Value::Array(c)) = node.get("content") {
        if !c.is_empty() && depth < MAX_DOC_DEPTH * 2 {
            out.insert("content".into(), Value::Array(c.iter().map(|n| canonical_at(n, depth + 1)).collect()));
        }
    }
    if let Some(Value::Array(marks)) = node.get("marks") {
        if !marks.is_empty() {
            let mut ms = marks.clone();
            ms.sort_by_key(|m| mark_rank(m.get("type").and_then(Value::as_str).unwrap_or("")));
            let ms = ms
                .into_iter()
                .map(|m| {
                    let t = m.get("type").cloned().unwrap_or(Value::Null);
                    let spec = t.as_str().and_then(|t| s.marks.get(t));
                    let mut mo = Map::new();
                    mo.insert("type".into(), t);
                    if let Some(a) = canonical_attrs(m.get("attrs"), spec) {
                        mo.insert("attrs".into(), a);
                    }
                    Value::Object(mo)
                })
                .collect();
            out.insert("marks".into(), Value::Array(ms));
        }
    }
    if let Some(t) = node.get("text") {
        out.insert("text".into(), t.clone());
    }
    Value::Object(out)
}

/// An attribute value of a node, its default when absent.
pub fn attr<'v>(node: &'v Value, name: &str) -> &'v Value {
    static NULL: Value = Value::Null;
    if let Some(v) = node.get("attrs").and_then(|a| a.get(name)) {
        return v;
    }
    let s = schema();
    node.get("type")
        .and_then(Value::as_str)
        .and_then(|t| s.nodes.get(t))
        .and_then(|n| n.attrs.get(name))
        .map_or(&NULL, |a| &a.default)
}

/// A mark's attributes with every default filled in (as the editor's `getJSON` gives them).
pub fn full_mark_attrs(mark: &Value) -> Option<Map<String, Value>> {
    let t = mark.get("type")?.as_str()?;
    let spec = schema().marks.get(t)?;
    if spec.is_empty() {
        return None;
    }
    let given = mark.get("attrs").and_then(Value::as_object);
    let mut out = Map::new();
    for (k, a) in spec {
        out.insert(k.clone(), given.and_then(|g| g.get(k)).cloned().unwrap_or_else(|| a.default.clone()));
    }
    Some(out)
}

// ---------------------------------------------------------------- validation

fn invalid(msg: String) -> RichDocError {
    RichDocError::Invalid(msg)
}

fn check_value(where_: &str, name: &str, v: &Value, a: &AttrSpec) -> Result<(), RichDocError> {
    let ok = match &a.ty {
        AttrType::Enum(values) => values.iter().any(|x| same(x, v)),
        AttrType::Number { min, max } => {
            v.as_f64().is_some_and(|n| min.is_none_or(|m| n >= m) && max.is_none_or(|m| n <= m))
        }
        AttrType::NumberOrNull => v.is_null() || v.is_number(),
        AttrType::String => v.is_string(),
        AttrType::StringOrNull => v.is_null() || v.is_string(),
        AttrType::Boolean => v.is_boolean(),
        AttrType::ArrayOrNull => v.is_null() || v.is_array(),
        AttrType::ObjectOrNull => v.is_null() || v.is_object(),
    };
    if ok { Ok(()) } else { Err(invalid(format!("{where_}: attribute {name} has a value of the wrong type ({v})"))) }
}

fn check_attrs(where_: &str, attrs: Option<&Value>, spec: &BTreeMap<String, AttrSpec>) -> Result<(), RichDocError> {
    let Some(attrs) = attrs else { return Ok(()) };
    let obj = attrs.as_object().ok_or_else(|| invalid(format!("{where_}: attrs is not an object")))?;
    for (k, v) in obj {
        let a = spec.get(k).ok_or_else(|| invalid(format!("{where_}: unknown attribute {k}")))?;
        check_value(where_, k, v, a)?;
    }
    Ok(())
}

/// Checks one attribute value of a node type.
///
/// # Errors
/// [`RichDocError::Invalid`] when the node type has no such attribute or the value has the wrong type.
pub fn check_attr(node_type: &str, key: &str, v: &Value) -> Result<(), RichDocError> {
    let spec = schema().nodes.get(node_type).ok_or_else(|| invalid(format!("unknown node {node_type}")))?;
    let a = spec.attrs.get(key).ok_or_else(|| invalid(format!("a {node_type} block has no attribute {key}")))?;
    check_value(node_type, key, v, a)
}

/// A term of a content expression: the names it accepts and how many.
#[derive(Debug)]
struct Term {
    names: Vec<String>,
    min: usize,
    max: usize,
}

fn parse_content(expr: &str) -> Vec<Term> {
    let mut terms = Vec::new();
    let mut rest = expr.trim();
    while !rest.is_empty() {
        let (names, after) = if let Some(r) = rest.strip_prefix('(') {
            let end = r.find(')').unwrap_or(r.len());
            let names = r[..end].split('|').map(|s| s.trim().to_string()).collect();
            (names, r.get(end + 1..).unwrap_or(""))
        } else {
            let end = rest.find(|c: char| !(c.is_ascii_alphanumeric())).unwrap_or(rest.len());
            (vec![rest[..end].to_string()], &rest[end..])
        };
        let (min, max, after) = if let Some(a) = after.strip_prefix('+') {
            (1, usize::MAX, a)
        } else if let Some(a) = after.strip_prefix('*') {
            (0, usize::MAX, a)
        } else if let Some(a) = after.strip_prefix('?') {
            (0, 1, a)
        } else if let Some(a) = after.strip_prefix('{') {
            let end = a.find('}').unwrap_or(a.len());
            let (lo, hi) = a[..end].split_once(',').unwrap_or((&a[..end], &a[..end]));
            (lo.trim().parse().unwrap_or(0), hi.trim().parse().unwrap_or(usize::MAX), a.get(end + 1..).unwrap_or(""))
        } else {
            (1, 1, after)
        };
        terms.push(Term { names, min, max });
        rest = after.trim_start();
    }
    terms
}

fn accepts(s: &Schema, name_or_group: &str, ty: &str, parent: &str) -> bool {
    if name_or_group == ty {
        return true;
    }
    if s.nodes.get(ty).is_some_and(|n| n.groups.iter().any(|g| g == name_or_group)) {
        return true;
    }
    // the editor keeps an inline `![x](…)` as an image inside the paragraph (fixtures/README.md)
    name_or_group == "inline" && ty == "image" && parent != "codeBlock"
}

fn check_content(s: &Schema, parent: &str, expr: &str, children: &[Value]) -> Result<(), RichDocError> {
    let terms = parse_content(expr);
    let mut i = 0;
    for t in &terms {
        let mut n = 0;
        while n < t.max && i < children.len() {
            let ty = children[i].get("type").and_then(Value::as_str).unwrap_or("");
            if !t.names.iter().any(|name| accepts(s, name, ty, parent)) {
                break;
            }
            n += 1;
            i += 1;
        }
        if n < t.min {
            return Err(invalid(match children.get(i).and_then(|c| c.get("type")).and_then(Value::as_str) {
                Some(ty) => format!("{parent}: {ty} is not allowed here (content \"{expr}\")"),
                None => format!("{parent}: content does not match \"{expr}\""),
            }));
        }
    }
    if i < children.len() {
        let ty = children[i].get("type").and_then(Value::as_str).unwrap_or("?");
        return Err(invalid(format!("{parent}: {ty} is not allowed here (content \"{expr}\")")));
    }
    Ok(())
}

fn check_marks(where_: &str, node: &Value) -> Result<(), RichDocError> {
    let Some(marks) = node.get("marks") else { return Ok(()) };
    let marks = marks.as_array().ok_or_else(|| invalid(format!("{where_}: marks is not an array")))?;
    let s = schema();
    let mut seen: Vec<&str> = Vec::new();
    for m in marks {
        let t =
            m.get("type").and_then(Value::as_str).ok_or_else(|| invalid(format!("{where_}: a mark has no type")))?;
        let spec = s.marks.get(t).ok_or_else(|| invalid(format!("{where_}: unknown mark {t}")))?;
        if seen.contains(&t) {
            return Err(invalid(format!("{where_}: mark {t} twice")));
        }
        seen.push(t);
        check_attrs(&format!("{where_} mark {t}"), m.get("attrs"), spec)?;
    }
    Ok(())
}

fn validate_node(node: &Value, depth: usize, parent: &str) -> Result<(), RichDocError> {
    if depth > MAX_DOC_DEPTH {
        return Err(invalid(format!("the page nests deeper than {MAX_DOC_DEPTH} levels")));
    }
    let s = schema();
    let ty =
        node.get("type").and_then(Value::as_str).ok_or_else(|| invalid(format!("{parent}: a node has no type")))?;
    if ty == "text" {
        let text = node
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(format!("{parent}: text node without text")))?;
        if text.is_empty() {
            return Err(invalid(format!("{parent}: empty text node")));
        }
        if node.get("content").is_some() || node.get("attrs").is_some() {
            return Err(invalid(format!("{parent}: a text node has content or attributes")));
        }
        return check_marks(&format!("{parent} text"), node);
    }
    let spec = s.nodes.get(ty).ok_or_else(|| invalid(format!("{parent}: unknown node {ty}")))?;
    check_attrs(ty, node.get("attrs"), &spec.attrs)?;
    if node.get("text").is_some() {
        return Err(invalid(format!("{ty}: only text nodes have text")));
    }
    if spec.groups.iter().any(|g| g == "inline") {
        check_marks(ty, node)?;
    } else if node.get("marks").is_some() {
        return Err(invalid(format!("{ty}: a block has marks")));
    }
    let children: &[Value] = match node.get("content") {
        None => &[],
        Some(Value::Array(c)) => c,
        Some(_) => return Err(invalid(format!("{ty}: content is not an array"))),
    };
    match &spec.content {
        Some(expr) => check_content(s, ty, expr, children)?,
        None if !children.is_empty() => return Err(invalid(format!("{ty}: a leaf node has content"))),
        None => {}
    }
    for c in children {
        validate_node(c, depth + 1, ty)?;
    }
    Ok(())
}

/// Checks a page against the schema.
///
/// # Errors
/// [`RichDocError::Invalid`] naming the first problem.
pub fn validate(doc: &Value) -> Result<(), RichDocError> {
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        return Err(invalid("the page is not a doc node".into()));
    }
    validate_node(doc, 0, "doc")
}
