//! `GET /uploads/{path}` and `GET /upload-info/{path}` (`main.py`): every header and branch, checked on the Python
//! server and the Rust one with the same exact values (they were read from the Python server). The files are put
//! straight into the server's uploads folder, with a fixed modification time so `Last-Modified` and `ETag` are known.

mod common;

use common::*;
use serde_json::json;
use testkit::{Options, Server, skip_unless_available};

const PNG: &[u8] = b"PNGDATA0123456789";

/// A server whose uploads folder holds the fixture files.
async fn server_with_files() -> Server {
    let s = Server::start().await;
    let up = s.uploads_dir();
    put_fixed(&up, "a.png", PNG);
    put_fixed(&up, "report.pdf", b"%PDF-1.4 0123456789");
    put_fixed(&up, "notes.txt", b"hello text");
    put_fixed(&up, "page.html", b"<html></html>");
    put_fixed(&up, "logo.svg", b"<svg/>");
    put_fixed(&up, "data.json", b"{}");
    put_fixed(&up, "Café report.docx", b"docx");
    put_fixed(&up, "weird.zzz", b"zzz");
    put_fixed(&up, "clip.mp4", b"mp4data");
    put_fixed(&up, "noext", b"x");
    put_fixed(&up, "UP.PNG", b"upper");
    put_fixed(&up, "sub/dir/inner.txt", b"inner");
    put_fixed(&up, "_private/secret.txt", b"secret");
    s
}

const CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/// What a served file must carry: Starlette's headers plus the app's. `disposition` is the exact
/// `Content-Disposition`; `svg` adds the policy header.
fn expected(
    s: &Server,
    rel: &str,
    size: usize,
    content_type: &str,
    disposition: Option<&str>,
    svg: bool,
) -> Vec<(String, String)> {
    let mut h = vec![
        ("accept-ranges".to_string(), "bytes".to_string()),
        ("content-length".to_string(), size.to_string()),
        ("content-type".to_string(), content_type.to_string()),
        ("etag".to_string(), etag(size).to_string()),
        ("last-modified".to_string(), LAST_MODIFIED.to_string()),
        ("x-content-type-options".to_string(), "nosniff".to_string()),
        ("x-file-path".to_string(), format!("{}/{rel}", canonical(&s.uploads_dir()))),
    ];
    if let Some(d) = disposition {
        h.push(("content-disposition".to_string(), d.to_string()));
    }
    if svg {
        h.push(("content-security-policy".to_string(), CSP.to_string()));
    }
    h
}

fn check(label: &str, reply: &Reply, status: u16, headers: Vec<(String, String)>, body: &[u8]) {
    assert_eq!(reply.status, status, "{label}: {}", reply.text());
    let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_headers(reply, label, &headers);
    assert_eq!(reply.body, body, "{label}: body");
}

#[tokio::test]
async fn an_image_is_served_inline_with_every_header() {
    if !skip_unless_available("an_image_is_served_inline_with_every_header") {
        return;
    }
    let s = server_with_files().await;
    for query in ["", "?name=x", "?download=0", "?download=1&download=0"] {
        let r = get(&s, &format!("/uploads/a.png{query}")).await;
        check(&format!("a.png{query}"), &r, 200, expected(&s, "a.png", 17, "image/png", None, false), PNG);
    }
    // the extension is read in lower case
    let r = get(&s, "/uploads/UP.PNG").await;
    check("UP.PNG", &r, 200, expected(&s, "UP.PNG", 5, "image/png", None, false), b"upper");
    s.stop().await;
}

#[tokio::test]
async fn download_flag_sends_an_attachment_of_any_file() {
    if !skip_unless_available("download_flag_sends_an_attachment_of_any_file") {
        return;
    }
    let s = server_with_files().await;
    let r = get(&s, "/uploads/a.png?download=1").await;
    let want = expected(&s, "a.png", 17, "application/octet-stream", Some("attachment; filename=\"a.png\""), false);
    check("a.png?download=1", &r, 200, want, PNG);
    // "download" wins over "inline"
    let r = get(&s, "/uploads/report.pdf?inline=1&download=1").await;
    let want =
        expected(&s, "report.pdf", 19, "application/octet-stream", Some("attachment; filename=\"report.pdf\""), false);
    check("report.pdf?inline=1&download=1", &r, 200, want, b"%PDF-1.4 0123456789");
    // every boolean spelling of FastAPI
    for flag in ["1", "true", "TRUE", "on", "yes", "y", "t"] {
        let r = get(&s, &format!("/uploads/a.png?download={flag}")).await;
        assert_eq!(r.header("content-type").as_deref(), Some("application/octet-stream"), "download={flag}");
    }
    for flag in ["0", "false", "off", "no", "n", "f"] {
        let r = get(&s, &format!("/uploads/a.png?download={flag}")).await;
        assert_eq!(r.header("content-type").as_deref(), Some("image/png"), "download={flag}");
    }
    s.stop().await;
}

#[tokio::test]
async fn viewable_types_are_inline_only_when_asked_and_a_page_never_is() {
    if !skip_unless_available("viewable_types_are_inline_only_when_asked_and_a_page_never_is") {
        return;
    }
    let s = server_with_files().await;
    let attachment = |name: &str| format!("attachment; filename=\"{name}\"");
    // (uri, file, size, content type, disposition)
    let cases: Vec<(&str, &str, usize, &str, Option<String>)> = vec![
        ("/uploads/report.pdf", "report.pdf", 19, "application/octet-stream", Some(attachment("report.pdf"))),
        ("/uploads/report.pdf?inline=1", "report.pdf", 19, "application/pdf", None),
        ("/uploads/report.pdf?view=true", "report.pdf", 19, "application/pdf", None),
        ("/uploads/notes.txt", "notes.txt", 10, "application/octet-stream", Some(attachment("notes.txt"))),
        ("/uploads/notes.txt?inline=1", "notes.txt", 10, "text/plain; charset=utf-8", None),
        ("/uploads/data.json?inline=yes", "data.json", 2, "application/json", None),
        ("/uploads/clip.mp4?inline=1", "clip.mp4", 7, "video/mp4", None),
        // a page is never shown as a page
        ("/uploads/page.html?inline=1", "page.html", 13, "application/octet-stream", Some(attachment("page.html"))),
        ("/uploads/page.html?view=1", "page.html", 13, "application/octet-stream", Some(attachment("page.html"))),
        // a type the board does not know
        ("/uploads/weird.zzz", "weird.zzz", 3, "application/octet-stream", Some(attachment("weird.zzz"))),
        ("/uploads/weird.zzz?inline=1", "weird.zzz", 3, "application/octet-stream", Some(attachment("weird.zzz"))),
        ("/uploads/noext", "noext", 1, "application/octet-stream", Some(attachment("noext"))),
        ("/uploads/sub/dir/inner.txt?inline=1", "sub/dir/inner.txt", 5, "text/plain; charset=utf-8", None),
    ];
    for (uri, rel, size, content_type, disposition) in cases {
        let r = get(&s, uri).await;
        let body = std::fs::read(s.uploads_dir().join(rel)).expect("fixture");
        check(uri, &r, 200, expected(&s, rel, size, content_type, disposition.as_deref(), false), &body);
    }
    s.stop().await;
}

#[tokio::test]
async fn an_svg_carries_a_policy_so_it_cannot_run_when_opened_on_its_own() {
    if !skip_unless_available("an_svg_carries_a_policy_so_it_cannot_run_when_opened_on_its_own") {
        return;
    }
    let s = server_with_files().await;
    let r = get(&s, "/uploads/logo.svg").await;
    check("logo.svg", &r, 200, expected(&s, "logo.svg", 6, "image/svg+xml", None, true), b"<svg/>");
    let r = get(&s, "/uploads/logo.svg?download=1").await;
    let want = expected(&s, "logo.svg", 6, "application/octet-stream", Some("attachment; filename=\"logo.svg\""), true);
    check("logo.svg?download=1", &r, 200, want, b"<svg/>");
    s.stop().await;
}

#[tokio::test]
async fn the_download_name_is_the_name_query_cleaned_or_the_stored_name() {
    if !skip_unless_available("the_download_name_is_the_name_query_cleaned_or_the_stored_name") {
        return;
    }
    let s = server_with_files().await;
    let names = [
        ("", "attachment; filename=\"notes.txt\""),
        ("&name=my%20pic.png", "attachment; filename*=utf-8''my%20pic.png"),
        ("&name=..%2F..%2Fevil.txt", "attachment; filename=\"evil.txt\""),
        ("&name=a%5Cb%5Cc.txt", "attachment; filename=\"c.txt\""),
        ("&name=bad%0Aname.txt", "attachment; filename=\"badname.txt\""),
        ("&name=", "attachment; filename=\"notes.txt\""),
        ("&name=%20", "attachment; filename*=utf-8''%20"),
        ("&name=q%22uote.txt", "attachment; filename*=utf-8''q%22uote.txt"),
        ("&name=n%C3%A0me.txt", "attachment; filename*=utf-8''n%C3%A0me.txt"),
        ("&name=%E2%80%8Bzero.txt", "attachment; filename=\"zero.txt\""),
    ];
    for (query, disposition) in names {
        let r = get(&s, &format!("/uploads/notes.txt?download=1{query}")).await;
        assert_eq!(r.status, 200, "{query}");
        assert_eq!(r.header("content-disposition").as_deref(), Some(disposition), "name query {query:?}");
    }
    // a long name is cut to 200 characters
    let long = "x".repeat(250);
    let r = get(&s, &format!("/uploads/notes.txt?name={long}")).await;
    let want = format!("attachment; filename=\"{}\"", "x".repeat(200));
    assert_eq!(r.header("content-disposition"), Some(want));
    // a stored name with accents has no plain form
    let r = get(&s, "/uploads/Caf%C3%A9%20report.docx").await;
    let want = expected(
        &s,
        "Café report.docx",
        4,
        "application/octet-stream",
        Some("attachment; filename*=utf-8''Caf%C3%A9%20report.docx"),
        false,
    );
    check("Café report.docx", &r, 200, want, b"docx");
    let r = get(&s, "/uploads/Caf%C3%A9%20report.docx?name=R%C3%A9sum%C3%A9%20n%C2%BA1.docx").await;
    assert_eq!(
        r.header("content-disposition").as_deref(),
        Some("attachment; filename*=utf-8''R%C3%A9sum%C3%A9%20n%C2%BA1.docx")
    );
    s.stop().await;
}

#[tokio::test]
async fn a_path_that_is_not_a_servable_file_is_refused() {
    if !skip_unless_available("a_path_that_is_not_a_servable_file_is_refused") {
        return;
    }
    let s = server_with_files().await;
    for (uri, status, detail) in [
        ("/uploads/nope.png", 404, "File not found"),
        ("/uploads/sub", 404, "File not found"),
        ("/uploads/sub/dir", 404, "File not found"),
        ("/uploads/", 404, "File not found"),
        ("/uploads/_private/secret.txt", 400, "Invalid path"),
        ("/uploads/_PRIVATE/secret.txt", 400, "Invalid path"),
        ("/uploads/_private", 400, "Invalid path"),
        ("/uploads//a.png", 400, "Invalid path"),
        ("/uploads/..%2f..%2fetc%2fpasswd", 400, "Invalid path"),
        ("/uploads/sub%2f..%2f..%2fa.png", 400, "Invalid path"),
        ("/uploads/a%00b", 400, "Invalid path"),
        ("/upload-info/nope.png", 404, "File not found"),
        ("/upload-info/sub", 404, "File not found"),
        ("/upload-info/", 404, "File not found"),
        ("/upload-info/_private/secret.txt", 400, "Invalid path"),
        ("/upload-info/..%2fa.png", 400, "Invalid path"),
        ("/upload-info//a.png", 400, "Invalid path"),
    ] {
        assert_detail(&get(&s, uri).await, uri, status, detail);
    }
    s.stop().await;
}

#[tokio::test]
async fn a_boolean_query_value_that_is_not_one_is_a_422() {
    if !skip_unless_available("a_boolean_query_value_that_is_not_one_is_a_422") {
        return;
    }
    let s = server_with_files().await;
    for (name, value) in [("download", "maybe"), ("inline", ""), ("view", "2"), ("download", "truee")] {
        let r = get(&s, &format!("/uploads/a.png?{name}={value}")).await;
        assert_eq!(r.status, 422, "{name}={value}");
        assert_eq!(
            r.json(),
            json!({"detail": [{
                "type": "bool_parsing",
                "loc": ["query", name],
                "msg": "Input should be a valid boolean, unable to interpret input",
                "input": value,
            }]}),
            "{name}={value}"
        );
    }
    s.stop().await;
}

#[tokio::test]
async fn ranges_and_if_range_are_answered_as_starlette_answers_them() {
    if !skip_unless_available("ranges_and_if_range_are_answered_as_starlette_answers_them") {
        return;
    }
    let s = server_with_files().await;
    let single = |label: &str, range: &str, content_range: &str, body: &[u8]| {
        let mut h = expected(&s, "a.png", 17, "image/png", None, false);
        h.retain(|(k, _)| k != "content-length");
        h.push(("content-length".into(), body.len().to_string()));
        h.push(("content-range".into(), content_range.into()));
        (label.to_string(), range.to_string(), h, body.to_vec())
    };
    for (label, range, headers, body) in [
        single("first five", "bytes=0-4", "bytes 0-4/17", b"PNGDA"),
        single("from five", "bytes=5-", "bytes 5-16/17", b"TA0123456789"),
        single("last four", "bytes=-4", "bytes 13-16/17", b"6789"),
        single("past the end", "bytes=0-1000", "bytes 0-16/17", PNG),
        single("overlapping ranges are one", "bytes=0-4,3-8", "bytes 0-8/17", b"PNGDATA01"),
        single("unit in capitals and spaces", "BYTES = 0-1", "bytes 0-1/17", b"PN"),
    ] {
        let r = send(&s, "GET", "/uploads/a.png", &[("range", &range)], None).await;
        check(&label, &r, 206, headers, &body);
    }

    // two ranges: multipart/byteranges (the boundary is random)
    let r = send(&s, "GET", "/uploads/a.png", &[("range", "bytes=0-1,5-6")], None).await;
    assert_eq!(r.status, 206);
    let content_type = r.header("content-type").expect("content type");
    let boundary = content_type.strip_prefix("multipart/byteranges; boundary=").expect("multipart type").to_string();
    assert_eq!(boundary.len(), 26);
    let want_body = format!(
        "--{b}\r\nContent-Type: image/png\r\nContent-Range: bytes 0-1/17\r\n\r\nPN\r\n\
         --{b}\r\nContent-Type: image/png\r\nContent-Range: bytes 5-6/17\r\n\r\nTA\r\n--{b}--",
        b = boundary
    );
    assert_eq!(r.text(), want_body);
    assert_eq!(r.header("content-length"), Some(want_body.len().to_string()));
    assert_eq!(r.header("content-length").as_deref(), Some("210"));

    // refused ranges
    let r = send(&s, "GET", "/uploads/a.png", &[("range", "bytes=100-")], None).await;
    assert_eq!(r.status, 416);
    assert_headers(
        &r,
        "416",
        &[("content-length", "0"), ("content-range", "bytes */17"), ("content-type", "text/plain; charset=utf-8")],
    );
    for (range, text) in [
        ("items=0-1", "Only support bytes range"),
        ("0-1", "Malformed range header."),
        ("bytes=", "Range header: range must be requested"),
        ("bytes=x-y", "Range header: range must be requested"),
        ("bytes=5-2", "Range header: start must be less than end"),
    ] {
        let r = send(&s, "GET", "/uploads/a.png", &[("range", range)], None).await;
        assert_eq!(r.status, 400, "{range}");
        assert_eq!(r.text(), text, "{range}");
        assert_headers(
            &r,
            range,
            &[("content-length", &text.len().to_string()), ("content-type", "text/plain; charset=utf-8")],
        );
    }

    // If-Range: the range is honoured only for the validator this response carries
    let stale = send(&s, "GET", "/uploads/a.png", &[("range", "bytes=0-4"), ("if-range", "\"nope\"")], None).await;
    check("if-range mismatch", &stale, 200, expected(&s, "a.png", 17, "image/png", None, false), PNG);
    for validator in [LAST_MODIFIED, etag(17)] {
        let r = send(&s, "GET", "/uploads/a.png", &[("range", "bytes=0-4"), ("if-range", validator)], None).await;
        assert_eq!(r.status, 206, "if-range {validator}");
        assert_eq!(r.text(), "PNGDA");
    }
    s.stop().await;
}

#[tokio::test]
async fn only_get_reaches_the_upload_routes_and_head_is_refused_as_fastapi_does() {
    if !skip_unless_available("only_get_reaches_the_upload_routes_and_head_is_refused_as_fastapi_does") {
        return;
    }
    let s = server_with_files().await;
    for (method, uri) in [
        ("HEAD", "/uploads/a.png"),
        ("HEAD", "/uploads/a.png?download=1"),
        ("HEAD", "/upload-info/a.png"),
        ("PUT", "/uploads/a.png"),
        ("PATCH", "/uploads/a.png"),
        ("DELETE", "/uploads/a.png"),
        ("DELETE", "/upload-info/a.png"),
        ("OPTIONS", "/uploads/a.png"),
    ] {
        let r = send(&s, method, uri, &[], None).await;
        assert_eq!(r.status, 405, "{method} {uri}");
        assert_headers(
            &r,
            &format!("{method} {uri}"),
            &[("allow", "GET"), ("content-length", "31"), ("content-type", "application/json")],
        );
        if method != "HEAD" {
            assert_eq!(r.json(), json!({"detail": "Method Not Allowed"}));
        }
    }
    s.stop().await;
}

#[tokio::test]
async fn upload_info_names_the_stored_file() {
    if !skip_unless_available("upload_info_names_the_stored_file") {
        return;
    }
    let s = server_with_files().await;
    let up = canonical(&s.uploads_dir());
    let r = get(&s, "/upload-info/a.png").await;
    assert_eq!(r.status, 200);
    assert_headers(
        &r,
        "upload-info",
        &[("content-length", &r.body.len().to_string()), ("content-type", "application/json")],
    );
    // the keys come in this order
    assert_eq!(r.text(), format!("{{\"path\":\"{up}/a.png\",\"name\":\"a.png\",\"size\":17}}"));
    let r = get(&s, "/upload-info/Caf%C3%A9%20report.docx").await;
    assert_eq!(r.json(), json!({"path": format!("{up}/Café report.docx"), "name": "Café report.docx", "size": 4}));
    let r = get(&s, "/upload-info/sub/dir/inner.txt").await;
    assert_eq!(r.json(), json!({"path": format!("{up}/sub/dir/inner.txt"), "name": "inner.txt", "size": 5}));
    s.stop().await;
}

/// A folder with a character latin-1 can carry (é): the header is sent as a latin-1 byte, as Starlette encodes it.
#[tokio::test]
async fn a_latin_1_path_is_sent_in_the_header_as_one_byte_per_character() {
    if !skip_unless_available("a_latin_1_path_is_sent_in_the_header_as_one_byte_per_character") {
        return;
    }
    let home = tempfile::tempdir().expect("temp dir");
    let uploads = home.path().join("Café").join("uploads");
    std::fs::create_dir_all(&uploads).expect("create folder");
    let s = Server::start_with(Options {
        env: vec![("KANBAN_UPLOADS_DIR".into(), uploads.display().to_string())],
        ..Options::default()
    })
    .await;
    std::fs::write(uploads.join("notes.txt"), b"hello").expect("write");
    let r = get(&s, "/uploads/notes.txt?download=1").await;
    let canonical_path = canonical(&uploads.join("notes.txt"));
    let latin1: Vec<u8> = canonical_path.chars().map(|c| u8::try_from(u32::from(c)).expect("latin-1")).collect();
    assert!(latin1.contains(&0xE9));
    assert_eq!(r.header_bytes("x-file-path"), Some(latin1));
    s.stop().await;
}
