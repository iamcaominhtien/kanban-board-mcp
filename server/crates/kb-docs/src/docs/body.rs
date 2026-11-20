//! A page's content in the Rich Docs format and the projections written with it.
//!
//! Since format 1 a version or a draft holds the page as rich JSON (`content`, `format = 'rich'`) plus two
//! projections computed here on every save: plain Markdown (`markdown`, which the link index, heading aliases, comment
//! anchors, the ticket side and the MCP still read) and plain text (`text`, for search and word counts). Versions
//! written before the conversion keep `format = 'md'` and only their Markdown.

use kb_db::entities::{docs_draft, docs_version};
use kb_richdoc::{IdSource, RandomIds};
use serde_json::Value;

use super::MAX_MARKDOWN;
use crate::{Result, docs_err};

/// The largest rich page, in bytes of its JSON (README: page limit 50 MB; the editor warns at 75 %).
pub const MAX_CONTENT_BYTES: usize = 50 * 1024 * 1024;

/// How a version or draft row stores its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Markdown only (written before format 1; read-only history, or a page whose conversion failed).
    Markdown,
    /// Rich JSON with its projections.
    Rich,
}

impl Format {
    /// The value of the `format` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Markdown => "md",
            Format::Rich => "rich",
        }
    }

    /// Reads the `format` column (anything but `rich` is Markdown).
    pub fn parse(raw: &str) -> Self {
        if raw == "rich" { Format::Rich } else { Format::Markdown }
    }
}

/// What a caller sends as the new content of a page.
#[derive(Debug, Clone, Copy)]
pub enum BodyInput<'a> {
    /// Plain Markdown (old clients, import, templates, the MCP `update`): converted to a rich page.
    Markdown(&'a str),
    /// A rich document (the editor).
    Content(&'a Value),
}

/// A page's content with its projections, ready to be written to a version or draft row.
#[derive(Debug, Clone, PartialEq)]
pub struct PageBody {
    /// How it is stored.
    pub format: Format,
    /// The rich document (`None` for a Markdown body).
    pub content: Option<Value>,
    /// The plain-Markdown projection (or the Markdown itself).
    pub markdown: String,
    /// The plain-text projection.
    pub text: String,
}

impl PageBody {
    /// Builds a rich body from what a caller sent: a document is checked and given block ids, Markdown converted.
    ///
    /// # Errors
    /// 422 `invalid_content` for a document that is not of the schema, 413 `too_large` over the size limits.
    pub fn from_input(input: BodyInput<'_>) -> Result<Self> {
        match input {
            BodyInput::Markdown(md) => {
                super::check_markdown(md)?;
                Ok(Self::from_doc(kb_richdoc::markdown_to_doc(md, &mut RandomIds)))
            }
            BodyInput::Content(doc) => {
                if serde_json::to_string(doc).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_CONTENT_BYTES {
                    return docs_err(413, "too_large", "Page is too large");
                }
                if let Err(e) = kb_richdoc::validate(doc) {
                    return docs_err(422, "invalid_content", e.to_string());
                }
                let mut doc = doc.clone();
                // HTML embeds are kept as written (they run in an isolated sandbox); only their size is checked
                crate::docs_embeds::check_doc(&doc)?;
                kb_richdoc::ensure_block_ids(&mut doc, &mut RandomIds);
                let body = Self::from_doc(doc);
                if body.markdown.chars().count() > MAX_MARKDOWN {
                    return docs_err(413, "too_large", "Page is too large");
                }
                Ok(body)
            }
        }
    }

    /// Builds a rich body from a document that already has its ids.
    pub fn from_doc(doc: Value) -> Self {
        let markdown = kb_richdoc::doc_to_markdown(&doc);
        let text = kb_richdoc::doc_to_text(&doc);
        Self { format: Format::Rich, content: Some(doc), markdown, text }
    }

    /// Converts Markdown to a rich body with fresh ids from `ids`.
    pub fn from_markdown(md: &str, ids: &mut dyn IdSource) -> Self {
        Self::from_doc(kb_richdoc::markdown_to_doc(md, ids))
    }

    /// Reads a version row.
    pub fn of_version(v: &docs_version::Model) -> Self {
        Self::from_columns(&v.format, v.content.as_deref(), &v.markdown, v.text.as_deref())
    }

    /// Reads a draft row.
    pub fn of_draft(d: &docs_draft::Model) -> Self {
        Self::from_columns(&d.format, d.content.as_deref(), &d.markdown, d.text.as_deref())
    }

    fn from_columns(format: &str, content: Option<&str>, markdown: &str, text: Option<&str>) -> Self {
        let parsed = content.filter(|c| !c.is_empty()).and_then(|c| serde_json::from_str::<Value>(c).ok());
        match (Format::parse(format), parsed) {
            (Format::Rich, Some(doc)) => Self {
                format: Format::Rich,
                markdown: markdown.to_string(),
                text: text.map(str::to_string).unwrap_or_else(|| kb_richdoc::doc_to_text(&doc)),
                content: Some(doc),
            },
            _ => Self {
                format: Format::Markdown,
                content: None,
                markdown: markdown.to_string(),
                text: text.map(str::to_string).unwrap_or_else(|| markdown.to_string()),
            },
        }
    }

    /// The body as a rich page: itself, or its Markdown converted with fresh ids.
    pub fn into_rich(self) -> Self {
        match self.format {
            Format::Rich => self,
            Format::Markdown => Self::from_markdown(&self.markdown, &mut RandomIds),
        }
    }

    /// The `content` column value (compact JSON), `None` for a Markdown body.
    pub fn content_column(&self) -> Option<String> {
        self.content.as_ref().map(Value::to_string)
    }

    /// Whether two bodies hold the same page (rich content compared without caring about JSON layout).
    pub fn same_page(&self, other: &PageBody) -> bool {
        match (&self.content, &other.content) {
            (Some(a), Some(b)) => a == b,
            (None, None) => self.markdown == other.markdown,
            _ => false,
        }
    }
}

/// Points every page link (`docRef`, `pageCard`) to `old_title` at `new_title` (titles compared as
/// `rewrite_page_links` does: trimmed, lower-cased). Returns how many were changed.
pub fn rewrite_doc_links(doc: &mut Value, old_title: &str, new_title: &str) -> usize {
    let needle = old_title.trim().to_lowercase();
    let mut count = 0;
    fn walk(node: &mut Value, needle: &str, new_title: &str, count: &mut usize) {
        let is_link = matches!(node.get("type").and_then(Value::as_str), Some("docRef" | "pageCard"));
        if is_link {
            if let Some(attrs) = node.get_mut("attrs").and_then(Value::as_object_mut) {
                let hit = attrs.get("page").and_then(Value::as_str).is_some_and(|p| p.trim().to_lowercase() == needle);
                if hit {
                    attrs.insert("page".into(), Value::String(new_title.to_string()));
                    *count += 1;
                }
            }
        }
        if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
            for child in children {
                walk(child, needle, new_title, count);
            }
        }
    }
    walk(doc, &needle, new_title, &mut count);
    count
}

impl PageBody {
    /// The body with its page links to `old_title` pointed at `new_title`, and how many changed (Markdown bodies are
    /// rewritten as text).
    pub fn rewrite_links(&self, old_title: &str, new_title: &str) -> (PageBody, usize) {
        match &self.content {
            Some(doc) => {
                let mut doc = doc.clone();
                let n = rewrite_doc_links(&mut doc, old_title, new_title);
                if n == 0 { (self.clone(), 0) } else { (PageBody::from_doc(doc), n) }
            }
            None => {
                let (md, n) = kb_doctext::docs_text::rewrite_page_links(&self.markdown, old_title, new_title);
                (PageBody { markdown: md.clone(), text: md, ..self.clone() }, n)
            }
        }
    }
}
