//! Diagrams, sketches and pictures: the files an agent exports, edits and saves back, and the PNG it asks for to look
//! at what it drew.

use serde_json::json;

use super::{Call, Fixtures, PNG, call, dr, dw, dwk, finish, golden, keep, run_with_files};
use crate::{Run, common};

fn setup() -> Vec<Call> {
    vec![
        keep("setup: project", "manage_project", json!({"action": "create", "name": "Draw", "prefix": "DRW"}), "p"),
        keep(
            "setup: other project",
            "manage_project",
            json!({"action": "create", "name": "Away", "prefix": "AWY"}),
            "p2",
        ),
        keep(
            "setup: a ticket",
            "manage_ticket",
            json!({"action": "create", "project_id": "$p", "title": "Draw it", "type": "task"}),
            "t1",
        ),
        dwk(
            "setup: a page",
            "create",
            json!({"project_id": "$p", "title": "Design", "markdown": "## Flow\n\ntext"}),
            "pg",
        ),
    ]
}

fn diagram_calls(f: &Fixtures) -> Vec<Call> {
    let out = f.path("out");
    vec![
        dr("diagrams: none yet", "diagrams", json!({"project_id": "$p"})),
        dr("diagrams: nothing else", "diagrams", json!({})),
        dr("diagrams: a project that does not exist", "diagrams", json!({"project_id": "nope"})),
        dr("diagram: nothing else", "diagram", json!({})),
        dr("diagram: one that does not exist", "diagram", json!({"diagram_id": "dg_00000000"})),
        dw("diagram_create: nothing else", "diagram_create", json!({})),
        dw("diagram_create: no path", "diagram_create", json!({"project_id": "$p", "title": "Flow"})),
        dw(
            "diagram_create: a parameter it does not use",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("flow.drawio"), "owner_id": "x"}),
        ),
        dw(
            "diagram_create: a project that does not exist",
            "diagram_create",
            json!({"project_id": "nope", "title": "Flow", "path": f.path("flow.drawio")}),
        ),
        dw(
            "diagram_create: a relative path",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": "flow.drawio"}),
        ),
        dw(
            "diagram_create: a file that does not exist",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": "/no/such/flow.drawio"}),
        ),
        dw(
            "diagram_create: a folder",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("canvas")}),
        ),
        dw(
            "diagram_create: a file that is not a drawing",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("broken.drawio")}),
        ),
        dw(
            "diagram_create: a drawing with a DTD",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("dtd.drawio")}),
        ),
        dw(
            "diagram_create: a file over 2 MB",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("big.drawio")}),
        ),
        dw(
            "diagram_create: a file that is not UTF-8",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("latin1.drawio")}),
        ),
        dw(
            "diagram_create: an svg that does not exist",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("flow.drawio"), "svg_path": "/no/such.svg"}),
        ),
        dw(
            "diagram_create: an svg with a script",
            "diagram_create",
            json!({"project_id": "$p", "title": "Flow", "path": f.path("flow.drawio"), "svg_path": f.path("script.svg")}),
        ),
        dwk(
            "diagram_create: a drawing",
            "diagram_create",
            json!({"project_id": "$p", "title": "Request flow", "path": f.path("flow.drawio"), "summary": "Client to service"}),
            "dg1",
        ),
        dwk(
            "diagram_create: with its own svg",
            "diagram_create",
            json!({"project_id": "$p", "title": "[Own] svg\nname", "path": f.path("flow.drawio"), "svg_path": f.path("flow.svg")}),
            "dg2",
        ),
        dwk(
            "diagram_create: a drawing with a link to nothing",
            "diagram_create",
            json!({"project_id": "$p", "title": "Lonely", "path": f.path("lonely.drawio")}),
            "dg3",
        ),
        dwk(
            "diagram_create: in the other project",
            "diagram_create",
            json!({"project_id": "$p2", "title": "Away", "path": f.path("flow.drawio")}),
            "dg4",
        ),
        dr("diagrams: the list", "diagrams", json!({"project_id": "$p"})),
        dr("diagram: the model", "diagram", json!({"diagram_id": "$dg1"})),
        dr("diagram: a model with problems", "diagram", json!({"diagram_id": "$dg3"})),
        dr("diagram: an older version that does not exist", "diagram", json!({"diagram_id": "$dg1", "version": 2})),
        dr("diagram: to a file", "diagram", json!({"diagram_id": "$dg1", "path": format!("{out}/flow.drawio")})),
        dr("diagram: to a folder", "diagram", json!({"diagram_id": "$dg1", "path": format!("{out}/dir")})),
        dr(
            "diagram: to a folder that is not there with a slash",
            "diagram",
            json!({"diagram_id": "$dg2", "path": format!("{out}/new/")}),
        ),
        dr("diagram: to a relative path", "diagram", json!({"diagram_id": "$dg1", "path": "flow.drawio"})),
        dr(
            "diagram: to a place that cannot be written",
            "diagram",
            json!({"diagram_id": "$dg1", "path": format!("{}/x.drawio", f.path("pic.png"))}),
        ),
        dr("diagram: another project's", "diagram", json!({"diagram_id": "$dg4"})),
        dw("diagram_save: nothing else", "diagram_save", json!({})),
        dw(
            "diagram_save: no base_version",
            "diagram_save",
            json!({"diagram_id": "$dg1", "path": f.path("flow.drawio")}),
        ),
        dw(
            "diagram_save: a diagram that does not exist",
            "diagram_save",
            json!({"diagram_id": "dg_00000000", "path": f.path("flow.drawio"), "base_version": 1}),
        ),
        dw(
            "diagram_save: a stale version",
            "diagram_save",
            json!({"diagram_id": "$dg1", "path": f.path("flow.drawio"), "base_version": 5}),
        ),
        dw(
            "diagram_save: a file that is not a drawing",
            "diagram_save",
            json!({"diagram_id": "$dg1", "path": f.path("broken.drawio"), "base_version": 1}),
        ),
        dw(
            "diagram_save: a file that does not exist",
            "diagram_save",
            json!({"diagram_id": "$dg1", "path": "/no/such/flow.drawio", "base_version": 1}),
        ),
        dw(
            "diagram_save: a new version",
            "diagram_save",
            json!({"diagram_id": "$dg1", "path": f.path("flow2.drawio"), "base_version": 1}),
        ),
        dw(
            "diagram_save: with problems and a new name",
            "diagram_save",
            json!({"diagram_id": "$dg1", "path": f.path("lonely.drawio"), "base_version": 2, "title": "Request flow v3"}),
        ),
        dw(
            "diagram_save: with an svg",
            "diagram_save",
            json!({"diagram_id": "$dg2", "path": f.path("flow2.drawio"), "base_version": 1, "svg_path": f.path("flow.svg")}),
        ),
        dr("diagram: the new version", "diagram", json!({"diagram_id": "$dg1"})),
        dr("diagram: the first version", "diagram", json!({"diagram_id": "$dg1", "version": 1})),
        dw("diagram_delete: nothing else", "diagram_delete", json!({})),
        dw("diagram_delete: one that does not exist", "diagram_delete", json!({"diagram_id": "dg_00000000"})),
        dw("diagram_delete: a diagram", "diagram_delete", json!({"diagram_id": "$dg3"})),
        dw("diagram_delete: again", "diagram_delete", json!({"diagram_id": "$dg3"})),
        dr("diagram: a deleted one", "diagram", json!({"diagram_id": "$dg3"})),
        dr("diagrams: after the delete", "diagrams", json!({"project_id": "$p"})),
        dw("diagram_restore: a diagram", "diagram_restore", json!({"diagram_id": "$dg3"})),
        dw("diagram_restore: one that is not deleted", "diagram_restore", json!({"diagram_id": "$dg3"})),
        dw("diagram_restore: one that does not exist", "diagram_restore", json!({"diagram_id": "dg_00000000"})),
        dw("diagram_restore: nothing else", "diagram_restore", json!({})),
        dw(
            "page: a diagram in a page",
            "update",
            json!({"page_id": "$pg", "markdown": "## Flow\n\n[Request flow](diagram:$dg1)\n", "base_version": 1}),
        ),
        dr("page: the diagram is pinned", "get", json!({"page_id": "$pg"})),
    ]
}

fn sketch_calls(f: &Fixtures) -> Vec<Call> {
    let out = f.path("sk");
    vec![
        dr("sketches: none yet", "sketches", json!({"project_id": "$p"})),
        dr("sketches: nothing else", "sketches", json!({})),
        dr("sketch: nothing else", "sketch", json!({})),
        dr("sketch: no path", "sketch", json!({"sketch_id": "sk_00000000"})),
        dr("sketch: one that does not exist", "sketch", json!({"sketch_id": "sk_00000000", "path": out})),
        dw("sketch_create: nothing else", "sketch_create", json!({})),
        dw("sketch_create: no path", "sketch_create", json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot"})),
        dw(
            "sketch_create: an owner kind that is not one",
            "sketch_create",
            json!({"owner_kind": "idea", "owner_id": "x", "title": "Dot", "path": f.path("dot.png")}),
        ),
        dw(
            "sketch_create: an owner kind unknown",
            "sketch_create",
            json!({"owner_kind": "comment", "owner_id": "x", "title": "Dot", "path": f.path("dot.png")}),
        ),
        dw(
            "sketch_create: an owner that does not exist",
            "sketch_create",
            json!({"owner_kind": "ticket", "owner_id": "NOPE-1", "title": "Dot", "path": f.path("dot.png")}),
        ),
        dw(
            "sketch_create: a page that does not exist",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "nope", "title": "Dot", "path": f.path("dot.png")}),
        ),
        dw(
            "sketch_create: a file that does not exist",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": "/no/such.png"}),
        ),
        dw(
            "sketch_create: a relative path",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": "dot.png"}),
        ),
        dw(
            "sketch_create: not a picture",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": f.path("not.png")}),
        ),
        dw(
            "sketch_create: a picture over 10 MB",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": f.path("big.png")}),
        ),
        dw(
            "sketch_create: a source that is not a sketch",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": f.path("dot.png"), "source_path": f.path("bad.sketch.json")}),
        ),
        dw(
            "sketch_create: a source that does not exist",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": f.path("dot.png"), "source_path": "/no/such.json"}),
        ),
        dw(
            "sketch_create: a source of another size",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": f.path("dot.png"), "source_path": f.path("wide.sketch.json")}),
        ),
        dw(
            "sketch_create: a source with too many layers",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": f.path("dot.png"), "source_path": f.path("layers.sketch.json")}),
        ),
        dwk(
            "sketch_create: a picture",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "[Dot]\nsketch", "path": f.path("dot.png")}),
            "sk0",
        ),
        dwk(
            "sketch_create: a picture on a page",
            "sketch_create",
            json!({"owner_kind": "doc", "owner_id": "$pg", "title": "Dot", "path": f.path("dot.png")}),
            "sk1",
        ),
        dwk(
            "sketch_create: with its source on a ticket",
            "sketch_create",
            json!({"owner_kind": "ticket", "owner_id": "$t1", "title": "Dot with layers", "path": f.path("dot.png"), "source_path": f.path("dot.sketch.json")}),
            "sk2",
        ),
        dr("sketches: the list", "sketches", json!({"project_id": "$p"})),
        dr("sketches: a project that does not exist", "sketches", json!({"project_id": "nope"})),
        dr("sketch: to a folder", "sketch", json!({"sketch_id": "$sk2", "path": out})),
        dr("sketch: to a png path", "sketch", json!({"sketch_id": "$sk1", "path": format!("{out}/mine.png")})),
        dr("sketch: to a relative path", "sketch", json!({"sketch_id": "$sk1", "path": "mine.png"})),
        dr("sketch: to a folder with a slash", "sketch", json!({"sketch_id": "$sk1", "path": format!("{out}/fresh/")})),
        dw("sketch_save: nothing else", "sketch_save", json!({})),
        dw("sketch_save: no base_version", "sketch_save", json!({"sketch_id": "$sk1", "path": f.path("dot.png")})),
        dw(
            "sketch_save: one that does not exist",
            "sketch_save",
            json!({"sketch_id": "sk_00000000", "path": f.path("dot.png"), "base_version": 1}),
        ),
        dw(
            "sketch_save: a stale version",
            "sketch_save",
            json!({"sketch_id": "$sk1", "path": f.path("dot.png"), "base_version": 4}),
        ),
        dw(
            "sketch_save: a file that does not exist",
            "sketch_save",
            json!({"sketch_id": "$sk1", "path": "/no/such.png", "base_version": 1}),
        ),
        dw(
            "sketch_save: a new version",
            "sketch_save",
            json!({"sketch_id": "$sk1", "path": f.path("dot.png"), "base_version": 1, "title": "Dot v2"}),
        ),
        dw(
            "sketch_save: with its source",
            "sketch_save",
            json!({"sketch_id": "$sk2", "path": f.path("dot.png"), "base_version": 1, "source_path": f.path("dot.sketch.json")}),
        ),
        dw(
            "sketch_save: a source that is not a sketch",
            "sketch_save",
            json!({"sketch_id": "$sk2", "path": f.path("dot.png"), "base_version": 2, "source_path": f.path("bad.sketch.json")}),
        ),
        dr("sketches: after the saves", "sketches", json!({"project_id": "$p"})),
    ]
}

fn picture_calls(f: &Fixtures) -> Vec<Call> {
    let out = f.path("pic");
    vec![
        dr("picture: nothing", "picture", json!({})),
        dr("picture: two ids", "picture", json!({"diagram_id": "$dg1", "sketch_id": "$sk1"})),
        dr("picture: a parameter it does not use", "picture", json!({"diagram_id": "$dg1", "query": "x"})),
        dr("picture: a diagram that does not exist", "picture", json!({"diagram_id": "dg_00000000"})),
        dr("picture: a version that does not exist", "picture", json!({"diagram_id": "$dg1", "version": 9})),
        dr("picture: a sketch that does not exist", "picture", json!({"sketch_id": "sk_00000000"})),
        dr("picture: a canvas that does not exist", "picture", json!({"canvas_id": "cv_00000000"})),
        dr("picture: a relative path", "picture", json!({"path": "flow.drawio"})),
        dr("picture: a file that does not exist", "picture", json!({"path": "/no/such/flow.drawio"})),
        dr("picture: a file of a type it cannot draw", "picture", json!({"path": f.path("notes.txt")})),
        dr("picture: a folder without a page", "picture", json!({"path": f.path("nopage")})),
        dr("picture: a drawing that is not a drawing", "picture", json!({"path": f.path("broken.drawio")})),
        dr("picture: a diagram", "picture", json!({"diagram_id": "$dg1", "path": format!("{out}/diagram.png")})),
        dr(
            "picture: a diagram of the first version",
            "picture",
            json!({"diagram_id": "$dg1", "version": 1, "path": format!("{out}/v1")}),
        ),
        dr(
            "picture: a diagram with its own svg",
            "picture",
            json!({"diagram_id": "$dg2", "path": format!("{out}/own.png")}),
        ),
        dr("picture: a sketch", "picture", json!({"sketch_id": "$sk1", "path": format!("{out}/sketch.png")})),
        dr("picture: a sketch to a relative path", "picture", json!({"sketch_id": "$sk1", "path": "sketch.png"})),
        dr("picture: a local drawing", "picture", json!({"path": f.path("flow2.drawio")})),
        dr("picture: a local svg", "picture", json!({"path": f.path("flow.svg")})),
        dr("picture: a local svg at a width", "picture", json!({"path": f.path("flow.svg"), "width": 400})),
        dr("picture: a local page", "picture", json!({"path": f.path("flat/index.html")})),
        dr("picture: a frame folder", "picture", json!({"path": f.path("canvas/01-home")})),
        dr("picture: a frame folder at a width", "picture", json!({"path": f.path("canvas/02-detail"), "width": 390})),
        dr("picture: a frame folder of a tablet", "picture", json!({"path": f.path("canvas/03-notes")})),
    ]
}

#[tokio::test]
async fn docs_drawings_answer_as_python_does() {
    let s = common::start().await;
    let f = Fixtures::new();
    f.write("flow2.drawio", &super::drawio(&["Client", "API gateway", "Service", "Database"], ""));
    f.write("dtd.drawio", "<?xml version=\"1.0\"?><!DOCTYPE mxfile [<!ENTITY x \"y\">]><mxfile><diagram><mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel></diagram></mxfile>");
    f.write(
        "script.svg",
        "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script><rect width=\"10\" height=\"10\"/></svg>",
    );
    std::fs::write(f.path("latin1.drawio"), b"<mxfile><diagram><mxGraphModel><root><mxCell id=\"0\" value=\"caf\xe9\"/></root></mxGraphModel></diagram></mxfile>").expect("a file");
    f.write("big.drawio", &format!("<mxfile><!--{}--></mxfile>", " ".repeat(2 * 1024 * 1024)));
    let mut big = PNG.to_vec();
    big.resize(10 * 1024 * 1024 + 10, 0);
    std::fs::write(f.path("big.png"), big).expect("a file");
    f.write(
        "wide.sketch.json",
        &json!({"format": "kanban-sketch", "version": 1, "width": 5, "height": 5, "layers": [{"id": "a"}]}).to_string(),
    );
    let layers: Vec<_> = (0..11).map(|i| json!({"id": format!("l{i}")})).collect();
    f.write(
        "layers.sketch.json",
        &json!({"format": "kanban-sketch", "version": 1, "width": 1, "height": 1, "layers": layers}).to_string(),
    );
    let mut run = Run::new(s.mcp());
    run.run(setup()).await;
    run_with_files(&mut run, diagram_calls(&f)).await;
    run_with_files(&mut run, sketch_calls(&f)).await;
    run_with_files(&mut run, picture_calls(&f)).await;
    let pictures = std::env::temp_dir().join("kanban-pictures").to_string_lossy().into_owned();
    let folders = f.folders(&[(s.dir().to_string_lossy().into_owned(), "<dir>"), (pictures, "<pictures>")]);
    let got = finish(run, &folders);
    golden("mcp_tool_calls_docs_drawings.json", &got);
    let _ = call;
}
