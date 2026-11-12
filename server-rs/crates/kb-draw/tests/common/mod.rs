//! Shared by the ported tests of the drawings: the sample drawings, pictures and forms, and a client for the
//! multipart forms of the sketch routes (the harness client sends one file part only).
#![allow(dead_code)]

pub mod hash;
pub mod service;

use std::io::Write;
use std::time::Duration;

use flate2::Compression;
use flate2::write::{DeflateEncoder, ZlibEncoder};
use serde_json::{Value, json};
use testkit::{Client, Server};

/// `tests/test_diagrams.py` `SOURCE`.
pub const SOURCE: &str = concat!(
    "<mxfile><diagram name=\"Page-1\"><mxGraphModel><root>",
    "<mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>",
    "<mxCell id=\"2\" value=\"Client\" vertex=\"1\" parent=\"1\"/>",
    "<mxCell id=\"3\" value=\"API &lt;b&gt;gateway&lt;/b&gt;\" vertex=\"1\" parent=\"1\"/>",
    "<mxCell id=\"4\" value=\"yes\" edge=\"1\" parent=\"1\" source=\"2\" target=\"3\"/>",
    "</root></mxGraphModel></diagram></mxfile>"
);

/// `EMPTY`.
pub const EMPTY: &str = concat!(
    "<mxfile><diagram><mxGraphModel><root>",
    "<mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>",
    "</root></mxGraphModel></diagram></mxfile>"
);

/// `SVG`.
pub const SVG: &str =
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\"/></svg>";

/// `POST /projects` as the Python tests do it (`Kanban`, `KAN`, `#0a0`), returning the project's id.
pub async fn pid(c: &Client) -> String {
    let r = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
    r.assert_status(201);
    r.json()["id"].as_str().expect("project id").to_string()
}

/// `POST /projects/{pid}/members`.
pub async fn member(c: &Client, pid: &str, name: &str, role: &str) {
    let r = c.post(&format!("/projects/{pid}/members"), json!({"name": name, "color": "#123456", "role": role})).await;
    r.assert_status(201);
}

/// `{"label": "Auth flow", "source": SOURCE, "svg": SVG, **extra}`.
pub fn body(extra: Value) -> Value {
    let mut out = json!({"label": "Auth flow", "source": SOURCE, "svg": SVG});
    for (k, v) in extra.as_object().expect("extra fields") {
        out[k] = v.clone();
    }
    out
}

/// `make(c, pid, **kw)`: save a diagram, expecting 201.
pub async fn make(c: &Client, pid: &str, extra: Value) -> Value {
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(extra)).await;
    r.assert_status(201);
    r.json()
}

// --- pictures and drawings of the sketch tests ---------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

/// `png(width, height, extra)`: a real PNG of one colour; `extra` pads it with an ancillary chunk to reach a size.
pub fn png(width: u32, height: u32, extra: usize) -> Vec<u8> {
    let mut raw = Vec::new();
    for _ in 0..height {
        raw.extend(std::iter::once(0u8).chain(std::iter::repeat_n(0xff, 4 * width as usize)));
    }
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    out.extend(chunk(b"IHDR", &header));
    if extra > 0 {
        let mut text = b"k\0".to_vec();
        text.extend(std::iter::repeat_n(b'x', extra));
        out.extend(chunk(b"tEXt", &text));
    }
    let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
    z.write_all(&raw).expect("deflate");
    out.extend(chunk(b"IDAT", &z.finish().expect("deflate")));
    out.extend(chunk(b"IEND", b""));
    out
}

/// `source(width, height, layers, **kw)`: the editable source of a drawing, `json.dumps`'d.
pub fn source(width: u32, height: u32, layers: usize, extra: Value) -> Vec<u8> {
    let layer_list: Vec<Value> = (0..layers)
        .map(|i| json!({"id": format!("l{i}"), "name": format!("Layer {i}"), "visible": true, "opacity": 1}))
        .collect();
    let mut doc = json!({
        "format": "kanban-sketch", "version": 1, "width": width, "height": height, "background": "white",
        "layers": layer_list,
    });
    for (k, v) in extra.as_object().expect("extra fields") {
        doc[k] = v.clone();
    }
    kb_base::pyjson::dumps(&doc).into_bytes()
}

// --- multipart forms -----------------------------------------------------------------------------------------------

/// A reply of a form request.
pub struct Reply {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| {
            panic!("{}: body is not JSON ({e}): {}", self.status, String::from_utf8_lossy(&self.body))
        })
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn detail(&self) -> Value {
        self.json()["detail"].clone()
    }

    pub fn header(&self, name: &str) -> String {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
    }
}

/// One file part: `(field, file name, content type, bytes)`.
pub type FilePart = (String, String, String, Vec<u8>);

/// `files={"png": ("drawing.png", bytes, "image/png"), "source": (...)}`.
pub fn files(width: u32, height: u32, layers: usize) -> Vec<FilePart> {
    vec![
        ("png".into(), "drawing.png".into(), "image/png".into(), png(width, height, 0)),
        (
            "source".into(),
            "drawing.sketch.json".into(),
            "application/json".into(),
            source(width, height, layers, json!({})),
        ),
    ]
}

/// A request with a multipart form (`data=` fields and `files=` parts) and optional extra headers.
pub async fn form(
    server: &Server,
    method: &str,
    path: &str,
    fields: &[(&str, &str)],
    parts: Vec<FilePart>,
    headers: &[(&str, &str)],
) -> Reply {
    let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(120)).build().expect("client");
    let mut multipart = reqwest::multipart::Form::new();
    for (k, v) in fields {
        multipart = multipart.text(k.to_string(), v.to_string());
    }
    for (field, name, content_type, bytes) in parts {
        let part = reqwest::multipart::Part::bytes(bytes).file_name(name).mime_str(&content_type).expect("mime");
        multipart = multipart.part(field, part);
    }
    let mut rb = http
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).expect("method"),
            format!("{}{path}", server.base_url()),
        )
        .multipart(multipart);
    for (n, v) in headers {
        rb = rb.header(*n, *v);
    }
    let r = rb.send().await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    let body = r.bytes().await.expect("body").to_vec();
    Reply { status, headers, body }
}

/// A plain GET with extra headers, returning raw bytes (the harness client reads JSON or text only).
pub async fn raw_get(server: &Server, path: &str, headers: &[(&str, &str)]) -> Reply {
    let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(120)).build().expect("client");
    let mut rb = http.get(format!("{}{path}", server.base_url()));
    for (n, v) in headers {
        rb = rb.header(*n, *v);
    }
    let r = rb.send().await.unwrap_or_else(|e| panic!("GET {path}: {e}"));
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    let body = r.bytes().await.expect("body").to_vec();
    Reply { status, headers, body }
}

// --- compressed pages ----------------------------------------------------------------------------------------------

/// `urllib.parse.quote(text)`: everything but letters, digits, `_.-~` and `/` is escaped.
pub fn quote(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"_.-~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `base64(raw deflate(quote(inner)))`, as draw.io stores a compressed page.
pub fn pack(inner: &str) -> String {
    use base64::Engine;
    let mut z = DeflateEncoder::new(Vec::new(), Compression::default());
    z.write_all(quote(inner).as_bytes()).expect("deflate");
    base64::engine::general_purpose::STANDARD.encode(z.finish().expect("deflate"))
}

/// `tests/test_diagram_mcp.py` `drawio(*labels, extra=...)`.
pub fn drawio(labels: &[&str], extra: &str) -> String {
    let mut cells = String::new();
    for (i, label) in labels.iter().enumerate() {
        cells.push_str(&format!(
            "<mxCell id=\"n{i}\" value=\"{label}\" style=\"rounded=1;fillColor=#E6F2EA;\" vertex=\"1\" parent=\"1\">\
             <mxGeometry x=\"{}\" y=\"40\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell>",
            40 + 160 * i
        ));
    }
    let mut edges = String::new();
    for i in 0..labels.len().saturating_sub(1) {
        let value = if i == 0 { "yes" } else { "" };
        edges.push_str(&format!(
            "<mxCell id=\"e{i}\" value=\"{value}\" style=\"endArrow=classic;\" edge=\"1\" parent=\"1\" source=\"n{i}\" \
             target=\"n{}\"><mxGeometry relative=\"1\" as=\"geometry\"/></mxCell>",
            i + 1
        ));
    }
    format!(
        "<mxfile><diagram name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>\
         {cells}{edges}{extra}</root></mxGraphModel></diagram></mxfile>"
    )
}
