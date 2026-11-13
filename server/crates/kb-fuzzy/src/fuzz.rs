//! `rapidfuzz.fuzz` scorers (`ratio`, `partial_ratio`, `token_sort_ratio`, `token_set_ratio`, `token_ratio`,
//! `partial_token_*`, `WRatio`, `QRatio`). Each returns a score between 0 and 100.
//!
//! The `*_cutoff` variants take rapidfuzz's `score_cutoff`: a score below it becomes 0.

use crate::utils::is_py_space;
use std::collections::{BTreeSet, HashMap};

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

fn cutoff_filter(score: f64, score_cutoff: Option<f64>) -> f64 {
    match score_cutoff {
        Some(c) if score < c => 0.0,
        _ => score,
    }
}

/// Length of the longest common subsequence (`LCSseq`), by dynamic programming.
fn lcs_dp(a: &[char], b: &[char]) -> usize {
    let mut row = vec![0usize; b.len() + 1];
    for &ca in a {
        let mut diag = 0;
        for (j, &cb) in b.iter().enumerate() {
            let up = row[j + 1];
            row[j + 1] = if ca == cb { diag + 1 } else { up.max(row[j]) };
            diag = up;
        }
    }
    row[b.len()]
}

/// Bit-parallel LCS (Hyyro) of a pattern of at most 64 characters against any text.
struct Pattern<'a> {
    chars: &'a [char],
    masks: Option<HashMap<char, u64>>,
}

impl<'a> Pattern<'a> {
    fn new(chars: &'a [char]) -> Self {
        let masks = (chars.len() <= 64).then(|| {
            let mut m: HashMap<char, u64> = HashMap::new();
            for (i, &c) in chars.iter().enumerate() {
                *m.entry(c).or_insert(0) |= 1u64 << i;
            }
            m
        });
        Pattern { chars, masks }
    }

    fn lcs(&self, text: &[char]) -> usize {
        let len = self.chars.len();
        if len == 0 {
            return 0;
        }
        let Some(masks) = &self.masks else {
            return lcs_dp(self.chars, text);
        };
        let full: u64 = if len == 64 { u64::MAX } else { (1u64 << len) - 1 };
        let mut s = full;
        for c in text {
            let matches = masks.get(c).copied().unwrap_or(0);
            let u = s & matches;
            s = s.wrapping_add(u) | s.wrapping_sub(u);
            s &= full;
        }
        len - (s.count_ones() as usize)
    }
}

/// `Indel.normalized_similarity` of a pattern against a text (0.0 to 1.0).
fn indel_norm_sim(pattern: &Pattern, text: &[char]) -> f64 {
    let maximum = pattern.chars.len() + text.len();
    let dist = maximum - 2 * pattern.lcs(text);
    let norm_dist = if maximum == 0 { 0.0 } else { dist as f64 / maximum as f64 };
    1.0 - norm_dist
}

fn indel_distance(a: &[char], b: &[char]) -> usize {
    a.len() + b.len() - 2 * Pattern::new(a).lcs(b)
}

fn ratio_chars(a: &[char], b: &[char]) -> f64 {
    indel_norm_sim(&Pattern::new(a), b) * 100.0
}

/// `fuzz.ratio`: normalized Indel similarity.
pub fn ratio(a: &str, b: &str) -> f64 {
    ratio_chars(&chars(a), &chars(b))
}

/// `fuzz.ratio(a, b, score_cutoff=...)`.
pub fn ratio_cutoff(a: &str, b: &str, score_cutoff: Option<f64>) -> f64 {
    cutoff_filter(ratio(a, b), score_cutoff)
}

/// `_partial_ratio_impl`: best ratio of `s1` against the windows of `s2` (`len(s1) <= len(s2)`), as a fraction.
fn partial_ratio_impl(s1: &[char], s2: &[char]) -> f64 {
    let set: BTreeSet<char> = s1.iter().copied().collect();
    let len1 = s1.len();
    let len2 = s2.len();
    if len1 == 0 {
        return 0.0;
    }
    let pattern = Pattern::new(s1);
    let mut best = 0.0f64;
    for i in 1..len1 {
        if !set.contains(&s2[i - 1]) {
            continue;
        }
        let r = indel_norm_sim(&pattern, &s2[..i]);
        if r > best {
            best = r;
            if best == 1.0 {
                return 100.0;
            }
        }
    }
    for i in 0..(len2 - len1) {
        if !set.contains(&s2[i + len1 - 1]) {
            continue;
        }
        let r = indel_norm_sim(&pattern, &s2[i..i + len1]);
        if r > best {
            best = r;
            if best == 1.0 {
                return 100.0;
            }
        }
    }
    for i in (len2 - len1)..len2 {
        if !set.contains(&s2[i]) {
            continue;
        }
        let r = indel_norm_sim(&pattern, &s2[i..]);
        if r > best {
            best = r;
            if best == 1.0 {
                return 100.0;
            }
        }
    }
    best * 100.0
}

fn partial_ratio_chars(s1: &[char], s2: &[char]) -> f64 {
    if s1.is_empty() && s2.is_empty() {
        return 100.0;
    }
    let (shorter, longer) = if s1.len() <= s2.len() { (s1, s2) } else { (s2, s1) };
    let mut res = partial_ratio_impl(shorter, longer);
    if res != 100.0 && s1.len() == s2.len() {
        let res2 = partial_ratio_impl(longer, shorter);
        if res2 > res {
            res = res2;
        }
    }
    res
}

/// `fuzz.partial_ratio`: best `ratio` of the shorter string against any window of the longer one.
pub fn partial_ratio(a: &str, b: &str) -> f64 {
    partial_ratio_chars(&chars(a), &chars(b))
}

/// `fuzz.partial_ratio(a, b, score_cutoff=...)`.
pub fn partial_ratio_cutoff(a: &str, b: &str, score_cutoff: Option<f64>) -> f64 {
    cutoff_filter(partial_ratio(a, b), score_cutoff)
}

/// `str.split()`: split on Python whitespace, dropping empty parts.
fn split_sequence(s: &[char]) -> Vec<Vec<char>> {
    s.split(|&c| is_py_space(c)).filter(|t| !t.is_empty()).map(<[char]>::to_vec).collect()
}

/// `" ".join(tokens)`.
fn join_tokens<'a, I: IntoIterator<Item = &'a Vec<char>>>(tokens: I) -> Vec<char> {
    let mut out = Vec::new();
    for (i, t) in tokens.into_iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.extend_from_slice(t);
    }
    out
}

fn sorted_joined(tokens: &[Vec<char>]) -> Vec<char> {
    let mut sorted: Vec<&Vec<char>> = tokens.iter().collect();
    sorted.sort();
    join_tokens(sorted)
}

fn token_sort_ratio_chars(a: &[char], b: &[char]) -> f64 {
    ratio_chars(&sorted_joined(&split_sequence(a)), &sorted_joined(&split_sequence(b)))
}

/// `fuzz.token_sort_ratio`: `ratio` after sorting the words of each string.
pub fn token_sort_ratio(a: &str, b: &str) -> f64 {
    token_sort_ratio_chars(&chars(a), &chars(b))
}

/// `fuzz.token_sort_ratio(a, b, score_cutoff=...)`.
pub fn token_sort_ratio_cutoff(a: &str, b: &str, score_cutoff: Option<f64>) -> f64 {
    cutoff_filter(token_sort_ratio(a, b), score_cutoff)
}

fn norm_distance(dist: usize, lensum: usize) -> f64 {
    if lensum == 0 { 100.0 } else { 100.0 - 100.0 * dist as f64 / lensum as f64 }
}

fn token_set_ratio_chars(a: &[char], b: &[char]) -> f64 {
    let tokens_a: BTreeSet<Vec<char>> = split_sequence(a).into_iter().collect();
    let tokens_b: BTreeSet<Vec<char>> = split_sequence(b).into_iter().collect();
    if tokens_a.is_empty() || tokens_b.is_empty() {
        return 0.0;
    }
    let intersect: Vec<&Vec<char>> = tokens_a.intersection(&tokens_b).collect();
    let diff_ab: Vec<&Vec<char>> = tokens_a.difference(&tokens_b).collect();
    let diff_ba: Vec<&Vec<char>> = tokens_b.difference(&tokens_a).collect();
    if !intersect.is_empty() && (diff_ab.is_empty() || diff_ba.is_empty()) {
        return 100.0;
    }
    // BTreeSet iterates in sorted (code point) order, like Python's `sorted(set)`.
    let diff_ab_joined = join_tokens(diff_ab);
    let diff_ba_joined = join_tokens(diff_ba);
    let ab_len = diff_ab_joined.len();
    let ba_len = diff_ba_joined.len();
    let sect_len = join_tokens(intersect).len();
    let nonzero = usize::from(sect_len != 0);
    let sect_ab_len = sect_len + nonzero + ab_len;
    let sect_ba_len = sect_len + nonzero + ba_len;
    let dist = indel_distance(&diff_ab_joined, &diff_ba_joined);
    let result = norm_distance(dist, sect_ab_len + sect_ba_len);
    if sect_len == 0 {
        return result;
    }
    let sect_ab_ratio = norm_distance(nonzero + ab_len, sect_len + sect_ab_len);
    let sect_ba_ratio = norm_distance(nonzero + ba_len, sect_len + sect_ba_len);
    result.max(sect_ab_ratio).max(sect_ba_ratio)
}

/// `fuzz.token_set_ratio`.
pub fn token_set_ratio(a: &str, b: &str) -> f64 {
    token_set_ratio_chars(&chars(a), &chars(b))
}

fn token_ratio_chars(a: &[char], b: &[char]) -> f64 {
    token_set_ratio_chars(a, b).max(token_sort_ratio_chars(a, b))
}

/// `fuzz.token_ratio`: the larger of `token_set_ratio` and `token_sort_ratio`.
pub fn token_ratio(a: &str, b: &str) -> f64 {
    token_ratio_chars(&chars(a), &chars(b))
}

/// `fuzz.partial_token_sort_ratio`.
pub fn partial_token_sort_ratio(a: &str, b: &str) -> f64 {
    partial_ratio_chars(&sorted_joined(&split_sequence(&chars(a))), &sorted_joined(&split_sequence(&chars(b))))
}

/// `fuzz.partial_token_set_ratio`.
pub fn partial_token_set_ratio(a: &str, b: &str) -> f64 {
    let tokens_a: BTreeSet<Vec<char>> = split_sequence(&chars(a)).into_iter().collect();
    let tokens_b: BTreeSet<Vec<char>> = split_sequence(&chars(b)).into_iter().collect();
    if tokens_a.is_empty() || tokens_b.is_empty() {
        return 0.0;
    }
    if tokens_a.intersection(&tokens_b).next().is_some() {
        return 100.0;
    }
    partial_ratio_chars(&join_tokens(tokens_a.difference(&tokens_b)), &join_tokens(tokens_b.difference(&tokens_a)))
}

fn partial_token_ratio_chars(a: &[char], b: &[char]) -> f64 {
    let split_a = split_sequence(a);
    let split_b = split_sequence(b);
    let tokens_a: BTreeSet<Vec<char>> = split_a.iter().cloned().collect();
    let tokens_b: BTreeSet<Vec<char>> = split_b.iter().cloned().collect();
    if tokens_a.intersection(&tokens_b).next().is_some() {
        return 100.0;
    }
    let diff_ab: Vec<&Vec<char>> = tokens_a.difference(&tokens_b).collect();
    let diff_ba: Vec<&Vec<char>> = tokens_b.difference(&tokens_a).collect();
    let result = partial_ratio_chars(&sorted_joined(&split_a), &sorted_joined(&split_b));
    // do not calculate the same partial_ratio twice
    if split_a.len() == diff_ab.len() && split_b.len() == diff_ba.len() {
        return result;
    }
    result.max(partial_ratio_chars(&join_tokens(diff_ab), &join_tokens(diff_ba)))
}

/// `fuzz.partial_token_ratio`: the larger of `partial_token_set_ratio` and `partial_token_sort_ratio`.
pub fn partial_token_ratio(a: &str, b: &str) -> f64 {
    partial_token_ratio_chars(&chars(a), &chars(b))
}

/// `fuzz.WRatio`: weighted ratio. Picks `ratio`, `token_ratio` or the partial scorers by the length ratio of the
/// strings (branches at 1.5 and 8.0), scaled by 0.95 / 0.9 / 0.6.
#[allow(non_snake_case)]
pub fn WRatio(a: &str, b: &str) -> f64 {
    wratio(a, b)
}

/// `fuzz.WRatio` under a snake_case name.
pub fn wratio(a: &str, b: &str) -> f64 {
    const UNBASE_SCALE: f64 = 0.95;
    let s1 = chars(a);
    let s2 = chars(b);
    if s1.is_empty() || s2.is_empty() {
        return 0.0;
    }
    let len1 = s1.len() as f64;
    let len2 = s2.len() as f64;
    let len_ratio = if len1 > len2 { len1 / len2 } else { len2 / len1 };
    let end_ratio = ratio_chars(&s1, &s2);
    if len_ratio < 1.5 {
        return end_ratio.max(token_ratio_chars(&s1, &s2) * UNBASE_SCALE);
    }
    let partial_scale = if len_ratio <= 8.0 { 0.9 } else { 0.6 };
    let end_ratio = end_ratio.max(partial_ratio_chars(&s1, &s2) * partial_scale);
    end_ratio.max(partial_token_ratio_chars(&s1, &s2) * UNBASE_SCALE * partial_scale)
}

/// `fuzz.WRatio(a, b, score_cutoff=...)`.
pub fn wratio_cutoff(a: &str, b: &str, score_cutoff: Option<f64>) -> f64 {
    cutoff_filter(wratio(a, b), score_cutoff)
}

/// `fuzz.QRatio`: `ratio`, but 0 when either string is empty.
pub fn qratio(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() { 0.0 } else { ratio(a, b) }
}
