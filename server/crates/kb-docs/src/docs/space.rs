//! A project's Docs settings beyond "on" and "who can edit" (design board "Docs settings"): how new pages look,
//! the template gallery, public links, highlights, upload limits, scripts in HTML embeds and how AI teams change
//! pages. Stored as JSON in `project.docs_settings`; a missing key is its default.

use kb_base::activity;
use kb_db::Session;
use kb_db::entities::project as project_table;
use kb_db::sea_orm::Set;
use kb_doctext::docs_access;
use serde_json::{Map, Value, json};

use super::pages::{json_or_none, project};
use crate::{Result, docs_err};

/// The largest upload limits an admin can choose, in MB (images, video, files).
pub const MAX_LIMITS_MB: (u64, u64, u64) = (50, 2048, 1024);
/// The fixed size limit of an HTML embed, in bytes.
pub const HTML_EMBED_BYTES: usize = 512 * 1024;

/// The settings every project starts with.
pub fn defaults() -> Map<String, Value> {
    match json!({
        "newPage": {"width": "normal", "bodyFont": "jakarta", "textSize": "m", "background": "white",
                    "titleAlign": "left", "childCopiesParent": true},
        "defaultTemplate": "blank",
        "hiddenTemplates": [],
        "allowPublicLinks": true,
        "publicLinkExpiry": "never",
        "highlights": "on",
        "uploads": {"imageMb": 10, "videoMb": 200, "fileMb": 100},
        "scriptsInEmbeds": "ask",
        "embedSites": ["youtube.com", "youtu.be", "vimeo.com", "loom.com", "figma.com", "codepen.io",
                       "docs.google.com", "github.com", "gist.github.com"],
        "aiApply": {},
    }) {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// The project's Docs settings: the defaults with the stored values over them.
pub fn read(project: &project_table::Model) -> Map<String, Value> {
    let mut out = defaults();
    if let Value::Object(stored) = json_or_none(project.docs_settings.as_deref()) {
        for (k, v) in stored {
            if out.contains_key(&k) {
                out.insert(k, v);
            }
        }
    }
    out
}

/// Whether `value` is allowed for the setting `key`.
fn allowed(key: &str, value: &Value) -> bool {
    let one_of = |v: &Value, list: &[&str]| v.as_str().is_some_and(|s| list.contains(&s));
    match key {
        "newPage" => value.as_object().is_some_and(|o| {
            o.iter().all(|(k, v)| match k.as_str() {
                "width" => one_of(v, &["narrow", "normal", "wide", "full"]),
                "bodyFont" => one_of(
                    v,
                    &[
                        "jakarta",
                        "lora",
                        "source-serif",
                        "merriweather",
                        "playfair",
                        "inter",
                        "jetbrains-mono",
                        "caveat",
                    ],
                ),
                "textSize" => one_of(v, &["s", "m", "l"]),
                "background" => one_of(v, &["white", "paper", "mist", "sepia", "night"]),
                "titleAlign" => one_of(v, &["left", "center"]),
                "childCopiesParent" => v.is_boolean(),
                _ => false,
            })
        }),
        "defaultTemplate" => value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 100),
        "hiddenTemplates" | "embedSites" => value.as_array().is_some_and(|a| {
            a.len() <= 200 && a.iter().all(|s| s.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 200))
        }),
        "allowPublicLinks" => value.is_boolean(),
        "publicLinkExpiry" => one_of(value, &["never", "7d", "30d", "90d"]),
        "highlights" => one_of(value, &["on", "off"]),
        "scriptsInEmbeds" => one_of(value, &["ask", "off"]),
        "uploads" => value.as_object().is_some_and(|o| {
            o.iter().all(|(k, v)| {
                let max = match k.as_str() {
                    "imageMb" => MAX_LIMITS_MB.0,
                    "videoMb" => MAX_LIMITS_MB.1,
                    "fileMb" => MAX_LIMITS_MB.2,
                    _ => return false,
                };
                v.as_u64().is_some_and(|n| (1..=max).contains(&n))
            })
        }),
        "aiApply" => value.as_object().is_some_and(|o| o.values().all(|v| one_of(v, &["suggest", "direct"]))),
        _ => false,
    }
}

/// Returns a project's Docs settings (anyone who can read its Docs).
///
/// # Errors
/// The project errors of `project` (404, 403).
pub async fn get_space_settings(session: &Session, project_id: &str) -> Result<Map<String, Value>> {
    let project = project(session, project_id, false).await?;
    Ok(read(&project))
}

/// Changes a project's Docs settings (admins only); `null` puts a key back to its default. Objects (`newPage`,
/// `uploads`, `aiApply`) are merged key by key.
///
/// # Errors
/// 403 `admins_only`, 422 `invalid_settings` naming the first bad key or value.
pub async fn update_space_settings(
    session: &Session,
    project_id: &str,
    changes: &Map<String, Value>,
) -> Result<Map<String, Value>> {
    let project = project(session, project_id, true).await?;
    let members = docs_access::members_of(session, &project.id).await?;
    if docs_access::role_in(&members, &activity::current_actor()) != "admin" {
        return docs_err(403, "admins_only", "Only project admins can change Docs settings.");
    }
    let mut stored = match json_or_none(project.docs_settings.as_deref()) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    let current = read(&project);
    for (key, value) in changes {
        if !current.contains_key(key) {
            return docs_err(422, "invalid_settings", format!("Unknown Docs setting '{key}'"));
        }
        if value.is_null() {
            stored.remove(key);
            continue;
        }
        let merged = match (current.get(key), value) {
            (Some(Value::Object(old)), Value::Object(new)) => {
                let mut m = old.clone();
                for (k, v) in new {
                    if v.is_null() {
                        m.remove(k);
                    } else {
                        m.insert(k.clone(), v.clone());
                    }
                }
                Value::Object(m)
            }
            _ => value.clone(),
        };
        if !allowed(key, &merged) {
            return docs_err(422, "invalid_settings", format!("'{value}' is not a value of '{key}'"));
        }
        stored.insert(key.clone(), merged);
    }
    let mut row = kb_db::edit(project.clone());
    row.docs_settings = Set(if stored.is_empty() { None } else { Some(Value::Object(stored).to_string()) });
    let project = row.update(session).await?;
    session.commit().await?;
    Ok(read(&project))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_all_allowed() {
        for (k, v) in defaults() {
            assert!(allowed(&k, &v), "{k}");
        }
    }

    #[test]
    fn bad_values_are_refused() {
        assert!(!allowed("highlights", &json!("maybe")));
        assert!(!allowed("uploads", &json!({"imageMb": 0})));
        assert!(!allowed("uploads", &json!({"imageMb": 10_000})));
        assert!(!allowed("newPage", &json!({"width": "huge"})));
        assert!(allowed("aiApply", &json!({"tm_1": "direct"})));
        assert!(!allowed("aiApply", &json!({"tm_1": "now"})));
    }
}
