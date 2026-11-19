//! The page-level Docs operations an agent needs beside the text: a page's settings (layout, type, cover, header,
//! book), the template gallery, and exporting pages to a file (PDF, Word, HTML, Markdown).

use std::path::{Path, PathBuf};
use std::time::Duration;

use kb_base::pytext;
use kb_docs::docs::{self, gallery};
use kb_docs::docs_export::{self, ExportRequest};
use serde_json::{Map, Value, json};

use super::docs::docs_error;
use super::docs_rich;
use crate::common::{self, ToolError, ToolResult, notify_on_success};

/// The settings only a person changes: who may read and change the page, and what readers may do on it. An AI team
/// that sends one is refused (the person decides; the team says so in its report).
pub const PERSON_ONLY_SETTINGS: [&str; 5] = ["notForAi", "aiApply", "lockedBlocks", "highlights", "reviewedAt"];

/// How long `export` waits for the file before it gives up.
const EXPORT_WAIT: Duration = Duration::from_secs(180);

/// Changes a page's settings: `changes` is merged into them, `null` puts a key back to its default. Returns {id,
/// settings} (the settings now set away from their defaults).
///
/// # Errors
/// An unknown key or value (the message names it), a setting only a person changes (for an AI team), the page
/// errors.
pub async fn set_docs_settings(page_id: &str, changes: &Map<String, Value>) -> ToolResult {
    if changes.is_empty() {
        return Err(ToolError::value(
            "settings needs at least one key, e.g. {\"cover\": {\"src\": \"/uploads/a.png\"}} or {\"width\": null}.",
        ));
    }
    refuse_person_only(changes).await?;
    notify_on_success(async {
        let session = common::async_session();
        let page = docs::update_settings(&session, page_id, changes).await.map_err(docs_error)?;
        Ok(json!({
            "id": page.get("id").cloned().unwrap_or(Value::Null),
            "settings": page.get("settings").cloned().unwrap_or_else(|| json!({})),
        }))
    })
    .await
}

/// Refuses an AI team a setting only a person changes ([`PERSON_ONLY_SETTINGS`]).
///
/// # Errors
/// The refusal naming the key; the guard's refusal of a dead run token.
pub async fn refuse_person_only(changes: &Map<String, Value>) -> Result<(), ToolError> {
    if docs_rich::ai_acting().await?
        && let Some(key) = changes.keys().find(|k| PERSON_ONLY_SETTINGS.contains(&k.as_str()))
    {
        return Err(ToolError::Value(format!(
            "'{key}' is changed by a person only (who may read or change the page). Leave it, and say in your report \
             what you would change."
        )));
    }
    Ok(())
}

/// The templates a page can start from in a project: [{id, name, description, from}], `from` being `builtin`,
/// `project` (shared in the project) or `yours`. The ones the project hides are left out.
///
/// # Errors
/// The project errors.
pub async fn list_docs_templates(project_id: &str) -> ToolResult {
    let session = common::async_session();
    let g = gallery::gallery(&session, project_id).await.map_err(docs_error)?;
    let hidden: Vec<&str> =
        g.get("hidden").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let mut out = Vec::new();
    for (key, from) in [("builtin", "builtin"), ("project", "project"), ("yours", "yours")] {
        for t in g.get(key).and_then(Value::as_array).into_iter().flatten() {
            let id = t.get("id").and_then(Value::as_str).unwrap_or_default();
            if hidden.contains(&id) {
                continue;
            }
            out.push(json!({
                "id": id,
                "name": t.get("name").cloned().unwrap_or(Value::Null),
                "description": t.get("description").cloned().unwrap_or(Value::Null),
                "from": from,
            }));
        }
    }
    Ok(Value::Array(out))
}

/// Creates a page from a template (its text and settings), published as v1. Returns the page's {id, title,
/// status, version}.
///
/// # Errors
/// An unknown template, the create errors.
pub async fn create_from_template(
    project_id: &str,
    title: &str,
    parent_id: Option<&str>,
    template: &str,
) -> Result<Map<String, Value>, ToolError> {
    let session = common::async_session();
    let page =
        gallery::create_from_template(&session, project_id, title, parent_id, template).await.map_err(docs_error)?;
    let id = page.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    docs::publish_page(&session, &id, 0, Some("Created via MCP"), None, None).await.map_err(docs_error)
}

/// Exports pages to a file and writes it at `path` (an absolute file path, or a folder that gets the export's own
/// name). `scope`: `page`, `children` (the page and its sub-pages), `book` (a book page and its chapters) or `space`
/// (the whole project; `page_id` names any page of it). Returns {path, format, size, name}.
///
/// # Errors
/// A relative path, an unknown scope or format, an empty page, a failed or too slow export, a file that cannot be
/// written.
pub async fn export_docs(page_id: &str, scope: &str, format: &str, path: &str) -> ToolResult {
    if !kb_files::pathlib::is_absolute(path) {
        return Err(ToolError::Value(format!("Give an absolute path (got {}).", pytext::repr(path))));
    }
    let session = common::async_session();
    let page = docs::page_detail(&session, page_id).await.map_err(docs_error)?;
    let project_id = page.get("project_id").and_then(Value::as_str).unwrap_or_default().to_string();
    let req = ExportRequest {
        scope: scope.to_string(),
        page_id: Some(page_id.to_string()),
        page_ids: None,
        format: format.to_string(),
        draft: false,
        file_name: None,
        options: Map::new(),
        book: None,
    };
    let row = docs_export::start(&session, &project_id, &req).await.map_err(docs_error)?;
    let id = row.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let deadline = tokio::time::Instant::now() + EXPORT_WAIT;
    loop {
        let now = docs_export::detail(&session, &id).await.map_err(docs_error)?;
        match now.get("state").and_then(Value::as_str) {
            Some("ready") => break,
            Some("running") if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Some("running") => {
                docs_export::cancel(&session, &id).await.map_err(docs_error)?;
                return Err(ToolError::value("The export took longer than 3 minutes and was cancelled. Export less."));
            }
            _ => {
                let why = now.get("error").and_then(Value::as_str).unwrap_or("it stopped");
                return Err(ToolError::Value(format!("The export failed: {why}.")));
            }
        }
    }
    let (name, bytes) = docs_export::file(&session, &id).await.map_err(docs_error)?;
    let target = target_of(path, &name);
    let written =
        target.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&target, &bytes));
    if let Err(e) = written {
        return Err(ToolError::Value(format!("{} could not be written ({e}).", target.display())));
    }
    Ok(json!({"path": target.display().to_string(), "format": format, "size": bytes.len(), "name": name}))
}

/// Where an export goes: `path` itself, or the export's name inside it when `path` is a folder (or ends with `/`).
fn target_of(path: &str, name: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_dir() || path.ends_with('/') || path.ends_with('\\') { p.join(name) } else { p.to_path_buf() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guide names every attribute an agent can set on the blocks it formats, by its marker name, and every page
    /// setting: a key added to the schema or to page-settings.json without a word in the guide fails here.
    #[test]
    fn the_docs_guide_names_every_attribute_and_setting() {
        let guide = kb_doctext::docs_guide::GUIDE;
        // what the Markdown itself holds, or the editor alone sets
        let not_in_marker =
            ["blockId", "src", "alt", "title", "crop", "height", "level", "language", "kind", "provider"];
        for node in ["paragraph", "heading", "image", "table", "tableCell", "columns", "callout", "video"] {
            let spec = &kb_richdoc::schema::schema().nodes[node];
            for name in spec.attrs.keys().filter(|k| !not_in_marker.contains(&k.as_str())) {
                if node == "tableCell" && ["colspan", "rowspan", "colwidth"].contains(&name.as_str()) {
                    continue;
                }
                let short = kb_richdoc::short_name(node, name);
                let named = [format!("`{short}`"), format!("`{short}="), format!("`{short} "), format!(" {short}=")];
                assert!(named.iter().any(|n| guide.contains(n.as_str())), "the guide does not name {node}.{short}");
            }
        }
        let settings: Value =
            serde_json::from_str(include_str!("../../../../contract/richdoc/page-settings.json")).expect("json");
        for key in settings["keys"].as_object().expect("keys").keys() {
            assert!(guide.contains(&format!("`{key}")), "the guide does not name the page setting {key}");
        }
    }

    #[test]
    fn an_export_lands_in_a_folder_under_its_own_name() {
        let dir = std::env::temp_dir();
        assert_eq!(target_of(dir.to_str().expect("utf-8"), "Runbook.pdf"), dir.join("Runbook.pdf"));
        assert_eq!(target_of("/no/such/dir/", "a.md"), PathBuf::from("/no/such/dir/a.md"));
        assert_eq!(target_of("/no/such/out.docx", "a.docx"), PathBuf::from("/no/such/out.docx"));
    }
}
