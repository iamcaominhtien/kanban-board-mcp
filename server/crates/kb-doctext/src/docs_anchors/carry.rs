//! Carry comment anchors across a publish. The old and new page text are diffed, first block by block and then
//! character by character inside a changed block, and each anchor moves with the edit that touched it. This replaces
//! searching for its quote again, which is first-come (an exact copy elsewhere won over a light edit in place) and
//! loses text that was rewritten.
//!
//! [`relocate`] is the fallback when there is no earlier text to diff against (a thread without a position, an
//! orphaned thread, a restore). It weighs every candidate on one scale (how much of the quote is there, how much of
//! its surrounding text, its section, its distance from where it was) instead of taking the first exact hit.

use serde::Serialize;

use super::{
    Block, CONTEXT, MAX_QUOTE, MIN_FUZZY_QUOTE, MIN_FUZZY_RATIO, Match, block_at, context_chars, found,
    matching_blocks, normalize, s, score,
};
use crate::pystr;

/// Least share of a quote that must survive an edit for the anchor to keep the edited text as its quote; below it,
/// the text counts as rewritten and the anchor takes the whole new block.
const MIN_EDITED_RATIO: f64 = 0.5;
/// Least share of the text around a quote (the quote and `CONTEXT` characters on each side) a new block must share
/// with the old one to count as its replacement in a hunk that is not one block for one.
const MIN_SHARED_RATIO: f64 = 0.3;
/// Share of its block a quote must make up for a rewrite of the block to hand the anchor the whole new block.
const MOST_OF_BLOCK: f64 = 0.6;

/// What an edit did to the text an anchor quotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    /// The quoted text is unchanged (it may have moved).
    Kept,
    /// The quoted text was edited; most of it is still there.
    Edited,
    /// The quoted text was replaced by other text in the same place.
    Rewritten,
}

/// Where an anchor ends up in the new page text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Carried {
    /// The anchor is on this text now, after the given change.
    Attached(Change, Match),
    /// The text was deleted and nothing took its place.
    Removed {
        /// Offset in the new page text where the text was.
        pos: usize,
        /// Slug of the section the spot is in.
        section: Option<String>,
        /// Index of the new block at or after the spot (`None` at the end of the page).
        next_block: Option<usize>,
    },
}

fn len(text: &str) -> usize {
    text.chars().count()
}

/// Offset of the end of the page text, blocks joined by one separator.
fn text_end(blocks: &[Block]) -> usize {
    blocks.last().map(|b| b.start + len(&b.text)).unwrap_or(0)
}

/// Map the start of old range `p` through matching parts (`(old, new, size)`) to the new text.
fn map_start(parts: &[(usize, usize, usize)], p: usize) -> usize {
    for &(i, j, k) in parts {
        if p < i + k {
            return if p >= i { j + p - i } else { j };
        }
    }
    parts.last().map(|&(_, j, k)| j + k).unwrap_or(0)
}

/// Map the (exclusive) end `e` of an old range through matching parts to the new text.
fn map_end(parts: &[(usize, usize, usize)], e: usize) -> usize {
    for &(i, j, k) in parts.iter().rev() {
        if i < e {
            return if e <= i + k { j + e - i } else { j + k };
        }
    }
    parts.first().map(|&(_, j, _)| j).unwrap_or(0)
}

/// How many characters of old range `[s, e)` are in the matching parts.
fn coverage(parts: &[(usize, usize, usize)], s: usize, e: usize) -> usize {
    parts.iter().map(|&(i, _, k)| (i + k).min(e).saturating_sub(i.max(s))).sum()
}

/// Carry an anchor from the old page text to the new one.
///
/// `old` and `new` are the blocks of the two versions ([`super::blocks_of`]); `old_pos` is where the anchor's quote
/// starts in the old page text and `quote` the quoted text. Unchanged blocks are paired by a diff, so of two
/// identical paragraphs the one the anchor was on keeps it. When the anchor's block changed, the anchor goes to the
/// block that replaced it (between the same unchanged neighbours): onto the edited quote when at least half of it
/// survives, else onto the whole new block. When nothing replaced it, the result says where it was.
///
/// Returns `None` when `quote` is not at `old_pos` in `old` (the stored position is stale), so the caller falls back
/// to [`relocate`].
pub fn carry_anchor(old: &[Block], new: &[Block], old_pos: usize, quote: &str) -> Option<Carried> {
    let quote = normalize(quote);
    let qlen = len(&quote);
    if qlen == 0 {
        return None;
    }
    let i = old.iter().rposition(|b| b.start <= old_pos)?;
    let otext: Vec<char> = old[i].text.chars().collect();
    let at = old_pos - old[i].start;
    if at >= otext.len() {
        return None;
    }
    let old_texts: Vec<&str> = old.iter().map(|b| b.text.as_str()).collect();
    let new_texts: Vec<&str> = new.iter().map(|b| b.text.as_str()).collect();
    let parts = matching_blocks(&old_texts, &new_texts);
    if at + qlen <= otext.len() {
        if s(&otext[at..at + qlen]) != quote {
            return None;
        }
        return Some(carry_in_block(old, new, &parts, i, at, at + qlen, &quote));
    }
    // a selection over several blocks: kept only while all its blocks are unchanged and still side by side
    let joined: Vec<char> = old_texts.join(" ").chars().collect();
    if old_pos + qlen > joined.len() || s(&joined[old_pos..old_pos + qlen]) != quote {
        return None;
    }
    let last = old.iter().rposition(|b| b.start < old_pos + qlen)?;
    let paired: Option<Vec<usize>> = (i..=last).map(|n| paired_with(&parts, n)).collect();
    if let Some(paired) = paired {
        if paired.windows(2).all(|w| w[1] == w[0] + 1) {
            let joined_new: Vec<char> = new_texts.join(" ").chars().collect();
            let pos = new[paired[0]].start + at;
            let (prefix, suffix) = context_chars(&joined_new, pos, pos + qlen);
            let section = new[paired[0]].section.clone();
            return Some(Carried::Attached(
                Change::Kept,
                Match { pos, quote: quote.clone(), prefix, suffix, section, exact: true },
            ));
        }
    }
    // The blocks were split up or changed: follow the part in the first block while it is most of the selection;
    // otherwise the selection is gone, and the spot is where that part went.
    let part = otext.len() - at;
    Some(match carry_in_block(old, new, &parts, i, at, otext.len(), &s(&otext[at..])) {
        Carried::Attached(_, m) if (part as f64) < qlen as f64 * 0.5 => {
            Carried::Removed { next_block: new.iter().rposition(|b| b.start <= m.pos), pos: m.pos, section: m.section }
        }
        Carried::Attached(Change::Kept, m) => Carried::Attached(Change::Edited, m),
        other => other,
    })
}

/// The new block an unchanged old block was paired with.
fn paired_with(parts: &[(usize, usize, usize)], n: usize) -> Option<usize> {
    parts.iter().find(|&&(a, _, k)| a <= n && n < a + k).map(|&(a, b, _)| b + n - a)
}

/// Carry old range `[s, e)` of old block `i` (whose text there is `quote`).
fn carry_in_block(
    old: &[Block],
    new: &[Block],
    parts: &[(usize, usize, usize)],
    i: usize,
    s_at: usize,
    e_at: usize,
    quote: &str,
) -> Carried {
    if let Some(n) = paired_with(parts, i) {
        let text: Vec<char> = new[n].text.chars().collect();
        return Carried::Attached(Change::Kept, found(&new[n], &text, s_at, e_at, true));
    }
    // the hunk the block is in: the new blocks between the same unchanged neighbours
    let (old_lo, new_lo) =
        parts.iter().filter(|&&(a, _, k)| a + k <= i).map(|&(a, b, k)| (a + k, b + k)).next_back().unwrap_or((0, 0));
    let new_hi = parts.iter().find(|&&(a, _, _)| a > i).map(|&(_, b, _)| b).unwrap_or(new.len());
    if new_lo >= new_hi {
        let before = new_lo.checked_sub(1).map(|n| &new[n]);
        let after = new.get(new_hi);
        return Carried::Removed {
            pos: after.map(|b| b.start).unwrap_or_else(|| text_end(new)),
            section: before.or(after).and_then(|b| b.section.clone()),
            next_block: after.map(|_| new_hi),
        };
    }
    let otext: Vec<char> = old[i].text.chars().collect();
    let qlen = e_at - s_at;
    let old_hi = parts.iter().find(|&&(a, _, _)| a > i).map(|&(a, _, _)| a).unwrap_or(old.len());
    let (old_n, new_n) = (old_hi - old_lo, new_hi - new_lo);
    let rank = i - old_lo;
    // The new block that took the old one's place: with as many new blocks as old ones in the hunk, the one at the
    // same rank; else the one sharing the most text around the quote (the quote and up to `CONTEXT` characters on
    // each side), not the first one that happens to contain the quote.
    let (w_lo, w_hi) = (s_at.saturating_sub(CONTEXT), (e_at + CONTEXT).min(otext.len()));
    let shared_with = |n: usize| {
        let ntext: Vec<char> = new[n].text.chars().collect();
        // runs of one or two letters are what any two sentences share; they say nothing about a replacement
        let runs: Vec<(usize, usize, usize)> =
            matching_blocks(&otext, &ntext).into_iter().filter(|&(_, _, k)| k >= 3).collect();
        coverage(&runs, w_lo, w_hi)
    };
    let (n, shared) = if old_n == new_n {
        (new_lo + rank, shared_with(new_lo + rank))
    } else {
        // (candidate, characters shared around the quote, distance from the old block's place in the hunk)
        let mut best: Option<(usize, usize, usize)> = None;
        for n in new_lo..new_hi {
            let shared = shared_with(n);
            let distance = (n - new_lo).abs_diff(rank);
            if best.is_none_or(|(_, k, d)| shared > k || (shared == k && distance < d)) {
                best = Some((n, shared, distance));
            }
        }
        let (n, shared, _) = best.expect("the hunk has at least one new block");
        (n, shared)
    };
    // It replaced the old block when it is the only old block of the hunk, when the hunk pairs blocks one to one,
    // or when it still shares a good part of the text around the quote. Otherwise a whole stretch of the page was
    // replaced by unrelated text, and the anchor's text counts as removed (the spot is that block).
    let replaced = old_n == 1 || old_n == new_n || shared as f64 >= (w_hi - w_lo) as f64 * MIN_SHARED_RATIO;
    let ntext: Vec<char> = new[n].text.chars().collect();
    let removed_at =
        |at: usize| Carried::Removed { pos: new[n].start + at, section: new[n].section.clone(), next_block: Some(n) };
    let hits = pystr::find_all_overlapping(&new[n].text, quote);
    let p = matching_blocks(&otext, &ntext);
    if !hits.is_empty() {
        // the quote itself survived in the changed block: keep it, at the copy nearest to where it maps
        let mapped = map_start(&p, s_at);
        let at = hits.into_iter().min_by_key(|&a| a.abs_diff(mapped)).expect("an occurrence was found above");
        return Carried::Attached(Change::Kept, found(&new[n], &ntext, at, at + qlen, true));
    }
    if !replaced {
        return removed_at(0);
    }
    let kept = coverage(&p, s_at, e_at);
    let (mut ms, mut me) = (map_start(&p, s_at), map_end(&p, e_at));
    // an edit inside a word takes the whole word ("five" -> "six" maps only the shared "i")
    while ms > 0 && ms < ntext.len() && pystr::is_word(ntext[ms]) && pystr::is_word(ntext[ms - 1]) {
        ms -= 1;
    }
    while me > 0 && me < ntext.len() && pystr::is_word(ntext[me]) && pystr::is_word(ntext[me - 1]) {
        me += 1;
    }
    while ms < me && pystr::is_space(ntext[ms]) {
        ms += 1;
    }
    while me > ms && pystr::is_space(ntext[me - 1]) {
        me -= 1;
    }
    if kept as f64 / qlen as f64 >= MIN_EDITED_RATIO && me > ms && me - ms <= qlen * 2 + 10 {
        return Carried::Attached(Change::Edited, found(&new[n], &ntext, ms, me, false));
    }
    // Rewritten: when the quote was most of its block, the whole new block replaced it; else the new text between
    // the unchanged words around it did (none there: that sentence was deleted from a paragraph that stays).
    if qlen as f64 >= otext.len() as f64 * MOST_OF_BLOCK || ntext.is_empty() {
        let end = ntext.len().min(MAX_QUOTE);
        return Carried::Attached(Change::Rewritten, found(&new[n], &ntext, 0, end, false));
    }
    // the replacement runs over all the new text there, up to the words kept on each side
    let kept_at = |c: usize| p.iter().any(|&(_, j, k)| k >= 3 && j <= c && c < j + k);
    while ms > 0 && !kept_at(ms - 1) {
        ms -= 1;
    }
    while me < ntext.len() && !kept_at(me) {
        me += 1;
    }
    // not the end of the sentence before it
    while ms < me && (pystr::is_space(ntext[ms]) || matches!(ntext[ms], '.' | ',' | ';' | ':' | '!' | '?')) {
        ms += 1;
    }
    while me > ms && pystr::is_space(ntext[me - 1]) {
        me -= 1;
    }
    // the new text there must hold at least one new word (not just a full stop left between kept words)
    let new_word = (ms..me).any(|c| pystr::is_word(ntext[c]) && !p.iter().any(|&(_, j, k)| j <= c && c < j + k));
    if new_word && me - ms <= qlen * 3 + 40 {
        return Carried::Attached(Change::Rewritten, found(&new[n], &ntext, ms, me, false));
    }
    removed_at(ms.min(ntext.len()))
}

/// Find a quote in the page blocks when there is no earlier text to carry it from.
///
/// Every candidate is weighed on one scale: an exact occurrence scores 100, an approximate one the share of the
/// quote it holds (at least `MIN_FUZZY_RATIO`) times 100; both add the characters of `prefix` / `suffix` found around
/// them and half a point for the same `section`. So an exact copy elsewhere no longer beats a lightly edited quote
/// whose surrounding text is still in place. Ties go to the candidate nearest `near` (an offset in the page text,
/// usually where the anchor was), then to the first. Returns `None` when nothing is close enough.
pub fn relocate(
    blocks: &[Block],
    quote: &str,
    prefix: &str,
    suffix: &str,
    section: Option<&str>,
    near: Option<usize>,
) -> Option<Match> {
    let quote = normalize(quote);
    if quote.is_empty() || blocks.is_empty() {
        return None;
    }
    let q: Vec<char> = quote.chars().collect();
    let prefix: Vec<char> = prefix.chars().collect();
    let suffix: Vec<char> = suffix.chars().collect();
    let section: Option<String> = section.map(str::to_string);
    let texts: Vec<Vec<char>> = blocks.iter().map(|b| b.text.chars().collect()).collect();
    // the best score with its match; ties broken by distance from `near`
    let mut best: Option<(f64, usize, Match)> = None;
    for (n, block) in blocks.iter().enumerate() {
        for at in pystr::find_all_overlapping(&block.text, &quote) {
            let sc = 100.0 + score(&texts[n], &block.section, at, at + q.len(), &prefix, &suffix, &section);
            offer(&mut best, near, sc, found(block, &texts[n], at, at + q.len(), true));
        }
    }
    if blocks.len() > 1 {
        let joined = blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join(" ");
        let jchars: Vec<char> = joined.chars().collect();
        for at in pystr::find_all_overlapping(&joined, &quote) {
            let owner = block_at(blocks, at);
            if at + q.len() <= owner.start + len(&owner.text) {
                continue; // inside one block: counted above
            }
            let sc = 100.0 + score(&jchars, &owner.section, at, at + q.len(), &prefix, &suffix, &section);
            let (before, after) = context_chars(&jchars, at, at + q.len());
            let m = Match {
                pos: at,
                quote: quote.clone(),
                prefix: before,
                suffix: after,
                section: owner.section.clone(),
                exact: true,
            };
            offer(&mut best, near, sc, m);
        }
    }
    // an approximate match can only win where an exact one did not find all of its surrounding text
    let ceiling = 100.0
        + prefix.len().min(CONTEXT) as f64
        + suffix.len().min(CONTEXT) as f64
        + if section.is_some() { 0.5 } else { 0.0 };
    let exact_score = best.as_ref().map(|(b, ..)| *b).unwrap_or(0.0);
    if q.len() >= MIN_FUZZY_QUOTE && exact_score < ceiling {
        for (n, block) in blocks.iter().enumerate() {
            let parts = matching_blocks(&q, &texts[n]);
            if parts.is_empty() {
                continue;
            }
            let covered: usize = parts.iter().map(|p| p.2).sum();
            let ratio = covered as f64 / q.len() as f64;
            if ratio < MIN_FUZZY_RATIO {
                continue;
            }
            // small stray pieces at the edges (a letter matched far away) do not stretch the match
            let mut core = &parts[..];
            while core.len() > 1 && core[0].2 <= 2 {
                core = &core[1..];
            }
            while core.len() > 1 && core[core.len() - 1].2 <= 2 {
                core = &core[..core.len() - 1];
            }
            let at = core[0].1;
            let last = core[core.len() - 1];
            let end = last.1 + last.2;
            if end - at > q.len() * 2 + 10 {
                continue;
            }
            let sc = ratio * 100.0 + score(&texts[n], &block.section, at, end, &prefix, &suffix, &section);
            offer(&mut best, near, sc, found(block, &texts[n], at, end, false));
        }
    }
    best.map(|(_, _, m)| m)
}

/// Keep `m` in `best` when it scores higher, or the same and nearer to `near`.
fn offer(best: &mut Option<(f64, usize, Match)>, near: Option<usize>, sc: f64, m: Match) {
    let distance = near.map(|n| n.abs_diff(m.pos)).unwrap_or(0);
    let better = match best {
        None => true,
        Some((b, d, _)) => sc > *b + 1e-9 || ((sc - *b).abs() <= 1e-9 && distance < *d),
    };
    if better {
        *best = Some((sc, distance, m));
    }
}
