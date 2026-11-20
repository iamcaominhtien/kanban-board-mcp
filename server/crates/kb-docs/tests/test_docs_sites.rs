//! HTML sites over HTTP: `POST /projects/{id}/docs/sites` (a folder, a `.zip`, one `.html`; the entry page, unsafe
//! paths, the project check) and `GET /docs/sites/{id}/{path}` (served inline by type, no CSP, 404 for what is not
//! a file of the site).

use std::io::Write;

use serde_json::{Value, json};
use testkit::{Client, Resp, Server, skip_unless_available};

macro_rules! setup {
    ($name:expr) => {{
        if !skip_unless_available($name) {
            return;
        }
        let s = Server::start().await;
        let c = s.client();
        let r = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
        let pid = r.json()["id"].as_str().expect("project id").to_string();
        (s, c, pid)
    }};
}

/// `POST /projects/{pid}/docs/sites` with parts `files` (filename = relative path) and text fields.
async fn upload(c: &Client, pid: &str, files: &[(&str, &[u8])], fields: &[(&str, &str)]) -> Resp {
    let boundary = "----docsSitesBoundary7MA4YWxkTrZu0gW";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    for (path, data) in files {
        body.extend(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{path}\"\r\n")
                .as_bytes(),
        );
        body.extend(b"Content-Type: application/octet-stream\r\n\r\n");
        body.extend(*data);
        body.extend(b"\r\n");
    }
    body.extend(format!("--{boundary}--\r\n").as_bytes());
    let content_type = format!("multipart/form-data; boundary={boundary}");
    c.request("POST", &format!("/projects/{pid}/docs/sites"), &[("content-type", content_type.as_str())], Some(body))
        .await
}

fn header(r: &Resp, name: &str) -> String {
    r.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

#[tokio::test]
async fn test_folder_upload_makes_a_site_served_as_a_web_server_would() {
    let (s, c, pid) = setup!("test_folder_upload_makes_a_site_served_as_a_web_server_would");
    let html = b"<!doctype html><script type=module src=\"js/app.mjs\"></script><canvas></canvas>";
    let r = upload(
        &c,
        &pid,
        &[
            ("globe/index.html", html),
            ("globe/js/app.mjs", b"import './three.js'"),
            ("globe/models/earth.glb", b"glTF\x02\0\0\0"),
            ("globe/css/my style.css", b"canvas{width:100%}"),
        ],
        &[],
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.text());
    let body = r.json();
    let id = body["id"].as_str().unwrap().to_string();
    assert!(id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{id}");
    assert_eq!(body["url"], json!(format!("/docs/sites/{id}/index.html")));
    assert_eq!(body["entry"], json!("index.html"));
    assert_eq!(body["bytes"], json!(html.len() + 19 + 8 + 18));
    let paths: Vec<&str> = body["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["css/my style.css", "index.html", "js/app.mjs", "models/earth.glb"]);
    assert_eq!(body["files"][1], json!({"path": "index.html", "bytes": html.len()}));
    // stored under the uploads folder
    assert!(s.uploads_dir().join("docs-sites").join(&id).join("models/earth.glb").is_file());

    let page = c.get(&format!("/docs/sites/{id}/index.html")).await;
    assert_eq!(page.status, 200);
    assert_eq!(page.body.as_ref(), html);
    assert_eq!(header(&page, "content-type"), "text/html; charset=utf-8");
    assert_eq!(header(&page, "x-content-type-options"), "nosniff");
    assert_eq!(header(&page, "cache-control"), "private, max-age=31536000, immutable");
    assert_eq!(header(&page, "content-security-policy"), "");
    assert_eq!(header(&page, "content-disposition"), "");
    let js = c.get(&format!("/docs/sites/{id}/js/app.mjs")).await;
    assert_eq!(header(&js, "content-type"), "text/javascript; charset=utf-8");
    let glb = c.get(&format!("/docs/sites/{id}/models/earth.glb")).await;
    assert_eq!(header(&glb, "content-type"), "model/gltf-binary");
    let css = c.get(&format!("/docs/sites/{id}/css/my%20style.css")).await;
    assert_eq!(css.status, 200);
    assert_eq!(header(&css, "content-type"), "text/css; charset=utf-8");

    // a folder, a missing file, another site: 404 (a `..` path is resolved by the client before it is sent; the
    // server refuses it too, see the unit tests of `docs_sites`)
    for path in ["js", "nope.html", "js/"] {
        assert_eq!(c.get(&format!("/docs/sites/{id}/{path}")).await.status, 404, "{path}");
    }
    assert_eq!(c.get("/docs/sites/000000000000/index.html").await.status, 404);
    assert_eq!(c.get("/docs/sites/NOTANID/index.html").await.status, 404);
}

#[tokio::test]
async fn test_zip_and_single_html_uploads() {
    let (_s, c, pid) = setup!("test_zip_and_single_html_uploads");
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("demo/start.html", o).unwrap();
        z.write_all(b"<h1>zip</h1>").unwrap();
        z.start_file("demo/img/a.png", o).unwrap();
        z.write_all(b"\x89PNG").unwrap();
        z.finish().unwrap();
    }
    let zipped = buf.into_inner();
    let r = upload(&c, &pid, &[("demo.zip", &zipped)], &[]).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let body = r.json();
    assert_eq!(body["entry"], json!("start.html"), "the first page at the top");
    let url = body["url"].as_str().unwrap();
    assert_eq!(c.get(url).await.body.as_ref(), b"<h1>zip</h1>");
    assert_eq!(body["files"].as_array().unwrap().len(), 2);

    let r = upload(&c, &pid, &[("Report.HTML", b"<p>one</p>")], &[]).await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!(r.json()["entry"], json!("Report.HTML"));

    // an entry named in the form, with or without the uploaded folder's name
    let files: [(&str, &[u8]); 2] = [("site/index.html", b"i"), ("site/other.html", b"o")];
    let r = upload(&c, &pid, &files, &[("entry", "site/other.html")]).await;
    assert_eq!(r.json()["entry"], json!("other.html"));
    let r = upload(&c, &pid, &files, &[("entry", "other.html")]).await;
    assert_eq!(r.json()["entry"], json!("other.html"));
    // `paths` fields name the files when the file names cannot hold the folders
    let r = upload(
        &c,
        &pid,
        &[("index.html", b"i"), ("app.js", b"j")],
        &[("paths", "w/index.html"), ("paths", "w/js/app.js")],
    )
    .await;
    let paths: Vec<Value> = r.json()["files"].as_array().unwrap().iter().map(|f| f["path"].clone()).collect();
    assert_eq!(paths, [json!("index.html"), json!("js/app.js")]);
}

#[tokio::test]
async fn test_site_upload_refusals() {
    let (_s, c, pid) = setup!("test_site_upload_refusals");
    let r = upload(&c, &pid, &[("a/../../evil.html", b"x")], &[]).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.detail()["code"], json!("unsafe_path"));
    let r = upload(&c, &pid, &[("C:/evil.html", b"x"), ("index.html", b"x")], &[]).await;
    assert_eq!(r.detail()["code"], json!("unsafe_path"));
    let r = upload(&c, &pid, &[("css/a.css", b"x"), ("js/a.js", b"x")], &[]).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()["code"], json!("no_html_page"));
    let r = upload(&c, &pid, &[("index.html", b"x")], &[("entry", "missing.html")]).await;
    assert_eq!(r.detail()["code"], json!("no_html_page"));
    let r = upload(&c, &pid, &[("broken.zip", b"PK not really")], &[]).await;
    assert_eq!(r.detail()["code"], json!("bad_zip"));
    let r = upload(&c, &pid, &[], &[]).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()["code"], json!("missing_file"));
    let r = upload(&c, "nope", &[("index.html", b"x")], &[]).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.detail()["code"], json!("project_not_found"));
}
