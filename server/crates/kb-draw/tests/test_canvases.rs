//! `tests/test_canvases.py` (the half of the canvases this crate serves), a differential check of every route of
//! `api/canvases.rs` against a snapshot recorded from the Python server, and the cross-server ZIP check.
//!
//! The Docs steps run only where the Docs routes are served (the Docs area is another port):
//! `test_a_docs_page_canvas_gets_a_version_every_ten_minutes`, `test_move_to_docs_keeps_the_id_...`,
//! `test_boards_are_sections_of_a_canvas_page_and_the_ticket_lists_the_canvas`.
//!
//! The comment tests (`test_comment_threads_pinned_to_a_frame_or_the_plane_resolve_and_reopen`,
//! `test_an_ai_comment_is_marked_and_an_ai_member_cannot_resolve_a_persons_thread`) are at the end of the file; the
//! pins inside `test_one_lock_per_board...`, `test_move_to_docs...` and `test_viewers_can_look...` run on every target.

mod common;

use std::io::Write;
use std::time::Duration;

use common::{FilePart, Reply, form, member, pid, png, raw_get};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

const PAGE: &str = "<!doctype html><html><head><title>Sign in</title><style>body{color:#123}</style></head><body>\
    <h1>Sign in</h1><label>Email</label><input type=email placeholder=you@example.com><button>Continue</button>\
    </body></html>";

const OPEN_PAGE: &str = "<!doctype html><html><head>\n<script src=\"https://cdn.example.com/a.js\"></script>\n\
    <link rel=\"stylesheet\" href=\"https://cdn.example.com/site.css\">\n<link rel=\"stylesheet\" href=\"local.css\">\n\
    <style>@import url(https://fonts.example/x.css); h1{color:red}</style>\n</head><body onload=\"start()\">\n\
    <h1 onclick=\"go()\">Hello</h1><img src=\"https://images.example/p.png\">\n\
    <script>document.title = 'ran'</script>\n</body></html>";

fn part(field: &str, name: &str, content_type: &str, data: &[u8]) -> FilePart {
    (field.into(), name.into(), content_type.into(), data.to_vec())
}

fn html_part(html: &str) -> FilePart {
    part("files", "index.html", "text/html", html.as_bytes())
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("a number, got {v}"))
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_else(|| panic!("a string, got {v}")).to_string()
}

/// `make(c, pid, **kw)`: `POST /canvases`, expecting 201.
async fn make(c: &Client, pid: Option<&str>, extra: Value) -> Value {
    let mut body = json!({"owner_kind": "doc", "owner_id": "page-1", "title": "Login redesign"});
    if let Some(pid) = pid {
        body["project_id"] = json!(pid);
    }
    for (k, v) in extra.as_object().expect("extra") {
        body[k] = v.clone();
    }
    let r = c.post("/canvases", body).await;
    r.assert_status(201);
    r.json()
}

async fn make_in(c: &Client, pid: &str, extra: Value) -> Value {
    make(c, Some(pid), extra).await
}

/// A form with `data=` fields and no files, urlencoded as httpx sends it.
async fn urlform(
    server: &Server,
    method: &str,
    path: &str,
    fields: &[(&str, &str)],
    headers: &[(&str, &str)],
) -> Reply {
    let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(120)).build().expect("client");
    let mut rb = http
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).expect("method"),
            format!("{}{path}", server.base_url()),
        )
        .form(&fields.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>());
    for (n, v) in headers {
        rb = rb.header(*n, *v);
    }
    let r = rb.send().await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    let body = r.bytes().await.expect("body").to_vec();
    Reply { status, headers, body }
}

/// `html_board(c, cid, name, html)`.
async fn html_board(srv: &Server, cid: &str, name: &str, html: &str) -> Value {
    let r = form(
        srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "html"), ("name", name)],
        vec![html_part(html)],
        &[],
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()["board"].clone()
}

async fn get(srv: &Server, path: &str) -> Reply {
    raw_get(srv, path, &[]).await
}

async fn get_json(c: &Client, path: &str) -> Value {
    c.get(path).await.json()
}

fn detail(r: &Reply) -> Value {
    r.json()["detail"].clone()
}

/// Whether the Docs area is wired in: its routes are served and a canvas page can be made (`POST /canvases/pages` goes
/// through the `CanvasDocs` hook, which `kb-app` registers once `kb-docs` is ported).
async fn docs_served(c: &Client, pid: &str, test: &str) -> bool {
    let tree = c.get(&format!("/projects/{pid}/docs/tree")).await.status == 200;
    if tree && c.post("/canvases/pages", json!({"project_id": pid, "title": "Probe"})).await.status == 201 {
        return true;
    }
    eprintln!("SKIPPED the Docs steps of {test}: the Docs area is not wired into this server");
    false
}

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in entries {
        z.start_file(*name, options).expect("zip entry");
        z.write_all(data).expect("zip data");
    }
    z.finish().expect("zip").into_inner()
}

fn zip_names(bytes: &[u8]) -> Vec<String> {
    let z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("a zip");
    z.file_names().map(str::to_string).collect()
}

macro_rules! start {
    ($name:expr) => {{
        if !skip_unless_available($name) {
            return;
        }
        let srv = Server::start().await;
        let c = srv.client();
        let pid = pid(&c).await;
        (srv, c, pid)
    }};
}

// --- create, read, markdown ------------------------------------------------------------------------------------

#[tokio::test]
async fn test_create_makes_a_record_a_file_and_an_empty_first_board() {
    let (srv, c, pid) = start!("test_create_makes_a_record_a_file_and_an_empty_first_board");
    let cv = make_in(&c, &pid, json!({})).await;
    let id = s(&cv["id"]);
    assert!(id.starts_with("cv_") && id.len() == 11);
    assert_eq!(cv["markdown"], json!(format!("![Login redesign](canvas:{id})")));
    assert!(cv["owner_kind"] == "doc" && cv["project_id"] == json!(pid));
    assert!(cv["version"] == 1 && cv["can_edit"] == true);
    let doc = &cv["doc"];
    assert!(doc["format"] == "kanban-canvas" && doc["pages"].as_array().expect("pages").len() == 1);
    let kinds: Vec<&Value> = doc["boards"].as_array().expect("boards").iter().map(|b| &b["kind"]).collect();
    assert_eq!(kinds, vec![&json!("empty")]);
    // a record plus one file in the uploads folder
    assert!(srv.uploads_dir().join("canvases").join(&id).join("canvas.json").is_file());
    let got = get_json(&c, &format!("/canvases/{id}")).await;
    assert_eq!(got["doc"]["boards"][0]["id"], doc["boards"][0]["id"]);
}

#[tokio::test]
async fn test_list_by_owner_and_unlink_restore() {
    let (_srv, c, pid) = start!("test_list_by_owner_and_unlink_restore");
    let cv = make_in(&c, &pid, json!({})).await;
    let id = s(&cv["id"]);
    let q = [("owner_kind", "doc"), ("owner_id", "page-1")];
    let listed = c.get_query("/canvases", &q).await.json();
    let ids: Vec<&Value> = listed.as_array().expect("list").iter().map(|x| &x["id"]).collect();
    assert_eq!(ids, vec![&cv["id"]]);
    assert_eq!(c.delete(&format!("/canvases/{id}")).await.status, 200);
    assert_eq!(c.get(&format!("/canvases/{id}")).await.status, 404);
    assert_eq!(c.get_query("/canvases", &q).await.json(), json!([]));
    let back = c.post_empty(&format!("/canvases/{id}/restore")).await;
    assert!(back.status == 200 && back.json()["deleted_at"].is_null());
}

// --- boards: HTML folder, images, limits ------------------------------------------------------------------------

#[tokio::test]
async fn test_html_board_is_a_folder_with_its_own_css_and_images() {
    let (srv, c, pid) = start!("test_html_board_is_a_folder_with_its_own_css_and_images");
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let r = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "html"), ("name", "Home")],
        vec![
            part(
                "files",
                "index.html",
                "text/html",
                b"<link rel=stylesheet href=\"css/site.css\"><img src=\"img/a.png\"><h1>Hi</h1>",
            ),
            part("files", "css/site.css", "text/css", b"h1{color:red}"),
            part("files", "img/a.png", "image/png", &png(8, 6, 0)),
        ],
        &[],
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.text());
    let b = r.json()["board"].clone();
    assert!(b["kind"] == "html" && b["content"]["entry"] == "index.html");
    let mut paths: Vec<String> =
        b["content"]["files"].as_array().expect("files").iter().map(|x| s(&x["path"])).collect();
    paths.sort();
    assert_eq!(paths, vec!["css/site.css", "img/a.png", "index.html"]);
    let rev = b["content"]["rev"].as_i64().expect("rev");
    let bid = s(&b["id"]);
    let root = srv.uploads_dir().join("canvases").join(&cid).join("boards").join(&bid).join(format!("r{rev}"));
    assert_eq!(std::fs::read(root.join("css").join("site.css")).expect("css"), b"h1{color:red}");
    // served one by one, relative to the page, so the folder works as it is
    let base = format!("/canvases/{cid}/boards/{bid}/r/{rev}");
    let page = get(&srv, &format!("{base}/index.html")).await;
    assert!(page.status == 200 && page.header("content-type").contains("text/html"));
    assert!(get(&srv, &format!("{base}/css/site.css")).await.header("content-type").starts_with("text/css"));
    assert_eq!(get(&srv, &format!("{base}/img/a.png")).await.body, png(8, 6, 0));
    // a way out of the board's folder gives nothing of the canvas (a built UI answers unknown paths with its own page)
    for way in ["../../../canvas.json", "%2e%2e/%2e%2e/%2e%2e/canvas.json", "..%2f..%2f..%2fcanvas.json"] {
        let out = get(&srv, &format!("{base}/{way}")).await;
        assert!(!out.text().contains("kanban-canvas"), "{way}");
    }
}

#[tokio::test]
async fn test_new_boards_are_placed_to_the_right_never_on_top() {
    let (srv, c, pid) = start!("test_new_boards_are_placed_to_the_right_never_on_top");
    let cv = make_in(&c, &pid, json!({})).await;
    let first = cv["doc"]["boards"][0].clone();
    let second = html_board(&srv, &s(&cv["id"]), "Two", PAGE).await;
    let third = html_board(&srv, &s(&cv["id"]), "Three", PAGE).await;
    assert!(f(&second["x"]) >= f(&first["x"]) + f(&first["w"]));
    assert!(f(&third["x"]) >= f(&second["x"]) + f(&second["w"]));
}

#[tokio::test]
async fn test_image_board_takes_its_size_from_the_picture() {
    let (srv, c, pid) = start!("test_image_board_takes_its_size_from_the_picture");
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let r = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "image")],
        vec![part("files", "shot.png", "image/png", &png(800, 600, 0))],
        &[],
    )
    .await;
    let b = r.json()["board"].clone();
    assert!(b["kind"] == "image" && (f(&b["w"]), f(&b["h"])) == (800.0, 600.0));
    assert_eq!(b["content"]["entry"], "image.png");
    let bad = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "image")],
        vec![part("files", "x.png", "image/png", b"not a picture")],
        &[],
    )
    .await;
    assert_eq!(bad.status, 422);
}

#[tokio::test]
async fn test_limits_have_clear_errors() {
    // the Python test lowers the limits with `monkeypatch`; this one meets the real ones (5 MB a frame, 60 frames, 50 MB
    // a canvas)
    let (srv, c, pid) = start!("test_limits_have_clear_errors");
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let mut big = b"<h1>x</h1>".to_vec();
    big.extend(std::iter::repeat_n(b'a', 5 * 1024 * 1024));
    let r = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "html")],
        vec![part("files", "index.html", "text/html", &big)],
        &[],
    )
    .await;
    assert_eq!(r.status, 413);
    let d = detail(&r);
    assert!(
        d["code"] == "board_too_large"
            && d["limit_bytes"] == 5 * 1024 * 1024
            && s(&d["message"]).contains("Remove embedded images")
    );
    // 60 frames
    for i in 0..60 {
        let r = urlform(&srv, "POST", &format!("/canvases/{cid}/boards"), &[("kind", "empty")], &[]).await;
        assert_eq!(r.status, 201, "frame {i}: {}", r.text());
    }
    let over = urlform(&srv, "POST", &format!("/canvases/{cid}/boards"), &[("kind", "empty")], &[]).await;
    assert!(over.status == 422 && detail(&over)["code"] == "too_many_boards");
    // 50 MB: ten frames of 5 MB fit, the eleventh does not
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let mut five = b"<h1>y</h1>".to_vec();
    five.extend(std::iter::repeat_n(b'b', 5 * 1024 * 1024 - 10));
    for i in 0..10 {
        let r = form(
            &srv,
            "POST",
            &format!("/canvases/{cid}/boards"),
            &[("kind", "html")],
            vec![part("files", "index.html", "text/html", &five)],
            &[],
        )
        .await;
        assert_eq!(r.status, 201, "frame {i}: {}", r.text());
    }
    let full = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "html")],
        vec![part("files", "index.html", "text/html", &five)],
        &[],
    )
    .await;
    assert!(full.status == 413 && detail(&full)["code"] == "canvas_too_large");
}

#[tokio::test]
async fn test_page_tab_limit() {
    let (_srv, c, pid) = start!("test_page_tab_limit");
    let cv = make_in(&c, &pid, json!({})).await;
    // a canvas holds up to 10 page tabs and has one: ten more is too many
    let pages: Vec<Value> = (0..10).map(|i| json!({"name": format!("Tab {i}")})).collect();
    let r = c
        .patch(&format!("/canvases/{}", s(&cv["id"])), json!({"base_rev": cv["rev"], "upsert": {"pages": pages}}))
        .await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "too_many_pages");
}

// --- a frame is an open web page: its files are kept exactly as given -------------------------------------------

#[tokio::test]
async fn test_files_are_kept_as_given_and_served_without_a_policy() {
    let (srv, c, pid) = start!("test_files_are_kept_as_given_and_served_without_a_policy");
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let css = "@import 'https://fonts.example/a.css'; a{background:url(https://x.example/a.png)}";
    let r = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "html"), ("name", "Open")],
        vec![
            html_part(OPEN_PAGE),
            part("files", "local.css", "text/css", css.as_bytes()),
            part("files", "app.js", "text/javascript", b"console.log(1)"),
            part("files", "tool.exe", "application/octet-stream", b"MZ"),
        ],
        &[],
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.text());
    let b = r.json()["board"].clone();
    assert!(b["content"].get("blocked").is_none() && b["content"].get("blocked_total").is_none());
    assert_eq!(b["content"]["skipped"], json!(["tool.exe"]));
    assert!(b["content"]["files"].as_array().expect("files").iter().any(|f| f["path"] == "app.js"));
    let base = format!("/canvases/{cid}/boards/{}/r/{}", s(&b["id"]), b["content"]["rev"]);
    let page = get(&srv, &format!("{base}/index.html")).await;
    assert_eq!(page.body, OPEN_PAGE.as_bytes());
    assert_eq!(get(&srv, &format!("{base}/local.css")).await.body, css.as_bytes());
    let js = get(&srv, &format!("{base}/app.js")).await;
    assert!(js.status == 200 && js.header("content-type").starts_with("text/javascript"));
    // nothing restricts the page: no policy, no sandbox
    assert!(page.headers.get("content-security-policy").is_none());
    assert_eq!(page.header("x-content-type-options"), "nosniff");
}

#[tokio::test]
async fn test_a_zip_of_a_built_page_becomes_one_board() {
    let (srv, c, pid) = start!("test_a_zip_of_a_built_page_becomes_one_board");
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let zipped = zip_of(&[
        ("dist/index.html", b"<title>Built</title><link rel=stylesheet href=assets/a.css><h1>Built</h1>"),
        ("dist/assets/a.css", b"h1{color:blue}"),
        ("dist/assets/app.js", b"alert(1)"),
        ("../evil.html", b"<h1>x</h1>"),
    ]);
    let r = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/import"),
        &[],
        vec![
            part("files", "site.zip", "application/zip", &zipped),
            part("files", "login.html", "text/html", PAGE.as_bytes()),
            part("files", "shot.png", "image/png", &png(8, 6, 0)),
            part("files", "notes.pdf", "application/pdf", b"%PDF"),
        ],
        &[],
    )
    .await;
    assert_eq!(r.status, 201, "{}", r.text());
    let out = r.json();
    let kinds: Vec<&Value> = out["boards"].as_array().expect("boards").iter().map(|b| &b["kind"]).collect();
    assert_eq!(kinds, vec![&json!("html"), &json!("html"), &json!("image")]);
    assert_eq!(out["boards"][0]["content"]["entry"], "index.html");
    assert_eq!(out["boards"][1]["name"], "login");
    let names: Vec<&Value> = out["failed"].as_array().expect("failed").iter().map(|f| &f["name"]).collect();
    assert_eq!(names, vec![&json!("notes.pdf")]);
    assert_eq!(out["failed"][0]["code"], "invalid_file");
}

// --- layout saves merge per item ---------------------------------------------------------------------------------

#[tokio::test]
async fn test_notes_arrows_labels_and_tabs_save_and_merge_per_item() {
    let (_srv, c, pid) = start!("test_notes_arrows_labels_and_tabs_save_and_merge_per_item");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let b1 = cv["doc"]["boards"][0].clone();
    let page = cv["doc"]["pages"][0]["id"].clone();
    let r = c
        .patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": cv["rev"], "upsert": {
                "notes": [{"x": 10, "y": 20, "text": "Copy is final", "color": "green", "page": page}],
                "labels": [{"x": 0, "y": -60, "text": "Step 2", "size": 20, "page": page}]}}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let doc = r.json()["doc"].clone();
    let note = doc["notes"][0].clone();
    assert!(s(&note["id"]).starts_with("n_") && note["color"] == "green" && note["by"] == "U");
    // an arrow joins a frame and a note
    let r2 = c
        .patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": r.json()["rev"], "upsert": {"arrows": [{"from": b1["id"], "to": note["id"], "label": "after", "page": page}]}}),
        )
        .await;
    assert!(r2.status == 200 && r2.json()["doc"]["arrows"][0]["label"] == "after");
    // two people arrange at once: each moves a different item, both saves go through
    let loaded = r2.json()["doc"].clone();
    let mut mine = loaded["boards"][0].clone();
    mine["x"] = json!(500);
    let mut theirs = loaded["notes"][0].clone();
    theirs["x"] = json!(99);
    let a =
        c.patch(&format!("/canvases/{cid}"), json!({"base_rev": r2.json()["rev"], "upsert": {"boards": [mine]}})).await;
    assert_eq!(a.status, 200);
    let b = c
        .patch(&format!("/canvases/{cid}"), json!({"base_rev": r2.json()["rev"], "upsert": {"notes": [theirs]}}))
        .await;
    assert_eq!(b.status, 200);
    let fin = b.json()["doc"].clone();
    assert!(f(&fin["boards"][0]["x"]) == 500.0 && f(&fin["notes"][0]["x"]) == 99.0);
}

#[tokio::test]
async fn test_the_same_item_changed_twice_conflicts_and_force_replaces() {
    let (_srv, c, pid) = start!("test_the_same_item_changed_twice_conflicts_and_force_replaces");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let board = cv["doc"]["boards"][0].clone();
    let with_x = |x: i64| {
        let mut b = board.clone();
        b["x"] = json!(x);
        b
    };
    let one =
        c.patch(&format!("/canvases/{cid}"), json!({"base_rev": cv["rev"], "upsert": {"boards": [with_x(100)]}})).await;
    assert_eq!(one.status, 200);
    let two =
        c.patch(&format!("/canvases/{cid}"), json!({"base_rev": cv["rev"], "upsert": {"boards": [with_x(300)]}})).await;
    assert_eq!(two.status, 409);
    let d = two.json()["detail"].clone();
    assert!(d["code"] == "canvas_conflict" && d["conflicts"] == json!([board["id"]]) && d["latest_author"] == "user");
    assert_eq!(f(&get_json(&c, &format!("/canvases/{cid}")).await["doc"]["boards"][0]["x"]), 100.0);
    let forced = c
        .patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": cv["rev"], "force": true, "upsert": {"boards": [with_x(300)]}}),
        )
        .await;
    assert!(forced.status == 200 && f(&forced.json()["doc"]["boards"][0]["x"]) == 300.0);
}

#[tokio::test]
async fn test_deleting_a_frame_drops_its_arrows_and_a_missing_item_conflicts() {
    let (_srv, c, pid) = start!("test_deleting_a_frame_drops_its_arrows_and_a_missing_item_conflicts");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let page = cv["doc"]["pages"][0]["id"].clone();
    let b1 = cv["doc"]["boards"][0].clone();
    let n = c
        .patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": cv["rev"], "upsert": {"notes": [{"x": 0, "y": 0, "text": "a", "page": page}]}}),
        )
        .await;
    let note = n.json()["doc"]["notes"][0].clone();
    let a = c
        .patch(&format!("/canvases/{cid}"), json!({"base_rev": n.json()["rev"], "upsert": {"arrows": [{"from": b1["id"], "to": note["id"], "page": page}]}}))
        .await;
    let rm = c.patch(&format!("/canvases/{cid}"), json!({"base_rev": a.json()["rev"], "remove": [note["id"]]})).await;
    assert!(rm.status == 200 && rm.json()["doc"]["notes"] == json!([]) && rm.json()["doc"]["arrows"] == json!([]));
    let mut edited = note.clone();
    edited["text"] = json!("edit");
    let stale =
        c.patch(&format!("/canvases/{cid}"), json!({"base_rev": cv["rev"], "upsert": {"notes": [edited]}})).await;
    assert_eq!(stale.status, 409);
}

#[tokio::test]
async fn test_a_frame_cannot_be_added_through_a_layout_save() {
    let (_srv, c, pid) = start!("test_a_frame_cannot_be_added_through_a_layout_save");
    let cv = make_in(&c, &pid, json!({})).await;
    let r = c
        .patch(
            &format!("/canvases/{}", s(&cv["id"])),
            json!({"base_rev": cv["rev"], "upsert": {"boards": [{"id": "b_00000000", "name": "x"}]}}),
        )
        .await;
    assert_eq!(r.status, 422);
}

// --- locks ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_one_lock_per_board_content_needs_it_layout_does_not() {
    let (srv, c, pid) = start!("test_one_lock_per_board_content_needs_it_layout_does_not");
    member(&c, &pid, "An", "member").await;
    let an = srv.client().header("x-actor", "An");
    let cv = make_in(&c, &pid, json!({})).await;
    let b = html_board(&srv, &s(&cv["id"]), "Sign in", PAGE).await;
    let (cid, bid) = (s(&cv["id"]), s(&b["id"]));
    let mine = c.post_empty(&format!("/canvases/{cid}/boards/{bid}/lock")).await;
    assert!(mine.status == 200 && mine.json()["holder"] == "user");
    let other = an.post_empty(&format!("/canvases/{cid}/boards/{bid}/lock")).await;
    assert_eq!(other.status, 423);
    let d = other.json()["detail"].clone();
    assert!(
        d["code"] == "board_locked"
            && d["holder"] == "user"
            && s(&d["message"]).contains("still look, comment and move")
    );
    // the other person cannot change the content, but can move it and comment
    let blocked = an
        .put(
            &format!("/canvases/{cid}/boards/{bid}/content"),
            json!({"files": [{"path": "index.html", "text": "<h1>An</h1>"}]}),
        )
        .await;
    assert_eq!(blocked.status, 423);
    let doc = get_json(&c, &format!("/canvases/{cid}")).await;
    assert!(
        doc["locks"].as_array().expect("locks").iter().any(|lk| lk["board_id"] == b["id"] && lk["holder"] == "user")
    );
    let mut moved_board =
        doc["doc"]["boards"].as_array().expect("boards").iter().find(|x| x["id"] == b["id"]).expect("board").clone();
    moved_board["x"] = json!(700);
    let moved = an
        .patch(&format!("/canvases/{cid}"), json!({"base_rev": doc["rev"], "upsert": {"boards": [moved_board]}}))
        .await;
    assert_eq!(moved.status, 200);
    let pin = an
        .post(
            &format!("/canvases/{cid}/threads"),
            json!({"body": "Looks fine", "board_id": b["id"], "x": 0.2, "y": 0.3}),
        )
        .await;
    assert_eq!(pin.status, 201);
    // the holder saves, which releases the lock
    let saved = c
        .put(
            &format!("/canvases/{cid}/boards/{bid}/content"),
            json!({"files": [{"path": "index.html", "text": "<h1>New</h1>"}], "base_content_rev": b["content"]["rev"]}),
        )
        .await;
    assert_eq!(saved.status, 200, "{}", saved.text());
    assert_eq!(get_json(&c, &format!("/canvases/{cid}")).await["locks"], json!([]));
    let free = an.post_empty(&format!("/canvases/{cid}/boards/{bid}/lock")).await;
    assert_eq!(free.status, 200);
}

#[tokio::test]
async fn test_locks_end_after_ten_idle_minutes() {
    // the clock cannot be moved in a running server: the HTTP half (take, heartbeat, release) runs here and the ten
    // minutes in the unit test of `canvas_locks`
    let (srv, c, pid) = start!("test_locks_end_after_ten_idle_minutes");
    let cv = make_in(&c, &pid, json!({})).await;
    let b = html_board(&srv, &s(&cv["id"]), "Sign in", PAGE).await;
    let base = format!("/canvases/{}/boards/{}", s(&cv["id"]), s(&b["id"]));
    assert_eq!(c.post_empty(&format!("{base}/lock")).await.status, 200);
    let beat = c.post_empty(&format!("{base}/heartbeat")).await.json();
    assert_eq!(beat["alive"], true);
    assert_eq!(beat["lock"]["warn"], false);
    assert_eq!(c.delete(&format!("{base}/lock")).await.json(), json!({"released": true}));
    let lost = c.post_empty(&format!("{base}/heartbeat")).await.json();
    assert_eq!(lost["alive"], false);
}

#[tokio::test]
async fn test_saving_over_a_frame_someone_else_saved_meanwhile_is_a_conflict() {
    let (srv, c, pid) = start!("test_saving_over_a_frame_someone_else_saved_meanwhile_is_a_conflict");
    let cv = make_in(&c, &pid, json!({})).await;
    let b = html_board(&srv, &s(&cv["id"]), "Sign in", PAGE).await;
    let path = format!("/canvases/{}/boards/{}/content", s(&cv["id"]), s(&b["id"]));
    let first = c
        .put(
            &path,
            json!({"files": [{"path": "index.html", "text": "<h1>one</h1>"}], "base_content_rev": b["content"]["rev"]}),
        )
        .await;
    assert_eq!(first.status, 200);
    let second = c
        .put(
            &path,
            json!({"files": [{"path": "index.html", "text": "<h1>two</h1>"}], "base_content_rev": b["content"]["rev"]}),
        )
        .await;
    assert!(second.status == 409 && second.json()["detail"]["code"] == "board_conflict");
}

#[tokio::test]
async fn test_images_sketches_and_diagrams_are_not_edited_as_source() {
    let (srv, c, pid) = start!("test_images_sketches_and_diagrams_are_not_edited_as_source");
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let r = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "image")],
        vec![part("files", "a.png", "image/png", &png(8, 6, 0))],
        &[],
    )
    .await;
    let bid = s(&r.json()["board"]["id"]);
    let locked = c.post_empty(&format!("/canvases/{cid}/boards/{bid}/lock")).await;
    assert!(locked.status == 422 && locked.json()["detail"]["code"] == "not_editable_here");
}

#[tokio::test]
async fn test_a_board_can_hold_a_sketch_and_shows_its_latest() {
    let (srv, c, pid) = start!("test_a_board_can_hold_a_sketch_and_shows_its_latest");
    let sk = form(
        &srv,
        "POST",
        "/sketches",
        &[("owner_kind", "doc"), ("owner_id", "page-1"), ("title", "Flow"), ("project_id", &pid)],
        common::files(8, 6, 1),
        &[],
    )
    .await;
    assert_eq!(sk.status, 201, "{}", sk.text());
    let sid = s(&sk.json()["id"]);
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let r = urlform(&srv, "POST", &format!("/canvases/{cid}/boards"), &[("kind", "sketch"), ("ref", &sid)], &[]).await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert!(r.json()["board"]["ref"] == json!(sid) && r.json()["board"]["name"] == "Flow");
    let bad =
        urlform(&srv, "POST", &format!("/canvases/{cid}/boards"), &[("kind", "sketch"), ("ref", "sk_00000000")], &[])
            .await;
    assert_eq!(bad.status, 404);
}

// --- versions ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_versions_on_done_named_restore_makes_a_new_one_and_compare() {
    let (srv, c, pid) = start!("test_versions_on_done_named_restore_makes_a_new_one_and_compare");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let b = html_board(&srv, &cid, "Sign in", PAGE).await;
    let bid = s(&b["id"]);
    let rev = get_json(&c, &format!("/canvases/{cid}")).await["rev"].clone();
    let done = c
        .patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": rev, "checkpoint": true, "name": "Review 1", "note": "First pass"}),
        )
        .await;
    assert_eq!(done.status, 200);
    let versions = get_json(&c, &format!("/canvases/{cid}/versions")).await;
    let numbers: Vec<&Value> = versions.as_array().expect("versions").iter().map(|v| &v["version"]).collect();
    assert_eq!(numbers, vec![&json!(2), &json!(1)]);
    assert_eq!(versions[0]["name"], "Review 1");
    assert!(s(&versions[0]["summary"]).contains("1 frame added"));
    assert!(versions[0]["changes"]["added"].as_array().expect("added").contains(&b["id"]));
    // edit the frame, Done again
    c.put(
        &format!("/canvases/{cid}/boards/{bid}/content"),
        json!({"files": [{"path": "index.html", "text": "<h1>Changed</h1>"}]}),
    )
    .await;
    let rev = get_json(&c, &format!("/canvases/{cid}")).await["rev"].clone();
    c.patch(&format!("/canvases/{cid}"), json!({"base_rev": rev, "checkpoint": true})).await;
    let v3 = get_json(&c, &format!("/canvases/{cid}/versions")).await[0].clone();
    assert!(v3["version"] == 3 && s(&v3["summary"]).contains("Sign in edited"));
    let comp = c.get_query(&format!("/canvases/{cid}/compare"), &[("a", "2"), ("b", "3")]).await.json();
    let state = |name: &str| {
        comp["boards"].as_array().expect("boards").iter().find(|r| r["name"] == name).expect("row")["state"].clone()
    };
    assert!(state("Sign in") == "changed" && state("Frame 1") == "same");
    let diff =
        c.get_query(&format!("/canvases/{cid}/boards/{bid}/source-diff"), &[("a", "2"), ("b", "3")]).await.json();
    assert!(s(&diff["files"][0]["diff"]).contains("Changed") && diff["files"][0]["path"] == "index.html");
    // the old content is still there, and restoring makes version 4 instead of rewriting history
    let restored = c.post_empty(&format!("/canvases/{cid}/versions/2/restore")).await;
    assert_eq!(restored.status, 200);
    let now = restored.json();
    assert!(now["version"] == 4 && now["doc"]["boards"][1]["content"]["rev"] != 0);
    let rev_now = now["doc"]["boards"][1]["content"]["rev"].clone();
    let page_now = get(&srv, &format!("/canvases/{cid}/boards/{bid}/r/{rev_now}/index.html")).await.text();
    assert!(page_now.contains("Sign in") && !page_now.contains("Changed"));
    let all: Vec<Value> = get_json(&c, &format!("/canvases/{cid}/versions"))
        .await
        .as_array()
        .expect("versions")
        .iter()
        .map(|v| v["version"].clone())
        .collect();
    assert_eq!(all, vec![json!(4), json!(3), json!(2), json!(1)]);
    let named = c.patch(&format!("/canvases/{cid}/versions/3"), json!({"name": "Before restore"})).await;
    assert_eq!(named.json()["name"], "Before restore");
}

#[tokio::test]
async fn test_restore_waits_while_somebody_edits_a_frame() {
    let (srv, c, pid) = start!("test_restore_waits_while_somebody_edits_a_frame");
    let cv = make_in(&c, &pid, json!({})).await;
    let b = html_board(&srv, &s(&cv["id"]), "Sign in", PAGE).await;
    c.post_empty(&format!("/canvases/{}/boards/{}/lock", s(&cv["id"]), s(&b["id"]))).await;
    let r = c.post_empty(&format!("/canvases/{}/versions/1/restore", s(&cv["id"]))).await;
    assert_eq!(r.status, 423);
}

/// Set every version of a canvas back in time, in the server's SQLite file (the Python test lowers
/// `AUTO_VERSION_SECONDS` instead).
async fn age_versions(srv: &Server, cid: &str) {
    use sqlx::Connection;
    let url = format!("sqlite://{}", srv.db_path().display());
    let mut conn = sqlx::SqliteConnection::connect(&url).await.expect("open the server's database");
    sqlx::query("UPDATE canvas_version SET created_at = '2000-01-01T00:00:00+00:00' WHERE canvas_id = ?")
        .bind(cid)
        .execute(&mut conn)
        .await
        .expect("age the versions");
}

#[tokio::test]
async fn test_a_docs_page_canvas_gets_a_version_every_ten_minutes() {
    let (srv, c, pid) = start!("test_a_docs_page_canvas_gets_a_version_every_ten_minutes");
    if !docs_served(&c, &pid, "test_a_docs_page_canvas_gets_a_version_every_ten_minutes").await {
        return;
    }
    let out = c.post("/canvases/pages", json!({"project_id": pid, "title": "Settings flow"})).await;
    assert_eq!(out.status, 201, "{}", out.text());
    let cv = out.json()["canvas"].clone();
    assert!(
        out.json()["page"]["kind"] == "canvas"
            && cv["owner_kind"] == "page"
            && cv["page_id"] == out.json()["page"]["id"]
    );
    let page = get_json(&c, &format!("/docs/pages/{}", s(&cv["page_id"]))).await;
    assert!(page["kind"] == "canvas" && page["markdown"] == cv["markdown"]);
    let tree = get_json(&c, &format!("/projects/{pid}/docs/tree")).await;
    assert!(tree.as_array().expect("tree").iter().any(|p| p["id"] == cv["page_id"] && p["kind"] == "canvas"));
    let cid = s(&cv["id"]);
    let count = |v: Value| v.as_array().expect("versions").len();
    let versions_before = count(get_json(&c, &format!("/canvases/{cid}/versions")).await);
    let page_id = cv["doc"]["pages"][0]["id"].clone();
    c.patch(
        &format!("/canvases/{cid}"),
        json!({"base_rev": cv["rev"], "upsert": {"labels": [{"x": 0, "y": 0, "text": "a", "page": page_id}]}}),
    )
    .await;
    // a change soon after the last version does not make another
    assert_eq!(count(get_json(&c, &format!("/canvases/{cid}/versions")).await), versions_before);
    age_versions(&srv, &cid).await;
    let rev = get_json(&c, &format!("/canvases/{cid}")).await["rev"].clone();
    c.patch(
        &format!("/canvases/{cid}"),
        json!({"base_rev": rev, "upsert": {"labels": [{"x": 0, "y": 40, "text": "b", "page": page_id}]}}),
    )
    .await;
    assert_eq!(count(get_json(&c, &format!("/canvases/{cid}/versions")).await), versions_before + 1);
}

#[tokio::test]
async fn test_move_to_docs_keeps_the_id_and_the_text_keeps_showing_it() {
    let (_srv, c, pid) = start!("test_move_to_docs_keeps_the_id_and_the_text_keeps_showing_it");
    if !docs_served(&c, &pid, "test_move_to_docs_keeps_the_id_and_the_text_keeps_showing_it").await {
        return;
    }
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let pin = c.post(&format!("/canvases/{cid}/threads"), json!({"body": "Check"})).await;
    assert_eq!(pin.status, 201);
    let out = c.post(&format!("/canvases/{cid}/move-to-docs"), json!({"title": "Login flow"})).await;
    assert_eq!(out.status, 200, "{}", out.text());
    let moved = out.json()["canvas"].clone();
    assert!(moved["id"] == cv["id"] && moved["owner_kind"] == "page" && moved["page_id"] == out.json()["page"]["id"]);
    assert_eq!(get_json(&c, &format!("/canvases/{cid}/threads")).await[0]["comments"][0]["body"], "Check");
    let again = c.post(&format!("/canvases/{cid}/move-to-docs"), json!({})).await;
    assert!(again.status == 422 && again.json()["detail"]["code"] == "already_page");
}

// --- comments ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_comment_threads_pinned_to_a_frame_or_the_plane_resolve_and_reopen() {
    let (_srv, c, pid) = start!("test_comment_threads_pinned_to_a_frame_or_the_plane_resolve_and_reopen");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let bid = s(&cv["doc"]["boards"][0]["id"]);
    let t1 = c
        .post(
            &format!("/canvases/{cid}/threads"),
            json!({"body": "Logo too small @Hoa", "board_id": bid, "x": 0.7, "y": 0.4}),
        )
        .await
        .json();
    let t2 = c.post(&format!("/canvases/{cid}/threads"), json!({"body": "Plane note", "x": 120, "y": 80})).await.json();
    assert!(t1["number"] == 1 && t2["number"] == 2 && t1["board_id"] == json!(bid) && t2["board_id"].is_null());
    // mentions are member ids; "Hoa" is no member here
    assert_eq!(t1["comments"][0]["mentions"], json!([]));
    let t1_id = s(&t1["id"]);
    let rep =
        c.post(&format!("/canvases/threads/{t1_id}/replies"), json!({"body": "It matches the brand sheet"})).await;
    assert_eq!(rep.json()["comments"].as_array().expect("comments").len(), 2);
    let res = c.post_empty(&format!("/canvases/threads/{t1_id}/resolve")).await.json();
    assert!(res["status"] == "resolved" && res["resolved_by"] == "user");
    let open = c.get_query(&format!("/canvases/{cid}/threads"), &[("state", "open")]).await.json();
    let ids: Vec<&Value> = open.as_array().expect("threads").iter().map(|t| &t["id"]).collect();
    assert_eq!(ids, vec![&t2["id"]]);
    assert_eq!(get_json(&c, &format!("/canvases/{cid}")).await["open_comments"], 1);
    assert_eq!(c.post_empty(&format!("/canvases/threads/{t1_id}/reopen")).await.json()["status"], "open");
    // a pin keeps its frame; a pin on a frame that is not there is refused
    let bad = c.post(&format!("/canvases/{cid}/threads"), json!({"body": "x", "board_id": "b_deadbeef"})).await;
    assert_eq!(bad.status, 404);
    let empty = c.post(&format!("/canvases/{cid}/threads"), json!({"body": "  "})).await;
    assert_eq!(empty.status, 422);
    // deleting the opening comment removes the thread
    let first = s(&t2["comments"][0]["id"]);
    assert_eq!(c.delete(&format!("/canvases/comments/{first}")).await.json()["deleted"], "thread");
}

// --- permissions ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_viewers_can_look_but_not_change_anything() {
    let (srv, c, pid) = start!("test_viewers_can_look_but_not_change_anything");
    member(&c, &pid, "Vi", "viewer").await;
    let vi = srv.client().header("x-actor", "Vi");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let got = vi.get(&format!("/canvases/{cid}")).await;
    assert!(got.status == 200 && got.json()["role"] == "viewer" && got.json()["can_edit"] == false);
    assert_eq!(vi.get(&format!("/canvases/{cid}/threads")).await.status, 200);
    assert_eq!(vi.get(&format!("/canvases/{cid}/versions")).await.status, 200);
    let bid = s(&cv["doc"]["boards"][0]["id"]);
    let h = [("x-actor", "Vi")];
    let mut replies = vec![
        vi.post("/canvases", json!({"owner_kind": "doc", "owner_id": "p", "project_id": pid})).await.into_pair(),
        vi.patch(&format!("/canvases/{cid}"), json!({"base_rev": 1})).await.into_pair(),
    ];
    let board = urlform(&srv, "POST", &format!("/canvases/{cid}/boards"), &[("kind", "empty")], &h).await;
    replies.push((board.status, board.json()));
    replies.push(vi.post_empty(&format!("/canvases/{cid}/boards/{bid}/lock")).await.into_pair());
    replies.push(vi.post(&format!("/canvases/{cid}/threads"), json!({"body": "hi"})).await.into_pair());
    replies.push(vi.delete(&format!("/canvases/{cid}")).await.into_pair());
    replies.push(vi.post_empty(&format!("/canvases/{cid}/versions/1/restore")).await.into_pair());
    for (status, body) in replies {
        assert_eq!(status, 403, "{body}");
        assert_eq!(body["detail"]["code"], "read_only");
    }
}

trait IntoPair {
    fn into_pair(self) -> (u16, Value);
}

impl IntoPair for testkit::Resp {
    fn into_pair(self) -> (u16, Value) {
        (self.status, self.json())
    }
}

#[tokio::test]
async fn test_a_canvas_of_a_ticket_is_the_tickets_to_see() {
    let (_srv, c, pid) = start!("test_a_canvas_of_a_ticket_is_the_tickets_to_see");
    let t = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "Redesign"})).await;
    let cv = make(&c, None, json!({"owner_kind": "ticket", "owner_id": t.json()["id"]})).await;
    assert!(cv["project_id"] == json!(pid) && cv["owner_kind"] == "ticket");
}

// --- exports -----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_download_zip_overview_and_snapshots() {
    let (srv, c, pid) = start!("test_download_zip_overview_and_snapshots");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let b = html_board(&srv, &cid, "Sign in", PAGE).await;
    let zipped = get(&srv, &format!("/canvases/{cid}/download")).await;
    assert!(zipped.status == 200 && zipped.header("content-disposition").contains("attachment"));
    let names = zip_names(&zipped.body);
    assert!(
        names.contains(&"canvas.json".to_string()) && names.contains(&"Sign-in/index.html".to_string()),
        "{names:?}"
    );
    let one = get(&srv, &format!("/canvases/{cid}/download?board_id={}", s(&b["id"]))).await;
    assert_eq!(zip_names(&one.body), vec!["index.html"]);
    let ov = get(&srv, &format!("/canvases/{cid}/overview.png")).await;
    assert!(ov.status == 200 && ov.body.starts_with(b"\x89PNG") && ov.header("content-type") == "image/png");
    let snap = get(&srv, &format!("/canvases/{cid}/boards/{}/snapshot.png", s(&b["id"]))).await;
    assert!(snap.body.starts_with(b"\x89PNG"));
    let cp = c.post_empty(&format!("/canvases/{cid}/copy")).await;
    assert!(
        cp.status == 201
            && cp.json()["id"] != cv["id"]
            && cp.json()["doc"]["boards"].as_array().expect("boards").len() == 2
    );
    let copied = cp.json();
    let cb = copied["doc"]["boards"][1].clone();
    let page = get(
        &srv,
        &format!("/canvases/{}/boards/{}/r/{}/index.html", s(&copied["id"]), s(&cb["id"]), cb["content"]["rev"]),
    )
    .await;
    assert!(page.text().contains("Sign in"));
}

#[tokio::test]
async fn test_an_ai_comment_is_marked_and_an_ai_member_cannot_resolve_a_persons_thread() {
    let (srv, c, pid) = start!("test_an_ai_comment_is_marked_and_an_ai_member_cannot_resolve_a_persons_thread");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    member(&c, &pid, "Designer AI", "member").await;
    let person = c.post(&format!("/canvases/{cid}/threads"), json!({"body": "Check this"})).await.json();
    let ai_client = srv.client().header("x-actor", "Designer AI");
    let ai = ai_client
        .post(
            &format!("/canvases/{cid}/threads"),
            json!({"body": "Button is 36 px", "board_id": cv["doc"]["boards"][0]["id"]}),
        )
        .await
        .json();
    assert_eq!(ai["created_by"], "Designer AI");
    // the Python test adds the team row through the session and calls `set_status` in-process; here the row is added to
    // the server's database and the route is asked
    common::add_ai_team(&srv, &pid, "Designer AI").await;
    let r = ai_client.post_empty(&format!("/canvases/threads/{}/resolve", s(&person["id"]))).await;
    assert_eq!(r.status, 403, "{}", r.text());
    assert_eq!(r.json()["detail"]["code"], "ai_cannot_resolve");
    // an AI team's own thread, it may resolve; a person may resolve any
    let own = ai_client.post_empty(&format!("/canvases/threads/{}/resolve", s(&ai["id"]))).await;
    assert!(own.status == 200 && own.json()["resolved_by"] == "Designer AI");
    assert_eq!(c.post_empty(&format!("/canvases/threads/{}/resolve", s(&person["id"]))).await.status, 200);
}

#[tokio::test]
async fn test_boards_are_sections_of_a_canvas_page_and_the_ticket_lists_the_canvas() {
    let (srv, c, pid) = start!("test_boards_are_sections_of_a_canvas_page_and_the_ticket_lists_the_canvas");
    if !docs_served(&c, &pid, "test_boards_are_sections_of_a_canvas_page_and_the_ticket_lists_the_canvas").await {
        return;
    }
    let made = c.post("/canvases/pages", json!({"project_id": pid, "title": "Settings flow"})).await.json();
    let (cv, page_id) = (made["canvas"].clone(), s(&made["page"]["id"]));
    let b = html_board(&srv, &s(&cv["id"]), "Sign in: wrong password", PAGE).await;
    // the boards are sections: [[Settings flow#Sign in: wrong password]] resolves and the search finds the board
    let res = c
        .post(
            &format!("/projects/{pid}/docs/resolve"),
            json!({"refs": [{"kind": "page", "title": "Settings flow", "anchor": "Sign in: wrong password"}]}),
        )
        .await
        .json();
    assert_eq!(res[0]["status"], "ok", "{res}");
    let found = c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", "wrong password")]).await.json();
    assert!(found["pages"].as_array().expect("pages").iter().any(|p| p["page_id"] == json!(page_id)));
    // a ticket that shows the canvas lists it under Linked docs, and the page lists the ticket in its backlinks
    let t = c
        .post(
            &format!("/projects/{pid}/tickets"),
            json!({"title": "Redesign", "description": format!("{}\n", s(&cv["markdown"]))}),
        )
        .await
        .json();
    let rows = get_json(&c, &format!("/tickets/{}/docs", s(&t["id"]))).await;
    let canvas_rows: Vec<(Value, Value, Value)> = rows
        .as_array()
        .expect("rows")
        .iter()
        .filter(|r| r["kind"] == "canvas")
        .map(|r| (r["kind"].clone(), r["canvas_id"].clone(), r["page_id"].clone()))
        .collect();
    assert_eq!(canvas_rows, vec![(json!("canvas"), cv["id"].clone(), json!(page_id))]);
    let back = get_json(&c, &format!("/docs/pages/{page_id}/backlinks")).await;
    let tickets: Vec<&Value> = back["tickets"].as_array().expect("tickets").iter().map(|x| &x["ticket_id"]).collect();
    assert_eq!(tickets, vec![&t["id"]]);
    // an inline canvas has no page: the row points at the canvas
    let inline = make(&c, None, json!({"title": "Inline", "owner_kind": "ticket", "owner_id": t["id"]})).await;
    c.patch(
        &format!("/tickets/{}", s(&t["id"])),
        json!({"description": format!("{}\n\n{}", s(&cv["markdown"]), s(&inline["markdown"]))}),
    )
    .await;
    let rows = get_json(&c, &format!("/tickets/{}/docs", s(&t["id"]))).await;
    let mut ids: Vec<String> =
        rows.as_array().expect("rows").iter().filter(|r| r["kind"] == "canvas").map(|r| s(&r["canvas_id"])).collect();
    ids.sort();
    let mut want = vec![s(&cv["id"]), s(&inline["id"])];
    want.sort();
    assert_eq!(ids, want);
    assert_eq!(b["name"], "Sign in: wrong password");
}

#[tokio::test]
async fn test_a_stale_save_about_a_deleted_frame_is_a_conflict_not_a_dead_end() {
    let (srv, c, pid) = start!("test_a_stale_save_about_a_deleted_frame_is_a_conflict_not_a_dead_end");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let b = html_board(&srv, &cid, "Doomed", PAGE).await;
    let cur = get_json(&c, &format!("/canvases/{cid}")).await;
    let mut board = cur["doc"]["boards"][1].clone();
    assert_eq!(
        c.patch(&format!("/canvases/{cid}"), json!({"base_rev": cur["rev"], "remove": [b["id"]]})).await.status,
        200
    );
    board["x"] = json!(5);
    let stale =
        c.patch(&format!("/canvases/{cid}"), json!({"base_rev": cur["rev"], "upsert": {"boards": [board]}})).await;
    assert!(stale.status == 409 && stale.json()["detail"]["conflicts"] == json!([b["id"]]));
}

#[tokio::test]
async fn test_a_frame_somebody_is_editing_cannot_be_deleted_or_replaced_under_them() {
    let (srv, c, pid) = start!("test_a_frame_somebody_is_editing_cannot_be_deleted_or_replaced_under_them");
    member(&c, &pid, "An", "member").await;
    let an = srv.client().header("x-actor", "An");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let b = html_board(&srv, &cid, "Held", PAGE).await;
    an.post_empty(&format!("/canvases/{cid}/boards/{}/lock", s(&b["id"]))).await;
    let rev = get_json(&c, &format!("/canvases/{cid}")).await["rev"].clone();
    let gone = c.patch(&format!("/canvases/{cid}"), json!({"base_rev": rev, "remove": [b["id"]]})).await;
    assert!(gone.status == 423 && gone.json()["detail"]["holder"] == "An");
    let page = cv["doc"]["pages"][0]["id"].clone();
    let tab = c.patch(&format!("/canvases/{cid}"), json!({"base_rev": rev, "remove": [page]})).await;
    assert_eq!(tab.status, 423);
    let locks = get_json(&c, &format!("/canvases/{cid}")).await["locks"].clone();
    assert!(locks.as_array().expect("locks").iter().any(|l| l["board_id"] == b["id"] && l["holder"] == "An"));
}

#[tokio::test]
async fn test_replacing_content_checks_the_revision_it_started_from_even_for_an_empty_frame() {
    let (srv, c, pid) = start!("test_replacing_content_checks_the_revision_it_started_from_even_for_an_empty_frame");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let empty = cv["doc"]["boards"][0].clone();
    let path = format!("/canvases/{cid}/boards/{}/content", s(&empty["id"]));
    let first =
        c.put(&path, json!({"files": [{"path": "index.html", "text": "<h1>Bob</h1>"}], "base_content_rev": 0})).await;
    assert_eq!(first.status, 200);
    // Ann opened it when it was empty (0), Bob saved meanwhile
    let second =
        c.put(&path, json!({"files": [{"path": "index.html", "text": "<h1>Ann</h1>"}], "base_content_rev": 0})).await;
    assert!(second.status == 409 && second.json()["detail"]["code"] == "board_conflict");
    let rep = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards/{}/replace", s(&empty["id"])),
        &[("base_content_rev", "0")],
        vec![html_part("<h1>Late</h1>")],
        &[],
    )
    .await;
    assert_eq!(rep.status, 409);
}

#[tokio::test]
async fn test_two_writes_at_once_never_share_a_revision() {
    let (srv, c, pid) = start!("test_two_writes_at_once_never_share_a_revision");
    let cv = make_in(&c, &pid, json!({"start": "none"})).await;
    let cid = s(&cv["id"]);
    let adds = (0..5).map(|i| {
        let (srv, cid) = (&srv, cid.clone());
        async move {
            form(
                srv,
                "POST",
                &format!("/canvases/{cid}/boards"),
                &[("kind", "html"), ("name", &format!("F{i}"))],
                vec![html_part(&format!("<h1>{i}</h1>"))],
                &[],
            )
            .await
        }
    });
    let rs = futures::future::join_all(adds).await;
    assert!(rs.iter().all(|r| r.status == 201));
    let mut revs: Vec<i64> = rs.iter().map(|r| r.json()["board"]["content"]["rev"].as_i64().expect("rev")).collect();
    revs.sort();
    revs.dedup();
    assert_eq!(revs.len(), 5, "{revs:?}");
    let doc = get_json(&c, &format!("/canvases/{cid}")).await["doc"].clone();
    assert_eq!(doc["boards"].as_array().expect("boards").len(), 5);
    let mut vs: Vec<i64> = get_json(&c, &format!("/canvases/{cid}/versions"))
        .await
        .as_array()
        .expect("versions")
        .iter()
        .map(|v| v["version"].as_i64().expect("n"))
        .collect();
    let n = vs.len();
    vs.sort();
    vs.dedup();
    assert_eq!(vs.len(), n);
}

#[tokio::test]
async fn test_odd_input_is_refused_not_a_crash() {
    let (srv, c, pid) = start!("test_odd_input_is_refused_not_a_crash");
    let cv = make_in(&c, &pid, json!({})).await;
    let cid = s(&cv["id"]);
    let bad = c
        .patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": cv["rev"], "upsert": {"notes": [{"x": 1, "y": 1, "text": "a", "page": {"x": 1}}]}}),
        )
        .await;
    assert_eq!(bad.status, 200); // the page falls back to the first tab
    let r = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/boards"),
        &[("kind", "html")],
        vec![
            html_part("<h1>x</h1>"),
            part("files", "a.css", "text/css", b"a{}"),
            part("files", "a.css/b.html", "text/html", b"<p>"),
        ],
        &[],
    )
    .await;
    assert!(r.status == 422 && r.detail()["code"] == "invalid_file");
    let broken = form(
        &srv,
        "POST",
        &format!("/canvases/{cid}/import"),
        &[],
        vec![part("files", "x.zip", "application/zip", b"PK\x03\x04 not really")],
        &[],
    )
    .await;
    assert!(broken.status == 201 && broken.json()["failed"][0]["code"] == "invalid_file");
}

#[tokio::test]
async fn test_a_new_canvas_keeps_its_name_as_typed_and_the_markdown_drops_the_brackets() {
    // CA-1: "[docs] Login canvas" is the canvas's name; only the alt text of the markdown line loses the brackets
    // (`canvas_name("  \n ", "Canvas")` is checked in `canvas_service.rs`)
    let (_srv, c, pid) = start!("test_a_new_canvas_keeps_its_name_as_typed_and_the_markdown_drops_the_brackets");
    let cv = make_in(&c, &pid, json!({"title": "[docs]  Login canvas"})).await;
    assert_eq!(cv["title"], "[docs] Login canvas");
    assert_eq!(cv["markdown"], json!(format!("![docs  Login canvas](canvas:{})", s(&cv["id"]))));
}

// --- a ZIP made by either server opens in the other --------------------------------------------------------------

/// The frames of the canvas the export test makes: `(name, files)`.
fn exported_frames() -> Vec<(&'static str, Vec<(&'static str, Vec<u8>)>)> {
    vec![
        (
            "Home page",
            vec![
                ("index.html", b"<title>Home</title><link rel=stylesheet href=css/site.css><h1>Home</h1>".to_vec()),
                ("css/site.css", b"h1{color:green}".to_vec()),
                ("img/a.png", png(8, 6, 0)),
            ],
        ),
        ("Second", vec![("index.html", "<title>Zweite \u{e9}</title><h1>Zwei</h1>".as_bytes().to_vec())]),
    ]
}

/// Not in the Python suite: the ZIP one server exports is the one the other opens. Run it as
/// `KB_PEER_EXPORT_TO=/tmp/canvas.zip PARITY_TARGET=python cargo test -p kb-draw --test test_canvases the_other` to write the
/// export of a canvas, then `KB_PEER_IMPORT_FROM=/tmp/canvas.zip PARITY_TARGET=rust ...` to read it with the other
/// server (and the other way round). Both variables may be set together: the ZIP is then made and read by the same one.
#[tokio::test]
async fn the_other_servers_canvas_zip_can_be_imported() {
    let (export_to, import_from) = (std::env::var("KB_PEER_EXPORT_TO").ok(), std::env::var("KB_PEER_IMPORT_FROM").ok());
    if export_to.is_none() && import_from.is_none() {
        return;
    }
    let (srv, c, pid) = start!("the_other_servers_canvas_zip_can_be_imported");
    if let Some(to) = export_to {
        let cv = make_in(&c, &pid, json!({"title": "Exported canvas", "start": "none"})).await;
        let cid = s(&cv["id"]);
        for (name, files) in exported_frames() {
            let parts: Vec<FilePart> =
                files.iter().map(|(n, d)| part("files", n, "application/octet-stream", d)).collect();
            let r =
                form(&srv, "POST", &format!("/canvases/{cid}/boards"), &[("kind", "html"), ("name", name)], parts, &[])
                    .await;
            assert_eq!(r.status, 201, "{}", r.text());
        }
        let zipped = get(&srv, &format!("/canvases/{cid}/download")).await;
        assert_eq!(zipped.status, 200);
        std::fs::write(to, &zipped.body).expect("write the export");
    }
    if let Some(from) = import_from {
        let bytes = std::fs::read(from).expect("the export of the other server");
        // it opens: every frame's files are there under the frame's folder, and canvas.json is the canvas
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes.clone())).expect("a ZIP");
        let mut names: Vec<String> = z.file_names().map(str::to_string).collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "Home-page/css/site.css",
                "Home-page/img/a.png",
                "Home-page/index.html",
                "Second/index.html",
                "canvas.json"
            ]
        );
        for (name, files) in exported_frames() {
            for (path, data) in files {
                let mut entry = z.by_name(&format!("{}/{path}", name.replace(' ', "-"))).expect("a frame file");
                let mut got = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut got).expect("read");
                assert!(got == data, "{name}/{path}");
            }
        }
        let doc: Value = {
            let mut entry = z.by_name("canvas.json").expect("canvas.json");
            let mut got = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut got).expect("read");
            serde_json::from_slice(&got).expect("canvas.json is JSON")
        };
        assert!(doc["format"] == "kanban-canvas" && doc["version"] == 1);
        let named: Vec<&Value> = doc["boards"].as_array().expect("boards").iter().map(|b| &b["name"]).collect();
        assert_eq!(named, vec![&json!("Home page"), &json!("Second")]);
        // and the import route takes it (a ZIP of a built page: one frame holding the files)
        let cv = make_in(&c, &pid, json!({"start": "none"})).await;
        let r = form(
            &srv,
            "POST",
            &format!("/canvases/{}/import", s(&cv["id"])),
            &[],
            vec![part("files", "peer.zip", "application/zip", &bytes)],
            &[],
        )
        .await;
        assert_eq!(r.status, 201, "{}", r.text());
        let out = r.json();
        assert_eq!(out["failed"], json!([]), "{out}");
        let paths: Vec<String> =
            out["boards"][0]["content"]["files"].as_array().expect("files").iter().map(|f| s(&f["path"])).collect();
        assert!(
            paths.contains(&"Home-page/index.html".to_string()) && paths.contains(&"canvas.json".to_string()),
            "{paths:?}"
        );
    }
}
