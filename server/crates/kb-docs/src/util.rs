//! Small Python behaviors the Docs code leans on and no lower crate has: `str.casefold`, `html.escape`,
//! `unicodedata.normalize("NFC")`, `difflib.SequenceMatcher` and a few `str` helpers.

use std::collections::HashMap;
use std::hash::Hash;

use unicode_normalization::UnicodeNormalization;

/// `text.casefold()`. ASCII text, most of what a search walks, folds to its lower case without the Unicode tables.
pub fn casefold(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    caseless::default_case_fold_str(text)
}

/// `unicodedata.normalize("NFC", text)`.
pub fn nfc(text: &str) -> String {
    text.nfc().collect()
}

/// `html.escape(text)` (quotes escaped too).
pub fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

/// `len(text.split())`.
pub fn word_count(text: &str) -> usize {
    kb_base::pytext::split(text).len()
}

/// `text[start:end]` by characters (indexes already clamped by the caller).
pub fn char_slice(text: &str, start: usize, end: usize) -> String {
    text.chars().skip(start).take(end.saturating_sub(start)).collect()
}

/// `text.strip(chars)`.
pub fn strip_chars<'a>(text: &'a str, chars: &str) -> &'a str {
    text.trim_matches(|c| chars.contains(c))
}

/// What `difflib.SequenceMatcher.get_opcodes` calls a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tag {
    /// The same in both.
    Equal,
    /// Different in both, `a[i1:i2]` becomes `b[j1:j2]`.
    Replace,
    /// Only in `a`.
    Delete,
    /// Only in `b`.
    Insert,
}

/// `difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()` without the closing sentinel:
/// `(i, j, size)` triples of the non-empty matching blocks, in order.
pub fn matching_blocks<T: Eq + Hash>(a: &[T], b: &[T]) -> Vec<(usize, usize, usize)> {
    let mut b2j: HashMap<&T, Vec<usize>> = HashMap::new();
    for (j, c) in b.iter().enumerate() {
        b2j.entry(c).or_default().push(j);
    }
    let longest = |alo: usize, ahi: usize, blo: usize, bhi: usize| -> (usize, usize, usize) {
        let (mut besti, mut bestj, mut bestsize) = (alo, blo, 0usize);
        let mut j2len: HashMap<usize, usize> = HashMap::new();
        for (i, ai) in a.iter().enumerate().take(ahi).skip(alo) {
            let mut newj2len: HashMap<usize, usize> = HashMap::new();
            if let Some(js) = b2j.get(ai) {
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

/// `difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()`: `(tag, i1, i2, j1, j2)`.
pub fn opcodes<T: Eq + Hash>(a: &[T], b: &[T]) -> Vec<(Tag, usize, usize, usize, usize)> {
    let mut blocks = matching_blocks(a, b);
    blocks.push((a.len(), b.len(), 0));
    let (mut i, mut j) = (0usize, 0usize);
    let mut answer = Vec::new();
    for (ai, bj, size) in blocks {
        let tag = if i < ai && j < bj {
            Some(Tag::Replace)
        } else if i < ai {
            Some(Tag::Delete)
        } else if j < bj {
            Some(Tag::Insert)
        } else {
            None
        };
        if let Some(tag) = tag {
            answer.push((tag, i, ai, j, bj));
        }
        i = ai + size;
        j = bj + size;
        if size > 0 {
            answer.push((Tag::Equal, ai, i, bj, j));
        }
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opcodes_follow_difflib() {
        // difflib.SequenceMatcher(None, "qabxcd", "abycdf").get_opcodes() from the Python docs
        let a: Vec<char> = "qabxcd".chars().collect();
        let b: Vec<char> = "abycdf".chars().collect();
        use Tag::*;
        assert_eq!(
            opcodes(&a, &b),
            vec![
                (Delete, 0, 1, 0, 0),
                (Equal, 1, 3, 0, 2),
                (Replace, 3, 4, 2, 3),
                (Equal, 4, 6, 3, 5),
                (Insert, 6, 6, 5, 6)
            ]
        );
    }

    #[test]
    fn casefold_and_escape() {
        assert_eq!(casefold("Straße"), "strasse");
        assert_eq!(html_escape("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&#x27;");
        assert_eq!(nfc("e\u{301}"), "\u{e9}");
        assert_eq!(strip_chars("\"\"a\"b\"", "\""), "a\"b");
    }
}
