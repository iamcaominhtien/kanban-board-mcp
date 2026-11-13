//! Sketch operations: paint-style drawings that sit in markdown as `![Name](sketch:sk_xxxxxxxx)`.
//!
//! An agent works on the files: export a sketch to a local PNG and its editable `.sketch.json` source, change them
//! with its own tools (or draw a new PNG), save them back. The format and its limits are in
//! `docs/specs/sketch-tool.md`.

use kb_draw::{Error as DrawFailure, sketches};
use serde_json::{Map, Value, json};

use crate::common::{self, ToolError, ToolResult, notify_on_success};

/// `_error`: a failure of the sketch service as the tool words it.
pub fn sketch_error(err: DrawFailure) -> ToolError {
    match err {
        DrawFailure::Docs(exc) => {
            let hint = if exc.code == "sketch_conflict" {
                " Export the sketch again, re-apply your change on the new version, and save it."
            } else {
                ""
            };
            ToolError::Value(format!("{}{hint}", exc.message))
        }
        DrawFailure::Value(message) => ToolError::Value(message),
        DrawFailure::Db(err) => err.into(),
        DrawFailure::Io(err) => ToolError::Other(err.to_string()),
    }
}

/// `_same_project`: an AI run may only touch sketches of the project it works in.
fn same_project(project_id: Option<&str>) -> Result<(), ToolError> {
    if let Some(run) = kb_ai::guard::current() {
        if project_id != Some(run.project_id.as_str()) {
            return Err(ToolError::value(
                "That sketch belongs to another project than this run works in, so it was left alone.",
            ));
        }
    }
    Ok(())
}

/// List a project's sketches: [{id, title, owner_kind, owner_id, version, width, height, layers, updated_by,
/// updated_at, markdown}].
pub async fn list_project_sketches(project_id: &str) -> ToolResult {
    let session = common::async_session();
    Ok(Value::Array(sketches::list_for_agent(&session, project_id).await.map_err(sketch_error)?))
}

/// Write a sketch's PNG and editable source to local paths. Returns {png_path, source_path, version, width, height,
/// layers, markdown}.
pub async fn export_sketch(sketch_id: &str, path: &str) -> ToolResult {
    let session = common::async_session();
    let s = sketches::get_sketch(&session, sketch_id).await.map_err(sketch_error)?;
    same_project(s.get("project_id").and_then(Value::as_str))?;
    Ok(Value::Object(sketches::export_to_files(&session, sketch_id, path).await.map_err(sketch_error)?))
}

/// Create a sketch from a local PNG (and its .sketch.json). Returns {id, title, version, markdown}: put `markdown`
/// on its own line in a ticket, comment or Docs page.
pub async fn create_sketch_from_files(
    owner_kind: &str,
    owner_id: &str,
    title: &str,
    path: &str,
    source_path: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let project = sketches::project_of(&session, owner_kind, owner_id, None).await.map_err(sketch_error)?;
        same_project(project.as_deref())?;
        let out = sketches::create_from_files(&session, owner_kind, owner_id, title, path, source_path)
            .await
            .map_err(sketch_error)?;
        let (id, title) = (out["id"].as_str().unwrap_or_default(), out["title"].as_str().unwrap_or_default());
        Ok(json!({
            "id": id,
            "title": title,
            "version": out["version"],
            "markdown": format!("![{title}](sketch:{id})"),
        }))
    })
    .await
}

/// Save a local PNG (and its .sketch.json) as a new version of a sketch. Returns {id, title, version}.
pub async fn save_sketch_files(
    sketch_id: &str,
    path: &str,
    base_version: i64,
    source_path: Option<&str>,
    title: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let s = sketches::get_sketch(&session, sketch_id).await.map_err(sketch_error)?;
        same_project(s.get("project_id").and_then(Value::as_str))?;
        let base_version = i32::try_from(base_version).unwrap_or(i32::MAX);
        let out = sketches::save_from_files(&session, sketch_id, path, base_version, source_path, title)
            .await
            .map_err(sketch_error)?;
        let keys: Map<String, Value> =
            ["id", "title", "version"].iter().map(|k| (k.to_string(), out[*k].clone())).collect();
        Ok(Value::Object(keys))
    })
    .await
}
