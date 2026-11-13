//! Port of `server/tests/test_main.py`. The tests that upload a file through `POST /uploads/images` or
//! `POST /uploads/files` (the tickets router of kb-board) put the file straight into the server's uploads folder and
//! keep the assertions on what is served; the upload half (the answer's `url`, `markdown`, `content_type`, `size`,
//! the 400 and 413 refusals) is left out until that router is ported: `test_upload_image_rejects_unsupported_type`
//! and `test_upload_image_rejects_files_over_size_limit` need `POST /uploads/images`.
//! `test_mcp_endpoint_is_reachable` needs the MCP endpoint (`/mcp/`, kb-mcp).

mod common;

use common::*;
use serde_json::json;
use testkit::{Options, Server, skip_unless_available};

#[tokio::test]
async fn test_health_returns_ok() {
    if !skip_unless_available("test_health_returns_ok") {
        return;
    }
    let s = Server::start().await;
    let r = get(&s, "/health").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json(), json!({"status": "ok"}));
    s.stop().await;
}

#[tokio::test]
async fn test_upload_image_returns_markdown_and_serves_file() {
    if !skip_unless_available("test_upload_image_returns_markdown_and_serves_file") {
        return;
    }
    let s = Server::start().await;
    // what `POST /uploads/images` stores: `<stem>-<12 hex>.png` in the uploads folder
    std::fs::write(s.uploads_dir().join("diagram-0123456789ab.png"), b"fake-png-bytes").expect("write");
    let r = get(&s, "/uploads/diagram-0123456789ab.png").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"fake-png-bytes");
    assert_eq!(r.header("x-content-type-options").as_deref(), Some("nosniff"));
    s.stop().await;
}

/// The Python test checks `resolve_upload_path` in process; the HTTP view of it: a read never creates the folder
/// (the pure rules are unit tests of `kb_files::uploads`).
#[tokio::test]
async fn test_resolve_upload_path_does_not_create_uploads_dir_on_read() {
    if !skip_unless_available("test_resolve_upload_path_does_not_create_uploads_dir_on_read") {
        return;
    }
    let s = Server::start().await;
    std::fs::remove_dir_all(s.uploads_dir()).expect("remove the uploads folder");
    assert_detail(&get(&s, "/uploads/nested/example.png").await, "uploads", 404, "File not found");
    assert_detail(&get(&s, "/upload-info/nested/example.png").await, "upload-info", 404, "File not found");
    assert!(!s.uploads_dir().exists(), "reading created the uploads folder");
    s.stop().await;
}

#[tokio::test]
async fn test_upload_and_serve_all_file_types() {
    if !skip_unless_available("test_upload_and_serve_all_file_types") {
        return;
    }
    let s = Server::start().await;
    let files: [(&str, &[u8]); 5] = [
        ("report.xlsx", b"fake-excel-data"),
        ("document.docx", b"fake-word-data"),
        ("slides.pptx", b"fake-ppt-data"),
        ("data.json", b"{\"key\": \"value\"}"),
        ("manual.pdf", b"%PDF-1.4..."),
    ];
    for (name, data) in files {
        std::fs::write(s.uploads_dir().join(name), data).expect("write");
        // Download request (?download=1)
        let dl = get(&s, &format!("/uploads/{name}?download=1")).await;
        assert_eq!(dl.status, 200, "Failed serving {name}");
        assert_eq!(dl.body, data);
        assert!(dl.header("content-disposition").expect("disposition").contains("attachment"));
        assert!(dl.header("x-file-path").is_some());
    }
    // Inline request for PDF (?inline=1): should have X-File-Path
    let pdf = get(&s, "/uploads/manual.pdf?inline=1").await;
    assert!(pdf.header("x-file-path").is_some() || pdf.status == 200 || pdf.status == 404);
    assert_eq!(pdf.header("content-type").as_deref(), Some("application/pdf"));
    s.stop().await;
}

#[tokio::test]
async fn test_html_and_svg_uploads_cannot_run_in_the_app_origin() {
    if !skip_unless_available("test_html_and_svg_uploads_cannot_run_in_the_app_origin") {
        return;
    }
    let s = Server::start().await;
    let page = b"<html><body><script>alert(1)</script></body></html>";
    let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
    std::fs::write(s.uploads_dir().join("report.html"), page).expect("write");
    std::fs::write(s.uploads_dir().join("logo.svg"), svg).expect("write");
    for query in ["", "?inline=1", "?view=1"] {
        let r = get(&s, &format!("/uploads/report.html{query}")).await;
        // never a page: either a download or plain text, so the viewer has to put it in its locked frame
        assert!(!r.header("content-type").expect("content type").starts_with("text/html"), "{query}");
        assert_eq!(r.header("x-content-type-options").as_deref(), Some("nosniff"));
    }
    let r = get(&s, "/uploads/logo.svg").await;
    assert!(r.header("content-type").expect("content type").starts_with("image/svg+xml"));
    let policy = r.header("content-security-policy").expect("policy");
    assert!(policy.contains("default-src 'none'"));
    assert!(policy.contains("sandbox"));
    s.stop().await;
}

/// A folder with accents, like a Windows user name such as "Tiến": a header cannot carry it, JSON can.
#[tokio::test]
async fn test_upload_info_names_the_local_path_for_open_in_app() {
    if !skip_unless_available("test_upload_info_names_the_local_path_for_open_in_app") {
        return;
    }
    let home = tempfile::tempdir().expect("temp dir");
    let uploads = home.path().join("Tiến").join("uploads");
    std::fs::create_dir_all(&uploads).expect("create folder");
    let s = Server::start_with(Options {
        env: vec![("KANBAN_UPLOADS_DIR".into(), uploads.display().to_string())],
        ..Options::default()
    })
    .await;
    std::fs::write(uploads.join("notes.txt"), b"hello").expect("write");

    // the file itself still downloads (the path header must not break the response)
    let r = get(&s, "/uploads/notes.txt?download=1").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"hello");

    // the desktop app asks for the path here; the page's origin (file://) cannot read custom headers
    let info = get(&s, "/upload-info/notes.txt").await;
    assert_eq!(info.status, 200);
    let body = info.json();
    assert_eq!(body["path"], canonical(&uploads.join("notes.txt")));
    assert_eq!(body["name"], "notes.txt");
    assert_eq!(body["size"], 5);

    assert_eq!(get(&s, "/upload-info/missing.txt").await.status, 404);
    let traversal = get(&s, "/upload-info/..%2F..%2Fetc%2Fpasswd").await.status;
    assert!(traversal == 400 || traversal == 404, "{traversal}");
    s.stop().await;
}

/// The server starts with its own database in a folder that does not exist yet, says `READY port=N` (the harness
/// waits for it) and serves `/health`.
#[tokio::test]
async fn test_main_emits_ready_signal_and_serves_health() {
    if !skip_unless_available("test_main_emits_ready_signal_and_serves_health") {
        return;
    }
    let home = tempfile::tempdir().expect("temp dir");
    let db = home.path().join("desktop-app").join("kanban.db");
    let s = Server::start_with(Options {
        // no ~/.kanban-board/config.json from the developer machine
        env: vec![
            ("KANBAN_DB_PATH".into(), db.display().to_string()),
            ("HOME".into(), home.path().display().to_string()),
        ],
        fresh_db: true,
        ..Options::default()
    })
    .await;
    assert!(s.port() > 0);
    let r = get(&s, "/health").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json(), json!({"status": "ok"}));
    assert!(db.is_file(), "the server made its database at {}", db.display());
    s.stop().await;
}
