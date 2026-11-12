//! `tests/test_sketches.py`, and one check per route of `api/sketches.py` that both servers answer the same status
//! and JSON for the success case and for each error.

mod common;

use common::{FilePart, files, form, member, pid, png, raw_get, source};
use serde_json::{Value, json};
use testkit::{Server, normalize, skip_unless_available};

const MAX_BYTES: usize = 10 * 1024 * 1024;

/// The `(type, loc)` of each entry of a 422 validation list.
fn problems(detail: &Value) -> Vec<(String, Value)> {
    let list = detail.as_array().unwrap_or_else(|| panic!("a validation list, got {detail}"));
    list.iter().map(|e| (e["type"].as_str().unwrap_or("").to_string(), e["loc"].clone())).collect()
}

/// A `detail` of a `DocsError` answer without its `request_id`.
fn detail(r: &common::Reply) -> Value {
    let mut d = r.detail();
    let id = d["request_id"].as_str().unwrap_or("").to_string();
    assert_eq!(id.len(), 12, "request_id of {d}");
    assert_eq!(r.header("x-request-id"), id);
    d.as_object_mut().expect("detail is an object").remove("request_id");
    d
}

/// `make(c, pid, owner_kind, owner_id, **kw)`.
async fn make(s: &Server, pid: Option<&str>, owner_kind: &str, owner_id: &str) -> Value {
    let mut fields = vec![("owner_kind", owner_kind), ("owner_id", owner_id), ("title", "Run card")];
    if let Some(pid) = pid {
        fields.push(("project_id", pid));
    }
    let r = form(s, "POST", "/sketches", &fields, files(8, 6, 1), &[]).await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

fn doc_fields<'a>(pid: &'a str, owner_id: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![("owner_kind", "doc"), ("owner_id", owner_id), ("project_id", pid)]
}

fn uploads(s: &Server) -> std::path::PathBuf {
    s.uploads_dir().join("sketches")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_read_and_files_are_in_the_uploads_folder() {
    if !skip_unless_available("test_create_read_and_files_are_in_the_uploads_folder") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    assert!(id.starts_with("sk_") && id.len() == 11);
    assert!(sk["version"] == 1 && sk["title"] == "Run card");
    assert_eq!((sk["width"].clone(), sk["height"].clone(), sk["layer_count"].clone()), (json!(8), json!(6), json!(1)));
    assert!(sk["owner_kind"] == "doc" && sk["project_id"] == json!(pid));
    assert_eq!(sk["png_url"], json!(format!("/uploads/sketches/{id}.png")));
    // stored like any attachment: inside the uploads folder, so a backup of the data folder carries them
    let folder = uploads(&s);
    assert_eq!(std::fs::read(folder.join(format!("{id}.png"))).expect("png file"), png(8, 6, 0));
    let stored: Value = serde_json::from_slice(&std::fs::read(folder.join(format!("{id}.sketch.json"))).expect("source file")).expect("json");
    assert!(!stored["layers"].as_array().expect("layers").is_empty());
    let got = raw_get(&s, &format!("/sketches/{id}/png"), &[]).await;
    assert!(got.status == 200 && got.header("content-type") == "image/png");
    assert_eq!(got.body, png(8, 6, 0));
    let src = c.get(&format!("/sketches/{id}/source")).await;
    assert_eq!(src.json()["format"], "kanban-sketch");
    // the stored PNG is also served by the generic uploads route, so it works wherever an image does
    let up = raw_get(&s, sk["png_url"].as_str().expect("png_url"), &[]).await;
    assert!(up.status == 200 && up.header("content-type") == "image/png");
}

#[tokio::test]
async fn test_png_answers_304_for_an_unchanged_version() {
    if !skip_unless_available("test_png_answers_304_for_an_unchanged_version") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    let first = raw_get(&s, &format!("/sketches/{id}/png"), &[]).await;
    let again = raw_get(&s, &format!("/sketches/{id}/png"), &[("if-none-match", &first.header("etag"))]).await;
    assert_eq!(again.status, 304);
}

#[tokio::test]
async fn test_owner_decides_the_project() {
    if !skip_unless_available("test_owner_decides_the_project") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let t = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "Bug"})).await;
    let tid = t.json()["id"].as_str().expect("ticket id").to_string();
    let sk = make(&s, None, "ticket", &tid).await;
    assert_eq!(sk["project_id"], json!(pid));
    let listed = c.get_query("/sketches", &[("owner_kind", "ticket"), ("owner_id", &tid)]).await.json();
    let ids: Vec<Value> = listed.as_array().expect("list").iter().map(|x| x["id"].clone()).collect();
    assert_eq!(ids, vec![sk["id"].clone()]);
    assert_eq!(c.get_query("/sketches", &[("owner_kind", "doc"), ("owner_id", &tid)]).await.json(), json!([]));
}

#[tokio::test]
async fn test_bad_owner_and_missing_project() {
    if !skip_unless_available("test_bad_owner_and_missing_project") {
        return;
    }
    let s = Server::start().await;
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "pizza"), ("owner_id", "x")], files(8, 6, 1), &[]).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "invalid_owner");
    let r = form(
        &s,
        "POST",
        "/sketches",
        &[("owner_kind", "doc"), ("owner_id", "x"), ("project_id", "nope")],
        files(8, 6, 1),
        &[],
    )
    .await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn test_update_bumps_version_and_replaces_the_files() {
    if !skip_unless_available("test_update_bumps_version_and_replaces_the_files") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "1"), ("title", "Renamed")], files(16, 12, 2), &[]).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let out = r.json();
    assert!(out["version"] == 2 && out["title"] == "Renamed");
    assert_eq!((out["width"].clone(), out["height"].clone(), out["layer_count"].clone()), (json!(16), json!(12), json!(2)));
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &[]).await.body, png(16, 12, 0));
    let tmp: Vec<_> = std::fs::read_dir(uploads(&s))
        .expect("sketches folder")
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(tmp.is_empty());
}

#[tokio::test]
async fn test_conflict_when_someone_saved_in_the_meantime() {
    if !skip_unless_available("test_conflict_when_someone_saved_in_the_meantime") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Mia", "member").await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    // Mia saves version 2 while the first person still holds version 1
    let ok = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "1")], files(10, 10, 1), &[("x-actor", "Mia")]).await;
    assert_eq!(ok.status, 200);
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "1")], files(20, 20, 1), &[]).await;
    assert_eq!(r.status, 409);
    let d = r.json()["detail"].clone();
    assert_eq!(d["code"], "sketch_conflict");
    assert!(d["latest_version"] == 2 && d["latest_author"] == "Mia");
    // nothing of the rejected save was written
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &[]).await.body, png(10, 10, 0));
    // "Replace theirs"
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "1"), ("force", "true")], files(20, 20, 1), &[]).await;
    assert!(r.status == 200 && r.json()["version"] == 3);
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &[]).await.body, png(20, 20, 0));
}

#[tokio::test]
async fn test_save_as_copy_leaves_the_first_alone() {
    if !skip_unless_available("test_save_as_copy_leaves_the_first_alone") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    // an unsaved state of the editor is saved as a copy
    let r = form(&s, "POST", &format!("/sketches/{id}/copy"), &[("title", "Second")], files(30, 20, 1), &[]).await;
    assert_eq!(r.status, 201);
    let cp = r.json();
    assert!(cp["id"] != sk["id"] && cp["version"] == 1 && cp["title"] == "Second");
    assert!(cp["owner_id"] == sk["owner_id"] && cp["project_id"] == json!(pid));
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &[]).await.body, png(8, 6, 0));
    let cid = cp["id"].as_str().expect("id").to_string();
    assert_eq!(raw_get(&s, &format!("/sketches/{cid}/png"), &[]).await.body, png(30, 20, 0));
    // without files it duplicates the saved one
    let r = form(&s, "POST", &format!("/sketches/{id}/copy"), &[], vec![], &[]).await;
    assert!(r.status == 201 && r.json()["title"] == "Run card copy");
    let rid = r.json()["id"].as_str().expect("id").to_string();
    assert_eq!(raw_get(&s, &format!("/sketches/{rid}/png"), &[]).await.body, png(8, 6, 0));
    let listed = c.get_query("/sketches", &[("owner_kind", "doc"), ("owner_id", "page-1")]).await.json();
    assert_eq!(listed.as_array().expect("list").len(), 3);
}

#[tokio::test]
async fn test_limits_are_enforced_on_the_server() {
    if !skip_unless_available("test_limits_are_enforced_on_the_server") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let fields = doc_fields(&pid, "p");
    // canvas over 4096 px
    let r = form(&s, "POST", "/sketches", &fields, files(4097, 10, 1), &[]).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.json()["detail"]["code"], "sketch_too_large");
    assert_eq!(r.json()["detail"]["limit_px"], 4096);
    // exactly 4096 is fine
    let ok = form(&s, "POST", "/sketches", &fields, files(4096, 1, 1), &[]).await;
    assert_eq!(ok.status, 201);
    // a PNG over 10 MB
    let big: Vec<FilePart> = vec![
        ("png".into(), "d.png".into(), "image/png".into(), png(8, 6, MAX_BYTES)),
        ("source".into(), "d.json".into(), "application/json".into(), source(8, 6, 1, json!({}))),
    ];
    let r = form(&s, "POST", "/sketches", &fields, big, &[]).await;
    assert!(r.status == 413 && r.json()["detail"]["part"] == "png");
    // a source over 10 MB
    let big_source = source(8, 6, 1, json!({"pad": "x".repeat(MAX_BYTES)}));
    let r = form(
        &s,
        "POST",
        "/sketches",
        &fields,
        vec![
            ("png".into(), "d.png".into(), "image/png".into(), png(8, 6, 0)),
            ("source".into(), "d.json".into(), "application/json".into(), big_source),
        ],
        &[],
    )
    .await;
    assert!(r.status == 413 && r.json()["detail"]["part"] == "source");
    // more than 10 layers
    let r = form(&s, "POST", "/sketches", &fields, files(8, 6, 11), &[]).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "too_many_layers");
    let ok = form(&s, "POST", "/sketches", &fields, files(8, 6, 10), &[]).await;
    assert!(ok.status == 201 && ok.json()["layer_count"] == 10);
}

#[tokio::test]
async fn test_malformed_files_are_refused() {
    if !skip_unless_available("test_malformed_files_are_refused") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let fields = doc_fields(&pid, "p");
    let post = |png_bytes: Vec<u8>, src: Vec<u8>| {
        let parts: Vec<FilePart> = vec![
            ("png".into(), "d.png".into(), "image/png".into(), png_bytes),
            ("source".into(), "d.json".into(), "application/json".into(), src),
        ];
        form(&s, "POST", "/sketches", &fields, parts, &[])
    };
    let sources = [
        post(b"not a png at all, just text padded to be long enough".to_vec(), source(8, 6, 1, json!({}))).await,
        post(png(8, 6, 0), b"{nope".to_vec()).await,
        post(png(8, 6, 0), b"{\"format\": \"other\", \"layers\": []}".to_vec()).await,
        post(png(8, 6, 0), source(8, 6, 1, json!({"version": 9}))).await,
        // the size in the source must match the picture
        post(png(8, 6, 0), source(9, 6, 1, json!({}))).await,
    ];
    for r in sources {
        assert_eq!(r.status, 422, "{}", r.text());
        assert_eq!(r.json()["detail"]["code"], "invalid_sketch");
    }
    // a part that is missing
    let r = form(&s, "POST", "/sketches", &fields, vec![("png".into(), "d.png".into(), "image/png".into(), png(8, 6, 0))], &[]).await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn test_delete_unlinks_and_restore_brings_it_back() {
    if !skip_unless_available("test_delete_unlinks_and_restore_brings_it_back") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    assert_eq!(c.delete(&format!("/sketches/{id}")).await.status, 200);
    assert_eq!(c.get(&format!("/sketches/{id}")).await.status, 404);
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &[]).await.status, 404);
    assert!(uploads(&s).join(format!("{id}.png")).exists());
    let listed = c.get_query("/sketches", &[("owner_kind", "doc"), ("owner_id", "page-1")]).await.json();
    assert_eq!(listed, json!([]));
    let back = c.post_empty(&format!("/sketches/{id}/restore")).await;
    assert!(back.status == 200 && back.json()["deleted_at"].is_null());
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &[]).await.status, 200);
}

#[tokio::test]
async fn test_viewers_can_look_but_not_edit() {
    if !skip_unless_available("test_viewers_can_look_but_not_edit") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Vi", "viewer").await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    let v = s.client().header("x-actor", "Vi");
    let h = [("x-actor", "Vi")];
    let r = v.get(&format!("/sketches/{id}")).await;
    assert_eq!(r.status, 200);
    assert!(r.json()["role"] == "viewer" && r.json()["can_edit"] == false);
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &h).await.status, 200);
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/source"), &h).await.status, 200);
    let fields = doc_fields(&pid, "p");
    let replies = [
        form(&s, "POST", "/sketches", &fields, files(8, 6, 1), &h).await,
        form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "1")], files(8, 6, 1), &h).await,
        form(&s, "POST", &format!("/sketches/{id}/copy"), &[], vec![], &h).await,
    ];
    for r in replies {
        assert_eq!(r.status, 403);
        assert_eq!(r.json()["detail"]["code"], "read_only");
    }
    let r = v.delete(&format!("/sketches/{id}")).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["detail"]["code"], "read_only");
}

#[tokio::test]
async fn test_members_can_add_and_edit() {
    if !skip_unless_available("test_members_can_add_and_edit") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Mia", "member").await;
    let r = form(&s, "POST", "/sketches", &doc_fields(&pid, "p"), files(8, 6, 1), &[("x-actor", "Mia")]).await;
    assert!(r.status == 201 && r.json()["created_by"] == "Mia");
    assert_eq!(r.json()["can_edit"], true);
}

#[tokio::test]
async fn test_a_free_idea_uses_the_best_role_anywhere() {
    if !skip_unless_available("test_a_free_idea_uses_the_best_role_anywhere") {
        return;
    }
    let s = Server::start().await;
    // an idea that belongs to no project: the board's own user may draw, a stranger may not
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "idea"), ("owner_id", "IDEA-9")], files(8, 6, 1), &[]).await;
    assert!(r.status == 201 && r.json()["project_id"].is_null());
    let r = form(
        &s,
        "POST",
        "/sketches",
        &[("owner_kind", "idea"), ("owner_id", "IDEA-9")],
        files(8, 6, 1),
        &[("x-actor", "Stranger")],
    )
    .await;
    assert_eq!(r.status, 403);
}

#[test]
fn test_refs_in_finds_each_sketch_once() {
    let text = "![A](sketch:sk_0123abcd) and [B](sketch:sk_0123abcd) ![C](sketch:sk_ffffffff)";
    assert_eq!(kb_draw::sketches::refs_in(text), vec!["sk_0123abcd", "sk_ffffffff"]);
}

// ---------------------------------------------------------------------------
// The same status and JSON on both servers, route by route (not in the Python suite)
// ---------------------------------------------------------------------------

fn expected(pid: Option<&str>, owner_kind: &str, owner_id: &str, version: u32, extra: Value) -> Value {
    let _ = pid;
    let mut out = json!({
        "id": "<sk>", "project_id": "<uuid:1>", "owner_kind": owner_kind, "owner_id": owner_id, "title": "Run card",
        "width": 8, "height": 6, "layer_count": 1, "version": version, "png_bytes": png(8, 6, 0).len(),
        "source_bytes": source(8, 6, 1, json!({})).len(), "png_url": "/uploads/sketches/<sk>.png",
        "source_url": "/uploads/sketches/<sk>.sketch.json", "created_by": "user", "created_at": "<time>",
        "updated_by": "user", "updated_at": "<time>", "deleted_at": null, "role": "admin", "can_edit": true,
    });
    for (k, v) in extra.as_object().expect("extra fields") {
        out[k] = v.clone();
    }
    out
}

/// A sketch as every route returns it, with its id replaced.
fn read(sk: &Value, want: Value) {
    let id = sk["id"].as_str().expect("id");
    assert!(id.len() == 11 && id.starts_with("sk_") && id[3..].chars().all(|c| c.is_ascii_hexdigit()), "{id}");
    let text = normalize(sk).to_string().replace(id, "<sk>");
    assert_eq!(serde_json::from_str::<Value>(&text).expect("json"), want);
}

#[tokio::test]
async fn post_get_and_list_sketches_answer_the_same() {
    if !skip_unless_available("post_get_and_list_sketches_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    read(&sk, expected(Some(&pid), "doc", "page-1", 1, json!({})));
    let id = sk["id"].as_str().expect("id").to_string();
    let r = c.get(&format!("/sketches/{id}")).await;
    assert_eq!(r.status, 200);
    read(&r.json(), expected(Some(&pid), "doc", "page-1", 1, json!({})));
    // the title is cleaned and cut, the fallback is "Sketch"
    let r = form(
        &s,
        "POST",
        "/sketches",
        &[("owner_kind", "doc"), ("owner_id", "page-2"), ("project_id", &pid), ("title", " [a]\nb ")],
        files(8, 6, 1),
        &[],
    )
    .await;
    assert_eq!(r.json()["title"], "a b");
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "doc"), ("owner_id", "page-2"), ("project_id", &pid)], files(8, 6, 1), &[]).await;
    assert_eq!(r.json()["title"], "Sketch");
    // `draft_chat` is accepted and changes nothing
    let r = form(
        &s,
        "POST",
        "/sketches",
        &[("owner_kind", "doc"), ("owner_id", "page-2"), ("project_id", &pid), ("draft_chat", "draft-1")],
        files(8, 6, 1),
        &[],
    )
    .await;
    assert_eq!(r.status, 201);
    // an idea of a project, a comment on a ticket
    let ticket = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "Bug"})).await.json();
    let tid = ticket["id"].as_str().expect("ticket id").to_string();
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "comment"), ("owner_id", &tid)], files(8, 6, 1), &[]).await;
    assert_eq!(r.status, 201);
    assert_eq!(r.json()["project_id"], json!(pid));
    // listed: only this owner's, newest change first
    let listed = c.get_query("/sketches", &[("owner_kind", "doc"), ("owner_id", "page-2")]).await;
    assert_eq!(listed.status, 200);
    assert_eq!(listed.json().as_array().expect("list").len(), 3);
    assert_eq!(c.get_query("/sketches", &[("owner_kind", "doc"), ("owner_id", "none")]).await.json(), json!([]));

    // the errors
    let r = c.get("/sketches/sk_00000000").await;
    assert_eq!(r.status, 404);
    let not_found = json!({"code": "sketch_not_found", "message": "Sketch not found. It was deleted, or you do not have access."});
    assert_eq!(r.json()["detail"]["code"], not_found["code"]);
    assert_eq!(r.json()["detail"]["message"], not_found["message"]);
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "pizza"), ("owner_id", "x")], files(8, 6, 1), &[]).await;
    assert_eq!(r.status, 422);
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_owner", "message": "owner_kind must be one of ('idea', 'ticket', 'doc', 'comment')"})
    );
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "doc"), ("owner_id", "  ")], files(8, 6, 1), &[]).await;
    assert_eq!(detail(&r), json!({"code": "invalid_owner", "message": "owner_id is required"}));
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "doc"), ("owner_id", "x"), ("project_id", "nope")], files(8, 6, 1), &[]).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), json!({"code": "project_not_found", "message": "Project not found"}));
    // a missing part or field is named
    let r = form(&s, "POST", "/sketches", &[("owner_kind", "doc")], vec![], &[]).await;
    assert_eq!(r.status, 422);
    let names: Vec<Value> = problems(&r.detail()).into_iter().map(|(t, loc)| json!([t, loc])).collect();
    assert!(names.contains(&json!(["missing", ["body", "owner_id"]])), "{names:?}");
    assert!(names.contains(&json!(["missing", ["body", "png"]])), "{names:?}");
    let r = c.get("/sketches").await;
    assert_eq!(r.status, 422);
    let names: Vec<Value> = problems(&r.detail()).into_iter().map(|(t, loc)| json!([t, loc])).collect();
    assert!(names.contains(&json!(["missing", ["query", "owner_kind"]])), "{names:?}");
}

#[tokio::test]
async fn validation_of_the_files_answers_the_same() {
    if !skip_unless_available("validation_of_the_files_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let fields = doc_fields(&pid, "p");
    let attempt = |png_bytes: Vec<u8>, src: Vec<u8>| {
        let parts: Vec<FilePart> = vec![
            ("png".into(), "d.png".into(), "image/png".into(), png_bytes),
            ("source".into(), "d.json".into(), "application/json".into(), src),
        ];
        form(&s, "POST", "/sketches", &fields, parts, &[])
    };
    let r = attempt(b"not a png at all, just text padded to be long enough".to_vec(), source(8, 6, 1, json!({}))).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "The picture is not a PNG image."}));
    let r = attempt(png(8, 6, 0), b"{\"format\": \"other\", \"layers\": []}".to_vec()).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "This is not a sketch source (wrong format)."}));
    let r = attempt(png(8, 6, 0), b"[1, 2]".to_vec()).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "This is not a sketch source (wrong format)."}));
    let r = attempt(png(8, 6, 0), source(8, 6, 1, json!({"version": 9}))).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "Unsupported sketch source version 9."}));
    let r = attempt(png(8, 6, 0), source(8, 6, 1, json!({"version": "1"}))).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "Unsupported sketch source version '1'."}));
    let r = attempt(png(8, 6, 0), source(8, 6, 1, json!({"version": null}))).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "Unsupported sketch source version None."}));
    let r = attempt(png(8, 6, 0), source(9, 6, 1, json!({}))).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "The size in the source does not match the picture."}));
    let r = attempt(png(8, 6, 0), b"{nope".to_vec()).await;
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_sketch", "message": "The editable source is not valid JSON (Expecting property name enclosed in double quotes: line 1 column 2 (char 1))."})
    );
    let r = attempt(png(8, 6, 0), b"".to_vec()).await;
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_sketch", "message": "The editable source is not valid JSON (Expecting value: line 1 column 1 (char 0))."})
    );
    let r = attempt(png(8, 6, 0), b"{\"a\": 1} x".to_vec()).await;
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_sketch", "message": "The editable source is not valid JSON (Extra data: line 1 column 10 (char 9))."})
    );
    let r = attempt(png(8, 6, 0), vec![0xff, 0xfe]).await;
    assert_eq!(
        detail(&r),
        json!({"code": "invalid_sketch", "message": "The editable source is not valid JSON ('utf-8' codec can't decode byte 0xff in position 0: invalid start byte)."})
    );
    let r = attempt(png(8, 6, 0), source(8, 6, 0, json!({}))).await;
    assert_eq!(r.status, 422);
    assert_eq!(
        detail(&r),
        json!({"code": "too_many_layers", "message": "A drawing has 1 to 10 layers (this one has 0). Merge some layers.", "layer_count": 0, "limit_layers": 10})
    );
    let r = attempt(png(8, 6, 0), source(8, 6, 11, json!({}))).await;
    assert_eq!(
        detail(&r),
        json!({"code": "too_many_layers", "message": "A drawing has 1 to 10 layers (this one has 11). Merge some layers.", "layer_count": 11, "limit_layers": 10})
    );
    // too large: the numbers are in the answer
    let wide = "This drawing is too large to save. The limit is 4096 \u{d7} 4096 px and 10 MB. Crop it or shrink the canvas.";
    let r = attempt(png(4097, 10, 0), source(4097, 10, 1, json!({}))).await;
    assert_eq!(r.status, 413);
    assert_eq!(
        detail(&r),
        json!({"code": "sketch_too_large", "message": wide, "part": "canvas", "size_bytes": null,
               "limit_bytes": MAX_BYTES, "limit_px": 4096, "width": 4097, "height": 10})
    );
    let big = png(8, 6, MAX_BYTES);
    // only one byte past the limit is read from an upload
    let size = MAX_BYTES + 1;
    let r = attempt(big, source(8, 6, 1, json!({}))).await;
    assert_eq!(
        detail(&r),
        json!({"code": "sketch_too_large", "message": wide, "part": "png", "size_bytes": size,
               "limit_bytes": MAX_BYTES, "limit_px": 4096})
    );
    // a PNG that is a valid header of 0 x 0
    let mut zero = png(8, 6, 0);
    zero[16..24].copy_from_slice(&[0; 8]);
    let r = attempt(zero, source(0, 0, 1, json!({}))).await;
    assert_eq!(detail(&r), json!({"code": "invalid_sketch", "message": "The picture is empty."}));
}

#[tokio::test]
async fn put_copy_delete_restore_routes_answer_the_same() {
    if !skip_unless_available("put_copy_delete_restore_routes_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Vi", "viewer").await;
    member(&c, &pid, "Mia", "member").await;
    let sk = make(&s, Some(&pid), "doc", "page-1").await;
    let id = sk["id"].as_str().expect("id").to_string();
    let not_found = json!({"code": "sketch_not_found", "message": "Sketch not found. It was deleted, or you do not have access."});

    // put: a new version with a new title, the sizes follow the files
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "1"), ("title", "  Two  ")], files(16, 12, 2), &[]).await;
    assert_eq!(r.status, 200);
    let mut want = expected(Some(&pid), "doc", "page-1", 2, json!({"title": "Two", "width": 16, "height": 12, "layer_count": 2}));
    want["png_bytes"] = json!(png(16, 12, 0).len());
    want["source_bytes"] = json!(source(16, 12, 2, json!({})).len());
    read(&r.json(), want);
    // an empty title keeps the old one
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "2"), ("title", "")], files(16, 12, 2), &[]).await;
    assert_eq!(r.json()["title"], "Two");
    // by a member: the editor of the version changes
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "3")], files(8, 6, 1), &[("x-actor", "Mia")]).await;
    assert_eq!(r.json()["updated_by"], "Mia");
    assert_eq!(r.json()["version"], 4);
    // conflicts: the numbers of the newer version
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "3")], files(8, 6, 1), &[]).await;
    assert_eq!(r.status, 409);
    let d = r.detail();
    assert_eq!(d["code"], "sketch_conflict");
    assert_eq!(d["message"], "Mia saved this drawing while you were drawing.");
    assert_eq!((d["latest_version"].clone(), d["latest_author"].clone()), (json!(4), json!("Mia")));
    assert!(d["latest_at"].as_str().expect("latest_at").contains('T'));
    // the conflict is answered before the files are read: the same with files that are not a drawing
    let r = form(
        &s,
        "PUT",
        &format!("/sketches/{id}"),
        &[("base_version", "3")],
        vec![("png".into(), "x.png".into(), "image/png".into(), b"x".to_vec()), ("source".into(), "x.json".into(), "application/json".into(), b"x".to_vec())],
        &[],
    )
    .await;
    assert_eq!(r.status, 409);
    // errors of the form, of the sketch, of the role, of the files
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "x")], files(8, 6, 1), &[]).await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("int_parsing".to_string(), json!(["body", "base_version"]))]);
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[], files(8, 6, 1), &[]).await;
    assert_eq!(problems(&r.detail()), vec![("missing".to_string(), json!(["body", "base_version"]))]);
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "4"), ("force", "perhaps")], files(8, 6, 1), &[]).await;
    assert_eq!(problems(&r.detail()), vec![("bool_parsing".to_string(), json!(["body", "force"]))]);
    let r = form(&s, "PUT", "/sketches/sk_00000000", &[("base_version", "1")], files(8, 6, 1), &[]).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), not_found);
    let r = form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "4")], files(8, 6, 1), &[("x-actor", "Vi")]).await;
    assert_eq!(r.status, 403);
    assert_eq!(
        detail(&r),
        json!({"code": "read_only", "message": "Viewers can look at drawings and open them large but cannot edit them."})
    );

    // copy: a new sketch of the same owner, version 1
    let r = form(&s, "POST", &format!("/sketches/{id}/copy"), &[], vec![], &[]).await;
    assert_eq!(r.status, 201);
    let cp = r.json();
    assert_eq!(cp["title"], "Two copy");
    assert_eq!((cp["version"].clone(), cp["owner_id"].clone(), cp["created_by"].clone()), (json!(1), json!("page-1"), json!("user")));
    let cid = cp["id"].as_str().expect("id").to_string();
    // only one of the two files given: the saved ones are copied
    let r = form(&s, "POST", &format!("/sketches/{id}/copy"), &[("title", "Half")], vec![files(30, 20, 1).remove(0)], &[]).await;
    assert_eq!(r.status, 201);
    let hid = r.json()["id"].as_str().expect("id").to_string();
    assert_eq!(raw_get(&s, &format!("/sketches/{hid}/png"), &[]).await.body, png(8, 6, 0));
    let r = form(&s, "POST", "/sketches/sk_00000000/copy", &[], vec![], &[]).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r), not_found);
    let r = form(&s, "POST", &format!("/sketches/{id}/copy"), &[], vec![], &[("x-actor", "Vi")]).await;
    assert_eq!(r.status, 403);

    // delete and restore
    let r = c.delete(&format!("/sketches/{cid}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(normalize(&r.json()), json!({"id": cid, "deleted_at": "<time>"}));
    let r = c.delete(&format!("/sketches/{cid}")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json()["detail"]["code"], not_found["code"]);
    assert_eq!(r.json()["detail"]["message"], not_found["message"]);
    let r = c.post_empty(&format!("/sketches/{cid}/restore")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["deleted_at"], Value::Null);
    let r = c.post_empty("/sketches/sk_00000000/restore").await;
    assert_eq!(r.status, 404);
    let r = s.client().header("x-actor", "Vi").post_empty(&format!("/sketches/{cid}/restore")).await;
    assert_eq!(r.status, 403);
    let r = s.client().header("x-actor", "Vi").delete(&format!("/sketches/{cid}")).await;
    assert_eq!(r.status, 403);
}

#[tokio::test]
async fn png_and_source_routes_answer_the_same() {
    if !skip_unless_available("png_and_source_routes_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let r = form(
        &s,
        "POST",
        "/sketches",
        &[("owner_kind", "doc"), ("owner_id", "page-1"), ("project_id", &pid), ("title", "Run card/2 \u{e9}")],
        files(8, 6, 1),
        &[],
    )
    .await;
    let id = r.json()["id"].as_str().expect("id").to_string();

    let r = raw_get(&s, &format!("/sketches/{id}/png"), &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, png(8, 6, 0));
    assert_eq!(r.header("content-type"), "image/png");
    assert_eq!(r.header("etag"), format!("\"{id}-v1-png\""));
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("cache-control"), "private, max-age=0, must-revalidate");
    assert_eq!(r.header("access-control-expose-headers"), "ETag, Content-Disposition");
    assert_eq!(r.header("content-disposition"), "");
    let r = raw_get(&s, &format!("/sketches/{id}/png?download=true"), &[]).await;
    assert_eq!(r.header("content-disposition"), "attachment; filename=\"Run-card-2.png\"");
    let r = raw_get(&s, &format!("/sketches/{id}/source?download=1"), &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), "application/json");
    assert_eq!(r.header("content-disposition"), "attachment; filename=\"Run-card-2.sketch.json\"");
    assert_eq!(r.header("etag"), format!("\"{id}-v1-source\""));
    assert_eq!(r.body, source(8, 6, 1, json!({})));
    // the validator of a version is not the validator of the other file, nor of the next version
    let etag = r.header("etag");
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/source"), &[("if-none-match", &etag)]).await.status, 304);
    let not_modified = raw_get(&s, &format!("/sketches/{id}/source"), &[("if-none-match", &etag)]).await;
    assert!(not_modified.body.is_empty());
    assert_eq!(not_modified.header("etag"), etag);
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/png"), &[("if-none-match", &etag)]).await.status, 200);
    form(&s, "PUT", &format!("/sketches/{id}"), &[("base_version", "1")], files(8, 6, 1), &[]).await;
    assert_eq!(raw_get(&s, &format!("/sketches/{id}/source"), &[("if-none-match", &etag)]).await.status, 200);
    // a file that is gone from the data folder
    std::fs::remove_file(uploads(&s).join(format!("{id}.png"))).expect("remove");
    let r = raw_get(&s, &format!("/sketches/{id}/png"), &[]).await;
    assert_eq!(r.status, 404);
    assert_eq!(
        detail(&r),
        json!({"code": "sketch_file_missing", "message": "The drawing's file is missing from the data folder."})
    );
    // errors
    let r = raw_get(&s, "/sketches/sk_00000000/png", &[]).await;
    assert_eq!(r.status, 404);
    assert_eq!(detail(&r)["code"], "sketch_not_found");
    let r = raw_get(&s, &format!("/sketches/{id}/source?download=maybe"), &[]).await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("bool_parsing".to_string(), json!(["query", "download"]))]);
}
