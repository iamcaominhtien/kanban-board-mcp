//! `services/docs_anchors.py`: comment anchors: turn page Markdown into plain text blocks and re-find a quoted
//! selection in them.
//!
//! An anchor is the selected text (`quote`) plus up to `CONTEXT` characters of `prefix` / `suffix` and the id of the
//! section it starts in. A selection may run over several blocks: the page text is then read as the blocks joined by
//! single spaces. The page Markdown is never changed. Offsets and lengths count characters, as in Python.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::docs_text::{self, heading_anchors, is_fence, strip_block_prefix};
use crate::pystr::{self, is_decimal, is_space, is_word};

/// Characters of prefix and suffix kept around a quote.
pub const CONTEXT: usize = 32;
/// Least share of a quote that must still be in place for a fuzzy match.
pub const MIN_FUZZY_RATIO: f64 = 0.7;
/// Shortest quote that is matched fuzzily.
pub const MIN_FUZZY_QUOTE: usize = 4;
/// Longest quote a comment may carry.
pub const MAX_QUOTE: usize = 2000;

/// Collapse whitespace runs to single spaces and trim, the way a selection is compared.
pub fn normalize(text: &str) -> String {
    // _WS.sub(" ", text).strip()
    let mut out = String::new();
    let mut in_run = false;
    for c in text.chars() {
        if is_space(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    pystr::strip(&out).to_string()
}

/// One block of page text (paragraph, heading, list item, table cell or code block).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    /// The block's plain text.
    pub text: String,
    /// Slug of the heading it sits under.
    #[serde(default)]
    pub section: Option<String>,
    /// Offset of the block in the page text, blocks joined by one separator.
    pub start: usize,
}

/// Where an anchor was found, with the anchor refreshed to the text found there.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Match {
    /// Offset of the quote in the page text.
    pub pos: usize,
    /// The text found.
    pub quote: String,
    /// Up to `CONTEXT` characters before it.
    pub prefix: String,
    /// Up to `CONTEXT` characters after it.
    pub suffix: String,
    /// Slug of the section it is in.
    pub section: Option<String>,
    /// False when the quote was found by approximation.
    pub exact: bool,
}

fn s(chars: &[char]) -> String {
    chars.iter().collect()
}

/// `!\[[^\]\n]{0,300}\]\([^()\n]{0,500}\)` at `i`: the end of an image, if one starts there.
fn image_at(chars: &[char], i: usize) -> Option<usize> {
    if chars.get(i) != Some(&'!') || chars.get(i + 1) != Some(&'[') {
        return None;
    }
    let a0 = i + 2;
    let mut a = 0;
    while a <= 300 && a0 + a < chars.len() && !matches!(chars[a0 + a], ']' | '\n') {
        a += 1;
    }
    if a > 300 || chars.get(a0 + a) != Some(&']') || chars.get(a0 + a + 1) != Some(&'(') {
        return None;
    }
    let u0 = a0 + a + 2;
    let mut u = 0;
    while u <= 500 && u0 + u < chars.len() && !matches!(chars[u0 + u], '(' | ')' | '\n') {
        u += 1;
    }
    if u > 500 || chars.get(u0 + u) != Some(&')') {
        return None;
    }
    Some(u0 + u + 1)
}

/// `_UNDERSCORE`: `(?<![\w])_([^_\n]{1,300})_(?![\w])` at `i`: the end and the inner range.
fn underscore_at(chars: &[char], i: usize) -> Option<(usize, usize, usize)> {
    if chars[i] != '_' || (i > 0 && is_word(chars[i - 1])) {
        return None;
    }
    let a0 = i + 1;
    let mut a = 0;
    while a <= 300 && a0 + a < chars.len() && !matches!(chars[a0 + a], '_' | '\n') {
        a += 1;
    }
    if !(1..=300).contains(&a) || chars.get(a0 + a) != Some(&'_') {
        return None;
    }
    let end = a0 + a + 1;
    if chars.get(end).is_some_and(|&c| is_word(c)) {
        return None;
    }
    Some((end, a0, a0 + a))
}

/// `_HTML`: `</?[a-zA-Z][^>\n]{0,200}>` at `i`: the end of a tag, if one starts there.
fn html_at(chars: &[char], i: usize) -> Option<usize> {
    if chars[i] != '<' {
        return None;
    }
    let mut p = i + 1;
    if chars.get(p) == Some(&'/') {
        p += 1;
    }
    if !chars.get(p).is_some_and(char::is_ascii_alphabetic) {
        return None;
    }
    let b0 = p + 1;
    let mut b = 0;
    while b <= 200 && b0 + b < chars.len() && !matches!(chars[b0 + b], '>' | '\n') {
        b += 1;
    }
    if b > 200 || chars.get(b0 + b) != Some(&'>') {
        return None;
    }
    Some(b0 + b + 1)
}

fn inline_plain(line: &str) -> String {
    // _IMAGE.sub("", line)
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<char> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match image_at(&chars, i) {
            Some(end) => i = end,
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    // _LINK.sub(label), _REF.sub(group(2) or group(1)): the `#section` of a reference here may be empty
    let line = s(&out);
    let line = docs_text::link_labels(&line);
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<char> = Vec::new();
    let mut last = 0;
    for m in docs_text::find_refs(&chars, 0) {
        out.extend(&chars[last..m.start]);
        let (a, b) = m.display.unwrap_or(m.title);
        out.extend(&chars[a..b]);
        last = m.end;
    }
    out.extend(&chars[last..]);
    // _HTML.sub("", line)
    let chars = out;
    let mut out: Vec<char> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match html_at(&chars, i) {
            Some(end) => i = end,
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    // _UNDERSCORE.sub(group(1), line)
    let chars = out;
    let mut out: Vec<char> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match underscore_at(&chars, i) {
            Some((end, a, b)) => {
                out.extend(&chars[a..b]);
                i = end;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    // _EMPHASIS.sub("", line): **, __, ~~, ==, *, `
    let chars = out;
    let mut out: Vec<char> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let pair = matches!(c, '*' | '_' | '~' | '=') && chars.get(i + 1) == Some(&c);
        if pair {
            i += 2;
        } else if c == '*' || c == '`' {
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    // re.sub(r"\\([\\`*_{}\[\]()#+\-.!|>~$])", r"\1", line)
    let chars = out;
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1).is_some_and(|c| "\\`*_{}[]()#+-.!|>~$".contains(*c)) {
            out.push(chars[i + 1]);
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    normalize(&out)
}

/// `^\s{0,3}#{1,6}[ \t]`: a heading line as the block splitter reads it (up to three spaces of indent).
fn is_block_heading(raw: &str) -> bool {
    let chars: Vec<char> = raw.chars().collect();
    let mut p = 0;
    while p < chars.len() && p < 3 && is_space(chars[p]) {
        p += 1;
    }
    let h0 = p;
    while p < chars.len() && p - h0 < 6 && chars[p] == '#' {
        p += 1;
    }
    p > h0 && matches!(chars.get(p), Some(' ' | '\t'))
}

/// `^\s*([*+-]|\d{1,9}\.)[ \t]`: a list item line.
fn is_list_item(raw: &str) -> bool {
    let chars: Vec<char> = raw.chars().collect();
    let mut p = 0;
    while p < chars.len() && is_space(chars[p]) {
        p += 1;
    }
    match chars.get(p) {
        Some('*' | '+' | '-') => matches!(chars.get(p + 1), Some(' ' | '\t')),
        _ => {
            let d0 = p;
            while p < chars.len() && is_decimal(chars[p]) {
                p += 1;
            }
            (1..=9).contains(&(p - d0)) && chars.get(p) == Some(&'.') && matches!(chars.get(p + 1), Some(' ' | '\t'))
        }
    }
}

/// Split Markdown into plain-text blocks, each tagged with the heading slug it sits under.
///
/// Returns non-empty blocks in page order; `start` offsets index the blocks joined by newlines.
pub fn blocks_of(markdown: &str) -> Vec<Block> {
    let slugs: Vec<String> = heading_anchors(markdown).into_iter().map(|h| h.slug).collect();
    let mut seen_headings = 0;
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    let mut para: Vec<&str> = Vec::new();
    let mut code: Vec<&str> = Vec::new();
    let mut in_code = false;
    let mut section: Option<String> = None;

    fn flush(para: &mut Vec<&str>, out: &mut Vec<(String, Option<String>)>, section: &Option<String>) {
        if !para.is_empty() {
            let text = inline_plain(&para.join(" "));
            if !text.is_empty() {
                out.push((text, section.clone()));
            }
            para.clear();
        }
    }

    for raw in markdown.split('\n') {
        if is_fence(raw) {
            if in_code {
                let text = normalize(&code.join(" "));
                if !text.is_empty() {
                    out.push((text, section.clone()));
                }
                code.clear();
            } else {
                flush(&mut para, &mut out, &section);
            }
            in_code = !in_code;
            continue;
        }
        if in_code {
            code.push(raw);
            continue;
        }
        if pystr::strip(raw).is_empty() {
            flush(&mut para, &mut out, &section);
            continue;
        }
        if is_block_heading(raw) {
            flush(&mut para, &mut out, &section);
            if seen_headings < slugs.len() {
                section = Some(slugs[seen_headings].clone());
                seen_headings += 1;
            }
            let text = inline_plain(&strip_block_prefix(raw, true));
            if !text.is_empty() {
                out.push((text, section.clone()));
            }
            continue;
        }
        if pystr::lstrip(raw).starts_with('|') {
            flush(&mut para, &mut out, &section);
            if pystr::strip_chars(raw, " \t|:-").is_empty() {
                // a |---|---| separator row
                continue;
            }
            for cell in pystr::strip(raw).trim_matches('|').split('|') {
                let text = inline_plain(cell);
                if !text.is_empty() {
                    out.push((text, section.clone()));
                }
            }
            continue;
        }
        if is_list_item(raw) || pystr::lstrip(raw).starts_with('>') {
            flush(&mut para, &mut out, &section);
            let text = inline_plain(&strip_block_prefix(raw, false));
            if !text.is_empty() {
                out.push((text, section.clone()));
            }
            continue;
        }
        para.push(raw);
    }
    flush(&mut para, &mut out, &section);
    let mut blocks = Vec::new();
    let mut pos = 0;
    for (text, sec) in out {
        let n = text.chars().count();
        blocks.push(Block { text, section: sec, start: pos });
        pos += n + 1;
    }
    blocks
}

/// Return the prefix and suffix around `text[start:end]` (at most `CONTEXT` characters each).
pub fn context_of(text: &str, start: usize, end: usize) -> (String, String) {
    let chars: Vec<char> = text.chars().collect();
    context_chars(&chars, start, end)
}

fn context_chars(chars: &[char], start: usize, end: usize) -> (String, String) {
    let clip = |i: usize| i.min(chars.len());
    let lo = start.saturating_sub(CONTEXT).min(clip(start));
    (s(&chars[lo..clip(start)]), s(&chars[clip(end)..clip(end + CONTEXT)]))
}

fn common_suffix(a: &[char], b: &[char]) -> usize {
    let mut n = 0;
    while n < a.len() && n < b.len() && a[a.len() - 1 - n] == b[b.len() - 1 - n] {
        n += 1;
    }
    n
}

fn common_prefix(a: &[char], b: &[char]) -> usize {
    let mut n = 0;
    while n < a.len() && n < b.len() && a[n] == b[n] {
        n += 1;
    }
    n
}

fn score(
    text: &[char],
    block_section: &Option<String>,
    at: usize,
    end: usize,
    prefix: &[char],
    suffix: &[char],
    section: &Option<String>,
) -> f64 {
    let (before, after) = context_chars(text, at, end);
    let before: Vec<char> = before.chars().collect();
    let after: Vec<char> = after.chars().collect();
    let mut score = (common_suffix(&before, prefix) + common_prefix(&after, suffix)) as f64;
    if section.is_some() && block_section == section {
        score += 0.5;
    }
    score
}

fn found(block: &Block, text: &[char], at: usize, end: usize, exact: bool) -> Match {
    let (prefix, suffix) = context_chars(text, at, end);
    Match { pos: block.start + at, quote: s(&text[at..end]), prefix, suffix, section: block.section.clone(), exact }
}

fn block_at(blocks: &[Block], pos: usize) -> &Block {
    let mut owner = &blocks[0];
    for b in blocks {
        if b.start > pos {
            break;
        }
        owner = b;
    }
    owner
}

/// Exact match of a selection that runs over several blocks, in the blocks joined by spaces.
fn find_across(
    blocks: &[Block],
    quote: &str,
    prefix: &[char],
    suffix: &[char],
    section: &Option<String>,
) -> Option<Match> {
    if blocks.len() < 2 {
        return None;
    }
    let text = blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join(" ");
    let text_chars: Vec<char> = text.chars().collect();
    let quote_len = quote.chars().count();
    let mut best: Option<(f64, usize)> = None;
    for at in pystr::find_all_overlapping(&text, quote) {
        let owner = block_at(blocks, at);
        let sc = score(&text_chars, &owner.section, at, at + quote_len, prefix, suffix, section);
        if best.is_none_or(|(b, _)| sc > b) {
            best = Some((sc, at));
        }
    }
    let (_, at) = best?;
    let (before, after) = context_chars(&text_chars, at, at + quote_len);
    Some(Match {
        pos: at,
        quote: quote.to_string(),
        prefix: before,
        suffix: after,
        section: block_at(blocks, at).section.clone(),
        exact: true,
    })
}

/// `difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()` without the closing sentinel:
/// `(i, j, size)` triples of the non-empty matching blocks, in order.
fn matching_blocks(a: &[char], b: &[char]) -> Vec<(usize, usize, usize)> {
    let mut b2j: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, &c) in b.iter().enumerate() {
        b2j.entry(c).or_default().push(j);
    }
    let longest = |alo: usize, ahi: usize, blo: usize, bhi: usize| -> (usize, usize, usize) {
        let (mut besti, mut bestj, mut bestsize) = (alo, blo, 0usize);
        let mut j2len: HashMap<usize, usize> = HashMap::new();
        for (i, &ai) in a.iter().enumerate().take(ahi).skip(alo) {
            let mut newj2len: HashMap<usize, usize> = HashMap::new();
            if let Some(js) = b2j.get(&ai) {
                for &j in js {
                    if j < blo {
                        continue;
                    }
                    if j >= bhi {
                        break;
                    }
                    let k = if j > 0 { j2len.get(&(j - 1)).copied().unwrap_or(0) } else { 0 } + 1;
                    newj2len.insert(j, k);
                    if k > bestsize {
                        besti = i + 1 - k;
                        bestj = j + 1 - k;
                        bestsize = k;
                    }
                }
            }
            j2len = newj2len;
        }
        // with no junk elements these never extend a match that is already maximal; kept as difflib has them
        while besti > alo && bestj > blo && a[besti - 1] == b[bestj - 1] {
            besti -= 1;
            bestj -= 1;
            bestsize += 1;
        }
        while besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] == b[bestj + bestsize] {
            bestsize += 1;
        }
        (besti, bestj, bestsize)
    };
    let mut queue = vec![(0usize, a.len(), 0usize, b.len())];
    let mut blocks: Vec<(usize, usize, usize)> = Vec::new();
    while let Some((alo, ahi, blo, bhi)) = queue.pop() {
        let (i, j, k) = longest(alo, ahi, blo, bhi);
        if k > 0 {
            blocks.push((i, j, k));
            if alo < i && blo < j {
                queue.push((alo, i, blo, j));
            }
            if i + k < ahi && j + k < bhi {
                queue.push((i + k, ahi, j + k, bhi));
            }
        }
    }
    blocks.sort();
    let (mut i1, mut j1, mut k1) = (0usize, 0usize, 0usize);
    let mut merged = Vec::new();
    for (i2, j2, k2) in blocks {
        if i1 + k1 == i2 && j1 + k1 == j2 {
            k1 += k2;
        } else {
            if k1 > 0 {
                merged.push((i1, j1, k1));
            }
            (i1, j1, k1) = (i2, j2, k2);
        }
    }
    if k1 > 0 {
        merged.push((i1, j1, k1));
    }
    merged
}

/// Find a quote in the page blocks.
///
/// An exact occurrence wins (the best-scoring one by surrounding text and section when there are several). Failing
/// that, the closest block text with at least `MIN_FUZZY_RATIO` of the quote still in place counts, so a slightly
/// edited or moved selection stays attached. `quote` is the selected text, `prefix` the text that preceded it,
/// `suffix` the text that followed it and `section` the slug of the section it was in. Returns `None` when nothing
/// is close enough.
pub fn find_anchor(blocks: &[Block], quote: &str, prefix: &str, suffix: &str, section: Option<&str>) -> Option<Match> {
    let quote = normalize(quote);
    if quote.is_empty() {
        return None;
    }
    let quote_chars: Vec<char> = quote.chars().collect();
    let prefix_chars: Vec<char> = prefix.chars().collect();
    let suffix_chars: Vec<char> = suffix.chars().collect();
    let section: Option<String> = section.map(str::to_string);
    let texts: Vec<Vec<char>> = blocks.iter().map(|b| b.text.chars().collect()).collect();
    let mut best: Option<(f64, usize, usize)> = None;
    for (n, block) in blocks.iter().enumerate() {
        for at in pystr::find_all_overlapping(&block.text, &quote) {
            let sc =
                score(&texts[n], &block.section, at, at + quote_chars.len(), &prefix_chars, &suffix_chars, &section);
            if best.is_none_or(|(b, _, _)| sc > b) {
                best = Some((sc, n, at));
            }
        }
    }
    if let Some((_, n, at)) = best {
        return Some(found(&blocks[n], &texts[n], at, at + quote_chars.len(), true));
    }
    if let Some(across) = find_across(blocks, &quote, &prefix_chars, &suffix_chars, &section) {
        return Some(across);
    }
    if quote_chars.len() < MIN_FUZZY_QUOTE {
        return None;
    }
    let mut fuzzy: Option<(f64, usize, usize, usize)> = None;
    for (n, block) in blocks.iter().enumerate() {
        let parts = matching_blocks(&quote_chars, &texts[n]);
        if parts.is_empty() {
            continue;
        }
        let covered: usize = parts.iter().map(|p| p.2).sum();
        let ratio = covered as f64 / quote_chars.len() as f64;
        if ratio < MIN_FUZZY_RATIO {
            continue;
        }
        let at = parts[0].1;
        let last = parts[parts.len() - 1];
        let end = last.1 + last.2;
        if end - at > quote_chars.len() * 2 + 10 {
            continue;
        }
        let sc = ratio * 100.0 + score(&texts[n], &block.section, at, end, &prefix_chars, &suffix_chars, &section);
        if fuzzy.is_none_or(|(b, ..)| sc > b) {
            fuzzy = Some((sc, n, at, end));
        }
    }
    fuzzy.map(|(_, n, at, end)| found(&blocks[n], &texts[n], at, end, false))
}
