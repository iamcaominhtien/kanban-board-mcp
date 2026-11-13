//! `tests/test_diagram_mcp.py`: what exercises the service functions of this crate. The Python tests go through
//! the MCP tools (`docs_write`, `docs_read`), which are ported with the MCP area; here the functions those tools call
//! (`create_from_file`, `save_from_file`, `export_to_file`, `list_for_agent`...) are called directly, on a database
//! of their own. Left out: `test_operations_are_exported` (the MCP operations), the "Export the diagram again" text
//! of `test_a_stale_base_version_is_refused_with_a_way_forward` and the `requires` check of `test_paths_are_checked`
//! (both are words of the MCP layer; the service's own 409 `diagram_conflict` is asserted instead).

mod common;

use std::path::Path;
use std::sync::Once;

use common::service::{project, run};
use common::{drawio, pack};
use kb_draw::{Error, diagram_model as dm, diagrams};
use serde_json::{Value, json};

static INIT: Once = Once::new();

/// No hidden browser in these tests (every test server sets this): the plain preview is what is stored.
#[allow(unsafe_code)]
fn init() {
    INIT.call_once(|| {
        // set before any test of this binary reads the environment
        unsafe { std::env::set_var("KANBAN_DIAGRAM_EXPORT", "off") };
    });
}

fn message<T: std::fmt::Debug>(result: Result<T, Error>) -> String {
    match result {
        Err(Error::Docs(e)) => e.message,
        other => panic!("expected a DocsError, got {other:?}"),
    }
}

async fn create(
    pid: &str,
    title: &str,
    path: &Path,
    svg: Option<&Path>,
) -> Result<serde_json::Map<String, Value>, Error> {
    let session = kb_db::session();
    let svg = svg.map(|p| p.to_string_lossy().into_owned());
    diagrams::create_from_file(&session, pid, title, &path.to_string_lossy(), svg.as_deref(), None).await
}

// --- the preview -----------------------------------------------------------------------------

#[test]
fn test_preview_is_a_valid_svg_with_every_label() {
    let svg =
        dm::render_svg(&drawio(&["Client", "API gateway", "Service &amp;amp; &amp;lt;db&amp;gt;"], "")).expect("svg");
    let clean = diagrams::sanitize_svg(&svg).expect("sanitized");
    for word in ["Client", "gateway", "yes", "&lt;db&gt;"] {
        assert!(clean.contains(word), "{word}");
    }
    assert!(clean.contains("marker-end"));
}

#[test]
fn test_preview_draws_every_basic_shape_and_unknown_ones_as_boxes() {
    let src = concat!(
        "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>",
        "<mxCell id=\"a\" value=\"O\" style=\"ellipse;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"0\" y=\"0\" width=\"80\" height=\"40\" as=\"geometry\"/></mxCell>",
        "<mxCell id=\"b\" value=\"D\" style=\"rhombus;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"100\" y=\"0\" width=\"80\" height=\"40\" as=\"geometry\"/></mxCell>",
        "<mxCell id=\"c\" value=\"C\" style=\"shape=cylinder3;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"200\" y=\"0\" width=\"80\" height=\"60\" as=\"geometry\"/></mxCell>",
        "<mxCell id=\"d\" value=\"L\" style=\"shape=mxgraph.aws4.lambda;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"300\" y=\"0\" width=\"80\" height=\"40\" as=\"geometry\"/></mxCell>",
        "</root></mxGraphModel>"
    );
    let svg = dm::render_svg(src).expect("svg");
    assert!(svg.contains("<ellipse") && svg.contains("<polygon") && svg.contains("<path"));
    assert_eq!(svg.matches("<rect").count(), 1);
}

#[test]
fn test_compressed_pages_are_read() {
    let inner = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"a\" value=\"Packed\" \
                 vertex=\"1\" parent=\"1\"><mxGeometry x=\"0\" y=\"0\" width=\"80\" height=\"40\" as=\"geometry\"/></mxCell></root></mxGraphModel>";
    let svg = dm::render_svg(&format!("<mxfile><diagram>{}</diagram></mxfile>", pack(inner))).expect("svg");
    assert!(svg.contains("Packed"));
}

#[test]
fn test_entities_and_doctype_are_refused() {
    let err =
        dm::render_svg("<!DOCTYPE x [<!ENTITY a \"b\">]><mxGraphModel><root/></mxGraphModel>").expect_err("refused");
    assert!(err.to_string().contains("XML"), "{err}");
}

// --- the file workflow, through the service functions the Docs tools call ---------------------

#[test]
fn test_agent_edits_a_diagram_as_a_file() {
    init();
    let tmp = tempfile::tempdir().expect("tempdir");
    let src = tmp.path().join("flow.drawio");
    std::fs::write(&src, drawio(&["Client", "Gateway"], "")).expect("write");
    run(async {
        let pid = project("agent files", "AGF").await;
        let session = kb_db::session();
        let session = &session;
        let made =
            diagrams::create_from_file(session, &pid, "Auth flow", &src.to_string_lossy(), None, Some("Two steps"))
                .await
                .expect("create");
        let did = made["id"].as_str().expect("id").to_string();
        assert_eq!(made["markdown"], json!(format!("[Auth flow](diagram:{did})")));
        assert_eq!(made["version"], 1);
        let listed = diagrams::list_for_agent(session, &pid).await.expect("list");
        assert_eq!(listed.iter().map(|d| d["id"].clone()).collect::<Vec<_>>(), vec![json!(did)]);
        assert_eq!(
            listed[0].as_object().expect("object").keys().collect::<Vec<_>>(),
            ["id", "label", "version", "updated_by", "updated_at", "summary"]
        );
        let svg = diagrams::read_file(session, &did, "svg", None).await.expect("svg").0;
        assert!(svg.contains("Gateway"));

        // take it back to a folder, edit the file the way an agent would, save it
        let work = format!("{}/", tmp.path().join("work").display());
        let got = diagrams::export_to_file(session, &did, &work, None).await.expect("export");
        let got_path = got["path"].as_str().expect("path").to_string();
        assert!(got_path.ends_with("Auth-flow.drawio") && got["version"] == 1, "{got:?}");
        let text = std::fs::read_to_string(tmp.path().join("work/Auth-flow.drawio")).expect("exported file");
        assert_eq!(text, std::fs::read_to_string(&src).expect("source"));
        let shape = "<mxCell id=\"x\" value=\"Cache\" style=\"shape=mxgraph.aws4.lambda;\" vertex=\"1\" parent=\"1\"><mxGeometry \
                     x=\"40\" y=\"200\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell>";
        std::fs::write(&got_path, text.replace("</root>", &format!("{shape}</root>"))).expect("edit");
        let saved = diagrams::save_from_file(session, &did, &got_path, 1, None, None).await.expect("save");
        assert_eq!(saved["version"], 2);
        assert!(diagrams::read_file(session, &did, "svg", None).await.expect("svg").0.contains("Cache"));
        let full = diagrams::get_diagram(session, &did, None, true).await.expect("get");
        // anything draw.io can store is kept
        assert!(full["source"].as_str().expect("source").contains("mxgraph.aws4.lambda"));
        let versions = diagrams::list_versions(session, &did).await.expect("versions");
        assert_eq!(versions[0]["note"], "Saved by an AI agent");

        // an older version can be exported too
        let v1 = tmp.path().join("v1.drawio");
        let old = diagrams::export_to_file(session, &did, &v1.to_string_lossy(), Some(1)).await.expect("export v1");
        assert!(!std::fs::read_to_string(&v1).expect("v1").contains("Cache"));
        assert!(old["path"].as_str().expect("path").ends_with("v1.drawio"));

        // unlink and bring back
        diagrams::delete_diagram(session, &did).await.expect("delete");
        assert!(diagrams::list_for_agent(session, &pid).await.expect("list").is_empty());
        let restored = diagrams::restore_diagram(session, &did).await.expect("restore");
        assert_eq!(restored["version"], 2);
    });
}

#[test]
fn test_a_stale_base_version_is_refused_with_a_way_forward() {
    init();
    let tmp = tempfile::tempdir().expect("tempdir");
    let f = tmp.path().join("a.drawio");
    std::fs::write(&f, drawio(&["A"], "")).expect("write");
    run(async {
        let pid = project("stale", "STA").await;
        let session = kb_db::session();
        let did = create(&pid, "A", &f, None).await.expect("create")["id"].as_str().expect("id").to_string();
        diagrams::save_from_file(&session, &did, &f.to_string_lossy(), 1, None, None).await.expect("save");
        // the conflict is answered before the file is read: a file that is gone gives the same answer
        std::fs::remove_file(&f).expect("remove");
        match diagrams::save_from_file(&session, &did, &f.to_string_lossy(), 1, None, None).await {
            Err(Error::Docs(e)) => {
                assert_eq!((e.status, e.code.as_str()), (409, "diagram_conflict"));
                assert_eq!(e.extra["latest_version"], 2);
                assert_eq!(e.message, "user saved a newer version while you were editing.");
            }
            other => panic!("expected the conflict, got {other:?}"),
        }
    });
}

#[test]
fn test_the_agents_own_svg_is_used_as_the_preview() {
    init();
    let tmp = tempfile::tempdir().expect("tempdir");
    let (f, s) = (tmp.path().join("a.drawio"), tmp.path().join("a.svg"));
    std::fs::write(&f, drawio(&["A"], "")).expect("write");
    std::fs::write(
        &s,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"5\" height=\"5\"><text>exact export</text></svg>",
    )
    .expect("write");
    run(async {
        let pid = project("own svg", "OWN").await;
        let did = create(&pid, "A", &f, Some(&s)).await.expect("create")["id"].as_str().expect("id").to_string();
        let session = kb_db::session();
        assert!(diagrams::read_file(&session, &did, "svg", None).await.expect("svg").0.contains("exact export"));
    });
}

#[test]
fn test_bad_files_are_refused() {
    init();
    for (content, wanted) in [
        ("not xml", "not valid XML"),
        ("<html/>", "not a draw.io file"),
        ("<!DOCTYPE x [<!ENTITY a \"b\">]><mxfile/>", "DTD"),
    ] {
        let tmp = tempfile::tempdir().expect("tempdir");
        let f = tmp.path().join("bad.drawio");
        std::fs::write(&f, content).expect("write");
        let said = run(async {
            let pid = project(&format!("bad {wanted}"), &format!("B{}", wanted.len())).await;
            message(create(&pid, "Bad", &f, None).await)
        });
        assert!(said.contains(wanted), "{content}: {said}");
    }
}

#[test]
fn test_paths_are_checked() {
    init();
    let tmp = tempfile::tempdir().expect("tempdir");
    run(async {
        let pid = project("paths", "PTH").await;
        let session = kb_db::session();
        let said = message(create(&pid, "x", Path::new("rel/flow.drawio"), None).await);
        assert!(said.contains("absolute path"), "{said}");
        let said = message(create(&pid, "x", &tmp.path().join("missing.drawio"), None).await);
        assert!(said.contains("not a file"), "{said}");
        let big = tmp.path().join("big.drawio");
        std::fs::write(&big, drawio(&["A"], "").replacen('A', &"x".repeat(2_100_000), 1)).expect("write");
        let said = message(create(&pid, "x", &big, None).await);
        assert!(said.contains("2 MB"), "{said}");
        let binary = tmp.path().join("b.drawio");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).expect("write");
        let said = message(create(&pid, "x", &binary, None).await);
        assert!(said.contains("UTF-8"), "{said}");
        let said = message(
            diagrams::export_to_file(&session, "dg_00000000", &tmp.path().join("o.drawio").to_string_lossy(), None)
                .await,
        );
        assert!(said.contains("not found"), "{said}");
        // a folder that cannot be written, an absolute path that is not one
        let said = message(diagrams::export_to_file(&session, "dg_00000000", "rel/o.drawio", None).await);
        assert!(said.contains("not found"), "{said}");
    });
}
