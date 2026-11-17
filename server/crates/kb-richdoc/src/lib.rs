//! The Rich Docs page format: a TipTap/ProseMirror JSON document with a block id on every block.
//!
//! The contract is `server/contract/richdoc/` (README.md, schema.json, palette.json and the fixtures); the UI has the
//! same converter in `ui/src/richdoc`. Markdown is only a projection of a page: [`doc_to_markdown`] (plain, for
//! export and the stored `markdown` column), [`doc_to_annotated`] (the MCP view, with block ids) and
//! [`doc_to_text`] (search, snippets, Docs health).

use serde_json::Value;

mod annotated;
mod chars;
mod ids;
mod md;
pub mod ops;
pub mod schema;
mod text;

pub use ids::{carries_block_id, is_block_id};

/// The format version written with every rich page (`schema.json` `formatVersion`).
pub const FORMAT_VERSION: u32 = 1;

/// Why a document or an edit was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RichDocError {
    /// The JSON is not a document of this schema (unknown node, bad content); the text says where.
    #[error("{0}")]
    Invalid(String),
    /// An annotated Markdown input could not be read (a broken marker or span); the text says where.
    #[error("{0}")]
    Syntax(String),
    /// A block edit names a block id the page does not have.
    #[error("No block {0} on this page")]
    NoBlock(String),
    /// A block edit would drop a placeholder (a block Markdown cannot hold) without an explicit delete.
    #[error("{0}")]
    Placeholder(String),
}

/// Makes block ids: `b-` and 6 lower-case hex digits.
pub trait IdSource {
    /// Returns the next id candidate (the caller re-asks when it is already used).
    fn next_id(&mut self) -> String;
}

/// Random block ids (production).
#[derive(Debug, Default)]
pub struct RandomIds;

/// Deterministic block ids `b-000001`, `b-000002`… (fixtures and tests).
#[derive(Debug)]
pub struct SeqIds(pub u32);

/// Converts plain Markdown (the editor's flavour) to a document; every block gets a new id from `ids`.
pub fn markdown_to_doc(md: &str, ids: &mut dyn IdSource) -> Value {
    let doc = md::build::parse(md);
    let mut doc = schema::canonical(&doc);
    ids::ensure(&mut doc, ids);
    doc
}

/// Writes a document as plain Markdown, exactly as the editor stores it (README "Plain").
pub fn doc_to_markdown(doc: &Value) -> String {
    md::write::doc_to_markdown(&schema::clamp(doc))
}

/// Writes a document as annotated Markdown: plain plus a `<!-- #b-… attrs -->` marker before every top-level
/// block, inline spans for marks plain Markdown cannot hold and placeholders that keep their ids.
pub fn doc_to_annotated(doc: &Value) -> String {
    annotated::doc_to_annotated(&schema::clamp(doc))
}

/// Reads annotated (or plain) Markdown: blocks with a marker keep its id and attributes, the rest get new ids.
///
/// `existing` is the page the Markdown was read from, when there is one: a placeholder line takes its block from
/// there by id.
///
/// # Errors
/// [`RichDocError::Syntax`] for a broken marker or span, [`RichDocError::NoBlock`] for a placeholder whose id
/// `existing` does not have.
pub fn annotated_to_doc(md: &str, existing: Option<&Value>, ids: &mut dyn IdSource) -> Result<Value, RichDocError> {
    annotated::annotated_to_doc(md, existing, ids)
}

/// Returns the plain-text projection (README "Projections").
pub fn doc_to_text(doc: &Value) -> String {
    text::doc_to_text(&schema::clamp(doc))
}

/// Gives every block a valid, unique id (a missing, malformed or duplicated one is replaced; the first holder of a
/// duplicated id keeps it). Returns whether anything changed.
pub fn ensure_block_ids(doc: &mut Value, ids: &mut dyn IdSource) -> bool {
    ids::ensure(doc, ids)
}

/// Checks a document against the schema (node and mark names, content, attribute types).
///
/// # Errors
/// [`RichDocError::Invalid`] naming the first problem.
pub fn validate(doc: &Value) -> Result<(), RichDocError> {
    schema::validate(doc)
}

/// Returns the top-level blocks (children of the doc, a `columns` block followed by its columns' blocks).
pub fn top_level_blocks(doc: &Value) -> Vec<&Value> {
    ids::top_level(doc)
}
