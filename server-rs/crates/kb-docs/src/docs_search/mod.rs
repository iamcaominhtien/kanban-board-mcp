//! Docs search: an FTS5 index (title > headings > body) with a LIKE-style fallback (`services/docs_search.py`).
//!
//! The index is a plain FTS5 table, `docs_fts`, kept in step synchronously by the docs service (publish, rename,
//! delete, restore, purge, import). Query syntax: words are ANDed, `"a phrase"` must match as written, `-word`
//! excludes. User input never reaches FTS5 unquoted, so odd characters cannot raise syntax errors; when FTS5 is
//! missing (or a MATCH still fails) the same query is evaluated in Rust over the pages.
//!
//! Layout: `index` is the index maintenance (python lines 40-235), `query` the query parser and snippets
//! (237-401), `search` the search itself (404-853).

pub mod index;
pub mod query;
pub mod search;

pub use index::{
    CREATE_FTS, backfill_sync, contents, create_fts_sync, ensure_fts, index_fields, rebuild_index, reindex,
    set_fts_broken, unindex,
};
pub use query::{MAX_QUERY, MAX_TERMS, Query, build_matches, highlight};
pub use search::{SearchParams, fts_ranks, path_titles, search, similar};
