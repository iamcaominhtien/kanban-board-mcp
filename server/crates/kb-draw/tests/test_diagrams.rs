//! `tests/test_diagrams.py`, and one check per route of `api/diagrams.py` that both servers answer the same status and
//! JSON for the success case and for each error.
//!
//! Left out here: `test_docs_versions_pin_diagrams_and_restore_brings_them_back` goes through the Docs routes, which
//! are not served by Rust yet; its assertions on the service functions (`pin_versions`, `parse_pins`,
//! `restore_pins`) are in `tests/diagram_service.rs`.

mod common;

use common::{EMPTY, SOURCE, SVG, body, make, member, pack, pid};
use serde_json::{Value, json};
use testkit::{Options, Server, normalize, skip_unless_available};

const MAX_BYTES: usize = 2 * 1024 * 1024;

/// A `detail` of a `DocsError` answer without its `request_id`, which must be 12 hex characters.
fn detail(r: &testkit::Resp) -> Value {
    let mut d = r.detail();
    let id = d["request_id"].as_str().unwrap_or("").to_string();
    assert_eq!(id.len(), 12, "request_id of {d}");
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "request_id of {d}");
    assert_eq!(r.headers.get("x-request-id").and_then(|v| v.to_str().ok()), Some(id.as_str()));
    d.as_object_mut().expect("detail is an object").remove("request_id");
    d
}

/// The `(type, loc)` of each entry of a 422 validation list: Pydantic's wording differs, what is wrong and where does
/// not.
fn problems(detail: &Value) -> Vec<(String, Value)> {
    let list = detail.as_array().unwrap_or_else(|| panic!("a validation list, got {detail}"));
    list.iter().map(|e| (e["type"].as_str().unwrap_or("").to_string(), e["loc"].clone())).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_read_and_files() {
    if !skip_unless_available("test_create_read_and_files") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let d = make(&c, &pid, json!({"summary": "Gateway then service"})).await;
    let id = d["id"].as_str().expect("id");
    assert!(id.starts_with("dg_") && id.len() == 11);
    assert!(d["version"] == 1 && d["label"] == "Auth flow" && d["empty"] == false);
    let got = c.get(&format!("/diagrams/{id}?source=true")).await.json();
    assert_eq!(got["source"], SOURCE);
    assert!(c.get(&format!("/diagrams/{id}")).await.json().get("source").is_none());
    assert_eq!(got["summary"], "Gateway then service");
    assert_eq!(got["suggested_summary"], "Contains: Client, API gateway, yes.");
    let svg = c.get(&format!("/diagrams/{id}/svg")).await;
    let ct = svg.headers["content-type"].to_str().expect("content type").to_string();
    assert!(ct.starts_with("image/svg+xml"), "{ct}");
    assert!(svg.headers["content-security-policy"].to_str().expect("csp").contains("sandbox"));
    assert!(svg.text().contains("<rect"));
    let dl = c.get(&format!("/diagrams/{id}/download?format=drawio")).await;
    assert_eq!(dl.text(), SOURCE);
    assert!(dl.headers["content-disposition"].to_str().expect("disposition").contains("filename=\"Auth-flow.drawio\""));
    let dl = c.get(&format!("/diagrams/{id}/download?format=svg")).await;
    assert!(dl.headers["content-disposition"].to_str().expect("disposition").contains("filename=\"Auth-flow.svg\""));
}

#[tokio::test]
async fn test_empty_diagram_is_flagged() {
    if !skip_unless_available("test_empty_diagram_is_flagged") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let d = make(&c, &pid, json!({"source": EMPTY})).await;
    assert_eq!(d["empty"], true);
}

#[tokio::test]
async fn test_compressed_diagram_is_read() {
    if !skip_unless_available("test_compressed_diagram_is_read") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let inner = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>\
                 <mxCell id=\"2\" value=\"Packed\" vertex=\"1\" parent=\"1\"/></root></mxGraphModel>";
    let packed = format!("<mxfile><diagram>{}</diagram></mxfile>", pack(inner));
    let d = make(&c, &pid, json!({"source": packed})).await;
    assert_eq!(d["empty"], false);
    let id = d["id"].as_str().expect("id");
    assert_eq!(c.get(&format!("/diagrams/{id}")).await.json()["suggested_summary"], "Contains: Packed.");
}

#[tokio::test]
async fn test_invalid_files_are_rejected() {
    if !skip_unless_available("test_invalid_files_are_rejected") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    for bad in ["not xml", "<html/>", "<!DOCTYPE x [<!ENTITY a \"b\">]><mxfile/>"] {
        let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"source": bad}))).await;
        assert_eq!(r.status, 422, "{bad}");
        assert_eq!(r.json()["detail"]["code"], "invalid_diagram");
    }
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"svg": "<div/>"}))).await;
    assert_eq!(r.status, 422);
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"item_kind": "nope"}))).await;
    assert_eq!(r.status, 422);
    let r = c.post("/projects/missing/diagrams", body(json!({}))).await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn test_size_limit_has_a_clear_error() {
    if !skip_unless_available("test_size_limit_has_a_clear_error") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let big = SOURCE.replace("Client", &"x".repeat(MAX_BYTES + 10));
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"source": big}))).await;
    assert_eq!(r.status, 413);
    let detail = r.json()["detail"].clone();
    assert_eq!(detail["code"], "diagram_too_large");
    assert!(detail["message"].as_str().expect("message").contains("The limit is 2 MB"));
    assert_eq!(detail["limit_bytes"], MAX_BYTES);
}

#[tokio::test]
async fn test_svg_is_sanitized() {
    if !skip_unless_available("test_svg_is_sanitized") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let dirty = concat!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" onload=\"x()\">",
        "<script>alert(1)</script><a xlink:href=\"javascript:alert(1)\"><rect onclick=\"y()\" width=\"1\"/></a>",
        "<foreignObject><div xmlns=\"http://www.w3.org/1999/xhtml\">label</div></foreignObject></svg>"
    );
    let d = make(&c, &pid, json!({"svg": dirty})).await;
    let out = c.get(&format!("/diagrams/{}/svg", d["id"].as_str().expect("id"))).await.text();
    assert!(!out.contains("script") && !out.contains("onload") && !out.contains("onclick"), "{out}");
    assert!(!out.contains("javascript"));
    assert!(out.contains("label") && out.contains("<rect"));
}

#[tokio::test]
async fn test_update_creates_versions_and_detects_conflicts() {
    if !skip_unless_available("test_update_creates_versions_and_detects_conflicts") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let d = make(&c, &pid, json!({})).await;
    let id = d["id"].as_str().expect("id").to_string();
    let r = c
        .put(&format!("/diagrams/{id}"), json!({"base_version": 1, "source": EMPTY, "svg": SVG, "label": "Auth v2"}))
        .await;
    assert!(r.status == 200 && r.json()["version"] == 2);
    assert_eq!(r.json()["label"], "Auth v2");
    let stale = c.put(&format!("/diagrams/{id}"), json!({"base_version": 1, "source": SOURCE, "svg": SVG})).await;
    assert_eq!(stale.status, 409);
    let detail = stale.json()["detail"].clone();
    assert_eq!(detail["code"], "diagram_conflict");
    assert!(detail["latest_version"] == 2 && detail["latest_author"] == "user");
    let versions = c.get(&format!("/diagrams/{id}/versions")).await.json();
    let numbers: Vec<Value> = versions.as_array().expect("list").iter().map(|v| v["version"].clone()).collect();
    assert_eq!(numbers, vec![json!(2), json!(1)]);
    let old = c.get(&format!("/diagrams/{id}?version=1&source=true")).await.json();
    assert!(old["source"] == SOURCE && old["shown_version"] == 1);
    assert_eq!(c.get(&format!("/diagrams/{id}?version=9")).await.status, 404);
}

#[tokio::test]
async fn test_delete_only_unlinks_and_can_be_restored() {
    if !skip_unless_available("test_delete_only_unlinks_and_can_be_restored") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let d = make(&c, &pid, json!({})).await;
    let id = d["id"].as_str().expect("id").to_string();
    assert_eq!(c.delete(&format!("/diagrams/{id}")).await.status, 200);
    let r = c.get(&format!("/diagrams/{id}")).await;
    assert!(r.status == 404 && r.json()["detail"]["code"] == "diagram_not_found");
    assert_eq!(c.get(&format!("/projects/{pid}/diagrams")).await.json(), json!([]));
    let bin = c.get(&format!("/projects/{pid}/diagrams?deleted=true")).await.json();
    let ids: Vec<Value> = bin.as_array().expect("list").iter().map(|x| x["id"].clone()).collect();
    assert_eq!(ids, vec![json!(id)]);
    let back = c.post_empty(&format!("/diagrams/{id}/restore")).await;
    assert!(back.status == 200 && back.json()["deleted_at"].is_null());
    assert_eq!(c.get(&format!("/diagrams/{id}")).await.status, 200);
}

#[tokio::test]
async fn test_viewers_can_look_and_download_but_not_edit() {
    if !skip_unless_available("test_viewers_can_look_and_download_but_not_edit") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Vi", "viewer").await;
    let d = make(&c, &pid, json!({})).await;
    let id = d["id"].as_str().expect("id").to_string();
    let v = s.client().header("x-actor", "Vi");
    let r = v.get(&format!("/diagrams/{id}")).await;
    assert_eq!(r.status, 200);
    assert!(r.json()["role"] == "viewer" && r.json()["can_edit"] == false);
    assert_eq!(v.get(&format!("/diagrams/{id}/download")).await.status, 200);
    assert_eq!(v.get(&format!("/diagrams/{id}/svg")).await.status, 200);
    for r in [
        v.post(&format!("/projects/{pid}/diagrams"), body(json!({}))).await,
        v.put(&format!("/diagrams/{id}"), json!({"base_version": 1, "source": SOURCE, "svg": SVG})).await,
        v.delete(&format!("/diagrams/{id}")).await,
    ] {
        assert_eq!(r.status, 403);
        assert_eq!(r.json()["detail"]["code"], "read_only");
    }
}

#[tokio::test]
async fn test_members_can_add_and_edit() {
    if !skip_unless_available("test_members_can_add_and_edit") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Mia", "member").await;
    let m = s.client().header("x-actor", "Mia");
    let r = m.post(&format!("/projects/{pid}/diagrams"), body(json!({}))).await;
    assert!(r.status == 201 && r.json()["created_by"] == "Mia");
    let id = r.json()["id"].as_str().expect("id").to_string();
    let r = m.put(&format!("/diagrams/{id}"), json!({"base_version": 1, "source": SOURCE, "svg": SVG})).await;
    assert!(r.status == 200 && r.json()["updated_by"] == "Mia");
}

#[tokio::test]
async fn test_editor_setting_defaults_and_admin_only() {
    if !skip_unless_available("test_editor_setting_defaults_and_admin_only") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let got = c.get("/diagrams/settings").await.json();
    assert_eq!(got["mode"], "self-hosted");
    assert_eq!(got["effective_url"], "http://localhost:8080");
    assert_eq!(got["sends_drawings_to_third_party"], false);
    let r = c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": "https://draw.corp/"})).await;
    assert_eq!(r.json()["effective_url"], "https://draw.corp");
    let r = c.put("/diagrams/settings", json!({"mode": "public"})).await;
    assert_eq!(r.json()["effective_url"], "https://embed.diagrams.net");
    assert_eq!(r.json()["sends_drawings_to_third_party"], true);
    assert_eq!(c.put("/diagrams/settings", json!({"mode": "other"})).await.status, 422);
    assert_eq!(c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": "javascript:x"})).await.status, 422);
    member(&c, &pid, "Mia", "member").await;
    let r = s.client().header("x-actor", "Mia").put("/diagrams/settings", json!({"mode": "public"})).await;
    assert!(r.status == 403 && r.json()["detail"]["code"] == "admin_only");
}

#[test]
fn test_refs_in_finds_each_diagram_once() {
    let md = "[a](diagram:dg_0123abcd) ![b](diagram:dg_0123abcd) [c](diagram:dg_deadbeef) (diagram:zz)";
    assert_eq!(kb_draw::diagrams::refs_in(md), vec!["dg_0123abcd", "dg_deadbeef"]);
}

#[tokio::test]
async fn test_the_editor_check_says_when_no_self_hosted_editor_answers() {
    if !skip_unless_available("test_the_editor_check_says_when_no_self_hosted_editor_answers") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    // a port nothing listens on
    let free = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = free.local_addr().expect("addr").port();
    drop(free);
    c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": format!("http://127.0.0.1:{port}")})).await;
    let out = c.get("/diagrams/editor-check").await.json();
    assert_eq!(out, json!({"mode": "self-hosted", "url": format!("http://127.0.0.1:{port}"), "reachable": false}));
    let up = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let up_port = up.local_addr().expect("addr").port();
    c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": format!("http://127.0.0.1:{up_port}")})).await;
    assert_eq!(c.get("/diagrams/editor-check").await.json()["reachable"], true);
    drop(up);
    c.put("/diagrams/settings", json!({"mode": "public"})).await;
    assert_eq!(c.get("/diagrams/editor-check").await.json()["reachable"], true);
}

/// A draw.io editor shipped with the app (`desktop/scripts/fetch-drawio.sh`), as a tiny fake.
fn shipped_editor() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    let folder = tmp.path().join("drawio");
    std::fs::create_dir_all(folder.join("js")).expect("js folder");
    std::fs::write(folder.join("index.html"), "<!doctype html><title>Shipped editor</title>").expect("index");
    std::fs::write(folder.join("js/app.min.js"), "var App={};").expect("js");
    std::fs::write(folder.join("VERSION"), "32.6.9\n").expect("version");
    std::fs::write(tmp.path().join("secret.txt"), "not the editor's").expect("secret");
    tmp
}

async fn start_with_editor(tmp: &tempfile::TempDir) -> Server {
    Server::start_with(Options {
        env: vec![("KANBAN_DRAWIO_DIR".into(), tmp.path().join("drawio").to_string_lossy().into_owned())],
        ..Default::default()
    })
    .await
}

#[tokio::test]
async fn test_the_shipped_editor_is_served_and_is_the_default() {
    if !skip_unless_available("test_the_shipped_editor_is_served_and_is_the_default") {
        return;
    }
    let tmp = shipped_editor();
    let s = start_with_editor(&tmp).await;
    let c = s.client();
    let got = c.get("/diagrams/settings").await.json();
    assert!(got["mode"] == "built-in" && got["built_in_available"] == true);
    let editor = format!("{}/drawio", s.base_url());
    assert_eq!(got["effective_url"], json!(editor));
    assert_eq!(got["built_in_version"], "32.6.9");
    assert_eq!(got["sends_drawings_to_third_party"], false);
    assert_eq!(
        c.get("/diagrams/editor-check").await.json(),
        json!({"mode": "built-in", "url": editor, "reachable": true})
    );
    let page = c.get("/drawio/?embed=1&proto=json").await;
    assert!(page.status == 200 && page.text().contains("<title>Shipped editor</title>"));
    let js = c.get("/drawio/js/app.min.js").await;
    assert!(
        js.status == 200 && js.headers["content-type"].to_str().expect("content type").starts_with("text/javascript")
    );
    // nothing outside the editor's folder comes out (a normalised path may land on the UI's own fallback page)
    for escape in ["/drawio/../secret.txt", "/drawio/%2e%2e/secret.txt"] {
        assert!(!c.get(escape).await.text().contains("not the editor's"), "{escape}");
    }
    assert_eq!(c.get("/drawio/missing.js").await.status, 404);
}

#[tokio::test]
async fn test_a_chosen_editor_is_kept_and_built_in_needs_one() {
    if !skip_unless_available("test_a_chosen_editor_is_kept_and_built_in_needs_one") {
        return;
    }
    let tmp = shipped_editor();
    let s = start_with_editor(&tmp).await;
    let c = s.client();
    let r = c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": "https://draw.corp/"})).await;
    assert_eq!(r.json()["mode"], "self-hosted");
    assert_eq!(r.json()["effective_url"], "https://draw.corp");
    let r = c.put("/diagrams/settings", json!({"mode": "built-in"})).await;
    assert_eq!(r.json()["mode"], "built-in");
    assert_eq!(r.json()["effective_url"], json!(format!("{}/drawio", s.base_url())));
    // a self-hosted setting left at its default address means the built-in one
    let r = c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": ""})).await;
    assert_eq!(r.json()["mode"], "built-in");
}

#[tokio::test]
async fn test_without_a_shipped_editor_built_in_is_refused() {
    if !skip_unless_available("test_without_a_shipped_editor_built_in_is_refused") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let got = c.get("/diagrams/settings").await.json();
    assert!(got["mode"] == "self-hosted" && got["built_in_available"] == false);
    assert_eq!(c.get("/drawio/").await.status, 404);
    let r = c.put("/diagrams/settings", json!({"mode": "built-in"})).await;
    assert!(r.status == 422 && r.text().to_lowercase().contains("no built-in"));
}

// ---------------------------------------------------------------------------
// The same status and JSON on both servers, route by route (not in the Python suite)
// ---------------------------------------------------------------------------

/// A diagram as the routes return it, with the id of the diagram and the ids and times of the rest replaced.
fn read(d: &Value, expected: Value) -> Value {
    let id = d["id"].as_str().expect("id");
    assert!(id.len() == 11 && id.starts_with("dg_") && id[3..].chars().all(|c| c.is_ascii_hexdigit()), "{id}");
    let mut out = normalize(d);
    out["id"] = json!("<dg>");
    assert_eq!(out, expected);
    d.clone()
}

fn expected(label: &str, version: u32, shown: u32, empty: bool, role: &str, extra: Value) -> Value {
    let mut out = json!({
        "id": "<dg>", "project_id": "<uuid:1>", "label": label, "summary": "", "item_kind": null, "item_id": null,
        "version": version, "shown_version": shown, "empty": empty, "preview_kind": "editor", "created_by": "user",
        "created_at": "<time>", "updated_by": "user", "updated_at": "<time>", "deleted_at": null,
        "size_bytes": SOURCE.len(), "role": role, "can_edit": true,
    });
    for (k, v) in extra.as_object().expect("extra fields") {
        out[k] = v.clone();
    }
    out
}

#[tokio::test]
async fn post_and_list_diagrams_answer_the_same() {
    if !skip_unless_available("post_and_list_diagrams_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Vi", "viewer").await;

    // created: 201, the label cleaned, the summary cut, an item kept
    let r = c
        .post(
            &format!("/projects/{pid}/diagrams"),
            json!({"label": " [Auth]\nflow ", "source": SOURCE, "svg": SVG, "summary": "  S  ", "item_kind": "doc", "item_id": "p1"}),
        )
        .await;
    assert_eq!(r.status, 201);
    let made = read(
        &r.json(),
        expected("Auth flow", 1, 1, false, "admin", json!({"summary": "S", "item_kind": "doc", "item_id": "p1"})),
    );
    // the label falls back to "Diagram"
    let r = c.post(&format!("/projects/{pid}/diagrams"), json!({"label": "[]", "source": EMPTY, "svg": SVG})).await;
    assert_eq!(r.status, 201);
    read(&r.json(), expected("Diagram", 1, 1, true, "admin", json!({"size_bytes": EMPTY.len()})));
    let r = c.post(&format!("/projects/{pid}/diagrams"), json!({"source": SOURCE, "svg": SVG})).await;
    assert_eq!(r.json()["label"], "Diagram");

    // listed, newest change first, deleted ones apart
    let r = c.get(&format!("/projects/{pid}/diagrams")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json().as_array().expect("list").len(), 3);
    c.delete(&format!("/diagrams/{}", made["id"].as_str().expect("id"))).await.assert_status(200);
    assert_eq!(c.get(&format!("/projects/{pid}/diagrams")).await.json().as_array().expect("list").len(), 2);
    let r = c.get(&format!("/projects/{pid}/diagrams?deleted=true")).await;
    assert_eq!(r.json().as_array().expect("list").len(), 1);
    assert_eq!(r.json()[0]["can_edit"], false);
    for yes in ["1", "TRUE", "on", "y"] {
        let r = c.get(&format!("/projects/{pid}/diagrams?deleted={yes}")).await;
        assert_eq!(r.json().as_array().expect("list").len(), 1, "{yes}");
    }
    let r = c.get(&format!("/projects/{pid}/diagrams?deleted=maybe")).await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("bool_parsing".to_string(), json!(["query", "deleted"]))]);

    // the errors: no such project, a viewer, a bad file, an item kind, a body that is not one
    let r = c.get("/projects/missing/diagrams").await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), json!({"code": "project_not_found", "message": "Project not found"}));
    let r = c.post("/projects/missing/diagrams", body(json!({}))).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), json!({"code": "project_not_found", "message": "Project not found"}));
    let r = s.client().header("x-actor", "Vi").post(&format!("/projects/{pid}/diagrams"), body(json!({}))).await;
    assert_eq!(r.status, 403);
    assert_eq!(
        detail(&r),
        json!({"code": "read_only", "message": "Viewers can look at and download diagrams but cannot edit them."})
    );
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"item_kind": "nope"}))).await;
    assert_eq!(r.status, 422);
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_item", "message": "item_kind must be one of ('ticket', 'comment', 'doc')"})
    );
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"source": "not xml"}))).await;
    assert_eq!(r.status, 422);
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_diagram", "message": "The diagram file is not valid XML (syntax error: line 1, column 0)."})
    );
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"source": "<html/>"}))).await;
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_diagram", "message": "This is not a draw.io file (expected an <mxfile> or <mxGraphModel>)."})
    );
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"source": "<!DOCTYPE x><mxfile/>"}))).await;
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_diagram", "message": "The diagram file contains a DTD or entity declaration, which is not allowed."})
    );
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"svg": "<div/>"}))).await;
    assert_eq!(detail(&r), json!({"code": "invalid_diagram", "message": "The preview must be an SVG image."}));
    let r = c.post(&format!("/projects/{pid}/diagrams"), json!({"label": "x"})).await;
    assert_eq!(r.status, 422);
    // FastAPI lists every missing field; the Rust server names the first one
    assert_eq!(problems(&r.detail())[0], ("missing".to_string(), json!(["body", "source"])));
    // a request id that the caller sent comes back, cut to 64 characters
    let long = "r".repeat(80);
    let r = c.request("GET", "/projects/missing/diagrams", &[("x-request-id", &format!("  {long}  "))], None).await;
    assert_eq!(r.json()["detail"]["request_id"], json!("r".repeat(64)));
    assert_eq!(r.headers["x-request-id"].to_str().expect("header"), "r".repeat(64));
    // the size limit is a 413 with the numbers
    let big = SOURCE.replace("Client", &"x".repeat(MAX_BYTES + 10));
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"source": big}))).await;
    assert_eq!(r.status, 413);
    let d = detail(&r);
    assert_eq!(d["code"], "diagram_too_large");
    assert_eq!(d["part"], "source");
    assert_eq!(d["limit_bytes"], MAX_BYTES);
    assert_eq!(d["size_bytes"], big.len());
    assert!(d["message"].as_str().expect("message").starts_with("This diagram is 2.0 MB. The limit is 2 MB."));
    // the same for a preview
    let big_svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{}</text></svg>", "x".repeat(MAX_BYTES));
    let r = c.post(&format!("/projects/{pid}/diagrams"), body(json!({"svg": big_svg}))).await;
    assert_eq!(r.status, 413);
    assert_eq!(detail(&r)["part"], "preview");
}

#[tokio::test]
async fn settings_routes_answer_the_same() {
    if !skip_unless_available("settings_routes_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let base = json!({
        "mode": "self-hosted", "url": "", "effective_url": "http://localhost:8080",
        "default_self_hosted_url": "http://localhost:8080", "public_url": "https://embed.diagrams.net",
        "built_in_available": false, "built_in_version": null, "sends_drawings_to_third_party": false,
    });
    let r = c.get("/diagrams/settings").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json(), base);
    let r = c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": " https://draw.corp/x/ "})).await;
    assert_eq!(r.status, 200);
    let mut want = base.clone();
    want["url"] = json!("https://draw.corp/x/");
    want["effective_url"] = json!("https://draw.corp/x");
    assert_eq!(r.json(), want);
    assert_eq!(c.get("/diagrams/settings").await.json(), want);
    let r = c.put("/diagrams/settings", json!({"mode": "public", "url": null})).await;
    let mut public = base.clone();
    public["mode"] = json!("public");
    public["effective_url"] = json!("https://embed.diagrams.net");
    public["sends_drawings_to_third_party"] = json!(true);
    assert_eq!(r.json(), public);
    assert_eq!(
        c.get("/diagrams/editor-check").await.json(),
        json!({"mode": "public", "url": "https://embed.diagrams.net", "reachable": true})
    );

    // the errors
    let r = c.put("/diagrams/settings", json!({"mode": "other"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(detail(&r), json!({"code": "invalid_mode", "message": "mode must be built-in, self-hosted or public"}));
    let r = c.put("/diagrams/settings", json!({"mode": "built-in"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(
        detail(&r),
        json!({"code": "no_built_in_editor", "message": "This install has no built-in draw.io editor; choose self-hosted or public."})
    );
    for url in ["javascript:x", "ftp://x", "http://", "http:// x", "https://a b"] {
        let r = c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": url})).await;
        assert_eq!(r.status, 422, "{url}");
        assert_eq!(
            detail(&r),
            json!({"code": "invalid_url", "message": "The editor address must start with http:// or https://"}),
            "{url}"
        );
    }
    let r = c.put("/diagrams/settings", json!({})).await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("missing".to_string(), json!(["body", "mode"]))]);
    member(&c, &pid, "Mia", "member").await;
    let r = s.client().header("x-actor", "Mia").put("/diagrams/settings", json!({"mode": "public"})).await;
    assert_eq!(r.status, 403);
    assert_eq!(detail(&r), json!({"code": "admin_only", "message": "Only an admin can change where the editor runs."}));
    // the admin of a project may change it
    member(&c, &pid, "Ada", "admin").await;
    let r = s.client().header("x-actor", "ada").put("/diagrams/settings", json!({"mode": "public"})).await;
    assert_eq!(r.status, 200);
    // an unreachable self-hosted editor
    let free = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = free.local_addr().expect("addr").port();
    drop(free);
    c.put("/diagrams/settings", json!({"mode": "self-hosted", "url": format!("http://127.0.0.1:{port}/")})).await;
    assert_eq!(
        c.get("/diagrams/editor-check").await.json(),
        json!({"mode": "self-hosted", "url": format!("http://127.0.0.1:{port}"), "reachable": false})
    );
    // `/diagrams/settings` is also a diagram id for the methods the static routes do not serve
    let r = c.delete("/diagrams/settings").await;
    assert_eq!(r.status, 404);
    assert_eq!(
        detail(&r),
        json!({"code": "diagram_not_found", "message": "Diagram not found. It was deleted, or you do not have access."})
    );
    let r = c.delete("/diagrams/editor-check").await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn read_update_delete_routes_answer_the_same() {
    if !skip_unless_available("read_update_delete_routes_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Vi", "viewer").await;
    member(&c, &pid, "Mia", "member").await;
    let d = make(&c, &pid, json!({})).await;
    let id = d["id"].as_str().expect("id").to_string();
    let not_found = json!({"code": "diagram_not_found", "message": "Diagram not found. It was deleted, or you do not have access."});

    // read: the summary drafted from the labels, the source on request
    let r = c.get(&format!("/diagrams/{id}")).await;
    assert_eq!(r.status, 200);
    read(
        &r.json(),
        expected(
            "Auth flow",
            1,
            1,
            false,
            "admin",
            json!({"suggested_summary": "Contains: Client, API gateway, yes."}),
        ),
    );
    let r = c.get(&format!("/diagrams/{id}?source=1")).await;
    assert_eq!(r.json()["source"], SOURCE);
    // a viewer reads, and cannot edit
    let r = s.client().header("x-actor", "Vi").get(&format!("/diagrams/{id}")).await;
    assert_eq!(r.json()["role"], "viewer");
    assert_eq!(r.json()["can_edit"], false);
    // somebody who is not a member of the project reads as a viewer too
    let r = s.client().header("x-actor", "Stranger").get(&format!("/diagrams/{id}")).await;
    assert_eq!(r.json()["role"], "viewer");
    // the errors
    let r = c.get("/diagrams/dg_00000000").await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), not_found);
    let r = c.get(&format!("/diagrams/{id}?version=9")).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), json!({"code": "version_not_found", "message": "Diagram version 9 not found"}));
    let r = c.get(&format!("/diagrams/{id}?version=abc")).await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("int_parsing".to_string(), json!(["query", "version"]))]);
    let r = c.get(&format!("/diagrams/{id}?source=x")).await;
    assert_eq!(problems(&r.detail()), vec![("bool_parsing".to_string(), json!(["query", "source"]))]);

    // update: a new version, the label and summary changed
    let r = c
        .put(
            &format!("/diagrams/{id}"),
            json!({"base_version": 1, "source": EMPTY, "svg": SVG, "label": "V2", "summary": " Two "}),
        )
        .await;
    assert_eq!(r.status, 200);
    let mut two = expected("V2", 2, 2, true, "admin", json!({"summary": "Two", "size_bytes": EMPTY.len()}));
    two["updated_by"] = json!("user");
    read(&r.json(), two);
    let r = s
        .client()
        .header("x-actor", "Mia")
        .put(&format!("/diagrams/{id}"), json!({"base_version": 2, "source": SOURCE, "svg": SVG}))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["updated_by"], "Mia");
    assert_eq!(r.json()["role"], "member");
    // the same when the label is given empty
    let r =
        c.put(&format!("/diagrams/{id}"), json!({"base_version": 3, "source": SOURCE, "svg": SVG, "label": ""})).await;
    assert_eq!(r.json()["label"], "Diagram");
    // the errors
    let r = c.put(&format!("/diagrams/{id}"), json!({"base_version": 1, "source": SOURCE, "svg": SVG})).await;
    assert_eq!(r.status, 409);
    let d = r.detail();
    assert_eq!(d["code"], "diagram_conflict");
    assert_eq!(d["message"], "user saved a newer version while you were editing.");
    assert_eq!(d["latest_version"], 4);
    assert_eq!(d["latest_author"], "user");
    assert!(d["latest_at"].as_str().expect("latest_at").contains('T'));
    let r = s
        .client()
        .header("x-actor", "Vi")
        .put(&format!("/diagrams/{id}"), json!({"base_version": 4, "source": SOURCE, "svg": SVG}))
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["detail"]["code"], "read_only");
    let r = c.put(&format!("/diagrams/{id}"), json!({"base_version": 4, "source": "nope", "svg": SVG})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json()["detail"]["code"], "invalid_diagram");
    let r = c.put("/diagrams/dg_00000000", json!({"base_version": 1, "source": SOURCE, "svg": SVG})).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), not_found);
    let r = c.put(&format!("/diagrams/{id}"), json!({"source": SOURCE, "svg": SVG})).await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("missing".to_string(), json!(["body", "base_version"]))]);

    // versions: newest first, with what each says
    let r = c.get(&format!("/diagrams/{id}/versions")).await;
    assert_eq!(r.status, 200);
    let list = r.json();
    let list = list.as_array().expect("list");
    assert_eq!(list.len(), 4);
    assert_eq!(list[0]["version"], 4);
    assert_eq!(list[0]["author"], "user");
    assert_eq!(list[0]["note"], Value::Null);
    assert_eq!(list[1]["author"], "Mia");
    assert_eq!(list[3]["size_bytes"], SOURCE.len());
    assert_eq!(
        normalize(&list[3]),
        json!({"version": 1, "author": "user", "note": null, "created_at": "<time>", "size_bytes": SOURCE.len()})
    );
    let r = c.get("/diagrams/dg_00000000/versions").await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), not_found);

    // delete: unlinked, kept; a viewer may not; a second delete finds nothing
    let r = s.client().header("x-actor", "Vi").delete(&format!("/diagrams/{id}")).await;
    assert_eq!(r.status, 403);
    let r = c.delete(&format!("/diagrams/{id}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(normalize(&r.json()), json!({"id": id, "deleted_at": "<time>"}));
    let r = c.delete(&format!("/diagrams/{id}")).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), not_found);
    assert_eq!(c.get(&format!("/diagrams/{id}/svg")).await.status, 404);
    assert_eq!(c.get(&format!("/diagrams/{id}/download")).await.status, 404);

    // restore: back, with its versions; unknown ones are 404; a viewer may not
    let r = s.client().header("x-actor", "Vi").post_empty(&format!("/diagrams/{id}/restore")).await;
    assert_eq!(r.status, 403);
    let r = c.post_empty(&format!("/diagrams/{id}/restore")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["deleted_at"], Value::Null);
    assert_eq!(r.json()["version"], 4);
    let r = c.post_empty("/diagrams/dg_00000000/restore").await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), not_found);
}

#[tokio::test]
async fn svg_and_download_routes_answer_the_same() {
    if !skip_unless_available("svg_and_download_routes_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let d = make(&c, &pid, json!({"label": "Ünï flow/2"})).await;
    let id = d["id"].as_str().expect("id").to_string();
    c.put(&format!("/diagrams/{id}"), json!({"base_version": 1, "source": EMPTY, "svg": SVG})).await.assert_status(200);
    let header =
        |r: &testkit::Resp, name: &str| r.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();

    let r = c.get(&format!("/diagrams/{id}/svg")).await;
    assert_eq!(r.status, 200);
    // stored the way ElementTree writes it: an empty element is `<rect ... />`
    assert_eq!(
        r.text(),
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\" /></svg>"
    );
    assert_eq!(header(&r, "content-type"), "image/svg+xml");
    assert_eq!(header(&r, "content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert_eq!(header(&r, "x-content-type-options"), "nosniff");
    assert_eq!(header(&r, "cache-control"), "private, max-age=0, must-revalidate");
    assert_eq!(header(&r, "content-disposition"), "");
    let r = c.get(&format!("/diagrams/{id}/svg?version=1")).await;
    assert_eq!(r.status, 200);
    let r = c.get(&format!("/diagrams/{id}/svg?version=3")).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), json!({"code": "version_not_found", "message": "Diagram version 3 not found"}));

    let r = c.get(&format!("/diagrams/{id}/download")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), EMPTY);
    assert_eq!(header(&r, "content-type"), "application/vnd.jgraph.mxfile");
    assert_eq!(header(&r, "content-disposition"), "attachment; filename=\"n-flow-2.drawio\"");
    assert_eq!(header(&r, "access-control-expose-headers"), "Content-Disposition");
    assert_eq!(header(&r, "content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    let r = c.get(&format!("/diagrams/{id}/download?format=svg&version=1")).await;
    assert_eq!(header(&r, "content-type"), "image/svg+xml");
    assert_eq!(header(&r, "content-disposition"), "attachment; filename=\"n-flow-2.svg\"");
    let r = c.get(&format!("/diagrams/{id}/download?format=whatever&version=1")).await;
    assert_eq!(r.text(), SOURCE);
    assert_eq!(header(&r, "content-type"), "application/vnd.jgraph.mxfile");
    let r = c.get("/diagrams/dg_00000000/download").await;
    assert_eq!(r.status, 404);
    let r = c.get(&format!("/diagrams/{id}/download?version=x")).await;
    assert_eq!(r.status, 422);
}
