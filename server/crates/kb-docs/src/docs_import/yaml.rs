//! `yaml.safe_load` as PyYAML (YAML 1.1) answers it, for the front matter of imported files.
//!
//! The text is parsed into events by `yaml-rust2` (its scanner and parser follow libyaml, as PyYAML's do); the plain
//! scalars are typed by PyYAML's resolver, not the YAML 1.2 core schema the crates use: `yes`, `on` and `No` are
//! booleans, `0777` is an octal number, `1:30` a sexagesimal number, `~` and an empty value are null, `2024-01-02` is
//! a date. Collections are built with PyYAML's `SafeConstructor` rules (merge keys `<<`, a later duplicate key wins).
//!
//! Failures are the two ways Python's `split_front_matter` can end: a `yaml.YAMLError` (the line of its
//! `problem_mark` is reported to the user) and any other exception, which nothing catches (`int("")` of `0x_`): a 500.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::scanner::TScalarStyle;

/// A value of a YAML document, typed as PyYAML types it.
#[derive(Debug, Clone, PartialEq)]
pub enum Yaml {
    /// `~`, `null` or an empty value.
    Null,
    /// `true`, `yes`, `on` and their opposites.
    Bool(bool),
    /// An integer, as the decimal digits Python's `str(int)` gives.
    Int(String),
    /// A float (`.inf` and `.nan` included).
    Float(f64),
    /// A string.
    Str(String),
    /// A list.
    Seq(Vec<Yaml>),
    /// A mapping, in Python's dict order.
    Map(Vec<(Yaml, Yaml)>),
    /// A value Python builds as an object that is neither of the above (`date`, `datetime`, `bytes`, `set`).
    Other(&'static str),
}

/// Why a document could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// A `yaml.YAMLError`: the 1-based line (in the text given) of its `problem_mark`, `None` without one, and what
    /// the parser said (for a log; it is not Python's text) and its column.
    Yaml(Option<usize>, String, usize),
    /// Another exception of the loader (`ValueError` from `int()`): not caught by the importer.
    Crash(String),
}

impl Yaml {
    /// The mapping's value for a string key (`meta.get("title")`).
    pub fn get(&self, key: &str) -> Option<&Yaml> {
        match self {
            Yaml::Map(entries) => entries.iter().find(|(k, _)| matches!(k, Yaml::Str(s) if s == key)).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The value as JSON, the way the golden vectors write a Python value: a mapping with only string keys is an
    /// object, any other mapping a list of `[key, value]` pairs, and an object that is not JSON `{"$": kind}`.
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::{Value, json};
        match self {
            Yaml::Null => Value::Null,
            Yaml::Bool(b) => json!(b),
            Yaml::Int(digits) => match digits.parse::<i64>() {
                Ok(n) => json!(n),
                Err(_) => json!({"$": "bigint", "digits": digits}),
            },
            Yaml::Float(f) if f.is_nan() => json!({"$": "float", "value": "nan"}),
            Yaml::Float(f) if f.is_infinite() => json!({"$": "float", "value": if *f > 0.0 { "inf" } else { "-inf" }}),
            Yaml::Float(f) => json!({"$": "float", "value": kb_base::pyjson::float_repr(*f)}),
            Yaml::Str(s) => json!(s),
            Yaml::Seq(items) => Value::Array(items.iter().map(Yaml::to_json).collect()),
            Yaml::Map(entries) => {
                if entries.iter().all(|(k, _)| matches!(k, Yaml::Str(_))) {
                    let mut out = serde_json::Map::new();
                    for (k, v) in entries {
                        if let Yaml::Str(k) = k {
                            out.insert(k.clone(), v.to_json());
                        }
                    }
                    Value::Object(out)
                } else {
                    json!({"$": "pairs", "items": entries.iter().map(|(k, v)| json!([k.to_json(), v.to_json()])).collect::<Vec<_>>()})
                }
            }
            Yaml::Other(kind) => json!({"$": kind}),
        }
    }
}

/// `yaml.safe_load(text)`; `None` for an empty document.
pub fn safe_load(text: &str) -> Result<Option<Yaml>, Failure> {
    // PyYAML's reader refuses control characters before it scans anything (a `ReaderError` has no mark)
    if text.chars().any(|c| !printable(c)) {
        return Err(Failure::Yaml(None, "a character a YAML stream may not hold".into(), 0));
    }
    // the parser of the crate asserts on input it does not expect: a panic is an error of the document
    // libyaml breaks lines at NEL too; the parser of the crate does not
    let mut text = text.replace('\u{85}', "\n");
    // what libyaml refuses and the crate accepts (tabs as indentation, a second anchor of the same name)
    let early = early_problem(&text);
    let mut result = Err(Failure::Yaml(None, "the parser gave up".into(), 0));
    for _ in 0..200 {
        result = match catch_unwind(AssertUnwindSafe(|| load(&text))) {
            Ok(r) => r,
            Err(_) => Err(Failure::Yaml(None, "the parser gave up".into(), 0)),
        };
        // libyaml lets the lines of a quoted scalar start left of the block's indentation; the crate does not.
        // Leading white space of a continuation line is folded away, so adding some changes nothing.
        match &result {
            Err(Failure::Yaml(Some(line), info, col)) if info == "invalid indentation in quoted scalar" => {
                match indent_quoted(&text, *line, *col) {
                    Some(fixed) => text = fixed,
                    None => {
                        let last = text.split('\n').count();
                        return Err(Failure::Yaml(Some(last), "found unexpected end of stream".into(), 0));
                    }
                }
            }
            _ => break,
        }
    }
    match result {
        Ok(value) => match early {
            Some(line) => Err(Failure::Yaml(Some(line), "early problem".into(), 0)),
            None => Ok(value),
        },
        Err(Failure::Yaml(line, info, col)) => {
            let line =
                line.map(|l| fix_line(&text, l, &info)).map(|l| early.map_or(l, |e| if l + 1 >= e { e } else { l }));
            Err(Failure::Yaml(line, info, col))
        }
        other => other,
    }
}

/// Add spaces to the continuation lines of the quoted scalar that starts at `line` and `col` (1-based line, 0-based
/// column); `None` when it never ends.
fn indent_quoted(text: &str, line: usize, col: usize) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut start = 0;
    for _ in 1..line {
        start += chars[start..].iter().position(|&c| c == '\n')? + 1;
    }
    start += col;
    let quote = *chars.get(start)?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let mut i = start + 1;
    let mut end = None;
    while i < chars.len() {
        match chars[i] {
            '\\' if quote == '"' => i += 1,
            c if c == quote => {
                if quote == '\'' && chars.get(i + 1) == Some(&'\'') {
                    i += 1;
                } else {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let end = end?;
    let pad = " ".repeat(col + 1);
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        out.push(*c);
        if *c == '\n' && i > start && i < end {
            out.push_str(&pad);
        }
    }
    Some(out)
}

/// `Reader.NON_PRINTABLE`: the characters a YAML stream may hold.
fn printable(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{7e}' | '\u{85}' | '\u{a0}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}')
        || c >= '\u{10000}'
}

/// An open collection while the events arrive.
enum Frame {
    Seq { anchor: usize, tag: Option<String>, items: Vec<Yaml> },
    Map { anchor: usize, tag: Option<String>, entries: Vec<(Yaml, Yaml)>, key: Option<Key> },
}

/// A key waiting for its value.
struct Key {
    value: Yaml,
    /// A plain `<<`: PyYAML's merge key.
    merge: bool,
}

fn line_of(mark: &yaml_rust2::scanner::Marker) -> Failure {
    Failure::Yaml(Some(mark.line()), String::new(), 0)
}

/// Where PyYAML puts a `problem_mark` that the parser of the crate puts elsewhere: an error at the end of the text
/// is on its last line (the crate counts a final line break as a new line), and an unterminated quoted scalar is
/// reported at the end of the stream.
fn fix_line(text: &str, line: usize, info: &str) -> usize {
    let lines = text.split('\n').count();
    if info.contains("unexpected end of stream") && info.contains("quoted scalar") {
        return lines;
    }
    line.min(lines)
}

/// The 1-based line of the first problem libyaml finds that the crate lets pass: a line that starts (after spaces)
/// with a tab in block context, or an anchor name that is defined a second time. Flow collections, block scalars and
/// quoted scalars may hold tabs.
fn early_problem(text: &str) -> Option<usize> {
    let mut flow: i32 = 0;
    let mut block_scalar: Option<usize> = None;
    let mut quote: Option<char> = None;
    let mut anchors: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (n, line) in text.split('\n').enumerate() {
        let indent = line.chars().take_while(|&c| c == ' ').count();
        let rest = &line[indent..];
        if let Some(parent) = block_scalar {
            if rest.is_empty() || indent > parent {
                continue;
            }
            block_scalar = None;
        }
        if quote.is_none() && flow == 0 && rest.starts_with('\t') {
            return Some(n + 1);
        }
        // follow quotes and brackets of this line (comments end it)
        let mut prev = ' ';
        let mut chars = rest.chars().peekable();
        while let Some(c) = chars.next() {
            match quote {
                Some('"') if c == '\\' => {
                    chars.next();
                }
                Some(q) if c == q => {
                    if q == '\'' && chars.peek() == Some(&'\'') {
                        chars.next();
                    } else {
                        quote = None;
                    }
                }
                Some(_) => {}
                None => {
                    let after_space = matches!(prev, ' ' | '\t' | '[' | '{' | ',' | ':' | '-');
                    match c {
                        '#' if prev == ' ' || prev == '\t' => break,
                        '"' | '\'' if after_space => quote = Some(c),
                        '&' if after_space || prev == '\0' => {
                            let mut name = String::new();
                            while let Some(&p) = chars.peek() {
                                if p.is_whitespace() || matches!(p, ',' | '[' | ']' | '{' | '}') {
                                    break;
                                }
                                name.push(p);
                                chars.next();
                            }
                            if !name.is_empty() && !anchors.insert(name) {
                                return Some(n + 1);
                            }
                        }
                        '[' | '{' => flow += 1,
                        ']' | '}' => flow = (flow - 1).max(0),
                        _ => {}
                    }
                }
            }
            prev = c;
        }
        let head = rest.trim_end();
        if quote.is_none() && flow == 0 {
            let tail = head.rsplit(' ').next().unwrap_or("");
            let indicator = tail.trim_start_matches(['|', '>']);
            if (tail.starts_with('|') || tail.starts_with('>'))
                && indicator.chars().all(|c| matches!(c, '+' | '-' | '0'..='9'))
            {
                block_scalar = Some(indent);
            }
        }
    }
    None
}

fn load(text: &str) -> Result<Option<Yaml>, Failure> {
    let mut parser = Parser::new_from_str(text);
    let mut stack: Vec<Frame> = Vec::new();
    let mut anchors: HashMap<usize, Yaml> = HashMap::new();
    let mut root: Option<Yaml> = None;
    let mut documents = 0;
    // whether the last scalar of the stream is a literal or folded one
    let mut last_block = false;
    loop {
        let (event, mark) = parser
            .next_token()
            .map_err(|e| Failure::Yaml(Some(e.marker().line()), e.info().to_string(), e.marker().col()))?;
        let mut merge_key = false;
        let value = match event {
            Event::Nothing | Event::StreamStart | Event::DocumentEnd => continue,
            Event::StreamEnd => break,
            Event::DocumentStart => {
                documents += 1;
                if documents > 1 {
                    // "expected a single document in the stream"
                    return Err(line_of(&mark));
                }
                continue;
            }
            Event::Alias(id) => match anchors.get(&id) {
                Some(v) => v.clone(),
                // a collection that refers to itself: PyYAML builds a cyclic object
                None => Yaml::Null,
            },
            Event::Scalar(text, style, anchor, tag) => {
                last_block = matches!(style, TScalarStyle::Literal | TScalarStyle::Folded);
                merge_key = style == TScalarStyle::Plain && tag.is_none() && text == "<<";
                // a merge tag has a constructor only on a key: "could not determine a constructor for the tag"
                if merge_key && !matches!(stack.last(), Some(Frame::Map { key: None, .. })) {
                    return Err(line_of(&mark));
                }
                let value = scalar(&text, style, tag.as_ref().map(tag_name), &mark)?;
                if anchor != 0 {
                    anchors.insert(anchor, value.clone());
                }
                value
            }
            Event::SequenceStart(anchor, tag) => {
                stack.push(Frame::Seq { anchor, tag: tag.as_ref().map(tag_name), items: Vec::new() });
                continue;
            }
            Event::MappingStart(anchor, tag) => {
                stack.push(Frame::Map { anchor, tag: tag.as_ref().map(tag_name), entries: Vec::new(), key: None });
                continue;
            }
            Event::SequenceEnd => match stack.pop() {
                Some(Frame::Seq { anchor, tag, items }) => {
                    let value = collection(tag.as_deref(), Yaml::Seq(items), &mark)?;
                    if anchor != 0 {
                        anchors.insert(anchor, value.clone());
                    }
                    value
                }
                _ => return Err(line_of(&mark)),
            },
            Event::MappingEnd => match stack.pop() {
                Some(Frame::Map { anchor, tag, entries, .. }) => {
                    let value = collection(tag.as_deref(), Yaml::Map(entries), &mark)?;
                    if anchor != 0 {
                        anchors.insert(anchor, value.clone());
                    }
                    value
                }
                _ => return Err(line_of(&mark)),
            },
        };
        // `value` is a finished node: it belongs to the open collection, or it is the document
        match stack.last_mut() {
            None => root = Some(value),
            Some(Frame::Seq { items, .. }) => items.push(value),
            Some(Frame::Map { entries, key, .. }) => match key.take() {
                None => {
                    // a key: PyYAML refuses a list or a mapping (unhashable); the merge key is a plain `<<`
                    let merge = merge_key;
                    if matches!(value, Yaml::Seq(_) | Yaml::Map(_)) {
                        return Err(line_of(&mark));
                    }
                    *key = Some(Key { value, merge });
                }
                Some(k) => {
                    if k.merge {
                        merge_into(entries, value, &mark)?;
                    } else {
                        set_key(entries, k.value, value);
                    }
                }
            },
        }
    }
    // A block scalar that ends the text has no final line break to keep when the text does not end with one
    // (the crate always adds it).
    let last_line = text.rsplit('\n').next().unwrap_or("");
    if last_block && !text.ends_with('\n') && !last_line.trim().is_empty() && !last_line.trim_start().starts_with('#') {
        if let Some(root) = root.as_mut() {
            drop_final_break(root);
        }
    }
    Ok(root)
}

/// The rightmost string of a document loses its last `\n`.
fn drop_final_break(value: &mut Yaml) {
    match value {
        Yaml::Seq(items) => {
            if let Some(last) = items.last_mut() {
                drop_final_break(last);
            }
        }
        Yaml::Map(entries) => {
            if let Some((_, last)) = entries.last_mut() {
                drop_final_break(last);
            }
        }
        Yaml::Str(s) if s.ends_with('\n') => {
            s.pop();
        }
        _ => {}
    }
}

/// The full name of a tag (`tag:yaml.org,2002:str` or `!local`).
fn tag_name(tag: &yaml_rust2::parser::Tag) -> String {
    format!("{}{}", tag.handle, tag.suffix)
}

/// PyYAML's `SafeConstructor` for a collection with an explicit tag.
fn collection(tag: Option<&str>, value: Yaml, mark: &yaml_rust2::scanner::Marker) -> Result<Yaml, Failure> {
    let Some(tag) = tag else { return Ok(value) };
    if tag == "!" {
        return Ok(value);
    }
    let Some(name) = tag.strip_prefix("tag:yaml.org,2002:") else { return Err(line_of(mark)) };
    match (name, value) {
        ("seq", v @ Yaml::Seq(_)) | ("map", v @ Yaml::Map(_)) => Ok(v),
        // a list of (key, value) tuples: every item must be a mapping with one key
        ("omap" | "pairs", Yaml::Seq(items)) => {
            let mut pairs = Vec::new();
            for item in items {
                match item {
                    Yaml::Map(mut m) if m.len() == 1 => {
                        let (k, v) = m.remove(0);
                        pairs.push(Yaml::Seq(vec![k, v]));
                    }
                    _ => return Err(line_of(mark)),
                }
            }
            Ok(Yaml::Seq(pairs))
        }
        ("set", Yaml::Map(_)) => Ok(Yaml::Other("set")),
        _ => Err(line_of(mark)),
    }
}

/// `dict[key] = value`: a key that compares equal to an earlier one replaces its value and keeps its place.
fn set_key(entries: &mut Vec<(Yaml, Yaml)>, key: Yaml, value: Yaml) {
    match entries.iter_mut().find(|(k, _)| same_key(k, &key)) {
        Some(slot) => slot.1 = value,
        None => entries.push((key, value)),
    }
}

/// Python's `==` between two hashable scalars (`1 == True == 1.0`).
fn same_key(a: &Yaml, b: &Yaml) -> bool {
    fn number(y: &Yaml) -> Option<f64> {
        match y {
            Yaml::Bool(b) => Some(f64::from(u8::from(*b))),
            Yaml::Int(d) => d.parse::<f64>().ok(),
            Yaml::Float(f) => Some(*f),
            _ => None,
        }
    }
    match (a, b) {
        (Yaml::Null, Yaml::Null) => true,
        (Yaml::Str(x), Yaml::Str(y)) => x == y,
        (Yaml::Other(x), Yaml::Other(y)) => x == y,
        _ => matches!((number(a), number(b)), (Some(x), Some(y)) if x == y),
    }
}

/// `flatten_mapping` for one `<<` entry: a mapping, or a list of mappings (the first one wins), is merged under the
/// explicit keys of the node.
fn merge_into(entries: &mut Vec<(Yaml, Yaml)>, value: Yaml, mark: &yaml_rust2::scanner::Marker) -> Result<(), Failure> {
    let mut merged: Vec<(Yaml, Yaml)> = Vec::new();
    match value {
        Yaml::Map(m) => merged.extend(m),
        Yaml::Seq(items) => {
            for item in items.into_iter().rev() {
                match item {
                    Yaml::Map(m) => merged.extend(m),
                    _ => return Err(line_of(mark)),
                }
            }
        }
        _ => return Err(line_of(mark)),
    }
    // the merged entries come first: the explicit keys of the node are set after them and win
    let own = std::mem::take(entries);
    for (k, v) in merged {
        set_key(entries, k, v);
    }
    for (k, v) in own {
        set_key(entries, k, v);
    }
    Ok(())
}

/// A scalar node: typed by its tag, else (when plain) by PyYAML's implicit resolvers, else a string.
fn scalar(
    text: &str,
    style: TScalarStyle,
    tag: Option<String>,
    mark: &yaml_rust2::scanner::Marker,
) -> Result<Yaml, Failure> {
    // the non-specific tag `!` is resolved like a plain scalar, whatever its style
    let non_specific = tag.as_deref() == Some("!");
    if let (Some(tag), false) = (&tag, non_specific) {
        let Some(name) = tag.strip_prefix("tag:yaml.org,2002:") else { return Err(line_of(mark)) };
        return match name {
            "str" => Ok(Yaml::Str(text.to_string())),
            "int" => construct_int(text),
            "float" => construct_float(text),
            "bool" => construct_bool(text),
            "null" => Ok(Yaml::Null),
            "timestamp" => construct_timestamp(text),
            "binary" => Ok(Yaml::Other("binary")),
            _ => Err(line_of(mark)),
        };
    }
    if style != TScalarStyle::Plain && !non_specific {
        // a block scalar of empty lines is the empty string (the crate keeps one line break)
        let empty_block = matches!(style, TScalarStyle::Literal | TScalarStyle::Folded) && text == "\n";
        return Ok(Yaml::Str(if empty_block { String::new() } else { text.to_string() }));
    }
    // The empty plain scalar the parser makes for a missing value is `~` in the crate: also null.
    match resolve(text) {
        Resolved::Str => Ok(Yaml::Str(text.to_string())),
        Resolved::Bool => construct_bool(text),
        Resolved::Int => construct_int(text),
        Resolved::Float => construct_float(text),
        Resolved::Null => Ok(Yaml::Null),
        Resolved::Timestamp => construct_timestamp(text),
        // `=` has an implicit tag with no constructor: "could not determine a constructor for the tag"
        Resolved::Value => Err(line_of(mark)),
    }
}

enum Resolved {
    Str,
    Bool,
    Int,
    Float,
    Null,
    Timestamp,
    Value,
}

/// The implicit resolvers of `yaml.resolver.Resolver`, tried in registration order for the first character.
fn resolve(text: &str) -> Resolved {
    let Some(first) = text.chars().next() else { return Resolved::Null };
    if "yYnNtTfFoO".contains(first) && is_bool(text) {
        return Resolved::Bool;
    }
    if "-+0123456789.".contains(first) && is_float(text) {
        return Resolved::Float;
    }
    if "-+0123456789".contains(first) && is_int(text) {
        return Resolved::Int;
    }
    if "~nN".contains(first) && matches!(text, "~" | "null" | "Null" | "NULL") {
        return Resolved::Null;
    }
    if first.is_ascii_digit() && is_timestamp(text) {
        return Resolved::Timestamp;
    }
    if text == "=" {
        return Resolved::Value;
    }
    Resolved::Str
}

fn is_bool(text: &str) -> bool {
    matches!(
        text,
        "yes"
            | "Yes"
            | "YES"
            | "no"
            | "No"
            | "NO"
            | "true"
            | "True"
            | "TRUE"
            | "false"
            | "False"
            | "FALSE"
            | "on"
            | "On"
            | "ON"
            | "off"
            | "Off"
            | "OFF"
    )
}

/// `[0-9][0-9_]*`
fn digits_us(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_digit()) && chars.all(|c| c.is_ascii_digit() || c == '_')
}

/// `(?::[0-5]?[0-9])+` over the whole of `s` (which starts after the first group).
fn sexagesimal_tail(s: &str) -> bool {
    !s.is_empty()
        && s.split(':').skip(1).all(|part| {
            let b = part.as_bytes();
            match b.len() {
                1 => b[0].is_ascii_digit(),
                2 => (b'0'..=b'5').contains(&b[0]) && b[1].is_ascii_digit(),
                _ => false,
            }
        })
        && s.starts_with(':')
}

fn is_float(text: &str) -> bool {
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    // [-+]?\.(?:inf|Inf|INF)  and  \.(?:nan|NaN|NAN)
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return true;
    }
    if matches!(text, ".nan" | ".NaN" | ".NAN") {
        return true;
    }
    // [-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?
    if let Some(dot) = unsigned.find('.') {
        let (int, rest) = (&unsigned[..dot], &unsigned[dot + 1..]);
        if digits_us(int) {
            // [-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*  (sexagesimal) is checked below
            if exponent_tail(rest, true) {
                return true;
            }
        }
        // [-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*
        if let Some(colon) = int.find(':') {
            if digits_us(&int[..colon])
                && sexagesimal_tail(&int[colon..])
                && rest.chars().all(|c| c.is_ascii_digit() || c == '_')
            {
                return true;
            }
        }
    }
    // \.[0-9][0-9_]*(?:[eE][-+][0-9]+)?  (no sign)
    if let Some(rest) = text.strip_prefix('.') {
        if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) && exponent_tail(rest, false) {
            return true;
        }
    }
    false
}

/// `[0-9_]*(?:[eE][-+][0-9]+)?` (`digits_may_be_empty`) or `[0-9][0-9_]*(?:[eE][-+][0-9]+)?`, whole string.
fn exponent_tail(s: &str, may_be_empty: bool) -> bool {
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    if !mantissa.chars().all(|c| c.is_ascii_digit() || c == '_') || (mantissa.is_empty() && !may_be_empty) {
        return false;
    }
    match exponent {
        None => true,
        Some(e) => {
            let mut chars = e.chars();
            matches!(chars.next(), Some('+' | '-')) && {
                let digits = chars.as_str();
                !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
            }
        }
    }
}

fn is_int(text: &str) -> bool {
    let u = text.strip_prefix(['-', '+']).unwrap_or(text);
    // [-+]?0b[0-1_]+
    if let Some(r) = u.strip_prefix("0b") {
        if !r.is_empty() && r.chars().all(|c| matches!(c, '0' | '1' | '_')) {
            return true;
        }
    }
    // [-+]?0[0-7_]+
    if let Some(r) = u.strip_prefix('0') {
        if !r.is_empty() && r.chars().all(|c| matches!(c, '0'..='7' | '_')) {
            return true;
        }
    }
    // [-+]?(?:0|[1-9][0-9_]*)
    if u == "0"
        || (u.starts_with(|c: char| ('1'..='9').contains(&c)) && u.chars().all(|c| c.is_ascii_digit() || c == '_'))
    {
        return true;
    }
    // [-+]?0x[0-9a-fA-F_]+
    if let Some(r) = u.strip_prefix("0x") {
        if !r.is_empty() && r.chars().all(|c| c.is_ascii_hexdigit() || c == '_') {
            return true;
        }
    }
    // [-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+
    if let Some(colon) = u.find(':') {
        let head = &u[..colon];
        if head.starts_with(|c: char| ('1'..='9').contains(&c)) && digits_us(head) && sexagesimal_tail(&u[colon..]) {
            return true;
        }
    }
    false
}

/// The timestamp resolver: `YYYY-MM-DD` or `YYYY-M-D[Tt ]h:mm:ss[.f][ tz]`.
fn is_timestamp(text: &str) -> bool {
    let b = text.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    if b.len() == 10
        && (0..4).all(digit)
        && b[4] == b'-'
        && digit(5)
        && digit(6)
        && b[7] == b'-'
        && digit(8)
        && digit(9)
    {
        return true;
    }
    if !(0..4).all(digit) || b.get(4) != Some(&b'-') {
        return false;
    }
    let mut i = 5;
    let take_digits = |i: &mut usize, min: usize, max: usize| -> bool {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() && *i - start < max {
            *i += 1;
        }
        *i - start >= min
    };
    if !take_digits(&mut i, 1, 2) || b.get(i) != Some(&b'-') {
        return false;
    }
    i += 1;
    if !take_digits(&mut i, 1, 2) {
        return false;
    }
    match b.get(i) {
        Some(b'T' | b't') => i += 1,
        Some(b' ' | b'\t') => {
            while matches!(b.get(i), Some(b' ' | b'\t')) {
                i += 1;
            }
        }
        _ => return false,
    }
    if !take_digits(&mut i, 1, 2) || b.get(i) != Some(&b':') {
        return false;
    }
    i += 1;
    if !(take_digits(&mut i, 2, 2)) || b.get(i) != Some(&b':') {
        return false;
    }
    i += 1;
    if !take_digits(&mut i, 2, 2) {
        return false;
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
    }
    // (?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?
    let mut j = i;
    while matches!(b.get(j), Some(b' ' | b'\t')) {
        j += 1;
    }
    if j == b.len() && j == i {
        return true;
    }
    match b.get(j) {
        Some(b'Z') => j + 1 == b.len(),
        Some(b'-' | b'+') => {
            j += 1;
            if !take_digits(&mut j, 1, 2) {
                return false;
            }
            if b.get(j) == Some(&b':') {
                j += 1;
                if !take_digits(&mut j, 2, 2) {
                    return false;
                }
            }
            j == b.len()
        }
        _ => false,
    }
}

fn construct_bool(text: &str) -> Result<Yaml, Failure> {
    match text.to_lowercase().as_str() {
        "yes" | "true" | "on" => Ok(Yaml::Bool(true)),
        "no" | "false" | "off" => Ok(Yaml::Bool(false)),
        _ => Err(Failure::Crash(format!("KeyError: {text:?}"))),
    }
}

/// `SafeConstructor.construct_yaml_int`.
fn construct_int(text: &str) -> Result<Yaml, Failure> {
    let crash = || Failure::Crash(format!("ValueError: invalid literal for int(): {text:?}"));
    let value: String = text.chars().filter(|&c| c != '_').collect();
    let (negative, unsigned) = match value.strip_prefix('-') {
        Some(rest) => (true, rest.to_string()),
        None => (false, value.strip_prefix('+').unwrap_or(&value).to_string()),
    };
    if unsigned.is_empty() {
        return Err(Failure::Crash("IndexError: string index out of range".into()));
    }
    let magnitude: i128 = if unsigned == "0" {
        0
    } else if let Some(r) = unsigned.strip_prefix("0b") {
        i128::from_str_radix(r, 2).map_err(|_| crash())?
    } else if let Some(r) = unsigned.strip_prefix("0x") {
        i128::from_str_radix(r, 16).map_err(|_| crash())?
    } else if unsigned.starts_with('0') {
        i128::from_str_radix(&unsigned, 8).map_err(|_| crash())?
    } else if unsigned.contains(':') {
        let mut total: i128 = 0;
        let mut base: i128 = 1;
        for part in unsigned.split(':').rev() {
            total += part.parse::<i128>().map_err(|_| crash())? * base;
            base *= 60;
        }
        total
    } else {
        // arbitrary size: the digits are the number
        let digits = unsigned.trim_start_matches('0');
        if !unsigned.chars().all(|c| c.is_ascii_digit()) {
            return Err(crash());
        }
        let digits = if digits.is_empty() { "0" } else { digits };
        return Ok(Yaml::Int(if negative && digits != "0" { format!("-{digits}") } else { digits.to_string() }));
    };
    Ok(Yaml::Int((if negative { -magnitude } else { magnitude }).to_string()))
}

/// `SafeConstructor.construct_yaml_float`.
fn construct_float(text: &str) -> Result<Yaml, Failure> {
    let crash = || Failure::Crash(format!("ValueError: could not convert string to float: {text:?}"));
    let value: String = text.chars().filter(|&c| c != '_').collect::<String>().to_lowercase();
    let (sign, unsigned) = match value.strip_prefix('-') {
        Some(rest) => (-1.0, rest.to_string()),
        None => (1.0, value.strip_prefix('+').unwrap_or(&value).to_string()),
    };
    if unsigned == ".inf" {
        return Ok(Yaml::Float(sign * f64::INFINITY));
    }
    if unsigned == ".nan" {
        return Ok(Yaml::Float(f64::NAN));
    }
    if unsigned.contains(':') {
        let mut total = 0.0;
        let mut base = 1.0;
        for part in unsigned.split(':').rev() {
            total += part.parse::<f64>().map_err(|_| crash())? * base;
            base *= 60.0;
        }
        return Ok(Yaml::Float(sign * total));
    }
    Ok(Yaml::Float(sign * unsigned.parse::<f64>().map_err(|_| crash())?))
}

/// `SafeConstructor.construct_yaml_timestamp`: the date and time must exist (`datetime.date(...)` raises otherwise).
fn construct_timestamp(text: &str) -> Result<Yaml, Failure> {
    let crash = || Failure::Crash(format!("ValueError: bad timestamp {text:?}"));
    let num = |s: &str| s.parse::<u32>().map_err(|_| crash());
    let mut parts = text.splitn(3, '-');
    let (year, month, rest) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let day_text: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let (year, month, day) = (num(year)?, num(month)?, num(&day_text)?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28 + u32::from(leap),
        _ => return Err(crash()),
    };
    if year == 0 || day == 0 || day > days {
        return Err(crash());
    }
    let tail = &rest[day_text.len().min(rest.len())..];
    let time = tail.trim_start_matches(['T', 't', ' ', '\t']);
    if !time.is_empty() {
        let mut t = time.splitn(3, ':');
        let hour = num(t.next().unwrap_or(""))?;
        let minute = num(t.next().unwrap_or(""))?;
        let second: String = t.next().unwrap_or("").chars().take_while(char::is_ascii_digit).collect();
        if hour > 23 || minute > 59 || num(&second)? > 59 {
            return Err(crash());
        }
    }
    Ok(Yaml::Other("timestamp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_ok(text: &str) -> Yaml {
        safe_load(text).expect("loads").expect("a document")
    }

    #[test]
    fn plain_scalars_are_typed_as_pyyaml_types_them() {
        let one = |t: &str| load_ok(&format!("k: {t}")).get("k").cloned().expect("a value");
        for (text, want) in [
            ("yes", Yaml::Bool(true)),
            ("Off", Yaml::Bool(false)),
            ("yEs", Yaml::Str("yEs".into())),
            ("~", Yaml::Null),
            ("0777", Yaml::Int("511".into())),
            ("0x1F", Yaml::Int("31".into())),
            ("1_000", Yaml::Int("1000".into())),
            ("1:30", Yaml::Int("90".into())),
            ("08", Yaml::Str("08".into())),
            ("1e3", Yaml::Str("1e3".into())),
            ("1.5", Yaml::Float(1.5)),
            ("'yes'", Yaml::Str("yes".into())),
            ("2024-01-02", Yaml::Other("timestamp")),
            ("!!str 5", Yaml::Str("5".into())),
        ] {
            assert_eq!(one(text), want, "{text}");
        }
        assert!(matches!(one(".inf"), Yaml::Float(f) if f.is_infinite()));
        assert_eq!(load_ok("k:").get("k"), Some(&Yaml::Null));
    }

    #[test]
    fn mappings_merge_and_later_keys_win() {
        let doc = load_ok("base: &b {x: 1, y: 1}\nd:\n  <<: *b\n  y: 2\nt: a\nt: b");
        assert_eq!(doc.get("t"), Some(&Yaml::Str("b".into())));
        assert_eq!(doc.get("d").and_then(|d| d.get("x")), Some(&Yaml::Int("1".into())));
        assert_eq!(doc.get("d").and_then(|d| d.get("y")), Some(&Yaml::Int("2".into())));
        // 1, 1.0 and true are one key in Python
        assert_eq!(load_ok("1: a\n1.0: b\ntrue: c"), Yaml::Map(vec![(Yaml::Int("1".into()), Yaml::Str("c".into()))]));
    }

    #[test]
    fn what_python_refuses_is_refused() {
        assert!(matches!(safe_load("a: [1,\n  2"), Err(Failure::Yaml(Some(2), ..))));
        assert!(matches!(safe_load("a:\n\tb: 1"), Err(Failure::Yaml(Some(2), ..))));
        assert!(matches!(safe_load("a: &x 1\nb: &x 2"), Err(Failure::Yaml(Some(2), ..))));
        assert!(matches!(safe_load("a: \u{7}"), Err(Failure::Yaml(None, ..))));
        assert!(matches!(safe_load("a: !!python/object:os.system x"), Err(Failure::Yaml(..))));
        assert!(matches!(safe_load("a: 0x_"), Err(Failure::Crash(_))));
        assert_eq!(safe_load("# only a comment"), Ok(None));
    }
}
