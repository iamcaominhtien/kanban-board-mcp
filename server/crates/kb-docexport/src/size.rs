//! A rough size of an export before it is made, so the caller can refuse one that is too big ("Too big").

use serde_json::Value;

use crate::assets::{AssetSource, NoAssets};
use crate::model::{ExportFormat, ExportPage, attr_f64, attr_str, children, ty};

/// The largest export the app makes in one go (200 MB).
pub const SIZE_LIMIT: u64 = 200 * 1024 * 1024;

/// Guesses for files whose size is unknown.
const IMAGE_GUESS: u64 = 400 * 1024;
const DRAWING_GUESS: u64 = 150 * 1024;
const VIDEO_GUESS: u64 = 20 * 1024 * 1024;

/// Returns a rough size in bytes of exporting `pages` as `format`, with guesses for pictures and videos.
pub fn estimate_size(pages: &[ExportPage], format: ExportFormat) -> u64 {
    estimate_size_with(pages, format, &NoAssets)
}

/// Like [`estimate_size`], with the real sizes of uploads where `assets` knows them ([`AssetSource::size_of`]).
pub fn estimate_size_with(pages: &[ExportPage], format: ExportFormat, assets: &dyn AssetSource) -> u64 {
    let mut total: u64 = 0;
    for p in pages {
        let mut text = 0u64;
        let mut media = 0u64;
        walk(&p.doc, format, assets, &mut text, &mut media);
        let overhead = match format {
            ExportFormat::Docx => 3,
            ExportFormat::Pdf => 4,
            ExportFormat::Html => 3,
            ExportFormat::Markdown => 1,
        };
        // Base64 inside a single HTML file is a third larger; it is the larger of the two HTML layouts.
        let media = if format == ExportFormat::Html { media + media / 3 } else { media };
        total = total.saturating_add(text * overhead + media + 2048);
    }
    total.saturating_add(match format {
        ExportFormat::Docx => 40 * 1024,
        ExportFormat::Pdf => 60 * 1024,
        ExportFormat::Html => 12 * 1024,
        ExportFormat::Markdown => 0,
    })
}

fn walk(node: &Value, format: ExportFormat, assets: &dyn AssetSource, text: &mut u64, media: &mut u64) {
    match ty(node) {
        "text" => *text += node.get("text").and_then(Value::as_str).map(str::len).unwrap_or(0) as u64,
        "image" => *media += attr_str(node, "src").and_then(|s| assets.size_of(s)).unwrap_or(IMAGE_GUESS),
        "diagram" | "sketch" | "canvas" => *media += DRAWING_GUESS,
        "video" => {
            if let Some(poster) = attr_str(node, "poster") {
                *media += assets.size_of(poster).unwrap_or(IMAGE_GUESS);
            }
            // An HTML export carries the video itself; the other formats keep a link.
            if format == ExportFormat::Html {
                *media += attr_str(node, "src").and_then(|s| assets.size_of(s)).unwrap_or(VIDEO_GUESS);
            }
        }
        "fileCard" => {
            if format == ExportFormat::Html {
                *media += attr_f64(node, "size").map(|n| n.max(0.0) as u64).unwrap_or(0);
            }
        }
        _ => {
            for c in children(node) {
                walk(c, format, assets, text, media);
            }
        }
    }
}
