//! `tests/test_debug_space.py`: the Debug Space of a ticket (the work log with kinds, attachments and links to a
//! branch and a test case), and uploading any file and serving it as a download.
//! `test_mcp_can_delete_work_log_and_is_validated` waits for the MCP tools.

mod common;

use common::id;
use serde_json::{Value, json};
use testkit::{Client, Resp, Server, skip_unless_available};

async fn _ticket(c: &Client) -> String {
    let p = c.post("/projects", json!({"name": "D", "prefix": "DBG", "color": "#123456"})).await.json();
    id(&c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": "t"})).await.json())
}

fn _entry(extra: Value) -> Value {
    let mut entry = json!({"author": "An", "role": "Developer", "note": "found it"});
    for (key, value) in extra.as_object().expect("extra fields") {
        entry[key] = value.clone();
    }
    entry
}

fn header(r: &Resp, name: &str) -> String {
    r.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

#[tokio::test]
async fn test_kind_role_and_note_are_validated() {
    if !skip_unless_available("test_kind_role_and_note_are_validated") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tid = _ticket(&c).await;
    let url = format!("/tickets/{tid}/work-log");
    assert_eq!(c.post(&url, _entry(json!({"kind": "weird"}))).await.status, 422);
    assert_eq!(c.post(&url, _entry(json!({"role": "Wizard"}))).await.status, 422);
    for note in ["", "   \n"] {
        let r = c.post(&url, _entry(json!({"note": note}))).await;
        assert!(r.status == 400 && r.detail().as_str().expect("detail").contains("Note"));
    }
    assert_eq!(c.post(&url, _entry(json!({"author": "  "}))).await.status, 400);
    assert_eq!(c.post(&url, _entry(json!({"note": "x".repeat(20001)}))).await.status, 400);
    let r = c.post(&url, _entry(json!({"note": "  padded  "}))).await;
    assert!(r.status == 200 && r.json()["work_log"][0]["note"] == "padded");

    let lid = id(&r.json()["work_log"][0]);
    assert_eq!(c.patch(&format!("{url}/{lid}"), json!({"kind": "weird"})).await.status, 422);
    assert_eq!(c.patch(&format!("{url}/{lid}"), json!({"note": " "})).await.status, 400);
    // nothing was changed by the rejected edits
    assert_eq!(c.get(&format!("/tickets/{tid}")).await.json()["work_log"][0]["note"], "padded");
}

#[tokio::test]
async fn test_links_must_point_at_real_branch_and_test_case() {
    if !skip_unless_available("test_links_must_point_at_real_branch_and_test_case") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tid = _ticket(&c).await;
    let url = format!("/tickets/{tid}/work-log");
    let r = c.post(&url, _entry(json!({"linked_branch": "fix/nope"}))).await;
    assert!(r.status == 400 && r.detail().as_str().expect("detail").contains("fix/nope"));
    let r = c.post(&url, _entry(json!({"linked_test_case": "TC-99"}))).await;
    assert!(r.status == 400 && r.detail().as_str().expect("detail").contains("TC-99"));

    c.post(&format!("/tickets/{tid}/branches"), json!({"name": "fix/jwt"})).await;
    let tc =
        c.post(&format!("/tickets/{tid}/test-cases"), json!({"title": "jwt"})).await.json()["test_cases"][0].clone();
    // a test case may be referenced by id, it is stored as its readable code
    let r = c.post(&url, _entry(json!({"linked_branch": "fix/jwt", "linked_test_case": tc["id"]}))).await;
    assert_eq!(r.status, 200);
    let e = r.json()["work_log"][0].clone();
    assert!(e["linked_branch"] == "fix/jwt" && e["linked_test_case"] == "TC-1");

    // "" clears a link; omitting it leaves it alone
    let lid = id(&e);
    let r = c.patch(&format!("{url}/{lid}"), json!({"note": "edited"})).await;
    assert_eq!(r.json()["work_log"][0]["linked_branch"], "fix/jwt");
    let r = c.patch(&format!("{url}/{lid}"), json!({"linked_branch": "", "linked_test_case": ""})).await;
    let e = r.json()["work_log"][0].clone();
    assert!(e["linked_branch"].is_null() && e["linked_test_case"].is_null());
}

#[tokio::test]
async fn test_attachments_are_validated_and_edit_sets_updated_at() {
    if !skip_unless_available("test_attachments_are_validated_and_edit_sets_updated_at") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tid = _ticket(&c).await;
    let url = format!("/tickets/{tid}/work-log");
    for bad in [
        json!([{"name": "a.txt", "url": "https://evil.example/a.txt"}]),
        json!([{"name": "a.txt", "url": "/uploads/../secret"}]),
        json!([{"name": "", "url": "/uploads/a.txt"}]),
        json!(["not-an-object"]),
    ] {
        let r = c.post(&url, _entry(json!({"attachments": bad}))).await;
        assert!(r.status == 400 || r.status == 422, "{bad}");
    }
    let good = json!([{"name": "trace.txt", "url": "/uploads/trace-1.txt", "size": 12, "type": "text/plain"}]);
    let r = c.post(&url, _entry(json!({"attachments": good}))).await;
    let e = r.json()["work_log"][0].clone();
    assert!(
        !e["attachments"][0]["id"].as_str().expect("id").is_empty()
            && e["attachments"][0]["url"] == "/uploads/trace-1.txt"
    );
    assert_eq!(e["updated_at"], e["at"]);
    let r = c.patch(&format!("{url}/{}", id(&e)), json!({"attachments": []})).await;
    let e2 = r.json()["work_log"][0].clone();
    assert!(
        e2["attachments"] == json!([])
            && e2["updated_at"].as_str().expect("updated_at") >= e["updated_at"].as_str().expect("updated_at")
    );
}

#[tokio::test]
async fn test_upload_any_file_and_serve_it_as_a_download() {
    if !skip_unless_available("test_upload_any_file_and_serve_it_as_a_download") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let r = c.upload("/uploads/files", "file", "trace log.txt", "text/plain", b"stack trace".to_vec(), &[]).await;
    assert_eq!(r.status, 201);
    let up = r.json();
    let url = up["url"].as_str().expect("url").to_string();
    assert!(up["name"] == "trace log.txt" && up["size"] == 11 && url.starts_with("/uploads/"));
    let got = c.get(&url).await;
    assert_eq!(got.body.as_ref(), b"stack trace");
    assert!(header(&got, "content-disposition").contains("attachment"));
    assert_eq!(header(&got, "x-content-type-options"), "nosniff");

    // ?name= offers the original file name instead of the stored one
    let named = c.get_query(&url, &[("name", "../trace log.txt")]).await;
    assert!(header(&named, "content-disposition").contains("trace%20log.txt")); // RFC 5987 form
    let bad = c.get_query(&url, &[("name", "a\r\nSet-Cookie: x=1")]).await;
    assert!(!header(&bad, "content-disposition").contains('\n') && bad.headers.get("set-cookie").is_none());

    // active content is never rendered inline in the app's origin
    let r = c
        .upload("/uploads/files", "file", "../evil.html", "text/html", b"<script>alert(1)</script>".to_vec(), &[])
        .await;
    assert!(r.status == 201 && !r.json()["url"].as_str().expect("url").contains(".."));
    let got = c.get(r.json()["url"].as_str().expect("url")).await;
    assert!(header(&got, "content-type").starts_with("application/octet-stream"));
    assert!(header(&got, "content-disposition").contains("attachment"));

    // images keep being shown inline
    let png = b"\x89PNG\r\n\x1a\n".to_vec();
    let r = c.upload("/uploads/images", "file", "a.png", "image/png", png, &[]).await;
    let got = c.get(r.json()["url"].as_str().expect("url")).await;
    assert!(header(&got, "content-type") == "image/png" && got.headers.get("content-disposition").is_none());
}

/// The Python test lowered `MAX_ATTACHMENT_BYTES` to 10 in process; a server has the real limit, 100 MB.
#[tokio::test]
async fn test_upload_size_limit() {
    if !skip_unless_available("test_upload_size_limit") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let limit = 100 * 1024 * 1024;
    let r = c.upload("/uploads/files", "file", "big.bin", "application/octet-stream", vec![b'x'; limit + 1], &[]).await;
    assert_eq!(r.status, 413);
    let r = c.upload("/uploads/files", "file", "ok.bin", "application/octet-stream", vec![b'x'; limit], &[]).await;
    assert_eq!(r.status, 201);
}
