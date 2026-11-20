//! Rich Docs phase 5 over HTTP: `POST /projects/{id}/docs/uploads` (limits from the project's settings, programs
//! and scripts refused, the EICAR test file refused, nothing left behind on a refusal), `GET /docs/file-preview` and
//! the address checks of `GET /docs/link-preview`.

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

/// The EICAR anti-virus test file, built from two halves so this source file is not itself flagged.
fn eicar() -> Vec<u8> {
    let mut s = br"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD".to_vec();
    s.extend_from_slice(b"-ANTIVIRUS-TEST-FILE!$H+H*");
    s
}

/// `POST /projects/{pid}/docs/uploads` with `kind` before the file (as the UI sends it).
async fn upload(c: &Client, pid: &str, kind: &str, filename: &str, data: &[u8]) -> Resp {
    let boundary = "----docsEmbedsBoundary7MA4YWxkTrZu0gW";
    let mut body = Vec::new();
    body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n{kind}\r\n").as_bytes());
    body.extend(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend(data);
    body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    let content_type = format!("multipart/form-data; boundary={boundary}");
    c.request("POST", &format!("/projects/{pid}/docs/uploads"), &[("content-type", content_type.as_str())], Some(body))
        .await
}

/// The names of the files in the uploads folder and its private folder (what an upload may leave behind).
fn stored_files(s: &Server) -> Vec<String> {
    let mut out = Vec::new();
    for dir in [s.uploads_dir(), s.uploads_dir().join("_private")] {
        if let Ok(rd) = std::fs::read_dir(dir) {
            out.extend(
                rd.flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()),
            );
        }
    }
    out.sort();
    out
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

#[tokio::test]
async fn test_upload_stores_the_file_and_answers_its_address() {
    let (s, c, pid) = setup!("test_upload_stores_the_file_and_answers_its_address");
    let r = upload(&c, &pid, "image", "Sprint photo.png", PNG).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let body = r.json();
    let src = body["src"].as_str().unwrap();
    assert!(src.starts_with("/uploads/Sprint-photo-") && src.ends_with(".png"), "{src}");
    assert_eq!(body["name"], json!("Sprint photo.png"));
    assert_eq!(body["size"], json!(PNG.len()));
    assert_eq!(body["mime"], json!("image/png"));
    assert_eq!(body["kind"], json!("image"));
    let stored = s.uploads_dir().join(src.trim_start_matches("/uploads/"));
    assert_eq!(std::fs::read(stored).unwrap(), PNG);
    // the file is served like any upload
    let served = c.get(src).await;
    assert_eq!(served.status, 200);

    let r = upload(&c, &pid, "video", "demo.mov", b"\0\0\0\x14ftypqt  ").await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!((r.json()["mime"].clone(), r.json()["kind"].clone()), (json!("video/quicktime"), json!("video")));

    let r = upload(&c, &pid, "file", "sprint-plan.pdf", b"%PDF-1.7\n").await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!(r.json()["mime"], json!("application/pdf"));
}

#[tokio::test]
async fn test_upload_limits_come_from_the_project_settings() {
    let (s, c, pid) = setup!("test_upload_limits_come_from_the_project_settings");
    let r = c.patch(&format!("/projects/{pid}/docs/settings"), json!({"settings": {"uploads": {"fileMb": 1}}})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let before = stored_files(&s);

    let big = vec![b'a'; 1024 * 1024 + 10];
    let r = upload(&c, &pid, "file", "notes.txt", &big).await;
    assert_eq!(r.status, 413, "{}", r.text());
    let detail = r.detail();
    assert_eq!(detail["code"], json!("too_large"));
    assert_eq!(detail["limit_mb"], json!(1));
    assert_eq!(detail["size_bytes"], json!(big.len()));
    assert!(detail["message"].as_str().unwrap().contains("1 MB at most"), "{detail}");
    assert_eq!(stored_files(&s), before, "a refused file leaves nothing behind");

    // exactly at the limit is fine; images keep their own limit (10 MB)
    let r = upload(&c, &pid, "file", "notes.txt", &big[..1024 * 1024]).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let r = upload(&c, &pid, "image", "big.png", &[PNG, &vec![0u8; 2 * 1024 * 1024]].concat()).await;
    assert_eq!(r.status, 201, "{}", r.text());
}

#[tokio::test]
async fn test_upload_refuses_programs_scripts_and_wrong_kinds() {
    let (s, c, pid) = setup!("test_upload_refuses_programs_scripts_and_wrong_kinds");
    let before = stored_files(&s);
    for (kind, name, data) in [
        ("file", "setup.exe", b"anything".as_slice()),
        ("file", "deploy.sh", b"echo hi".as_slice()),
        ("file", "app.js", b"alert(1)".as_slice()),
        ("file", "report.pdf", b"\x7fELF\x02\x01\x01\0\0\0".as_slice()),
        ("file", "notes.txt", b"#!/bin/sh\nrm -rf /\n".as_slice()),
        ("image", "sprint-plan.pdf", b"%PDF-1.7".as_slice()),
        ("video", "demo.avi", b"RIFF....AVI ".as_slice()),
    ] {
        let r = upload(&c, &pid, kind, name, data).await;
        assert_eq!(r.status, 415, "{name}: {}", r.text());
        assert_eq!(r.detail()["code"], json!("type_not_allowed"), "{name}");
    }
    let r = upload(&c, &pid, "program", "a.txt", b"x").await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()["code"], json!("invalid_kind"));
    assert_eq!(stored_files(&s), before);
}

#[tokio::test]
async fn test_upload_refuses_the_eicar_test_file() {
    let (s, c, pid) = setup!("test_upload_refuses_the_eicar_test_file");
    let before = stored_files(&s);
    let mut data = b"%PDF-1.4\n".to_vec();
    data.extend(eicar());
    let r = upload(&c, &pid, "file", "invoice-0912.pdf", &data).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.detail()["code"], json!("virus_found"));
    assert_eq!(r.detail()["virus"], json!("Eicar-Test-Signature"));
    assert_eq!(stored_files(&s), before, "nothing was uploaded");
}

#[tokio::test]
async fn test_upload_needs_a_project_with_docs() {
    let (_s, c, _pid) = setup!("test_upload_needs_a_project_with_docs");
    let r = upload(&c, "nope", "file", "a.txt", b"x").await;
    assert_eq!(r.status, 404, "{}", r.text());
    assert_eq!(r.detail()["code"], json!("project_not_found"));
}

#[tokio::test]
async fn test_file_preview_reads_uploads_only() {
    let (s, c, pid) = setup!("test_file_preview_reads_uploads_only");
    let preview = |src: String| {
        let c = c.clone();
        async move { c.get_query("/docs/file-preview", &[("src", src.as_str())]).await }
    };
    let csv = upload(&c, &pid, "file", "events-export.csv", b"Date,Event\nOct 01,ticket.created\n").await.json();
    let r = preview(csv["src"].as_str().unwrap().to_string()).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let sheet = &r.json()["sheets"][0];
    assert_eq!(r.json()["kind"], json!("sheet"));
    assert_eq!(sheet["rows"], json!([["Date", "Event"], ["Oct 01", "ticket.created"]]));

    let pdf = upload(&c, &pid, "file", "plan.pdf", b"%PDF-1.7\n").await.json();
    assert_eq!(preview(pdf["src"].as_str().unwrap().to_string()).await.json(), json!({"kind": "pdf"}));
    let zip = upload(&c, &pid, "file", "shots.zip", b"PK\x03\x04").await.json();
    assert_eq!(preview(zip["src"].as_str().unwrap().to_string()).await.json(), json!({"kind": "none"}));

    std::fs::create_dir_all(s.uploads_dir().join("_private")).unwrap();
    std::fs::write(s.uploads_dir().join("_private").join("secret.csv"), "a,b\n").unwrap();
    for bad in
        ["/uploads/_private/secret.csv", "/uploads/../config.json", "/etc/passwd", "/uploads/", "/uploads/a/../b.csv"]
    {
        let r = preview(bad.to_string()).await;
        assert_eq!(r.status, 400, "{bad}: {}", r.text());
        assert_eq!(r.detail()["code"], json!("invalid_path"), "{bad}");
    }
    let r = preview("/uploads/missing.csv".to_string()).await;
    assert_eq!(r.status, 404);
    let r = c.get("/docs/file-preview").await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn test_link_preview_refuses_private_addresses() {
    let (s, c, pid) = setup!("test_link_preview_refuses_private_addresses");
    let own = format!("http://127.0.0.1:{}/api/health", s.port());
    for url in
        [own.as_str(), "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "not a url"]
    {
        let r = c.get_query("/docs/link-preview", &[("url", url), ("project_id", pid.as_str())]).await;
        assert_eq!(r.status, 200, "{url}: {}", r.text());
        let body: Value = r.json();
        assert_eq!(body["error"], json!("refused"), "{url}: {body}");
        assert!(body.get("title").is_none(), "{body}");
    }
    let r = c.get_query("/docs/link-preview", &[("url", "http://127.0.0.1/"), ("project_id", "nope")]).await;
    assert_eq!(r.status, 404);
}
