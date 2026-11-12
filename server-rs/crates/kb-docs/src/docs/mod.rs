//! Docs space: a page tree per project, drafts, versions, history and references (`services/docs.py`).
//!
//! Pages store Markdown. The title is its own field; body headings start at `##`. Every publish adds a
//! `docs_version` row; a restore adds a new one rather than rewriting history. References (`[[Page#Section|text]]`
//! and ticket keys) are indexed in `docs_link` when a page is published.
//!
//! Layout (python lines): `pages` 63-503 (lookup, tree, create, paths), `tree` 505-835 (move, copy, delete,
//! restore, bin), `versions` 838-1333 (drafts, follow, seen, publish, versions, diff), `refs` 1335-1657
//! (aliases, resolving references, link rows), `tickets` 1659-2209 (ticket mentions, backlinks, stats, ticket
//! docs), `rename` 2212-2427 (rename and delete previews).

pub mod pages;
pub mod refs;
pub mod rename;
pub mod tickets;
pub mod tree;
pub mod versions;

pub use pages::*;
pub use refs::*;
pub use rename::*;
pub use tickets::*;
pub use tree::*;
pub use versions::*;

// `from services.docs_text import ...  # noqa: F401 (re-exported)`: the same names, from `kb_doctext`. The private
// patterns of the Python module (`_FENCE`, `_HEADING`, `_INLINE_CODE`, `_REF`, `_strip_inline`) are the scanners and
// functions that replace them.
pub use kb_doctext::docs_text::{
    DocsError, count_page_links, heading_anchors, heading_match, inline_code_spans, is_fence, page_ref_contexts,
    parse_references, ref_at, rewrite_page_links, slugify, strip_inline,
};

use kb_doctext::docs_templates::{self, Template};

/// Days a page stays in the Recycle Bin.
pub const RECYCLE_DAYS: i64 = 30;
/// Longest page title, in characters.
pub const MAX_TITLE: usize = 200;
/// Largest page, in characters.
pub const MAX_MARKDOWN: usize = 1_000_000;

/// The BA's page templates (`services/ba_templates/`: `docs_templates()`), in the order of its `DOCS`.
fn ba_templates() -> Vec<(String, Template)> {
    let t = |key: &str, name: &str, description: &str, markdown: &str| {
        (key.to_string(), Template { name: name.into(), description: description.into(), markdown: markdown.into() })
    };
    vec![
        t(
            "feature-spec",
            "Feature spec",
            "Stories, scenarios, numbered requirements, edge cases",
            include_str!("../text/ba_templates/feature-spec.md"),
        ),
        t(
            "bugfix-spec",
            "Bugfix spec",
            "Current, expected and unchanged behaviour",
            include_str!("../text/ba_templates/bugfix-spec.md"),
        ),
        t(
            "decision-table",
            "Decision table",
            "One row per combination of conditions",
            include_str!("../text/ba_templates/decision-table.md"),
        ),
        t(
            "use-case",
            "Use case",
            "Main scenario and what can go differently",
            include_str!("../text/ba_templates/use-case.md"),
        ),
        t(
            "example-map",
            "Example map",
            "Rules, their examples, open questions",
            include_str!("../text/ba_templates/example-map.md"),
        ),
        t(
            "one-pager",
            "One-pager",
            "Problem, appetite, solution, no-gos",
            include_str!("../text/ba_templates/one-pager.md"),
        ),
        t(
            "data-dictionary",
            "Data dictionary",
            "Fields, types, examples, rules",
            include_str!("../text/ba_templates/data-dictionary.md"),
        ),
        t(
            "nfr-checklist",
            "Quality requirements",
            "Speed, safety, access, formats",
            include_str!("../text/ba_templates/nfr-checklist.md"),
        ),
    ]
}

/// `TEMPLATES`: every page template, by key, in order.
pub fn templates() -> Vec<(String, Template)> {
    docs_templates::templates(ba_templates())
}
