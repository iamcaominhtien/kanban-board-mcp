//! `services/docs_edit.py`: edit a part of a Docs page instead of the whole page: one section, or one passage.
//!
//! Pure functions over the page's Markdown, so an AI fixes one line of a long page without sending the page back (and
//! without overwriting what a person changed elsewhere in the meantime). The MCP action `docs_write(edit)` reads the
//! page, applies the edits here, and publishes the result as one new version through the usual `update` path.
//!
//! Safety: a passage edit names the exact text it replaces, so it fails when that text changed. A section edit made
//! from an older `base_version` goes on only when that section still reads as it did in that version.

use std::collections::HashMap;

use caseless::default_case_fold_str as casefold;
use serde::Serialize;

use crate::docs_text::{heading_match, is_fence, slugify, strip_inline};
use crate::pystr;

/// The modes of `edit_section`.
pub const MODES: [&str; 5] = ["replace", "append", "prepend", "before", "after"];

/// An edit that cannot be applied as asked; the message says how to fix the call (`EditError(ValueError)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditError(pub String);

impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EditError {}

fn err<T>(message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError(message.into()))
}

/// A heading and the lines it owns (up to the next heading of the same or a higher level).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Section {
    /// Heading level, 1 to 6.
    pub level: usize,
    /// Heading text as plain text.
    pub text: String,
    /// The slug.
    pub slug: String,
    /// Line index of the heading.
    pub start: usize,
    /// Line index after the section's last line (sub-sections included).
    pub end: usize,
}

/// The page's sections in order, with the same slugs as `heading_anchors` (duplicates get -2, -3...).
pub fn sections(markdown: &str) -> Vec<Section> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut found: Vec<(usize, usize, String)> = Vec::new();
    let mut in_fence = false;
    for (i, line) in lines.iter().enumerate() {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(m) = heading_match(line) {
            found.push((i, m.hashes.len(), strip_inline(&m.text)));
        }
    }
    let mut out = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (n, (i, level, text)) in found.iter().enumerate() {
        let mut end = lines.len();
        for (j, lvl, _) in &found[n + 1..] {
            if lvl <= level {
                end = *j;
                break;
            }
        }
        let mut base = slugify(text);
        if base.is_empty() {
            base = "section".to_string();
        }
        let count = seen.get(&base).copied().unwrap_or(0) + 1;
        seen.insert(base.clone(), count);
        let slug = if count == 1 { base } else { format!("{base}-{count}") };
        out.push(Section { level: *level, text: text.clone(), slug, start: *i, end });
    }
    out
}

/// `_key`: the heading text or slug a name stands for, case-folded.
pub fn key(name: &str) -> String {
    let name = pystr::strip(pystr::lstrip_chars(pystr::strip(name), "#"));
    // "[[Page#Section]]" or "Page#Section": the part after the last '#'
    let name = match name.rsplit_once('#') {
        Some((_, last)) => last,
        None => name,
    };
    casefold(pystr::strip_chars(name, " []"))
}

/// The section a heading text or slug names (case-insensitive; '## Endpoints', 'endpoints', 'API#Endpoints').
pub fn find_section(markdown: &str, name: &str) -> Result<Section, EditError> {
    let all = sections(markdown);
    let key = key(name);
    if key.is_empty() {
        return err("section: give a heading's text or slug.");
    }
    let by_text: Vec<&Section> = all.iter().filter(|s| casefold(&s.text) == key).collect();
    if by_text.len() == 1 {
        return Ok(by_text[0].clone());
    }
    let key_slug = slugify(&key);
    let by_slug: Vec<&Section> = all.iter().filter(|s| s.slug == key || s.slug == key_slug).collect();
    if by_slug.len() == 1 && by_text.is_empty() {
        return Ok(by_slug[0].clone());
    }
    if !by_text.is_empty() || by_slug.len() > 1 {
        let dup = if by_text.is_empty() { &by_slug } else { &by_text };
        let slugs = dup.iter().map(|s| s.slug.as_str()).collect::<Vec<_>>().join(", ");
        return err(format!("section '{name}': {} headings have that name. Name one by its slug: {slugs}.", dup.len()));
    }
    let have = if all.is_empty() {
        "none (the page has no headings)".to_string()
    } else {
        all.iter().map(|s| format!("'{}'", s.text)).collect::<Vec<_>>().join(", ")
    };
    err(format!(
        "section '{name}' is not on the page. Its headings: {have}. \
         To add a new section, use mode='after' on an existing one, or mode='append' with no section."
    ))
}

/// The Markdown of one section, its heading line included.
pub fn section_text(markdown: &str, name: &str) -> Result<String, EditError> {
    let s = find_section(markdown, name)?;
    let lines: Vec<&str> = markdown.split('\n').collect();
    Ok(lines[s.start..s.end].join("\n").trim_matches('\n').to_string())
}

/// `_block`: `text.strip("\n").split("\n")`.
pub fn block(text: &str) -> Vec<String> {
    text.trim_matches('\n').split('\n').map(str::to_string).collect()
}

/// `_join`: the lines as a page: one blank line at most between blocks and one newline at the end.
pub fn join(lines: &[String]) -> String {
    let mut out = lines.join("\n");
    // keep one blank line between blocks
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    format!("{}\n", out.trim_matches('\n'))
}

/// `_splice`: put `new` in place of `lines[at..end]`, with a blank line kept on each side that touches text.
pub fn splice(lines: &[String], at: usize, end: usize, new: Vec<String>) -> Vec<String> {
    let before = &lines[..at];
    let after = &lines[end..];
    let mut new = new;
    if before.last().is_some_and(|l| !pystr::strip(l).is_empty()) {
        new.insert(0, String::new());
    }
    if after.first().is_some_and(|l| !pystr::strip(l).is_empty()) {
        new.push(String::new());
    }
    let mut out = before.to_vec();
    out.extend(new);
    out.extend(after.iter().cloned());
    out
}

fn owned_lines(markdown: &str) -> Vec<String> {
    markdown.split('\n').map(str::to_string).collect()
}

/// Change one section.
///
/// `name` is a heading text or slug. `new` is the Markdown to put in: with mode `replace`, text that starts with a
/// heading of the section's level replaces the heading too (a rename); otherwise it replaces the body under the
/// heading, which stays. `mode` is `replace`, `append` (end of the section, after its sub-sections), `prepend` (just
/// under the heading), or `before` / `after` (a new block before or after the whole section, e.g. a new section).
pub fn edit_section(markdown: &str, name: &str, new: &str, mode: &str) -> Result<String, EditError> {
    if !MODES.contains(&mode) {
        return err(format!("mode: one of {}.", MODES.join(", ")));
    }
    let s = find_section(markdown, name)?;
    let lines = owned_lines(markdown);
    let blk = block(new);
    if mode == "replace" {
        let head = blk.first().and_then(|b| heading_match(b));
        if head.is_some_and(|h| h.hashes.len() == s.level) {
            return Ok(join(&splice(&lines, s.start, s.end, blk)));
        }
        let body = if pystr::strip(new).is_empty() {
            Vec::new()
        } else {
            let mut body = vec![String::new()];
            body.extend(blk);
            body
        };
        return Ok(join(&splice(&lines, s.start + 1, s.end, body)));
    }
    if mode == "prepend" {
        return Ok(join(&splice(&lines, s.start + 1, s.start + 1, blk)));
    }
    if mode == "before" {
        return Ok(join(&splice(&lines, s.start, s.start, blk)));
    }
    // append and after: at the end of the section, before its trailing blank lines
    let mut end = s.end;
    while end > s.start + 1 && pystr::strip(&lines[end - 1]).is_empty() {
        end -= 1;
    }
    Ok(join(&splice(&lines, end, end, blk)))
}

/// Replace the one place where `find` occurs (or put `new` before / after it).
///
/// `find` is exact page Markdown (as docs_read(get) returns it), unique on the page; it may span lines.
pub fn edit_passage(markdown: &str, find: &str, new: &str, mode: &str) -> Result<String, EditError> {
    if !matches!(mode, "replace" | "before" | "after") {
        return err("mode with find: replace, before or after.");
    }
    if find.is_empty() {
        return err("find: the exact text to change, copied from docs_read(get).");
    }
    let count = markdown.matches(find).count();
    if count == 0 {
        let mut hint = "";
        if pystr::squash(markdown).contains(&pystr::squash(find)) {
            hint = " It is there with other spaces or line breaks: copy it exactly.";
        }
        return err(format!(
            "find: that text is not on the page (it may have been changed since you read it). \
             Read the page again with docs_read(get) and copy the text exactly.{hint}"
        ));
    }
    if count > 1 {
        return err(format!(
            "find: that text is on the page {count} times. Add a few words around it so it names one place."
        ));
    }
    let at = markdown.find(find).unwrap_or(0);
    Ok(match mode {
        "replace" => format!("{}{new}{}", &markdown[..at], &markdown[at + find.len()..]),
        "before" => format!("{}{new}{}", &markdown[..at], &markdown[at..]),
        _ => format!("{}{new}{}", &markdown[..at + find.len()], &markdown[at + find.len()..]),
    })
}

/// `new` as the last block of the page.
pub fn append_page(markdown: &str, new: &str) -> String {
    let lines: Vec<String> = if pystr::strip(markdown).is_empty() {
        Vec::new()
    } else {
        markdown.trim_end_matches('\n').split('\n').map(str::to_string).collect()
    };
    let n = lines.len();
    join(&splice(&lines, n, n, block(new)))
}

/// One edit `{section | find, markdown, mode}` as `apply` reads it (the keys of the dict the MCP action passes).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Edit {
    /// The new text (`edit.get("markdown")`); `None` when the key is missing or null.
    pub markdown: Option<String>,
    /// `replace`, `append`... (`edit.get("mode") or "replace"`).
    pub mode: Option<String>,
    /// A heading's text or slug.
    pub section: Option<String>,
    /// Exact text to change.
    pub find: Option<String>,
}

/// Apply one edit {section | find, markdown, mode} to the page.
///
/// `markdown` is the page as it is now. `base` is the page as the editor read it (its base_version), when older than
/// now: a section edit goes on only when that section reads the same in both; a passage edit is checked by its `find`
/// text.
pub fn apply(markdown: &str, edit: &Edit, base: Option<&str>) -> Result<String, EditError> {
    let Some(new) = edit.markdown.as_deref() else {
        return err("markdown: the new text.");
    };
    let mode = match edit.mode.as_deref() {
        Some(m) if !m.is_empty() => m,
        _ => "replace",
    };
    let section = edit.section.as_deref().filter(|s| !s.is_empty());
    let find = edit.find.as_deref();
    if section.is_some() && find.is_some_and(|f| !f.is_empty()) {
        return err("Give section or find, not both.");
    }
    if let Some(find) = find {
        return edit_passage(markdown, find, new, mode);
    }
    if let Some(section) = section {
        if let Some(base) = base {
            if base != markdown {
                let then = section_text(base, section).ok();
                let now = section_text(markdown, section)?;
                if then.as_deref() != Some(now.as_str()) {
                    return err(format!(
                        "conflict: section '{section}' was changed since the version you read. It now reads:\n\n{now}\n\n\
                         Apply your change to this text and retry with the page's current version as base_version."
                    ));
                }
            }
        }
        return edit_section(markdown, section, new, mode);
    }
    if mode != "append" {
        return err(
            "Name what to change: section (a heading) or find (exact text); or mode='append' to add to the end.",
        );
    }
    Ok(append_page(markdown, new))
}
