//! The `slides` skill: decks a person is proud to present (issue #277, asked for by the owner).
//!
//! `guide.md` is the skill's text; its folder ships with it in the board's plugin: `scripts/` (HTML to an editable
//! .pptx, a deck in a person's own template, rendering any office file to look at it), `themes/` (each a theme.css,
//! its sample deck and a preview) and `examples/`. The themes table in the text is made from the themes'
//! content.json.

use serde_json::Value;

use crate::assets;

const FOLDER: &str = "slides_skill";

/// The skill's name.
pub const NAME: &str = "slides";

/// What the skill is for and when to use it.
pub const DESCRIPTION: &str = include_str!("text/slides.description.txt");

/// The files the skill ships beside its SKILL.md, by suffix; sample.html and the .pptx are what a run copies from.
const SHIP: [&str; 10] = [".py", ".css", ".json", ".html", ".pptx", ".jpg", ".png", ".svg", ".mp4", ".gif"];

/// One theme, from its `content.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct Theme {
    /// The folder name.
    pub key: String,
    /// `label`.
    pub label: String,
    /// `for` ("" when left out).
    pub for_: String,
    /// `fonts`: `display`, `body`, `office_display`, `office_body`.
    pub fonts: Value,
}

/// Each theme's key, label, who it is for and its fonts, from its content.json.
pub fn themes() -> Vec<Theme> {
    let mut out = Vec::new();
    for (rel, bytes) in assets::folder_files(FOLDER) {
        let mut parts = rel.split('/');
        let (Some("themes"), Some(key), Some("content.json"), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(content) = serde_json::from_str::<Value>(&assets::decode_text(bytes)) else { continue };
        let text = |name: &str| content.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        out.push(Theme {
            key: key.to_string(),
            label: text("label"),
            for_: text("for"),
            fonts: content.get("fonts").cloned().unwrap_or(Value::Null),
        });
    }
    out
}

/// The skill's text, with the table of themes.
pub fn body() -> String {
    let font = |fonts: &Value, name: &str| fonts.get(name).map(kb_base::pyjson::py_str).unwrap_or_default();
    let mut rows = vec!["| Theme | For | Fonts (web; Office) |".to_string(), "|---|---|---|".to_string()];
    for theme in themes() {
        let f = &theme.fonts;
        rows.push(format!(
            "| `{}` {} | {} | {} + {}; {} + {} |",
            theme.key,
            theme.label,
            theme.for_,
            font(f, "display"),
            font(f, "body"),
            font(f, "office_display"),
            font(f, "office_body"),
        ));
    }
    assets::read_text(FOLDER, "guide.md").unwrap_or_default().replace("{THEMES}", &rows.join("\n"))
}

/// The files beside SKILL.md: `{relative path: bytes}`, from `scripts/`, `themes/` and `examples/` in that order.
pub fn files() -> Vec<(String, &'static [u8])> {
    let all = assets::folder_files(FOLDER);
    let mut out = Vec::new();
    for sub in ["scripts", "themes", "examples"] {
        for (rel, bytes) in &all {
            let mut parts = rel.split('/');
            if parts.next() != Some(sub) || !rel.contains('/') {
                continue;
            }
            if SHIP.contains(&assets::suffix(rel))
                && !rel.split('/').any(|part| part.starts_with('.') || part.starts_with("__"))
            {
                out.push((rel.to_string(), *bytes));
            }
        }
    }
    out
}
