//! Page JSON to plain Markdown, as the editor stores it: the `renderMarkdown` handlers of its extensions and
//! `@tiptap/markdown`'s serializer (mark boundaries, escaping), then `cleanEditorMarkdown` and `compactMarkdown`.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::build::PM_MARK_RANK;
use crate::chars::{is_space, js_len, trim};
use crate::schema::{MAX_DOC_DEPTH, full_mark_attrs};

/// Writes a page as plain Markdown (without a final newline).
pub fn doc_to_markdown(doc: &Value) -> String {
    let doc = prepare(doc);
    let raw = Writer::default().render(&doc, None, 0, 0);
    let raw = if is_empty_output(&raw) { String::new() } else { raw };
    compact_markdown(&clean_editor_markdown(&raw))
}

/// Writes one top-level block in the annotated flavour (without its marker): inline spans for marks plain Markdown
/// cannot hold, escapes so the text reads back as written, and, with `escape_lines`, block syntax at the start of a
/// paragraph line escaped too.
pub fn annotated_block(block: &Value, escape_lines: bool) -> String {
    let block = annotate_marks(&prepare_node(block, 0), 0);
    let doc = serde_json::json!({"type": "doc", "content": [block]});
    let w = Writer { annotated: true, escape_lines };
    let raw = w.render(&doc["content"][0], Some(&doc), 0, 0);
    compact_markdown(&raw).trim_matches('\n').to_string()
}

/// Replaces the marks plain Markdown cannot hold (underline, sup/sub, text style, coloured highlight) by one `span`
/// mark carrying the annotated attribute list (`.underline color=teal`).
fn annotate_marks(n: &Value, depth: usize) -> Value {
    let Some(obj) = n.as_object() else { return n.clone() };
    let mut out = obj.clone();
    if let Some(Value::Array(c)) = obj.get("content") {
        if depth <= MAX_DOC_DEPTH * 2 {
            let mut kids: Vec<Value> = c.iter().map(|x| annotate_marks(x, depth + 1)).collect();
            join_text(&mut kids);
            out.insert("content".into(), Value::Array(kids));
        }
    }
    if let Some(Value::Array(marks)) = obj.get("marks") {
        let mut keep = Vec::new();
        let mut classes = Vec::new();
        let mut pairs: Vec<(usize, String)> = Vec::new();
        for m in marks {
            let a = m.get("attrs");
            let get = |k: &str| a.and_then(|x| x.get(k)).filter(|v| !v.is_null());
            match m["type"].as_str().unwrap_or("") {
                "underline" => classes.push((0, ".underline".to_string())),
                "superscript" => classes.push((1, ".sup".to_string())),
                "subscript" => classes.push((2, ".sub".to_string())),
                "textStyle" => {
                    if let Some(v) = get("color") {
                        pairs.push((0, format!("color={}", crate::annotated::quote_value(v))));
                    }
                    if let Some(v) = get("fontFamily") {
                        pairs.push((2, format!("font={}", crate::annotated::quote_value(v))));
                    }
                    if let Some(v) = get("fontSize") {
                        pairs.push((3, format!("size={}", crate::annotated::quote_value(v))));
                    }
                }
                "highlight" if get("color").is_some() => {
                    if let Some(v) = get("color") {
                        pairs.push((1, format!("highlight={}", crate::annotated::quote_value(v))));
                    }
                }
                _ => keep.push(m.clone()),
            }
        }
        classes.sort();
        pairs.sort();
        let spec: Vec<String> = classes.into_iter().map(|c| c.1).chain(pairs.into_iter().map(|p| p.1)).collect();
        if !spec.is_empty() {
            keep.push(serde_json::json!({"type": "span", "attrs": {"spec": spec.join(" ")}}));
        }
        keep.sort_by_key(|m| rank(m["type"].as_str().unwrap_or("")));
        if keep.is_empty() {
            out.remove("marks");
        } else {
            out.insert("marks".into(), Value::Array(keep));
        }
    }
    Value::Object(out)
}

/// Escapes text so the annotated reader reads it back as text: `$` that would start math, `==` that would start a
/// highlight, ticket-key hyphens, bare URLs and e-mails, tag-like `<` and entity-like `&` (on Markdown-escaped text).
fn annotated_escape(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 8);
    let escaped_at = |i: usize| {
        let mut k = i;
        let mut n = 0;
        while k > 0 && c[k - 1] == '\\' {
            n += 1;
            k -= 1;
        }
        n % 2 == 1
    };
    let mut i = 0;
    while i < c.len() {
        let x = c[i];
        if escaped_at(i) {
            out.push(x);
            i += 1;
            continue;
        }
        let rest = &c[i..];
        let next = rest.get(1).copied();
        let need = match x {
            '&' => {
                let r: String = rest[1..].iter().take(34).collect();
                let body = r.strip_prefix('#').unwrap_or(&r);
                let n = body.chars().take_while(char::is_ascii_alphanumeric).count();
                n > 0 && body[n..].starts_with(';')
            }
            '<' => next.is_some_and(|y| y.is_ascii_alphabetic() || matches!(y, '/' | '!' | '?')),
            '$' => next == Some('$') || (i > 0 && c[i - 1] == '$') || super::inline::math_at(&c, i),
            '=' => next == Some('=') || (i > 0 && c[i - 1] == '='),
            ':' => {
                let before: String = c[..i]
                    .iter()
                    .rev()
                    .take(5)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
                    .to_ascii_lowercase();
                rest.get(1) == Some(&'/')
                    && rest.get(2) == Some(&'/')
                    && (before.ends_with("http") || before.ends_with("https") || before.ends_with("ftp"))
            }
            '.' => i >= 3 && c[i - 3..i] == ['w', 'w', 'w'] && (i == 3 || !c[i - 4].is_ascii_alphanumeric()),
            '@' => {
                i > 0
                    && (c[i - 1].is_ascii_alphanumeric() || matches!(c[i - 1], '.' | '_' | '+' | '-'))
                    && next.is_some_and(|y| y.is_ascii_alphanumeric() || y == '-' || y == '_')
            }
            '-' => {
                // the hyphen of something read as a ticket key: [A-Z][A-Z0-9]{1,5}-\d+\b
                let mut k = i;
                while k > 0 && (c[k - 1].is_ascii_uppercase() || c[k - 1].is_ascii_digit()) && i - k < 7 {
                    k -= 1;
                }
                let start_ok = k < i
                    && c[k].is_ascii_uppercase()
                    && (1..=5).contains(&(i - k - 1))
                    && (k == 0 || !(crate::chars::is_word(c[k - 1]) || c[k - 1] == '-' || c[k - 1] == '/'));
                let mut d = i + 1;
                while d < c.len() && c[d].is_ascii_digit() {
                    d += 1;
                }
                start_ok && d > i + 1 && !c.get(d).is_some_and(|y| crate::chars::is_word(*y) || *y == '-')
            }
            _ => false,
        };
        if x == ' ' {
            // two spaces or more before a line break would be read as a hard break
            let run = c[i..].iter().take_while(|y| **y == ' ').count();
            if run >= 2 && c.get(i + run) == Some(&'\n') {
                out.push_str(&"&#32;".repeat(run));
                i += run;
                continue;
            }
        }
        if need {
            out.push('\\');
        }
        out.push(x);
        i += 1;
    }
    out
}

/// The backtick fence a code block needs: longer than any run of backticks starting one of its lines.
fn fence_len(body: &str) -> usize {
    let mut n = 3;
    for line in body.split('\n') {
        let t = line.trim_start_matches(' ');
        if line.len() - t.len() <= 3 {
            let run = t.bytes().take_while(|b| *b == b'`').count();
            if run >= n {
                n = run + 1;
            }
        }
    }
    n
}

/// Escapes block syntax at the start of each line of a paragraph (`# `, `> `, `- `, `1. `, `a) `, `|`, `---`…).
fn escape_line_starts(md: &str) -> String {
    md.split('\n')
        .map(|line| {
            let lead = line.len() - line.trim_start_matches([' ', '\t']).len();
            let (pre, l) = line.split_at(lead);
            let b = l.as_bytes();
            let Some(&first) = b.first() else { return line.to_string() };
            let ws_after = |k: usize| b.get(k).is_none_or(|x| *x == b' ' || *x == b'\t');
            let escape_at = |k: usize| format!("{pre}{}\\{}", &l[..k], &l[k..]);
            if matches!(first, b'#' | b'>' | b'|' | b'+' | b'=') {
                return escape_at(0);
            }
            if first == b'-' && (ws_after(1) || l.bytes().all(|x| x == b'-' || x == b' ')) {
                return escape_at(0);
            }
            let alnum = b.iter().take_while(|x| x.is_ascii_alphanumeric()).count();
            if alnum > 0 && matches!(b.get(alnum), Some(b'.') | Some(b')')) && ws_after(alnum + 1) {
                return escape_at(alnum);
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the editor holds after `setContent(json)`: marks with full attributes in rank order, adjacent text with the
/// same marks joined, and the trailing paragraph.
fn prepare(doc: &Value) -> Value {
    let mut d = prepare_node(doc, 0);
    if let Some(obj) = d.as_object_mut() {
        let content = obj.entry("content").or_insert_with(|| Value::Array(Vec::new()));
        if let Some(c) = content.as_array_mut() {
            if c.last().is_none_or(|n| n.get("type").and_then(Value::as_str) != Some("paragraph")) {
                c.push(serde_json::json!({"type": "paragraph"}));
            }
        }
    }
    d
}

fn prepare_node(n: &Value, depth: usize) -> Value {
    let Some(obj) = n.as_object() else { return n.clone() };
    let mut out = Map::new();
    for (k, v) in obj {
        match k.as_str() {
            "marks" => {
                let mut marks: Vec<Value> = v
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|m| {
                                let mut mo = Map::new();
                                mo.insert("type".into(), m.get("type").cloned().unwrap_or(Value::Null));
                                if let Some(attrs) = full_mark_attrs(m) {
                                    mo.insert("attrs".into(), Value::Object(attrs));
                                }
                                Value::Object(mo)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                marks.sort_by_key(|m| rank(m["type"].as_str().unwrap_or("")));
                if !marks.is_empty() {
                    out.insert(k.clone(), Value::Array(marks));
                }
            }
            "content" => {
                if depth > MAX_DOC_DEPTH * 2 {
                    continue;
                }
                let mut c: Vec<Value> =
                    v.as_array().map(|a| a.iter().map(|x| prepare_node(x, depth + 1)).collect()).unwrap_or_default();
                join_text(&mut c);
                if !c.is_empty() {
                    out.insert(k.clone(), Value::Array(c));
                }
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

fn join_text(c: &mut Vec<Value>) {
    let mut out: Vec<Value> = Vec::with_capacity(c.len());
    for n in c.drain(..) {
        if n["type"] == "text" {
            if let Some(last) = out.last_mut() {
                if last["type"] == "text" && last.get("marks") == n.get("marks") {
                    let t = format!("{}{}", last["text"].as_str().unwrap_or(""), n["text"].as_str().unwrap_or(""));
                    last["text"] = Value::String(t);
                    continue;
                }
            }
        }
        out.push(n);
    }
    *c = out;
}

fn is_empty_output(md: &str) -> bool {
    if trim(md).is_empty() {
        return true;
    }
    trim(&md.replace("&nbsp;", "").replace('\u{a0}', "")).is_empty()
}

fn ty(n: &Value) -> &str {
    n.get("type").and_then(Value::as_str).unwrap_or("")
}

fn content(n: &Value) -> &[Value] {
    match n.get("content") {
        Some(Value::Array(c)) => c,
        _ => &[],
    }
}

fn has_content(n: &Value) -> bool {
    !content(n).is_empty()
}

fn attr<'v>(n: &'v Value, k: &str) -> &'v Value {
    crate::schema::attr(n, k)
}

fn str_attr<'v>(n: &'v Value, k: &str) -> &'v str {
    attr(n, k).as_str().unwrap_or("")
}

/// A JavaScript number written as `String(n)`.
fn js_num(v: &Value) -> String {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && f.abs() < 1e21 { format!("{}", f as i64) } else { format!("{f}") }
            } else {
                n.to_string()
            }
        }
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

/// Whether a JSON value is truthy in JavaScript.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `escapeMarkdownText`: backslash before `\ ` * _ [ ] ~`.
pub fn escape_markdown_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 4);
    for c in text.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '~') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `plainLine`: `[`, `]` and line breaks become spaces, runs of white space one space, trimmed.
pub fn plain_line(v: &str) -> String {
    let replaced: String = v.chars().map(|c| if matches!(c, '[' | ']' | '\r' | '\n') { ' ' } else { c }).collect();
    trim(&crate::chars::collapse_spaces(&replaced)).to_string()
}

/// `embedLine`: `[embed: kind · title]` or `[embed: kind]`.
pub fn embed_line(kind: &str, title: &str) -> String {
    let t = plain_line(title);
    if t.is_empty() { format!("[embed: {kind}]") } else { format!("[embed: {kind} · {t}]") }
}

/// The callout marker of a kind (`custom` is written as info).
pub fn callout_marker(kind: &str) -> &'static str {
    match kind {
        "warning" => "WARNING",
        "success" => "SUCCESS",
        "danger" => "DANGER",
        "note" => "NOTE",
        _ => "INFO",
    }
}

fn has_merged_cells(table: &Value) -> bool {
    content(table).iter().any(|row| {
        content(row).iter().any(|c| {
            let span = |k: &str| attr(c, k).as_f64().unwrap_or(1.0);
            span("colspan") > 1.0 || span("rowspan") > 1.0
        })
    })
}

fn merged_cells_title(table: &Value) -> String {
    content(table)
        .first()
        .map(|row| content(row).iter().map(|c| crate::text::cell_text(c, 0)).collect::<Vec<_>>().join(" | "))
        .unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Markdown,
    Html,
}

/// An insertion-ordered map of active marks (JavaScript `Map` semantics).
#[derive(Default, Clone)]
struct OMap(Vec<(String, Value)>);

impl OMap {
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.iter().find(|(x, _)| x == k).map(|(_, v)| v)
    }
    fn has(&self, k: &str) -> bool {
        self.get(k).is_some()
    }
    fn set(&mut self, k: &str, v: Value) {
        match self.0.iter_mut().find(|(x, _)| x == k) {
            Some(e) => e.1 = v,
            None => self.0.push((k.to_string(), v)),
        }
    }
    fn delete(&mut self, k: &str) {
        self.0.retain(|(x, _)| x != k);
    }
    fn keys(&self) -> Vec<String> {
        self.0.iter().map(|(k, _)| k.clone()).collect()
    }
}

fn mark_attrs(m: &Value) -> Option<&Value> {
    m.get("attrs")
}

fn attrs_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn node_marks(n: &Value) -> OMap {
    let mut m = OMap::default();
    if let Some(Value::Array(a)) = n.get("marks") {
        for mark in a {
            m.set(mark["type"].as_str().unwrap_or(""), mark.clone());
        }
    }
    m
}

fn next_has(next: Option<&Value>, ty_: &str, attrs: Option<&Value>) -> bool {
    next.and_then(|n| n.get("marks"))
        .and_then(Value::as_array)
        .is_some_and(|ms| ms.iter().any(|m| m["type"] == ty_ && attrs_equal(mark_attrs(m), attrs)))
}

/// The nesting rank of a mark (lower is outer); the annotated span sits right inside a link.
fn rank(t: &str) -> usize {
    match t {
        "link" => 0,
        "span" => 1,
        _ => PM_MARK_RANK.iter().position(|r| *r == t).map_or(usize::MAX, |i| i + 2),
    }
}

fn html_reopen(t: &str) -> Option<(&'static str, &'static str)> {
    match t {
        "bold" => Some(("<strong>", "</strong>")),
        "italic" => Some(("<em>", "</em>")),
        _ => None,
    }
}

/// The run of backticks a code span needs (`shortestUnusedBacktickRun`).
fn code_fence(text: &str) -> usize {
    let mut runs = HashSet::new();
    let mut n = 0;
    for c in text.chars() {
        if c == '`' {
            n += 1;
        } else if n > 0 {
            runs.insert(n);
            n = 0;
        }
    }
    if n > 0 {
        runs.insert(n);
    }
    let mut len = 1;
    while runs.contains(&len) {
        len += 1;
    }
    len
}

/// The Markdown before and after the text of a mark.
fn mark_delims(t: &str, mark: &Value, mode: Mode, mark_text: &str) -> (String, String) {
    if mode == Mode::Html {
        return html_reopen(t).map(|(o, c)| (o.to_string(), c.to_string())).unwrap_or_default();
    }
    match t {
        "bold" => ("**".into(), "**".into()),
        "italic" => ("*".into(), "*".into()),
        "strike" => ("~~".into(), "~~".into()),
        "highlight" => ("==".into(), "==".into()),
        "span" => {
            let spec = mark.get("attrs").and_then(|a| a.get("spec")).and_then(Value::as_str).unwrap_or("");
            ("[".into(), format!("]{{{spec}}}"))
        }
        "code" => {
            let fence = "`".repeat(code_fence(mark_text));
            let pad = if mark_text.starts_with('`') || mark_text.ends_with('`') { " " } else { "" };
            (format!("{fence}{pad}"), format!("{pad}{fence}"))
        }
        "link" => {
            let a = mark.get("attrs");
            let href = a.and_then(|x| x.get("href")).map(js_num).unwrap_or_default();
            let title = a.and_then(|x| x.get("title")).filter(|v| truthy(v)).map(js_num);
            match title {
                Some(t) => ("[".into(), format!("]({href} \"{t}\")")),
                None => ("[".into(), format!("]({href})")),
            }
        }
        _ => (String::new(), String::new()),
    }
}

/// For each node, the full text of each mark's run (`collectMarkSpanTexts`).
fn mark_span_texts(nodes: &[Value]) -> Vec<HashMap<String, String>> {
    let mut spans: Vec<HashMap<String, String>> = vec![HashMap::new(); nodes.len()];
    let mut open: Vec<(String, Vec<usize>, String)> = Vec::new();
    let flush = |spans: &mut Vec<HashMap<String, String>>, run: (String, Vec<usize>, String)| {
        for i in run.1 {
            spans[i].insert(run.0.clone(), run.2.clone());
        }
    };
    for (i, n) in nodes.iter().enumerate() {
        if ty(n) != "text" {
            for run in open.drain(..) {
                flush(&mut spans, run);
            }
            continue;
        }
        let types: Vec<String> = n
            .get("marks")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| m["type"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let mut keep = Vec::new();
        for run in open.drain(..) {
            if types.contains(&run.0) {
                keep.push(run);
            } else {
                flush(&mut spans, run);
            }
        }
        open = keep;
        let text = n["text"].as_str().unwrap_or("");
        for t in types {
            match open.iter_mut().find(|r| r.0 == t) {
                Some(r) => {
                    r.1.push(i);
                    r.2.push_str(text);
                }
                None => open.push((t, vec![i], text.to_string())),
            }
        }
    }
    for run in open.drain(..) {
        flush(&mut spans, run);
    }
    spans
}

/// Trailing JavaScript white space of `s`, split off.
fn split_trailing_ws(s: &mut String) -> String {
    let t = s.trim_end_matches(is_space).len();
    let ws = s[t..].to_string();
    s.truncate(t);
    ws
}

fn split_leading_ws(s: &mut String) -> String {
    let t = s.len() - s.trim_start_matches(is_space).len();
    let ws = s[..t].to_string();
    *s = s[t..].to_string();
    ws
}

/// Writer options: the annotated flavour (spans, extra escapes) and escaping of block syntax at line starts.
#[derive(Clone, Copy, Default)]
struct Writer {
    annotated: bool,
    escape_lines: bool,
}

impl Writer {
    /// `encodeTextForMarkdown`.
    fn encode_text(&self, text: &str, node: &Value, parent: Option<&Value>) -> String {
        let in_code = parent.is_some_and(|p| ty(p) == "codeBlock")
            || node.get("marks").and_then(Value::as_array).is_some_and(|ms| ms.iter().any(|m| m["type"] == "code"));
        if in_code {
            return text.to_string();
        }
        if self.annotated {
            return annotated_escape(&escape_markdown_text(text));
        }
        let enc = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        escape_markdown_text(&enc)
    }

    /// `renderNodes` on an array: mark boundaries tracked across the nodes.
    fn render_nodes(&self, nodes: &[Value], parent: Option<&Value>, sep: &str, level: usize) -> String {
        let mut result: Vec<String> = Vec::with_capacity(nodes.len());
        let mut active = OMap::default();
        let mut reopen_html: HashSet<String> = HashSet::new();
        let mut modes: HashMap<String, Mode> = HashMap::new();
        let spans = mark_span_texts(nodes);
        let span = |i: Option<usize>, t: &str| -> String {
            i.and_then(|i| spans.get(i)).and_then(|m| m.get(t)).cloned().unwrap_or_default()
        };
        for (i, node) in nodes.iter().enumerate() {
            let next = nodes.get(i + 1);
            if ty(node).is_empty() {
                continue;
            }
            if ty(node) != "text" {
                let node_types: HashSet<String> = node
                    .get("marks")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|m| m["type"].as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let mut to_reopen = OMap::default();
                let mut reopen_modes: HashMap<String, Mode> = HashMap::new();
                for (t, m) in &active.0 {
                    if node_types.contains(t) {
                        to_reopen.set(t, m.clone());
                        reopen_modes.insert(t.clone(), *modes.get(t).unwrap_or(&Mode::Markdown));
                    }
                }
                // closeMarksBeforeNode: keys reversed, each closing prepended
                let mut before = String::new();
                for t in active.keys().iter().rev() {
                    let m = active.get(t).cloned().unwrap_or(Value::Null);
                    let mode = *modes.get(t).unwrap_or(&Mode::Markdown);
                    let (_, close) = mark_delims(t, &m, mode, &span(i.checked_sub(1), t));
                    before = format!("{close}{before}");
                }
                active = OMap::default();
                modes.clear();
                let body = self.render(node, parent, i, level);
                let mut after = String::new();
                if ty(node) != "hardBreak" {
                    for (t, m) in &to_reopen.0 {
                        let mode = *reopen_modes.get(t).unwrap_or(&Mode::Markdown);
                        modes.insert(t.clone(), mode);
                        let (open, _) = mark_delims(t, m, mode, &span(Some(i + 1), t));
                        after.push_str(&open);
                        active.set(t, m.clone());
                    }
                }
                result.push(format!("{before}{body}{after}"));
                continue;
            }
            let mut text = self.encode_text(node["text"].as_str().unwrap_or(""), node, parent);
            let mut current = node_marks(node);
            let mut to_open = self.marks_to_open(&active, &current, next);
            let mut to_close = marks_to_close(&current, next);
            let ws_only = !text.is_empty() && trim(&text).is_empty();
            if ws_only && !current.0.is_empty() {
                let transient: Vec<String> = to_close.iter().filter(|t| !active.has(t)).cloned().collect();
                if !transient.is_empty() {
                    current.0.retain(|(t, _)| !transient.contains(t));
                    to_open = self.marks_to_open(&active, &current, next);
                    to_close = marks_to_close(&current, next);
                }
            }
            let closing_here: Vec<String> = to_close.iter().filter(|t| active.has(t)).cloned().collect();
            let crossed = !closing_here.is_empty() && !to_open.is_empty();
            let mut middle_ws = String::new();
            if !to_close.is_empty() && !crossed {
                middle_ws = split_trailing_ws(&mut text);
            }
            if !crossed {
                for t in to_close.iter().rev() {
                    if !active.has(t) {
                        continue;
                    }
                    let m = current.get(t).cloned().unwrap_or(Value::Null);
                    let mode = *modes.get(t).unwrap_or(&Mode::Markdown);
                    let (_, close) = mark_delims(t, &m, mode, &span(Some(i), t));
                    text.push_str(&close);
                    active.delete(t);
                    modes.remove(t);
                }
            }
            let mut leading = String::new();
            if !to_open.is_empty() {
                leading = split_leading_ws(&mut text);
            }
            for (t, m) in &to_open {
                let mode = if reopen_html.contains(t) { Mode::Html } else { Mode::Markdown };
                let (open, _) = mark_delims(t, m, mode, &span(Some(i), t));
                text = format!("{open}{text}");
                modes.insert(t.clone(), mode);
                reopen_html.remove(t);
            }
            if !crossed {
                for (t, m) in to_open.iter().rev() {
                    active.set(t, m.clone());
                }
            }
            text = format!("{leading}{text}");
            let close_at_end: Vec<String> = if crossed {
                let next_types: HashSet<String> = next
                    .and_then(|n| n.get("marks"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|m| m["type"].as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                for (t, _) in &to_open {
                    if next_types.contains(t) && html_reopen(t).is_some() {
                        reopen_html.insert(t.clone());
                    }
                }
                let keys = active.keys();
                let mut lifo = closing_here.clone();
                lifo.sort_by_key(|t| std::cmp::Reverse(keys.iter().position(|k| k == t).unwrap_or(0)));
                to_open.iter().map(|(t, _)| t.clone()).chain(lifo).collect()
            } else {
                marks_to_close_at_end(&active, &current, next)
            };
            let mut trailing = String::new();
            if !close_at_end.is_empty() {
                trailing = split_trailing_ws(&mut text);
            }
            for t in &close_at_end {
                let m = active.get(t).or_else(|| current.get(t)).cloned().unwrap_or(Value::Null);
                let mode = *modes.get(t).unwrap_or(&Mode::Markdown);
                let (_, close) = mark_delims(t, &m, mode, &span(Some(i), t));
                text.push_str(&close);
                active.delete(t);
                modes.remove(t);
            }
            text.push_str(&trailing);
            text.push_str(&middle_ws);
            if self.annotated && parent.is_some_and(|p| ty(p) != "codeBlock") {
                // spaces starting or ending a text block are dropped by the reader: write them as references
                if i == 0 {
                    let t = text.trim_start_matches(' ');
                    let n = text.len() - t.len();
                    if n > 0 {
                        text = format!("{}{t}", "&#32;".repeat(n));
                    }
                }
                if next.is_none() {
                    let t = text.trim_end_matches(' ').len();
                    let n = text.len() - t;
                    text.truncate(t);
                    text.push_str(&"&#32;".repeat(n));
                }
            }
            result.push(text);
        }
        result.join(sep)
    }

    /// `getMarksToOpenForSerialization`.
    fn marks_to_open(&self, active: &OMap, current: &OMap, next: Option<&Value>) -> Vec<(String, Value)> {
        let mut to_open: Vec<(String, Value)> = current
            .0
            .iter()
            .filter(|(t, m)| match active.get(t) {
                None => true,
                Some(a) => !attrs_equal(mark_attrs(a), mark_attrs(m)),
            })
            .cloned()
            .collect();
        if to_open.len() <= 1 {
            return to_open;
        }
        let inner_first =
            |a: &(String, Value), b: &(String, Value)| rank(&b.0).cmp(&rank(&a.0)).then_with(|| a.0.cmp(&b.0));
        let (mut cont, mut ending): (Vec<_>, Vec<_>) =
            to_open.drain(..).partition(|(t, m)| next_has(next, t, mark_attrs(m)));
        ending.sort_by(inner_first);
        cont.sort_by(inner_first);
        ending.extend(cont);
        ending
    }

    /// Renders one node (`renderNodeToMarkdown`).
    fn render(&self, node: &Value, parent: Option<&Value>, index: usize, level: usize) -> String {
        if level > MAX_DOC_DEPTH * 2 {
            return String::new();
        }
        let t = ty(node);
        if t == "text" {
            return self.encode_text(node["text"].as_str().unwrap_or(""), node, parent);
        }
        let prev = parent.and_then(|p| if index > 0 { content(p).get(index - 1) } else { None });
        let children = |sep: &str, lvl: usize| self.render_nodes(content(node), Some(node), sep, lvl);
        match t {
            "doc" | "columns" | "column" => {
                if !has_content(node) && t == "doc" {
                    return String::new();
                }
                children("\n\n", level)
            }
            "paragraph" => {
                if !has_content(node) {
                    let prev_empty = prev.is_some_and(|p| ty(p) == "paragraph" && !has_content(p));
                    return if prev_empty { "&nbsp;".into() } else { String::new() };
                }
                let out = children("", level);
                if self.escape_lines {
                    return escape_line_starts(&out);
                }
                out
            }
            "heading" => {
                if !has_content(node) {
                    return String::new();
                }
                let lvl = attr(node, "level").as_f64().unwrap_or(1.0).max(0.0) as usize;
                let mut text = children("", level);
                if self.escape_lines && text.ends_with('#') {
                    text.insert(text.len() - 1, '\\');
                }
                format!("{} {}", "#".repeat(lvl.min(64)), text)
            }
            "blockquote" => {
                if !has_content(node) {
                    return String::new();
                }
                let parts: Vec<String> = content(node)
                    .iter()
                    .enumerate()
                    .map(|(i, ch)| {
                        let c = self.render(ch, Some(node), i, level);
                        c.split('\n')
                            .map(|l| if trim(l).is_empty() { ">".to_string() } else { format!("> {l}") })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .collect();
                parts.join("\n>\n")
            }
            "pullQuote" => children("", level)
                .split('\n')
                .map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") })
                .collect::<Vec<_>>()
                .join("\n"),
            "bulletList" | "orderedList" | "taskList" => {
                if !has_content(node) {
                    return String::new();
                }
                children("\n", level + 1)
            }
            "listItem" | "taskItem" => self.list_item(node, parent, index, level),
            "codeBlock" => {
                let lang = attr(node, "language");
                let lang = if truthy(lang) { js_num(lang) } else { String::new() };
                // the annotated flavour fences code holding a ``` line with a longer run, so it reads back
                let body = children("", level);
                let fence = if self.annotated { "`".repeat(fence_len(&body)) } else { "```".to_string() };
                if !has_content(node) {
                    format!("{fence}{lang}\n\n{fence}")
                } else {
                    format!("{fence}{lang}\n{body}\n{fence}")
                }
            }
            "horizontalRule" => "---".into(),
            // the annotated flavour writes `<br>`: it reads back as a break anywhere (task items, headings, the
            // start or end of a paragraph), where two spaces and a newline do not
            "hardBreak" => {
                if self.annotated {
                    "<br>".into()
                } else {
                    "  \n".into()
                }
            }
            "image" => {
                let alt = attr(node, "alt");
                let alt = if alt.is_null() { String::new() } else { js_num(alt) };
                let width = attr(node, "width");
                let w = if truthy(width) { format!("|{}", js_num(width)) } else { String::new() };
                let src = js_num(attr(node, "src"));
                let title = attr(node, "title");
                let title = if truthy(title) { format!(" \"{}\"", js_num(title)) } else { String::new() };
                format!("![{alt}{w}]({src}{title})")
            }
            "table" => {
                if has_merged_cells(node) {
                    return embed_line("table with merged cells", &merged_cells_title(node));
                }
                self.table(node, level)
            }
            "callout" => {
                let kind = str_attr(node, "kind");
                let body = children("\n\n", level);
                let lines: Vec<String> =
                    body.split('\n').map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect();
                // the annotated flavour keeps the title in the block's marker (or restores it from the page)
                let title = match attr(node, "title") {
                    Value::String(s) if !self.annotated => trim(&crate::chars::collapse_spaces(s)).to_string(),
                    _ => String::new(),
                };
                let head = if title.is_empty() {
                    format!("> [!{}]", callout_marker(kind))
                } else {
                    format!("> [!{}] {title}", callout_marker(kind))
                };
                std::iter::once(head).chain(lines).collect::<Vec<_>>().join("\n")
            }
            "diagram" | "sketch" | "canvas" => {
                let default = match t {
                    "diagram" => "Diagram",
                    "sketch" => "Sketch",
                    _ => "Canvas",
                };
                let label = str_attr(node, "label");
                let label = if label.is_empty() { default } else { label };
                let label: String = {
                    let mut out = String::new();
                    let mut run = false;
                    for c in label.chars() {
                        if matches!(c, '[' | ']' | '\n') {
                            if !run {
                                out.push(' ');
                            }
                            run = true;
                        } else {
                            out.push(c);
                            run = false;
                        }
                    }
                    out
                };
                let id = str_attr(node, "id");
                match t {
                    "diagram" => format!("[{label}](diagram:{id})"),
                    "sketch" => format!("![{label}](sketch:{id})"),
                    _ => {
                        let frag = str_attr(node, "fragment");
                        let frag = if frag.is_empty() { String::new() } else { format!("#{frag}") };
                        format!("![{label}](canvas:{id}{frag})")
                    }
                }
            }
            "mathInline" => format!("${}$", js_num(attr(node, "latex"))),
            "mathBlock" => format!("$$\n{}\n$$", js_num(attr(node, "latex"))),
            "docRef" => {
                let page = js_num(attr(node, "page"));
                let section = attr(node, "section");
                let label = attr(node, "label");
                let mut s = format!("[[{page}");
                if truthy(section) {
                    s.push('#');
                    s.push_str(&js_num(section));
                }
                if truthy(label) {
                    s.push('|');
                    s.push_str(&js_num(label));
                }
                s.push_str("]]");
                if self.annotated {
                    let mut extra = Vec::new();
                    if let Value::String(v) = attr(node, "pageId") {
                        extra.push(format!("page-id={}", crate::annotated::quote(v)));
                    }
                    if let Value::String(v) = attr(node, "targetBlockId") {
                        extra.push(format!("target={}", crate::annotated::quote(v)));
                    }
                    if let Value::String(v) = attr(node, "targetLabel") {
                        extra.push(format!("target-label={}", crate::annotated::quote(v)));
                    }
                    if !extra.is_empty() {
                        s.push_str(&format!("{{{}}}", extra.join(" ")));
                    }
                }
                s
            }
            "ticketRef" => js_num(attr(node, "key")),
            "video" => {
                let pick = [str_attr(node, "title"), str_attr(node, "caption"), str_attr(node, "src")]
                    .into_iter()
                    .find(|s| !s.is_empty())
                    .unwrap_or("");
                embed_line("video", pick)
            }
            "htmlEmbed" => embed_line("HTML embed", str_attr(node, "title")),
            "fileCard" => {
                let name = str_attr(node, "name");
                let src = str_attr(node, "src");
                let label = if name.is_empty() { src } else { name };
                format!("[{}]({src})", escape_markdown_text(&plain_line(label)))
            }
            "linkEmbed" => {
                let title = str_attr(node, "title");
                embed_line("link", if title.is_empty() { str_attr(node, "url") } else { title })
            }
            "pageCard" => {
                let page = str_attr(node, "page");
                if page.is_empty() {
                    String::new()
                } else {
                    let p: String =
                        plain_line(page).chars().map(|c| if c == '|' || c == '#' { ' ' } else { c }).collect();
                    format!("[[{}]]", trim(&p))
                }
            }
            "ticketCard" => str_attr(node, "key").to_string(),
            _ => String::new(),
        }
    }

    /// `renderNestedMarkdownContent` for list and task items.
    fn list_item(&self, node: &Value, parent: Option<&Value>, index: usize, level: usize) -> String {
        let c = content(node);
        if node.get("content").and_then(Value::as_array).is_none() {
            return String::new();
        }
        let parent_ty = parent.map(ty).unwrap_or("");
        let (prefix, align) = if ty(node) == "taskItem" {
            let checked = attr(node, "checked").as_bool().unwrap_or(false);
            (if checked { "- [x] ".to_string() } else { "- [ ] ".to_string() }, false)
        } else if parent_ty == "orderedList" {
            let p = parent.unwrap_or(&Value::Null);
            let start = attr(p, "start");
            let start = if truthy(start) { start.as_f64().unwrap_or(1.0) } else { 1.0 };
            let ltype = attr(p, "type");
            let pos = start - 1.0 + index as f64 + 1.0;
            (list_marker(ltype.as_str(), pos), true)
        } else {
            ("- ".to_string(), false)
        };
        let Some((first, rest)) = c.split_first() else {
            return prefix;
        };
        let main = self.render_nodes(std::slice::from_ref(first), Some(node), "", level);
        // an empty bullet item is `-` alone: `- ` with nothing after it does not start a list
        let prefix = if self.annotated && main.is_empty() && prefix == "- " { "-".to_string() } else { prefix };
        let mut out = format!("{prefix}{main}");
        let indent = if align && js_len(&prefix) > 2 { " ".repeat(js_len(&prefix)) } else { "  ".to_string() };
        for (k, ch) in rest.iter().enumerate() {
            let body = self.render(ch, Some(node), k + 1, level);
            let indented = body.split('\n').map(|l| format!("{indent}{l}")).collect::<Vec<_>>().join("\n");
            if ty(ch) == "paragraph" {
                out.push_str("\n\n");
            } else {
                out.push('\n');
            }
            out.push_str(&indented);
        }
        out
    }

    /// `renderTableToMarkdown` (the editor's GFM table).
    fn table(&self, node: &Value, level: usize) -> String {
        struct Cell {
            text: String,
            header: bool,
            align: Option<String>,
        }
        let rows: Vec<Vec<Cell>> = content(node)
            .iter()
            .map(|row| {
                content(row)
                    .iter()
                    .map(|cell| {
                        let cc = content(cell);
                        let raw = if cc.len() > 1 {
                            cc.iter()
                                .map(|child| self.render_nodes(content(child), Some(node), "", level))
                                .collect::<Vec<_>>()
                                .join("\n")
                        } else {
                            self.render_nodes(cc, Some(node), "", level)
                        };
                        let single = br_lines(&raw);
                        let single = trim(&crate::chars::collapse_spaces(&single.replace('\u{1f}', " "))).to_string();
                        let text = escape_cell_pipes(&single);
                        let align = attr(cell, "align")
                            .as_str()
                            .filter(|a| matches!(*a, "left" | "right" | "center"))
                            .map(str::to_string);
                        Cell { text, header: ty(cell) == "tableHeader", align }
                    })
                    .collect()
            })
            .collect();
        let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
        if cols == 0 {
            return String::new();
        }
        let mut widths = vec![0usize; cols];
        for r in &rows {
            for (i, w) in widths.iter_mut().enumerate() {
                let len = r.get(i).map_or(0, |c| js_len(&c.text));
                *w = (*w).max(len).max(3);
            }
        }
        let pad = |s: &str, w: usize| format!("{s}{}", " ".repeat(w.saturating_sub(js_len(s))));
        let has_header = rows[0].iter().any(|c| c.header);
        let mut aligns: Vec<Option<String>> = vec![None; cols];
        for r in &rows {
            for (i, a) in aligns.iter_mut().enumerate() {
                if a.is_none() {
                    if let Some(c) = r.get(i) {
                        a.clone_from(&c.align);
                    }
                }
            }
        }
        let mut out = String::from("\n");
        let header: Vec<String> = (0..cols)
            .map(|i| pad(if has_header { rows[0].get(i).map_or("", |c| c.text.as_str()) } else { "" }, widths[i]))
            .collect();
        out.push_str(&format!("| {} |\n", header.join(" | ")));
        let sep: Vec<String> = widths
            .iter()
            .enumerate()
            .map(|(i, w)| {
                let d = "-".repeat((*w).max(3));
                match aligns[i].as_deref() {
                    Some("left") => format!(":{d}"),
                    Some("right") => format!("{d}:"),
                    Some("center") => format!(":{d}:"),
                    _ => d,
                }
            })
            .collect();
        out.push_str(&format!("| {} |\n", sep.join(" | ")));
        let body = if has_header { &rows[1..] } else { &rows[..] };
        for r in body {
            let cells: Vec<String> =
                (0..cols).map(|i| pad(r.get(i).map_or("", |c| c.text.as_str()), widths[i])).collect();
            out.push_str(&format!("| {} |\n", cells.join(" | ")));
        }
        out
    }
}

/// `raw.replace(/[ \t]*\r?\n[ \t]*/g, '<br>')`.
fn br_lines(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let lines: Vec<&str> = raw.split('\n').collect();
    for (i, l) in lines.iter().enumerate() {
        let mut l: &str = l;
        if i > 0 {
            l = l.trim_start_matches([' ', '\t']);
        }
        if i + 1 < lines.len() {
            l = l.trim_end_matches([' ', '\t']);
            l = l.strip_suffix('\r').unwrap_or(l);
            l = l.trim_end_matches([' ', '\t']);
            out.push_str(l);
            out.push_str("<br>");
        } else {
            out.push_str(l);
        }
    }
    out
}

/// `escapePipesInCellText`: a bare `|` becomes `\|`, escapes are kept.
fn escape_cell_pipes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            out.push(c);
            if let Some(n) = it.next() {
                out.push(n);
            }
        } else if c == '|' {
            out.push_str("\\|");
        } else {
            out.push(c);
        }
    }
    out
}

fn list_marker(ltype: Option<&str>, position: f64) -> String {
    let n = position;
    let as_int = || if n >= 1.0 && n.fract() == 0.0 && n < 1e15 { Some(n as u64) } else { None };
    let num = || if n.fract() == 0.0 && n.abs() < 1e21 { format!("{}", n as i64) } else { format!("{n}") };
    match (ltype, as_int()) {
        (Some("a"), Some(k)) => format!("{}. ", super::block::to_alpha(k)),
        (Some("A"), Some(k)) => format!("{}. ", super::block::to_alpha(k).to_ascii_uppercase()),
        (Some("i"), Some(k)) => format!("{}. ", super::block::to_roman(k)),
        (Some("I"), Some(k)) => format!("{}. ", super::block::to_roman(k).to_ascii_uppercase()),
        _ => format!("{}. ", num()),
    }
}

fn marks_to_close(current: &OMap, next: Option<&Value>) -> Vec<String> {
    current
        .0
        .iter()
        .filter(|(t, m)| next.is_none() || !next_has(next, t, mark_attrs(m)))
        .map(|(t, _)| t.clone())
        .collect()
}

fn marks_to_close_at_end(active: &OMap, current: &OMap, next: Option<&Value>) -> Vec<String> {
    let next_marks = next.and_then(|n| n.get("marks")).and_then(Value::as_array);
    let is_last = next.is_none();
    let next_no_marks = next.is_some() && next_marks.is_none_or(Vec::is_empty);
    let next_different = next_marks.is_some_and(|nm| {
        let other = {
            let mut m = OMap::default();
            for x in nm {
                m.set(x["type"].as_str().unwrap_or(""), x.clone());
            }
            m
        };
        !(current.0.len() == other.0.len()
            && current.0.iter().all(|(t, m)| other.get(t).is_some_and(|o| attrs_equal(mark_attrs(m), mark_attrs(o)))))
    });
    let mut out = Vec::new();
    if is_last || next_no_marks || next_different {
        if next_marks.is_some() {
            for (t, m) in active.0.iter().rev() {
                if !next_has(next, t, mark_attrs(m)) {
                    out.push(t.clone());
                }
            }
        } else {
            out.extend(active.keys().into_iter().rev());
        }
    }
    out
}

/// `^\s*(```|~~~)`.
fn is_fence_line(line: &str) -> bool {
    let t = line.trim_start_matches(is_space);
    t.starts_with("```") || t.starts_with("~~~")
}

/// `cleanEditorMarkdown`: undo the editor's `&amp;`, `&lt;` and `&gt;` outside code.
pub fn clean_editor_markdown(md: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut fenced = false;
    for line in md.split('\n') {
        if is_fence_line(line) {
            fenced = !fenced;
            out.push(line.to_string());
        } else if fenced {
            out.push(line.to_string());
        } else {
            let mut s = String::with_capacity(line.len());
            let mut rest = line;
            loop {
                match rest.find('`') {
                    Some(a) => match rest[a + 1..].find('`') {
                        Some(b) => {
                            s.push_str(&unescape_entities(&rest[..a]));
                            s.push_str(&rest[a..a + 1 + b + 1]);
                            rest = &rest[a + b + 2..];
                        }
                        None => {
                            s.push_str(&unescape_entities(rest));
                            break;
                        }
                    },
                    None => {
                        s.push_str(&unescape_entities(rest));
                        break;
                    }
                }
            }
            out.push(s);
        }
    }
    out.join("\n")
}

fn unescape_entities(s: &str) -> String {
    // &lt; not followed by [A-Za-z/!?] → <, then &gt; → >, then &amp; → &
    let mut a = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("&lt;") {
        a.push_str(&rest[..i]);
        let after = &rest[i + 4..];
        if after.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?')) {
            a.push_str("&lt;");
        } else {
            a.push('<');
        }
        rest = after;
    }
    a.push_str(rest);
    a.replace("&gt;", ">").replace("&amp;", "&")
}

/// `compactMarkdown`: compact tables, single blank lines (fenced code untouched).
pub fn compact_markdown(md: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut fenced = false;
    let mut blank = false;
    for line in md.split('\n') {
        if is_fence_line(line) {
            fenced = !fenced;
            blank = false;
            out.push(line.to_string());
            continue;
        }
        if fenced {
            out.push(line.to_string());
            continue;
        }
        if trim(line).is_empty() {
            if blank {
                continue;
            }
            blank = true;
            out.push(String::new());
            continue;
        }
        blank = false;
        let lead = line.chars().take_while(|c| is_space(*c)).count();
        if is_row(line) && lead < 4 {
            out.push(compact_row(line));
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

/// `^\s*\|.*\|\s*$`.
fn is_row(line: &str) -> bool {
    let t = trim(line);
    t.len() >= 2 && t.starts_with('|') && t.ends_with('|') && !t.contains(['\r', '\u{2028}', '\u{2029}'])
}

fn compact_row(line: &str) -> String {
    let t = trim(line);
    let inner = &t[1..t.len() - 1];
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut it = inner.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\\' && it.peek().is_some() {
            cur.push(c);
            if let Some(n) = it.next() {
                cur.push(n);
            }
        } else if c == '|' {
            cells.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    cells.push(cur);
    let cells: Vec<String> = cells.iter().map(|c| trim(c).to_string()).collect();
    let is_delim = |c: &str| {
        let d = c.strip_prefix(':').unwrap_or(c);
        let d = d.strip_suffix(':').unwrap_or(d);
        !d.is_empty() && d.bytes().all(|b| b == b'-')
    };
    let delim = !cells.is_empty() && cells.iter().all(|c| is_delim(c));
    let parts: Vec<String> = if delim {
        cells
            .iter()
            .map(|c| {
                format!("{}---{}", if c.starts_with(':') { ":" } else { "" }, if c.ends_with(':') { ":" } else { "" })
            })
            .collect()
    } else {
        cells
    };
    format!("| {} |", parts.join(" | "))
}
