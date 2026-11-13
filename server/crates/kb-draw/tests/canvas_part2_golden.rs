//! Golden vectors of canvases part 2 (`contract/golden/gen_canvas_part2.py`): the guide texts and examples, the pure
//! functions of `canvas_comments` and `canvas_delivery`, and what `screenshots` lets the hidden browser load and its
//! throwaway server serve (a security property: every refusal is checked).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

use std::path::Path;

mod common;

use kb_db::entities::{canvas, member};
use kb_draw::{canvas_comments as cc, canvas_delivery as cd, canvas_design, screenshots, visual_guides};
use serde_json::{Map, Value, json};

fn golden() -> &'static Value {
    static G: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    G.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/canvas_part2.json");
        serde_json::from_slice(&std::fs::read(path).expect("golden file")).expect("golden json")
    })
}

fn rows(key: &str) -> &'static Vec<Value> {
    golden()[key].as_array().unwrap_or_else(|| panic!("{key} is a list"))
}

fn finish(what: &str, bad: Vec<String>, total: usize) {
    assert!(
        bad.is_empty(),
        "{what}: {} of {total} cases differ:\n{}",
        bad.len(),
        bad.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn the_guide_texts_are_python_s_character_for_character() {
    let t = &golden()["texts"];
    assert_eq!(canvas_design::SKILL_HEADER, t["skill_header"].as_str().expect("text"));
    assert_eq!(canvas_design::GUIDE, t["guide"].as_str().expect("text"));
    assert_eq!(canvas_design::CRAFT, t["craft"].as_str().expect("text"));
    assert_eq!(visual_guides::DRAWIO_HEADER, t["drawio_header"].as_str().expect("text"));
    assert_eq!(visual_guides::SKETCH_HEADER, t["sketch_header"].as_str().expect("text"));
    assert_eq!(visual_guides::CHOOSING, t["choosing"].as_str().expect("text"));
    assert_eq!(visual_guides::DRAWIO, t["drawio"].as_str().expect("text"));
    assert_eq!(visual_guides::SKETCH, t["sketch"].as_str().expect("text"));
    assert_eq!(Value::Object(visual_guides::diagram_guide()), t["diagram_guide"]);
    // the guide carries what the skill header and the tests rely on
    assert!(canvas_design::SKILL_HEADER.starts_with("---\nname: canvas-design\n"));
    assert!(visual_guides::DRAWIO.contains(visual_guides::CHOOSING));
}

#[test]
fn the_design_examples_are_python_s_files() {
    use common::hash::sha256_hex;
    let want = rows("examples");
    let got = canvas_design::examples();
    assert_eq!(got.len(), want.len());
    for ((name, bytes), w) in got.iter().zip(want) {
        assert_eq!(*name, w["name"].as_str().expect("name"));
        assert_eq!(bytes.len() as u64, w["len"].as_u64().expect("len"), "{name}");
        assert_eq!(sha256_hex(bytes), w["sha256"].as_str().expect("sha"), "{name}");
    }
    // the folder Python reads from is the source of the copy
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server/services/design_examples");
    if source.is_dir() {
        for (name, bytes) in got {
            assert_eq!(std::fs::read(source.join(name)).expect("python example"), bytes, "{name}");
        }
    }
}

#[test]
fn a_comment_body_is_stripped_cut_and_never_empty() {
    let mut bad = Vec::new();
    for case in rows("body") {
        let text = case["text"].as_str().expect("text");
        let got = cc::body(text);
        let same = match (&got, case.get("out"), case.get("error")) {
            (Ok(out), Some(want), _) => want == out,
            (Err(e), _, Some(want)) => *want == json!([e.status, e.code, e.message]),
            _ => false,
        };
        if !same {
            bad.push(format!("{text:?}: got {:?}, want {case}", got.as_ref().map(|s| s.chars().count())));
        }
    }
    finish("body", bad, rows("body").len());
}

#[test]
fn the_anchor_of_a_pin_is_cleaned_as_python_does() {
    let mut bad = Vec::new();
    for case in rows("clean_anchor") {
        let got = cc::clean_anchor(Some(&case["raw"])).map(|m| kb_base::pyjson::dumps(&Value::Object(m)));
        let want = case["out"].as_str().map(str::to_string);
        if got != want {
            bad.push(format!("{}\n  got  {got:?}\n  want {want:?}", case["raw"]));
        }
    }
    finish("clean_anchor", bad, rows("clean_anchor").len());
}

#[test]
fn the_members_a_comment_mentions_are_the_ones_python_finds() {
    let mut bad = Vec::new();
    for case in rows("mentioned") {
        let members: Vec<member::Model> = case["members"]
            .as_array()
            .expect("members")
            .iter()
            .map(|m| member::Model {
                id: m[0].as_str().expect("id").into(),
                project_id: "p".into(),
                name: m[1].as_str().expect("name").into(),
                color: "#123456".into(),
                role: "member".into(),
                kind: "human".into(),
                created_at: String::new(),
            })
            .collect();
        let text = case["text"].as_str().expect("text");
        let got: Vec<String> = cc::pick_mentions(&members, text).into_iter().map(|m| m.id).collect();
        let want: Vec<String> =
            case["ids"].as_array().expect("ids").iter().map(|v| v.as_str().expect("id").to_string()).collect();
        if got != want {
            bad.push(format!("{:?} in {text:?}: got {got:?}, want {want:?}", case["members"]));
        }
    }
    finish("mentioned", bad, rows("mentioned").len());
}

fn canvas_row(page_id: Option<&str>, owner_kind: &str, owner_id: &str, title: &str) -> canvas::Model {
    canvas::Model {
        id: "cv_12345678".into(),
        project_id: Some("p".into()),
        owner_kind: owner_kind.into(),
        owner_id: owner_id.into(),
        page_id: page_id.map(str::to_string),
        title: title.into(),
        rev: 1,
        version: 1,
        board_count: 0,
        total_bytes: 0,
        created_by: "user".into(),
        created_at: String::new(),
        updated_by: "user".into(),
        updated_at: String::new(),
        deleted_at: None,
        deleted_by: None,
    }
}

#[test]
fn the_page_of_a_canvas_and_the_note_to_a_team_are_python_s() {
    let mut bad = Vec::new();
    for case in rows("page_of") {
        let c = canvas_row(
            case["page_id"].as_str(),
            case["owner_kind"].as_str().expect("kind"),
            case["owner_id"].as_str().expect("owner"),
            "",
        );
        let got = cd::page_of(&c);
        // Python gives "" where Rust gives `None`: both are false wherever the page is used
        if got.as_deref() != case["out"].as_str().filter(|p| !p.is_empty()) {
            bad.push(format!("page_of {case}: got {got:?}"));
        }
    }
    for case in rows("note") {
        let c = canvas_row(None, "doc", "o", case["title"].as_str().expect("title"));
        let thread: Map<String, Value> = case["thread"].as_object().expect("thread").clone();
        let comment: Map<String, Value> = [("body".to_string(), case["body"].clone())].into_iter().collect();
        let got = cd::note(&c, &thread, &comment, case["by"].as_str().expect("by"));
        if got != case["out"].as_str().expect("out") {
            bad.push(format!("note {case}\n  got {got:?}"));
        }
    }
    finish("note", bad, rows("note").len() + rows("page_of").len());
}

// --- screenshots -------------------------------------------------------------------------------------------------------

#[test]
fn the_hidden_browser_loads_only_the_page_and_public_hosts() {
    let mut bad = Vec::new();
    for case in rows("allowed") {
        let url = case["url"].as_str().expect("url");
        let origin = case["origin"].as_str().expect("origin");
        let got = screenshots::allowed(url, origin);
        // a URL that makes Python's `urlsplit` raise stops the browser's reader there; the port refuses it
        let want = case["out"].as_bool().unwrap_or(false);
        if got != want {
            bad.push(format!("{url:?}: got {got}, want {case}"));
        }
    }
    finish("allowed", bad, rows("allowed").len());
}

#[test]
fn the_drawn_size_of_an_svg_and_the_quoted_entry_are_python_s() {
    let mut bad = Vec::new();
    for case in rows("svg_size") {
        let (w, h) = screenshots::svg_size(case["svg"].as_str().expect("svg"));
        if json!([w, h]) != case["out"] {
            bad.push(format!("{}: got {w}x{h}, want {}", case["svg"], case["out"]));
        }
    }
    for case in rows("quote") {
        let text = case["text"].as_str().expect("text");
        if screenshots::percent_quote(text) != case["out"].as_str().expect("out") {
            bad.push(format!("quote {text:?}: got {:?}", screenshots::percent_quote(text)));
        }
    }
    finish("svg_size", bad, rows("svg_size").len() + rows("quote").len());
}

/// The folder the generator built: a site, a folder outside it, and links across the border.
fn site() -> (tempfile::TempDir, std::path::PathBuf) {
    let root = tempfile::tempdir().expect("temporary folder");
    let (site, outside) = (root.path().join("site"), root.path().join("outside"));
    for d in ["sub", "empty", "noindex", "withindex"] {
        std::fs::create_dir_all(site.join(d)).expect("folder");
    }
    std::fs::create_dir_all(&outside).expect("folder");
    let write = |p: std::path::PathBuf, data: &[u8]| std::fs::write(p, data).expect("file");
    write(site.join("index.html"), b"<h1>home</h1>");
    write(site.join("page.css"), b"body{}");
    write(site.join("data.json"), b"{}");
    write(site.join("pic.png"), b"\x89PNG\r\n\x1a\n");
    write(site.join("a b.txt"), b"spaced");
    write(site.join("sub/b.txt"), b"b");
    write(site.join("noindex/z.txt"), b"z");
    write(site.join("noindex/A.txt"), b"a");
    write(site.join("withindex/index.htm"), b"<p>htm</p>");
    write(outside.join("secret.txt"), b"secret");
    std::os::unix::fs::symlink(&outside, site.join("link_out")).expect("link");
    std::os::unix::fs::symlink(site.join("sub"), site.join("link_in")).expect("link");
    std::os::unix::fs::symlink(outside.join("secret.txt"), site.join("file_out")).expect("link");
    (root, site)
}

#[test]
fn a_url_path_leaving_the_folder_by_dots_or_links_is_a_path_that_does_not_exist() {
    let (_root, site) = site();
    let mut bad = Vec::new();
    for case in rows("translate_path") {
        let path = case["path"].as_str().expect("path");
        if case.get("raises").is_some() {
            continue;
        }
        let full = screenshots::translate_path(&site, path);
        let text = full.to_string_lossy().into_owned();
        let shown = if text.ends_with("__outside__") {
            "__outside__".to_string()
        } else {
            let rel = full.strip_prefix(&site).expect("inside the folder").to_string_lossy().into_owned();
            let rel = if rel.is_empty() || rel == "/" { ".".to_string() } else { rel };
            let rel = rel.trim_end_matches('/').to_string();
            format!("{rel}{}", if text.ends_with('/') { "/" } else { "" })
        };
        if shown != case["inside"].as_str().expect("inside") {
            bad.push(format!("{path:?}: got {shown:?}, want {}", case["inside"]));
        }
    }
    finish("translate_path", bad, rows("translate_path").len());
}

/// One raw HTTP/1.1 request (no URL normalisation, no redirects followed): `(status, headers, body)`.
async fn raw(port: u16, method: &str, target: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
    let request = format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("send");
    let mut data = Vec::new();
    let _ = stream.read_to_end(&mut data).await;
    let split = data.windows(4).position(|w| w == b"\r\n\r\n").map_or(data.len(), |i| i + 4);
    let head = String::from_utf8_lossy(&data[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap_or("").split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let headers: Vec<(String, String)> =
        lines.filter_map(|l| l.split_once(':').map(|(n, v)| (n.trim().to_lowercase(), v.trim().to_string()))).collect();
    let mut body = data[split..].to_vec();
    if headers.iter().any(|(n, v)| n == "transfer-encoding" && v.contains("chunked")) {
        body = unchunk(&body);
    }
    (status, headers, body)
}

fn unchunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(i) = data.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&data[..i]).trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        out.extend_from_slice(&data[i + 2..i + 2 + size]);
        data = &data[i + 2 + size + 2..];
    }
    out
}

#[tokio::test]
async fn the_throwaway_server_serves_its_folder_to_this_machine_only_as_python_does() {
    let (_root, site) = site();
    let served = screenshots::Serve::start(&site).await.expect("serve");
    let port: u16 = served.origin.rsplit(':').next().and_then(|p| p.parse().ok()).expect("port");
    assert!(served.origin.starts_with("http://127.0.0.1:"), "{}", served.origin);
    assert_eq!(golden()["bound_to"], "127.0.0.1");
    let mut bad = Vec::new();
    for case in rows("served") {
        if case.get("raises").is_some() {
            continue;
        }
        let (method, path) = (case["method"].as_str().expect("method"), case["path"].as_str().expect("path"));
        let (status, headers, body) = raw(port, method, path).await;
        let header = |n: &str| headers.iter().find(|(h, _)| h == n).map(|(_, v)| v.clone());
        let sent_body = if method == "HEAD" { Vec::new() } else { body };
        let got = json!({
            "status": status,
            "content_type": header("content-type"),
            "location": header("location"),
            "len": sent_body.len(),
            "sha256": common::hash::sha256_hex(&sent_body),
        });
        let want = json!({
            "status": case["status"], "content_type": case["content_type"], "location": case["location"],
            "len": case["len"], "sha256": case["sha256"],
        });
        if got != want {
            bad.push(format!("{method} {path}\n  got  {got}\n  want {want}"));
        }
    }
    served.stop().await;
    finish("served", bad, rows("served").len());
}
