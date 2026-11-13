//! `docs_read`: reading a project's Docs: pages, search, versions, comments, diagrams, sketches, canvases, pictures
//! and the guides.

use serde_json::{Map, Value};

use crate::common::{ToolResult, arg_int, arg_str, arg_strings, arg_text};
use crate::operations as ops;
use crate::operations::pictures::PictureArgs;
use crate::tools::routing::{Op, dispatch, params_of};

/// `DOCS_READ_OPS`: what each action runs and takes, in the order of the Python table.
pub const DOCS_READ_OPS: &[(&str, Op)] = &[
    (
        "list",
        Op::new(
            |a| Box::pin(async move { ops::list_docs_pages(&arg_text(&a, "project_id")).await }),
            &["project_id"],
            &[],
        ),
    ),
    (
        "get",
        Op::new(
            |a| {
                Box::pin(async move {
                    let section = arg_str(&a, "section");
                    ops::get_docs_page(&arg_text(&a, "page_id"), section.as_deref()).await
                })
            },
            &["page_id"],
            &["section"],
        ),
    ),
    (
        "search",
        Op::new(
            |a| {
                Box::pin(async move {
                    let scope = arg_str(&a, "scope").unwrap_or_else(|| "space".to_string());
                    ops::search_docs(
                        &arg_text(&a, "project_id"),
                        &arg_text(&a, "query"),
                        &scope,
                        arg_int(&a, "limit").unwrap_or(10),
                    )
                    .await
                })
            },
            &["project_id", "query"],
            &["scope", "limit"],
        ),
    ),
    (
        "versions",
        Op::new(
            |a| Box::pin(async move { ops::list_docs_versions(&arg_text(&a, "page_id")).await }),
            &["page_id"],
            &[],
        ),
    ),
    (
        "version",
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::get_docs_version(
                        &arg_text(&a, "page_id"),
                        arg_int(&a, "version").unwrap_or_default(),
                        arg_int(&a, "compare_to"),
                    )
                    .await
                })
            },
            &["page_id", "version"],
            &["compare_to"],
        ),
    ),
    (
        "recycle_bin",
        Op::new(
            |a| Box::pin(async move { ops::list_docs_recycle_bin(&arg_text(&a, "project_id")).await }),
            &["project_id"],
            &[],
        ),
    ),
    (
        "check_links",
        Op::new(
            |a| {
                Box::pin(async move {
                    let refs = arg_strings(&a, "refs").unwrap_or_default();
                    ops::resolve_docs_links(&arg_text(&a, "project_id"), &refs).await
                })
            },
            &["project_id", "refs"],
            &[],
        ),
    ),
    (
        "comments",
        Op::new(
            |a| {
                Box::pin(async move {
                    let state = arg_str(&a, "state").unwrap_or_else(|| "all".to_string());
                    ops::list_docs_comments(&arg_text(&a, "page_id"), &state).await
                })
            },
            &["page_id"],
            &["state"],
        ),
    ),
    (
        "diagrams",
        Op::new(
            |a| Box::pin(async move { ops::list_project_diagrams(&arg_text(&a, "project_id")).await }),
            &["project_id"],
            &[],
        ),
    ),
    (
        "diagram",
        Op::new(
            |a| {
                Box::pin(async move {
                    let path = arg_str(&a, "path");
                    ops::export_diagram(&arg_text(&a, "diagram_id"), path.as_deref(), arg_int(&a, "version")).await
                })
            },
            &["diagram_id"],
            &["path", "version"],
        ),
    ),
    (
        "sketches",
        Op::new(
            |a| Box::pin(async move { ops::list_project_sketches(&arg_text(&a, "project_id")).await }),
            &["project_id"],
            &[],
        ),
    ),
    (
        "sketch",
        Op::new(
            |a| Box::pin(async move { ops::export_sketch(&arg_text(&a, "sketch_id"), &arg_text(&a, "path")).await }),
            &["sketch_id", "path"],
            &[],
        ),
    ),
    (
        "canvases",
        Op::new(
            |a| Box::pin(async move { ops::list_project_canvases(&arg_text(&a, "project_id")).await }),
            &["project_id"],
            &[],
        ),
    ),
    (
        "canvas",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (board_id, path) = (arg_str(&a, "board_id"), arg_str(&a, "path"));
                    ops::read_canvas(&arg_text(&a, "canvas_id"), board_id.as_deref(), path.as_deref()).await
                })
            },
            &["canvas_id"],
            &["board_id", "path"],
        ),
    ),
    ("design_guide", Op::new(|_| Box::pin(async move { ops::design_guide().await }), &[], &[])),
    ("diagram_guide", Op::new(|_| Box::pin(async move { ops::diagram_guide().await }), &[], &[])),
    (
        "picture",
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::picture(PictureArgs {
                        path: arg_str(&a, "path"),
                        diagram_id: arg_str(&a, "diagram_id"),
                        version: arg_int(&a, "version"),
                        canvas_id: arg_str(&a, "canvas_id"),
                        board_id: arg_str(&a, "board_id"),
                        sketch_id: arg_str(&a, "sketch_id"),
                        width: arg_int(&a, "width"),
                    })
                    .await
                })
            },
            &[],
            &["path", "diagram_id", "version", "canvas_id", "board_id", "sketch_id", "width"],
        ),
    ),
    ("guides", Op::new(|_| Box::pin(async move { ops::shared_guides().await }), &[], &[])),
    (
        "role_guide",
        Op::new(
            |a| {
                Box::pin(async move {
                    let query = arg_str(&a, "query");
                    ops::role_guide(query.as_deref()).await
                })
            },
            &[],
            &["query"],
        ),
    ),
    ("ticket_guide", Op::new(|_| Box::pin(async move { ops::ticket_guide().await }), &[], &[])),
    ("docs_guide", Op::new(|_| Box::pin(async move { ops::docs_guide().await }), &[], &[])),
];

/// Read a project's Docs: a tree of Markdown pages. `action`: list, get, search, versions, version, recycle_bin,
/// check_links, comments, diagrams, diagram, sketches, sketch, canvases, canvas, design_guide, diagram_guide,
/// picture, guides, role_guide, ticket_guide, docs_guide (the tool's description says what each takes).
pub async fn docs_read(args: Map<String, Value>) -> ToolResult {
    super::super::checked_read("docs_read", args, |a| {
        Box::pin(async move {
            let action = arg_text(&a, "action");
            dispatch("docs_read", DOCS_READ_OPS, &action, params_of(a)).await
        })
    })
    .await
}
