//! `tests/test_diagram_mcp.py`, the file workflow through the Docs tools (an agent edits a `.drawio` file and saves it
//! back). The tests of the preview itself (`render_svg`, compressed pages, DTDs) are service tests, in
//! `kb-draw/tests/`; `test_operations_are_exported` is about the Python modules.

mod common;

use common::{call, call_err};
use serde_json::{Value, json};

/// `drawio(*labels)`.
fn drawio(labels: &[&str]) -> String {
    let cells: String = labels
        .iter()
        .enumerate()
        .map(|(i, label)| {
            format!(
                "<mxCell id=\"n{i}\" value=\"{label}\" style=\"rounded=1;fillColor=#E6F2EA;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"{}\" y=\"40\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell>",
                40 + 160 * i
            )
        })
        .collect();
    let edges: String = (0..labels.len().saturating_sub(1))
        .map(|i| {
            format!(
                "<mxCell id=\"e{i}\" value=\"{}\" style=\"endArrow=classic;\" edge=\"1\" parent=\"1\" source=\"n{i}\" target=\"n{}\"><mxGeometry relative=\"1\" as=\"geometry\"/></mxCell>",
                if i == 0 { "yes" } else { "" },
                i + 1
            )
        })
        .collect();
    format!(
        "<mxfile><diagram name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>{cells}{edges}</root></mxGraphModel></diagram></mxfile>"
    )
}

async fn project(c: &testkit::Client) -> Value {
    let made = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
    made.assert_status(201);
    made.json()["id"].clone()
}

fn folder() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("kbdiagram").tempdir().expect("a folder")
}

#[tokio::test]
async fn test_agent_edits_a_diagram_as_a_file() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await;
    let dir = folder();
    let src = dir.path().join("flow.drawio");
    std::fs::write(&src, drawio(&["Client", "Gateway"])).expect("a file");
    let made = call(
        &mcp,
        "docs_write",
        json!({"action": "diagram_create", "project_id": pid, "title": "Auth flow", "path": src.to_string_lossy(), "summary": "Two steps"}),
    )
    .await;
    let did = made["id"].as_str().expect("an id").to_string();
    assert!(made["markdown"] == format!("[Auth flow](diagram:{did})") && made["version"] == 1);
    let listed = call(&mcp, "docs_read", json!({"action": "diagrams", "project_id": pid})).await;
    let ids: Vec<&Value> = listed.as_array().expect("a list").iter().map(|d| &d["id"]).collect();
    assert_eq!(ids, [&json!(did)]);
    assert!(c.get(&format!("/diagrams/{did}/svg")).await.text().contains("Gateway"));

    // take it back to a folder, edit the file the way an agent would, save it
    let work = dir.path().join("work");
    let got = call(
        &mcp,
        "docs_read",
        json!({"action": "diagram", "diagram_id": did, "path": format!("{}/", work.to_string_lossy())}),
    )
    .await;
    assert!(got["path"].as_str().expect("a path").ends_with("Auth-flow.drawio") && got["version"] == 1);
    let file = work.join("Auth-flow.drawio");
    let text = std::fs::read_to_string(&file).expect("the file");
    assert_eq!(text, std::fs::read_to_string(&src).expect("the source"));
    let shape = "<mxCell id=\"x\" value=\"Cache\" style=\"shape=mxgraph.aws4.lambda;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"40\" y=\"200\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell>";
    std::fs::write(&file, text.replace("</root>", &format!("{shape}</root>"))).expect("an edit");
    let saved = call(
        &mcp,
        "docs_write",
        json!({"action": "diagram_save", "diagram_id": did, "path": got["path"], "base_version": got["version"]}),
    )
    .await;
    assert_eq!(saved["version"], 2);
    assert!(c.get(&format!("/diagrams/{did}/svg")).await.text().contains("Cache"));
    let full = c.get(&format!("/diagrams/{did}?source=true")).await.json();
    // anything draw.io can store is kept
    assert!(full["source"].as_str().expect("source").contains("mxgraph.aws4.lambda"));
    assert_eq!(c.get(&format!("/diagrams/{did}/versions")).await.json()[0]["note"], "Saved by an AI agent");

    // an older version can be exported too
    let v1 = dir.path().join("v1.drawio");
    let old = call(
        &mcp,
        "docs_read",
        json!({"action": "diagram", "diagram_id": did, "path": v1.to_string_lossy(), "version": 1}),
    )
    .await;
    assert!(
        !std::fs::read_to_string(&v1).expect("the file").contains("Cache")
            && old["path"].as_str().expect("a path").ends_with("v1.drawio")
    );

    // unlink and bring back
    call(&mcp, "docs_write", json!({"action": "diagram_delete", "diagram_id": did})).await;
    assert_eq!(call(&mcp, "docs_read", json!({"action": "diagrams", "project_id": pid})).await, json!([]));
    let restored = call(&mcp, "docs_write", json!({"action": "diagram_restore", "diagram_id": did})).await;
    assert_eq!(restored["version"], 2);
}

#[tokio::test]
async fn test_a_stale_base_version_is_refused_with_a_way_forward() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await;
    let dir = folder();
    let f = dir.path().join("a.drawio");
    std::fs::write(&f, drawio(&["A"])).expect("a file");
    let made = call(
        &mcp,
        "docs_write",
        json!({"action": "diagram_create", "project_id": pid, "title": "A", "path": f.to_string_lossy()}),
    )
    .await;
    let did = made["id"].clone();
    call(
        &mcp,
        "docs_write",
        json!({"action": "diagram_save", "diagram_id": did, "path": f.to_string_lossy(), "base_version": 1}),
    )
    .await;
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "diagram_save", "diagram_id": did, "path": f.to_string_lossy(), "base_version": 1}),
    )
    .await;
    assert!(refused.contains("Export the diagram again"), "{refused}");
}

#[tokio::test]
async fn test_the_agents_own_svg_is_used_as_the_preview() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await;
    let dir = folder();
    let (f, svg) = (dir.path().join("a.drawio"), dir.path().join("a.svg"));
    std::fs::write(&f, drawio(&["A"])).expect("a file");
    std::fs::write(
        &svg,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"5\" height=\"5\"><text>exact export</text></svg>",
    )
    .expect("a file");
    let made = call(
        &mcp,
        "docs_write",
        json!({"action": "diagram_create", "project_id": pid, "title": "A", "path": f.to_string_lossy(), "svg_path": svg.to_string_lossy()}),
    )
    .await;
    let did = made["id"].as_str().expect("an id");
    assert!(c.get(&format!("/diagrams/{did}/svg")).await.text().contains("exact export"));
}

#[tokio::test]
async fn test_bad_files_are_refused() {
    for (content, expected) in [
        ("not xml", "not valid XML"),
        ("<html/>", "not a draw.io file"),
        ("<!DOCTYPE x [<!ENTITY a \"b\">]><mxfile/>", "DTD"),
    ] {
        let s = common::start().await;
        let (mcp, c) = (s.mcp(), s.client());
        let pid = project(&c).await;
        let dir = folder();
        let f = dir.path().join("bad.drawio");
        std::fs::write(&f, content).expect("a file");
        let refused = call_err(
            &mcp,
            "docs_write",
            json!({"action": "diagram_create", "project_id": pid, "title": "Bad", "path": f.to_string_lossy()}),
        )
        .await;
        assert!(refused.contains(expected), "{content}: {refused}");
    }
}

#[tokio::test]
async fn test_paths_are_checked() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await;
    let dir = folder();
    let create = |path: String| json!({"action": "diagram_create", "project_id": pid, "title": "x", "path": path});
    assert!(call_err(&mcp, "docs_write", create("rel/flow.drawio".into())).await.contains("absolute path"));
    assert!(
        call_err(&mcp, "docs_write", create(dir.path().join("missing.drawio").to_string_lossy().into_owned()))
            .await
            .contains("not a file")
    );
    let big = dir.path().join("big.drawio");
    std::fs::write(&big, drawio(&["A"]).replacen('A', &"x".repeat(2_100_000), 1)).expect("a file");
    assert!(call_err(&mcp, "docs_write", create(big.to_string_lossy().into_owned())).await.contains("2 MB"));
    let binary = dir.path().join("b.drawio");
    std::fs::write(&binary, b"\xff\xfe\x00").expect("a file");
    assert!(call_err(&mcp, "docs_write", create(binary.to_string_lossy().into_owned())).await.contains("UTF-8"));
    let refused = call_err(
        &mcp,
        "docs_read",
        json!({"action": "diagram", "diagram_id": "dg_00000000", "path": dir.path().join("o.drawio").to_string_lossy()}),
    )
    .await;
    assert!(refused.contains("not found"), "{refused}");
    let refused = call_err(&mcp, "docs_write", json!({"action": "diagram_save", "diagram_id": "dg_00000000"})).await;
    assert!(refused.contains("requires"), "{refused}");
}
