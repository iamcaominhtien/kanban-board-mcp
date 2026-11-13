//! The draw.io editor shipped with the app, served at `/drawio` (`main.py`: `drawio_root`, `serve_drawio`, not in the
//! OpenAPI schema), and the bundle's own functions (`services/drawio_bundle.py`).

mod common;

use common::*;
use serde_json::json;
use std::path::Path;
use testkit::{Options, Server, skip_unless_available};

/// A folder that looks like a fetched draw.io editor.
fn editor() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    let p = dir.path();
    put_fixed(p, "index.html", b"<html>draw</html>");
    put_fixed(p, "js/app.min.js", b"var a=1;");
    put_fixed(p, "styles/a.css", b"a{}");
    put_fixed(p, "images/x.png", b"\x89PNG");
    put_fixed(p, "x.map", b"{}");
    put_fixed(p, "sub/index.html", b"<html>sub</html>");
    put_fixed(p, "VERSION", b"24.0.1\n");
    dir
}

async fn server_with_editor(folder: &Path) -> Server {
    Server::start_with(Options {
        env: vec![("KANBAN_DRAWIO_DIR".into(), folder.display().to_string())],
        ..Options::default()
    })
    .await
}

fn cached(size: usize, content_type: &str) -> Vec<(&'static str, String)> {
    vec![
        ("accept-ranges", "bytes".to_string()),
        ("cache-control", "public, max-age=3600".to_string()),
        ("content-length", size.to_string()),
        ("content-type", content_type.to_string()),
        ("etag", etag(size).to_string()),
        ("last-modified", LAST_MODIFIED.to_string()),
    ]
}

fn assert_file(reply: &Reply, label: &str, size: usize, content_type: &str, body: &[u8]) {
    assert_eq!(reply.status, 200, "{label}: {}", reply.text());
    let want = cached(size, content_type);
    let want: Vec<(&str, &str)> = want.iter().map(|(k, v)| (*k, v.as_str())).collect();
    assert_headers(reply, label, &want);
    assert_eq!(reply.body, body, "{label}: body");
}

#[tokio::test]
async fn the_editor_folder_redirects_to_its_slash_form() {
    if !skip_unless_available("the_editor_folder_redirects_to_its_slash_form") {
        return;
    }
    // with or without an editor in this install
    let none = Server::start().await;
    let folder = editor();
    let with = server_with_editor(folder.path()).await;
    for s in [&none, &with] {
        let r = get(s, "/drawio").await;
        assert_eq!(r.status, 307);
        assert_headers(&r, "GET /drawio", &[("content-length", "0"), ("location", "/drawio/")]);
        assert!(r.body.is_empty());
    }
    none.stop().await;
    with.stop().await;
}

#[tokio::test]
async fn an_install_without_the_editor_answers_404() {
    if !skip_unless_available("an_install_without_the_editor_answers_404") {
        return;
    }
    // the harness points KANBAN_DRAWIO_DIR at a folder that does not exist
    let s = Server::start().await;
    for uri in ["/drawio/", "/drawio/x.js", "/drawio/js/app.min.js", "/drawio/%00"] {
        assert_detail(&get(&s, uri).await, uri, 404, "No draw.io editor in this install");
    }
    s.stop().await;
}

#[tokio::test]
async fn editor_files_are_served_with_their_type_and_a_cache_header() {
    if !skip_unless_available("editor_files_are_served_with_their_type_and_a_cache_header") {
        return;
    }
    let folder = editor();
    let s = server_with_editor(folder.path()).await;
    assert_file(&get(&s, "/drawio/").await, "/drawio/", 17, "text/html; charset=utf-8", b"<html>draw</html>");
    assert_file(
        &get(&s, "/drawio/index.html").await,
        "index.html",
        17,
        "text/html; charset=utf-8",
        b"<html>draw</html>",
    );
    assert_file(&get(&s, "/drawio/js/app.min.js").await, "js", 8, "text/javascript; charset=utf-8", b"var a=1;");
    assert_file(&get(&s, "/drawio/styles/a.css").await, "css", 3, "text/css; charset=utf-8", b"a{}");
    assert_file(&get(&s, "/drawio/images/x.png").await, "png", 4, "image/png", b"\x89PNG");
    // a type the table does not name is guessed from the name, and text/plain when that fails
    assert_file(&get(&s, "/drawio/x.map").await, "map", 2, "text/plain; charset=utf-8", b"{}");
    assert_file(&get(&s, "/drawio/VERSION").await, "VERSION", 7, "text/plain; charset=utf-8", b"24.0.1\n");
    // a folder answers with its own index
    assert_file(&get(&s, "/drawio/sub").await, "sub", 16, "text/html; charset=utf-8", b"<html>sub</html>");
    assert_file(&get(&s, "/drawio/sub/").await, "sub/", 16, "text/html; charset=utf-8", b"<html>sub</html>");
    s.stop().await;
}

#[tokio::test]
async fn the_type_table_is_the_apps_not_the_platforms() {
    if !skip_unless_available("the_type_table_is_the_apps_not_the_platforms") {
        return;
    }
    let folder = editor();
    let table = [
        ("t.html", "text/html; charset=utf-8"),
        ("t.js", "text/javascript; charset=utf-8"),
        ("T.JS", "text/javascript; charset=utf-8"),
        ("t.css", "text/css; charset=utf-8"),
        ("t.json", "application/json"),
        ("t.svg", "image/svg+xml"),
        ("t.png", "image/png"),
        ("t.gif", "image/gif"),
        ("t.jpg", "image/jpeg"),
        ("t.ico", "image/x-icon"),
        ("t.txt", "text/plain; charset=utf-8"),
        ("t.xml", "application/xml"),
        ("t.woff", "font/woff"),
        ("t.woff2", "font/woff2"),
        ("t.ttf", "font/ttf"),
    ];
    for (name, _) in table {
        put_fixed(folder.path(), name, b"x");
    }
    let s = server_with_editor(folder.path()).await;
    for (name, content_type) in table {
        assert_file(&get(&s, &format!("/drawio/{name}")).await, name, 1, content_type, b"x");
    }
    s.stop().await;
}

#[tokio::test]
async fn what_is_not_a_file_inside_the_editor_folder_is_404() {
    if !skip_unless_available("what_is_not_a_file_inside_the_editor_folder_is_404") {
        return;
    }
    let folder = editor();
    let s = server_with_editor(folder.path()).await;
    for uri in [
        "/drawio/nope",
        "/drawio/js",
        "/drawio/js/",
        "/drawio/..%2f..%2fx",
        "/drawio/..%2f",
        "/drawio//etc/passwd",
        "/drawio/sub/..%2f..%2f..%2fetc%2fpasswd",
    ] {
        assert_detail(&get(&s, uri).await, uri, 404, "Not found");
    }
    // a NUL in the path is an error nothing catches
    let r = get(&s, "/drawio/%00").await;
    assert_eq!(r.status, 500);
    assert_eq!(r.text(), "Internal Server Error");
    assert_headers(&r, "NUL", &[("content-length", "21"), ("content-type", "text/plain; charset=utf-8")]);
    s.stop().await;
}

#[tokio::test]
async fn a_link_out_of_the_editor_folder_is_not_followed() {
    if !skip_unless_available("a_link_out_of_the_editor_folder_is_not_followed") {
        return;
    }
    let folder = editor();
    let outside = tempfile::tempdir().expect("temp dir");
    std::fs::write(outside.path().join("secret.txt"), b"secret").expect("write");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), folder.path().join("link.txt")).expect("symlink");
        std::os::unix::fs::symlink(folder.path().join("js/app.min.js"), folder.path().join("inside.js"))
            .expect("symlink");
        let s = server_with_editor(folder.path()).await;
        assert_detail(&get(&s, "/drawio/link.txt").await, "link.txt", 404, "Not found");
        let r = get(&s, "/drawio/inside.js").await;
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"var a=1;");
        s.stop().await;
    }
}

#[tokio::test]
async fn editor_files_take_ranges_and_only_get() {
    if !skip_unless_available("editor_files_take_ranges_and_only_get") {
        return;
    }
    let folder = editor();
    let s = server_with_editor(folder.path()).await;
    let r = send(&s, "GET", "/drawio/index.html", &[("range", "bytes=0-5")], None).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.text(), "<html>");
    assert_eq!(r.header("content-range").as_deref(), Some("bytes 0-5/17"));
    assert_eq!(r.header("cache-control").as_deref(), Some("public, max-age=3600"));
    for (method, uri) in [
        ("HEAD", "/drawio/index.html"),
        ("HEAD", "/drawio"),
        ("POST", "/drawio"),
        ("PUT", "/drawio/index.html"),
        ("DELETE", "/drawio/"),
    ] {
        let r = send(&s, method, uri, &[], None).await;
        assert_eq!(r.status, 405, "{method} {uri}");
        assert_eq!(r.header("allow").as_deref(), Some("GET"), "{method} {uri}");
        if method != "HEAD" {
            assert_eq!(r.json(), json!({"detail": "Method Not Allowed"}));
        }
    }
    s.stop().await;
}
