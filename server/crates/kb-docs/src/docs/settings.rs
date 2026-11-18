//! Per-page settings (width, background, fonts, cover, header, access): `docs_page.settings`, a JSON object whose
//! keys and values are `server/contract/richdoc/page-settings.json`. A missing key is its default.

use std::sync::LazyLock;

use kb_db::Session;
use kb_db::sea_orm::Set;
use serde_json::{Map, Value};

use super::pages::{get_page, json_or_none, page_detail};
use crate::{Result, docs_err};

/// The settings contract (`page-settings.json`).
static CONTRACT: LazyLock<Map<String, Value>> = LazyLock::new(|| {
    let raw = include_str!("../../../../contract/richdoc/page-settings.json");
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("keys").and_then(Value::as_object).cloned())
        .unwrap_or_default()
});

/// The longest free-text setting (eyebrow, icon, an image address), in characters.
const MAX_TEXT: usize = 500;

/// Whether `value` is allowed for `key`: one of its listed values, or the right shape for keys without a list.
fn allowed(key: &str, value: &Value) -> bool {
    let Some(spec) = CONTRACT.get(key) else { return false };
    if let Some(values) = spec.get("values").and_then(Value::as_array) {
        return values.iter().any(|v| v == value);
    }
    let short_text = |v: &Value| v.as_str().is_some_and(|s| s.chars().count() <= MAX_TEXT);
    match key {
        // a picture (`src`) or a plain colour (`color`), with where it sits, how high, how it fits and how dim
        "cover" => value.as_object().is_some_and(|o| {
            (o.get("src").is_some_and(short_text) || o.get("color").is_some_and(is_hex_colour))
                && o.iter().all(|(k, v)| match k.as_str() {
                    "src" => short_text(v),
                    "color" => is_hex_colour(v),
                    "positionX" | "positionY" => v.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n)),
                    "height" => matches!(v.as_str(), Some("s" | "m" | "l" | "full")),
                    "fit" => matches!(v.as_str(), Some("fill" | "fit")),
                    "dim" => v.as_f64().is_some_and(|n| (0.0..=80.0).contains(&n)),
                    "titleOnCover" => v.is_boolean(),
                    _ => false,
                })
        }),
        // CSS px in steps of half a pixel
        "baseSize" => half_step(value, 12.0, 22.0),
        "book" => value.as_object().is_some_and(|o| {
            o.iter().all(|(k, v)| matches!(k.as_str(), "isBook" | "numberChapters") && v.is_boolean())
        }),
        "icon" | "eyebrow" | "reviewedAt" => short_text(value),
        "lockedBlocks" => value.as_array().is_some_and(|a| {
            a.len() <= 500
                && a.iter().all(|b| {
                    b.as_str().is_some_and(|s| {
                        s.len() == 8 && s.starts_with("b-") && s[2..].bytes().all(|c| c.is_ascii_hexdigit())
                    })
                })
        }),
        _ => false,
    }
}

/// Whether `value` is a `#rrggbb` colour.
fn is_hex_colour(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|c| c.is_ascii_hexdigit()))
}

/// Whether `value` is a number from `min` to `max` (both included) in steps of 0.5.
fn half_step(value: &Value, min: f64, max: f64) -> bool {
    value.as_f64().is_some_and(|n| (min..=max).contains(&n) && (n * 2.0).fract() == 0.0)
}

/// A page's settings as stored (an object; `{}` when none or unreadable).
pub fn read_settings(raw: Option<&str>) -> Map<String, Value> {
    match json_or_none(raw) {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// Merges `changes` into a page's settings (`null` removes a key, back to its default) and returns the page detail.
///
/// # Errors
/// 422 `invalid_settings` naming the first unknown key or value; the page errors of `get_page` (edit rights).
pub async fn update_settings(
    session: &Session,
    page_id: &str,
    changes: &Map<String, Value>,
) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, true).await?;
    let mut settings = read_settings(page.settings.as_deref());
    for (key, value) in changes {
        if !CONTRACT.contains_key(key) {
            return docs_err(422, "invalid_settings", format!("Unknown page setting '{key}'"));
        }
        if value.is_null() {
            settings.remove(key);
        } else if allowed(key, value) {
            settings.insert(key.clone(), value.clone());
        } else {
            return docs_err(422, "invalid_settings", format!("'{value}' is not a value of '{key}'"));
        }
    }
    let mut row = kb_db::edit(page);
    row.settings = Set(if settings.is_empty() { None } else { Some(Value::Object(settings).to_string()) });
    row.update(session).await?;
    session.commit().await?;
    page_detail(session, page_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_contract_is_read() {
        assert!(CONTRACT.contains_key("width"));
        assert!(allowed("width", &json!("wide")));
        assert!(!allowed("width", &json!("huge")));
        assert!(allowed("showOutline", &json!(false)));
        assert!(allowed("cover", &json!({"src": "/uploads/a.png", "positionY": 30, "height": "m"})));
        assert!(!allowed("cover", &json!({"positionY": 30})));
        assert!(!allowed("cover", &json!({"src": "/a.png", "other": 1})));
        assert!(allowed(
            "cover",
            &json!({"color": "#2E6F40", "height": "full", "fit": "fit", "dim": 20, "positionX": 0})
        ));
        assert!(!allowed("cover", &json!({"color": "green"})));
        assert!(!allowed("cover", &json!({"src": "/a.png", "dim": 95})));
        assert!(allowed("baseSize", &json!(17)));
        assert!(allowed("baseSize", &json!(14.5)));
        assert!(!allowed("baseSize", &json!(14.2)));
        assert!(!allowed("baseSize", &json!(40)));
        assert!(allowed("margins", &json!("roomy")));
        assert!(allowed("outlineDepth", &json!(2)));
        assert!(!allowed("outlineDepth", &json!(4)));
        assert!(allowed("titleAlign", &json!("right")));
        assert!(allowed("book", &json!({"isBook": true})));
        assert!(allowed("eyebrow", &json!("ENGINEERING NOTES")));
        assert!(!allowed("nope", &json!(1)));
        assert!(allowed("lockedBlocks", &json!(["b-3f2a9c"])));
        assert!(!allowed("lockedBlocks", &json!(["nope"])));
    }

    #[test]
    fn unreadable_settings_read_as_none() {
        assert!(read_settings(Some("not json")).is_empty());
        assert_eq!(read_settings(Some(r#"{"width":"wide"}"#))["width"], "wide");
    }
}
