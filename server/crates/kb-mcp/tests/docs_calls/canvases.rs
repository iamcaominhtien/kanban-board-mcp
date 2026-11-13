//! Canvases: reading a plane, making one from folders of web pages, changing a frame, commenting, and looking at it.

use serde_json::json;

use super::{Call, Fixtures, call, dr, dw, dwk, finish, golden, keep, run_with_files};
use crate::{Run, common};

fn setup() -> Vec<Call> {
    vec![
        keep("setup: project", "manage_project", json!({"action": "create", "name": "Plane", "prefix": "PLN"}), "p"),
        keep("setup: Dan", "manage_project", json!({"action": "add_member", "project_id": "$p", "name": "Dan"}), "dan"),
        keep("setup: Bao", "manage_project", json!({"action": "add_member", "project_id": "$p", "name": "Bao"}), "bao"),
        keep(
            "setup: other project",
            "manage_project",
            json!({"action": "create", "name": "Away", "prefix": "AWY"}),
            "p2",
        ),
        keep(
            "setup: a ticket",
            "manage_ticket",
            json!({"action": "create", "project_id": "$p", "title": "Mock it", "type": "task"}),
            "t1",
        ),
        keep(
            "setup: a ticket elsewhere",
            "manage_ticket",
            json!({"action": "create", "project_id": "$p2", "title": "Far", "type": "task"}),
            "t2",
        ),
        dwk(
            "setup: a page",
            "create",
            json!({"project_id": "$p", "title": "Screens", "markdown": "## Home\n\ntext"}),
            "pg",
        ),
    ]
}

fn create_calls(f: &Fixtures) -> Vec<Call> {
    vec![
        dr("canvases: none yet", "canvases", json!({"project_id": "$p"})),
        dr("canvases: nothing else", "canvases", json!({})),
        dr("canvases: a project that does not exist", "canvases", json!({"project_id": "nope"})),
        dr("canvas: nothing else", "canvas", json!({})),
        dr("canvas: one that does not exist", "canvas", json!({"canvas_id": "cv_00000000"})),
        dw("canvas_create: nothing else", "canvas_create", json!({})),
        dw(
            "canvas_create: a parameter it does not use",
            "canvas_create",
            json!({"path": f.path("canvas"), "owner_kind": "doc", "owner_id": "$pg", "page_id": "x"}),
        ),
        dw("canvas_create: no owner and no canvas", "canvas_create", json!({"path": f.path("canvas")})),
        dw(
            "canvas_create: an owner kind without an id",
            "canvas_create",
            json!({"path": f.path("canvas"), "owner_kind": "doc"}),
        ),
        dw(
            "canvas_create: a relative path",
            "canvas_create",
            json!({"path": "canvas", "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: a folder that does not exist",
            "canvas_create",
            json!({"path": "/no/such/folder", "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: a file, not a folder",
            "canvas_create",
            json!({"path": f.path("pic.png"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: a folder without a page",
            "canvas_create",
            json!({"path": f.path("nopage"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: an owner kind that does not exist",
            "canvas_create",
            json!({"path": f.path("flat"), "owner_kind": "note", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: a note near a frame that is not there",
            "canvas_create",
            json!({"path": f.path("badlayout"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: an arrow to nowhere",
            "canvas_create",
            json!({"path": f.path("badarrow"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: a layout that is not JSON",
            "canvas_create",
            json!({"path": f.path("badjson"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: too many frames",
            "canvas_create",
            json!({"path": f.path("many"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: a frame over 5 MB",
            "canvas_create",
            json!({"path": f.path("heavy"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: too many page tabs",
            "canvas_create",
            json!({"path": f.path("tabs"), "owner_kind": "doc", "owner_id": "$pg"}),
        ),
        dw(
            "canvas_create: a ticket that does not exist",
            "canvas_create",
            json!({"path": f.path("flat"), "owner_kind": "ticket", "owner_id": "NOPE-1"}),
        ),
        dw(
            "canvas_create: a page that does not exist",
            "canvas_create",
            json!({"path": f.path("flat"), "owner_kind": "doc", "owner_id": "nope"}),
        ),
        dw(
            "canvas_create: a canvas that does not exist",
            "canvas_create",
            json!({"path": f.path("flat"), "canvas_id": "cv_00000000"}),
        ),
        dwk(
            "canvas_create: from a folder of frames",
            "canvas_create",
            json!({"path": f.path("canvas"), "owner_kind": "doc", "owner_id": "$pg", "title": "Mockups"}),
            "cv1",
        ),
        dwk(
            "canvas_create: from one page at the top",
            "canvas_create",
            json!({"path": f.path("flat"), "owner_kind": "ticket", "owner_id": "$t1"}),
            "cv2",
        ),
        dw(
            "canvas_create: frames added to a canvas",
            "canvas_create",
            json!({"path": f.path("flat"), "canvas_id": "$cv1"}),
        ),
        dw(
            "canvas_create: the same folder with a canvas and an owner",
            "canvas_create",
            json!({"path": f.path("edit"), "canvas_id": "$cv1", "owner_kind": "doc", "owner_id": "$pg", "title": "ignored"}),
        ),
        dwk(
            "canvas_create: for a ticket of another project",
            "canvas_create",
            json!({"path": f.path("flat"), "owner_kind": "ticket", "owner_id": "$t2"}),
            "cv3",
        ),
        dr("canvases: the list", "canvases", json!({"project_id": "$p"})),
        dr("canvases: the other project", "canvases", json!({"project_id": "$p2"})),
    ]
}

fn read_calls(f: &Fixtures) -> Vec<Call> {
    let out = f.path("frame-out");
    vec![
        dr("canvas: the plane", "canvas", json!({"canvas_id": "$cv1"})),
        dr("canvas: a plane with one page", "canvas", json!({"canvas_id": "$cv2"})),
        dr("canvas: a frame's source", "canvas", json!({"canvas_id": "$cv1", "board_id": "$b1"})),
        dr("canvas: a frame that is not there", "canvas", json!({"canvas_id": "$cv1", "board_id": "b_00000000"})),
        dr(
            "canvas: a frame's files to a folder",
            "canvas",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": out}),
        ),
        dr(
            "canvas: a frame's files to a relative folder",
            "canvas",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": "out"}),
        ),
        dr("canvas: a path without a frame", "canvas", json!({"canvas_id": "$cv1", "path": out})),
        dr("canvas: of another project", "canvas", json!({"canvas_id": "$cv3"})),
    ]
}

fn comment_calls() -> Vec<Call> {
    vec![
        dw("canvas_comment: nothing else", "canvas_comment", json!({})),
        dw("canvas_comment: no body", "canvas_comment", json!({"canvas_id": "$cv1"})),
        dw(
            "canvas_comment: a parameter it does not use",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "x", "title": "t"}),
        ),
        dw(
            "canvas_comment: a canvas that does not exist",
            "canvas_comment",
            json!({"canvas_id": "cv_00000000", "body": "x"}),
        ),
        dw("canvas_comment: an empty body", "canvas_comment", json!({"canvas_id": "$cv1", "body": "  "})),
        dw(
            "canvas_comment: a body that is too long",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "x".repeat(4001)}),
        ),
        dw(
            "canvas_comment: an element without a frame",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "x", "at": "#go"}),
        ),
        dw(
            "canvas_comment: a frame that is not there",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "x", "board_id": "b_00000000"}),
        ),
        dwk(
            "canvas_comment: on the plane",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "Too much grey"}),
            "th1",
        ),
        dwk(
            "canvas_comment: on a frame",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "Align this", "board_id": "$b1"}),
            "th2",
        ),
        dwk(
            "canvas_comment: on an element",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "Bigger button, @Bao", "board_id": "$b1", "at": "#go"}),
            "th3",
        ),
        dwk(
            "canvas_comment: on a text",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "Typo", "board_id": "$b1", "at": "text=Welcome"}),
            "th4",
        ),
        dw(
            "canvas_comment: a reply",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "Fixed", "thread_id": "$th3"}),
        ),
        dw(
            "canvas_comment: a reply to a thread of another canvas",
            "canvas_comment",
            json!({"canvas_id": "$cv2", "body": "x", "thread_id": "$th3"}),
        ),
        dw(
            "canvas_comment: a reply to a thread that does not exist",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "x", "thread_id": "nope"}),
        ),
        dw(
            "canvas_comment: a reply with a pin it ignores",
            "canvas_comment",
            json!({"canvas_id": "$cv1", "body": "x", "thread_id": "$th1", "board_id": "$b1", "at": "p"}),
        ),
        dr("canvas: with its comments", "canvas", json!({"canvas_id": "$cv1"})),
    ]
}

fn update_calls(f: &Fixtures) -> Vec<Call> {
    vec![
        dw("canvas_update: nothing else", "canvas_update", json!({})),
        dw("canvas_update: no path", "canvas_update", json!({"canvas_id": "$cv1", "board_id": "$b1"})),
        dw(
            "canvas_update: a parameter it does not use",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": f.path("edit"), "body": "x"}),
        ),
        dw(
            "canvas_update: a canvas that does not exist",
            "canvas_update",
            json!({"canvas_id": "cv_00000000", "board_id": "$b1", "path": f.path("edit")}),
        ),
        dw(
            "canvas_update: a frame that is not there",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "b_00000000", "path": f.path("edit")}),
        ),
        dw(
            "canvas_update: a relative path",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": "edit"}),
        ),
        dw(
            "canvas_update: a folder that does not exist",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": "/no/such"}),
        ),
        dw(
            "canvas_update: an empty folder",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": f.path("empty")}),
        ),
        dw(
            "canvas_update: a folder with no page to show",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": f.path("nopage")}),
        ),
        dw(
            "canvas_update: a frame that is a picture",
            "canvas_update",
            json!({"canvas_id": "$cv2", "board_id": "$bimg", "path": f.path("edit")}),
        ),
        dw(
            "canvas_update: change a frame",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": f.path("edit"), "note": "New title"}),
        ),
        dw(
            "canvas_update: change it again",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b1", "path": f.path("edit")}),
        ),
        dr("canvas: the frame after the changes", "canvas", json!({"canvas_id": "$cv1", "board_id": "$b1"})),
        dw(
            "canvas_update: a frame a person is editing",
            "canvas_update",
            json!({"canvas_id": "$cv1", "board_id": "$b2", "path": f.path("edit")}),
        ),
        dr("picture: the plane's layout", "picture", json!({"canvas_id": "$cv1"})),
        dr("picture: a frame", "picture", json!({"canvas_id": "$cv1", "board_id": "$b1", "path": f.path("pic-out")})),
        dr("picture: a frame at a width", "picture", json!({"canvas_id": "$cv1", "board_id": "$b1", "width": 390})),
        dr("picture: a frame that is not there", "picture", json!({"canvas_id": "$cv1", "board_id": "b_00000000"})),
        dr("picture: of another project", "picture", json!({"canvas_id": "$cv3", "board_id": "$b1"})),
        dw(
            "page: a canvas in a page",
            "update",
            json!({"page_id": "$pg", "markdown": "## Home\n\n![Mockups](canvas:$cv1)\n", "base_version": 1}),
        ),
        dr("page: the canvas is linked", "get", json!({"page_id": "$pg"})),
        call("ticket: a canvas for a ticket", "get_ticket", json!({"ticket_id": "$t1"})),
    ]
}

#[tokio::test]
async fn docs_canvases_answer_as_python_does() {
    let s = common::start().await;
    let f = Fixtures::new();
    // limits
    for i in 0..61 {
        f.write(&format!("many/f{i:02}/index.html"), "<p>x</p>");
    }
    f.write("heavy/a/index.html", "<p>x</p>");
    std::fs::write(f.path("heavy/a/big.txt"), vec![b'x'; 5 * 1024 * 1024 + 1]).expect("a file");
    for i in 0..11 {
        f.write(&format!("tabs/f{i:02}/index.html"), "<p>x</p>");
        f.write(&format!("tabs/f{i:02}/frame.json"), &json!({"page": format!("Tab {i}")}).to_string());
    }
    let mut run = Run::new(s.mcp());
    run.run(setup()).await;
    run_with_files(&mut run, create_calls(&f)).await;
    // the ids of the frames
    let plane = run.mcp.call_tool("docs_read", json!({"action": "canvas", "canvas_id": run.id("cv1")})).await.json();
    let boards = plane["boards"].as_array().expect("boards");
    run.ids.insert("b1".into(), boards[0]["id"].as_str().expect("a frame").to_string());
    run.ids.insert("b2".into(), boards[1]["id"].as_str().expect("a frame").to_string());
    // a frame that is a picture: made by a person through the REST API
    let c = s.client();
    let image = c
        .upload(
            &format!("/canvases/{}/boards", run.id("cv2")),
            "files",
            "shot.png",
            "image/png",
            super::PNG.to_vec(),
            &[("kind", "image"), ("name", "Shot")],
        )
        .await;
    image.assert_status(201);
    let flat = run.mcp.call_tool("docs_read", json!({"action": "canvas", "canvas_id": run.id("cv2")})).await.json();
    run.ids.insert("bimg".into(), flat["boards"][0]["id"].as_str().expect("a frame").to_string());
    run_with_files(&mut run, read_calls(&f)).await;
    run.run(comment_calls()).await;
    // a person holds the lock of the second frame
    let lock = s
        .client()
        .header("x-actor", "Dan")
        .post_empty(&format!("/canvases/{}/boards/{}/lock", run.id("cv1"), run.id("b2")))
        .await;
    run.got.insert("rest: a person locks a frame".into(), json!({"status": lock.status}));
    run_with_files(&mut run, update_calls(&f)).await;
    let pictures = std::env::temp_dir().join("kanban-pictures").to_string_lossy().into_owned();
    let folders = f.folders(&[(s.dir().to_string_lossy().into_owned(), "<dir>"), (pictures, "<pictures>")]);
    let got = finish(run, &folders);
    golden("mcp_tool_calls_docs_canvases.json", &got);
}
