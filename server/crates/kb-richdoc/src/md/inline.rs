//! The inline lexer: a port of marked 17's inline tokenizer (GFM) with the inline tokenizers the Docs editor
//! registers (ticket key, inline math, page reference, highlight).
//!
//! The source is handled as characters, as marked handles a string; lookups that marked repeats on every step
//! (where the next extension token could start, e-mail look-aheads) are computed once per call so a long line stays
//! linear. Nesting deeper than [`MAX_INLINE_DEPTH`] is read as text.

use std::collections::HashMap;

use super::token::{ITok, Inline};
use crate::chars::{is_alnum, is_punct, is_space, is_word};

/// How deep emphasis, links and highlights may nest before the rest is read as text.
pub const MAX_INLINE_DEPTH: usize = 24;

/// How many steps the search for an emphasis or strikethrough closer may take (each step passes a run of text or a
/// run of delimiters).
const MAX_DELIM_SCAN: usize = 1000;

/// Stands for a lone UTF-16 surrogate (U+FFFE is not punctuation, space, letter or number either).
const LONE_SURROGATE: char = '\u{fffe}';

/// Characters of the GFM e-mail look-ahead (`[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]`).
fn is_email_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || ".!#$%&'*+/=?_`{|}~-".contains(c)
}

/// `[\p{P}\p{S}]` without `~` (the GFM emphasis classes).
fn punct_gfm(c: char) -> bool {
    c != '~' && is_punct(c)
}

fn s(c: &[char]) -> String {
    c.iter().collect()
}

/// The inline lexer state of one document.
pub struct InlineLexer<'a> {
    links: &'a HashMap<String, (String, Option<String>, usize)>,
    in_link: bool,
    /// Only the link definitions read before this many are known (the editor's early tokenizers).
    pub max_defs: usize,
    depth: usize,
    /// Reads the annotated flavour's spans and page-reference attributes.
    pub annotated: bool,
    /// Broken spans found (annotated flavour).
    pub errors: Vec<String>,
}

/// Per-call tables over the source.
struct Tables {
    /// End of the run of spaces starting at each position.
    sp_end: Vec<usize>,
    /// End of the run of e-mail characters starting at each position.
    em_end: Vec<usize>,
    /// Next position of `==`, `[[`, `$`, a ticket key (with its look-behind), at or after each position.
    next_eq: Vec<usize>,
    next_dbl: Vec<usize>,
    next_dollar: Vec<usize>,
    next_ticket: Vec<usize>,
    /// Whether a ticket key starts at each position (look-behind not checked).
    ticket_at: Vec<bool>,
    /// End of the run of link-destination characters (`[^ \t\n\x00-\x1f]`) starting at each position.
    href_end: Vec<usize>,
    /// The last `)` before each position (`usize::MAX` for none).
    last_paren: Vec<usize>,
    /// The next `]`, `|`, `#` or line break at or after each position (page part of a reference).
    next_page_stop: Vec<usize>,
    /// The next `]`, `|` or line break (section part).
    next_section_stop: Vec<usize>,
    /// The next `]` or line break (label part).
    next_label_stop: Vec<usize>,
    /// Starts of the maximal backtick runs, by run length.
    tick_runs: HashMap<usize, Vec<usize>>,
}

impl Tables {
    fn new(c: &[char]) -> Self {
        let n = c.len();
        let mut sp_end = vec![n; n + 1];
        let mut em_end = vec![n; n + 1];
        let mut next_eq = vec![usize::MAX; n + 2];
        let mut next_dbl = vec![usize::MAX; n + 2];
        let mut next_dollar = vec![usize::MAX; n + 2];
        let mut next_ticket = vec![usize::MAX; n + 2];
        let mut ticket_at = vec![false; n + 1];
        // digit runs, for ticket keys
        let mut digit_end = vec![n; n + 1];
        for i in (0..n).rev() {
            sp_end[i] = if c[i] == ' ' { sp_end[i + 1] } else { i };
            em_end[i] = if is_email_char(c[i]) { em_end[i + 1] } else { i };
            digit_end[i] = if c[i].is_ascii_digit() { digit_end[i + 1] } else { i };
        }
        for i in (0..n).rev() {
            next_eq[i] = if c[i] == '=' && c.get(i + 1) == Some(&'=') { i } else { next_eq[i + 1] };
            next_dbl[i] = if c[i] == '[' && c.get(i + 1) == Some(&'[') { i } else { next_dbl[i + 1] };
            next_dollar[i] = if c[i] == '$' { i } else { next_dollar[i + 1] };
            ticket_at[i] = ticket_len(c, i, &digit_end).is_some();
            let lb_ok = i == 0 || !(is_word(c[i - 1]) || c[i - 1] == '-' || c[i - 1] == '/');
            next_ticket[i] = if ticket_at[i] && lb_ok { i } else { next_ticket[i + 1] };
        }
        let mut href_end = vec![n; n + 1];
        let mut next_page_stop = vec![n; n + 1];
        let mut next_section_stop = vec![n; n + 1];
        let mut next_label_stop = vec![n; n + 1];
        for i in (0..n).rev() {
            let x = c[i];
            href_end[i] = if !matches!(x, ' ' | '\t' | '\n') && (x as u32) >= 0x20 { href_end[i + 1] } else { i };
            next_page_stop[i] = if matches!(x, ']' | '|' | '#' | '\n') { i } else { next_page_stop[i + 1] };
            next_section_stop[i] = if matches!(x, ']' | '|' | '\n') { i } else { next_section_stop[i + 1] };
            next_label_stop[i] = if matches!(x, ']' | '\n') { i } else { next_label_stop[i + 1] };
        }
        let mut last_paren = vec![usize::MAX; n + 1];
        for i in 1..=n {
            last_paren[i] = if c[i - 1] == ')' { i - 1 } else { last_paren[i - 1] };
        }
        let mut tick_runs: HashMap<usize, Vec<usize>> = HashMap::new();
        let mut i = 0;
        while i < n {
            if c[i] == '`' {
                let st = i;
                while i < n && c[i] == '`' {
                    i += 1;
                }
                tick_runs.entry(i - st).or_default().push(st);
            } else {
                i += 1;
            }
        }
        Tables {
            sp_end,
            em_end,
            next_eq,
            next_dbl,
            next_dollar,
            next_ticket,
            ticket_at,
            href_end,
            last_paren,
            next_page_stop,
            next_section_stop,
            next_label_stop,
            tick_runs,
        }
    }

    /// `(?= {2,}\n)` at `i`.
    fn spaces_nl(&self, c: &[char], i: usize, end: usize) -> bool {
        let e = self.sp_end[i];
        e >= i + 2 && e < end && c[e] == '\n'
    }

    /// `(?=[email chars]+@)` at `i`.
    fn email_ahead(&self, c: &[char], i: usize, end: usize) -> bool {
        let e = self.em_end[i];
        e > i && e < end && c[e] == '@'
    }
}

/// `[A-Z][A-Z0-9]{1,5}-\d+\b` at `i`: its length.
fn ticket_len(c: &[char], i: usize, digit_end: &[usize]) -> Option<usize> {
    if !c.get(i).is_some_and(|x| x.is_ascii_uppercase()) {
        return None;
    }
    let mut j = i + 1;
    while j < c.len() && j - i <= 6 && (c[j].is_ascii_uppercase() || c[j].is_ascii_digit()) {
        j += 1;
    }
    let run = j - i - 1;
    if !(1..=5).contains(&run) || c.get(j) != Some(&'-') {
        return None;
    }
    let d = digit_end[j + 1];
    if d == j + 1 {
        return None;
    }
    if d < c.len() && is_word(c[d]) {
        return None;
    }
    Some(d - i)
}

impl<'a> InlineLexer<'a> {
    /// A lexer using the document's link definitions.
    pub fn new(links: &'a HashMap<String, (String, Option<String>, usize)>) -> Self {
        InlineLexer { links, in_link: false, max_defs: usize::MAX, depth: 0, annotated: false, errors: Vec::new() }
    }

    /// Tokenizes inline Markdown (marked's `inlineTokens`).
    pub fn tokens(&mut self, src: &str) -> Vec<ITok> {
        let c: Vec<char> = src.chars().collect();
        if self.depth >= MAX_INLINE_DEPTH {
            return if c.is_empty() {
                Vec::new()
            } else {
                vec![ITok { raw: src.to_string(), kind: Inline::Text(src.to_string()) }]
            };
        }
        self.depth += 1;
        let out = self.tokens_chars(&c);
        self.depth -= 1;
        out
    }

    fn tokens_chars(&mut self, c: &[char]) -> Vec<ITok> {
        let n = c.len();
        let masked = mask(c);
        let t = Tables::new(c);
        let mut tokens: Vec<ITok> = Vec::new();
        let mut p = 0;
        let mut keep_prev = false;
        let mut prev: Option<char> = None;
        while p < n {
            if !keep_prev {
                prev = None;
            }
            keep_prev = false;
            // a page reference goes first: `[[P]]{page-id=…}` is not a span
            let doc_ref_here = c[p] == '[' && c.get(p + 1) == Some(&'[') && doc_ref(c, p, &t).is_some();
            if self.annotated && c[p] == '[' && !doc_ref_here {
                if let Some((len, marks, inner)) = self.span(c, p) {
                    let toks = self.tokens(&inner);
                    tokens.push(ITok { raw: s(&c[p..p + len]), kind: Inline::Span { marks, tokens: toks } });
                    p += len;
                    continue;
                }
            }
            if let Some((len, kind)) = self.extension(c, p, &t) {
                tokens.push(ITok { raw: s(&c[p..p + len]), kind });
                p += len;
                continue;
            }
            // escape
            if c[p] == '\\' && c.get(p + 1).is_some_and(|x| x.is_ascii_punctuation()) {
                tokens.push(ITok { raw: s(&c[p..p + 2]), kind: Inline::Escape(c[p + 1].to_string()) });
                p += 2;
                continue;
            }
            if let Some(len) = inline_tag(c, p) {
                let raw = s(&c[p..p + len]);
                let lower = raw.to_ascii_lowercase();
                if !self.in_link && lower.starts_with("<a ") {
                    self.in_link = true;
                } else if self.in_link && lower.starts_with("</a>") {
                    self.in_link = false;
                }
                tokens.push(ITok { raw, kind: Inline::Html });
                p += len;
                continue;
            }
            if let Some((len, tok)) = self.link(c, p, &t) {
                tokens.push(ITok { raw: s(&c[p..p + len]), kind: tok });
                p += len;
                continue;
            }
            if let Some((len, tok)) = self.reflink(c, p) {
                let raw = s(&c[p..p + len]);
                if let Inline::Text(txt) = &tok {
                    if let Some(ITok { raw: lr, kind: Inline::Text(lt) }) = tokens.last_mut() {
                        lr.push_str(&raw);
                        lt.push_str(txt);
                        p += len;
                        continue;
                    }
                }
                tokens.push(ITok { raw, kind: tok });
                p += len;
                continue;
            }
            if let Some((len, tok)) = self.em_strong(c, &masked, p, prev) {
                tokens.push(ITok { raw: s(&c[p..p + len]), kind: tok });
                p += len;
                continue;
            }
            if let Some((len, text)) = codespan(c, p, &t) {
                tokens.push(ITok { raw: s(&c[p..p + len]), kind: Inline::Codespan(text) });
                p += len;
                continue;
            }
            if let Some(len) = br(c, p) {
                tokens.push(ITok { raw: s(&c[p..p + len]), kind: Inline::Br });
                p += len;
                continue;
            }
            if let Some((len, tok)) = self.del(c, &masked, p, prev) {
                tokens.push(ITok { raw: s(&c[p..p + len]), kind: tok });
                p += len;
                continue;
            }
            if let Some((len, text, href)) = autolink(c, p) {
                tokens.push(ITok {
                    raw: s(&c[p..p + len]),
                    kind: Inline::Link {
                        href,
                        title: None,
                        tokens: vec![ITok { raw: text.clone(), kind: Inline::Text(text) }],
                    },
                });
                p += len;
                continue;
            }
            if !self.in_link {
                if let Some((len, text, href)) = url(c, p) {
                    tokens.push(ITok {
                        raw: s(&c[p..p + len]),
                        kind: Inline::Link {
                            href,
                            title: None,
                            tokens: vec![ITok { raw: text.clone(), kind: Inline::Text(text) }],
                        },
                    });
                    p += len;
                    continue;
                }
            }
            // text, clipped where an extension token could start
            let end = self.start_inline(c, p, &t).unwrap_or(n);
            let len = inline_text(c, p, end, &t);
            let raw = s(&c[p..p + len]);
            if c[p + len - 1] != '_' {
                // marked keeps the last UTF-16 unit: half of a character outside the BMP, which is neither
                // punctuation, space nor alphanumeric
                let last = c[p + len - 1];
                prev = Some(if last.len_utf16() == 2 { LONE_SURROGATE } else { last });
            }
            keep_prev = true;
            if let Some(ITok { raw: lr, kind: Inline::Text(lt) }) = tokens.last_mut() {
                lr.push_str(&raw);
                lt.push_str(&raw);
            } else {
                tokens.push(ITok { raw: raw.clone(), kind: Inline::Text(raw) });
            }
            p += len;
        }
        tokens
    }

    /// The start functions of the inline extensions on `src.slice(1)`: the end of the clipped text.
    fn start_inline(&self, c: &[char], p: usize, t: &Tables) -> Option<usize> {
        let s1 = p + 1;
        if s1 > c.len() {
            return None;
        }
        let mut best = usize::MAX;
        best = best.min(t.next_eq[s1]).min(t.next_dbl[s1]).min(t.next_dollar[s1]);
        if s1 < c.len() && t.ticket_at[s1] {
            best = best.min(s1);
        } else {
            best = best.min(t.next_ticket[(s1 + 1).min(c.len())]);
        }
        (best != usize::MAX).then_some(best)
    }

    /// The editor's inline tokenizers, in the order marked tries them.
    fn extension(&mut self, c: &[char], p: usize, t: &Tables) -> Option<(usize, Inline)> {
        // ticketRef: ^[A-Z][A-Z0-9]{1,5}-\d+\b(?!-)
        if c[p].is_ascii_uppercase() {
            let mut digit_end = p;
            let mut j = p + 1;
            while j < c.len() && j - p <= 6 && (c[j].is_ascii_uppercase() || c[j].is_ascii_digit()) {
                j += 1;
            }
            if (1..=5).contains(&(j - p - 1)) && c.get(j) == Some(&'-') {
                digit_end = j + 1;
                while digit_end < c.len() && c[digit_end].is_ascii_digit() {
                    digit_end += 1;
                }
            }
            if digit_end > j + 1 && !c.get(digit_end).is_some_and(|x| is_word(*x)) && c.get(digit_end) != Some(&'-') {
                let key = s(&c[p..digit_end]);
                return Some((digit_end - p, Inline::TicketRef(key)));
            }
        }
        // mathInline: ^\$(?!\s|\$)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)
        if c[p] == '$' {
            if let Some(r) = math_inline(c, p) {
                return Some(r);
            }
        }
        // docRef: ^\[\[([^\]|#\n]+?)(?:#([^\]|\n]+?))?(?:\|([^\]\n]+?))?\]\]
        if c[p] == '[' && c.get(p + 1) == Some(&'[') {
            if let Some((len, mut tok)) = doc_ref(c, p, t) {
                let mut len = len;
                if self.annotated && c.get(p + len) == Some(&'{') {
                    if let Some((extra, pairs)) = spec_at(c, p + len) {
                        if let Inline::DocRef { page_id, target, target_label, .. } = &mut tok {
                            for (k, v) in pairs {
                                match k.as_str() {
                                    "page-id" | "pageId" => *page_id = Some(v),
                                    "target" | "targetBlockId" => *target = Some(v),
                                    "target-label" | "targetLabel" => *target_label = Some(v),
                                    _ => self.errors.push(format!("unknown page reference attribute {k}")),
                                }
                            }
                        }
                        len += extra;
                    }
                }
                return Some((len, tok));
            }
        }
        // highlight: ^(==)([^=]+)(==)
        if c[p] == '=' && c.get(p + 1) == Some(&'=') {
            let mut j = p + 2;
            while j < c.len() && c[j] != '=' {
                j += 1;
            }
            if j > p + 2 && c.get(j) == Some(&'=') && c.get(j + 1) == Some(&'=') {
                let inner: String = s(&c[p + 2..j]);
                let inner = crate::chars::trim(&inner).to_string();
                let toks = self.tokens(&inner);
                return Some((j + 2 - p, Inline::Highlight(toks)));
            }
        }
        None
    }

    /// An annotated span at `p`: (length, marks, inner text).
    fn span(&mut self, c: &[char], p: usize) -> Option<(usize, Vec<serde_json::Value>, String)> {
        let end = inline_label(c, p + 1)?;
        if c.get(end) != Some(&']') || c.get(end + 1) != Some(&'{') {
            return None;
        }
        let (len, items) = spec_items(c, end + 1)?;
        let mut marks = Vec::new();
        let mut style = serde_json::Map::new();
        for it in items {
            match it {
                SpecItem::Class(name) => match name.as_str() {
                    "underline" => marks.push(serde_json::json!({"type": "underline"})),
                    "sup" => marks.push(serde_json::json!({"type": "superscript"})),
                    "sub" => marks.push(serde_json::json!({"type": "subscript"})),
                    other => self.errors.push(format!("unknown span class .{other}")),
                },
                SpecItem::Pair(k, v) => match k.as_str() {
                    "color" => {
                        style.insert("color".into(), v.into());
                    }
                    "font" => {
                        let fonts = crate::schema::schema()
                            .marks
                            .get("textStyle")
                            .and_then(|m| m.get("fontFamily"))
                            .map(|a| a.ty.clone());
                        let ok = matches!(&fonts, Some(crate::schema::AttrType::Enum(vals)) if vals.iter().any(|x| x == &serde_json::Value::String(v.clone())));
                        if ok {
                            style.insert("fontFamily".into(), v.into());
                        } else {
                            self.errors.push(format!("unknown font {v}"));
                        }
                    }
                    "size" => match v.parse::<f64>() {
                        Ok(n) if n.is_finite() => {
                            let num = if n.fract() == 0.0 && n.abs() < 1e15 {
                                serde_json::Value::from(n as i64)
                            } else {
                                serde_json::Number::from_f64(n)
                                    .map_or(serde_json::Value::Null, serde_json::Value::Number)
                            };
                            style.insert("fontSize".into(), num);
                        }
                        _ => self.errors.push(format!("size={v} is not a number")),
                    },
                    "highlight" => marks.push(serde_json::json!({"type": "highlight", "attrs": {"color": v}})),
                    other => self.errors.push(format!("unknown span attribute {other}")),
                },
            }
        }
        if !style.is_empty() {
            marks.push(serde_json::json!({"type": "textStyle", "attrs": style}));
        }
        Some((end + 1 + len - p, marks, s(&c[p + 1..end])))
    }

    /// marked's `link` rule (and images).
    fn link(&mut self, c: &[char], p: usize, t: &Tables) -> Option<(usize, Inline)> {
        let image = c[p] == '!';
        let lb = if image { p + 1 } else { p };
        if c.get(lb) != Some(&'[') {
            return None;
        }
        let label_end = inline_label(c, lb + 1)?;
        if c.get(label_end) != Some(&']') || c.get(label_end + 1) != Some(&'(') {
            return None;
        }
        let label = &c[lb + 1..label_end];
        let (end, href_raw, title_raw) = link_dest(c, label_end + 2, t)?;
        let mut cap0_end = end;
        let mut href_cap: Vec<char> = href_raw.to_vec();
        let mut title_cap: Option<Vec<char>> = title_raw.map(<[char]>::to_vec);
        let trimmed_url = crate::chars::trim(&s(&href_cap)).to_string();
        if trimmed_url.starts_with('<') {
            if !trimmed_url.ends_with('>') {
                return None;
            }
            let inner = &trimmed_url[..trimmed_url.len() - 1];
            let back = inner.len() - inner.trim_end_matches('\\').len();
            if (back + 1).is_multiple_of(2) {
                return None;
            }
        } else {
            let last = find_closing_bracket(&href_cap);
            if last == -2 {
                return None;
            }
            if last > -1 {
                let start = if image { 5 } else { 4 };
                let link_len = start + label.len() + last as usize;
                href_cap.truncate(last as usize);
                // cap[0].substring(0, linkLen).trim()
                let mut e = p + link_len;
                while e > p && is_space(c[e - 1]) {
                    e -= 1;
                }
                cap0_end = e;
                title_cap = None;
            }
        }
        let mut href = crate::chars::trim(&s(&href_cap)).to_string();
        if href.starts_with('<') {
            href = js_slice(&href, 1, -1);
        }
        let title = title_cap.map(|t| {
            let t = s(&t);
            js_slice(&t, 1, -1)
        });
        let href = super::block::unescape_punct(&href);
        let title = title.filter(|t| !t.is_empty()).map(|t| super::block::unescape_punct(&t));
        let text = unescape_brackets(&s(label));
        let len = cap0_end - p;
        if image {
            return Some((len, Inline::Image { href, title, text }));
        }
        self.in_link = true;
        let tokens = self.tokens(&text);
        self.in_link = false;
        Some((len, Inline::Link { href, title, tokens }))
    }

    /// marked's `reflink` / `nolink` rules: a link to a definition, or the first character as text.
    fn reflink(&mut self, c: &[char], p: usize) -> Option<(usize, Inline)> {
        let image = c[p] == '!';
        let lb = if image { p + 1 } else { p };
        if c.get(lb) != Some(&'[') {
            return None;
        }
        // reflink: ^!?\[(label)\]\[(ref)\]
        let mut found: Option<(usize, Vec<char>, Vec<char>)> = None;
        if let Some(le) = inline_label(c, lb + 1) {
            if c.get(le) == Some(&']') && c.get(le + 1) == Some(&'[') {
                if let Some(re) = block_label(c, le + 2) {
                    if c.get(re) == Some(&']') {
                        found = Some((re + 1, c[lb + 1..le].to_vec(), c[le + 2..re].to_vec()));
                    }
                }
            }
        }
        if found.is_none() {
            // nolink: ^!?\[(ref)\](?:\[\])?
            if let Some(re) = block_label(c, lb + 1) {
                if c.get(re) == Some(&']') {
                    let mut end = re + 1;
                    if c.get(end) == Some(&'[') && c.get(end + 1) == Some(&']') {
                        end += 2;
                    }
                    let lab = c[lb + 1..re].to_vec();
                    found = Some((end, lab.clone(), lab));
                }
            }
        }
        let (end, label, reference) = found?;
        let key = crate::chars::collapse_spaces(&s(&reference)).to_lowercase();
        let found = self.links.get(&key).filter(|l| l.2 < self.max_defs).map(|l| (l.0.clone(), l.1.clone()));
        let Some((href, title)) = found else {
            return Some((1, Inline::Text(c[p].to_string())));
        };
        let text = unescape_brackets(&s(&label));
        let len = end - p;
        if image {
            return Some((len, Inline::Image { href, title, text }));
        }
        self.in_link = true;
        let tokens = self.tokens(&text);
        self.in_link = false;
        Some((len, Inline::Link { href, title, tokens }))
    }

    /// marked's `emStrong`.
    fn em_strong(&mut self, c: &[char], masked: &[char], p: usize, prev: Option<char>) -> Option<(usize, Inline)> {
        let d = c[p];
        if d != '*' && d != '_' {
            return None;
        }
        let mut j = p;
        while j < c.len() && c[j] == d {
            j += 1;
        }
        let next = c.get(j).copied();
        // groups: 1/3 punctuation after the run, 2/4 another non-space character
        let (punct_next, other_next) = match next {
            Some(x) if x != d && punct_gfm(x) => (Some(x), None),
            Some(x) if x != d && !is_space(x) => (None, Some(x)),
            _ => (None, None),
        };
        if punct_next.is_none() && other_next.is_none() {
            return None;
        }
        if d == '_' && other_next.is_some() && prev.is_some_and(is_alnum) {
            return None;
        }
        let prev_ok = match prev {
            None => true,
            Some(x) => x != '*' && x != '_' && (is_space(x) || is_punct(x)),
        };
        if !(punct_next.is_none() || prev.is_none() || prev_ok) {
            return None;
        }
        let l_len = j - p;
        let mut delim_total = l_len as isize;
        let mut mid_total: isize = 0;
        let ms = &masked[p + l_len..];
        let mut i = 0;
        let mut steps = 0;
        while i < ms.len() {
            // bounded: an emphasis whose closer lies further than this is read as text (marked would scan on,
            // which is quadratic on hostile input)
            steps += 1;
            if steps > MAX_DELIM_SCAN {
                return None;
            }
            let Some(m) = r_delim(ms, i, d) else {
                i += 1;
                continue;
            };
            i = m.end;
            let Some(kind) = m.group else { continue };
            let mut r_len = m.len as isize;
            if kind == 3 || kind == 4 {
                delim_total += r_len;
                continue;
            } else if (kind == 5 || kind == 6) && !l_len.is_multiple_of(3) && (l_len as isize + r_len) % 3 == 0 {
                mid_total += r_len;
                continue;
            }
            delim_total -= r_len;
            if delim_total > 0 {
                continue;
            }
            r_len = r_len.min(r_len + delim_total + mid_total);
            let raw_len = l_len + m.index + 1 + r_len.max(0) as usize;
            let raw_len = raw_len.min(c.len() - p);
            let raw = &c[p..p + raw_len];
            if (l_len.min(r_len.max(0) as usize)) % 2 == 1 {
                let text = s(&raw[1..raw.len().saturating_sub(1).max(1)]);
                let toks = self.tokens(&text);
                return Some((raw_len, Inline::Em(toks)));
            }
            let text = if raw.len() >= 4 { s(&raw[2..raw.len() - 2]) } else { String::new() };
            let toks = self.tokens(&text);
            return Some((raw_len, Inline::Strong(toks)));
        }
        None
    }

    /// marked's `del` (GFM strikethrough with `~` or `~~`).
    fn del(&mut self, c: &[char], masked: &[char], p: usize, prev: Option<char>) -> Option<(usize, Inline)> {
        if c[p] != '~' {
            return None;
        }
        // ^~~?(?:((?!~)punct)|[^\s~])
        let try_len = |l: usize| -> Option<(usize, bool)> {
            if (0..l).any(|k| c.get(p + k) != Some(&'~')) {
                return None;
            }
            let x = *c.get(p + l)?;
            if x != '~' && is_punct(x) {
                Some((l, true))
            } else if x != '~' && !is_space(x) {
                Some((l, false))
            } else {
                None
            }
        };
        let (l_len, punct_next) = try_len(2).or_else(|| try_len(1))?;
        let prev_ok = match prev {
            None => true,
            Some(x) => x != '*' && x != '_' && (is_space(x) || is_punct(x)),
        };
        if !(!punct_next || prev.is_none() || prev_ok) {
            return None;
        }
        let mut delim_total = l_len as isize;
        let ms = &masked[p + l_len..];
        let mut i = 0;
        let mut steps = 0;
        while i < ms.len() {
            steps += 1;
            if steps > MAX_DELIM_SCAN {
                return None;
            }
            let Some(m) = del_r_delim(ms, i) else {
                i += 1;
                continue;
            };
            i = m.end;
            let Some(kind) = m.group else { continue };
            let mut r_len = m.len as isize;
            if r_len != l_len as isize {
                continue;
            }
            if kind == 3 || kind == 4 {
                delim_total += r_len;
                continue;
            }
            delim_total -= r_len;
            if delim_total > 0 {
                continue;
            }
            r_len = r_len.min(r_len + delim_total);
            let raw_len = (l_len + m.index + 1 + r_len.max(0) as usize).min(c.len() - p);
            let raw = &c[p..p + raw_len];
            let text = if raw.len() >= 2 * l_len { s(&raw[l_len..raw.len() - l_len]) } else { String::new() };
            let toks = self.tokens(&text);
            return Some((raw_len, Inline::Del(toks)));
        }
        None
    }
}

/// One item of an annotated attribute list.
enum SpecItem {
    Class(String),
    Pair(String, String),
}

/// An attribute list `{.class key=value key="quoted value"}` at `p` (the `{`): its length and items. `None` when
/// it is not a well-formed list (then it is plain text).
fn spec_items(c: &[char], p: usize) -> Option<(usize, Vec<SpecItem>)> {
    let close = c[p..].iter().take(4096).position(|x| *x == '}' || *x == '\n')?;
    let inner: String = c[p + 1..p + close].iter().collect();
    if c[p + close] != '}' {
        // a quoted value may hold `}`: scan properly below
    }
    let mut items = Vec::new();
    let b: Vec<char> = c[p + 1..].to_vec();
    let mut i = 0;
    let _ = inner;
    loop {
        while i < b.len() && b[i] == ' ' {
            i += 1;
        }
        match b.get(i) {
            None | Some('\n') => return None,
            Some('}') => {
                i += 1;
                break;
            }
            Some('.') => {
                let st = i + 1;
                let mut j = st;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == '-') {
                    j += 1;
                }
                if j == st {
                    return None;
                }
                items.push(SpecItem::Class(b[st..j].iter().collect()));
                i = j;
            }
            Some(_) => {
                let st = i;
                let mut j = st;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == '-' || b[j] == '_') {
                    j += 1;
                }
                if j == st || b.get(j) != Some(&'=') {
                    return None;
                }
                let key: String = b[st..j].iter().collect();
                let (val, _quoted, next) = crate::annotated::read_value(&b, j + 1)?;
                items.push(SpecItem::Pair(key, val));
                i = next;
            }
        }
    }
    if items.is_empty() {
        return None;
    }
    Some((i + 1, items))
}

/// `{key=value …}` after a page reference: (length, pairs).
fn spec_at(c: &[char], p: usize) -> Option<(usize, Vec<(String, String)>)> {
    let (len, items) = spec_items(c, p)?;
    let mut out = Vec::new();
    for it in items {
        match it {
            SpecItem::Pair(k, v) => out.push((k, v)),
            SpecItem::Class(_) => return None,
        }
    }
    Some((len, out))
}

/// Whether the inline math tokenizer matches at `i` (a `$`).
pub fn math_at(c: &[char], i: usize) -> bool {
    c.get(i) == Some(&'$') && math_inline(c, i).is_some()
}

/// A right-delimiter match of marked's `emStrongRDelim*` / `delRDelim` scan.
struct RMatch {
    /// Where the match starts (the character before the run).
    index: usize,
    /// Where the scan goes on.
    end: usize,
    /// Which alternative captured the run (1–6), `None` for a skip.
    group: Option<u8>,
    /// The run's length.
    len: usize,
}

/// One step of the emphasis right-delimiter regex at `i` (`d` is `*` or `_`).
fn r_delim(m: &[char], i: usize, d: char) -> Option<RMatch> {
    let ast = d == '*';
    let other = if ast { '_' } else { '*' };
    // (0) only at the start: skip an orphan delimiter inside the other kind's strong
    if i == 0 {
        let excl = |x: char| x != '_' && x != '*';
        let mut j = 0;
        while j < m.len() && excl(m[j]) {
            j += 1;
        }
        if j + 1 < m.len() && m[j] == other && m[j + 1] == other {
            let mut k = j + 2;
            while k < m.len() && excl(m[k]) {
                k += 1;
            }
            if k < m.len() && m[k] == d {
                let mut q = k + 1;
                while q < m.len() && excl(m[q]) {
                    q += 1;
                }
                if q + 1 < m.len() && m[q] == other && m[q + 1] == other {
                    return Some(RMatch { index: 0, end: q, group: None, len: 0 });
                }
            }
        }
    }
    // (a) consume a run of other characters, leaving the last one
    if m[i] != d {
        let mut r = i;
        while r < m.len() && m[r] != d {
            r += 1;
        }
        if r - i >= 2 {
            return Some(RMatch { index: i, end: r - 1, group: None, len: 0 });
        }
    }
    let x = m[i];
    if x == d || m.get(i + 1) != Some(&d) {
        return None;
    }
    let mut j = i + 1;
    while j < m.len() && m[j] == d {
        j += 1;
    }
    let len = j - i - 1;
    let after = m.get(j).copied();
    let (punct, punct_space, not_punct_space): (fn(char) -> bool, fn(char) -> bool, fn(char) -> bool) = if ast {
        (punct_gfm, |c| is_space(c) || punct_gfm(c), |c| !(is_space(c) || is_punct(c)) || c == '~')
    } else {
        (is_punct, |c| is_space(c) || is_punct(c), |c| !(is_space(c) || is_punct(c)))
    };
    let mk = |g: u8| Some(RMatch { index: i, end: j, group: Some(g), len });
    // (1) #*** right only
    if x != d && punct(x) && after.is_none_or(is_space) {
        return mk(1);
    }
    // (2) a*** right only
    if not_punct_space(x) && after.is_none_or(punct_space) {
        return mk(2);
    }
    // (3) #***a left only
    if x != d && punct_space(x) && after.is_some_and(not_punct_space) {
        return mk(3);
    }
    // (4) ***# left only
    if is_space(x) && after.is_some_and(punct) {
        return mk(4);
    }
    // (5) #***# either
    if x != d && punct(x) && after.is_some_and(punct) {
        return mk(5);
    }
    // (6) a***a either (not for _)
    if ast && not_punct_space(x) && after.is_some_and(not_punct_space) {
        return mk(6);
    }
    None
}

/// One step of marked's `delRDelim` at `i`.
fn del_r_delim(m: &[char], i: usize) -> Option<RMatch> {
    // ^[^~]+(?=[^~]) only at the start
    if i == 0 && m[0] != '~' {
        let mut r = 0;
        while r < m.len() && m[r] != '~' {
            r += 1;
        }
        if r >= 2 {
            return Some(RMatch { index: 0, end: r - 1, group: None, len: 0 });
        }
    }
    let x = m[i];
    if x == '~' {
        return None;
    }
    let run_at = |t: usize| (1..=t).all(|k| m.get(i + k) == Some(&'~'));
    let after = |t: usize| m.get(i + 1 + t).copied();
    let not_tilde = |t: usize| after(t) != Some('~');
    let mk = |g: u8, t: usize| Some(RMatch { index: i, end: i + 1 + t, group: Some(g), len: t });
    // each alternative tries `~~` before `~`
    type Alt = fn(char, Option<char>, bool) -> bool;
    let alts: [(u8, Alt); 6] = [
        (1, |x, a, _| is_punct(x) && a.is_none_or(is_space)),
        (2, |x, a, nt| !(is_space(x) || is_punct(x)) && nt && a.is_none_or(|c| is_space(c) || is_punct(c))),
        (3, |x, a, _| (is_space(x) || is_punct(x)) && a.is_some_and(|c| !(is_space(c) || is_punct(c)))),
        (4, |x, a, nt| is_space(x) && nt && a.is_some_and(is_punct)),
        (5, |x, a, nt| is_punct(x) && nt && a.is_some_and(is_punct)),
        (6, |x, a, _| !(is_space(x) || is_punct(x)) && a.is_some_and(|c| !(is_space(c) || is_punct(c)))),
    ];
    for (g, alt) in alts {
        for t in [2usize, 1] {
            if run_at(t) && alt(x, after(t), not_tilde(t)) {
                return mk(g, t);
            }
        }
    }
    None
}

/// The masked source of `inlineTokens`: escaped punctuation, links, code spans and tags hidden from the emphasis
/// scan (same length).
fn mask(c: &[char]) -> Vec<char> {
    let mut m = c.to_vec();
    // anyPunctuation: \\(punct) → ++
    let mut i = 0;
    while i + 1 < m.len() {
        if m[i] == '\\' && is_punct(m[i + 1]) {
            m[i] = '+';
            m[i + 1] = '+';
            i += 2;
        } else {
            i += 1;
        }
    }
    // where a link destination that starts at each position ends (its `)`), computed once
    let n = m.len();
    let mut inner: Vec<Option<usize>> = vec![None; n + 2];
    let mut dest: Vec<Option<usize>> = vec![None; n + 2];
    for k in (0..n).rev() {
        inner[k] = match m[k] {
            ')' => Some(k),
            '(' => None,
            '\\' => {
                if k + 1 < n {
                    inner[k + 2]
                } else {
                    None
                }
            }
            _ => inner[k + 1],
        };
        dest[k] = match m[k] {
            ')' => Some(k + 1),
            '\\' => {
                if k + 1 < n {
                    dest[k + 2]
                } else {
                    None
                }
            }
            '(' => inner[k + 1].and_then(|q| dest[q + 1]),
            _ => dest[k + 1],
        };
    }
    // blockSkip: links, code spans, tags → [aaa]
    let mut i = 0;
    while i < m.len() {
        let len = skip_link(&m, i, &dest).or_else(|| skip_code(&m, i)).or_else(|| skip_tag(&m, i));
        match len {
            Some(l) if l >= 2 => {
                m[i] = '[';
                for x in &mut m[i + 1..i + l - 1] {
                    *x = 'a';
                }
                m[i + l - 1] = ']';
                i += l;
            }
            _ => i += 1,
        }
    }
    m
}

/// A code span item in a link label (`(?<a>`+)[^`]+\k<a>(?!`)`): its end.
fn code_item(m: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    while j < m.len() && m[j] == '`' {
        j += 1;
    }
    let n = j - i;
    if n == 0 {
        return None;
    }
    let mut k = j;
    while k < m.len() && m[k] != '`' {
        k += 1;
    }
    if k == j {
        return None;
    }
    let mut e = k;
    while e < m.len() && m[e] == '`' {
        e += 1;
    }
    (e - k == n).then_some(e)
}

/// blockSkip's link: `\[(?:[^\[\]`]|code)*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)`.
fn skip_link(m: &[char], i: usize, dest: &[Option<usize>]) -> Option<usize> {
    if m[i] != '[' {
        return None;
    }
    let mut j = i + 1;
    loop {
        match m.get(j) {
            Some(']') => break,
            Some('[') | None => return None,
            Some('`') => j = code_item(m, j)?,
            Some(_) => j += 1,
        }
    }
    if m.get(j + 1) != Some(&'(') {
        return None;
    }
    dest[j + 2].map(|e| e - i)
}

/// blockSkip's code: `(?<!`)(?<b>`+)[^`]+\k<b>(?!`)`.
fn skip_code(m: &[char], i: usize) -> Option<usize> {
    if m[i] != '`' || (i > 0 && m[i - 1] == '`') {
        return None;
    }
    code_item(m, i).map(|e| e - i)
}

/// blockSkip's tag: `<(?! )[^<>]*?>`.
fn skip_tag(m: &[char], i: usize) -> Option<usize> {
    if m[i] != '<' || m.get(i + 1) == Some(&' ') {
        return None;
    }
    let mut j = i + 1;
    while j < m.len() {
        match m[j] {
            '>' => return Some(j + 1 - i),
            '<' => return None,
            _ => j += 1,
        }
    }
    None
}

/// marked's inline label (`_inlineLabel`, lazy): the position of the `]` that ends it.
fn inline_label(c: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    loop {
        match c.get(j) {
            None => return None,
            Some(']') => return Some(j),
            Some('[') => {
                // \[(?:\\[\s\S]|[^\[\]\\])*\]
                let mut k = j + 1;
                loop {
                    match c.get(k) {
                        None | Some('[') => return None,
                        Some(']') => break,
                        Some('\\') => {
                            if k + 1 < c.len() {
                                k += 2;
                            } else {
                                return None;
                            }
                        }
                        Some(_) => k += 1,
                    }
                }
                j = k + 1;
            }
            Some('\\') => {
                if j + 1 < c.len() {
                    j += 2;
                } else {
                    return None;
                }
            }
            Some('`') => {
                // `+(?!`)[^`]*?`+(?!`) or ``+(?=\])
                let mut e = j;
                while e < c.len() && c[e] == '`' {
                    e += 1;
                }
                let mut k = e;
                while k < c.len() && c[k] != '`' {
                    k += 1;
                }
                if k < c.len() {
                    let mut q = k;
                    while q < c.len() && c[q] == '`' {
                        q += 1;
                    }
                    j = q;
                } else if e - j >= 2 && c.get(e) == Some(&']') {
                    j = e;
                } else {
                    return None;
                }
            }
            Some(_) => j += 1,
        }
    }
}

/// `_blockLabel`: `(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+` — the position after it.
fn block_label(c: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    while j < c.len() {
        match c[j] {
            '\\' => {
                if j + 1 < c.len() {
                    j += 2;
                } else {
                    return None;
                }
            }
            '[' | ']' => break,
            _ => j += 1,
        }
    }
    if j == i || c[i..j].iter().all(|x| is_space(*x)) {
        return None;
    }
    Some(j)
}

/// The destination of an inline link after `](`: (end of the match, href capture, title capture).
fn link_dest<'c>(c: &'c [char], i: usize, t: &Tables) -> Option<(usize, &'c [char], Option<&'c [char]>)> {
    let mut p = i;
    while p < c.len() && is_space(c[p]) {
        p += 1;
    }
    let href_start = p;
    // the rest: optional title, \s*, ')'
    let finish = |h_end: usize| -> Option<(usize, Option<(usize, usize)>)> {
        // with title
        let mut q = h_end;
        let mut sep = false;
        let ws = |q: &mut usize| {
            while *q < c.len() && (c[*q] == ' ' || c[*q] == '\t') {
                *q += 1;
            }
        };
        let q0 = q;
        ws(&mut q);
        if q > q0 {
            sep = true;
            if c.get(q) == Some(&'\n') {
                q += 1;
                ws(&mut q);
            }
        } else if c.get(q) == Some(&'\n') {
            sep = true;
            q += 1;
            ws(&mut q);
        }
        if sep {
            if let Some(te) = link_title(c, q) {
                let mut r = te;
                while r < c.len() && is_space(c[r]) {
                    r += 1;
                }
                if c.get(r) == Some(&')') {
                    return Some((r + 1, Some((q, te))));
                }
            }
        }
        let mut r = h_end;
        while r < c.len() && is_space(c[r]) {
            r += 1;
        }
        (c.get(r) == Some(&')')).then_some((r + 1, None))
    };
    // <...>
    if c.get(href_start) == Some(&'<') {
        let mut k = href_start + 1;
        let mut ok = false;
        while k < c.len() {
            match c[k] {
                '\\' if k + 1 < c.len() && c[k + 1] != '\n' => k += 2,
                '>' => {
                    ok = k > href_start + 1;
                    break;
                }
                '\n' | '<' | '\\' => break,
                _ => k += 1,
            }
        }
        if ok {
            if let Some((end, t)) = finish(k + 1) {
                return Some((end, &c[href_start..k + 1], t.map(|(a, b)| &c[a..b])));
            }
        }
    }
    // the destination `[^ \t\n\x00-\x1f]*` backtracks from its longest run; a shorter one can only end before a `)`
    // (the run holds no white space), so only the run's end and its last `)` need trying
    let run = t.href_end[href_start.min(c.len())].max(href_start);
    if let Some((end, ti)) = finish(run) {
        return Some((end, &c[href_start..run], ti.map(|(a, b)| &c[a..b])));
    }
    let h = t.last_paren[run];
    if h != usize::MAX && h >= href_start {
        if let Some((end, ti)) = finish(h) {
            return Some((end, &c[href_start..h], ti.map(|(a, b)| &c[a..b])));
        }
    }
    None
}

/// A link title (`"…"`, `'…'` or `(…)`): its end.
fn link_title(c: &[char], i: usize) -> Option<usize> {
    let open = *c.get(i)?;
    let close = match open {
        '"' => '"',
        '\'' => '\'',
        '(' => ')',
        _ => return None,
    };
    let mut j = i + 1;
    while j < c.len() {
        let x = c[j];
        if x == '\\' {
            j += if c.get(j + 1) == Some(&close) { 2 } else { 1 };
            continue;
        }
        if x == close {
            return Some(j + 1);
        }
        j += 1;
    }
    None
}

/// marked's `findClosingBracket` for `()`.
fn find_closing_bracket(s: &[char]) -> isize {
    if !s.contains(&')') {
        return -1;
    }
    let mut level = 0isize;
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            '\\' => i += 1,
            '(' => level += 1,
            ')' => {
                level -= 1;
                if level < 0 {
                    return i as isize;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if level > 0 { -2 } else { -1 }
}

/// `text.replace(/\\([\[\]])/g, '$1')`.
fn unescape_brackets(s: &str) -> String {
    s.replace("\\[", "[").replace("\\]", "]")
}

/// `str.slice(a, b)` with a negative end, on characters.
fn js_slice(s: &str, a: usize, b_neg: isize) -> String {
    let c: Vec<char> = s.chars().collect();
    let end = (c.len() as isize + b_neg).max(0) as usize;
    if a >= end {
        return String::new();
    }
    c[a..end].iter().collect()
}

/// marked's inline `tag` rule: its length.
fn inline_tag(c: &[char], p: usize) -> Option<usize> {
    if c[p] != '<' {
        return None;
    }
    let rest = &c[p..];
    let starts = |pre: &str| {
        let v: Vec<char> = pre.chars().collect();
        rest.len() >= v.len() && rest[..v.len()] == v[..]
    };
    // comment: <!--(?:-?>|[\s\S]*?-->)
    if starts("<!--") {
        if starts("<!-->") {
            return Some(5);
        }
        if starts("<!--->") {
            return Some(6);
        }
        let mut k = 4;
        while k + 2 < rest.len() {
            if rest[k] == '-' && rest[k + 1] == '-' && rest[k + 2] == '>' {
                return Some(k + 3);
            }
            k += 1;
        }
        return None;
    }
    // closing tag: </[a-zA-Z][\w:-]*\s*>
    if rest.get(1) == Some(&'/') {
        if !rest.get(2).is_some_and(|x| x.is_ascii_alphabetic()) {
            return None;
        }
        let mut k = 3;
        while k < rest.len() && (is_word(rest[k]) || rest[k] == ':' || rest[k] == '-') {
            k += 1;
        }
        while k < rest.len() && is_space(rest[k]) {
            k += 1;
        }
        return (rest.get(k) == Some(&'>')).then_some(k + 1);
    }
    // processing instruction, declaration, CDATA
    if starts("<?") {
        let mut k = 2;
        while k + 1 < rest.len() {
            if rest[k] == '?' && rest[k + 1] == '>' {
                return Some(k + 2);
            }
            k += 1;
        }
        return None;
    }
    if starts("<![CDATA[") {
        let mut k = 9;
        while k + 2 < rest.len() {
            if rest[k] == ']' && rest[k + 1] == ']' && rest[k + 2] == '>' {
                return Some(k + 3);
            }
            k += 1;
        }
        return None;
    }
    if rest.get(1) == Some(&'!') {
        let mut k = 2;
        while k < rest.len() && rest[k].is_ascii_alphabetic() {
            k += 1;
        }
        if k == 2 || !rest.get(k).is_some_and(|x| is_space(*x)) {
            return None;
        }
        while k < rest.len() {
            if rest[k] == '>' {
                return Some(k + 1);
            }
            k += 1;
        }
        return None;
    }
    // open tag: <[a-zA-Z][\w-]*(?:attribute)*?\s*/?>
    if !rest.get(1).is_some_and(|x| x.is_ascii_alphabetic()) {
        return None;
    }
    let mut j = 2;
    while j < rest.len() && (is_word(rest[j]) || rest[j] == '-') {
        j += 1;
    }
    loop {
        let mut k = j;
        while k < rest.len() && is_space(rest[k]) {
            k += 1;
        }
        if rest.get(k) == Some(&'/') && rest.get(k + 1) == Some(&'>') {
            return Some(k + 2);
        }
        if rest.get(k) == Some(&'>') {
            return Some(k + 1);
        }
        if k == j || !rest.get(k).is_some_and(|x| x.is_ascii_alphabetic() || *x == ':' || *x == '_') {
            return None;
        }
        k += 1;
        while k < rest.len() && (is_word(rest[k]) || matches!(rest[k], '.' | ':' | '-')) {
            k += 1;
        }
        let mut v = k;
        while v < rest.len() && is_space(rest[v]) {
            v += 1;
        }
        if rest.get(v) == Some(&'=') {
            v += 1;
            while v < rest.len() && is_space(rest[v]) {
                v += 1;
            }
            match rest.get(v) {
                Some(q @ ('"' | '\'')) => {
                    let q = *q;
                    if let Some(e) = rest[v + 1..].iter().position(|x| *x == q) {
                        k = v + 1 + e + 1;
                    }
                }
                Some(_) => {
                    let st = v;
                    while v < rest.len() && !is_space(rest[v]) && !matches!(rest[v], '"' | '\'' | '=' | '<' | '>' | '`')
                    {
                        v += 1;
                    }
                    if v > st {
                        k = v;
                    }
                }
                None => {}
            }
        }
        j = k;
    }
}

/// marked's `codespan`: (length, text).
fn codespan(c: &[char], p: usize, t: &Tables) -> Option<(usize, String)> {
    if c[p] != '`' {
        return None;
    }
    let mut j = p;
    while j < c.len() && c[j] == '`' {
        j += 1;
    }
    let n = j - p;
    if j >= c.len() || c[j] == '`' {
        return None;
    }
    // the first maximal run of exactly n backticks after at least one character
    let runs = t.tick_runs.get(&n)?;
    let at = runs.partition_point(|r| *r <= j);
    let k = *runs.get(at)?;
    let e = k + n;
    let mut text: String = c[j..k].iter().map(|x| if *x == '\n' { ' ' } else { *x }).collect();
    let has_non_space = text.chars().any(|x| x != ' ');
    if has_non_space && text.starts_with(' ') && text.ends_with(' ') && text.len() >= 2 {
        text = text[1..text.len() - 1].to_string();
    }
    Some((e - p, text))
}

/// marked's `br`: `^( {2,}|\\)\n(?!\s*$)`.
fn br(c: &[char], p: usize) -> Option<usize> {
    let mut j = p;
    if c[p] == '\\' {
        j += 1;
    } else {
        while j < c.len() && c[j] == ' ' {
            j += 1;
        }
        if j - p < 2 {
            return None;
        }
    }
    if c.get(j) != Some(&'\n') {
        return None;
    }
    if c[j + 1..].iter().all(|x| is_space(*x)) {
        return None;
    }
    Some(j + 1 - p)
}

/// marked's `autolink`: (length, text, href).
fn autolink(c: &[char], p: usize) -> Option<(usize, String, String)> {
    if c[p] != '<' {
        return None;
    }
    let mut k = p + 1;
    while k < c.len() && c[k] != '>' && c[k] != '<' && !is_space(c[k]) && (c[k] as u32) >= 0x20 {
        k += 1;
    }
    if c.get(k) != Some(&'>') {
        return None;
    }
    let inner: String = c[p + 1..k].iter().collect();
    // scheme:...
    let b = inner.as_bytes();
    if b.first().is_some_and(u8::is_ascii_alphabetic) {
        let n = b.iter().skip(1).take_while(|x| x.is_ascii_alphanumeric() || matches!(x, b'+' | b'.' | b'-')).count();
        if (1..=31).contains(&n) && b.get(1 + n) == Some(&b':') {
            return Some((k + 1 - p, inner.clone(), inner));
        }
    }
    // email
    if let Some((local, domain)) = inner.split_once('@') {
        let local_ok = !local.is_empty()
            && local.bytes().all(|x| x.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&x));
        let labels: Vec<&str> = domain.split('.').collect();
        let label_ok = |l: &str| {
            let lb = l.as_bytes();
            !lb.is_empty()
                && lb.len() <= 63
                && lb[0].is_ascii_alphanumeric()
                && lb[lb.len() - 1].is_ascii_alphanumeric()
                && lb.iter().all(|x| x.is_ascii_alphanumeric() || *x == b'-')
        };
        if local_ok && labels.len() >= 2 && labels.iter().all(|l| label_ok(l)) {
            return Some((k + 1 - p, inner.clone(), format!("mailto:{inner}")));
        }
    }
    None
}

/// marked's GFM `url` (bare links and e-mails): (length, text, href).
fn url(c: &[char], p: usize) -> Option<(usize, String, String)> {
    let rest = &c[p..];
    let lower: String = rest.iter().take(8).collect::<String>().to_ascii_lowercase();
    let prefix = ["https://", "http://", "ftp://"].iter().find(|x| lower.starts_with(**x)).map(|x| x.len());
    let www = rest.len() >= 4 && rest[..4] == ['w', 'w', 'w', '.'];
    if let Some(pl) = prefix.or(if www { Some(4) } else { None }) {
        if !rest.get(pl).is_some_and(|x| x.is_ascii_alphanumeric() || *x == '-') {
            return email_url(c, p);
        }
        let mut e = pl;
        while e < rest.len() && !is_space(rest[e]) && rest[e] != '<' {
            e += 1;
        }
        let mut cap: Vec<char> = rest[..e].to_vec();
        let mut passes = 0;
        loop {
            let next = backpedal(&cap);
            if next.len() == cap.len() {
                break;
            }
            passes += 1;
            cap = next;
            if passes > 64 {
                // each pass drops one trailing punctuation character: drop the rest of the run at once
                while cap.len() > 1 && "?!.,:;*_'\"~".contains(cap[cap.len() - 1]) {
                    cap.pop();
                }
            }
        }
        let text: String = cap.iter().collect();
        let href = if www { format!("http://{text}") } else { text.clone() };
        return Some((cap.len(), text, href));
    }
    email_url(c, p)
}

/// GFM e-mail autolink: `[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])`.
fn email_url(c: &[char], p: usize) -> Option<(usize, String, String)> {
    let rest = &c[p..];
    let local = rest.iter().take_while(|x| x.is_ascii_alphanumeric() || matches!(x, '.' | '_' | '+' | '-')).count();
    if local == 0 || rest.get(local) != Some(&'@') {
        return None;
    }
    let dom_ok = |x: &char| x.is_ascii_alphanumeric() || *x == '-' || *x == '_';
    let mut k = local + 1;
    let st = k;
    while k < rest.len() && dom_ok(&rest[k]) {
        k += 1;
    }
    if k == st {
        return None;
    }
    // (?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+ then (?![-_]): backtracking tries every possible end from the right, an
    // end being an alphanumeric inside a dotted part
    let mut q = k;
    let mut last = k;
    while rest.get(q) == Some(&'.') {
        let mut r = q + 1;
        while r < rest.len() && dom_ok(&rest[r]) {
            r += 1;
        }
        last = r;
        q = r;
    }
    let mut best = None;
    let mut e = last;
    while e > k {
        if rest[e - 1].is_ascii_alphanumeric() && rest[k..e].contains(&'.') && rest[e - 1] != '.' {
            // the part this end is in must hold at least the dot and this character
            if !matches!(rest.get(e), Some('-') | Some('_')) {
                best = Some(e);
                break;
            }
        }
        e -= 1;
    }
    let end = best?;
    let text: String = rest[..end].iter().collect();
    Some((end, text.clone(), format!("mailto:{text}")))
}

/// One pass of marked's `_backpedal` on a bare URL.
fn backpedal(c: &[char]) -> Vec<char> {
    let trail = |x: char| "?!.,:;*_'\"~)".contains(x);
    let stop = |x: char| "?!.,:;*_'\"~()&".contains(x);
    let mut i = 0;
    loop {
        if i >= c.len() {
            break;
        }
        // [^?!.,:;*_'"~()&]+
        if !stop(c[i]) {
            while i < c.len() && !stop(c[i]) {
                i += 1;
            }
            continue;
        }
        // \([^)]*\)
        if c[i] == '(' {
            if let Some(k) = c[i + 1..].iter().position(|x| *x == ')') {
                i = i + 1 + k + 1;
                continue;
            }
        }
        // &(?![a-zA-Z0-9]+;$)
        if c[i] == '&' {
            let n = c[i + 1..].iter().take_while(|x| x.is_ascii_alphanumeric()).count();
            let entity_end = n > 0 && c.get(i + 1 + n) == Some(&';') && i + 2 + n == c.len();
            if !entity_end {
                i += 1;
                continue;
            }
            break;
        }
        // [?!.,:;*_'"~)]+(?!$)
        if trail(c[i]) {
            let mut e = i;
            while e < c.len() && trail(c[e]) {
                e += 1;
            }
            if e == c.len() {
                e -= 1;
            }
            if e > i {
                i = e;
                continue;
            }
        }
        break;
    }
    c[..i].to_vec()
}

/// marked's GFM inline `text` on `c[p..end]`: its length (at least one character).
fn inline_text(c: &[char], p: usize, end: usize, t: &Tables) -> usize {
    let end = end.max(p + 1).min(c.len());
    let mut q = p;
    if c[p] == '`' || c[p] == '~' {
        while q < end && (c[q] == '`' || c[q] == '~') {
            q += 1;
        }
    } else {
        q += 1;
    }
    if q >= end {
        return q - p;
    }
    if t.spaces_nl(c, q, end) || t.email_ahead(c, q, end) {
        return q - p;
    }
    loop {
        if q >= end {
            return end - p;
        }
        let x = c[q];
        if matches!(x, '\\' | '<' | '!' | '[' | '`' | '*' | '~' | '_') || protocol_at(c, q, end) {
            return q - p;
        }
        if x != ' ' && t.spaces_nl(c, q + 1, end) {
            return q + 1 - p;
        }
        if !is_email_char(x) && q + 1 < end && t.email_ahead(c, q + 1, end) {
            return q + 1 - p;
        }
        q += 1;
    }
}

/// `protocol:\/\/|www\.` at `q`.
fn protocol_at(c: &[char], q: usize, end: usize) -> bool {
    let get = |k: usize| if q + k < end { c[q + k].to_ascii_lowercase() } else { '\0' };
    let http = get(0) == 'h' && get(1) == 't' && get(2) == 't' && get(3) == 'p';
    if http {
        let k = if get(4) == 's' { 5 } else { 4 };
        if get(k) == ':' && get(k + 1) == '/' && get(k + 2) == '/' {
            return true;
        }
    }
    if get(0) == 'f' && get(1) == 't' && get(2) == 'p' && get(3) == ':' && get(4) == '/' && get(5) == '/' {
        return true;
    }
    q + 4 <= end && c[q..q + 4] == ['w', 'w', 'w', '.']
}

/// The MathInline tokenizer at `p` (a `$`).
fn math_inline(c: &[char], p: usize) -> Option<(usize, Inline)> {
    let first = *c.get(p + 1)?;
    if is_space(first) || first == '$' {
        return None;
    }
    let mut i = p + 1;
    loop {
        let x = *c.get(i)?;
        if x == '\\' {
            let y = *c.get(i + 1)?;
            if crate::chars::is_line_term(y) {
                return None;
            }
            i += 2;
            continue;
        }
        if x == '$' {
            if i == p + 1 || is_space(c[i - 1]) || c.get(i + 1).is_some_and(char::is_ascii_digit) {
                return None;
            }
            let latex = s(&c[p + 1..i]);
            return Some((i + 1 - p, Inline::Math(latex)));
        }
        if x == '\n' {
            return None;
        }
        i += 1;
    }
}

/// The DocRef tokenizer at `p` (`[[`).
fn doc_ref(c: &[char], p: usize, t: &Tables) -> Option<(usize, Inline)> {
    let st = p + 2;
    let i = t.next_page_stop[st.min(c.len())];
    if i == st || i >= c.len() || c[i] == '\n' {
        return None;
    }
    let page = s(&c[st..i]);
    let mut section = None;
    let mut label = None;
    let close_at = |k: usize| c.get(k) == Some(&']') && c.get(k + 1) == Some(&']');
    let try_label = |k: usize| -> Option<(usize, String)> {
        // \|([^\]\n]+?) then \]\]
        if c.get(k) != Some(&'|') {
            return None;
        }
        let j = t.next_label_stop[(k + 1).min(c.len())];
        if j == k + 1 || !close_at(j) {
            return None;
        }
        Some((j + 2, s(&c[k + 1..j])))
    };
    let mut end = None;
    if c[i] == '#' {
        let j = t.next_section_stop[(i + 1).min(c.len())];
        if j > i + 1 {
            let sec = s(&c[i + 1..j]);
            if let Some((e, l)) = try_label(j) {
                section = Some(sec);
                label = Some(l);
                end = Some(e);
            } else if close_at(j) {
                section = Some(sec);
                end = Some(j + 2);
            }
        }
        // without the section: the label or "]]" must follow the page directly, which '#' prevents
    } else if let Some((e, l)) = try_label(i) {
        label = Some(l);
        end = Some(e);
    } else if close_at(i) {
        end = Some(i + 2);
    }
    let end = end?;
    let clean = |v: Option<String>| v.map(|x| crate::chars::trim(&x).to_string()).filter(|x| !x.is_empty());
    Some((
        end - p,
        Inline::DocRef {
            page: crate::chars::trim(&page).to_string(),
            section: clean(section),
            label: clean(label),
            page_id: None,
            target: None,
            target_label: None,
        },
    ))
}
