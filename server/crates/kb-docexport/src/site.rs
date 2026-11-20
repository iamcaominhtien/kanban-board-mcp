//! HTML "sites": the files of an `htmlEmbed` block that has a `src`, turned into one `srcdoc` (single file) by
//! inlining the entry's local stylesheets, scripts and media.
//!
//! The scanner is a small tag walker, not an HTML parser: it handles `<link rel=stylesheet>`, `<script src>`,
//! `src`/`poster` attributes and CSS `url(...)` (`@import` in CSS is inlined to a depth of 3). A `type=module`
//! script has its relative import specifiers rewritten, bottom-up, to `data:text/javascript` URIs of the
//! already-rewritten target (a cycle keeps the specifier of the file that closes it).

use std::collections::HashMap;

use crate::assets::data_uri;

/// One file of a site, by its path relative to the site folder (`js/app.js`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteFile {
    /// Relative path with `/` separators.
    pub path: String,
    /// The file content.
    pub bytes: Vec<u8>,
}

/// Splits an embed `src` (`/docs/sites/<id>/<entry>`, or a URL holding that path) into the site id and the entry
/// path (`index.html` when the address stops at the id); `None` for any other address.
pub(crate) fn parse_site_src(src: &str) -> Option<(String, String)> {
    let at = src.find("/docs/sites/")?;
    let rest = &src[at + "/docs/sites/".len()..];
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (id, entry) = rest.split_once('/').unwrap_or((rest, ""));
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let entry = normalize(entry).unwrap_or_default();
    Some((id.to_string(), if entry.is_empty() { "index.html".into() } else { entry }))
}

/// Cleans a relative path: drops `.` and empty parts, applies `..`; `None` when it climbs out of the root.
fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(h) = s.get(i + 1..i + 3)
            && let Ok(v) = u8::from_str_radix(h, 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether a reference leaves the site (a scheme, `//host`, an anchor).
fn is_external(r: &str) -> bool {
    let r = r.trim();
    r.is_empty() || r.starts_with('#') || r.starts_with("//") || {
        let head = r.split(['/', '?', '#']).next().unwrap_or("");
        head.contains(':')
    }
}

/// The media type of a file by its extension.
pub(crate) fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "csv" => "text/csv",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// The files of one site, for inlining.
pub(crate) struct Site<'a> {
    files: HashMap<&'a str, &'a [u8]>,
}

impl<'a> Site<'a> {
    pub(crate) fn new(files: &'a [SiteFile]) -> Self {
        Site { files: files.iter().map(|f| (f.path.as_str(), f.bytes.as_slice())).collect() }
    }

    /// The file a reference made from the file in `dir` points to: its path and bytes.
    fn lookup(&self, dir: &str, reference: &str) -> Option<(String, &'a [u8])> {
        if is_external(reference) {
            return None;
        }
        let clean = reference.trim().split(['?', '#']).next().unwrap_or("");
        let clean = percent_decode(clean);
        let joined = match clean.strip_prefix('/') {
            Some(root) => root.to_string(),
            None if dir.is_empty() => clean,
            None => format!("{dir}/{clean}"),
        };
        let path = normalize(&joined)?;
        self.files.get(path.as_str()).map(|b| (path, *b))
    }

    fn data_url(&self, dir: &str, reference: &str) -> Option<String> {
        let (path, bytes) = self.lookup(dir, reference)?;
        Some(data_uri(mime_of(&path), bytes))
    }

    /// Returns the HTML of `entry` with its local files inlined; `None` when the entry is missing.
    pub(crate) fn inline_page(&self, entry: &str) -> Option<String> {
        let bytes = self.files.get(entry)?;
        Some(self.inline_html(&String::from_utf8_lossy(bytes), dir_of(entry)))
    }

    /// Rewrites the relative specifiers of the module `source` (the file at `path`) to data URIs of their
    /// rewritten targets; `stack` holds the files being rewritten, so a cycle leaves its specifier as it is.
    fn rewrite_module(&self, source: &str, path: &str, stack: &mut Vec<String>) -> String {
        let dir = dir_of(path);
        let mut out = String::with_capacity(source.len());
        let mut last = 0;
        for (start, end) in module_specifiers(source) {
            let spec = &source[start..end];
            if !(spec.starts_with("./") || spec.starts_with("../") || spec.starts_with('/')) {
                continue;
            }
            let Some((target, bytes)) = self.lookup(dir, spec) else { continue };
            if stack.contains(&target) {
                continue;
            }
            stack.push(target.clone());
            let code = self.rewrite_module(&String::from_utf8_lossy(bytes), &target, stack);
            stack.pop();
            out.push_str(&source[last..start]);
            out.push_str(&data_uri("text/javascript", code.as_bytes()));
            last = end;
        }
        out.push_str(&source[last..]);
        out
    }

    fn inline_css(&self, css: &str, dir: &str, depth: u8) -> String {
        let mut out = String::with_capacity(css.len());
        let mut rest = css;
        while let Some(at) = find_ci(rest, &["url(", "@import"]) {
            out.push_str(&rest[..at]);
            let tail = &rest[at..];
            if tail[..1].eq_ignore_ascii_case("@") {
                // @import "x.css"; or @import url(x.css);
                let end = tail.find(';').map(|e| e + 1).unwrap_or(tail.len());
                let stmt = &tail[..end];
                if depth < 3
                    && let Some((path, bytes)) = self.lookup(dir, target_ref(stmt).unwrap_or(""))
                {
                    out.push_str(&self.inline_css(&String::from_utf8_lossy(bytes), dir_of(&path), depth + 1));
                    rest = &tail[end..];
                    continue;
                }
                out.push_str(stmt);
                rest = &tail[end..];
                continue;
            }
            let inner_start = 4;
            let Some(close) = tail.find(')') else {
                out.push_str(tail);
                rest = "";
                break;
            };
            let raw = tail[inner_start..close].trim();
            let reference = raw.trim_matches(|c| c == '"' || c == '\'');
            match self.data_url(dir, reference) {
                Some(url) => {
                    out.push_str("url(\"");
                    out.push_str(&url);
                    out.push_str("\")");
                }
                None => out.push_str(&tail[..=close]),
            }
            rest = &tail[close + 1..];
        }
        out.push_str(rest);
        out
    }

    fn inline_html(&self, html: &str, dir: &str) -> String {
        let mut out = String::with_capacity(html.len());
        let mut i = 0;
        while let Some(rel) = html[i..].find('<') {
            let start = i + rel;
            out.push_str(&html[i..start]);
            let rest = &html[start..];
            if rest.starts_with("<!--") {
                let end = rest.find("-->").map(|e| e + 3).unwrap_or(rest.len());
                out.push_str(&rest[..end]);
                i = start + end;
                continue;
            }
            let is_tag = rest.len() > 1 && rest.as_bytes()[1].is_ascii_alphabetic();
            let Some(tag_end) = is_tag.then(|| tag_end(rest)).flatten() else {
                out.push('<');
                i = start + 1;
                continue;
            };
            let tag = &rest[..tag_end];
            let name =
                tag[1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
            i = start + tag_end;
            match name.as_str() {
                "script" | "style" => {
                    let close = format!("</{name}");
                    let body_end = find_ci(&html[i..], &[&close]).unwrap_or(html.len() - i);
                    let body = &html[i..i + body_end];
                    let after = html[i + body_end..].find('>').map(|e| i + body_end + e + 1).unwrap_or(html.len());
                    if name == "style" {
                        out.push_str(tag);
                        out.push_str(&self.inline_css(body, dir, 0));
                        out.push_str(&html[i + body_end..after]);
                    } else {
                        let attrs = parse_attrs(tag);
                        let src = attr(&attrs, "src").map(|a| a.value.clone());
                        match src.as_deref().and_then(|s| self.lookup(dir, s)) {
                            Some((_, bytes)) => {
                                out.push_str(&rebuild(tag, &attrs, &["src"]));
                                let text = String::from_utf8_lossy(bytes);
                                let text = match (is_module(&attrs), src.as_deref().and_then(|s| self.lookup(dir, s))) {
                                    (true, Some((path, _))) => {
                                        self.rewrite_module(&text, &path, &mut vec![path.clone()])
                                    }
                                    _ => text.into_owned(),
                                };
                                out.push_str(&text.replace("</script", "<\\/script"));
                                out.push_str("</script>");
                            }
                            None => {
                                out.push_str(tag);
                                if src.is_none() && is_module(&attrs) {
                                    let own = if dir.is_empty() {
                                        "_inline.js".to_string()
                                    } else {
                                        format!("{dir}/_inline.js")
                                    };
                                    out.push_str(&self.rewrite_module(body, &own, &mut vec![own.clone()]));
                                    out.push_str(&html[i + body_end..after]);
                                } else {
                                    out.push_str(&html[i..after]);
                                }
                            }
                        }
                    }
                    i = after;
                }
                "link" => {
                    let attrs = parse_attrs(tag);
                    let rel = attr(&attrs, "rel").map(|a| a.value.to_ascii_lowercase()).unwrap_or_default();
                    let href = attr(&attrs, "href").map(|a| a.value.clone());
                    if let Some(href) = href.as_deref()
                        && rel.split_whitespace().any(|r| r == "stylesheet")
                        && let Some((path, bytes)) = self.lookup(dir, href)
                    {
                        let css = self.inline_css(&String::from_utf8_lossy(bytes), dir_of(&path), 0);
                        out.push_str("<style>");
                        out.push_str(&css.replace("</style", "<\\/style"));
                        out.push_str("</style>");
                    } else {
                        out.push_str(&rewrite_attrs(tag, &attrs, |n, v| {
                            (n == "href" && (rel.contains("icon") || rel.contains("preload")))
                                .then(|| self.data_url(dir, v))
                                .flatten()
                        }));
                    }
                }
                _ => {
                    let attrs = parse_attrs(tag);
                    out.push_str(&rewrite_attrs(tag, &attrs, |n, v| match n {
                        "src" | "poster" | "data" => self.data_url(dir, v),
                        "style" if v.to_ascii_lowercase().contains("url(") => Some(self.inline_css(v, dir, 0)),
                        _ => None,
                    }));
                }
            }
        }
        out.push_str(&html[i..]);
        out
    }
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

/// The byte index just after the `>` closing a tag that starts at 0, skipping quoted values.
fn tag_end(s: &str) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (i, b) in s.bytes().enumerate() {
        match (quote, b) {
            (Some(q), b) if b == q => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(b),
            (None, b'>') => return Some(i + 1),
            _ => {}
        }
    }
    None
}

/// The first position of any needle in `s`, ignoring ASCII case.
fn find_ci(s: &str, needles: &[&str]) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    needles.iter().filter_map(|n| lower.find(n)).min()
}

/// The quoted or `url(...)` address in an `@import` statement.
fn target_ref(stmt: &str) -> Option<&str> {
    let s = stmt.trim_start_matches(|c: char| c != '"' && c != '\'' && c != '(');
    css_ref(s)
}

fn css_ref(s: &str) -> Option<&str> {
    let s = s.trim_start_matches('(').trim_start();
    let q = s.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let body = &s[1..];
    body.find(q).map(|e| &body[..e])
}

struct Attr {
    name: String,
    value: String,
    /// Byte range of the value inside the tag (without quotes); `None` for a bare attribute.
    span: Option<(usize, usize)>,
    /// Byte range of the whole attribute (name through closing quote).
    whole: (usize, usize),
}

fn attr<'x>(attrs: &'x [Attr], name: &str) -> Option<&'x Attr> {
    attrs.iter().find(|a| a.name == name)
}

fn parse_attrs(tag: &str) -> Vec<Attr> {
    let b = tag.as_bytes();
    let mut i = 1;
    while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' && b[i] != b'/' {
        i += 1;
    }
    let mut out = Vec::new();
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if i >= b.len() || b[i] == b'>' {
            break;
        }
        let ns = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        let name = tag[ns..i].to_ascii_lowercase();
        let mut j = i;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < b.len() && b[j] == b'=' {
            j += 1;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            let (vs, ve, end) = if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                let q = b[j];
                let vs = j + 1;
                let ve = b[vs..].iter().position(|c| *c == q).map(|p| vs + p).unwrap_or(b.len());
                (vs, ve, (ve + 1).min(b.len()))
            } else {
                let vs = j;
                let mut ve = j;
                while ve < b.len() && !b[ve].is_ascii_whitespace() && b[ve] != b'>' {
                    ve += 1;
                }
                (vs, ve, ve)
            };
            out.push(Attr { name, value: tag[vs..ve].to_string(), span: Some((vs, ve)), whole: (ns, end) });
            i = end;
        } else {
            out.push(Attr { name, value: String::new(), span: None, whole: (ns, i) });
        }
    }
    out
}

/// The tag with the attributes in `drop` removed and `add` appended.
fn rebuild(tag: &str, attrs: &[Attr], drop: &[&str]) -> String {
    let mut out = String::new();
    let mut last = 0;
    for a in attrs.iter().filter(|a| drop.contains(&a.name.as_str())) {
        out.push_str(&tag[last..a.whole.0]);
        last = a.whole.1;
    }
    out.push_str(&tag[last..]);
    out
}

/// The tag with attribute values replaced where `f(name, value)` gives a new one (written double-quoted).
fn rewrite_attrs(tag: &str, attrs: &[Attr], f: impl Fn(&str, &str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut last = 0;
    for a in attrs {
        if a.span.is_none() {
            continue;
        }
        let Some(new) = f(&a.name, &a.value) else { continue };
        out.push_str(&tag[last..a.whole.0]);
        out.push_str(&format!("{}=\"{}\"", a.name, new.replace('"', "&quot;")));
        last = a.whole.1;
    }
    out.push_str(&tag[last..]);
    out
}

fn is_module(attrs: &[Attr]) -> bool {
    attr(attrs, "type").is_some_and(|a| a.value.trim().eq_ignore_ascii_case("module"))
}

/// The byte ranges (inside the quotes) of the static module specifiers in JavaScript source: `import x from 'a'`,
/// `import 'a'`, `export … from 'a'` and `import('a')`. Comments, strings and templates are skipped.
fn module_specifiers(src: &str) -> Vec<(usize, usize)> {
    let b = src.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    // the string literal starting at the first non-space byte at or after `j`
    let literal = |mut j: usize| -> Option<(usize, usize)> {
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        let q = *b.get(j).filter(|c| **c == b'"' || **c == b'\'')?;
        let end = b[j + 1..].iter().position(|c| *c == q || *c == b'\n')? + j + 1;
        (b[end] == q).then_some((j + 1, end))
    };
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                i = b[i..].iter().position(|c| *c == b'\n').map_or(b.len(), |p| i + p);
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = src[i + 2..].find("*/").map_or(b.len(), |p| i + 2 + p + 2);
            }
            q @ (b'"' | b'\'' | b'`') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            c if word(c) => {
                let start = i;
                while i < b.len() && word(b[i]) {
                    i += 1;
                }
                let after_dot = src[..start].trim_end().ends_with('.');
                match &src[start..i] {
                    "from" if !after_dot => found.extend(literal(i)),
                    "import" if !after_dot => {
                        let mut j = i;
                        while j < b.len() && b[j].is_ascii_whitespace() {
                            j += 1;
                        }
                        if b.get(j) == Some(&b'(') {
                            found.extend(literal(j + 1).filter(|(_, e)| {
                                let mut k = e + 1;
                                while k < b.len() && b[k].is_ascii_whitespace() {
                                    k += 1;
                                }
                                matches!(b.get(k), Some(b')' | b','))
                            }));
                        } else {
                            found.extend(literal(i));
                        }
                    }
                    _ => {}
                }
            }
            _ => i += 1,
        }
    }
    found.sort_unstable();
    found.dedup();
    found
}
