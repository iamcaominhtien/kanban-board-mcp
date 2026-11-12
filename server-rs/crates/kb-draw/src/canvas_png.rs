//! `services/canvas_png.py`: small pictures made without an image library: the snapshot of an HTML board and the
//! overview of a canvas.
//!
//! A board below 40% zoom shows a picture of its last saved state, and a text export writes the canvas's overview as a
//! PNG. There is no browser on the server, so the pictures are *wireframes* drawn from the page's outline (headings,
//! text, buttons, fields, pictures) and from the plane (boards, notes). They are honest placeholders, not screenshots.

use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use serde_json::Value;

use crate::canvas_html;

/// `Color`: red, green, blue.
pub type Color = (u8, u8, u8);

pub const INK: Color = (30, 42, 34);
pub const GREY: Color = (230, 236, 232);
pub const MID: Color = (190, 201, 194);
pub const GREEN: Color = (46, 111, 64);
pub const PAPER: Color = (244, 246, 244);
pub const WHITE: Color = (255, 255, 255);
pub const PLANE: Color = (243, 245, 243);
pub const DOT: Color = (211, 219, 214);
pub const BORDER: Color = (208, 217, 211);

/// `NOTE_COLORS.get(name, yellow)`.
pub fn note_color(name: &str) -> Color {
    match name {
        "green" => (227, 243, 231),
        "blue" => (221, 236, 250),
        "pink" => (252, 226, 233),
        "purple" => (239, 232, 251),
        "grey" => (232, 236, 233),
        _ => (255, 243, 184),
    }
}

/// `int(round(x))`: Python rounds half to even.
fn int_round(x: f64) -> i64 {
    x.round_ties_even() as i64
}

/// An RGB picture you can fill rectangles in, and write as a PNG.
pub struct Raster {
    w: usize,
    h: usize,
    rows: Vec<Vec<u8>>,
}

impl Raster {
    /// Make a picture of one colour (`Raster(width, height, background)`).
    pub fn new(width: i64, height: i64, background: Color) -> Self {
        let w = width.max(1) as usize;
        let h = height.max(1) as usize;
        let row: Vec<u8> = [background.0, background.1, background.2].repeat(w);
        Self { w, h, rows: vec![row; h] }
    }

    /// Fill a rectangle (clipped to the picture).
    pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, color: Color) {
        let x0 = int_round(x).max(0);
        let y0 = int_round(y).max(0);
        let x1 = int_round(x + w).min(self.w as i64);
        let y1 = int_round(y + h).min(self.h as i64);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let chunk: Vec<u8> = [color.0, color.1, color.2].repeat((x1 - x0) as usize);
        for yy in y0..y1 {
            self.rows[yy as usize][(x0 as usize) * 3..(x1 as usize) * 3].copy_from_slice(&chunk);
        }
    }

    /// Draw a rectangle's outline.
    pub fn frame(&mut self, x: f64, y: f64, w: f64, h: f64, color: Color, t: u32) {
        let t = f64::from(t);
        self.rect(x, y, w, t, color);
        self.rect(x, y + h - t, w, t, color);
        self.rect(x, y, t, h, color);
        self.rect(x + w - t, y, t, h, color);
    }

    /// Draw a straight line 2 pixels thick (`Raster.line(x0, y0, x1, y1, color)`).
    pub fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, color: Color) {
        let t = 2.0;
        let steps = (x1 - x0).abs().max((y1 - y0).abs()) as i64 + 1;
        for i in 0..=steps {
            let f = i as f64 / steps as f64;
            self.rect(x0 + (x1 - x0) * f - t / 2.0, y0 + (y1 - y0) * f - t / 2.0, t, t, color);
        }
    }

    /// The picture as PNG bytes.
    pub fn png(&self) -> Vec<u8> {
        let mut raw = Vec::with_capacity(self.h * (self.w * 3 + 1));
        for row in &self.rows {
            raw.push(0);
            raw.extend_from_slice(row);
        }
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&(self.w as u32).to_be_bytes());
        ihdr.extend_from_slice(&(self.h as u32).to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        out.extend(chunk(b"IHDR", &ihdr));
        out.extend(chunk(b"IDAT", &compress(&raw)));
        out.extend(chunk(b"IEND", b""));
        out
    }
}

/// `zlib.compress(raw, 6)`.
pub fn compress(raw: &[u8]) -> Vec<u8> {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::new(6));
    // writing to a Vec cannot fail
    let _ = z.write_all(raw);
    z.finish().unwrap_or_default()
}

/// One PNG chunk: length, kind and data, CRC-32 of kind and data.
fn chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

/// `zlib.crc32`.
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

/// A wireframe of an HTML board (a grey page, with bars for text and boxes for buttons, fields and pictures).
///
/// `html_text` is the cleaned page, or None for an empty board; `width` and `height` the board's size in plane units;
/// `max_side` the longest side of the picture in pixels (360 in every call).
pub fn board_snapshot(html_text: Option<&str>, width: i64, height: i64, max_side: i64) -> Vec<u8> {
    let scale = (max_side as f64 / width.max(height).max(1) as f64).min(1.0);
    let w = 40.max((width as f64 * scale) as i64);
    let h = 30.max((height as f64 * scale) as i64);
    let (wf, hf) = (w as f64, h as f64);
    let mut r = Raster::new(w, h, PAPER);
    let bar_h = 6f64.max(hf * 0.07);
    r.rect(0.0, 0.0, wf, bar_h, INK); // a top bar, as in the design's board thumbnails
    r.rect(6.0, 2.0, wf * 0.14, 2.0, (123, 211, 154));
    let items = match html_text {
        Some(text) if !text.is_empty() => canvas_html::outline(text),
        _ => Vec::new(),
    };
    let pad = 8f64.max(wf * 0.12);
    let mut y = bar_h + pad * 0.7;
    if !items.is_empty() {
        let (card_x, card_w) = (pad, wf - 2.0 * pad);
        r.rect(card_x - 3.0, y - 4.0, card_w + 6.0, hf - y - 2.0, WHITE);
        r.frame(card_x - 3.0, y - 4.0, card_w + 6.0, hf - y - 2.0, GREY, 1);
        for (kind, text) in items.iter().take(40) {
            if y > hf - 10.0 {
                break;
            }
            let n = text.chars().count() as f64;
            match kind.as_str() {
                "head" => {
                    let bh = 3f64.max(hf * 0.035);
                    r.rect(card_x, y, card_w.min(14.0 + n * 3.2 * scale * 2.0), bh, INK);
                    y += bh + 5.0;
                }
                "button" => {
                    let bh = 5f64.max(hf * 0.05);
                    r.rect(card_x, y, card_w.min(28.0 + n * 3.0 * scale * 2.0), bh, GREEN);
                    y += bh + 5.0;
                }
                "field" => {
                    let bh = 5f64.max(hf * 0.045);
                    r.rect(card_x, y, card_w, bh, GREY);
                    y += bh + 4.0;
                }
                "pic" => {
                    let bh = 12f64.max(hf * 0.16);
                    r.rect(card_x, y, card_w, bh, GREY);
                    r.frame(card_x, y, card_w, bh, MID, 1);
                    y += bh + 5.0;
                }
                _ => {
                    let bar = 2f64.max(hf * 0.02);
                    r.rect(card_x, y, card_w.min(10.0 + n * 2.4 * scale * 2.0), bar, MID);
                    y += bar + 3.5;
                }
            }
        }
    } else {
        r.rect(pad, hf * 0.4, wf - 2.0 * pad, 3.0, MID);
    }
    r.png()
}

/// A JSON number as a float (0 for anything else).
fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

fn num_or(v: Option<&Value>, default: f64) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(default)
}

fn on_page<'a>(doc: &'a Value, key: &str, page: Option<&Value>) -> Vec<&'a Value> {
    doc.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter(|i| i.get("page") == page).collect())
        .unwrap_or_default()
}

/// A wireframe of one page tab of a canvas: the boards as framed pages, the notes as small coloured squares.
///
/// `doc` is the canvas file; `page` the page tab to draw (the first when omitted or empty); `max_side` the longest
/// side of the picture in pixels (1200 when the caller gives none).
pub fn overview(doc: &Value, page: Option<&str>, max_side: i64) -> Vec<u8> {
    let first_page =
        doc.get("pages").and_then(Value::as_array).and_then(|pages| pages.first()).and_then(|p| p.get("id")).cloned();
    // `page = page or (pages[0]["id"] if pages else None)`
    let page_value: Option<Value> = match page {
        Some(p) if !p.is_empty() => Some(Value::String(p.to_string())),
        _ => first_page.filter(|v| !v.is_null()),
    };
    let page_ref = page_value.as_ref();
    // `b.get("page") == page` with `page` None matches a board with no page key too
    let matches = |items: Vec<&Value>| -> Vec<Value> { items.into_iter().cloned().collect() };
    let pick = |key: &str| -> Vec<Value> {
        match page_ref {
            Some(_) => matches(on_page(doc, key, page_ref)),
            None => doc
                .get(key)
                .and_then(Value::as_array)
                .map(|items| items.iter().filter(|i| i.get("page").is_none_or(Value::is_null)).cloned().collect())
                .unwrap_or_default(),
        }
    };
    let boards = pick("boards");
    let notes = pick("notes");
    let labels = pick("labels");
    let mut xs: Vec<f64> = boards.iter().map(|b| num(b.get("x"))).collect();
    xs.extend(notes.iter().map(|n| num(n.get("x"))));
    xs.extend(labels.iter().map(|t| num(t.get("x"))));
    let mut ys: Vec<f64> = boards.iter().map(|b| num(b.get("y"))).collect();
    ys.extend(notes.iter().map(|n| num(n.get("y"))));
    ys.extend(labels.iter().map(|t| num(t.get("y"))));
    if xs.is_empty() {
        return Raster::new(max_side / 2, max_side / 3, PLANE).png();
    }
    let mut x1: Vec<f64> = boards.iter().map(|b| num(b.get("x")) + num(b.get("w"))).collect();
    x1.extend(notes.iter().map(|n| num(n.get("x")) + num_or(n.get("w"), 160.0)));
    let mut y1: Vec<f64> = boards.iter().map(|b| num(b.get("y")) + num(b.get("h"))).collect();
    y1.extend(notes.iter().map(|n| num(n.get("y")) + num_or(n.get("h"), 100.0)));
    let margin = 40.0;
    let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let (left, top) = (min(&xs) - margin, min(&ys) - margin);
    let mut right: Vec<f64> = x1.clone();
    right.extend(xs.iter().map(|x| x + 80.0));
    let mut bottom: Vec<f64> = y1.clone();
    bottom.extend(ys.iter().map(|y| y + 30.0));
    let width = max(&right) + margin - left;
    let height = max(&bottom) + margin - top;
    let scale = (max_side as f64 / width.max(height)).min(1.0);
    let mut r = Raster::new(60.max((width * scale) as i64), 40.max((height * scale) as i64), PLANE);
    for b in &boards {
        let (bx, by) = ((num(b.get("x")) - left) * scale, (num(b.get("y")) - top) * scale);
        let (bw, bh) = (num(b.get("w")) * scale, num(b.get("h")) * scale);
        r.rect(bx + 2.0, by + 3.0, bw, bh, (226, 231, 228));
        r.rect(bx, by, bw, bh, WHITE);
        r.rect(bx, by, bw, 3f64.max(bh * 0.07), INK);
        r.rect(bx + bw * 0.12, by + bh * 0.3, bw * 0.76, 2f64.max(bh * 0.06), GREY);
        r.rect(bx + bw * 0.12, by + bh * 0.45, bw * 0.76, 2f64.max(bh * 0.06), GREY);
        r.rect(bx + bw * 0.12, by + bh * 0.62, bw * 0.4, 3f64.max(bh * 0.08), GREEN);
        r.frame(bx, by, bw, bh, BORDER, 1);
    }
    for n in &notes {
        let color = note_color(n.get("color").and_then(Value::as_str).unwrap_or("yellow"));
        r.rect(
            (num(n.get("x")) - left) * scale,
            (num(n.get("y")) - top) * scale,
            num_or(n.get("w"), 160.0) * scale,
            num_or(n.get("h"), 100.0) * scale,
            color,
        );
    }
    for t in &labels {
        let len = t.get("text").and_then(Value::as_str).map_or(0, |s| s.chars().count()) as f64;
        r.rect(
            (num(t.get("x")) - left) * scale,
            (num(t.get("y")) - top) * scale,
            10f64.max(len * 9.0 * scale),
            3f64.max(14.0 * scale),
            INK,
        );
    }
    r.png()
}
