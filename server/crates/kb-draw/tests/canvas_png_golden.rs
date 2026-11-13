//! `canvas_png` against the PNGs the Python `Raster`, `board_snapshot` and `overview` write
//! (`contract/golden/gen_canvas_png.py`): the same bytes, so the same zlib stream at level 6.

mod common;

use base64::Engine;
use common::hash::sha256_hex;
use kb_draw::canvas_png::{self, Raster};
use serde_json::Value;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/canvas_png.json");
    serde_json::from_slice(&std::fs::read(path).expect("golden file")).expect("golden json")
}

fn color(v: &Value) -> (u8, u8, u8) {
    let a = v.as_array().expect("colour");
    (a[0].as_u64().expect("r") as u8, a[1].as_u64().expect("g") as u8, a[2].as_u64().expect("b") as u8)
}

fn f(v: &Value) -> f64 {
    v.as_f64().expect("number")
}

/// Compare a picture with the golden entry: the whole PNG when it is kept, else its length (and the digest below).
fn check(what: &str, png: &[u8], entry: &Value) {
    assert_eq!(png.len() as u64, entry["len"].as_u64().expect("len"), "{what}: length");
    if let Some(b64) = entry["png_b64"].as_str() {
        let want = base64::engine::general_purpose::STANDARD.decode(b64).expect("base64");
        assert!(png == want.as_slice(), "{what}: bytes differ");
    }
}

#[test]
fn compress_is_zlib_level_6() {
    let g = golden();
    for case in g["compress"].as_array().expect("compress") {
        let raw =
            base64::engine::general_purpose::STANDARD.decode(case["raw_full_b64"].as_str().expect("raw")).expect("b64");
        let out = canvas_png::compress(&raw);
        assert_eq!(sha256_hex(&out), case["sha256"].as_str().expect("sha"), "{} n={}", case["kind"], case["n"]);
    }
}

#[test]
fn rasters_are_byte_for_byte_the_python_ones() {
    let g = golden();
    for (i, case) in g["rasters"].as_array().expect("rasters").iter().enumerate() {
        let mut r = Raster::new(case["w"].as_i64().expect("w"), case["h"].as_i64().expect("h"), color(&case["bg"]));
        for op in case["ops"].as_array().expect("ops") {
            let op = op.as_array().expect("op");
            match op[0].as_str().expect("kind") {
                "rect" => r.rect(f(&op[1]), f(&op[2]), f(&op[3]), f(&op[4]), color(&op[5])),
                "frame" => r.frame(
                    f(&op[1]),
                    f(&op[2]),
                    f(&op[3]),
                    f(&op[4]),
                    color(&op[5]),
                    op[6].as_u64().expect("t") as u32,
                ),
                _ => r.line(f(&op[1]), f(&op[2]), f(&op[3]), f(&op[4]), color(&op[5])),
            }
        }
        let png = r.png();
        check(&format!("raster {i}"), &png, case);
        assert_eq!(sha256_hex(&png), case["sha256"].as_str().expect("sha"), "raster {i}");
    }
}

#[test]
fn board_snapshots_are_byte_for_byte_the_python_ones() {
    let g = golden();
    for (i, case) in g["snapshots"].as_array().expect("snapshots").iter().enumerate() {
        let png = canvas_png::board_snapshot(
            case["html"].as_str(),
            case["width"].as_i64().expect("w"),
            case["height"].as_i64().expect("h"),
            case["max_side"].as_i64().expect("max_side"),
        );
        check(&format!("snapshot {i}"), &png, case);
        assert_eq!(sha256_hex(&png), case["sha256"].as_str().expect("sha"), "snapshot {i}");
    }
}

#[test]
fn overviews_are_byte_for_byte_the_python_ones() {
    let g = golden();
    for (i, case) in g["overviews"].as_array().expect("overviews").iter().enumerate() {
        let png =
            canvas_png::overview(&case["doc"], case["page"].as_str(), case["max_side"].as_i64().expect("max_side"));
        check(&format!("overview {i}"), &png, case);
        assert_eq!(sha256_hex(&png), case["sha256"].as_str().expect("sha"), "overview {i}");
    }
}
