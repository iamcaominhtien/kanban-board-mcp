//! Checks the HTML of an HTML embed when a page is saved (design "Embeds").
//!
//! The HTML is stored exactly as written: scripts, event handlers, frames, forms and links to other sites all stay.
//! It is safe to keep them because an embed is only ever shown in an `<iframe sandbox>` without `allow-same-origin`
//! (the Docs page, the viewer, public links and the HTML export alike): the page runs in an origin of its own and
//! cannot reach the board, its cookies or its API. The only check left is the size.

use kb_doctext::docs_text::DocsError;
use serde_json::Value;

use crate::docs::space::HTML_EMBED_BYTES;

/// Checks the HTML of one embed; the HTML itself is kept as it is.
///
/// # Errors
/// 413 `too_large` when `html` is over [`HTML_EMBED_BYTES`] (the detail has `limit_bytes` and `size_bytes`).
pub fn check_embed_html(html: &str) -> crate::Result<()> {
    if html.len() > HTML_EMBED_BYTES {
        return Err(DocsError::new(
            413,
            "too_large",
            format!(
                "This HTML is {}. An embed can be {} at most.",
                human_size(html.len() as u64),
                human_size(HTML_EMBED_BYTES as u64)
            ),
        )
        .with("limit_bytes", HTML_EMBED_BYTES)
        .with("size_bytes", html.len())
        .into());
    }
    Ok(())
}

/// Checks every `htmlEmbed` node of a page document (its `html` attribute), in document order.
///
/// # Errors
/// The error of [`check_embed_html`] for the first embed that has one.
pub fn check_doc(doc: &Value) -> crate::Result<()> {
    let mut stack: Vec<&Value> = vec![doc];
    while let Some(node) = stack.pop() {
        let Some(obj) = node.as_object() else { continue };
        if obj.get("type").and_then(Value::as_str) == Some("htmlEmbed") {
            if let Some(Value::String(html)) = obj.get("attrs").and_then(|a| a.get("html")) {
                check_embed_html(html)?;
            }
        }
        if let Some(Value::Array(children)) = obj.get("content") {
            stack.extend(children.iter().rev());
        }
    }
    Ok(())
}

/// `1.4 MB`, `512 KB`, `900 bytes`.
pub(crate) fn human_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        let tenths = (bytes * 10 + MB / 2) / MB;
        if tenths.is_multiple_of(10) {
            format!("{} MB", tenths / 10)
        } else {
            format!("{}.{} MB", tenths / 10, tenths % 10)
        }
    } else if bytes >= KB {
        format!("{} KB", (bytes + KB / 2) / KB)
    } else {
        format!("{bytes} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn interactive_html_is_kept_as_written() {
        // what the old cleaner took out: an interactive page needs all of it, and the sandbox keeps it from the board
        let doc = json!({"type": "doc", "content": [
            {"type": "htmlEmbed", "attrs": {"html": "<div onclick=\"spin()\">3D</div><iframe src=\"https://example.com\"></iframe>\
                <script src=\"https://cdn.example.com/three.min.js\"></script><form action=\"https://example.com\"></form>"}}
        ]});
        let before = doc.clone();
        check_doc(&doc).unwrap();
        assert_eq!(doc, before);
    }

    #[test]
    fn an_embed_over_the_limit_is_refused() {
        let big = "a".repeat(HTML_EMBED_BYTES + 1);
        let Err(crate::Error::Docs(e)) = check_embed_html(&big) else { panic!("expected a DocsError") };
        assert_eq!((e.status, e.code.as_str()), (413, "too_large"));
        assert_eq!(e.extra["limit_bytes"], json!(HTML_EMBED_BYTES));
        assert!(e.message.contains("10 MB"), "{}", e.message);
        assert!(check_embed_html(&"a".repeat(HTML_EMBED_BYTES)).is_ok());

        let nested = json!({"type": "doc", "content": [{"type": "columns", "content": [{"type": "column", "content": [
            {"type": "htmlEmbed", "attrs": {"html": big}}
        ]}]}]});
        assert!(check_doc(&nested).is_err());
    }

    #[test]
    fn sizes_read_like_the_design() {
        assert_eq!(human_size(512 * 1024), "512 KB");
        assert_eq!(human_size(1_468_006), "1.4 MB");
        assert_eq!(human_size(100 * 1024 * 1024), "100 MB");
    }
}
