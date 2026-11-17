//! HTML found in Markdown, read as the editor reads it (format 1, `fixtures/README.md` "Inline and block HTML").
//!
//! HTML whose tags are all in [`KEPT_HTML`] is read as formatting (the browser's HTML parser and ProseMirror's
//! parse rules in the UI; a small parser here); any other tag makes the whole fragment literal text.

use serde_json::{Map, Value, json};

use crate::chars::is_space;

/// The tags read as formatting; any other tag keeps the HTML as typed (`KEPT_HTML` in the UI).
pub const KEPT_HTML: &[&str] =
    &["a", "b", "strong", "i", "em", "u", "s", "del", "strike", "sup", "sub", "code", "mark", "br"];

/// Returns whether the HTML holds a tag outside [`KEPT_HTML`] (`<\/?\s*([A-Za-z][\w-]*)`).
pub fn is_unrecognized(html: &str) -> bool {
    let c: Vec<char> = html.chars().collect();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '<' {
            let mut j = i + 1;
            if c.get(j) == Some(&'/') {
                j += 1;
            }
            while j < c.len() && is_space(c[j]) {
                j += 1;
            }
            if c.get(j).is_some_and(char::is_ascii_alphabetic) {
                let st = j;
                while j < c.len() && (crate::chars::is_word(c[j]) || c[j] == '-') {
                    j += 1;
                }
                let name: String = c[st..j].iter().collect::<String>().to_ascii_lowercase();
                if !KEPT_HTML.contains(&name.as_str()) {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

/// `htmlAsLiteralText`: the HTML as text, trailing white space removed (`None` when nothing is left).
pub fn literal(html: &str) -> Option<String> {
    let t = crate::chars::trim_end(html);
    (!t.is_empty()).then(|| t.to_string())
}

#[derive(Clone)]
struct Open {
    name: String,
    mark: Option<Value>,
}

/// The mark an element gives, if any.
fn element_mark(name: &str, attrs: &[(String, String)]) -> Option<Value> {
    let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    Some(match name {
        "b" | "strong" => json!({"type": "bold"}),
        "i" | "em" => json!({"type": "italic"}),
        "u" => json!({"type": "underline"}),
        "s" | "del" | "strike" => json!({"type": "strike"}),
        "sup" => json!({"type": "superscript"}),
        "sub" => json!({"type": "subscript"}),
        "code" => json!({"type": "code"}),
        "mark" => match get("data-color") {
            Some(c) => json!({"type": "highlight", "attrs": {"color": c}}),
            None => json!({"type": "highlight"}),
        },
        "a" => {
            let href = get("href")?;
            if !allowed_uri(&href) {
                return None;
            }
            let mut attrs = Map::new();
            attrs.insert("href".into(), Value::String(href));
            attrs.insert("title".into(), get("title").map_or(Value::Null, Value::String));
            json!({"type": "link", "attrs": attrs})
        }
        _ => return None,
    })
}

/// The link mark's URI check: relative URIs and the usual protocols.
fn allowed_uri(href: &str) -> bool {
    let t: String = href.chars().filter(|c| !c.is_whitespace() && (*c as u32) > 0x20).collect();
    let lower = t.to_ascii_lowercase();
    let scheme_len = lower.bytes().take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')).count();
    if scheme_len > 0 && lower.as_bytes().get(scheme_len) == Some(&b':') && lower.as_bytes()[0].is_ascii_alphabetic() {
        let scheme = &lower[..scheme_len];
        return ["http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp"].contains(&scheme);
    }
    true
}

/// Whether mark `a` excludes mark `b` (ProseMirror `excludes`: code excludes all, sup and sub each other, a mark
/// its own type).
fn excludes(a: &str, b: &str) -> bool {
    a == b || a == "code" || (a == "superscript" && b == "subscript") || (a == "subscript" && b == "superscript")
}

/// ProseMirror's `Mark.addToSet` (rank order is restored later).
fn add_to_set(set: &[Value], mark: &Value) -> Vec<Value> {
    let t = mark["type"].as_str().unwrap_or("");
    let mut out = Vec::new();
    for other in set {
        if other == mark {
            return set.to_vec();
        }
        let ot = other["type"].as_str().unwrap_or("");
        if excludes(t, ot) {
            continue;
        }
        if excludes(ot, t) {
            return set.to_vec();
        }
        out.push(other.clone());
    }
    out.push(mark.clone());
    out
}

/// Decodes the HTML character references the browser would.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] == '&' {
            if let Some((len, rep)) = entity_at(&c[i..]) {
                out.push_str(&rep);
                i += len;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn entity_at(c: &[char]) -> Option<(usize, String)> {
    let end = c.iter().take(40).position(|x| *x == ';')?;
    let body: String = c[1..end].iter().collect();
    if let Some(num) = body.strip_prefix('#') {
        let v = if let Some(h) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(h, 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        let ch = char::from_u32(v).filter(|_| v != 0).unwrap_or('\u{fffd}');
        return Some((end + 1, ch.to_string()));
    }
    let rep = match body.as_str() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "laquo" => "«",
        "raquo" => "»",
        "middot" => "·",
        "bull" => "•",
        "times" => "×",
        "divide" => "÷",
        "deg" => "°",
        "euro" => "€",
        "pound" => "£",
        "yen" => "¥",
        "cent" => "¢",
        "sect" => "§",
        "para" => "¶",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        _ => return None,
    };
    Some((end + 1, rep.to_string()))
}

/// Reads an HTML fragment whose tags are all kept: text nodes with marks and hard breaks.
pub fn parse_inline(html: &str) -> Vec<Value> {
    let c: Vec<char> = html.chars().collect();
    let mut stack: Vec<Open> = Vec::new();
    // pending runs: (text, marks) or hard break (None)
    let mut items: Vec<(Option<String>, Vec<Value>)> = Vec::new();
    let mut text = String::new();
    let mut after_br = false;
    let marks_of = |stack: &[Open]| -> Vec<Value> {
        let mut set: Vec<Value> = Vec::new();
        for o in stack {
            if let Some(m) = &o.mark {
                set = add_to_set(&set, m);
            }
        }
        set
    };
    let flush =
        |text: &mut String, stack: &[Open], items: &mut Vec<(Option<String>, Vec<Value>)>, after_br: &mut bool| {
            if text.is_empty() {
                return;
            }
            let raw = decode_entities(text);
            text.clear();
            let mut v = String::with_capacity(raw.len());
            let mut ws = false;
            for ch in raw.chars() {
                if matches!(ch, ' ' | '\t' | '\r' | '\n' | '\u{0c}') {
                    if !ws {
                        v.push(' ');
                    }
                    ws = true;
                } else {
                    v.push(ch);
                    ws = false;
                }
            }
            if v.starts_with(' ') {
                let before_space = match items.last() {
                    None => true,
                    Some((Some(t), _)) => t.ends_with(' '),
                    Some((None, _)) => true,
                };
                if before_space || *after_br {
                    v.remove(0);
                }
            }
            *after_br = false;
            if !v.is_empty() {
                items.push((Some(v), marks_of(stack)));
            }
        };
    let mut i = 0;
    while i < c.len() {
        if c[i] == '<' {
            if let Some((len, tag)) = read_tag(&c[i..]) {
                flush(&mut text, &stack, &mut items, &mut after_br);
                match tag {
                    Tag::Open { name, attrs, self_closing } => {
                        if name == "br" {
                            items.push((None, marks_of(&stack)));
                            after_br = true;
                        } else if !self_closing {
                            let mark = element_mark(&name, &attrs);
                            stack.push(Open { name, mark });
                        }
                    }
                    Tag::Close { name } => {
                        if let Some(pos) = stack.iter().rposition(|o| o.name == name) {
                            stack.truncate(pos);
                        }
                    }
                    Tag::Other => {}
                }
                i += len;
                continue;
            }
        }
        text.push(c[i]);
        i += 1;
    }
    flush(&mut text, &stack, &mut items, &mut after_br);
    // trailing white space of the block is dropped
    while let Some((Some(t), _)) = items.last_mut() {
        let trimmed = t.trim_end_matches([' ', '\t', '\r', '\n', '\u{0c}']).to_string();
        if trimmed.is_empty() {
            items.pop();
            continue;
        }
        *t = trimmed;
        break;
    }
    items
        .into_iter()
        .map(|(t, marks)| {
            let mut node = Map::new();
            match t {
                Some(t) => {
                    node.insert("type".into(), "text".into());
                    node.insert("text".into(), Value::String(t));
                }
                None => {
                    node.insert("type".into(), "hardBreak".into());
                }
            }
            if !marks.is_empty() {
                node.insert("marks".into(), Value::Array(marks));
            }
            Value::Object(node)
        })
        .collect()
}

enum Tag {
    Open { name: String, attrs: Vec<(String, String)>, self_closing: bool },
    Close { name: String },
    Other,
}

/// One tag at the start of `c`: (length, tag).
fn read_tag(c: &[char]) -> Option<(usize, Tag)> {
    let get = |k: usize| c.get(k).copied();
    if get(1) == Some('!') || get(1) == Some('?') {
        // comment, declaration or processing instruction
        let comment = get(2) == Some('-') && get(3) == Some('-');
        let mut k = 2;
        while k < c.len() {
            if comment {
                if c[k] == '>' && k >= 4 && c[k - 1] == '-' && c[k - 2] == '-' {
                    return Some((k + 1, Tag::Other));
                }
            } else if c[k] == '>' {
                return Some((k + 1, Tag::Other));
            }
            k += 1;
        }
        return Some((c.len(), Tag::Other));
    }
    let closing = get(1) == Some('/');
    let mut k = if closing { 2 } else { 1 };
    if !get(k).is_some_and(|x| x.is_ascii_alphabetic()) {
        return None;
    }
    let st = k;
    while k < c.len() && !is_space(c[k]) && c[k] != '/' && c[k] != '>' {
        k += 1;
    }
    let name: String = c[st..k].iter().collect::<String>().to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut self_closing = false;
    loop {
        while k < c.len() && is_space(c[k]) {
            k += 1;
        }
        match get(k) {
            None => return Some((c.len(), Tag::Other)),
            Some('>') => {
                k += 1;
                break;
            }
            Some('/') => {
                self_closing = get(k + 1) == Some('>');
                k += 1;
                continue;
            }
            Some(_) => {
                let an = k;
                while k < c.len() && !is_space(c[k]) && !matches!(c[k], '=' | '>' | '/') {
                    k += 1;
                }
                let aname: String = c[an..k].iter().collect::<String>().to_ascii_lowercase();
                let mut j = k;
                while j < c.len() && is_space(c[j]) {
                    j += 1;
                }
                let mut value = String::new();
                if get(j) == Some('=') {
                    j += 1;
                    while j < c.len() && is_space(c[j]) {
                        j += 1;
                    }
                    match get(j) {
                        Some(q @ ('"' | '\'')) => {
                            let e = c[j + 1..].iter().position(|x| *x == q).map_or(c.len(), |e| j + 1 + e);
                            value = c[j + 1..e].iter().collect();
                            j = (e + 1).min(c.len());
                        }
                        _ => {
                            let s = j;
                            while j < c.len() && !is_space(c[j]) && c[j] != '>' {
                                j += 1;
                            }
                            value = c[s..j].iter().collect();
                        }
                    }
                    k = j;
                }
                if !aname.is_empty() {
                    attrs.push((aname, decode_entities(&value)));
                }
            }
        }
    }
    if closing {
        return Some((k, Tag::Close { name }));
    }
    Some((k, Tag::Open { name, attrs, self_closing }))
}
