//! Where the bytes of pictures, files and drawings come from: the caller implements [`AssetSource`].

use base64::Engine;

/// The bytes of one uploaded file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    /// The file content.
    pub bytes: Vec<u8>,
    /// Its media type (`image/png`); empty when unknown (the renderers then look at the first bytes).
    pub mime: String,
}

/// The blocks whose rendered PNG an export can show: the three drawings, and an HTML embed (as it first draws).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DrawingKind {
    /// A draw.io diagram (`diagram` block, id `dg_…`).
    Diagram,
    /// A sketch (`sketch` block, id `sk_…`).
    Sketch,
    /// A canvas (`canvas` block, id `cv_…`).
    Canvas,
    /// An HTML embed (`htmlEmbed` block, by its block id `b-…`): a picture of the page it shows, for paper.
    Embed,
    /// An equation (`mathBlock`, by its LaTeX): a picture of it typeset, for Word (which has no MathML).
    Math,
}

impl DrawingKind {
    /// The kind of a drawing node type (`diagram`, `sketch`, `canvas`); `None` for any other type.
    pub fn of_node_type(ty: &str) -> Option<DrawingKind> {
        match ty {
            "diagram" => Some(DrawingKind::Diagram),
            "sketch" => Some(DrawingKind::Sketch),
            "canvas" => Some(DrawingKind::Canvas),
            _ => None,
        }
    }

    /// How a reader calls this kind ("draw.io diagram").
    pub fn label(self) -> &'static str {
        match self {
            DrawingKind::Diagram => "draw.io diagram",
            DrawingKind::Sketch => "sketch",
            DrawingKind::Canvas => "canvas",
            DrawingKind::Embed => "HTML embed",
            DrawingKind::Math => "equation",
        }
    }

    /// The app path that shows the drawing (`/diagrams/<id>/svg`), for links.
    pub fn app_path(self, id: &str) -> String {
        match self {
            DrawingKind::Diagram => format!("/diagrams/{id}/svg"),
            DrawingKind::Sketch => format!("/sketches/{id}/png"),
            DrawingKind::Canvas => format!("/canvases/{id}/overview.png"),
            // an embed or an equation lives in its page; there is no address of its own
            DrawingKind::Embed | DrawingKind::Math => String::new(),
        }
    }
}

/// Hands the renderers the bytes they embed. Every method may be slow (disk, a draw.io render); the renderers
/// call each source at most once per export.
pub trait AssetSource {
    /// Returns an uploaded file by the `src` stored in the page (`/uploads/team.png`, or a URL the caller chooses
    /// to fetch); `None` when it is missing or not served, and the renderer then keeps a link instead.
    fn fetch(&self, src: &str) -> Option<Asset>;

    /// Returns the rendered PNG of a drawing; `None` when it cannot be drawn, and the renderer writes a
    /// placeholder line instead.
    fn drawing_png(&self, kind: DrawingKind, id: &str) -> Option<Vec<u8>>;

    /// Returns the size in bytes of an uploaded file without reading it, for [`crate::estimate_size_with`];
    /// `None` when unknown (a guess is used).
    fn size_of(&self, _src: &str) -> Option<u64> {
        None
    }
}

/// An [`AssetSource`] that has nothing: pictures stay links and drawings become placeholder lines.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoAssets;

impl AssetSource for NoAssets {
    fn fetch(&self, _src: &str) -> Option<Asset> {
        None
    }

    fn drawing_png(&self, _kind: DrawingKind, _id: &str) -> Option<Vec<u8>> {
        None
    }
}

/// The picture types an export embeds, by their first bytes; `None` for anything else.
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
        if head.contains("<svg") { Some("image/svg+xml") } else { None }
    }
}

/// The image media type of an asset: its bytes decide, the stated type is trusted only when the bytes say
/// nothing and it names an image.
pub(crate) fn image_mime(asset: &Asset) -> Option<&'static str> {
    sniff_image(&asset.bytes).or(match asset.mime.as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    })
}

/// The file extension of an image media type.
pub(crate) fn image_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

/// A `data:` URI of bytes.
pub(crate) fn data_uri(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}
