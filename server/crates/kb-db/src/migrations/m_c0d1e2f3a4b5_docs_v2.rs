//! `server/alembic/versions/c0d1e2f3a4b5_docs_v2.py`
//!
//! docs_v2: docs_enabled, link origin, heading aliases, full-text index

use std::sync::LazyLock;

use regex::Regex;
use sea_orm::ConnectionTrait;

use kb_base::pytext;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c0d1e2f3a4b5`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE project ADD COLUMN docs_enabled BOOLEAN DEFAULT 1 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE docs_link ADD COLUMN origin VARCHAR DEFAULT 'page' NOT NULL").await?;
    ops::exec(
        conn,
        r"CREATE TABLE docs_anchor_aliases (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	old_slug VARCHAR NOT NULL, 
	new_slug VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_anchor_aliases_page_id ON docs_anchor_aliases (page_id)").await?;
    // Full-text index. SQLite builds without FTS5 skip it: search falls back to LIKE matching.
    if create_fts(conn).await {
        backfill(conn).await?;
    }
    Ok(())
}

/// `services/docs_search.py` `CREATE_FTS`.
const CREATE_FTS: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(\
    page_id UNINDEXED, project_id UNINDEXED, title, headings, body, \
    tokenize = 'unicode61 remove_diacritics 2')";

/// `docs_search.create_fts_sync`: false when FTS5 is unavailable (a statement SQLite refuses leaves the
/// transaction open).
async fn create_fts<C: ConnectionTrait>(conn: &C) -> bool {
    conn.execute_unprepared(CREATE_FTS).await.is_ok()
}

/// `docs_search.backfill_sync`: index every live page from its latest version (or, if never published, its draft).
async fn backfill<C: ConnectionTrait>(conn: &C) -> StepResult {
    let pages = ops::rows(
        conn,
        "SELECT p.id AS id, p.project_id AS project_id, p.title AS title, \
         COALESCE((SELECT v.markdown FROM docs_version v WHERE v.page_id = p.id AND v.version = p.version), \
         (SELECT d.markdown FROM docs_draft d WHERE d.page_id = p.id LIMIT 1), '') AS markdown \
         FROM docs_page p WHERE p.deleted_at IS NULL",
        vec![],
    )
    .await?;
    ops::exec(conn, "DELETE FROM docs_fts").await?;
    for page in pages {
        let id: Option<String> = page.try_get("", "id")?;
        let project_id: Option<String> = page.try_get("", "project_id")?;
        let title: Option<String> = page.try_get("", "title")?;
        let markdown: Option<String> = page.try_get("", "markdown")?;
        let markdown = markdown.unwrap_or_default();
        ops::exec_with(
            conn,
            "INSERT INTO docs_fts (page_id, project_id, title, headings, body) VALUES (?, ?, ?, ?, ?)",
            vec![id.into(), project_id.into(), title.into(), headings(&markdown).into(), markdown.into()],
        )
        .await?;
    }
    Ok(())
}

// The heading text of a page, as `docs_search.index_fields` takes it from `docs_text.heading_anchors`. The Docs text
// functions live in `kb-doctext`, which is built on this crate, so the three small ones the backfill needs are
// written out here.

static REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\]\[|#\n]{1,200})(?:#([^\]\[|\n]{1,200}))?(?:\|([^\]\[\n]{1,200}))?\]\]")
        .expect("a valid pattern")
});
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]\[\n]{1,300})\]\(([^()\n]{0,500})\)").expect("a valid pattern"));

/// `_FENCE.match(line)`: the line opens or closes a code fence.
fn is_fence(line: &str) -> bool {
    let rest = line.trim_start_matches(pytext::is_space);
    rest.starts_with("```") || rest.starts_with("~~~")
}

/// `_HEADING.match(line)`: the text of an ATX heading (`## Title ##`), `None` for any other line.
fn heading_text(line: &str) -> Option<&str> {
    let n = line.bytes().take(7).take_while(|&b| b == b'#').count();
    if !(1..=6).contains(&n) || !matches!(line.as_bytes().get(n), Some(b' ' | b'\t')) {
        return None;
    }
    let text = pytext::strip(&line[n..]);
    let bare = text.trim_end_matches('#');
    // a closing run of # counts only after a space
    let text = if bare != text && (bare.is_empty() || bare.ends_with([' ', '\t'])) {
        bare.trim_end_matches(pytext::is_space)
    } else {
        text
    };
    if text.is_empty() { None } else { Some(text) }
}

/// `_strip_inline`: a heading without its links and emphasis marks.
fn strip_inline(text: &str) -> String {
    let text = REF.replace_all(text, |m: &regex::Captures<'_>| {
        m.get(3).or_else(|| m.get(1)).map(|g| g.as_str().to_string()).unwrap_or_default()
    });
    let text = LINK.replace_all(&text, "${1}");
    let text = text.replace("==", "").replace(['*', '_', '`', '~'], "");
    pytext::strip(&text).to_string()
}

/// `"\n".join(h["text"] for h in heading_anchors(markdown))`.
fn headings(markdown: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in pytext::splitlines(markdown) {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(text) = heading_text(line) {
            out.push(strip_inline(text));
        }
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_are_read_as_the_docs_index_reads_them() {
        let page = "# One *big* title #\ntext\n```\n# not a heading\n```\n## [[Page#part|shown]] and [a link](http://x)\n#nospace\n### ==mark== `code`\n";
        assert_eq!(headings(page), "One big title\nshown and a link\nmark code");
        assert_eq!(headings(""), "");
    }
}
