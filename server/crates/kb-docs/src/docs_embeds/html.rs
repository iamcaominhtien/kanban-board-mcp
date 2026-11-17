//! Cleans the HTML of an HTML embed when a page is saved (design "Embeds", frames 1-11 and 73).
//!
//! The embed is shown in a sandboxed iframe with no network; this cleaner is the first guard. It keeps HTML, CSS
//! (`<style>` and `style` attributes) and `<script>`, and removes what could load another page, leave the sandbox or
//! run code outside a script: event-handler attributes, frames, plug-ins, `<base>`, `<meta http-equiv>`,
//! `javascript:`/`vbscript:`/`data:text/html` addresses, forms that send to another site. Elements are an allow-list:
//! the HTML elements, custom elements (a `-` in the name), SVG and MathML; any other element is unwrapped (its
//! children stay). When nothing is removed the HTML is kept byte for byte, so saving an unchanged page changes
//! nothing.

use html5ever::tendril::TendrilSink;
use html5ever::{Attribute, ParseOpts, QualName, local_name, ns, parse_document, parse_fragment};
use kb_doctext::docs_text::DocsError;
use markup5ever_rcdom::{Handle, NodeData, RcDom, SerializableHandle};
use serde_json::Value;

use crate::docs::space::HTML_EMBED_BYTES;

/// HTML after cleaning, and what was taken out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedHtml {
    /// The HTML to store: the input itself when `removed` is empty.
    pub html: String,
    /// What was removed, one entry per thing, in words for the "Saved. 3 things were removed…" message ("an
    /// onclick attribute", "an iframe", "a javascript: link").
    pub removed: Vec<String>,
}

/// HTML elements an embed may hold.
const HTML_ELEMENTS: &[&str] = &[
    "a",
    "abbr",
    "address",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "bdi",
    "bdo",
    "big",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "datalist",
    "dd",
    "del",
    "details",
    "dfn",
    "dialog",
    "div",
    "dl",
    "dt",
    "em",
    "fieldset",
    "figcaption",
    "figure",
    "font",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "i",
    "img",
    "input",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "link",
    "main",
    "map",
    "mark",
    "menu",
    "meta",
    "meter",
    "nav",
    "noscript",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "picture",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "script",
    "search",
    "section",
    "select",
    "slot",
    "small",
    "source",
    "span",
    "strike",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "title",
    "tr",
    "track",
    "tt",
    "u",
    "ul",
    "var",
    "video",
    "wbr",
];

/// Elements removed with everything in them, and how the message names each.
const REMOVED_ELEMENTS: &[(&str, &str)] = &[
    ("iframe", "an iframe"),
    ("frame", "a frame"),
    ("frameset", "a frameset"),
    ("object", "an object"),
    ("embed", "an embed"),
    ("applet", "an applet"),
    ("base", "a base tag"),
    ("portal", "a portal"),
    ("fencedframe", "a fenced frame"),
];

/// Attributes that hold an address (any element, any namespace: `xlink:href` has the local name `href`).
const URL_ATTRIBUTES: &[&str] =
    &["href", "src", "poster", "background", "cite", "longdesc", "lowsrc", "dynsrc", "codebase", "manifest", "data"];

/// Schemes an address may use; `data:` is checked on its own.
const ALLOWED_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];

/// Media types a `data:` address may carry (pictures, fonts, sound and video, never a page).
const ALLOWED_DATA_TYPES: &[&str] = &["image/", "font/", "audio/", "video/", "application/font", "text/css"];

/// How deep elements may nest in an embed (browsers flatten deeper trees at about this depth).
pub const MAX_DEPTH: usize = 512;

/// Cleans the HTML of one embed.
///
/// `html` may be a fragment or a whole document (`<!doctype` or `<html` in it); a document stays a document.
///
/// # Errors
/// 413 `too_large` when `html` is over [`HTML_EMBED_BYTES`] (the detail has `limit_bytes` and `size_bytes`); 422
/// `embed_too_deep` when elements nest more than [`MAX_DEPTH`] deep.
pub fn sanitize_embed_html(html: &str) -> crate::Result<SanitizedHtml> {
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
    if nesting_depth(html) > MAX_DEPTH {
        // the HTML parser takes time in the square of the depth: a page of nested `<div>`s would hold a save for
        // minutes; browsers stop nesting long before this
        return Err(DocsError::new(
            422,
            "embed_too_deep",
            format!("This HTML nests elements more than {MAX_DEPTH} deep. Flatten it, or attach it as a file."),
        )
        .with("limit_depth", MAX_DEPTH)
        .into());
    }
    let lower = html.trim_start().to_ascii_lowercase();
    let whole_document = lower.starts_with("<!doctype") || lower.contains("<html");
    let dom = if whole_document {
        parse_document(RcDom::default(), ParseOpts::default()).one(html)
    } else {
        parse_fragment(
            RcDom::default(),
            ParseOpts::default(),
            QualName::new(None, ns!(html), local_name!("body")),
            Vec::new(),
            true,
        )
        .one(html)
    };
    let mut removed = Vec::new();
    clean_tree(&dom.document, &mut removed);
    if removed.is_empty() {
        return Ok(SanitizedHtml { html: html.to_string(), removed });
    }
    // a fragment is parsed under an `<html>` element: its children are the fragment
    let root = if whole_document {
        dom.document.clone()
    } else {
        dom.document.children.borrow().first().cloned().unwrap_or_else(|| dom.document.clone())
    };
    let mut out = Vec::with_capacity(html.len());
    let opts = html5ever::serialize::SerializeOpts {
        traversal_scope: html5ever::serialize::TraversalScope::ChildrenOnly(None),
        ..Default::default()
    };
    html5ever::serialize(&mut out, &SerializableHandle::from(root), opts)
        .map_err(|e| crate::Error::Other(format!("could not write the cleaned HTML: {e}")))?;
    Ok(SanitizedHtml { html: String::from_utf8_lossy(&out).into_owned(), removed })
}

/// Cleans every `htmlEmbed` node of a page document in place (the `html` attribute), and returns what was removed
/// from all of them, in document order.
///
/// # Errors
/// The errors of [`sanitize_embed_html`] for the first embed that has one.
pub fn sanitize_doc(doc: &mut Value) -> crate::Result<Vec<String>> {
    let mut removed = Vec::new();
    let mut stack: Vec<&mut Value> = vec![doc];
    // depth first, children pushed in reverse so the removals come out in document order
    while let Some(node) = stack.pop() {
        let Some(obj) = node.as_object_mut() else { continue };
        if obj.get("type").and_then(Value::as_str) == Some("htmlEmbed") {
            if let Some(Value::String(html)) = obj.get_mut("attrs").and_then(|a| a.get_mut("html")) {
                let clean = sanitize_embed_html(html)?;
                if !clean.removed.is_empty() {
                    *html = clean.html;
                    removed.extend(clean.removed);
                }
            }
        }
        if let Some(Value::Array(children)) = obj.get_mut("content") {
            stack.extend(children.iter_mut().rev());
        }
    }
    Ok(removed)
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

/// Elements that never have an end tag.
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
    "keygen", "frame", "basefont", "bgsound",
];

/// Elements whose content is text, not tags.
const RAW_TEXT_ELEMENTS: &[&str] =
    &["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"];

/// Elements a start tag of the same group closes (`<li>` closes an open `<li>`).
fn closes_open(open: &str, new: &str) -> bool {
    let group = |t: &str| match t {
        "p" => 1,
        "li" => 2,
        "dt" | "dd" => 3,
        "option" | "optgroup" => 4,
        "tr" | "td" | "th" => 5,
        "thead" | "tbody" | "tfoot" => 6,
        "rt" | "rp" => 7,
        _ => 0,
    };
    let g = group(open);
    g != 0 && g == group(new)
}

/// How deep the elements of `html` nest, estimated in one pass without the HTML parser (end tags close what they
/// match, void elements and `/>` open nothing, the content of `<script>` and the like is skipped).
fn nesting_depth(html: &str) -> usize {
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let mut stack: Vec<String> = Vec::new();
    let mut open_count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut deepest = 0;
    let mut i = 0;
    while let Some(off) = lower[i..].find('<') {
        i += off + 1;
        if lower[i..].starts_with("!--") {
            i = lower[i..].find("-->").map_or(bytes.len(), |e| i + e + 3);
            continue;
        }
        let closing = bytes.get(i) == Some(&b'/');
        let start = if closing { i + 1 } else { i };
        let end = start + bytes[start..].iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'-').count();
        if end == start || !bytes[start].is_ascii_alphabetic() {
            continue;
        }
        let name = &lower[start..end];
        let tag_end = lower[end..].find('>').map_or(bytes.len(), |e| end + e);
        let self_closing = tag_end > 0 && bytes.get(tag_end - 1) == Some(&b'/');
        i = (tag_end + 1).min(bytes.len());
        if closing {
            if open_count.get(name).copied().unwrap_or(0) > 0 {
                while let Some(top) = stack.pop() {
                    if let Some(n) = open_count.get_mut(&top) {
                        *n -= 1;
                    }
                    if top == name {
                        break;
                    }
                }
            }
            continue;
        }
        if RAW_TEXT_ELEMENTS.contains(&name) {
            let close = format!("</{name}");
            i = lower[i..].find(&close).map_or(bytes.len(), |e| i + e);
            continue;
        }
        if VOID_ELEMENTS.contains(&name) || self_closing {
            continue;
        }
        if stack.last().is_some_and(|top| closes_open(top, name)) {
            if let Some(top) = stack.pop() {
                if let Some(n) = open_count.get_mut(&top) {
                    *n -= 1;
                }
            }
        }
        *open_count.entry(name.to_string()).or_insert(0) += 1;
        stack.push(name.to_string());
        deepest = deepest.max(stack.len());
    }
    deepest
}

/// What to do with one child node.
enum Verdict {
    /// Keep it (its own attributes may have been cleaned).
    Keep,
    /// Drop it and everything in it.
    Drop,
    /// Drop the element, keep its children in its place.
    Unwrap,
}

/// Walks the tree without recursion (an embed can nest deeply) and cleans each element's children.
fn clean_tree(root: &Handle, removed: &mut Vec<String>) {
    let mut stack = vec![root.clone()];
    while let Some(node) = stack.pop() {
        // a template's content is a fragment of its own: put it back as children so it is cleaned and written
        if let NodeData::Element { template_contents, .. } = &node.data {
            if let Some(contents) = template_contents.borrow_mut().take() {
                let moved: Vec<Handle> = contents.children.borrow_mut().drain(..).collect();
                node.children.borrow_mut().extend(moved);
            }
        }
        let children: Vec<Handle> = node.children.borrow_mut().drain(..).collect();
        let mut kept = Vec::with_capacity(children.len());
        let mut queue: std::collections::VecDeque<Handle> = children.into();
        while let Some(child) = queue.pop_front() {
            match judge(&child, removed) {
                Verdict::Keep => kept.push(child),
                Verdict::Drop => {}
                Verdict::Unwrap => {
                    if let NodeData::Element { template_contents, .. } = &child.data {
                        if let Some(contents) = template_contents.borrow_mut().take() {
                            let moved: Vec<Handle> = contents.children.borrow_mut().drain(..).collect();
                            child.children.borrow_mut().extend(moved);
                        }
                    }
                    let inner: Vec<Handle> = child.children.borrow_mut().drain(..).collect();
                    for (i, grandchild) in inner.into_iter().enumerate() {
                        queue.insert(i, grandchild);
                    }
                }
            }
        }
        for child in &kept {
            if matches!(child.data, NodeData::Element { .. }) {
                stack.push(child.clone());
            }
        }
        *node.children.borrow_mut() = kept;
    }
}

/// Decides about one node and cleans its attributes when it stays.
fn judge(node: &Handle, removed: &mut Vec<String>) -> Verdict {
    let NodeData::Element { name, attrs, .. } = &node.data else {
        return Verdict::Keep;
    };
    let local: &str = name.local.as_ref();
    let is_html = name.ns == ns!(html);
    let is_svg = name.ns == ns!(svg);
    if is_html {
        if let Some((_, words)) = REMOVED_ELEMENTS.iter().find(|(tag, _)| *tag == local) {
            removed.push((*words).to_string());
            return Verdict::Drop;
        }
        if local == "meta" {
            if let Some(equiv) = attr(&attrs.borrow(), "http-equiv") {
                let words = if equiv.trim().eq_ignore_ascii_case("refresh") {
                    "a meta refresh"
                } else {
                    "a meta http-equiv tag"
                };
                removed.push(words.to_string());
                return Verdict::Drop;
            }
        }
        if local == "style" && css_is_unsafe(&text_of(node)) {
            removed.push("a style sheet with a script in it".to_string());
            return Verdict::Drop;
        }
        if !HTML_ELEMENTS.contains(&local) && !local.contains('-') {
            removed.push(format!("a <{local}> element"));
            return Verdict::Unwrap;
        }
    } else if is_svg {
        let lower = local.to_ascii_lowercase();
        if matches!(lower.as_str(), "animate" | "set" | "animatemotion" | "animatetransform") {
            let target = attr(&attrs.borrow(), "attributeName").unwrap_or_default().to_ascii_lowercase();
            if target == "href" || target == "xlink:href" {
                removed.push("an SVG animation of a link".to_string());
                return Verdict::Drop;
            }
        }
    } else if name.ns != ns!(mathml) {
        removed.push(format!("a <{local}> element"));
        return Verdict::Unwrap;
    }
    clean_attributes(local, is_svg, &mut attrs.borrow_mut(), removed);
    Verdict::Keep
}

/// The value of the attribute `name` (no namespace match: `attributeName` and `http-equiv` have none).
fn attr(attrs: &[Attribute], name: &str) -> Option<String> {
    attrs.iter().find(|a| &*a.name.local == name).map(|a| a.value.to_string())
}

/// The text inside an element (a `<style>` holds one text node).
fn text_of(node: &Handle) -> String {
    let mut out = String::new();
    for child in node.children.borrow().iter() {
        if let NodeData::Text { contents } = &child.data {
            out.push_str(&contents.borrow());
        }
    }
    out
}

/// Removes the attributes of one element that could run code or leave the sandbox.
fn clean_attributes(element: &str, is_svg: bool, attrs: &mut Vec<Attribute>, removed: &mut Vec<String>) {
    attrs.retain(|a| {
        let name = a.name.local.to_ascii_lowercase();
        let value: &str = &a.value;
        if name.starts_with("on") {
            removed.push(format!("an {name} attribute"));
            return false;
        }
        match name.as_str() {
            "srcdoc" => {
                removed.push("a srcdoc attribute".to_string());
                false
            }
            "ping" => {
                removed.push("a ping attribute".to_string());
                false
            }
            "action" | "formaction" => {
                if sends_elsewhere(value) {
                    removed.push("a form that sends to another site".to_string());
                    false
                } else if let Some(scheme) = bad_scheme(value) {
                    removed.push(format!("a {scheme}: link"));
                    false
                } else {
                    true
                }
            }
            "srcset" | "imagesrcset" => {
                let bad = value.split(',').find_map(|part| bad_scheme(part.split_whitespace().next().unwrap_or("")));
                if let Some(scheme) = bad {
                    removed.push(format!("a {scheme}: link"));
                    false
                } else {
                    true
                }
            }
            "style" => {
                if css_is_unsafe(value) {
                    removed.push("a style with a script in it".to_string());
                    false
                } else {
                    true
                }
            }
            "href" if is_svg && element == "use" && !value.trim_start().starts_with('#') => {
                removed.push("an outside SVG reference".to_string());
                false
            }
            n if URL_ATTRIBUTES.contains(&n) => {
                if let Some(scheme) = bad_scheme(value) {
                    removed.push(format!("a {scheme}: link"));
                    false
                } else {
                    true
                }
            }
            _ => true,
        }
    });
}

/// An address with ASCII whitespace and control characters taken out, lower case (browsers ignore tabs and line
/// breaks inside a scheme: `java\tscript:` runs).
fn normalized(url: &str) -> String {
    url.chars().filter(|c| !c.is_ascii_control() && !c.is_ascii_whitespace()).collect::<String>().to_ascii_lowercase()
}

/// The scheme of an address that may not be used (`javascript`, `vbscript`, `data` with a page in it, `file`…),
/// or `None` for an allowed or relative address.
pub(crate) fn bad_scheme(url: &str) -> Option<String> {
    let url = normalized(url);
    let end = url.find([':', '/', '?', '#'])?;
    if url.as_bytes()[end] != b':' || end == 0 {
        return None;
    }
    let scheme = &url[..end];
    if !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    if ALLOWED_SCHEMES.contains(&scheme) {
        return None;
    }
    if scheme == "data" && ALLOWED_DATA_TYPES.iter().any(|t| url[end + 1..].starts_with(t)) {
        return None;
    }
    Some(scheme.to_string())
}

/// Whether a form `action` sends somewhere other than the embed itself (an address with a scheme or a host).
fn sends_elsewhere(action: &str) -> bool {
    let url = normalized(action);
    url.starts_with("http:")
        || url.starts_with("https:")
        || url.starts_with("//")
        || url.starts_with("/\\")
        || url.starts_with('\\')
}

/// Whether CSS could run a script or load one (`expression()`, `javascript:` in `url()`, bindings).
fn css_is_unsafe(css: &str) -> bool {
    let css = normalized(css);
    ["expression(", "javascript:", "vbscript:", "-moz-binding", "behavior:"].iter().any(|bad| css.contains(bad))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn clean(html: &str) -> SanitizedHtml {
        sanitize_embed_html(html).expect("under the limit")
    }

    #[test]
    fn safe_html_css_and_scripts_are_kept_byte_for_byte() {
        let html = "<div class=\"plans\" style=\"display: flex\"><h3>Team</h3></div>\n<style>.plans { gap: 12px; }</style>\n<script>document.querySelector('h3').textContent = 'x' < 'y' ? 'a' : 'b';</script>";
        let out = clean(html);
        assert!(out.removed.is_empty(), "{:?}", out.removed);
        assert_eq!(out.html, html);
    }

    #[test]
    fn each_kind_of_removal_is_named() {
        let cases: &[(&str, &str, &str)] = &[
            ("<div onclick=\"track()\">x</div>", "an onclick attribute", "onclick"),
            ("<iframe src=\"https://ads.example.com\"></iframe><p>x</p>", "an iframe", "iframe"),
            ("<a href=\"javascript:go()\">Pricing</a>", "a javascript: link", "javascript"),
            ("<a href=\"java\tscript:go()\">x</a>", "a javascript: link", "script:"),
            ("<a href=\"vbscript:msgbox\">x</a>", "a vbscript: link", "vbscript"),
            ("<a href=\"data:text/html,<script>1</script>\">x</a>", "a data: link", "data:text"),
            ("<!doctype html><frameset><frame src=x></frameset>", "a frameset", "frame"),
            ("<object data=\"x.swf\"></object>", "an object", "object"),
            ("<embed src=\"x.swf\">", "an embed", "embed"),
            ("<base href=\"https://evil.example/\"><p>x</p>", "a base tag", "base"),
            ("<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">", "a meta refresh", "refresh"),
            (
                "<form action=\"https://evil.example/steal\"><input name=a></form>",
                "a form that sends to another site",
                "evil",
            ),
            ("<button formaction=\"//evil.example\">go</button>", "a form that sends to another site", "evil"),
            ("<img src=x onerror=alert(1)>", "an onerror attribute", "onerror"),
            ("<iframe srcdoc=\"<script>1</script>\"></iframe>", "an iframe", "srcdoc"),
            ("<div style=\"background:url(javascript:alert(1))\">x</div>", "a style with a script in it", "javascript"),
            (
                "<svg><a><animate attributeName=\"href\" values=\"javascript:alert(1)\"/></a></svg>",
                "an SVG animation of a link",
                "animate",
            ),
            ("<svg><use href=\"data:image/svg+xml,<svg id='x'/>#x\"/></svg>", "an outside SVG reference", "data:"),
            ("<blink>hi</blink>", "a <blink> element", "blink"),
        ];
        for (input, words, gone) in cases {
            let out = clean(input);
            assert!(out.removed.iter().any(|r| r == words), "{input}: {:?}", out.removed);
            assert!(!out.html.to_ascii_lowercase().contains(gone), "{input} -> {}", out.html);
        }
    }

    #[test]
    fn the_rest_of_the_embed_stays_when_something_is_removed() {
        let out = clean(
            "<div onclick=\"track()\">\n <iframe src=\"https://ads.example.com\"></iframe>\n <a href=\"javascript:go()\">Pricing</a>\n <h3>Team</h3>\n</div><script>let a = 1 < 2;</script><style>h3{color:red}</style>",
        );
        assert_eq!(out.removed, vec!["an onclick attribute", "an iframe", "a javascript: link"]);
        assert!(out.html.contains("<h3>Team</h3>"), "{}", out.html);
        assert!(out.html.contains("<a>Pricing</a>"), "{}", out.html);
        assert!(out.html.contains("<script>let a = 1 < 2;</script>"), "{}", out.html);
        assert!(out.html.contains("<style>h3{color:red}</style>"), "{}", out.html);
        assert!(!out.html.contains("<html"), "a fragment stays a fragment: {}", out.html);
    }

    #[test]
    fn allowed_addresses_and_local_forms_are_kept() {
        for html in [
            "<a href=\"https://example.com\">x</a>",
            "<a href=\"/docs\">x</a>",
            "<a href=\"#top\">x</a>",
            "<a href=\"mailto:a@example.com\">x</a>",
            "<img src=\"data:image/png;base64,AAAA\">",
            "<form><input name=q><button>Go</button></form>",
            "<form action=\"#\"><input></form>",
            "<my-widget data-x=\"1\"></my-widget>",
            "<svg viewBox=\"0 0 10 10\"><use href=\"#a\"/><circle r=\"4\"/></svg>",
        ] {
            assert!(clean(html).removed.is_empty(), "{html}: {:?}", clean(html).removed);
        }
    }

    #[test]
    fn a_whole_document_stays_a_document() {
        let out = clean(
            "<!doctype html><html><head><base href=\"https://x\"><title>T</title></head><body><p>Hi</p></body></html>",
        );
        assert_eq!(out.removed, vec!["a base tag"]);
        assert!(out.html.starts_with("<!DOCTYPE html><html><head><title>T</title>"), "{}", out.html);
    }

    #[test]
    fn template_content_is_cleaned_and_kept() {
        let out = clean("<template><p onclick=\"x()\">in</p></template>");
        assert_eq!(out.removed, vec!["an onclick attribute"]);
        assert!(out.html.contains("<template><p>in</p></template>"), "{}", out.html);
    }

    #[test]
    fn an_embed_over_512_kb_is_refused() {
        let big = format!("<p>{}</p>", "a".repeat(HTML_EMBED_BYTES));
        let Err(crate::Error::Docs(e)) = sanitize_embed_html(&big) else { panic!("expected a DocsError") };
        assert_eq!((e.status, e.code.as_str()), (413, "too_large"));
        assert_eq!(e.extra["limit_bytes"], json!(HTML_EMBED_BYTES));
        assert!(e.message.contains("512 KB"), "{}", e.message);
        let just = "a".repeat(HTML_EMBED_BYTES);
        assert!(sanitize_embed_html(&just).is_ok());
    }

    #[test]
    fn sanitize_doc_cleans_every_embed_in_order() {
        let mut doc = json!({"type": "doc", "content": [
            {"type": "htmlEmbed", "attrs": {"html": "<div onclick=\"a()\">1</div>", "title": "A"}},
            {"type": "columns", "content": [{"type": "column", "content": [
                {"type": "htmlEmbed", "attrs": {"html": "<iframe></iframe><b>2</b>"}}
            ]}]},
            {"type": "htmlEmbed", "attrs": {"html": "<b>safe</b>"}},
            {"type": "paragraph", "content": [{"type": "text", "text": "<iframe>"}]}
        ]});
        let removed = sanitize_doc(&mut doc).unwrap();
        assert_eq!(removed, vec!["an onclick attribute", "an iframe"]);
        assert_eq!(doc["content"][0]["attrs"]["html"], json!("<div>1</div>"));
        assert_eq!(doc["content"][1]["content"][0]["content"][0]["attrs"]["html"], json!("<b>2</b>"));
        assert_eq!(doc["content"][2]["attrs"]["html"], json!("<b>safe</b>"));
        assert_eq!(doc["content"][3]["content"][0]["text"], json!("<iframe>"));

        let mut big = json!({"type": "doc", "content": [
            {"type": "htmlEmbed", "attrs": {"html": "x".repeat(HTML_EMBED_BYTES + 1)}}
        ]});
        assert!(sanitize_doc(&mut big).is_err());
    }

    #[test]
    fn deep_nesting_is_refused_before_parsing() {
        let html = format!("{}<p onclick=x>deep</p>{}", "<div>".repeat(20_000), "</div>".repeat(20_000));
        let started = std::time::Instant::now();
        let Err(crate::Error::Docs(e)) = sanitize_embed_html(&html) else { panic!("expected a DocsError") };
        assert_eq!((e.status, e.code.as_str()), (422, "embed_too_deep"));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));

        let ok = format!("{}<p onclick=x>deep</p>{}", "<div>".repeat(MAX_DEPTH - 1), "</div>".repeat(MAX_DEPTH - 1));
        assert_eq!(clean(&ok).removed, vec!["an onclick attribute"]);
    }

    #[test]
    fn the_depth_estimate_follows_real_html() {
        assert_eq!(nesting_depth("<div><p>a<p>b<ul><li>1<li>2</ul></div>"), 4);
        assert_eq!(nesting_depth(&"<p>x<br><img src=a>".repeat(2000)), 1);
        assert_eq!(nesting_depth(&"<li><a href=#>x</a>".repeat(2000)), 2);
        assert_eq!(nesting_depth(&format!("<script>{}</script><div></div>", "'<div>'+".repeat(2000))), 1);
        assert_eq!(nesting_depth("<!-- <div><div> --><svg><path d=x /><g></g></svg>"), 2);
    }

    #[test]
    fn sizes_read_like_the_design() {
        assert_eq!(human_size(512 * 1024), "512 KB");
        assert_eq!(human_size(1_468_006), "1.4 MB");
        assert_eq!(human_size(100 * 1024 * 1024), "100 MB");
    }
}
