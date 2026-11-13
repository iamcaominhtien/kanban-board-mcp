//! Diagram operations: draw.io drawings that sit in markdown as `[label](diagram:dg_xxxxxxxx)`.
//!
//! An agent works on the `.drawio` file itself: export it to a local path, edit it with its own file tools, save it
//! back.

use kb_db::Session;
use kb_draw::diagram_model::{self, Drawing};
use kb_draw::{Error as DrawFailure, diagrams};
use serde_json::{Map, Value, json};

use crate::common::{self, ToolError, ToolResult, notify_on_success};

/// `_error`: a failure of the diagram service as the tool words it: the message, and for a conflict what to do next.
pub fn diagram_error(err: DrawFailure) -> ToolError {
    match err {
        DrawFailure::Docs(exc) => {
            let hint = if exc.code == "diagram_conflict" {
                " Export the diagram again, re-apply your change on the new version, and save it."
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

/// `_preview_note`: tell the agent how good the stored picture is.
fn preview_note(out: &Map<String, Value>) -> Map<String, Value> {
    let note = match out.get("preview_kind").and_then(Value::as_str) {
        Some("editor") => Some("exact: drawn by the draw.io editor"),
        Some("agent") => Some("your SVG"),
        Some("basic") => Some(
            "plain: boxes, arrows and text only; shapes beyond those show as boxes until someone opens the diagram in \
             the editor and saves",
        ),
        _ => None,
    };
    let mut map = Map::new();
    if let Some(note) = note {
        map.insert("preview".into(), json!(note));
    }
    map
}

/// `_same_project`: an AI run may only read diagrams of the project it works in.
fn same_project(project_id: Option<&str>) -> Result<(), ToolError> {
    if let Some(run) = kb_ai::guard::current() {
        if project_id.is_some_and(|p| !p.is_empty() && p != run.project_id) {
            return Err(ToolError::value(
                "That diagram belongs to another project than this run works in, so it was left alone.",
            ));
        }
    }
    Ok(())
}

/// List a project's diagrams: [{id, label, version, updated_by, updated_at, summary}].
pub async fn list_project_diagrams(project_id: &str) -> ToolResult {
    let session = common::async_session();
    Ok(Value::Array(diagrams::list_for_agent(&session, project_id).await.map_err(diagram_error)?))
}

/// Read a diagram as a model (shapes, links, labels, boxes, styles, problems), and with `path` write its .drawio
/// file there to edit. Returns {id, label, version, markdown, model[, path]}.
pub async fn export_diagram(diagram_id: &str, path: Option<&str>, version: Option<i64>) -> ToolResult {
    let session = common::async_session();
    let version = version.and_then(|v| i32::try_from(v).ok());
    let d = diagrams::get_diagram(&session, diagram_id, version, true).await.map_err(diagram_error)?;
    same_project(d.get("project_id").and_then(Value::as_str))?;
    let mut out = match path.filter(|p| !p.is_empty()) {
        Some(path) => diagrams::export_to_file(&session, diagram_id, path, version).await.map_err(diagram_error)?,
        None => {
            let mut out = Map::new();
            out.insert("id".into(), d["id"].clone());
            out.insert("label".into(), d["label"].clone());
            out.insert("version".into(), d["version"].clone());
            out.insert(
                "markdown".into(),
                json!(format!(
                    "[{}](diagram:{})",
                    d["label"].as_str().unwrap_or_default(),
                    d["id"].as_str().unwrap_or_default()
                )),
            );
            out
        }
    };
    let source = d.get("source").and_then(Value::as_str).unwrap_or_default();
    let model = match diagram_model::model(source, diagram_model::MODEL_CELLS) {
        Ok(model) => Value::Object(model),
        Err(diagram_model::Error::Docs(exc)) => json!({"error": exc.message}),
        Err(diagram_model::Error::Value(message)) => return Err(ToolError::Other(message)),
    };
    out.insert("model".into(), model);
    Ok(Value::Object(out))
}

/// `_problems`: what will look broken in the saved file (links to nothing, overlaps), as a hint after a save.
fn problems(path: &str) -> Result<Map<String, Value>, ToolError> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(Map::new()) };
    let found = match Drawing::new(&text).and_then(|d| diagram_model::problems(&d)) {
        Ok(found) => found,
        Err(diagram_model::Error::Docs(_)) => return Ok(Map::new()),
        Err(diagram_model::Error::Value(message)) => return Err(ToolError::Other(message)),
    };
    let mut out = Map::new();
    if !found.is_empty() {
        out.insert("problems".into(), json!(found));
        out.insert(
            "fix".into(),
            json!(
                "Saved as it is. Fix these in the file and save again (docs_write diagram_save with the new version)."
            ),
        );
    }
    Ok(out)
}

/// The keys of a service result, in the order listed.
fn keys_of(out: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    keys.iter().map(|k| (k.to_string(), out.get(*k).cloned().unwrap_or(Value::Null))).collect()
}

/// Create a diagram from a local .drawio file. Returns {id, label, version, markdown}: put `markdown` on its own
/// line in a ticket, comment or Docs page.
pub async fn create_diagram_from_file(
    project_id: &str,
    label: &str,
    path: &str,
    svg_path: Option<&str>,
    summary: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let session: Session = common::async_session();
        let out = diagrams::create_from_file(&session, project_id, label, path, svg_path, summary)
            .await
            .map_err(diagram_error)?;
        let mut reply = keys_of(&out, &["id", "label", "version", "markdown"]);
        reply.extend(preview_note(&out));
        reply.extend(problems(path)?);
        Ok(Value::Object(reply))
    })
    .await
}

/// Save a local .drawio file as a new version of a diagram. Returns {id, label, version}.
pub async fn save_diagram_file(
    diagram_id: &str,
    path: &str,
    base_version: i64,
    svg_path: Option<&str>,
    label: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let base_version = i32::try_from(base_version).unwrap_or(i32::MAX);
        let out = diagrams::save_from_file(&session, diagram_id, path, base_version, svg_path, label)
            .await
            .map_err(diagram_error)?;
        let mut reply = keys_of(&out, &["id", "label", "version"]);
        reply.extend(preview_note(&out));
        reply.extend(problems(path)?);
        Ok(Value::Object(reply))
    })
    .await
}

/// Unlink a diagram. It is kept and can be restored; texts that reference it show 'Diagram not found'.
pub async fn delete_diagram(diagram_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        Ok(Value::Object(diagrams::delete_diagram(&session, diagram_id).await.map_err(diagram_error)?))
    })
    .await
}

/// Bring an unlinked diagram back.
pub async fn restore_diagram(diagram_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let out = diagrams::restore_diagram(&session, diagram_id).await.map_err(diagram_error)?;
        Ok(Value::Object(keys_of(&out, &["id", "label", "version"])))
    })
    .await
}
