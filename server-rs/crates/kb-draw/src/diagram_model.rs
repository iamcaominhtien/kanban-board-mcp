//! Reads a draw.io drawing and draws a basic SVG preview of its first page.
//!
//! The editable source is the real `.drawio` XML and is never rewritten here. The SVG made here is a plain preview
//! (boxes, ellipses, diamonds, cylinders, arrows and text; any other shape is drawn as a box); the draw.io editor
//! draws the fine one the next time a person saves.

use std::sync::OnceLock;

use base64::Engine;
use kb_base::pytext;
use kb_doctext::docs_text::DocsError;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::hooks;
use crate::html;
use crate::xml::{self, Element, XmlError};

pub const DEFAULT_W: f64 = 120.0;
pub const DEFAULT_H: f64 = 60.0;
pub const MAX_CELLS: usize = 2000;
/// How many shapes and links `model` lists by default.
pub const MODEL_CELLS: usize = 300;

/// What `diagrams.sanitize_svg` registers with `ET.register_namespace`, as `(uri, prefix)`: a process-wide setting
/// of ElementTree that every later `ET.tostring` sees.
pub const REGISTERED_NAMESPACES: [(&str, &str); 2] =
    [("http://www.w3.org/2000/svg", ""), ("http://www.w3.org/1999/xlink", "xlink")];

/// What a function of this module raises: a `DocsError` (422 `invalid_diagram_edit`), or the `ValueError` of a
/// number that is not one (`float("abc")`), which nothing above catches.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// `raise DocsError(...)`.
    Docs(DocsError),
    /// `ValueError(message)`.
    Value(String),
}

impl From<DocsError> for Error {
    fn from(err: DocsError) -> Self {
        Error::Docs(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Docs(err) => err.fmt(f),
            Error::Value(text) => f.write_str(text),
        }
    }
}

impl std::error::Error for Error {}

/// `_bad(message)`.
fn bad(message: impl Into<String>) -> Error {
    Error::Docs(DocsError::new(422, "invalid_diagram_edit", message))
}

// --- reading ---------------------------------------------------------------------------------

/// `_parse(text)`.
fn parse(text: &str) -> Result<Element, Error> {
    xml::fromstring(text).map_err(|e: XmlError| bad(format!("The diagram XML could not be read ({e}).")))
}

/// `urllib.parse.unquote(text)`: percent escapes decoded as UTF-8, bad sequences replaced.
pub fn unquote(text: &str) -> String {
    if !text.contains('%') {
        return text.to_string();
    }
    // the ASCII runs are unquoted as bytes and decoded together; the rest is kept as it is
    let mut out = String::new();
    let mut run: Vec<u8> = Vec::new();
    let bytes = text.as_bytes();
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut i = 0;
    let flush = |run: &mut Vec<u8>, out: &mut String| {
        out.push_str(&String::from_utf8_lossy(run));
        run.clear();
    };
    while i < bytes.len() {
        let b = bytes[i];
        if b >= 0x80 {
            flush(&mut run, &mut out);
            let ch_len = text[i..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&text[i..i + ch_len]);
            i += ch_len;
        } else if b == b'%' && i + 2 < bytes.len() && hex(bytes[i + 1]).is_some() && hex(bytes[i + 2]).is_some() {
            run.push(hex(bytes[i + 1]).unwrap_or(0) * 16 + hex(bytes[i + 2]).unwrap_or(0));
            i += 3;
        } else {
            run.push(b);
            i += 1;
        }
    }
    flush(&mut run, &mut out);
    out
}

/// `base64.b64decode(data)` (not strict: characters outside the alphabet are skipped); `None` for a `binascii.Error`.
pub fn b64decode(data: &str) -> Option<Vec<u8>> {
    // a str with a character outside ASCII is refused before it is decoded
    if !data.is_ascii() {
        return None;
    }
    let mut out = Vec::new();
    let (mut quad, mut left, mut pads) = (0u8, 0u8, 0u8);
    for ch in data.chars() {
        let c = ch as u8;
        if c == b'=' {
            if quad >= 2 {
                pads += 1;
                if quad + pads >= 4 {
                    return Some(out);
                }
            }
            continue;
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        pads = 0;
        match quad {
            0 => {
                quad = 1;
                left = v;
            }
            1 => {
                quad = 2;
                out.push((left << 2) | (v >> 4));
                left = v & 0x0f;
            }
            2 => {
                quad = 3;
                out.push((left << 4) | (v >> 2));
                left = v & 0x03;
            }
            _ => {
                quad = 0;
                out.push((left << 6) | v);
            }
        }
    }
    if quad != 0 { None } else { Some(out) }
}

/// `zlib.decompress(data, -15)`: a raw deflate stream; `None` for a `zlib.error`.
pub fn inflate_raw(data: &[u8]) -> Option<Vec<u8>> {
    use flate2::{Decompress, FlushDecompress, Status};
    const LIMIT: usize = 1 << 30;
    let mut dec = Decompress::new(false);
    let mut out: Vec<u8> = Vec::with_capacity(data.len().saturating_mul(4).min(1 << 24));
    loop {
        if out.len() > LIMIT {
            return None;
        }
        let before_in = dec.total_in();
        let before_out = dec.total_out();
        out.reserve(64 * 1024);
        let input = &data[usize::try_from(before_in).ok()?..];
        match dec.decompress_vec(input, &mut out, FlushDecompress::Finish).ok()? {
            Status::StreamEnd => return Some(out),
            Status::Ok | Status::BufError => {
                if dec.total_in() == before_in && dec.total_out() == before_out {
                    return None;
                }
            }
        }
    }
}

/// `_inflate(data)`: the `mxGraphModel` inside a compressed page.
pub(crate) fn inflate(data: &str) -> Result<Element, Error> {
    let failed = || bad("The first page of the diagram is compressed in an unknown way.");
    let raw = b64decode(pytext::strip(data)).and_then(|b| inflate_raw(&b)).ok_or_else(failed)?;
    let text = String::from_utf8(raw).map_err(|_| failed())?;
    parse(&unquote(&text))
}

/// The first page of a `.drawio` file as an editable graph. Other pages are kept untouched.
#[derive(Debug, Clone)]
pub struct Drawing {
    /// The `mxGraphModel` of the first page, with its `root` container.
    model: Element,
    /// Index of the `root` container among the model's children.
    container: usize,
    /// The first `diagram` element's `name` attribute (`None` for a bare model or a page without a name).
    page_name: Option<String>,
    /// How many pages the file has.
    pub pages: usize,
}

impl Drawing {
    /// Parse `source` (an `<mxfile>` or a bare `<mxGraphModel>`).
    pub fn new(source: &str) -> Result<Drawing, Error> {
        let root = parse(source)?;
        let mut page_name = None;
        let mut pages = 1;
        let mut model = match root.local() {
            "mxGraphModel" => root,
            "mxfile" => {
                let diagrams: Vec<&Element> = root.children.iter().filter(|p| p.local() == "diagram").collect();
                let Some(page) = diagrams.first() else {
                    return Err(bad("The file has no page."));
                };
                pages = diagrams.len();
                page_name = page.get("name").map(str::to_string);
                let text = page.text.as_deref().unwrap_or("");
                let inner = match page.children.iter().find(|c| c.local() == "mxGraphModel") {
                    Some(inner) => Some(inner.clone()),
                    None if !pytext::strip(text).is_empty() => Some(inflate(text)?),
                    None => None,
                };
                inner.ok_or_else(|| bad("The first page is empty."))?
            }
            _ => return Err(bad("This is not a draw.io file (expected <mxfile> or <mxGraphModel>).")),
        };
        let container = match model.children.iter().position(|c| c.local() == "root") {
            Some(i) => i,
            None => {
                model.children.push(Element::new("root"));
                model.children.len() - 1
            }
        };
        let cells = &mut model.children[container].children;
        if !cells.iter().any(|c| c.get("id") == Some("0")) {
            cells.insert(0, Element::with_attrib("mxCell", &[("id", "0")]));
            cells.insert(1, Element::with_attrib("mxCell", &[("id", "1"), ("parent", "0")]));
        }
        if cells.len() > MAX_CELLS {
            return Err(bad(format!("The diagram has more than {MAX_CELLS} elements.")));
        }
        Ok(Drawing { model, container, page_name, pages })
    }

    /// The page's `name` attribute.
    pub fn page_name(&self) -> Option<&str> {
        self.page_name.as_deref()
    }

    /// `self.container`: the cells of the first page.
    pub fn cells(&self) -> &[Element] {
        &self.model.children[self.container].children
    }

    /// `_cell(el)`: the `mxCell` of an element (`UserObject` / `object` wrap one).
    pub fn cell<'a>(&self, el: &'a Element) -> &'a Element {
        if el.local() == "mxCell" {
            return el;
        }
        el.children.iter().find(|c| c.local() == "mxCell").unwrap_or(el)
    }

    /// Every drawn element (vertex or edge), wrappers included.
    pub fn elements(&self) -> Vec<&Element> {
        self.cells()
            .iter()
            .filter(|el| {
                let cell = self.cell(el);
                cell.get("vertex") == Some("1") || cell.get("edge") == Some("1")
            })
            .collect()
    }

    /// The element with this id.
    pub fn find(&self, cell_id: &str) -> Option<&Element> {
        self.cells().iter().find(|e| e.get("id") == Some(cell_id))
    }

    /// `_default_parent`.
    pub fn default_parent(&self) -> String {
        for el in self.cells() {
            if el.get("id").is_some_and(|id| id != "0") && el.local() == "mxCell" && el.get("parent") == Some("0") {
                return match el.get("id") {
                    Some(id) if !id.is_empty() => id.to_string(),
                    _ => "1".to_string(),
                };
            }
        }
        "1".to_string()
    }

    /// The element's text as plain text (HTML labels are flattened).
    pub fn label_of(el: &Element) -> String {
        let raw = if matches!(el.local(), "UserObject" | "object") { el.get("label") } else { el.get("value") };
        plain(raw.unwrap_or(""))
    }

    /// `{x, y, w, h}` of a vertex, relative to its parent.
    pub fn geometry(&self, el: &Element) -> Result<Option<Geometry>, Error> {
        let Some(g) = self.cell(el).children.iter().find(|c| c.local() == "mxGeometry") else {
            return Ok(None);
        };
        let num = |key: &str, default: f64| -> Result<f64, Error> {
            match g.get(key) {
                Some(v) if !v.is_empty() => py_float(v).map_err(Error::Value),
                _ => Ok(default),
            }
        };
        Ok(Some(Geometry { x: num("x", 0.0)?, y: num("y", 0.0)?, w: num("width", DEFAULT_W)?, h: num("height", DEFAULT_H)? }))
    }
}

/// `{x, y, w, h}`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geometry {
    /// Left edge.
    pub x: f64,
    /// Top edge.
    pub y: f64,
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
}

impl Geometry {
    fn default_box() -> Self {
        Geometry { x: 0.0, y: 0.0, w: DEFAULT_W, h: DEFAULT_H }
    }
}

/// Python's `float(text)`: the error is the `ValueError` message.
pub fn py_float(text: &str) -> Result<f64, String> {
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let re = NUMBER.get_or_init(|| {
        Regex::new(r"^[+-]?(?:(?:[0-9]+(?:_[0-9]+)*)(?:\.(?:[0-9]+(?:_[0-9]+)*)?)?|\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?$")
            .expect("static pattern")
    });
    let stripped = pytext::strip(text);
    let lower = stripped.to_ascii_lowercase();
    let unsigned = lower.trim_start_matches(['+', '-']);
    let sign = if lower.starts_with('-') { -1.0 } else { 1.0 };
    if lower.len() - unsigned.len() <= 1 {
        if unsigned == "inf" || unsigned == "infinity" {
            return Ok(sign * f64::INFINITY);
        }
        if unsigned == "nan" {
            return Ok(f64::NAN);
        }
    }
    if re.is_match(stripped) {
        if let Ok(v) = stripped.replace('_', "").parse::<f64>() {
            return Ok(v);
        }
    }
    Err(format!("could not convert string to float: {}", pytext::repr(text)))
}

/// `round(value, 1)`.
pub fn round1(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    format!("{value:.1}").parse().unwrap_or(value)
}

/// `f"{value:g}"`.
pub fn fmt_g(value: f64) -> String {
    if value == 0.0 {
        return if value.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    if !value.is_finite() {
        return if value.is_nan() { "nan".into() } else if value > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let sci = format!("{value:.5e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if !(-4..6).contains(&exp) {
        let mantissa = if mantissa.contains('.') { mantissa.trim_end_matches('0').trim_end_matches('.') } else { mantissa };
        let sign = if exp < 0 { '-' } else { '+' };
        return format!("{mantissa}e{sign}{:02}", exp.abs());
    }
    let decimals = (5 - exp).max(0) as usize;
    let text = format!("{value:.decimals$}");
    if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.').to_string() } else { text }
}

fn f1(value: f64) -> String {
    format!("{value:.1}")
}

// --- styles and labels -----------------------------------------------------------------------

/// Value of `key=value` in a draw.io style string.
pub fn style_get<'a>(style: &'a str, key: &str) -> Option<&'a str> {
    for part in style.split(';') {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        if k == key && !v.is_empty() {
            return Some(v);
        }
    }
    None
}

/// `{p.partition("=")[0] for p in style.split(";") if p}`.
fn style_keys(style: &str) -> Vec<&str> {
    style.split(';').filter(|p| !p.is_empty()).map(|p| p.split_once('=').map_or(p, |(k, _)| k)).collect()
}

/// The closest of the agent's shape names for a style string.
pub fn shape_of(style: &str) -> &'static str {
    let keys = style_keys(style);
    let value = style_get(style, "shape").unwrap_or("");
    if keys.contains(&"ellipse") {
        return "ellipse";
    }
    if keys.contains(&"rhombus") {
        return "diamond";
    }
    if value.contains("cylinder") {
        return "cylinder";
    }
    if keys.contains(&"text") {
        return "text";
    }
    if style_get(style, "rounded") == Some("1") { "rounded" } else { "rect" }
}

/// An HTML label as plain text.
pub fn plain(label: &str) -> String {
    static BREAKS: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    let breaks = BREAKS.get_or_init(|| Regex::new(r"(?i)<\s*(?:br|/p|/div)\s*/?>").expect("static pattern"));
    let tags = TAGS.get_or_init(|| Regex::new(r"<[^>]{0,200}>").expect("static pattern"));
    let text = breaks.replace_all(label, "\n");
    let text = tags.replace_all(&text, "");
    pytext::strip(&html::unescape(&text)).to_string()
}

// --- the drawing as a model, for an agent (issue #267) -----------------------------------------

fn is_container(style: &str) -> bool {
    let keys = style_keys(style);
    keys.contains(&"swimlane")
        || style_get(style, "container") == Some("1")
        || keys.contains(&"group")
        || style_get(style, "shape").unwrap_or("").starts_with("table")
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// The first page as the agent reads it: shapes and links with their ids, labels, boxes and styles.
///
/// Returns `{page, pages, shapes: [{id, label, shape, x, y, w, h, style, in?, container?}], links: [{id, label, from,
/// to, style}], problems, truncated?}`. A shape's `x, y` are relative to the shape it is `in` (a group, a
/// container or a lane), else to the page.
pub fn model(source: &str, limit: usize) -> Result<Map<String, Value>, Error> {
    let d = Drawing::new(source)?;
    let layers = ["0".to_string(), "1".to_string(), d.default_parent()];
    let mut shapes: Vec<Value> = Vec::new();
    let mut links: Vec<Value> = Vec::new();
    for el in d.elements() {
        let cell = d.cell(el);
        let style = cell.get("style").unwrap_or("");
        let mut item = Map::new();
        item.insert("id".into(), json!(el.get("id").unwrap_or("")));
        item.insert("label".into(), json!(Drawing::label_of(el)));
        if cell.get("edge") == Some("1") {
            item.insert("from".into(), json!(cell.get("source")));
            item.insert("to".into(), json!(cell.get("target")));
            item.insert("style".into(), json!(style));
            links.push(Value::Object(item));
            continue;
        }
        item.insert("shape".into(), json!(shape_of(style)));
        match d.geometry(el)? {
            Some(g) => {
                for (k, v) in [("x", g.x), ("y", g.y), ("w", g.w), ("h", g.h)] {
                    item.insert(k.into(), number(round1(v)));
                }
            }
            // no geometry: `{"x": 0.0, "y": 0.0, "w": DEFAULT_W, "h": DEFAULT_H}` where the last two are ints
            None => {
                item.insert("x".into(), number(0.0));
                item.insert("y".into(), number(0.0));
                item.insert("w".into(), json!(DEFAULT_W as i64));
                item.insert("h".into(), json!(DEFAULT_H as i64));
            }
        }
        item.insert("style".into(), json!(style));
        if let Some(parent) = cell.get("parent").filter(|p| !p.is_empty() && !layers.iter().any(|l| l == p)) {
            item.insert("in".into(), json!(parent));
        }
        if is_container(style) {
            item.insert("container".into(), json!(true));
        }
        shapes.push(Value::Object(item));
    }
    let mut out = Map::new();
    let page = d.page_name().filter(|n| !n.is_empty()).unwrap_or("Page-1");
    out.insert("page".into(), json!(page));
    out.insert("pages".into(), json!(d.pages));
    let (n_shapes, n_links) = (shapes.len(), links.len());
    shapes.truncate(limit);
    links.truncate(limit);
    out.insert("shapes".into(), Value::Array(shapes));
    out.insert("links".into(), Value::Array(links));
    out.insert("problems".into(), json!(problems(&d)?));
    if n_shapes > limit || n_links > limit {
        out.insert(
            "truncated".into(),
            json!(format!(
                "{n_shapes} shapes and {n_links} links; the first {limit} of each are listed. The .drawio file has them all."
            )),
        );
    }
    Ok(out)
}

/// Two overlapping shapes that were put there on purpose: a small one on a large one (a step's number chip, a
/// lane's name tab, an icon on a card) or one drawn wholly inside a larger one (a lane or pool frame behind its
/// steps, a sequence fragment). Only shapes of about the same size that partly cover each other look broken.
fn on_purpose(a: &Geometry, b: &Geometry) -> bool {
    let (small, big) = if b.w * b.h < a.w * a.h { (b, a) } else { (a, b) };
    if small.w * small.h * 4.0 <= big.w * big.h {
        return true;
    }
    let inside = big.x <= small.x
        && big.y <= small.y
        && small.x + small.w <= big.x + big.w
        && small.y + small.h <= big.y + big.h;
    inside && small.w * small.h < big.w * big.h
}

/// What will look broken once drawn: links to nothing, repeated ids, shapes on top of each other.
pub fn problems(d: &Drawing) -> Result<Vec<String>, Error> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut seen_set = std::collections::HashSet::new();
    for el in d.cells() {
        let Some(id) = el.get("id").filter(|i| !i.is_empty()) else { continue };
        if seen_set.contains(id) {
            out.push(format!("The id {} is used twice: give each shape and link its own id.", pytext::repr(id)));
        }
        seen_set.insert(id.to_string());
        seen.push(id.to_string());
    }
    struct Boxed {
        id: String,
        parent: String,
        g: Geometry,
        skip: bool,
    }
    let mut boxes: Vec<Boxed> = Vec::new();
    for el in d.elements() {
        let cell = d.cell(el);
        if cell.get("edge") == Some("1") {
            for end in ["source", "target"] {
                if let Some(r) = cell.get(end).filter(|r| !r.is_empty()) {
                    if !seen_set.contains(r) {
                        let id = el.get("id").map_or("None".to_string(), pytext::repr);
                        out.push(format!(
                            "Link {id} points at {}, which is not a shape: use the id of a shape on this page (or \
                             drop the attribute and give the link sourcePoint / targetPoint).",
                            pytext::repr(r)
                        ));
                    }
                }
            }
            continue;
        }
        if let Some(g) = d.geometry(el)? {
            let style = cell.get("style").unwrap_or("");
            boxes.push(Boxed {
                id: el.get("id").unwrap_or("").to_string(),
                parent: cell.get("parent").unwrap_or("").to_string(),
                g,
                skip: is_container(style) || style.split(';').any(|p| p == "text"),
            });
        }
    }
    let mut overlaps = 0;
    for (i, a) in boxes.iter().enumerate() {
        for b in &boxes[i + 1..] {
            if a.parent != b.parent || a.skip || b.skip {
                continue;
            }
            if a.g.x < b.g.x + b.g.w
                && b.g.x < a.g.x + a.g.w
                && a.g.y < b.g.y + b.g.h
                && b.g.y < a.g.y + a.g.h
                && !on_purpose(&a.g, &b.g)
            {
                overlaps += 1;
                if overlaps <= 5 {
                    out.push(format!(
                        "Shapes {} and {} overlap: move one so they are at least 40 px apart.",
                        pytext::repr(&a.id),
                        pytext::repr(&b.id)
                    ));
                }
            }
        }
    }
    if overlaps > 5 {
        out.push(format!("... and {} more overlapping pairs.", overlaps - 5));
    }
    let _ = seen;
    Ok(out)
}

/// `source` with every compressed page written out as plain XML (draw.io reads both), so an agent can edit it
/// with its own file tools; unchanged when no page is compressed.
pub fn uncompressed(source: &str) -> String {
    let Ok(mut root) = parse(source) else {
        return source.to_string();
    };
    if root.local() != "mxfile" {
        return source.to_string();
    }
    let mut changed = false;
    for page in root.children.iter_mut() {
        if page.local() != "diagram" || page.children.iter().any(|c| c.local() == "mxGraphModel") {
            continue;
        }
        let data = pytext::strip(page.text.as_deref().unwrap_or("")).to_string();
        if data.is_empty() {
            continue;
        }
        let Ok(inner) = inflate(&data) else { continue };
        page.text = None;
        page.children.push(inner);
        changed = true;
    }
    if !changed {
        return source.to_string();
    }
    // `ET.register_namespace` has been called by the time anything is exported (`diagrams.sanitize_svg`)
    xml::tostring(&root, &REGISTERED_NAMESPACES)
}

/// A picture of the first page made without a browser: shapes as outlined boxes, links as lines, no text. The
/// picture is drawn by the canvas code (`hooks::canvas_raster`); `None` while that area has not registered itself.
pub fn wireframe_png(source: &str, max_side: f64) -> Result<Option<Vec<u8>>, Error> {
    let Some(factory) = hooks::canvas_raster() else {
        return Ok(None);
    };
    let d = Drawing::new(source)?;
    let layers = ["0".to_string(), "1".to_string(), d.default_parent()];
    // (id, box) in insertion order, a later shape with the same id replacing the earlier one
    let mut boxes: Vec<(String, (f64, f64, f64, f64))> = Vec::new();

    fn absolute(d: &Drawing, layers: &[String], el: &Element, depth: usize) -> Result<(f64, f64, f64, f64), Error> {
        let g = d.geometry(el)?.unwrap_or_else(Geometry::default_box);
        let (mut x, mut y) = (g.x, g.y);
        let parent = d.cell(el).get("parent");
        if !parent.is_some_and(|p| layers.iter().any(|l| l == p)) && depth < 20 {
            if let Some(pe) = d.find(parent.unwrap_or("")) {
                let (px, py, _, _) = absolute(d, layers, pe, depth + 1)?;
                x += px;
                y += py;
            }
        }
        Ok((x, y, g.w, g.h))
    }

    for el in d.elements() {
        if d.cell(el).get("vertex") == Some("1") {
            let id = el.get("id").unwrap_or("").to_string();
            let b = absolute(&d, &layers, el, 0)?;
            match boxes.iter_mut().find(|(k, _)| *k == id) {
                Some(slot) => slot.1 = b,
                None => boxes.push((id, b)),
            }
        }
    }
    if boxes.is_empty() {
        return Ok(Some(factory.new_raster(200, 100).png()));
    }
    let pad = 20.0;
    let left = boxes.iter().map(|(_, b)| b.0).fold(f64::INFINITY, f64::min) - pad;
    let top = boxes.iter().map(|(_, b)| b.1).fold(f64::INFINITY, f64::min) - pad;
    let width = boxes.iter().map(|(_, b)| b.0 + b.2).fold(f64::NEG_INFINITY, f64::max) + pad - left;
    let height = boxes.iter().map(|(_, b)| b.1 + b.3).fold(f64::NEG_INFINITY, f64::max) + pad - top;
    let scale = (max_side / width.max(height).max(1.0)).min(1.0);
    let mut r = factory.new_raster((width * scale) as u32 + 1, (height * scale) as u32 + 1);
    let (ink, line) = ((51, 51, 51), (120, 120, 120));
    let to_px = |x: f64, y: f64| ((x - left) * scale, (y - top) * scale);
    let find = |id: &str| boxes.iter().find(|(k, _)| k == id).map(|(_, b)| *b);
    for el in d.elements() {
        let cell = d.cell(el);
        if cell.get("edge") != Some("1") {
            continue;
        }
        if let (Some(a), Some(b)) = (find(cell.get("source").unwrap_or("")), find(cell.get("target").unwrap_or(""))) {
            let (x1, y1) = to_px(a.0 + a.2 / 2.0, a.1 + a.3 / 2.0);
            let (x2, y2) = to_px(b.0 + b.2 / 2.0, b.1 + b.3 / 2.0);
            r.line(x1, y1, x2, y2, line);
        }
    }
    for (el_id, (x, y, w, h)) in &boxes {
        let style = d.find(el_id).map(|el| d.cell(el).get("style").unwrap_or("")).unwrap_or("");
        let (px, py) = to_px(*x, *y);
        if !is_container(style) {
            r.rect(px, py, w * scale, h * scale, (255, 255, 255));
        }
        r.frame(px, py, w * scale, h * scale, ink, if is_container(style) { 1 } else { 2 });
    }
    Ok(Some(r.png()))
}

// --- SVG preview -----------------------------------------------------------------------------

fn esc(text: &str) -> String {
    html::escape(text)
}

fn wrap(text: &str, width: f64, size: f64) -> Vec<String> {
    let per_line = ((width / (size * 0.58)) as i64).max(4) as usize;
    let mut lines: Vec<String> = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split(' ') {
            let candidate = pytext::strip(&format!("{line} {word}")).to_string();
            if candidate.chars().count() > per_line && !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line = candidate;
            }
        }
        lines.push(line);
    }
    lines
}

type Box4 = (f64, f64, f64, f64);
type Point = (f64, f64);

/// The bends a person or an agent gave a link: `<mxGeometry><Array as="points"><mxPoint x y/>`.
pub fn waypoints(cell: &Element) -> Vec<Point> {
    let Some(g) = cell.children.iter().find(|c| c.local() == "mxGeometry") else {
        return Vec::new();
    };
    let Some(arr) = g.children.iter().find(|c| c.local() == "Array" && c.get("as") == Some("points")) else {
        return Vec::new();
    };
    let coord = |p: &Element, key: &str| -> Result<f64, String> {
        match p.get(key) {
            Some(v) if !v.is_empty() => py_float(v),
            _ => Ok(0.0),
        }
    };
    arr.children.iter().filter_map(|p| Some((coord(p, "x").ok()?, coord(p, "y").ok()?))).collect()
}

/// The points a link is drawn through: its own bends, else for an orthogonal link an elbow between the facing sides
/// (as the editor draws it), else a straight line between the edges of the two shapes.
pub fn route(a: Box4, b: Box4, bends: &[Point], orthogonal: bool, clip: &dyn Fn(Box4, Point) -> Point) -> Vec<Point> {
    let ca = (a.0 + a.2 / 2.0, a.1 + a.3 / 2.0);
    let cb = (b.0 + b.2 / 2.0, b.1 + b.3 / 2.0);
    if !bends.is_empty() {
        let mut path = vec![clip(a, bends[0])];
        path.extend_from_slice(bends);
        path.push(clip(b, bends[bends.len() - 1]));
        if !orthogonal {
            return path;
        }
        let mut out = vec![path[0]];
        for p in &path[1..] {
            let q = out[out.len() - 1];
            if (p.0 - q.0).abs() > 0.5 && (p.1 - q.1).abs() > 0.5 {
                out.push((p.0, q.1));
            }
            out.push(*p);
        }
        return out;
    }
    if !orthogonal {
        return vec![clip(a, cb), clip(b, ca)];
    }
    let (dx, dy) = (cb.0 - ca.0, cb.1 - ca.1);
    if dy.abs() >= dx.abs() {
        let s = (ca.0, if dy > 0.0 { a.1 + a.3 } else { a.1 });
        let e = (cb.0, if dy > 0.0 { b.1 } else { b.1 + b.3 });
        if (s.0 - e.0).abs() < 0.5 {
            return vec![s, e];
        }
        let mid = (s.1 + e.1) / 2.0;
        return vec![s, (s.0, mid), (e.0, mid), e];
    }
    let s = (if dx > 0.0 { a.0 + a.2 } else { a.0 }, ca.1);
    let e = (if dx > 0.0 { b.0 } else { b.0 + b.2 }, cb.1);
    if (s.1 - e.1).abs() < 0.5 {
        return vec![s, e];
    }
    let mid = (s.0 + e.0) / 2.0;
    vec![s, (mid, s.1), (mid, e.1), e]
}

fn edge_point(box4: Box4, toward: Point) -> Point {
    let (x, y, w, h) = box4;
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    let (dx, dy) = (toward.0 - cx, toward.1 - cy);
    if dx == 0.0 && dy == 0.0 {
        return (cx, cy);
    }
    let sx = if dx != 0.0 { (w / 2.0) / dx.abs() } else { f64::INFINITY };
    let sy = if dy != 0.0 { (h / 2.0) / dy.abs() } else { f64::INFINITY };
    let scale = sx.min(sy);
    (cx + dx * scale, cy + dy * scale)
}

/// An insertion-ordered map where a later key replaces the value of an earlier one (a Python dict).
struct Ordered<V>(Vec<(String, V)>);

impl<V> Ordered<V> {
    fn new() -> Self {
        Ordered(Vec::new())
    }

    fn set(&mut self, key: String, value: V) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key, value)),
        }
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.0.iter().map(|(_, v)| v)
    }
}

/// A basic SVG of the first page: shapes, connectors with arrows, and labels.
pub fn render_svg(source: &str) -> Result<String, Error> {
    let d = Drawing::new(source)?;
    let default_parent = d.default_parent();
    let mut boxes: Ordered<Box4> = Ordered::new();

    let absolute = |el: &Element| -> Result<Option<Box4>, Error> {
        let Some(g) = d.geometry(el)? else { return Ok(None) };
        let (mut x, mut y) = (g.x, g.y);
        let mut parent: Option<String> = d.cell(el).get("parent").map(str::to_string);
        let mut seen = 0;
        while !parent.as_deref().is_none_or(|p| p == "0" || p == "1" || p == default_parent) && seen < 20 {
            let pe = d.find(parent.as_deref().unwrap_or(""));
            let pg = match pe {
                Some(pe) => d.geometry(pe)?,
                None => None,
            };
            if let Some(pg) = pg {
                x += pg.x;
                y += pg.y;
            }
            parent = pe.and_then(|pe| d.cell(pe).get("parent")).map(str::to_string);
            seen += 1;
        }
        Ok(Some((x, y, g.w, g.h)))
    };

    let elements = d.elements();
    let verts: Vec<&Element> = elements.iter().copied().filter(|e| d.cell(e).get("vertex") == Some("1")).collect();
    for e in &verts {
        if let Some(b) = absolute(e)? {
            boxes.set(e.get("id").unwrap_or("").to_string(), b);
        }
    }
    let mut parts: Vec<String> = Vec::new();
    // arrows are drawn after the shapes so containers never hide them
    let mut edge_parts: Vec<String> = Vec::new();
    let (mut xs, mut ys, mut xe, mut ye) = (vec![0.0], vec![0.0], vec![200.0], vec![100.0]);
    if !boxes.0.is_empty() {
        xs = boxes.values().map(|b| b.0).collect();
        ys = boxes.values().map(|b| b.1).collect();
        xe = boxes.values().map(|b| b.0 + b.2).collect();
        ye = boxes.values().map(|b| b.1 + b.3).collect();
    }
    // a link's own bends (waypoints) count too, so a loop drawn around the outside is not cut off
    let mut bends: Ordered<Vec<Point>> = Ordered::new();
    for e in &elements {
        let c = d.cell(e);
        if c.get("edge") == Some("1") {
            bends.set(e.get("id").unwrap_or("").to_string(), waypoints(c));
        }
    }
    for pts in bends.values() {
        xs.extend(pts.iter().map(|p| p.0));
        ys.extend(pts.iter().map(|p| p.1));
        xe.extend(pts.iter().map(|p| p.0));
        ye.extend(pts.iter().map(|p| p.1));
    }
    let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let pad = 20.0;
    let (ox, oy) = (min(&xs) - pad, min(&ys) - pad);
    let (width, height) = (max(&xe) - min(&xs) + 2.0 * pad, max(&ye) - min(&ys) + 2.0 * pad);

    for e in &elements {
        let c = d.cell(e);
        if c.get("edge") != Some("1") {
            continue;
        }
        let (Some(a), Some(b)) = (boxes.get(c.get("source").unwrap_or("")), boxes.get(c.get("target").unwrap_or("")))
        else {
            continue;
        };
        let style = c.get("style").unwrap_or("");
        let no_bends: Vec<Point> = Vec::new();
        let path = route(
            *a,
            *b,
            bends.get(e.get("id").unwrap_or("")).unwrap_or(&no_bends),
            style_get(style, "edgeStyle") == Some("orthogonalEdgeStyle"),
            &edge_point,
        );
        let color = style_get(style, "strokeColor").unwrap_or("#333333");
        let pts: Vec<String> = path.iter().map(|(x, y)| format!("{},{}", f1(x - ox), f1(y - oy))).collect();
        edge_parts.push(format!(
            "<polyline points=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"1.5\" marker-end=\"url(#arrow)\"/>",
            pts.join(" "),
            esc(color)
        ));
        let label = Drawing::label_of(e);
        if !label.is_empty() {
            // on the middle of the longest segment, where draw.io puts it too
            let mut seg = (path[0], path[1.min(path.len() - 1)]);
            let mut best = f64::NEG_INFINITY;
            for pair in path.windows(2) {
                let len = (pair[1].0 - pair[0].0).abs() + (pair[1].1 - pair[0].1).abs();
                if len > best {
                    best = len;
                    seg = (pair[0], pair[1]);
                }
            }
            let (p, q) = seg;
            let (mx, my) = ((p.0 + q.0) / 2.0 - ox, (p.1 + q.1) / 2.0 - oy);
            edge_parts.push(format!(
                "<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" font-size=\"11\" fill=\"#333333\" stroke=\"#ffffff\" \
                 stroke-width=\"3\" paint-order=\"stroke\">{}</text>",
                f1(mx),
                f1(my - 4.0),
                esc(&label)
            ));
        }
    }
    for e in &verts {
        let Some(b) = boxes.get(e.get("id").unwrap_or("")) else { continue };
        let (x, y, w, h) = (b.0 - ox, b.1 - oy, b.2, b.3);
        let style = d.cell(e).get("style").unwrap_or("");
        let shape = shape_of(style);
        let fill = style_get(style, "fillColor").unwrap_or("#ffffff");
        let stroke = style_get(style, "strokeColor").unwrap_or("#333333");
        let mut attrs = format!("fill=\"{}\" stroke=\"{}\" stroke-width=\"1.5\"", esc(fill), esc(stroke));
        if shape == "text" {
            attrs = "fill=\"none\" stroke=\"none\"".to_string();
        }
        match shape {
            "ellipse" => parts.push(format!(
                "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" {attrs}/>",
                f1(x + w / 2.0),
                f1(y + h / 2.0),
                f1(w / 2.0),
                f1(h / 2.0)
            )),
            "diamond" => {
                let pts = format!(
                    "{},{} {},{} {},{} {},{}",
                    f1(x + w / 2.0),
                    f1(y),
                    f1(x + w),
                    f1(y + h / 2.0),
                    f1(x + w / 2.0),
                    f1(y + h),
                    f1(x),
                    f1(y + h / 2.0)
                );
                parts.push(format!("<polygon points=\"{pts}\" {attrs}/>"));
            }
            "cylinder" => {
                let ry = 15.0_f64.min(h / 4.0);
                parts.push(format!(
                    "<path d=\"M{},{} a{},{} 0 0,1 {},0 v{} a{},{} 0 0,1 {},0 z\" {attrs}/>\
                     <ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" {attrs}/>",
                    f1(x),
                    f1(y + ry),
                    f1(w / 2.0),
                    f1(ry),
                    f1(w),
                    f1(h - 2.0 * ry),
                    f1(w / 2.0),
                    f1(ry),
                    f1(-w),
                    f1(x + w / 2.0),
                    f1(y + ry),
                    f1(w / 2.0),
                    f1(ry)
                ));
            }
            _ => {
                let r = if shape == "rounded" { 8 } else { 0 };
                parts.push(format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{r}\" {attrs}/>",
                    f1(x),
                    f1(y),
                    f1(w),
                    f1(h)
                ));
            }
        }
        let label = Drawing::label_of(e);
        if !label.is_empty() {
            let size = style_get(style, "fontSize").map_or(Ok(12.0), py_float).unwrap_or(12.0);
            let color = style_get(style, "fontColor").unwrap_or("#000000");
            let lines = wrap(&label, w - 10.0, size);
            let first = y + h / 2.0 - (lines.len() as f64 - 1.0) * size * 0.6 + size * 0.35;
            let spans: String = lines
                .iter()
                .enumerate()
                .map(|(i, line)| {
                    format!(
                        "<tspan x=\"{}\" y=\"{}\">{}</tspan>",
                        f1(x + w / 2.0),
                        f1(first + i as f64 * size * 1.2),
                        esc(line)
                    )
                })
                .collect();
            parts.push(format!(
                "<text text-anchor=\"middle\" font-size=\"{}\" fill=\"{}\">{spans}</text>",
                fmt_g(size),
                esc(color)
            ));
        }
    }
    let w0 = format!("{width:.0}");
    let h0 = format!("{height:.0}");
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w0}\" height=\"{h0}\" viewBox=\"0 0 {w0} {h0}\" \
         font-family=\"Helvetica, Arial, sans-serif\"><defs><marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"9\" \
         refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M0,0 L10,5 L0,10 z\" \
         fill=\"#333333\"/></marker></defs>{}{}</svg>",
        parts.concat(),
        edge_parts.concat()
    ))
}

/// Used by the golden test: the base64 of a raw deflate, as draw.io stores a compressed page.
pub fn b64encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
