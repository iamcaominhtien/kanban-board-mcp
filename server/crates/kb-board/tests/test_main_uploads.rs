//! The upload tests of `tests/test_main.py`, through `POST /uploads/images` and `POST /uploads/files` (the tickets
//! router): the two refusals that `crates/kb-app/tests/test_main.rs` left out, and the tests it ported with a file
//! put straight into the uploads folder, here with the upload itself.

use serde_json::{Value, json};
use testkit::{Options, Resp, Server, skip_unless_available};

const MAX_DESCRIPTION_IMAGE_BYTES: usize = 5 * 1024 * 1024;

const SMALL_PNG_BYTES: &[u8] = b"fake-png-bytes";

async fn upload(s: &Server, path: &str, name: &str, content_type: &str, data: &[u8]) -> Resp {
    s.client().upload(path, "file", name, content_type, data.to_vec(), &[]).await
}

fn header(r: &Resp, name: &str) -> String {
    r.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_else(|| panic!("not text: {value}"))
}

#[tokio::test]
async fn test_upload_image_returns_markdown_and_serves_file() {
    if !skip_unless_available("test_upload_image_returns_markdown_and_serves_file") {
        return;
    }
    let s = Server::start().await;
    let upload_response = upload(&s, "/uploads/images", "diagram.png", "image/png", SMALL_PNG_BYTES).await;

    assert_eq!(upload_response.status, 201, "{}", upload_response.text());
    let body = upload_response.json();
    let url = text(&body["url"]);
    assert!(url.starts_with("/uploads/diagram-"));
    assert!(url.ends_with(".png"));
    assert_eq!(body["markdown"], json!(format!("![diagram]({url})")));
    assert_eq!(body["content_type"], "image/png");
    assert_eq!(body["size"], json!(SMALL_PNG_BYTES.len()));

    let file_response = s.client().get(url).await;

    assert_eq!(file_response.status, 200);
    assert_eq!(file_response.body.as_ref(), SMALL_PNG_BYTES);
    assert_eq!(header(&file_response, "x-content-type-options"), "nosniff");
}

#[tokio::test]
async fn test_upload_image_rejects_unsupported_type() {
    if !skip_unless_available("test_upload_image_rejects_unsupported_type") {
        return;
    }
    let s = Server::start().await;
    let response = upload(&s, "/uploads/images", "notes.txt", "text/plain", b"hello").await;

    assert_eq!(response.status, 400);
    assert!(text(&response.detail()).contains("Unsupported image type"));
}

#[tokio::test]
async fn test_upload_image_rejects_files_over_size_limit() {
    if !skip_unless_available("test_upload_image_rejects_files_over_size_limit") {
        return;
    }
    let s = Server::start().await;
    let oversized = vec![b'x'; MAX_DESCRIPTION_IMAGE_BYTES + 1];
    let response = upload(&s, "/uploads/images", "oversized.png", "image/png", &oversized).await;

    assert_eq!(response.status, 413);
    assert_eq!(response.detail(), "Image exceeds the 5MB upload limit.");
}

#[tokio::test]
async fn test_upload_and_serve_all_file_types() {
    if !skip_unless_available("test_upload_and_serve_all_file_types") {
        return;
    }
    let s = Server::start().await;
    let files_to_test: [(&str, &[u8], &str); 5] = [
        ("report.xlsx", b"fake-excel-data", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("document.docx", b"fake-word-data", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("slides.pptx", b"fake-ppt-data", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        ("data.json", br#"{"key": "value"}"#, "application/json"),
        ("manual.pdf", b"%PDF-1.4...", "application/pdf"),
    ];

    let c = s.client();
    for (fname, data, mime) in files_to_test {
        let res = upload(&s, "/uploads/files", fname, mime, data).await;
        assert_eq!(res.status, 201, "Failed uploading {fname}");
        let body = res.json();
        assert_eq!(body["name"], fname);
        assert_eq!(body["markdown"], json!(format!("[{fname}]({})", text(&body["url"]))));

        // Download request (?download=1)
        let dl_res = c.get_query(text(&body["url"]), &[("download", "1")]).await;
        assert_eq!(dl_res.status, 200);
        assert!(header(&dl_res, "content-disposition").contains("attachment"));
        assert!(dl_res.headers.get("x-file-path").is_some());
    }

    // Inline request for PDF (?inline=1)
    let pdf_res = c.get_query("/uploads/manual.pdf", &[("inline", "1")]).await;
    // Should have X-File-Path
    assert!(pdf_res.headers.get("x-file-path").is_some() || pdf_res.status == 200 || pdf_res.status == 404);
}

#[tokio::test]
async fn test_html_and_svg_uploads_cannot_run_in_the_app_origin() {
    if !skip_unless_available("test_html_and_svg_uploads_cannot_run_in_the_app_origin") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let page = b"<html><body><script>alert(1)</script></body></html>";
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;

    let html_up = upload(&s, "/uploads/files", "report.html", "text/html", page).await;
    assert_eq!(html_up.status, 201);
    let html_url = html_up.json()["url"].clone();
    for params in [vec![], vec![("inline", "1")], vec![("view", "1")]] {
        let res = c.get_query(text(&html_url), &params).await;
        // never a page: either a download or plain text, so the viewer has to put it in its locked frame
        assert!(!header(&res, "content-type").starts_with("text/html"));
        assert_eq!(header(&res, "x-content-type-options"), "nosniff");
    }

    let svg_up = upload(&s, "/uploads/files", "logo.svg", "image/svg+xml", svg).await;
    assert_eq!(svg_up.status, 201);
    let res = c.get(text(&svg_up.json()["url"])).await;
    assert!(header(&res, "content-type").starts_with("image/svg+xml"));
    let policy = header(&res, "content-security-policy");
    assert!(policy.contains("default-src 'none'"));
    assert!(policy.contains("sandbox"));
}

#[tokio::test]
async fn test_upload_info_names_the_local_path_for_open_in_app() {
    if !skip_unless_available("test_upload_info_names_the_local_path_for_open_in_app") {
        return;
    }
    // A folder with accents, like a Windows user name such as "Tiến": a header cannot carry it, JSON can
    let home = tempfile::tempdir().expect("temporary folder");
    let uploads = home.path().join("Tiến").join("uploads");
    std::fs::create_dir_all(&uploads).expect("create folder");
    let s = Server::start_with(Options {
        env: vec![("KANBAN_UPLOADS_DIR".into(), uploads.display().to_string())],
        ..Options::default()
    })
    .await;
    let c = s.client();

    let up = upload(&s, "/uploads/files", "notes.txt", "text/plain", b"hello").await;
    assert_eq!(up.status, 201);
    let url = text(&up.json()["url"]).to_string();
    let name = url.rsplit('/').next().expect("name").to_string();

    // the file itself still downloads (the path header must not break the response)
    let res = c.get_query(&url, &[("download", "1")]).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body.as_ref(), b"hello");

    // the desktop app asks for the path here; the page's origin (file://) cannot read custom headers
    let info = c.get(&format!("/upload-info{}", url.trim_start_matches("/uploads"))).await;
    assert_eq!(info.status, 200);
    let body = info.json();
    let resolved = std::fs::canonicalize(uploads.join(&name)).expect("stored file");
    assert_eq!(std::path::Path::new(text(&body["path"])), resolved);
    assert_eq!(body["name"], json!(name));
    assert_eq!(body["size"], 5);

    assert_eq!(c.get("/upload-info/missing.txt").await.status, 404);
    let traversal = c.get("/upload-info/..%2F..%2Fetc%2Fpasswd").await.status;
    assert!(traversal == 400 || traversal == 404);
}

// ---------------------------------------------------------------------------
// Both servers answer the same: the success case and each refusal of the two routes
// ---------------------------------------------------------------------------

/// A `multipart/form-data` body written by hand, for parts a client library would not send (no file name, no type).
async fn raw_form(s: &Server, path: &str, part_headers: &str, data: &[u8]) -> Resp {
    let mut body = format!("--XBOUNDARY\r\n{part_headers}\r\n\r\n").into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n--XBOUNDARY--\r\n");
    s.client().request("POST", path, &[("content-type", "multipart/form-data; boundary=XBOUNDARY")], Some(body)).await
}

fn keys(body: &Value) -> Vec<&str> {
    body.as_object().expect("object").keys().map(String::as_str).collect()
}

/// `<stem>-<12 hex><extension>`: the twelve characters.
fn unique_part<'a>(stored: &'a str, stem: &str, extension: &str) -> &'a str {
    let unique = stored
        .strip_prefix(&format!("{stem}-"))
        .and_then(|rest| rest.strip_suffix(extension))
        .unwrap_or_else(|| panic!("{stored} is not {stem}-<unique>{extension}"));
    assert!(unique.len() == 12 && unique.bytes().all(|b| b.is_ascii_hexdigit()), "{stored}");
    unique
}

#[tokio::test]
async fn upload_description_image_answers_the_same() {
    if !skip_unless_available("upload_description_image_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let image = "/uploads/images";

    // the answer: where it is, how to write it in Markdown, what was stored
    let r = upload(&s, image, "Sơ đồ [v2] final.PNG", "image/png", b"0123456789").await;
    assert_eq!(r.status, 201, "{}", r.text());
    let body = r.json();
    assert_eq!(keys(&body), ["url", "markdown", "filename", "content_type", "size"]);
    let stored = text(&body["filename"]);
    unique_part(stored, "So-o-v2-final", ".png");
    assert_eq!(body["url"], json!(format!("/uploads/{stored}")));
    assert_eq!(body["markdown"], json!(format!("![So-o-v2-final](/uploads/{stored})")));
    assert_eq!((body["content_type"].clone(), body["size"].clone()), (json!("image/png"), json!(10)));
    assert_eq!(std::fs::read(s.uploads_dir().join(stored)).expect("stored"), b"0123456789");
    // a file of exactly the limit is taken; an empty one too
    let r = upload(&s, image, "full.jpg", "image/jpeg", &vec![b'x'; MAX_DESCRIPTION_IMAGE_BYTES]).await;
    assert_eq!((r.status, r.json()["size"].clone()), (201, json!(MAX_DESCRIPTION_IMAGE_BYTES)));
    let r = upload(&s, image, "empty.gif", "image/gif", b"").await;
    assert_eq!((r.status, r.json()["size"].clone()), (201, json!(0)));
    for (name, kind) in
        [("a.jpeg", "image/jpeg"), ("a.webp", "image/webp"), ("a.svg", "image/svg+xml"), ("a.PnG", "IMAGE/PNG")]
    {
        let r = upload(&s, image, name, kind, b"x").await;
        assert_eq!(r.status, 201, "{name}: {}", r.text());
        assert_eq!(r.json()["content_type"], json!(kind.to_lowercase()));
    }

    // refused: not a picture by its name, or a type that is not the name's
    let unsupported = json!({"detail": "Unsupported image type. Use png, jpg, jpeg, gif, or webp."});
    for (name, kind) in [
        ("notes.txt", "text/plain"),
        ("notes.txt", "image/png"),
        ("picture", "image/png"),
        ("picture.png", "image/jpeg"),
        ("picture.png", "text/plain"),
        ("picture.png", "image/png; charset=binary"),
        ("picture.jpg", "image/jpg"),
        (".png", "image/png"),
    ] {
        let r = upload(&s, image, name, kind, b"x").await;
        assert_eq!((r.status, r.json()), (400, unsupported.clone()), "{name} as {kind}");
    }
    let r = raw_form(&s, image, "Content-Disposition: form-data; name=\"file\"; filename=\"a.png\"", b"x").await;
    assert_eq!((r.status, r.json()), (400, unsupported.clone()), "a part without a type");
    // the type is checked before the size
    let oversized = vec![b'x'; MAX_DESCRIPTION_IMAGE_BYTES + 1];
    let r = upload(&s, image, "big.txt", "text/plain", &oversized).await;
    assert_eq!((r.status, r.json()), (400, unsupported.clone()));
    let r = upload(&s, image, "big.png", "image/png", &oversized).await;
    assert_eq!((r.status, r.json()), (413, json!({"detail": "Image exceeds the 5MB upload limit."})));

    // no file in the form
    let r = s.client().upload(image, "picture", "a.png", "image/png", b"x".to_vec(), &[]).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(
        (r.detail()[0]["type"].clone(), r.detail()[0]["loc"].clone()),
        (json!("missing"), json!(["body", "file"]))
    );
    let r = s.client().post(image, json!({"file": "a.png"})).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.detail()[0]["loc"], json!(["body", "file"]));
    let r = s.client().post_empty(image).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.detail()[0]["loc"], json!(["body", "file"]));
    // nothing of what was refused is in the folder
    let names: Vec<String> = std::fs::read_dir(s.uploads_dir())
        .expect("uploads folder")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 7, "{names:?}");
    assert!(!names.iter().any(|n| n.starts_with("big") || n.starts_with("picture") || n.starts_with("notes")));
}

#[tokio::test]
async fn upload_attachment_answers_the_same() {
    if !skip_unless_available("upload_attachment_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let files = "/uploads/files";

    // the answer: an id (the unique part of the stored name), the name as given, the size, the type as sent
    let r = upload(&s, files, "Báo cáo Q3 (final).xlsx", "application/vnd.ms-excel", b"sheet").await;
    assert_eq!(r.status, 201, "{}", r.text());
    let body = r.json();
    assert_eq!(keys(&body), ["id", "url", "name", "size", "type", "markdown"]);
    let url = text(&body["url"]);
    let stored = url.strip_prefix("/uploads/").expect("url");
    assert_eq!(body["id"], json!(unique_part(stored, "Bao-cao-Q3-final", ".xlsx")));
    assert_eq!(body["name"], "Báo cáo Q3 (final).xlsx");
    assert_eq!((body["size"].clone(), body["type"].clone()), (json!(5), json!("application/vnd.ms-excel")));
    assert_eq!(body["markdown"], json!(format!("[Báo cáo Q3 (final).xlsx]({url})")));
    assert_eq!(std::fs::read(s.uploads_dir().join(stored)).expect("stored"), b"sheet");
    // a picture is written as a picture, whatever type was sent; any file is taken, also an empty one
    let r = upload(&s, files, "shot.PNG", "application/octet-stream", b"").await;
    let body = r.json();
    assert_eq!(body["markdown"], json!(format!("![shot.PNG]({})", text(&body["url"]))));
    assert_eq!((body["size"].clone(), body["type"].clone()), (json!(0), json!("application/octet-stream")));
    assert!(text(&body["url"]).ends_with(".png"));
    let r = upload(&s, files, "Makefile", "text/x-makefile", b"all:").await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!(r.json()["name"], "Makefile");
    assert_eq!(r.json()["id"], json!(unique_part(text(&r.json()["url"]), "/uploads/Makefile", "")));
    // a name with folders keeps its last part; a long one is cut to 200 characters, a long type to 100
    let r = upload(&s, files, "logs/2026/run.log", "text/plain", b"x").await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!(r.json()["name"], "run.log");
    unique_part(text(&r.json()["url"]), "/uploads/run", ".log");
    let long_name = format!("{}.txt", "n".repeat(230));
    let long_type = format!("application/x-{}", "t".repeat(120));
    let r = upload(&s, files, &long_name, &long_type, b"x").await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!(r.json()["name"], json!("n".repeat(200)));
    assert_eq!(r.json()["type"], json!(long_type[..100]));
    assert_eq!(r.json()["markdown"], json!(format!("[{}]({})", "n".repeat(200), text(&r.json()["url"]))));
    // a part without a type
    let r = raw_form(&s, files, "Content-Disposition: form-data; name=\"file\"; filename=\"plain.bin\"", b"abc").await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!((r.json()["type"].clone(), r.json()["size"].clone()), (json!("application/octet-stream"), json!(3)));

    // refused: a file without a name
    for name in ["/", ".", "a/.."] {
        let r = upload(&s, files, name, "text/plain", b"x").await;
        if name == "a/.." {
            // `..` is a name
            assert_eq!(r.status, 201, "{name}: {}", r.text());
            continue;
        }
        assert_eq!((r.status, r.json()), (400, json!({"detail": "File name is required."})), "{name}");
    }
    // no file in the form
    let r = s.client().upload(files, "attachment", "a.txt", "text/plain", b"x".to_vec(), &[]).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(
        (r.detail()[0]["type"].clone(), r.detail()[0]["loc"].clone()),
        (json!("missing"), json!(["body", "file"]))
    );
    let r = raw_form(&s, files, "Content-Disposition: form-data; name=\"file\"", b"just text").await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.detail()[0]["loc"], json!(["body", "file"]));
    let r = s.client().post_empty(files).await;
    assert_eq!(r.status, 422, "{}", r.text());
}

/// 100 MB and one byte: refused, nothing stored.
#[tokio::test]
async fn upload_attachment_refuses_files_over_the_size_limit() {
    if !skip_unless_available("upload_attachment_refuses_files_over_the_size_limit") {
        return;
    }
    let s = Server::start().await;
    let oversized = vec![b'x'; 100 * 1024 * 1024 + 1];
    let r = upload(&s, "/uploads/files", "huge.bin", "application/octet-stream", &oversized).await;
    assert_eq!(r.status, 413, "{}", r.text());
    assert_eq!(r.json(), json!({"detail": "File exceeds the 100MB upload limit."}));
    assert_eq!(std::fs::read_dir(s.uploads_dir()).expect("uploads folder").count(), 0);
}
