//! `docs_write`: changing a project's Docs: pages, comments, import, files, diagrams, sketches and canvases.

use serde_json::{Map, Value};

use super::composite;
use crate::common::{ToolError, ToolResult, arg_bool, arg_int, arg_str, arg_text};
use crate::operations as ops;
use crate::tools::routing::{Op, batch, dispatch, params_of};

/// The parameters of `create_sketch_from_files` as Pydantic's `validate_call` reads them: a sketch belongs to a ticket
/// or a Docs page, where the tool also takes an idea (a canvas may belong to one).
const SKETCH_CREATE_PARAMS: &str = r#"{"properties": {
    "owner_kind": {"enum": ["ticket", "doc"], "type": "string"},
    "owner_id": {"type": "string"},
    "title": {"type": "string"},
    "path": {"type": "string"},
    "source_path": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}
  }, "required": ["owner_kind", "owner_id", "title", "path"]}"#;

/// `DOCS_WRITE_OPS`: what each action runs and takes, in the order of the Python table (`edit`, `tickets` and `assign`
/// are made of other actions: `DOCS_WRITE_COMPOSITE`).
pub const DOCS_WRITE_OPS: &[(&str, Op)] = &[
    (
        "create",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (markdown, parent_id) = (arg_str(&a, "markdown").unwrap_or_default(), arg_str(&a, "parent_id"));
                    ops::create_docs_page(
                        &arg_text(&a, "project_id"),
                        &arg_text(&a, "title"),
                        &markdown,
                        parent_id.as_deref(),
                    )
                    .await
                })
            },
            &["project_id", "title"],
            &["markdown", "parent_id"],
        ),
    ),
    (
        "update",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (note, title) = (arg_str(&a, "note"), arg_str(&a, "title"));
                    ops::update_docs_page(
                        &arg_text(&a, "page_id"),
                        &arg_text(&a, "markdown"),
                        arg_int(&a, "base_version").unwrap_or_default(),
                        note.as_deref(),
                        arg_bool(&a, "publish").unwrap_or(true),
                        title.as_deref(),
                    )
                    .await
                })
            },
            &["page_id", "markdown", "base_version"],
            &["note", "publish", "title"],
        ),
    ),
    (
        "upload",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (path, data, name) = (arg_str(&a, "path"), arg_str(&a, "data"), arg_str(&a, "name"));
                    ops::upload_file(path.as_deref(), data.as_deref(), name.as_deref()).await
                })
            },
            &[],
            &["path", "data", "name"],
        ),
    ),
    (
        "move",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (parent_id, after_id) = (arg_str(&a, "parent_id"), arg_str(&a, "after_id"));
                    ops::move_docs_page(&arg_text(&a, "page_id"), parent_id.as_deref(), after_id.as_deref()).await
                })
            },
            &["page_id"],
            &["parent_id", "after_id"],
        ),
    ),
    (
        "duplicate",
        Op::new(
            |a| {
                Box::pin(async move {
                    let title = arg_str(&a, "title");
                    ops::duplicate_docs_page(
                        &arg_text(&a, "page_id"),
                        arg_bool(&a, "include_children").unwrap_or(false),
                        title.as_deref(),
                    )
                    .await
                })
            },
            &["page_id"],
            &["include_children", "title"],
        ),
    ),
    (
        "delete",
        Op::new(|a| Box::pin(async move { ops::delete_docs_page(&arg_text(&a, "page_id")).await }), &["page_id"], &[]),
    ),
    (
        "restore",
        Op::new(|a| Box::pin(async move { ops::restore_docs_page(&arg_text(&a, "page_id")).await }), &["page_id"], &[]),
    ),
    (
        "restore_version",
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::restore_docs_version(&arg_text(&a, "page_id"), arg_int(&a, "version").unwrap_or_default())
                        .await
                })
            },
            &["page_id", "version"],
            &[],
        ),
    ),
    (
        "import",
        Op::new(
            |a| {
                Box::pin(async move {
                    let parent_id = arg_str(&a, "parent_id");
                    ops::import_docs(
                        &arg_text(&a, "project_id"),
                        &arg_text(&a, "path"),
                        parent_id.as_deref(),
                        arg_bool(&a, "publish").unwrap_or(true),
                    )
                    .await
                })
            },
            &["project_id", "path"],
            &["parent_id", "publish"],
        ),
    ),
    (
        "comment",
        Op::new(
            |a| {
                Box::pin(async move {
                    let quote = arg_str(&a, "quote");
                    ops::add_docs_comment(&arg_text(&a, "page_id"), &arg_text(&a, "body"), quote.as_deref()).await
                })
            },
            &["page_id", "body"],
            &["quote"],
        ),
    ),
    (
        "reply",
        Op::new(
            |a| {
                Box::pin(
                    async move { ops::reply_docs_comment(&arg_text(&a, "thread_id"), &arg_text(&a, "body")).await },
                )
            },
            &["thread_id", "body"],
            &[],
        ),
    ),
    (
        "edit_comment",
        Op::new(
            |a| {
                Box::pin(
                    async move { ops::edit_docs_comment(&arg_text(&a, "comment_id"), &arg_text(&a, "body")).await },
                )
            },
            &["comment_id", "body"],
            &[],
        ),
    ),
    (
        "delete_comment",
        Op::new(
            |a| Box::pin(async move { ops::delete_docs_comment(&arg_text(&a, "comment_id")).await }),
            &["comment_id"],
            &[],
        ),
    ),
    (
        "resolve",
        Op::new(
            |a| Box::pin(async move { ops::resolve_docs_comment(&arg_text(&a, "thread_id")).await }),
            &["thread_id"],
            &[],
        ),
    ),
    (
        "reopen",
        Op::new(
            |a| Box::pin(async move { ops::reopen_docs_comment(&arg_text(&a, "thread_id")).await }),
            &["thread_id"],
            &[],
        ),
    ),
    (
        "diagram_create",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (svg_path, summary) = (arg_str(&a, "svg_path"), arg_str(&a, "summary"));
                    ops::create_diagram_from_file(
                        &arg_text(&a, "project_id"),
                        &arg_text(&a, "label"),
                        &arg_text(&a, "path"),
                        svg_path.as_deref(),
                        summary.as_deref(),
                    )
                    .await
                })
            },
            &["project_id", "title", "path"],
            &["svg_path", "summary"],
        )
        .rename(&[("title", "label")]),
    ),
    (
        "diagram_save",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (svg_path, label) = (arg_str(&a, "svg_path"), arg_str(&a, "label"));
                    ops::save_diagram_file(
                        &arg_text(&a, "diagram_id"),
                        &arg_text(&a, "path"),
                        arg_int(&a, "base_version").unwrap_or_default(),
                        svg_path.as_deref(),
                        label.as_deref(),
                    )
                    .await
                })
            },
            &["diagram_id", "path", "base_version"],
            &["svg_path", "title"],
        )
        .rename(&[("title", "label")]),
    ),
    (
        "diagram_delete",
        Op::new(
            |a| Box::pin(async move { ops::delete_diagram(&arg_text(&a, "diagram_id")).await }),
            &["diagram_id"],
            &[],
        ),
    ),
    (
        "diagram_restore",
        Op::new(
            |a| Box::pin(async move { ops::restore_diagram(&arg_text(&a, "diagram_id")).await }),
            &["diagram_id"],
            &[],
        ),
    ),
    (
        "sketch_create",
        Op::new(
            |a| {
                Box::pin(async move {
                    let source_path = arg_str(&a, "source_path");
                    ops::create_sketch_from_files(
                        &arg_text(&a, "owner_kind"),
                        &arg_text(&a, "owner_id"),
                        &arg_text(&a, "title"),
                        &arg_text(&a, "path"),
                        source_path.as_deref(),
                    )
                    .await
                })
            },
            &["owner_kind", "owner_id", "title", "path"],
            &["source_path"],
        )
        .params(SKETCH_CREATE_PARAMS),
    ),
    (
        "sketch_save",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (source_path, title) = (arg_str(&a, "source_path"), arg_str(&a, "title"));
                    ops::save_sketch_files(
                        &arg_text(&a, "sketch_id"),
                        &arg_text(&a, "path"),
                        arg_int(&a, "base_version").unwrap_or_default(),
                        source_path.as_deref(),
                        title.as_deref(),
                    )
                    .await
                })
            },
            &["sketch_id", "path", "base_version"],
            &["source_path", "title"],
        ),
    ),
    (
        "canvas_create",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (owner_kind, owner_id) = (arg_str(&a, "owner_kind"), arg_str(&a, "owner_id"));
                    let (title, canvas_id) = (arg_str(&a, "title"), arg_str(&a, "canvas_id"));
                    ops::create_canvas_from_files(
                        &arg_text(&a, "path"),
                        owner_kind.as_deref(),
                        owner_id.as_deref(),
                        title.as_deref(),
                        canvas_id.as_deref(),
                    )
                    .await
                })
            },
            &["path"],
            &["owner_kind", "owner_id", "title", "canvas_id"],
        ),
    ),
    (
        "canvas_comment",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (board_id, thread_id, at) =
                        (arg_str(&a, "board_id"), arg_str(&a, "thread_id"), arg_str(&a, "at"));
                    ops::comment_on_canvas(
                        &arg_text(&a, "canvas_id"),
                        &arg_text(&a, "body"),
                        board_id.as_deref(),
                        thread_id.as_deref(),
                        at.as_deref(),
                    )
                    .await
                })
            },
            &["canvas_id", "body"],
            &["board_id", "thread_id", "at"],
        ),
    ),
    (
        "canvas_update",
        Op::new(
            |a| {
                Box::pin(async move {
                    let note = arg_str(&a, "note");
                    ops::update_canvas_frame(
                        &arg_text(&a, "canvas_id"),
                        &arg_text(&a, "board_id"),
                        &arg_text(&a, "path"),
                        note.as_deref(),
                    )
                    .await
                })
            },
            &["canvas_id", "board_id", "path"],
            &["note"],
        ),
    ),
];

/// Actions made of other actions (each part checked by the AI guard as a call of its own): edit reads the page and
/// publishes it with `update`, tickets creates tickets and edits the page, assign creates a ticket and asks an AI.
pub const DOCS_WRITE_COMPOSITE: [&str; 3] = ["edit", "tickets", "assign"];

/// The light actions that take `items`; page, file and diagram work is one call each.
const BATCH_ACTIONS: [&str; 4] = ["comment", "reply", "resolve", "reopen"];

/// One call of the table, checked by the AI guard when an AI run makes it.
pub async fn run_write(action: String, given: Map<String, Value>) -> ToolResult {
    dispatch("docs_write", DOCS_WRITE_OPS, &action, given).await
}

/// Write a project's Docs. `action`: create, update, edit, upload, tickets, assign, move, duplicate, delete, restore,
/// restore_version, import, comment, reply, edit_comment, delete_comment, resolve, reopen, diagram_create,
/// diagram_save, diagram_delete, diagram_restore, sketch_create, sketch_save, canvas_create, canvas_comment,
/// canvas_update (the tool's description says what each takes).
pub async fn docs_write(args: Map<String, Value>) -> ToolResult {
    let action = arg_text(&args, "action");
    let mut given = params_of(args);
    match action.as_str() {
        "edit" => return composite::edit(given).await,
        "upload" => return composite::upload(given).await,
        "tickets" => return composite::tickets(given).await,
        "assign" => return composite::assign(given).await,
        _ => {}
    }
    for key in ["section", "find", "mode", "data", "name", "ticket_id", "author", "member_id", "kind"] {
        if given.get(key).is_some_and(|v| !v.is_null()) {
            return Err(ToolError::Value(format!("docs_write(action='{action}') does not use: {key}.")));
        }
        given.shift_remove(key);
    }
    let many = given.shift_remove("items").filter(|many| !many.is_null());
    if let Some(many) = many {
        if !BATCH_ACTIONS.contains(&action.as_str()) {
            let mut sorted = BATCH_ACTIONS;
            sorted.sort_unstable();
            return Err(ToolError::Value(format!("docs_write: items only works with {}.", sorted.join(", "))));
        }
        let base = given;
        return batch(
            move |extra| {
                let mut merged = base.clone();
                merged.extend(extra);
                Box::pin(run_write(action.clone(), merged))
            },
            &many,
            true,
        )
        .await;
    }
    run_write(action, given).await
}
