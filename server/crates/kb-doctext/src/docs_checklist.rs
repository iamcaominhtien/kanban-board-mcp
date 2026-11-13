//! `services/docs_checklist.py`: from a page's checklist to tickets: unchecked task items and action items ("TODO:"
//! lines, bullets under an "Actions" or "Next steps" heading) become tickets. Ticked items and items that already
//! carry a ticket key are left out.
//!
//! Deterministic: no model. `docs_write(action='tickets')` uses it (`kanban_mcp/tools/docs.py`). Kept from the Docs AI
//! of v1 (`services/docs_ai/tickets.py`) when the Docs AI moved to Claude Code skills (AI v2).
//!
//! The patterns are Python's `re` with its character classes (`\s`, `\w`, `\d` from `pystr`) and, where the Python
//! pattern has `re.I`, every letter written as the class of the characters Python's case folding equates with it
//! (`i` also matches `İ` and `ı`, `s` also `ſ`, `k` also the Kelvin sign).

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::docs_text::{first_ticket, heading_match, is_fence, remove_inline_code, strip_block_prefix, strip_inline};
use crate::pystr::{self, DECIMAL_CLASS, SPACE_CLASS, WORD_CLASS};

/// Most items one call returns.
pub const MAX_ITEMS: usize = 30;

/// A regex source for `word` under Python's `re.I`: letters become classes of the characters that fold together.
fn ci(word: &str) -> String {
    let mut out = String::new();
    for c in word.chars() {
        match c {
            'i' => out.push_str("[iI\\x{130}\\x{131}]"),
            's' => out.push_str("[sS\\x{17F}]"),
            'k' => out.push_str("[kK\\x{212A}]"),
            c if c.is_ascii_alphabetic() => {
                out.push('[');
                out.push(c.to_ascii_lowercase());
                out.push(c.to_ascii_uppercase());
                out.push(']');
            }
            c => out.push_str(&regex::escape(&c.to_string())),
        }
    }
    out
}

fn compile(pattern: &str) -> Regex {
    // the patterns are constants of this file: a failure to compile is a typo found by the first test run
    Regex::new(pattern).expect("a constant pattern of docs_checklist")
}

fn bullet() -> String {
    format!("(?:[*+-]|[{}]{{1,9}}\\.)", DECIMAL_CLASS.as_str())
}

/// `^\s*(?:>\s*)*(?:[*+-]|\d{1,9}\.)\s+\[( |x|X)\][ \t]+(\S.*)$`
static TASK: LazyLock<Regex> = LazyLock::new(|| {
    let s = SPACE_CLASS;
    compile(&format!("^[{s}]*(?:>[{s}]*)*{}[{s}]+\\[( |x|X)\\][ \\t]+([^{s}].*)\\n?\\z", bullet()))
});

/// `^\s*(?:>\s*)*(?:[*+-]|\d{1,9}\.)\s+(\S.*)$`
static BULLET: LazyLock<Regex> = LazyLock::new(|| {
    let s = SPACE_CLASS;
    compile(&format!("^[{s}]*(?:>[{s}]*)*{}[{s}]+([^{s}].*)\\n?\\z", bullet()))
});

/// `action|next steps?|to-?do|follow-?ups?` (re.I, searched)
static ACTION_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        "{}|{}{}?|{}-?{}|{}-?{}{}?",
        ci("action"),
        ci("next step"),
        ci("s"),
        ci("to"),
        ci("do"),
        ci("follow"),
        ci("up"),
        ci("s")
    ))
});

/// `^\s*(?:(?:[*+-]|\d{1,9}\.)\s+)?(?:todo|action(?: item)?)\s*[:\-]\s*(\S.*)$` (re.I)
static ACTION_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    let s = SPACE_CLASS;
    compile(&format!(
        "^[{s}]*(?:{}[{s}]+)?(?:{}|{}(?: {})?)[{s}]*[:\\-][{s}]*([^{s}].*)\\n?\\z",
        bullet(),
        ci("todo"),
        ci("action"),
        ci("item")
    ))
});

/// `\s+[—–-]\s+[A-Z][\w'’]*(?:\s+[A-Z][\w'’]*){0,2}\s*$`
static NAME_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    let s = SPACE_CLASS;
    let w = &*WORD_CLASS;
    compile(&format!("[{s}]+[—–-][{s}]+[A-Z][{w}'’]*(?:[{s}]+[A-Z][{w}'’]*){{0,2}}[{s}]*\\z"))
});

/// What was found on a page: items to draft and items left out (with the reason).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Found {
    /// Items to draft, at most `MAX_ITEMS`.
    pub items: Vec<Item>,
    /// Items left out.
    pub skipped: Vec<Skipped>,
}

/// An item to draft as a ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    /// The plain text of the line.
    pub text: String,
    /// The line as written.
    pub raw: String,
    /// Index of the line.
    pub line: usize,
    /// 1-based position among the items.
    pub n: usize,
}

/// An item that is left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    /// The plain text of the line.
    pub text: String,
    /// `"ticked"` or `"has_ticket"`.
    pub reason: &'static str,
    /// The ticket key already on the line (`has_ticket` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Index of the line.
    pub line: usize,
}

/// The plain text of a list line: no bullet, checkbox or formatting (what a draft's `text` holds).
pub fn line_text(raw: &str) -> String {
    pystr::strip(&strip_inline(&strip_block_prefix(raw, false))).to_string()
}

/// `re.sub(r"\s+", " ", text).strip().lower()`.
fn norm(text: &str) -> String {
    crate::docs_anchors::normalize(text).to_lowercase()
}

/// Unchecked task items and action items of some Markdown, skipping ticked items and items that already carry a
/// ticket key (a chip). `selection` limits the search to the text a person selected.
pub fn extract<'a>(markdown: &'a str, selection: Option<&'a str>) -> Found {
    let mut found = Found::default();
    let mut lines: Vec<&str> = pystr::splitlines(markdown);
    let mut wanted: Option<String> = match selection {
        Some(sel) if !pystr::strip(sel).is_empty() => Some(norm(sel)),
        _ => None,
    };
    if let (Some(w), Some(sel)) = (wanted.clone(), selection) {
        let picked = lines.iter().any(|ln| {
            let t = line_text(ln);
            !t.is_empty() && w.contains(&norm(&t))
        });
        if !picked {
            // the selection is not on the page: read it as Markdown
            lines = pystr::splitlines(sel);
            wanted = None;
        }
    }
    let mut in_fence = false;
    let mut heading = String::new();
    for (i, raw) in lines.iter().enumerate() {
        let raw = *raw;
        if is_fence(raw) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(h) = heading_match(raw) {
            heading = h.text;
            continue;
        }
        if let Some(w) = &wanted {
            let t = line_text(raw);
            if t.is_empty() || !w.contains(&norm(&t)) {
                continue;
            }
        }
        let mut checked = false;
        if let Some(task) = TASK.captures(raw) {
            checked = task[1].eq_ignore_ascii_case("x");
        } else if !(ACTION_PREFIX.is_match(raw) || (ACTION_HEAD.is_match(&heading) && BULLET.is_match(raw))) {
            continue;
        }
        let text = line_text(raw);
        if text.is_empty() {
            continue;
        }
        if checked {
            found.skipped.push(Skipped { text, reason: "ticked", key: None, line: i });
            continue;
        }
        if let Some(key) = first_ticket(&remove_inline_code(raw)) {
            found.skipped.push(Skipped { text, reason: "has_ticket", key: Some(key), line: i });
            continue;
        }
        found.items.push(Item { text, raw: raw.to_string(), line: i, n: 0 });
    }
    found.items.truncate(MAX_ITEMS);
    for (n, it) in found.items.iter_mut().enumerate() {
        it.n = n + 1;
    }
    found
}

/// `,?\s*\b(?:due|by)\s+(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|\d{4}-\d{2}-\d{2}
/// |(?:jan|...|dec)[a-z]*\.?\s+\d{1,2}|today|tomorrow)\b` (re.I) matched at `i`: the end of the due phrase.
///
/// Written out because of the two `\b`, which in Python mean "next to a non-`\w` character" with Python's `\w`.
fn due_at(chars: &[char], i: usize, ws_end: &[usize]) -> Option<usize> {
    use crate::pystr::{is_decimal, is_word};
    let eq = |p: usize, word: &str| -> Option<usize> {
        let mut q = p;
        for w in word.chars() {
            let c = *chars.get(q)?;
            let same = match w {
                'i' => matches!(c, 'i' | 'I' | '\u{130}' | '\u{131}'),
                's' => matches!(c, 's' | 'S' | '\u{17f}'),
                'k' => matches!(c, 'k' | 'K' | '\u{212a}'),
                w => c.eq_ignore_ascii_case(&w),
            };
            if !same {
                return None;
            }
            q += 1;
        }
        Some(q)
    };
    let is_letter = |c: char| c.is_ascii_alphabetic() || matches!(c, '\u{130}' | '\u{131}' | '\u{17f}' | '\u{212a}');
    let letters_from = |mut q: usize| {
        while q < chars.len() && is_letter(chars[q]) {
            q += 1;
        }
        q
    };
    let digits = |q: usize, n: usize| -> Option<usize> {
        (q..q + n).all(|k| chars.get(k).is_some_and(|&c| is_decimal(c))).then_some(q + n)
    };
    let boundary_after = |q: usize| !chars.get(q).is_some_and(|&c| is_word(c));
    // ,?\s*  (a comma, else none: a run of white space never gives characters back to a word that needs one)
    let starts: &[usize] = if chars[i] == ',' { &[i + 1, i] } else { &[i] };
    for &after_comma in starts {
        let p = ws_end[after_comma];
        // \b before the keyword: it can only fail when nothing was consumed and a word character comes before
        if p == i && i > 0 && is_word(chars[i - 1]) {
            continue;
        }
        let Some(q) = eq(p, "due").or_else(|| eq(p, "by")) else { continue };
        let w = ws_end[q];
        if w == q {
            continue;
        }
        let mut stems = vec![w];
        if let Some(o) = eq(w, "on") {
            let w2 = ws_end[o];
            if w2 > o {
                stems.insert(0, w2);
            }
        }
        for t in stems {
            for day in ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] {
                if let Some(e) = eq(t, day) {
                    let e = letters_from(e);
                    if boundary_after(e) {
                        return Some(e);
                    }
                }
            }
            // \d{4}-\d{2}-\d{2}
            if let Some(a) = digits(t, 4)
                && chars.get(a) == Some(&'-')
                && let Some(b) = digits(a + 1, 2)
                && chars.get(b) == Some(&'-')
                && let Some(e) = digits(b + 1, 2)
                && boundary_after(e)
            {
                return Some(e);
            }
            for month in ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] {
                if let Some(e) = eq(t, month) {
                    let mut e = letters_from(e);
                    if chars.get(e) == Some(&'.') {
                        e += 1;
                    }
                    let w = ws_end[e];
                    if w == e {
                        continue;
                    }
                    let mut d = w;
                    while d < chars.len() && d - w < 2 && is_decimal(chars[d]) {
                        d += 1;
                    }
                    if d > w && boundary_after(d) {
                        return Some(d);
                    }
                }
            }
            for word in ["today", "tomorrow"] {
                if let Some(e) = eq(t, word)
                    && boundary_after(e)
                {
                    return Some(e);
                }
            }
        }
    }
    None
}

/// `_DUE_ANY.sub("", title)`.
fn remove_due(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    // ws_end[k]: where the run of white space that starts at k ends (k itself when there is none)
    let mut ws_end = vec![0; chars.len() + 1];
    ws_end[chars.len()] = chars.len();
    for k in (0..chars.len()).rev() {
        ws_end[k] = if pystr::is_space(chars[k]) { ws_end[k + 1] } else { k };
    }
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        match due_at(&chars, i, &ws_end) {
            Some(end) => i = end,
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// The text as a ticket title: no due phrase, no "- Name" tail, no "TODO:" prefix, first letter capital.
pub fn clean_title(text: &str) -> String {
    let stripped = match ACTION_PREFIX.captures(text) {
        // the remainder after the match: a single trailing newline that `$` leaves is cut by strip() anyway
        Some(c) => {
            let m = c.get(0).map_or(0..0, |m| m.range());
            format!("{}{}", &c[1], &text[m.end..])
        }
        None => text.to_string(),
    };
    let title = pystr::strip(&stripped);
    let due = remove_due(title);
    let title = pystr::strip_chars(&due, " ,;");
    let tail = NAME_TAIL.replace(title, "").into_owned();
    let title = pystr::strip_chars(&tail, " ,;—–-");
    let title = if title.is_empty() { pystr::strip(text) } else { title };
    let mut chars = title.chars();
    let first: String = chars.next().map(pystr::upper_char).unwrap_or_default();
    let capped = format!("{first}{}", chars.as_str());
    pystr::head(&capped, 200).to_string()
}
