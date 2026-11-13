//! Tidy while importing Markdown (design/screens/docs-ai.md, D4) (`services/docs_ai/tidy.py`, lines 1 to 321).
//!
//! Deterministic, so it costs nothing and needs no model: split by top-level heading, count ticket keys (the chips
//! render from the text, so keys stay as text), find "see X" phrases that name an existing page, and move headings so
//! the page starts at `##`. "see X" links are candidates for review: they are only written into the text when the
//! person accepts them (`accept_see_links`). Nothing is imported here: the result is a preview, "what changed in
//! each page", and the files the existing import endpoint takes.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use kb_base::pytext;
use kb_db::Session;
use kb_db::entities::{docs_page, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use kb_doctext::docs_text::{heading_match, is_fence, slugify, ticket_matches};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::errors::{DocsAiError, Error};
use super::settings as svc_settings;

/// The largest file a tidy takes, in bytes.
pub const MAX_MARKDOWN: usize = 2 * 1024 * 1024;

/// `_SEE`: "see X" where X is a `[[link]]` or a plain name.
static SEE: LazyLock<FancyRegex> = LazyLock::new(|| {
    match FancyRegex::new(
        r#"\b([Ss]ee)\s+(?:the\s+)?(?:\[\[[^\]\n]*\]\]|[“\"']?([A-Za-z0-9][A-Za-z0-9 ›>/_-]{0,80}?)[”\"']?(?=[.,;:)!?]|\s*$|\s+(?:for|in|on|and|or|to|page|section)\b))"#,
    ) {
        Ok(re) => re,
        Err(err) => unreachable!("the pattern is a constant: {err}"),
    }
});
/// `_INLINE_CODE`.
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| match Regex::new(r"`[^`\n]*`") {
    Ok(re) => re,
    Err(err) => unreachable!("the pattern is a constant: {err}"),
});
/// `re.sub(r"\.(md|markdown)$", "", name, flags=re.I)`.
static EXTENSION: LazyLock<FancyRegex> = LazyLock::new(|| match FancyRegex::new(r"(?i)\.(?:md|markdown)(?=\n?\z)") {
    Ok(re) => re,
    Err(err) => unreachable!("the pattern is a constant: {err}"),
});

/// `_lines_outside_code`: true per line when it is prose (not inside a fenced code block).
pub fn lines_outside_code(lines: &[&str]) -> Vec<bool> {
    let mut out = Vec::with_capacity(lines.len());
    let mut fenced = false;
    for line in lines {
        if is_fence(line) {
            fenced = !fenced;
            out.push(false);
        } else {
            out.push(!fenced);
        }
    }
    out
}

/// `(preamble, [(heading text, body)], level)`: the text split at the top-level headings.
///
/// A lone top heading is the document's title: the sections are then the next level down.
pub fn split_sections(markdown: &str) -> (String, Vec<(String, String)>, usize) {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let prose = lines_outside_code(&lines);
    let heads: Vec<(usize, usize, String)> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| prose[*i])
        .filter_map(|(i, line)| heading_match(line).map(|m| (i, m.hashes.chars().count(), m.text)))
        .collect();
    if heads.is_empty() {
        return (markdown.to_string(), Vec::new(), 0);
    }
    let mut level = heads.iter().map(|h| h.1).min().unwrap_or(0);
    let mut tops: Vec<&(usize, usize, String)> = heads.iter().filter(|h| h.1 == level).collect();
    let mut title_line: Option<usize> = None;
    if tops.len() == 1 && heads.iter().any(|h| h.1 == level + 1) {
        title_line = Some(tops[0].0);
        level += 1;
        tops = heads.iter().filter(|h| h.1 == level).collect();
    }
    if tops.len() < 2 && title_line.is_none() {
        return (markdown.to_string(), Vec::new(), level);
    }
    let first = tops[0].0;
    let pre_start = title_line.map_or(0, |t| t + 1);
    let preamble = pytext::strip(&lines[pre_start.min(first)..first].join("\n")).to_string();
    let mut sections = Vec::new();
    for (k, (i, _lvl, text)) in tops.iter().map(|h| (h.0, h.1, &h.2)).enumerate() {
        let end = tops.get(k + 1).map_or(lines.len(), |next| next.0);
        let body = lines[(i + 1).min(end)..end].join("\n");
        sections.push((text.clone(), body.trim_matches('\n').to_string()));
    }
    (preamble, sections, level)
}

/// Move every heading so the shallowest one is `minimum` deep: `(text, levels moved)`.
pub fn shift_headings(markdown: &str, minimum: usize) -> (String, usize) {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let prose = lines_outside_code(&lines);
    let levels: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| prose[*i])
        .filter_map(|(_, line)| heading_match(line).map(|m| m.hashes.chars().count()))
        .collect();
    let Some(&lowest) = levels.iter().min() else { return (markdown.to_string(), 0) };
    if lowest >= minimum {
        return (markdown.to_string(), 0);
    }
    let shift = minimum - lowest;
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_string()).collect();
    for (i, line) in lines.iter().enumerate() {
        if prose[i] {
            if let Some(m) = heading_match(line) {
                out[i] = format!("{} {}", "#".repeat((m.hashes.chars().count() + shift).min(6)), m.text);
            }
        }
    }
    (out.join("\n"), shift)
}

/// Ticket keys written in prose (not in code), counted: `(key, count)` in the order they were first found.
pub fn ticket_keys(markdown: &str) -> Vec<(String, usize)> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let prose = lines_outside_code(&lines);
    let mut found: Vec<(String, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !prose[i] {
            continue;
        }
        let clean = INLINE_CODE.replace_all(line, "").into_owned();
        let chars: Vec<char> = clean.chars().collect();
        for (a, b) in ticket_matches(&chars) {
            let key: String = chars[a..b].iter().collect();
            match found.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 += 1,
                None => found.push((key, 1)),
            }
        }
    }
    found
}

/// `Counter.most_common(n)`: by count, highest first; equal counts stay in the order they were found.
fn most_common(counter: &[(String, usize)], n: Option<usize>) -> Vec<(String, usize)> {
    let mut sorted = counter.to_vec();
    sorted.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    if let Some(n) = n {
        sorted.truncate(n);
    }
    sorted
}

/// A "see X" phrase whose X is the title of a page.
#[derive(Debug, Clone, PartialEq)]
pub struct SeeCandidate {
    /// `l{line}c{start}`.
    pub id: String,
    /// The line, from 1.
    pub line: usize,
    /// The whole phrase (`see Architecture`).
    pub phrase: String,
    /// The page's title.
    pub title: String,
    /// Where the name starts in the line, in characters.
    pub start: usize,
    /// Where it ends.
    pub end: usize,
}

/// `m.start(group)` in characters.
fn char_index(text: &str, byte: usize) -> usize {
    text[..byte].chars().count()
}

/// "see X" phrases whose X is the title of a page (`titles`: lower-cased -> title).
pub fn see_candidates(markdown: &str, titles: &HashMap<String, String>) -> Vec<SeeCandidate> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let prose = lines_outside_code(&lines);
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !prose[i] {
            continue;
        }
        let clean = INLINE_CODE.replace_all(line, |caps: &regex::Captures<'_>| " ".repeat(caps[0].chars().count()));
        for caps in SEE.captures_iter(&clean).flatten() {
            let name = caps.get(2).map_or("", |m| m.as_str());
            let name = pytext::strip(name).to_lowercase();
            let Some(title) = titles.get(&name).filter(|t| !t.is_empty()) else { continue };
            let (Some(whole), Some(group)) = (caps.get(0), caps.get(2)) else { continue };
            let start = char_index(&clean, group.start());
            out.push(SeeCandidate {
                id: format!("l{}c{start}", i + 1),
                line: i + 1,
                phrase: whole.as_str().to_string(),
                title: title.clone(),
                start,
                end: start + group.as_str().chars().count(),
            });
        }
    }
    out
}

/// Write `[[Title]]` in place of the accepted candidates' page names.
pub fn apply_see_links(markdown: &str, accepted: &HashSet<String>, candidates: &[SeeCandidate]) -> String {
    let mut lines: Vec<Vec<char>> = markdown.split('\n').map(|l| l.chars().collect()).collect();
    let mut sorted: Vec<&SeeCandidate> = candidates.iter().collect();
    sorted.sort_by_key(|c| (c.line, std::cmp::Reverse(c.start)));
    for c in sorted {
        if !accepted.contains(&c.id) {
            continue;
        }
        let i = c.line - 1;
        let line = &lines[i];
        let mut start = c.start;
        // take a quote around the name with it
        if start > 0 && matches!(line.get(start - 1), Some('“' | '"' | '\'')) {
            start -= 1;
        }
        let mut end = c.end;
        if end < line.len() && matches!(line[end], '”' | '"' | '\'') {
            end += 1;
        }
        let mut rebuilt: Vec<char> = line[..start.min(line.len())].to_vec();
        rebuilt.extend(format!("[[{}]]", c.title).chars());
        rebuilt.extend(line[end.min(line.len())..].iter());
        lines[i] = rebuilt;
    }
    lines.iter().map(|l| l.iter().collect::<String>()).collect::<Vec<_>>().join("\n")
}

/// The upload the import endpoint takes: front matter carries the title.
fn file_for(title: &str, body: &str, taken: &mut HashSet<String>) -> Value {
    let slug = slugify(title);
    let base = if slug.is_empty() { "page".to_string() } else { slug };
    let mut name = base.clone();
    let mut n = 2;
    while taken.contains(&name) {
        name = format!("{base}-{n}");
        n += 1;
    }
    taken.insert(name.clone());
    let safe_title = title.replace('"', "'");
    json!({
        "path": format!("{name}.md"),
        "content": format!("---\ntitle: \"{safe_title}\"\n---\n\n{}\n", pytext::strip(body)),
    })
}

/// `str.title()`.
fn title_case(text: &str) -> String {
    let mut out = String::new();
    let mut prev_cased = false;
    for c in text.chars() {
        if c.is_lowercase() || c.is_uppercase() {
            if prev_cased {
                out.extend(c.to_lowercase());
            } else {
                out.extend(c.to_uppercase());
            }
            prev_cased = true;
        } else {
            out.push(c);
            prev_cased = false;
        }
    }
    out
}

/// Preview the tidied import: pages (with what changed in each), counts and the "see X" candidates.
///
/// `options`: `{split_by_heading, ticket_chips, see_links, heading_levels}`. `filename` is used for the title of a
/// page with no heading. `accept_see_links`: candidate ids the person accepted; the rest stay plain text.
pub async fn tidy(
    session: &Session,
    project_id: &str,
    markdown: &str,
    options: &Map<String, Value>,
    filename: &str,
    accept_see_links: Option<&[String]>,
) -> Result<Map<String, Value>, Error> {
    svc_settings::require_enabled(session, project_id).await?;
    if markdown.len() > MAX_MARKDOWN {
        return Err(DocsAiError::new("too_long", "That file is larger than 2 MB.").into());
    }
    let text = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let opt = |key: &str| options.get(key).is_some_and(kb_base::pyjson::truthy);
    let (split_by_heading, ticket_chips, see_links, heading_levels) =
        (opt("split_by_heading"), opt("ticket_chips"), opt("see_links"), opt("heading_levels"));
    let last = filename.rsplit('/').next().unwrap_or("");
    let stem = EXTENSION.replace(last, "").into_owned();
    let stem = if stem.is_empty() { "Import".to_string() } else { stem };
    let doc_title = pytext::strip(&stem.replace(['-', '_'], " ")).to_string();
    let doc_title = if doc_title.is_empty() { "Import".to_string() } else { title_case(&doc_title) };

    let mut sections: Vec<(String, String)> = Vec::new();
    let mut preamble = text.clone();
    let mut level = 0;
    if split_by_heading {
        (preamble, sections, level) = split_sections(&text);
    }
    // (title, body, changes)
    let mut pieces: Vec<(String, String, Vec<String>)> = Vec::new();
    if !sections.is_empty() {
        if !pytext::strip(&preamble).is_empty() {
            pieces.push((
                doc_title.clone(),
                preamble.clone(),
                vec![format!("Text before the first section, from {filename}")],
            ));
        }
        for (title, body) in &sections {
            pieces.push((title.clone(), body.clone(), vec![format!("Split from {filename}")]));
        }
    } else {
        pieces.push((doc_title.clone(), text.clone(), Vec::new()));
    }

    let mut existing: HashMap<String, String> = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(project_id))
        .filter(docs_page::Column::DeletedAt.is_null())
        .all(session)
        .await?
        .into_iter()
        .map(|p| (p.title.to_lowercase(), p.title))
        .collect();
    // pages this import makes can be linked to as well
    for (title, _b, _c) in &pieces {
        existing.entry(title.to_lowercase()).or_insert_with(|| title.clone());
    }

    let accepted: HashSet<String> = accept_see_links.unwrap_or(&[]).iter().cloned().collect();
    let mut pages: Vec<Value> = Vec::new();
    let mut all_keys: Vec<(String, usize)> = Vec::new();
    let mut candidates_out: Vec<Value> = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    for (idx, (title, body, changes)) in pieces.iter().enumerate() {
        let mut body = body.clone();
        let mut changes = changes.clone();
        if heading_levels {
            let (moved_body, moved) = shift_headings(&body, 2);
            body = moved_body;
            if moved > 0 {
                changes.push(format!(
                    "Headings moved down {moved} level{}, starting at ##",
                    if moved != 1 { "s" } else { "" }
                ));
            }
        }
        let keys = ticket_keys(&body);
        for (key, n) in &keys {
            match all_keys.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 += n,
                None => all_keys.push((key.clone(), *n)),
            }
        }
        if ticket_chips && !keys.is_empty() {
            let listed: Vec<String> = most_common(&keys, Some(6)).iter().map(|(k, n)| format!("{k} ×{n}")).collect();
            changes.push(format!("Ticket keys kept as text and shown as chips: {}", listed.join(", ")));
        }
        let others: HashMap<String, String> = existing
            .iter()
            .filter(|(_, v)| v.to_lowercase() != title.to_lowercase())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let prefix = format!("p{idx}");
        let cands: Vec<SeeCandidate> = see_candidates(&body, &others)
            .into_iter()
            .map(|c| SeeCandidate { id: format!("{prefix}{}", c.id), ..c })
            .collect();
        let mine: HashSet<String> = if see_links {
            cands.iter().filter(|c| accepted.contains(&c.id)).map(|c| c.id.clone()).collect()
        } else {
            HashSet::new()
        };
        if !mine.is_empty() {
            let local: Vec<SeeCandidate> =
                cands.iter().map(|c| SeeCandidate { id: c.id[prefix.len()..].to_string(), ..c.clone() }).collect();
            let local_mine: HashSet<String> = mine.iter().map(|m| m[prefix.len()..].to_string()).collect();
            body = apply_see_links(&body, &local_mine, &local);
            changes.push(format!("{} “see …” turned into [[links]]", mine.len()));
        }
        for c in &cands {
            candidates_out.push(json!({
                "id": c.id,
                "page_index": idx,
                "page_title": title,
                "line": c.line,
                "phrase": c.phrase,
                "title": c.title,
                "accepted": accepted.contains(&c.id),
            }));
        }
        if changes.is_empty() {
            changes.push("No changes".to_string());
        }
        let file = file_for(title, &body, &mut taken);
        pages.push(json!({"index": idx, "title": title, "markdown": body, "changes": changes, "file": file}));
    }

    let mut known: HashSet<String> = HashSet::new();
    if !all_keys.is_empty() {
        let keys: Vec<String> = all_keys.iter().map(|(k, _)| k.clone()).collect();
        let ids: Vec<String> = ticket::Entity::find()
            .select_only()
            .column(ticket::Column::Id)
            .filter(ticket::Column::ProjectId.eq(project_id))
            .filter(ticket::Column::Id.is_in(keys))
            .into_tuple::<String>()
            .all(session)
            .await?;
        known = ids.into_iter().collect();
    }
    let sections_found = split_sections(&text).1.len();
    let total: usize = all_keys.iter().map(|(_, n)| n).sum();
    let mut out = Map::new();
    out.insert(
        "options".into(),
        json!({
            "split_by_heading": split_by_heading,
            "ticket_chips": ticket_chips,
            "see_links": see_links,
            "heading_levels": heading_levels,
        }),
    );
    out.insert(
        "source".into(),
        json!({
            "filename": filename,
            "bytes": markdown.len(),
            "sections": if sections_found == 0 { 1 } else { sections_found },
            "split_level": level,
        }),
    );
    let key_rows: Vec<Value> = most_common(&all_keys, None)
        .iter()
        .map(|(k, n)| json!({"key": k, "count": n, "known": known.contains(k)}))
        .collect();
    out.insert(
        "counts".into(),
        json!({
            "pages": pages.len(),
            "ticket_keys": key_rows,
            "ticket_key_total": total,
            "see_links": candidates_out.len(),
        }),
    );
    out.insert("see_links".into(), Value::Array(candidates_out));
    out.insert("pages".into(), Value::Array(pages));
    out.insert("cost".into(), json!(0));
    Ok(out)
}
