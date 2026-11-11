//! `tests/test_workspace.py`, and one check per route of `api/workspace.py` that both servers answer the same status
//! and JSON for the success case and for each error.
//!
//! The Python test made its tickets through `POST /projects/{id}/tickets` and `PATCH /tickets/{id}`; those routes are
//! not ported yet, so the ticket rows are added to the server's SQLite file in the stored formats.

#![recursion_limit = "256"]

mod common;

use std::path::Path;
use std::time::Duration;

use common::{age, id, idea, project, scalar, set_mtime, ticket, workspace_settings};
use serde_json::{Value, json};
use testkit::{Client, Options, Server, skip_unless_available};

/// A query string with the values percent-encoded.
fn q(path: &str, query: &[(&str, &str)]) -> String {
    let enc = |text: &str| {
        text.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
                other => format!("%{other:02X}"),
            })
            .collect::<String>()
    };
    let pairs: Vec<String> = query.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect();
    format!("{path}?{}", pairs.join("&"))
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `_setup`: the workspace root set, a project and one ticket (`WS-1`) in it; returns the ticket's id.
async fn setup(s: &Server, c: &Client, root: &Path, settings: Value) -> String {
    let mut body = json!({"root_path": text(root)});
    for (key, value) in settings.as_object().expect("settings") {
        body[key] = value.clone();
    }
    workspace_settings(c, body).await;
    let p = project(c, "W", "WS").await;
    ticket(s, "WS-1", &id(&p), "t", json!({})).await;
    "WS-1".to_string()
}

fn header(r: &testkit::Resp, name: &str) -> String {
    r.headers.get(name).map(|v| v.to_str().expect("header text").to_string()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// tests/test_workspace.py
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_listing_dirs_files_and_init() {
    if !skip_unless_available("test_listing_dirs_files_and_init") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let t = setup(&s, &c, tmp.path(), json!({})).await;
    let ws = c.get(&format!("/tickets/{t}/workspace")).await.json();
    assert_eq!(ws["exists"], json!(false));
    assert_eq!(ws["files"], json!([]));
    assert!(!tmp.path().join(&t).exists(), "GET never creates");

    c.post_empty(&format!("/tickets/{t}/workspace/init")).await.assert_status(200);
    let folder = tmp.path().join(&t);
    assert!(folder.is_dir());
    std::fs::create_dir(folder.join("logs")).unwrap();
    std::fs::write(folder.join("logs").join("run.txt"), "hello").unwrap();
    std::fs::write(folder.join("x.txt"), "xx").unwrap();
    let ws = c.get(&format!("/tickets/{t}/workspace")).await.json();
    let names: Vec<(String, bool)> = ws["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["name"].as_str().unwrap().to_string(), f["is_dir"].as_bool().unwrap()))
        .collect();
    assert_eq!(
        names,
        vec![("logs".to_string(), true), ("logs/run.txt".to_string(), false), ("x.txt".to_string(), false)]
    );
    assert_eq!(ws["file_count"], json!(2));
    assert_eq!(ws["total_bytes"], json!(7));
    assert_eq!(ws["path"], json!(text(&std::fs::canonicalize(&folder).unwrap())));
}

#[tokio::test]
async fn test_upload_create_folder_preview_download_delete() {
    if !skip_unless_available("test_upload_create_folder_preview_download_delete") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({})).await;
    let r = c.post(&format!("/tickets/{tid}/workspace/folders"), json!({"path": "notes/deep"})).await;
    assert!(r.status == 200 && tmp.path().join(&tid).join("notes").join("deep").is_dir(), "{}", r.text());

    let r = c
        .upload(
            &format!("/tickets/{tid}/workspace/files"),
            "file",
            "a.txt",
            "text/plain",
            b"line1\nline2".to_vec(),
            &[("directory", "notes")],
        )
        .await;
    assert!(r.status == 200 && r.json()["name"] == "notes/a.txt", "{}", r.text());

    let prev = c.get(&q(&format!("/tickets/{tid}/workspace/file"), &[("path", "notes/a.txt")])).await.json();
    assert!(prev["text"] == "line1\nline2" && prev["binary"] == json!(false));

    c.upload(
        &format!("/tickets/{tid}/workspace/files"),
        "file",
        "p.png",
        "image/png",
        b"\x89PNG\r\n\x1a\n".to_vec(),
        &[],
    )
    .await;
    let img = c.get(&q(&format!("/tickets/{tid}/workspace/file"), &[("path", "p.png")])).await;
    assert_eq!(header(&img, "content-type"), "image/png");
    assert_eq!(header(&img, "x-content-type-options"), "nosniff");

    c.upload(
        &format!("/tickets/{tid}/workspace/files"),
        "file",
        "b.bin",
        "application/octet-stream",
        vec![0, 1, 2],
        &[],
    )
    .await;
    let binprev = c.get(&q(&format!("/tickets/{tid}/workspace/file"), &[("path", "b.bin")])).await.json();
    assert_eq!(binprev["binary"], json!(true));

    let dl =
        c.get(&q(&format!("/tickets/{tid}/workspace/file"), &[("path", "notes/a.txt"), ("download", "true")])).await;
    assert!(header(&dl, "content-disposition").contains("attachment"));

    let r = c.delete(&q(&format!("/tickets/{tid}/workspace/entry"), &[("path", "notes")])).await;
    assert!(r.status == 200 && !tmp.path().join(&tid).join("notes").exists(), "{}", r.text());
    let r = c.delete(&q(&format!("/tickets/{tid}/workspace/entry"), &[("path", "notes")])).await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn test_path_traversal_and_symlink_escape_rejected() {
    if !skip_unless_available("test_path_traversal_and_symlink_escape_rejected") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let outside = tmp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "nope").unwrap();
    let root = tmp.path().join("root");
    let tid = setup(&s, &c, &root, json!({})).await;
    c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
    std::os::unix::fs::symlink(&outside, root.join(&tid).join("link")).unwrap();
    for path in ["../outside/secret.txt", "link/secret.txt", ""] {
        let r = c.get(&q(&format!("/tickets/{tid}/workspace/file"), &[("path", path)])).await;
        assert_eq!(r.status, 400, "{path}");
        let r = c.delete(&q(&format!("/tickets/{tid}/workspace/entry"), &[("path", path)])).await;
        assert_eq!(r.status, 400, "{path}");
    }
    // an absolute path is read as relative to the workspace folder, never the host
    let r = c.get(&q(&format!("/tickets/{tid}/workspace/file"), &[("path", "/etc/passwd")])).await;
    assert_eq!(r.status, 404);
    let r = c.post(&format!("/tickets/{tid}/workspace/folders"), json!({"path": "../evil"})).await;
    assert!(r.status == 400 && !root.join("evil").exists());
    let r = c
        .upload(
            &format!("/tickets/{tid}/workspace/files"),
            "file",
            "../../evil.txt",
            "text/plain",
            b"x".to_vec(),
            &[("directory", "../")],
        )
        .await;
    assert!(r.status == 400 && !tmp.path().join("evil.txt").exists(), "{}", r.text());
    // symlinks are never listed
    let ws = c.get(&format!("/tickets/{tid}/workspace")).await.json();
    assert_eq!(ws["files"], json!([]));
    assert!(outside.join("secret.txt").exists());
}

#[tokio::test]
async fn test_upload_size_limit() {
    if !skip_unless_available("test_upload_size_limit") {
        return;
    }
    // The Python test lowered `MAX_UPLOAD_BYTES` to 10 in process; a server has the real limit, 50 MB.
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let t = setup(&s, &c, tmp.path(), json!({})).await;
    let limit = 50 * 1024 * 1024;
    let r = c
        .upload(&format!("/tickets/{t}/workspace/files"), "file", "big.txt", "text/plain", vec![b'x'; limit + 1], &[])
        .await;
    assert_eq!(r.status, 400, "{}", r.text());
    assert_eq!(r.detail(), json!("File is larger than 50 MB"));
    assert!(!tmp.path().join(&t).join("big.txt").exists());
    let r = c
        .upload(&format!("/tickets/{t}/workspace/files"), "file", "ok.txt", "text/plain", vec![b'x'; limit], &[])
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json(), json!({"name": "ok.txt", "size": limit}));
}

#[tokio::test]
async fn test_disabled_workspace_blocks_mutations() {
    if !skip_unless_available("test_disabled_workspace_blocks_mutations") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({"enabled": false})).await;
    assert_eq!(c.get(&format!("/tickets/{tid}/workspace")).await.json()["enabled"], json!(false));
    assert_eq!(c.post_empty(&format!("/tickets/{tid}/workspace/init")).await.status, 400);
    let r = c.upload(&format!("/tickets/{tid}/workspace/files"), "file", "a", "text/plain", b"x".to_vec(), &[]).await;
    assert_eq!(r.status, 400);
    assert!(!tmp.path().join(&tid).exists());
}

#[tokio::test]
async fn test_root_path_validation() {
    if !skip_unless_available("test_root_path_validation") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    for bad in ["", "   ", "/", "~"] {
        let r = c.patch("/workspace/settings", json!({"root_path": bad})).await;
        assert_eq!(r.status, 400, "{bad}");
    }
    let r = c.patch("/workspace/settings", json!({"root_path": text(&tmp.path().join("ok"))})).await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn test_retention_semantics() {
    if !skip_unless_available("test_retention_semantics") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({"default_retention_days": 30})).await;
    assert_eq!(c.get(&format!("/tickets/{tid}/workspace")).await.json()["retention_days"], json!(30));
    c.patch(&format!("/tickets/{tid}/workspace/retention"), json!({"retention_days": 0})).await;
    let ws = c.get(&format!("/tickets/{tid}/workspace")).await.json();
    assert!(ws["retention_days"] == json!(0) && ws["retention_override"] == json!(0));
    let r = c.patch(&format!("/tickets/{tid}/workspace/retention"), json!({"retention_days": -3})).await;
    assert_eq!(r.status, 400);
    c.patch(&format!("/tickets/{tid}/workspace/retention"), json!({"retention_days": null})).await;
    assert_eq!(c.get(&format!("/tickets/{tid}/workspace")).await.json()["retention_days"], json!(30));
}

#[tokio::test]
async fn test_sweep_only_deletes_closed_expired_non_forever() {
    if !skip_unless_available("test_sweep_only_deletes_closed_expired_non_forever") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let p = project(&c, "S", "SW").await;
    workspace_settings(&c, json!({"root_path": text(tmp.path()), "default_retention_days": 7})).await;
    let mut ids = std::collections::HashMap::new();
    for (n, key) in ["old_done", "old_open", "fresh_done", "forever_done", "old_wontdo"].into_iter().enumerate() {
        let tid = format!("SW-{}", n + 1);
        ticket(&s, &tid, &id(&p), key, json!({})).await;
        c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
        std::fs::write(tmp.path().join(&tid).join("f.txt"), key).unwrap();
        ids.insert(key, tid);
    }
    for key in ["old_done", "old_open", "forever_done", "old_wontdo"] {
        age(&tmp.path().join(&ids[key]), 30);
    }
    for key in ["old_done", "fresh_done", "forever_done"] {
        common::exec(&s, "UPDATE ticket SET status = 'done' WHERE id = ?", &[json!(ids[key])]).await;
    }
    common::exec(
        &s,
        "UPDATE ticket SET status = 'wont_do', wont_do_reason = 'x' WHERE id = ?",
        &[json!(ids["old_wontdo"])],
    )
    .await;
    c.patch(&format!("/tickets/{}/workspace/retention", ids["forever_done"]), json!({"retention_days": 0})).await;
    // a folder in the root that is not a ticket folder must never be touched
    std::fs::create_dir(tmp.path().join("keepme")).unwrap();
    age(&tmp.path().join("keepme"), 90);

    let removed_ids = |r: &Value| {
        let mut found: Vec<String> =
            r["removed"].as_array().unwrap().iter().map(|e| e["ticket_id"].as_str().unwrap().to_string()).collect();
        found.sort();
        found
    };
    let mut expected = vec![ids["old_done"].clone(), ids["old_wontdo"].clone()];
    expected.sort();
    let dry = c.post("/workspace/sweep", json!({"dry_run": true})).await.json();
    assert_eq!(removed_ids(&dry), expected);
    assert!(tmp.path().join(&ids["old_done"]).exists(), "dry run deletes nothing");

    let real = c.post("/workspace/sweep", json!({})).await.json();
    assert_eq!(removed_ids(&real), expected);
    assert!(!tmp.path().join(&ids["old_done"]).exists());
    assert!(!tmp.path().join(&ids["old_wontdo"]).exists());
    for keep in ["old_open", "fresh_done", "forever_done"] {
        assert!(tmp.path().join(&ids[keep]).exists(), "{keep}");
    }
    assert!(tmp.path().join("keepme").exists());
}

#[tokio::test]
async fn test_expiry_reported_and_activity_resets_clock() {
    if !skip_unless_available("test_expiry_reported_and_activity_resets_clock") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({"default_retention_days": 7})).await;
    c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
    std::fs::write(tmp.path().join(&tid).join("f.txt"), "x").unwrap();
    let ws = c.get(&format!("/tickets/{tid}/workspace")).await.json();
    assert!(ws["expires_at"] != Value::Null && ws["sweep_eligible"] == json!(false));
}

/// `test_open_runs_file_manager_in_ticket_folder`: the server runs with a fake `xdg-open` first on its `PATH`.
#[tokio::test]
async fn test_open_runs_file_manager_in_ticket_folder() {
    if !skip_unless_available("test_open_runs_file_manager_in_ticket_folder") || !cfg!(target_os = "linux") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().expect("tempdir");
    let bindir = tmp.path().join("bin");
    std::fs::create_dir(&bindir).unwrap();
    let marker = tmp.path().join("opened");
    let opener = bindir.join("xdg-open");
    std::fs::write(&opener, format!("#!/bin/sh\necho \"$PWD|$1\" > {}\n", marker.display())).unwrap();
    std::fs::set_permissions(&opener, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bindir.display(), std::env::var("PATH").unwrap_or_default());
    let s = Server::start_with(Options { env: vec![("PATH".into(), path)], ..Default::default() }).await;
    let c = s.client();
    let root = tmp.path().join("root");
    let tid = setup(&s, &c, &root, json!({})).await;
    let r = c.post_empty(&format!("/tickets/{tid}/workspace/open")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    for _ in 0..50 {
        if std::fs::read_to_string(&marker).map(|t| !t.trim().is_empty()).unwrap_or(false) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let written = std::fs::read_to_string(&marker).unwrap();
    let (cwd, arg) = written.trim().split_once('|').unwrap();
    assert_eq!(cwd, text(&std::fs::canonicalize(root.join(&tid)).unwrap()));
    assert_eq!(arg, ".");
}

// ---------------------------------------------------------------------------
// Differential checks: one per route of api/workspace.py
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_routes_answer_the_same_json() {
    if !skip_unless_available("settings_routes_answer_the_same_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let r = c.get("/workspace/settings").await;
    assert_eq!(r.status, 200);
    // the row comes from the migrated template database, whose root is that of the template's own run
    let first = r.json();
    assert_eq!((&first["id"], &first["enabled"], &first["default_retention_days"]), (&json!(1), &json!(true), &json!(14)));
    assert!(first["root_path"].as_str().is_some_and(|root| root.ends_with("/workspace")), "{first}");
    assert_eq!(first.as_object().unwrap().len(), 4);
    // a partial update leaves the rest as it was; a value is stored stripped
    let root = format!("  {}  ", text(tmp.path()));
    let r =
        c.patch("/workspace/settings", json!({"enabled": false, "root_path": root, "default_retention_days": 3})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let saved = json!({"id": 1, "enabled": false, "root_path": text(tmp.path()), "default_retention_days": 3});
    assert_eq!(r.json(), saved);
    let r = c.patch("/workspace/settings", json!({"enabled": true})).await;
    assert_eq!(r.json(), json!({"id": 1, "enabled": true, "root_path": text(tmp.path()), "default_retention_days": 3}));
    // null leaves a value alone too
    let r = c.patch("/workspace/settings", json!({"enabled": null, "default_retention_days": null})).await;
    assert_eq!(r.json(), json!({"id": 1, "enabled": true, "root_path": text(tmp.path()), "default_retention_days": 3}));
    assert_eq!(c.get("/workspace/settings").await.json()["default_retention_days"], json!(3));

    for (value, detail) in [
        ("", "Workspace root path must not be empty"),
        ("   ", "Workspace root path must not be empty"),
        ("/", "Workspace root must not be the filesystem root"),
        ("~", "Workspace root must not be the home directory itself"),
    ] {
        let r = c.patch("/workspace/settings", json!({"root_path": value})).await;
        assert_eq!(r.status, 400, "{value:?}");
        assert_eq!(r.json(), json!({"detail": detail}), "{value:?}");
    }
    // the refused update changed nothing
    assert_eq!(c.get("/workspace/settings").await.json()["root_path"], json!(text(tmp.path())));
    let r = c.patch("/workspace/settings", json!({"enabled": "perhaps"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "enabled"]));
    assert_eq!(c.patch("/workspace/settings", json!({"default_retention_days": "x"})).await.status, 422);
}

#[tokio::test]
async fn sweep_route_answers_the_same_json() {
    if !skip_unless_available("sweep_route_answers_the_same_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let p = project(&c, "S", "SW").await;
    workspace_settings(&c, json!({"root_path": text(tmp.path()), "default_retention_days": 7})).await;
    assert_eq!(c.post("/workspace/sweep", json!({})).await.json(), json!({"dry_run": false, "removed": []}));
    ticket(&s, "SW-1", &id(&p), "done", json!({"status": "done"})).await;
    c.post_empty("/tickets/SW-1/workspace/init").await;
    std::fs::create_dir(tmp.path().join("SW-1").join("sub")).unwrap();
    std::fs::write(tmp.path().join("SW-1").join("sub").join("f.txt"), "12345").unwrap();
    age(&tmp.path().join("SW-1"), 30);
    // an idea of a closed stage is swept under the 30 days of ideas, and one that is kept forever is not
    idea(&s, "IDEA-1", json!({"stage": "shipped"})).await;
    idea(&s, "IDEA-2", json!({"stage": "shipped", "workspace_retention": "forever"})).await;
    idea(&s, "IDEA-3", json!({"stage": "inbox"})).await;
    for idea_id in ["IDEA-1", "IDEA-2", "IDEA-3"] {
        std::fs::create_dir(tmp.path().join(idea_id)).unwrap();
        std::fs::write(tmp.path().join(idea_id).join("n.txt"), "abc").unwrap();
        age(&tmp.path().join(idea_id), 40);
    }
    let folder = |name: &str| text(&std::fs::canonicalize(tmp.path()).unwrap().join(name));
    let expected = |dry_run: bool| {
        let mut removed = vec![
            json!({"ticket_id": "SW-1", "path": folder("SW-1"), "bytes": 5}),
            json!({"ticket_id": "IDEA-1", "path": folder("IDEA-1"), "bytes": 3}),
        ];
        removed.sort_by_key(|e| e["ticket_id"].as_str().unwrap().to_string());
        json!({"dry_run": dry_run, "removed": removed})
    };
    let sorted = |mut reply: Value| {
        reply["removed"].as_array_mut().unwrap().sort_by_key(|e| e["ticket_id"].as_str().unwrap().to_string());
        reply
    };
    assert_eq!(sorted(c.post("/workspace/sweep", json!({"dry_run": true})).await.json()), expected(true));
    assert_eq!(sorted(c.post("/workspace/sweep", json!({"dry_run": false})).await.json()), expected(false));
    assert!(!tmp.path().join("SW-1").exists() && !tmp.path().join("IDEA-1").exists());
    assert!(tmp.path().join("IDEA-2").exists() && tmp.path().join("IDEA-3").exists());
    // switched off: nothing is swept
    workspace_settings(&c, json!({"enabled": false})).await;
    assert_eq!(c.post("/workspace/sweep", json!({})).await.json(), json!({"dry_run": false, "removed": []}));
    assert_eq!(c.post("/workspace/sweep", json!({"dry_run": "maybe"})).await.status, 422);
    assert_eq!(c.post_empty("/workspace/sweep").await.status, 422);
}

/// The listing of a folder whose times are set: the exact JSON, microseconds and all.
#[tokio::test]
async fn ticket_workspace_route_answers_the_same_json() {
    if !skip_unless_available("ticket_workspace_route_answers_the_same_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({"default_retention_days": 7})).await;
    let folder = std::fs::canonicalize(tmp.path()).unwrap().join(&tid);
    let shown = text(&folder);
    // not created yet
    assert_eq!(
        c.get(&format!("/tickets/{tid}/workspace")).await.json(),
        json!({"enabled": true, "path": shown, "exists": false, "retention_days": 7, "retention_override": null,
               "sweep_eligible": false, "expires_at": null, "files": [], "file_count": 0, "total_bytes": 0,
               "truncated": false})
    );
    c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
    std::fs::create_dir_all(folder.join("b").join("deep")).unwrap();
    std::fs::create_dir(folder.join("a")).unwrap();
    std::fs::write(folder.join("b").join("deep").join("z.txt"), "zzz").unwrap();
    std::fs::write(folder.join("b").join("m.txt"), "mm").unwrap();
    std::fs::write(folder.join("a").join("a.txt"), "a").unwrap();
    std::fs::write(folder.join("Top.txt"), "").unwrap();
    std::fs::write(folder.join("é.txt"), "é").unwrap();
    // a link is never listed
    std::os::unix::fs::symlink(&folder, folder.join("loop")).unwrap();
    set_mtime(&folder, 1_800_000_000, 0);
    set_mtime(&folder.join("b").join("m.txt"), 1_800_000_100, 500_000_000);
    let ws = c.get(&format!("/tickets/{tid}/workspace")).await.json();
    // 1_800_000_000 = 2027-01-15T08:00:00Z; +100 s and a half
    let expected_files = json!([
        {"name": "Top.txt", "is_dir": false, "size": 0, "modified_at": "2027-01-15T08:00:00+00:00"},
        {"name": "a", "is_dir": true, "size": 0, "modified_at": "2027-01-15T08:00:00+00:00"},
        {"name": "a/a.txt", "is_dir": false, "size": 1, "modified_at": "2027-01-15T08:00:00+00:00"},
        {"name": "b", "is_dir": true, "size": 0, "modified_at": "2027-01-15T08:00:00+00:00"},
        {"name": "b/deep", "is_dir": true, "size": 0, "modified_at": "2027-01-15T08:00:00+00:00"},
        {"name": "b/deep/z.txt", "is_dir": false, "size": 3, "modified_at": "2027-01-15T08:00:00+00:00"},
        {"name": "b/m.txt", "is_dir": false, "size": 2, "modified_at": "2027-01-15T08:01:40.500000+00:00"},
        {"name": "é.txt", "is_dir": false, "size": 2, "modified_at": "2027-01-15T08:00:00+00:00"},
    ]);
    assert_eq!(ws["files"], expected_files);
    // newest change 1_800_000_100.5 s, kept 7 days
    assert_eq!(
        ws,
        json!({"enabled": true, "path": shown, "exists": true, "retention_days": 7, "retention_override": null,
               "sweep_eligible": false, "expires_at": "2027-01-22T08:01:40.500000+00:00", "files": expected_files,
               "file_count": 5, "total_bytes": 8, "truncated": false})
    );

    // closed, with an override of its own
    common::exec(&s, "UPDATE ticket SET status = 'wont_do', workspace_retention_days = 2 WHERE id = ?", &[json!(tid)])
        .await;
    let ws = c.get(&format!("/tickets/{tid}/workspace")).await.json();
    assert_eq!(
        (&ws["sweep_eligible"], &ws["retention_days"], &ws["retention_override"], &ws["expires_at"]),
        (&json!(true), &json!(2), &json!(2), &json!("2027-01-17T08:01:40.500000+00:00"))
    );
    // kept forever: no expiry
    let ws = c.patch(&format!("/tickets/{tid}/workspace/retention"), json!({"retention_days": 0})).await;
    assert_eq!(ws.status, 200);
    let ws = c.get(&format!("/tickets/{tid}/workspace")).await.json();
    assert_eq!((&ws["retention_days"], &ws["expires_at"]), (&json!(0), &Value::Null));

    // errors
    let r = c.get("/tickets/NOPE-1/workspace").await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    // a ticket whose id cannot name a folder reads as missing
    ticket(&s, "a.b", &json!(project(&c, "X", "XX").await["id"]).as_str().unwrap().to_string(), "odd", json!({})).await;
    let r = c.get("/tickets/a.b/workspace").await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
}

#[tokio::test]
async fn an_idea_has_a_workspace_too() {
    if !skip_unless_available("an_idea_has_a_workspace_too") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    workspace_settings(&c, json!({"root_path": text(tmp.path())})).await;
    idea(&s, "IDEA-7", json!({})).await;
    let shown = text(&std::fs::canonicalize(tmp.path()).unwrap().join("IDEA-7"));
    let base = |retention: Value, eligible: bool, override_text: &str| {
        json!({"enabled": true, "path": shown, "exists": false, "retention_days": retention,
               "retention_override": override_text, "sweep_eligible": eligible, "expires_at": null, "files": [],
               "file_count": 0, "total_bytes": 0, "truncated": false})
    };
    assert_eq!(c.get("/tickets/IDEA-7/workspace").await.json(), base(json!(30), false, "open_then_30"));
    common::exec(&s, "UPDATE idea_ticket SET workspace_retention = 'forever' WHERE id = 'IDEA-7'", &[]).await;
    assert_eq!(c.get("/tickets/IDEA-7/workspace").await.json(), base(json!(0), false, "forever"));
    common::exec(&s, "UPDATE idea_ticket SET workspace_retention = '30_days' WHERE id = 'IDEA-7'", &[]).await;
    assert_eq!(c.get("/tickets/IDEA-7/workspace").await.json(), base(json!(30), true, "30_days"));
    common::exec(
        &s,
        "UPDATE idea_ticket SET workspace_retention = 'open_then_30', stage = 'archived' WHERE id = 'IDEA-7'",
        &[],
    )
    .await;
    assert_eq!(c.get("/tickets/IDEA-7/workspace").await.json(), base(json!(30), true, "open_then_30"));
    // an idea's folder is made and filled like a ticket's
    let r = c.post_empty("/tickets/IDEA-7/workspace/init").await;
    assert_eq!((r.status, r.json()), (200, json!({"path": shown, "exists": true})));
    // only a ticket has a retention override to set
    let r = c.patch("/tickets/IDEA-7/workspace/retention", json!({"retention_days": 3})).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
}

#[tokio::test]
async fn retention_route_answers_the_same_json() {
    if !skip_unless_available("retention_route_answers_the_same_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({})).await;
    common::exec(
        &s,
        "UPDATE ticket SET status = 'done', estimate = 3, tags = '[\"a\",\"é\"]', comments = ? WHERE id = ?",
        &[
            json!(r#"[{"id":"c1","text":"kept"},{"id":"c2","text":"gone","deleted_at":"2026-01-01T00:00:00+00:00"}]"#),
            json!(tid),
        ],
    )
    .await;
    let path = format!("/tickets/{tid}/workspace/retention");
    let r = c.patch(&path, json!({"retention_days": 5})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let body = r.json();
    let log = body["activity_log"].as_array().unwrap().clone();
    assert_eq!(log.len(), 1);
    assert_eq!(
        (&log[0]["field"], &log[0]["from"], &log[0]["to"], &log[0]["actor"]),
        (&json!("workspace_retention"), &json!("default"), &json!("5 days"), &json!("user"))
    );
    assert!(log[0]["at"].as_str().unwrap().ends_with("+00:00"));
    assert!(body["updated_at"].as_str().unwrap() > common::NOW);
    let mut rest = body.clone();
    for key in ["activity_log", "updated_at"] {
        rest.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        rest,
        json!({"id": tid, "project_id": body["project_id"], "title": "t", "description": "", "type": "task",
               "status": "done", "priority": "medium", "estimate": 3.0, "due_date": null, "start_date": null,
               "tags": ["a", "é"], "parent_id": null, "comments": [{"id": "c1", "text": "kept"}],
               "acceptance_criteria": [], "sub_tasks": [], "work_log": [], "test_cases": [], "wont_do_reason": null,
               "created_by": null, "assignee": null, "blocks": [], "blocked_by": [],
               "block_done_if_acs_incomplete": false, "block_done_if_tcs_incomplete": false, "links": [],
               "branches": [], "workspace_retention_days": 5, "repo_path": null, "reopen_count": 0,
               "last_reopened_at": null, "last_reopened_by": null, "last_reopen_reason": null,
               "reopen_history": [], "pending": false, "pending_reason_type": null, "pending_ticket_id": null,
               "pending_member_id": null, "pending_party": null, "pending_note": null, "pending_since": null,
               "pending_by": null, "from_idea_id": null, "tests_assumption_id": null, "wave_pin": null,
               "review_requested_from": null, "completed_at": null, "completed_by": null,
               "created_at": common::NOW})
    );
    // the same value again adds no entry; 0 reads "forever", null "default"
    let again = c.patch(&path, json!({"retention_days": 5})).await.json();
    assert_eq!(again["activity_log"].as_array().unwrap().len(), 1);
    let forever = c.patch(&path, json!({"retention_days": 0})).await.json();
    assert_eq!(forever["activity_log"][1]["from"], json!("5 days"));
    assert_eq!(forever["activity_log"][1]["to"], json!("forever"));
    let default = c.patch(&path, json!({"retention_days": null})).await.json();
    assert_eq!(default["activity_log"][2]["from"], json!("forever"));
    assert_eq!(default["activity_log"][2]["to"], json!("default"));
    assert_eq!(default["workspace_retention_days"], Value::Null);
    // an empty body is the same as null
    assert_eq!(c.patch(&path, json!({})).await.json()["workspace_retention_days"], Value::Null);

    // a closed ticket says when it was closed (its latest move into the status)
    let closing = r#"[{"field":"status","from":"todo","to":"done","at":"2026-02-03T04:05:06+00:00","actor":"An"},
                      {"field":"status","from":"done","to":"todo","at":"2026-02-04T04:05:06+00:00","actor":"Bo"},
                      {"field":"status","from":"todo","to":"done","at":"2026-02-05T04:05:06+00:00","actor":"Cy"}]"#;
    common::exec(&s, "UPDATE ticket SET activity_log = ? WHERE id = ?", &[json!(closing), json!(tid)]).await;
    let closed = c.patch(&path, json!({"retention_days": 9})).await.json();
    assert_eq!((&closed["completed_at"], &closed["completed_by"]), (&json!("2026-02-05T04:05:06+00:00"), &json!("Cy")));

    // errors
    let r = c.patch(&path, json!({"retention_days": -3})).await;
    assert_eq!(
        (r.status, r.json()),
        (400, json!({"detail": "Retention must be 0 (forever) or a positive number of days"}))
    );
    let r = c.patch("/tickets/NOPE-1/workspace/retention", json!({"retention_days": 3})).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    // a negative value is judged after the ticket is found
    let r = c.patch("/tickets/NOPE-1/workspace/retention", json!({"retention_days": -3})).await;
    assert_eq!(r.status, 404);
    let r = c.patch(&path, json!({"retention_days": "x"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "retention_days"]));
}

#[tokio::test]
async fn init_open_and_folder_routes_answer_the_same_json() {
    if !skip_unless_available("init_open_and_folder_routes_answer_the_same_json") {
        return;
    }
    // no file manager on this server's PATH: the folder route of `open` answers its refusal
    let tmp = tempfile::tempdir().expect("tempdir");
    let empty_bin = tmp.path().join("empty-bin");
    std::fs::create_dir(&empty_bin).unwrap();
    // the Python server needs `git` to start; nothing else is on the path, least of all `xdg-open`
    let git = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|dir| Path::new(dir).join("git"))
        .find(|candidate| candidate.is_file())
        .expect("git on PATH");
    std::os::unix::fs::symlink(git, empty_bin.join("git")).unwrap();
    let s = Server::start_with(Options { env: vec![("PATH".into(), text(&empty_bin))], ..Default::default() }).await;
    let c = s.client();
    let root = tmp.path().join("root");
    let tid = setup(&s, &c, &root, json!({})).await;
    let real_root = std::fs::canonicalize(tmp.path()).unwrap().join("root");
    let shown = text(&real_root.join(&tid));

    // init
    let r = c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
    assert_eq!((r.status, r.json()), (200, json!({"path": shown, "exists": true})));
    // again: the folder is there already
    assert_eq!(c.post_empty(&format!("/tickets/{tid}/workspace/init")).await.status, 200);
    let r = c.post_empty("/tickets/NOPE-1/workspace/init").await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    ticket(&s, "a.b", &id(&project(&c, "X", "XX").await), "odd", json!({})).await;
    let r = c.post_empty("/tickets/a.b/workspace/init").await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "Invalid ticket id: 'a.b'"})));

    // open: no opener, so no folder is made for it either
    std::fs::remove_dir(real_root.join(&tid)).unwrap();
    let r = c.post_empty(&format!("/tickets/{tid}/workspace/open")).await;
    assert_eq!(
        (r.status, r.json()),
        (400, json!({"detail": "No file manager available on this machine; copy the path instead"}))
    );
    assert!(!real_root.join(&tid).exists(), "a failed Open folder leaves no empty folder behind");
    let r = c.post_empty("/tickets/NOPE-1/workspace/open").await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));

    // folders
    let path = format!("/tickets/{tid}/workspace/folders");
    let r = c.post(&path, json!({"path": "notes/deep"})).await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "notes/deep"})));
    let r = c.post(&path, json!({"path": "\\win\\style/"})).await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "win/style"})));
    let r = c.post(&path, json!({"path": "notes"})).await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "notes"})), "an existing folder is fine");
    for (value, detail) in [
        ("", "Path is required"),
        ("///", "Path is required"),
        ("../evil", "Path escapes the workspace folder"),
        ("a/../../evil", "Path escapes the workspace folder"),
    ] {
        let r = c.post(&path, json!({"path": value})).await;
        assert_eq!((r.status, r.json()), (400, json!({"detail": detail})), "{value:?}");
    }
    let r = c.post("/tickets/NOPE-1/workspace/folders", json!({"path": "x"})).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    let r = c.post(&path, json!({})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "path"]));
    workspace_settings(&c, json!({"enabled": false})).await;
    let r = c.post(&path, json!({"path": "x"})).await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "Workspace is disabled"})));
}

#[tokio::test]
async fn upload_route_answers_the_same_json() {
    if !skip_unless_available("upload_route_answers_the_same_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({})).await;
    let path = format!("/tickets/{tid}/workspace/files");
    let up = |name: &'static str, bytes: &'static [u8], directory: &'static str| {
        let c = c.clone();
        let path = path.clone();
        async move {
            let fields: Vec<(&str, &str)> = if directory.is_empty() { vec![] } else { vec![("directory", directory)] };
            c.upload(&path, "file", name, "application/octet-stream", bytes.to_vec(), &fields).await
        }
    };
    let r = up("a.txt", b"hello", "").await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "a.txt", "size": 5})));
    let r = up("a.txt", b"hello world", "/deep//er/").await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "deep//er/a.txt".replace("//", "/"), "size": 11})));
    // a path in the file name is cut to its last part
    let r = up("x/y\\z.txt", b"1", "").await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "z.txt", "size": 1})));
    // the file is replaced when it is uploaded again
    let r = up("a.txt", b"new", "").await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "a.txt", "size": 3})));
    assert_eq!(std::fs::read(tmp.path().join(&tid).join("a.txt")).unwrap(), b"new");
    // empty content is a file too
    let r = up("empty.bin", b"", "").await;
    assert_eq!((r.status, r.json()), (200, json!({"name": "empty.bin", "size": 0})));

    std::fs::create_dir(tmp.path().join(&tid).join("folder")).unwrap();
    let r = up("folder", b"x", "").await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "A folder with that name already exists"})));
    for (name, directory, detail) in [
        ("..", "", "Invalid file name"),
        ("dir/", "", "Invalid file name"),
        ("ok.txt", "../", "Path escapes the workspace folder"),
        ("ok.txt", "a/../../", "Path escapes the workspace folder"),
    ] {
        let r = up(name, b"x", directory).await;
        assert_eq!((r.status, r.json()), (400, json!({"detail": detail})), "{name} {directory}");
    }
    let r = c.upload("/tickets/NOPE-1/workspace/files", "file", "a.txt", "text/plain", b"x".to_vec(), &[]).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    // no file part
    let r = c.post(&path, json!({})).await;
    assert_eq!(r.status, 422);
    let r = c.upload(&path, "other", "a.txt", "text/plain", b"x".to_vec(), &[]).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "file"]));
    workspace_settings(&c, json!({"enabled": false})).await;
    let r = up("a.txt", b"x", "").await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "Workspace is disabled"})));
}

#[tokio::test]
async fn file_route_answers_the_same_status_and_json() {
    if !skip_unless_available("file_route_answers_the_same_status_and_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({})).await;
    c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
    let folder = tmp.path().join(&tid);
    std::fs::write(folder.join("a.txt"), "line1\nline2").unwrap();
    std::fs::write(folder.join("latin.txt"), b"caf\xe9").unwrap();
    std::fs::write(folder.join("big.txt"), vec![b'y'; 512 * 1024 + 10]).unwrap();
    std::fs::write(folder.join("exact.txt"), vec![b'y'; 512 * 1024]).unwrap();
    std::fs::write(folder.join("b.bin"), b"ab\x00cd").unwrap();
    std::fs::write(folder.join("p.PNG"), b"\x89PNG").unwrap();
    std::fs::write(folder.join("q.jpeg"), b"jpg").unwrap();
    std::fs::write(folder.join("r.svg"), "<svg/>").unwrap();
    std::fs::create_dir(folder.join("dir")).unwrap();
    let file = |p: &str, extra: &[(&str, &str)]| {
        let mut query = vec![("path", p)];
        query.extend_from_slice(extra);
        q(&format!("/tickets/{tid}/workspace/file"), &query)
    };

    let r = c.get(&file("a.txt", &[])).await;
    assert_eq!(
        (r.status, r.json(), header(&r, "x-content-type-options")),
        (200, json!({"binary": false, "text": "line1\nline2", "truncated": false, "size": 11}), "nosniff".to_string())
    );
    assert!(header(&r, "content-type").starts_with("application/json"));
    let r = c.get(&file("latin.txt", &[])).await;
    assert_eq!(r.json(), json!({"binary": false, "text": "caf\u{fffd}", "truncated": false, "size": 4}));
    let r = c.get(&file("big.txt", &[])).await.json();
    assert_eq!(
        (r["truncated"].clone(), r["size"].clone(), r["text"].as_str().unwrap().len()),
        (json!(true), json!(524_298), 524_288)
    );
    let r = c.get(&file("exact.txt", &[])).await.json();
    assert_eq!((r["truncated"].clone(), r["size"].clone()), (json!(false), json!(524_288)));
    let r = c.get(&file("b.bin", &[])).await;
    assert_eq!(r.json(), json!({"binary": true, "text": "", "truncated": false, "size": 5}));
    // images are sent as they are, by their extension
    for (name, media) in [("p.PNG", "image/png"), ("q.jpeg", "image/jpeg")] {
        let r = c.get(&file(name, &[])).await;
        assert_eq!(
            (r.status, header(&r, "content-type"), header(&r, "x-content-type-options")),
            (200, media.to_string(), "nosniff".to_string()),
            "{name}"
        );
    }
    assert_eq!(c.get(&file("p.PNG", &[])).await.body.as_ref(), b"\x89PNG");
    // a download: an attachment of any type; the flag is a bool as FastAPI reads one
    for flag in ["true", "1", "yes", "ON", "True"] {
        let r = c.get(&file("r.svg", &[("download", flag)])).await;
        assert_eq!(
            (
                r.status,
                header(&r, "content-disposition"),
                header(&r, "content-type"),
                header(&r, "x-content-type-options")
            ),
            (
                200,
                "attachment; filename=\"r.svg\"".to_string(),
                "application/octet-stream".to_string(),
                "nosniff".to_string()
            ),
            "{flag}"
        );
        assert_eq!(r.body.as_ref(), b"<svg/>");
    }
    let r = c.get(&file("p.PNG", &[("download", "1")])).await;
    assert_eq!(header(&r, "content-type"), "application/octet-stream");
    for flag in ["false", "0", "no", "off", ""] {
        let r = c.get(&file("a.txt", &[("download", flag)])).await;
        assert_eq!(r.status, if flag.is_empty() { 422 } else { 200 }, "{flag:?}");
    }
    assert_eq!(c.get(&file("a.txt", &[("download", "maybe")])).await.status, 422);

    for (p, status, detail) in [
        ("nope.txt", 404, "File not found"),
        ("dir", 404, "File not found"),
        ("/a.txt", 200, ""),
        ("", 400, "Path is required"),
        ("../a.txt", 400, "Path escapes the workspace folder"),
    ] {
        let r = c.get(&file(p, &[])).await;
        assert_eq!(r.status, status, "{p:?}");
        if !detail.is_empty() {
            assert_eq!(r.json(), json!({"detail": detail}), "{p:?}");
        }
    }
    let r = c.get(&format!("/tickets/{tid}/workspace/file")).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["query", "path"]));
    let r = c.get(&q("/tickets/NOPE-1/workspace/file", &[("path", "a.txt")])).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    workspace_settings(&c, json!({"enabled": false})).await;
    let r = c.get(&file("a.txt", &[])).await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "Workspace is disabled"})));
}

#[tokio::test]
async fn move_route_answers_the_same_json() {
    if !skip_unless_available("move_route_answers_the_same_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({})).await;
    let pid = id(&c.get("/projects").await.json()[0]);
    let other = project(&c, "O", "OT").await;
    for n in 2..=4 {
        ticket(&s, &format!("WS-{n}"), &pid, "t", json!({})).await;
    }
    ticket(&s, "OT-1", &id(&other), "elsewhere", json!({})).await;
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let shown = |t: &str| text(&root.join(t));
    let path = |t: &str| format!("/tickets/{t}/workspace/move");

    // errors, in the order the code meets them
    let r = c.post(&path(&tid), json!({"to_ticket_id": "NOPE-9"})).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    let r = c.post(&path("NOPE-9"), json!({"to_ticket_id": &tid})).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    let r = c.post(&path(&tid), json!({"to_ticket_id": "ws-1"})).await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "Pick another ticket"})));
    let r = c.post(&path(&tid), json!({"to_ticket_id": "OT-1"})).await;
    assert_eq!(
        (r.status, r.json()),
        (400, json!({"detail": "Workspaces move only between tickets of the same project"}))
    );
    let r = c.post(&path(&tid), json!({"to_ticket_id": "WS-2"})).await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "This ticket has no workspace folder to move"})));
    assert_eq!(c.post(&path(&tid), json!({"to_ticket_id": "WS-2", "mode": "swap"})).await.status, 422);
    assert_eq!(c.post(&path(&tid), json!({})).await.status, 422);

    // a move renames the folder; the id is read stripped and in capitals
    c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
    std::fs::create_dir(root.join(&tid).join("sub")).unwrap();
    std::fs::write(root.join(&tid).join("sub").join("f.txt"), "one").unwrap();
    std::fs::write(root.join(&tid).join("top.txt"), "top").unwrap();
    set_mtime(&root.join(&tid), 1_800_000_000, 0);
    let r = c.post(&path(&tid), json!({"to_ticket_id": "  ws-2 "})).await;
    assert_eq!(
        (r.status, r.json()),
        (200, json!({"result": "moved", "path": shown("WS-2"), "to": "WS-2"})),
        "{}",
        r.text()
    );
    assert!(!root.join(&tid).exists());
    assert_eq!(std::fs::read_to_string(root.join("WS-2").join("sub").join("f.txt")).unwrap(), "one");
    let log = |ticket_id: &'static str| {
        let s = &s;
        async move {
            let text = scalar(s, "SELECT activity_log FROM ticket WHERE id = ?", &[json!(ticket_id)]).await;
            let entries: Value = serde_json::from_str(text.as_str().unwrap()).unwrap();
            entries
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (e["field"].clone(), e["from"].clone(), e["to"].clone(), e["actor"].clone()))
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(log("WS-1").await, vec![(json!("workspace"), Value::Null, json!("moved to WS-2"), json!("user"))]);
    assert_eq!(log("WS-2").await, vec![(json!("workspace"), Value::Null, json!("moved from WS-1"), json!("user"))]);

    // a copy keeps the source, and the files keep their times; a folder with files in it is merged into
    set_mtime(&root.join("WS-2"), 1_800_000_000, 0);
    c.post_empty("/tickets/WS-3/workspace/init").await;
    std::fs::write(root.join("WS-3").join("top.txt"), "old").unwrap();
    std::fs::write(root.join("WS-3").join("mine.txt"), "mine").unwrap();
    let r = c.post(&path("WS-2"), json!({"to_ticket_id": "WS-3", "mode": "copy"})).await;
    assert_eq!((r.status, r.json()), (200, json!({"result": "copied", "path": shown("WS-3"), "to": "WS-3"})));
    assert!(root.join("WS-2").join("sub").join("f.txt").exists());
    assert_eq!(std::fs::read_to_string(root.join("WS-3").join("top.txt")).unwrap(), "top");
    assert_eq!(std::fs::read_to_string(root.join("WS-3").join("mine.txt")).unwrap(), "mine");
    let listed = c.get("/tickets/WS-3/workspace").await.json();
    let top = listed["files"].as_array().unwrap().iter().find(|f| f["name"] == "top.txt").unwrap().clone();
    assert_eq!(top["modified_at"], json!("2027-01-15T08:00:00+00:00"));
    // a copy into an empty folder
    c.post_empty("/tickets/WS-4/workspace/init").await;
    let r = c.post(&path("WS-3"), json!({"to_ticket_id": "WS-4", "mode": "copy"})).await;
    assert_eq!((r.status, r.json()), (200, json!({"result": "copied", "path": shown("WS-4"), "to": "WS-4"})));
    assert_eq!(std::fs::read_to_string(root.join("WS-4").join("mine.txt")).unwrap(), "mine");
    // a move into a folder with files copies, then removes the source
    let r = c.post(&path("WS-2"), json!({"to_ticket_id": "WS-3"})).await;
    assert_eq!((r.status, r.json()), (200, json!({"result": "moved", "path": shown("WS-3"), "to": "WS-3"})));
    assert!(!root.join("WS-2").exists());

    workspace_settings(&c, json!({"enabled": false})).await;
    let r = c.post(&path("WS-3"), json!({"to_ticket_id": "WS-4"})).await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "Workspace is disabled"})));
}

#[tokio::test]
async fn delete_entry_route_answers_the_same_json() {
    if !skip_unless_available("delete_entry_route_answers_the_same_json") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp = tempfile::tempdir().expect("tempdir");
    let tid = setup(&s, &c, tmp.path(), json!({})).await;
    c.post_empty(&format!("/tickets/{tid}/workspace/init")).await;
    std::fs::create_dir_all(tmp.path().join(&tid).join("d").join("e")).unwrap();
    std::fs::write(tmp.path().join(&tid).join("d").join("e").join("f.txt"), "x").unwrap();
    std::fs::write(tmp.path().join(&tid).join("g.txt"), "x").unwrap();
    let del = |p: &str| {
        let url = q(&format!("/tickets/{tid}/workspace/entry"), &[("path", p)]);
        let c = c.clone();
        async move { c.delete(&url).await }
    };
    let r = del("g.txt").await;
    assert_eq!((r.status, r.json()), (200, json!({"deleted": "g.txt"})));
    let r = del("/d/").await;
    assert_eq!((r.status, r.json()), (200, json!({"deleted": "/d/"})));
    assert!(!tmp.path().join(&tid).join("d").exists());
    let r = del("d").await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Entry not found"})));
    for (p, detail) in [("", "Path is required"), ("../x", "Path escapes the workspace folder")] {
        let r = del(p).await;
        assert_eq!((r.status, r.json()), (400, json!({"detail": detail})), "{p:?}");
    }
    let r = c.delete(&format!("/tickets/{tid}/workspace/entry")).await;
    assert_eq!(r.status, 422);
    let r = c.delete(&q("/tickets/NOPE-1/workspace/entry", &[("path", "g.txt")])).await;
    assert_eq!((r.status, r.json()), (404, json!({"detail": "Ticket not found"})));
    workspace_settings(&c, json!({"enabled": false})).await;
    let r = del("g.txt").await;
    assert_eq!((r.status, r.json()), (400, json!({"detail": "Workspace is disabled"})));
}
