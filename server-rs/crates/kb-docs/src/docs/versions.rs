//! Drafts, following, "seen", publish, versions, diff and restore (`services/docs.py` lines 838-1333).

use std::collections::HashMap;

use kb_base::{activity, time};
use kb_db::Session;
use kb_db::entities::{
    docs_anchor_aliases, docs_draft, docs_page, docs_page_seen, docs_version, member, notify_follow,
};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter, QueryOrder, Set,
};
use kb_doctext::docs_text::{DocsError, heading_anchors, heading_match, strip_inline};
use kb_draw::diagrams;
use serde_json::{Map, Value, json};

use super::pages::{check_markdown, clean_title, draft_for, get_page, latest_version, opt, page_detail, project};
use super::refs::{refresh_link_targets, reindex_links};
use crate::util::{Tag, opcodes, word_count};
use crate::{Result, docs_err, docs_search, hooks};

/// Save the caller's draft of a page.
///
/// `title` keeps the current one when none; `base_version` is the version the draft was started from (default the
/// current one). Returns the page detail including the draft.
pub async fn save_draft(
    session: &Session,
    page_id: &str,
    markdown: &str,
    title: Option<&str>,
    base_version: Option<i32>,
) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, true).await?;
    check_markdown(markdown)?;
    let actor = activity::current_actor();
    let draft = draft_for(session, &page.id, &actor).await?;
    let new_title = match title {
        Some(t) => Some(clean_title(Some(t))?),
        None => None,
    };
    match draft {
        None => {
            let mut row = docs_draft::new();
            row.page_id = Set(page.id.clone());
            row.author = Set(actor);
            row.title = Set(new_title.filter(|t| !t.is_empty()).unwrap_or_else(|| page.title.clone()));
            row.markdown = Set(markdown.to_string());
            row.base_version = Set(base_version.unwrap_or(page.version));
            row.insert(session).await?;
        }
        Some(draft) => {
            let saves = draft.saves + 1;
            let mut row = draft.into_active_model();
            row.markdown = Set(markdown.to_string());
            row.saves = Set(saves);
            if let Some(t) = new_title.filter(|t| !t.is_empty()) {
                row.title = Set(t);
            }
            if let Some(b) = base_version {
                row.base_version = Set(b);
            }
            row.updated_at = Set(time::now_iso());
            row.update(session).await?;
        }
    }
    session.commit().await?;
    page_detail(session, page_id).await
}

/// Return who follows a project's Docs space: `{following, count, names}`; `count` and `names` leave out the
/// caller, who is not notified of their own publishes (names: at most 3, for the avatars).
pub async fn followers(session: &Session, project_id: &str) -> Result<Map<String, Value>> {
    project(session, project_id, false).await?;
    let me = kb_notify::person_key(Some(&activity::current_actor()));
    let rows = notify_follow::Entity::find()
        .filter(notify_follow::Column::Scope.eq("space"))
        .filter(notify_follow::Column::ScopeId.eq(project_id))
        .filter(notify_follow::Column::Level.ne("mute"))
        .order_by_asc(notify_follow::Column::CreatedAt)
        .all(session)
        .await?;
    let names: HashMap<String, String> = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .all(session)
        .await?
        .into_iter()
        .map(|m| (kb_notify::person_key(Some(&m.name)), m.name))
        .collect();
    let others: Vec<String> = rows
        .iter()
        .filter(|r| r.recipient != me)
        .map(|r| names.get(&r.recipient).cloned().unwrap_or_else(|| r.recipient.clone()))
        .collect();
    let mut out = Map::new();
    out.insert("following".into(), json!(rows.iter().any(|r| r.recipient == me)));
    out.insert("count".into(), json!(others.len()));
    out.insert("names".into(), json!(others.iter().take(3).collect::<Vec<_>>()));
    Ok(out)
}

/// Follow or unfollow a project's Docs space as the caller (idempotent); the same payload as `followers`.
pub async fn set_following(session: &Session, project_id: &str, on: bool) -> Result<Map<String, Value>> {
    project(session, project_id, false).await?;
    let me = kb_notify::person_key(Some(&activity::current_actor()));
    kb_notify::set_follow(
        session,
        &me,
        "space",
        project_id,
        if on { Some("follow") } else { None },
        Some(project_id),
        None,
        "",
    )
    .await?;
    followers(session, project_id).await
}

async fn seen_row(session: &Session, page_id: &str, viewer: &str) -> Result<Option<docs_page_seen::Model>> {
    Ok(docs_page_seen::Entity::find()
        .filter(docs_page_seen::Column::PageId.eq(page_id))
        .filter(docs_page_seen::Column::Viewer.eq(viewer))
        .one(session)
        .await?)
}

/// Return the version of a page the caller last viewed: `{version}` (null when never viewed).
pub async fn get_seen(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let row = seen_row(session, &page.id, &activity::current_actor()).await?;
    let mut out = Map::new();
    out.insert("version".into(), json!(row.map(|r| r.version)));
    Ok(out)
}

/// Record that the caller has viewed a version of a page (clamped to the current version): `{version}`.
pub async fn mark_seen(session: &Session, page_id: &str, version: i64) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let actor = activity::current_actor();
    let version = version.min(i64::from(page.version)).max(0) as i32;
    match seen_row(session, &page.id, &actor).await? {
        None => {
            let mut row = docs_page_seen::new();
            row.page_id = Set(page.id.clone());
            row.viewer = Set(actor);
            row.version = Set(version);
            row.insert(session).await?;
        }
        Some(row) => {
            let mut row = row.into_active_model();
            row.version = Set(version);
            row.seen_at = Set(time::now_iso());
            row.update(session).await?;
        }
    }
    session.commit().await?;
    let mut out = Map::new();
    out.insert("version".into(), json!(version));
    Ok(out)
}

/// Delete the caller's draft of a page.
pub async fn discard_draft(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, true).await?;
    if let Some(draft) = draft_for(session, &page.id, &activity::current_actor()).await? {
        draft.delete(session).await?;
        session.commit().await?;
    }
    page_detail(session, page_id).await
}

/// Publish content as a new version.
///
/// `base_version` is the version the edit started from and must equal the current version; `markdown` defaults to
/// the caller's draft, `title` to the draft's. Fails with 409 if `base_version` is stale, 422 if there is nothing to
/// publish. Returns the published page's detail.
pub async fn publish_page(
    session: &Session,
    page_id: &str,
    base_version: i64,
    note: Option<&str>,
    markdown: Option<&str>,
    title: Option<&str>,
) -> Result<Map<String, Value>> {
    let mut page = get_page(session, page_id, false, true).await?;
    let actor = activity::current_actor();
    if base_version != i64::from(page.version) {
        let latest = latest_version(session, &page).await?;
        return Err(DocsError::new(
            409,
            "conflict",
            format!("Page was published as v{} since you started from v{base_version}", page.version),
        )
        .with("latest_version", page.version)
        .with("latest_author", latest.as_ref().map(|l| l.author.clone()))
        .with("latest_at", latest.as_ref().map(|l| l.created_at.clone()))
        .into());
    }
    let draft = draft_for(session, &page.id, &actor).await?;
    let markdown = match markdown {
        Some(m) => m.to_string(),
        None => match &draft {
            Some(d) => d.markdown.clone(),
            None => return docs_err(422, "nothing_to_publish", "There is no draft to publish"),
        },
    };
    check_markdown(&markdown)?;
    let wanted = title.filter(|t| !t.is_empty()).map(str::to_string).unwrap_or_else(|| match &draft {
        Some(d) => d.title.clone(),
        None => page.title.clone(),
    });
    let new_title = clean_title(Some(&wanted))?;
    commit_version(session, &mut page, &markdown, &new_title, &actor, note, draft, true).await
}

/// Write a page's next version: the page row, the version row, link index, aliases, search index and comment
/// anchors. With `commit` false the caller commits (and gets an empty map).
pub async fn commit_version(
    session: &Session,
    page: &mut docs_page::Model,
    markdown: &str,
    title: &str,
    author: &str,
    note: Option<&str>,
    draft: Option<docs_draft::Model>,
    commit: bool,
) -> Result<Map<String, Value>> {
    let previous = latest_version(session, page).await?;
    let mut row = page.clone().into_active_model();
    row.version = Set(page.version + 1);
    row.status = Set("published".to_string());
    row.title = Set(title.to_string());
    row.updated_at = Set(time::now_iso());
    row.updated_by = Set(author.to_string());
    *page = row.update(session).await?;
    let note = kb_base::pytext::strip(note.unwrap_or("")).to_string();
    let mut version = docs_version::new();
    version.page_id = Set(page.id.clone());
    version.version = Set(page.version);
    version.title = Set(title.to_string());
    version.markdown = Set(markdown.to_string());
    version.author = Set(author.to_string());
    version.note = Set(if note.is_empty() { None } else { Some(note) });
    version.diagram_versions = Set(diagrams::pin_versions(session, markdown).await?);
    version.with_ai = Set(
        draft.as_ref().is_some_and(|d| d.ai_source.as_deref().is_some_and(|s| !s.is_empty())) || hooks::ai_acting()
    );
    version.insert(session).await?;
    if let Some(draft) = draft {
        draft.delete(session).await?;
    }
    update_aliases(session, page, previous.as_ref().map(|p| p.markdown.as_str()).unwrap_or(""), markdown).await?;
    reindex_links(session, page, markdown).await?;
    refresh_link_targets(session, &page.project_id).await?;
    docs_search::reindex(session, std::slice::from_ref(&page.id)).await?;
    // late import in Python: docs_comments builds on this module
    if let Some(comments) = hooks::comments() {
        comments.rematch_page(session, page, markdown).await?;
    }
    if !commit {
        return Ok(Map::new());
    }
    session.commit().await?;
    page_detail(session, &page.id).await
}

/// Remember renamed headings (a slug that vanished while a new one took its place).
async fn update_aliases(session: &Session, page: &docs_page::Model, old_md: &str, new_md: &str) -> Result<()> {
    let old: Vec<String> = heading_anchors(old_md).into_iter().map(|h| h.slug).collect();
    let new: Vec<String> = heading_anchors(new_md).into_iter().map(|h| h.slug).collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for (tag, i1, i2, j1, j2) in opcodes(&old, &new) {
        if tag == Tag::Replace && i2 - i1 == j2 - j1 {
            pairs.extend(old[i1..i2].iter().cloned().zip(new[j1..j2].iter().cloned()));
        }
    }
    struct Alias {
        row: Option<docs_anchor_aliases::Model>,
        old_slug: String,
        new_slug: String,
        changed: bool,
    }
    let mut existing: Vec<Alias> = docs_anchor_aliases::Entity::find()
        .filter(docs_anchor_aliases::Column::PageId.eq(page.id.as_str()))
        .all(session)
        .await?
        .into_iter()
        .map(|r| Alias { old_slug: r.old_slug.clone(), new_slug: r.new_slug.clone(), row: Some(r), changed: false })
        .collect();
    let live: std::collections::HashSet<&String> = new.iter().collect();
    for (old_slug, new_slug) in &pairs {
        if live.contains(old_slug) {
            continue;
        }
        for row in existing.iter_mut() {
            if row.new_slug == *old_slug {
                // a chain: A -> B becomes A -> C
                row.new_slug = new_slug.clone();
                row.changed = true;
            }
        }
        match existing.iter_mut().find(|r| r.old_slug == *old_slug) {
            Some(m) => {
                m.new_slug = new_slug.clone();
                m.changed = true;
            }
            None => existing.push(Alias {
                row: None,
                old_slug: old_slug.clone(),
                new_slug: new_slug.clone(),
                changed: true,
            }),
        }
    }
    for alias in existing {
        let drop = live.contains(&alias.old_slug) || alias.old_slug == alias.new_slug;
        match (alias.row, drop) {
            (Some(row), true) => {
                row.delete(session).await?;
            }
            (Some(row), false) if alias.changed => {
                let mut active = row.into_active_model();
                active.new_slug = Set(alias.new_slug);
                active.update(session).await?;
            }
            (None, false) => {
                let mut row = docs_anchor_aliases::new();
                row.page_id = Set(page.id.clone());
                row.old_slug = Set(alias.old_slug);
                row.new_slug = Set(alias.new_slug);
                row.insert(session).await?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// List a page's versions, newest first.
pub async fn list_versions(session: &Session, page_id: &str) -> Result<Vec<Value>> {
    get_page(session, page_id, false, false).await?;
    let rows = docs_version::Entity::find()
        .filter(docs_version::Column::PageId.eq(page_id))
        .order_by_desc(docs_version::Column::Version)
        .all(session)
        .await?;
    Ok(rows
        .into_iter()
        .map(|v| {
            json!({
                "version": v.version,
                "title": v.title,
                "author": v.author,
                "note": v.note,
                "created_at": v.created_at,
                "words": word_count(&v.markdown),
                "with_ai": v.with_ai,
            })
        })
        .collect())
}

/// `_version`: one version of a page, or 404.
pub async fn version(session: &Session, page_id: &str, n: i64) -> Result<docs_version::Model> {
    let found = match i32::try_from(n) {
        Ok(n) => {
            docs_version::Entity::find()
                .filter(docs_version::Column::PageId.eq(page_id))
                .filter(docs_version::Column::Version.eq(n))
                .one(session)
                .await?
        }
        Err(_) => None,
    };
    match found {
        Some(v) => Ok(v),
        None => docs_err(404, "version_not_found", format!("Version {n} not found")),
    }
}

/// Return one version of a page with its content.
pub async fn get_version(session: &Session, page_id: &str, n: i64) -> Result<Map<String, Value>> {
    get_page(session, page_id, false, false).await?;
    let v = version(session, page_id, n).await?;
    let mut out = Map::new();
    out.insert("version".into(), json!(v.version));
    out.insert("title".into(), json!(v.title));
    out.insert("markdown".into(), json!(v.markdown));
    out.insert("author".into(), json!(v.author));
    out.insert("note".into(), opt(&v.note));
    out.insert("created_at".into(), json!(v.created_at));
    out.insert("diagram_versions".into(), Value::Object(diagrams::parse_pins(Some(&v.diagram_versions))));
    out.insert("with_ai".into(), json!(v.with_ai));
    Ok(out)
}

/// The section a heading line starts: its text as plain text.
fn heading_section(line: &str) -> Option<String> {
    heading_match(line).map(|m| strip_inline(&m.text))
}

/// Diff two Markdown texts by line, with word-level highlights on changed lines: `{rows, added, removed,
/// sections}`.
pub fn diff_markdown(old: &str, new: &str) -> Map<String, Value> {
    let a = kb_base::pytext::splitlines(old);
    let b = kb_base::pytext::splitlines(new);
    let mut rows: Vec<Value> = Vec::new();
    let (mut added, mut removed) = (0i64, 0i64);
    let mut section = "(top)".to_string();
    let mut sections: Vec<(String, i64, i64)> = Vec::new();
    let (mut old_no, mut new_no) = (0i64, 0i64);
    let bump = |sections: &mut Vec<(String, i64, i64)>, section: &str, removed_kind: bool| {
        let at = match sections.iter().position(|s| s.0 == section) {
            Some(at) => at,
            None => {
                sections.push((section.to_string(), 0, 0));
                sections.len() - 1
            }
        };
        if removed_kind {
            sections[at].2 += 1;
        } else {
            sections[at].1 += 1;
        }
    };
    for (tag, i1, i2, j1, j2) in opcodes(&a, &b) {
        if tag == Tag::Equal {
            for line in &a[i1..i2] {
                old_no += 1;
                new_no += 1;
                if let Some(s) = heading_section(line) {
                    section = s;
                }
                rows.push(json!({"type": "same", "text": line, "old_no": old_no, "new_no": new_no}));
            }
            continue;
        }
        let (olds, news) = (&a[i1..i2], &b[j1..j2]);
        for line in olds {
            if let Some(s) = heading_section(line) {
                section = s;
            }
        }
        for (k, line) in olds.iter().enumerate() {
            old_no += 1;
            removed += 1;
            bump(&mut sections, &section, true);
            let mut row = json!({"type": "del", "text": line, "old_no": old_no, "new_no": Value::Null});
            if tag == Tag::Replace && k < news.len() {
                row["words"] = Value::Array(word_diff(line, news[k], true));
            }
            rows.push(row);
        }
        for (k, line) in news.iter().enumerate() {
            new_no += 1;
            added += 1;
            if let Some(s) = heading_section(line) {
                section = s;
            }
            bump(&mut sections, &section, false);
            let mut row = json!({"type": "add", "text": line, "old_no": Value::Null, "new_no": new_no});
            if tag == Tag::Replace && k < olds.len() {
                row["words"] = Value::Array(word_diff(olds[k], line, false));
            }
            rows.push(row);
        }
    }
    let mut out = Map::new();
    out.insert("rows".into(), Value::Array(rows));
    out.insert("added".into(), json!(added));
    out.insert("removed".into(), json!(removed));
    out.insert(
        "sections".into(),
        Value::Array(sections.into_iter().map(|(h, a, r)| json!({"heading": h, "added": a, "removed": r})).collect()),
    );
    out
}

/// `re.findall(r"\s+|\S+", text)`: runs of whitespace and runs of the rest.
fn word_tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<bool> = None;
    for (i, c) in text.char_indices() {
        let space = kb_base::pytext::is_space(c);
        if prev.is_some_and(|p| p != space) {
            out.push(&text[start..i]);
            start = i;
        }
        prev = Some(space);
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// Token list for one side of a changed line, with `changed` marking differing words.
fn word_diff(old: &str, new: &str, del_side: bool) -> Vec<Value> {
    let (ot, nt) = (word_tokens(old), word_tokens(new));
    let mut out = Vec::new();
    for (tag, i1, i2, j1, j2) in opcodes(&ot, &nt) {
        let side = if del_side { &ot[i1..i2] } else { &nt[j1..j2] };
        out.extend(side.iter().map(|t| json!({"text": t, "changed": tag != Tag::Equal})));
    }
    out
}

/// Return the line diff between two versions of a page, as `diff_markdown`, with `from` and `to`.
pub async fn diff_versions(session: &Session, page_id: &str, a: i64, b: i64) -> Result<Map<String, Value>> {
    get_page(session, page_id, false, false).await?;
    let va = version(session, page_id, a).await?;
    let vb = version(session, page_id, b).await?;
    let mut out = Map::new();
    out.insert("from".into(), json!(a));
    out.insert("to".into(), json!(b));
    out.extend(diff_markdown(&va.markdown, &vb.markdown));
    Ok(out)
}

/// Publish an old version's content as a new version; returns the page detail after publishing.
pub async fn restore_version(
    session: &Session,
    page_id: &str,
    n: i64,
    note: Option<&str>,
) -> Result<Map<String, Value>> {
    let mut page = get_page(session, page_id, false, true).await?;
    let v = version(session, page_id, n).await?;
    let actor = activity::current_actor();
    let draft = draft_for(session, &page.id, &actor).await?;
    // Diagrams go back to the versions this page version used, before the new version pins them
    diagrams::restore_pins(session, &diagrams::parse_pins(Some(&v.diagram_versions))).await?;
    let note = note.filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| format!("Restored from v{n}"));
    commit_version(session, &mut page, &v.markdown, &v.title, &actor, Some(&note), draft, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `test_diff_markdown_counts_and_word_level` of `tests/test_docs.py`.
    #[test]
    fn test_diff_markdown_counts_and_word_level() {
        let d = diff_markdown("## A\none two\nkeep", "## A\none three\nkeep\nnew");
        assert_eq!((d["added"].clone(), d["removed"].clone()), (json!(2), json!(1)));
        let changed: Vec<&str> = d["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .filter(|r| r["type"] == "add")
            .filter_map(|r| r["words"].as_array())
            .flatten()
            .filter(|t| t["changed"] == true)
            .map(|t| t["text"].as_str().expect("text"))
            .collect();
        assert_eq!(changed, ["three"]);
        assert_eq!(d["sections"][0]["heading"], "A");
    }

    #[test]
    fn words_and_spaces_are_separate_tokens() {
        assert_eq!(word_tokens("a  b\tc"), ["a", "  ", "b", "\t", "c"]);
        assert_eq!(word_tokens(" x"), [" ", "x"]);
        assert!(word_tokens("").is_empty());
    }

    #[test]
    fn a_line_diff_keeps_the_order_of_rows_and_numbers_them() {
        let d = diff_markdown("a\nb\nc", "a\nx\nc");
        let rows: Vec<(&str, Option<i64>, Option<i64>)> = d["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| (r["type"].as_str().expect("type"), r["old_no"].as_i64(), r["new_no"].as_i64()))
            .collect();
        assert_eq!(
            rows,
            [("same", Some(1), Some(1)), ("del", Some(2), None), ("add", None, Some(2)), ("same", Some(3), Some(3))]
        );
    }
}
