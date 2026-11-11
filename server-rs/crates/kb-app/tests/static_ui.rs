//! The built UI served by the app (`main.py`: `_get_ui_dist`, `GET /` and the catch-all `GET /{full_path:path}`), and
//! what the catch-all means for every path and method the app has no route for.

mod common;

use common::*;
use serde_json::json;
use std::path::Path;
use testkit::{Options, Server, skip_unless_available};

/// A built UI: an index page, assets of several types, a folder.
fn dist() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    let p = dir.path();
    put_fixed(p, "index.html", b"<html>index</html>");
    put_fixed(p, "assets/app.js", b"console.log(1)");
    put_fixed(p, "assets/style.css", b"a{}");
    put_fixed(p, "assets/logo.svg", b"<svg/>");
    put_fixed(p, "assets/font.woff2", b"font");
    put_fixed(p, "assets/app.js.map", b"{}");
    put_fixed(p, "data.json", b"{}");
    put_fixed(p, "favicon.ico", b"ico");
    put_fixed(p, "pic.PNG", b"png");
    put_fixed(p, "sub/page.txt", b"sub");
    dir
}

async fn server_with_ui(folder: &Path) -> Server {
    Server::start_with(Options {
        env: vec![("KANBAN_UI_DIST".into(), folder.display().to_string())],
        ..Options::default()
    })
    .await
}

/// `ui/dist` of the checkout is the fallback of the app when `KANBAN_UI_DIST` names nothing: a machine that built the
/// UI there has a UI in every "no UI" case.
fn checkout_has_a_built_ui() -> bool {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ui/dist").is_dir()
}

fn assert_page(reply: &Reply, label: &str, content_type: &str, body: &[u8]) {
    assert_eq!(reply.status, 200, "{label}: {}", reply.text());
    assert_headers(
        reply,
        label,
        &[
            ("accept-ranges", "bytes"),
            ("content-length", &body.len().to_string()),
            ("content-type", content_type),
            ("etag", etag(body.len())),
            ("last-modified", LAST_MODIFIED),
        ],
    );
    assert_eq!(reply.body, body, "{label}: body");
}

const HTML: &str = "text/html; charset=utf-8";

#[tokio::test]
async fn without_a_built_ui_every_get_is_404_ui_not_built() {
    if !skip_unless_available("without_a_built_ui_every_get_is_404_ui_not_built") || checkout_has_a_built_ui() {
        return;
    }
    let s = Server::start().await;
    for uri in [
        "/",
        "/nope",
        "/assets/app.js",
        "/some/client/route",
        "/projects/",
        "/events/",
        "/health/",
        "/version/",
        "/uploads",
        "/upload-info",
        "/mcp",
        "/%00",
        "//etc/passwd",
        "/..%2f..%2fetc/passwd",
    ] {
        assert_detail(&get(&s, uri).await, uri, 404, "UI not built");
    }
    let r = send(&s, "GET", "/nope", &[("accept", "text/html")], None).await;
    assert_detail(&r, "accept html", 404, "UI not built");
    s.stop().await;
}

#[tokio::test]
async fn a_folder_named_by_the_variable_that_does_not_exist_is_no_ui() {
    if !skip_unless_available("a_folder_named_by_the_variable_that_does_not_exist_is_no_ui")
        || checkout_has_a_built_ui()
    {
        return;
    }
    let s = Server::start_with(Options {
        env: vec![("KANBAN_UI_DIST".into(), "/definitely/not/a/folder".into())],
        ..Options::default()
    })
    .await;
    assert_detail(&get(&s, "/").await, "/", 404, "UI not built");
    assert_detail(&get(&s, "/x").await, "/x", 404, "UI not built");
    s.stop().await;
}

#[tokio::test]
async fn the_index_page_is_served_at_the_root_and_for_client_routes() {
    if !skip_unless_available("the_index_page_is_served_at_the_root_and_for_client_routes") {
        return;
    }
    let folder = dist();
    let s = server_with_ui(folder.path()).await;
    let page: &[u8] = b"<html>index</html>";
    for uri in [
        "/",
        "/index.html",
        "/some/client/route",
        "/nope",
        "/projects/",
        "/events/",
        "/mcp",
        "/assets",
        "/assets/",
        "/sub",
        "/assets/missing.js",
        "/health/",
        "/uploads",
    ] {
        // an existing file keeps its own type: only a path that is not a file falls back to the index
        let r = get(&s, uri).await;
        assert_page(&r, uri, HTML, page);
    }
    let r = send(&s, "GET", "/nope", &[("accept", "text/html")], None).await;
    assert_page(&r, "accept html", HTML, page);
    s.stop().await;
}

#[tokio::test]
async fn assets_are_served_with_the_type_python_guesses_from_the_name() {
    if !skip_unless_available("assets_are_served_with_the_type_python_guesses_from_the_name") {
        return;
    }
    let folder = dist();
    let s = server_with_ui(folder.path()).await;
    for (uri, content_type, body) in [
        ("/assets/app.js", "text/javascript; charset=utf-8", &b"console.log(1)"[..]),
        ("/assets/style.css", "text/css; charset=utf-8", b"a{}"),
        ("/assets/logo.svg", "image/svg+xml", b"<svg/>"),
        ("/assets/font.woff2", "font/woff2", b"font"),
        ("/assets/app.js.map", "text/plain; charset=utf-8", b"{}"),
        ("/data.json", "application/json", b"{}"),
        ("/favicon.ico", "image/vnd.microsoft.icon", b"ico"),
        ("/pic.PNG", "image/png", b"png"),
        ("/sub/page.txt", "text/plain; charset=utf-8", b"sub"),
        ("/index.html", HTML, b"<html>index</html>"),
    ] {
        assert_page(&get(&s, uri).await, uri, content_type, body);
    }
    s.stop().await;
}

#[tokio::test]
async fn a_path_that_leaves_the_ui_folder_is_refused() {
    if !skip_unless_available("a_path_that_leaves_the_ui_folder_is_refused") {
        return;
    }
    let folder = dist();
    let s = server_with_ui(folder.path()).await;
    for uri in ["//etc/passwd", "/..%2f..%2fetc/passwd", "/assets/..%2f..%2fx", "/%2e%2e%2fx", "/..%2f"] {
        assert_detail(&get(&s, uri).await, uri, 400, "Invalid path");
    }
    // a NUL in the path is an error nothing catches
    let r = get(&s, "/%00").await;
    assert_eq!(r.status, 500);
    assert_eq!(r.text(), "Internal Server Error");
    assert_headers(&r, "NUL", &[("content-length", "21"), ("content-type", "text/plain; charset=utf-8")]);
    s.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_link_leaving_the_ui_folder_is_refused_and_one_inside_is_followed() {
    if !skip_unless_available("a_link_leaving_the_ui_folder_is_refused_and_one_inside_is_followed") {
        return;
    }
    let folder = dist();
    let outside = tempfile::tempdir().expect("temp dir");
    std::fs::write(outside.path().join("secret.txt"), b"secret").expect("write");
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), folder.path().join("link.txt")).expect("symlink");
    std::os::unix::fs::symlink(folder.path().join("assets/app.js"), folder.path().join("inside.js")).expect("symlink");
    let s = server_with_ui(folder.path()).await;
    assert_detail(&get(&s, "/link.txt").await, "link.txt", 400, "Invalid path");
    let r = get(&s, "/inside.js").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"console.log(1)");
    s.stop().await;
}

#[tokio::test]
async fn a_ui_folder_without_an_index_page_serves_its_files_and_nothing_else() {
    if !skip_unless_available("a_ui_folder_without_an_index_page_serves_its_files_and_nothing_else") {
        return;
    }
    let folder = tempfile::tempdir().expect("temp dir");
    put_fixed(folder.path(), "app.js", b"x");
    let s = server_with_ui(folder.path()).await;
    assert_detail(&get(&s, "/").await, "/", 404, "UI not built");
    assert_detail(&get(&s, "/nope").await, "/nope", 404, "Not found");
    assert_detail(&get(&s, "/some/route").await, "/some/route", 404, "Not found");
    assert_page(&get(&s, "/app.js").await, "/app.js", "text/javascript; charset=utf-8", b"x");
    s.stop().await;
}

#[tokio::test]
async fn ui_files_take_ranges() {
    if !skip_unless_available("ui_files_take_ranges") {
        return;
    }
    let folder = dist();
    let s = server_with_ui(folder.path()).await;
    let r = send(&s, "GET", "/assets/app.js", &[("range", "bytes=0-6")], None).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.text(), "console");
    assert_eq!(r.header("content-range").as_deref(), Some("bytes 0-6/14"));
    // the root page is a FileResponse too
    let r = send(&s, "GET", "/", &[("range", "bytes=-8")], None).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.text(), "x</html>");
    s.stop().await;
}

#[tokio::test]
async fn no_route_for_a_method_is_a_405_and_head_never_works() {
    if !skip_unless_available("no_route_for_a_method_is_a_405_and_head_never_works") {
        return;
    }
    let folder = dist();
    for with_ui in [false, true] {
        if !with_ui && checkout_has_a_built_ui() {
            continue;
        }
        let s = if with_ui { server_with_ui(folder.path()).await } else { Server::start().await };
        for (method, uri) in [
            ("POST", "/nope"),
            ("PUT", "/nope"),
            ("PATCH", "/nope"),
            ("DELETE", "/nope"),
            ("OPTIONS", "/nope"),
            ("POST", "/"),
            ("POST", "/projects/"),
            ("DELETE", "/health"),
            ("POST", "/health"),
            ("POST", "/version"),
            ("POST", "/events"),
            ("POST", "/assets/app.js"),
        ] {
            let r = send(&s, method, uri, &[], None).await;
            assert_eq!(r.status, 405, "{method} {uri} (ui: {with_ui})");
            assert_eq!(r.json(), json!({"detail": "Method Not Allowed"}), "{method} {uri}");
            assert_headers(
                &r,
                &format!("{method} {uri}"),
                &[("allow", "GET"), ("content-length", "31"), ("content-type", "application/json")],
            );
        }
        for uri in ["/", "/health", "/version", "/nope", "/assets/app.js", "/events", "/uploads/x", "/upload-info/x"] {
            let r = send(&s, "HEAD", uri, &[], None).await;
            assert_eq!(r.status, 405, "HEAD {uri} (ui: {with_ui})");
            assert_eq!(r.header("allow").as_deref(), Some("GET"), "HEAD {uri}");
            assert!(r.body.is_empty());
        }
        s.stop().await;
    }
}
