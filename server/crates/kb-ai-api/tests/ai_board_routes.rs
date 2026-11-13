//! One check per route of `api/ai_board.py` (the pull requests the board opened, and the knowledge base): the answer
//! of each route, for the success case and for each error branch, must be what the Python server answers. Recorded
//! from the Python server in `contract/golden/ai_board_routes/<test>.json`:
//!
//! `AI_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-ai-api --test ai_board_routes`

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use common::rec::Rec;
use common::{id, insert, project, start, tmp};
use serde_json::json;

#[tokio::test]
async fn pull_routes() {
    let name = "pull_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new("ai_board_routes", name, &[&tmp(&f), f.server.dir()]);
    let (pid, _an) = project(c).await;
    let t1 = common::ticket(c, &pid, "Fix add()", "todo").await;
    let url = format!("/projects/{pid}/ai/pulls");
    rec.check("GET pulls: none", &c.get(&url).await);
    rec.check("GET pulls: another project", &c.get("/projects/nope/ai/pulls").await);
    rec.check("POST poll: the watcher is off", &c.post_empty(&format!("{url}/poll")).await);
    rec.check("POST poll: another project", &c.post_empty("/projects/nope/ai/pulls/poll").await);
    // a worktree that has a pull request is watched
    insert(
        &f.server,
        "ai_worktree",
        &json!({"ticket_id": t1, "project_id": pid, "repo": tmp(&f).join("repo").to_string_lossy(),
                "path": tmp(&f).join("repo.worktrees").join(&t1).to_string_lossy(), "branch": "ai/KAN-1-work",
                "base": "main", "state": "active", "conflict_files": "[]", "created_at": common::NOW,
                "pr_number": 7, "pr_url": "https://example.test/pull/7"}),
    )
    .await;
    rec.check("GET pulls", &c.get(&url).await);
    rec.check("GET pulls: again", &c.get(&url).await);
    rec.check("GET pulls: another project, none", &c.get(&format!("/projects/{}/ai/pulls", "other")).await);
    // the watcher on, and no `gh` to ask
    c.patch(&format!("/projects/{pid}/ai/settings"), json!({"ops": {"github": {"on": true}}})).await.assert_status(200);
    rec.check("POST poll: no gh", &c.post_empty(&format!("{url}/poll")).await);
    rec.check("GET pulls: after the poll", &c.get(&url).await);
    rec.finish();
}

#[tokio::test]
async fn knowledge_base_routes() {
    let name = "knowledge_base_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    std::fs::write(f.claude.join(".fake-login"), "an@work.example").expect("login file");
    let mut rec = Rec::new("ai_board_routes", name, &[&tmp(&f), f.server.dir()]);
    let (pid, _an) = project(c).await;
    let url = format!("/projects/{pid}/ai/kb");
    rec.check("GET kb: none", &c.get(&url).await);
    rec.check("GET kb: no such project", &c.get("/projects/nope/ai/kb").await);
    rec.check("GET search: no q", &c.get(&format!("{url}/search")).await);
    rec.check("GET search: nothing yet", &c.get(&format!("{url}/search?q=hello")).await);
    rec.check("GET search: only punctuation", &c.get(&format!("{url}/search?q=%21%21")).await);

    rec.check(
        "POST kb: no such project",
        &c.request(
            "POST",
            "/projects/nope/ai/kb",
            &[("content-type", "application/x-www-form-urlencoded")],
            Some(b"text=hi".to_vec()),
        )
        .await,
    );
    let urlencoded = [("content-type", "application/x-www-form-urlencoded")];
    let send = |body: &'static str| c.request("POST", &url, &urlencoded, Some(body.as_bytes().to_vec()));
    rec.check("POST kb: nothing readable", &send("title=Empty&text=").await);
    rec.check("POST kb: only spaces", &send("title=Empty&text=%20%20%0A").await);
    rec.check("POST kb: store is not one", &send("title=T&text=hello&store=world").await);
    rec.check("POST kb: private is not a bool", &send("title=T&text=hello&private=maybe").await);
    rec.check("POST kb: shared is not on", &send("title=T&text=hello&store=shared").await);
    let doc = send("title=How%20we%20deploy&text=We%20deploy%20with%20a%20script%20called%20ship.%20It%20builds%20the%20image%20and%20pushes%20it.").await;
    rec.check("POST kb: pasted text", &doc);
    doc.assert_status(201);
    let doc_id = id(&doc.json());
    rec.check(
        "POST kb: no title",
        &send("text=A%20document%20with%20no%20title%20at%20all%2C%20about%20databases.").await,
    );
    // a file
    let file = c
        .upload(
            &url,
            "file",
            "notes.md",
            "text/markdown",
            b"# Release notes\n\nVersion two adds a kanban board.\n".to_vec(),
            &[("title", "Release notes")],
        )
        .await;
    rec.check("POST kb: a file", &file);
    file.assert_status(201);
    rec.check(
        "POST kb: a file with no title",
        &c.upload(&url, "file", "plain.txt", "text/plain", b"Plain text about caching.".to_vec(), &[]).await,
    );
    rec.check(
        "POST kb: a private file",
        &c.upload(&url, "file", "secret.txt", "text/plain", b"The secret recipe.".to_vec(), &[("private", "true")])
            .await,
    );
    rec.check("POST kb: an empty file", &c.upload(&url, "file", "empty.txt", "text/plain", Vec::new(), &[]).await);
    rec.check(
        "POST kb: code",
        &c.upload(&url, "file", "calc.py", "text/x-python", b"def add(a, b):\n    return a + b\n".to_vec(), &[]).await,
    );
    rec.check(
        "POST kb: an unknown kind of file",
        &c.upload(&url, "file", "blob.bin", "application/octet-stream", vec![0, 159, 146, 150], &[]).await,
    );
    rec.check("GET kb", &c.get(&url).await);
    rec.check("GET search", &c.get(&format!("{url}/search?q=deploy")).await);
    rec.check("GET search: two words", &c.get(&format!("{url}/search?q=release%20notes")).await);
    rec.check("GET search: no hit", &c.get(&format!("{url}/search?q=zebra")).await);
    // as another person
    let other = f.server.client().header("x-actor", "Binh Tran");
    rec.check("GET kb: another person", &other.get(&url).await);
    rec.check("GET search: another person, the private one", &other.get(&format!("{url}/search?q=recipe")).await);
    rec.check("GET search: the person, the private one", &c.get(&format!("{url}/search?q=recipe")).await);
    // one document
    let one = format!("/ai/kb/{doc_id}");
    rec.check("GET doc", &c.get(&one).await);
    rec.check("GET doc: not found", &c.get("/ai/kb/nope").await);
    let listing = c.get(&url).await.json();
    let private = listing["documents"].as_array().and_then(|d| d.iter().find(|x| x["private"] == true)).map(id);
    let private = private.expect("a private document");
    rec.check("GET doc: another person's private one", &other.get(&format!("/ai/kb/{private}")).await);
    rec.check("PATCH doc: not found", &c.patch("/ai/kb/nope", json!({"private": true})).await);
    rec.check("PATCH doc: store is not one", &c.patch(&one, json!({"store": "world"})).await);
    rec.check("PATCH doc: private is text", &c.patch(&one, json!({"private": "x"})).await);
    rec.check("PATCH doc: nothing", &c.patch(&one, json!({})).await);
    rec.check("PATCH doc: no body", &c.request("PATCH", &one, &[], None).await);
    rec.check("PATCH doc: shared, not opted in", &c.patch(&one, json!({"store": "shared"})).await);
    rec.check("PATCH doc: not the person who added it", &other.patch(&one, json!({"private": true})).await);
    rec.check("PATCH doc: private", &c.patch(&one, json!({"private": true})).await);
    rec.check(
        "PATCH doc: another person's",
        &other.patch(&format!("/ai/kb/{private}"), json!({"private": false})).await,
    );
    rec.check("PATCH doc: the same store", &c.patch(&one, json!({"store": "project", "private": false})).await);
    // the shared store
    c.patch(&format!("/projects/{pid}/ai/settings"), json!({"ops": {"knowledge_shared": true}}))
        .await
        .assert_status(200);
    rec.check("PATCH doc: to the shared store", &c.patch(&one, json!({"store": "shared"})).await);
    rec.check("PATCH doc: back to the project", &c.patch(&one, json!({"store": "project"})).await);
    rec.check(
        "POST kb: to the shared store",
        &send("title=Shared%20note&text=A%20note%20that%20every%20project%20reads%20about%20linting&store=shared")
            .await,
    );
    rec.check("GET kb: with a shared store", &c.get(&url).await);
    rec.check("GET search: across the stores", &c.get(&format!("{url}/search?q=linting")).await);
    // a document that belongs to no project
    insert(
        &f.server,
        "ai_knowledge_doc",
        &json!({"id": "kb_000000000001", "project_id": null, "store": "shared", "title": "Orphan", "kind": "text",
                "text": "An orphan document.", "keywords": "[]", "answers": "[]", "private": false, "tokens": 5,
                "created_by": null, "created_at": common::NOW}),
    )
    .await;
    rec.check(
        "PATCH doc: an orphan to the project",
        &c.patch("/ai/kb/kb_000000000001", json!({"store": "project"})).await,
    );
    rec.check("DELETE doc: not found", &c.delete("/ai/kb/nope").await);
    rec.check("DELETE doc", &c.delete(&one).await);
    rec.check("DELETE doc: again", &c.delete(&one).await);
    rec.check("GET doc: deleted", &c.get(&one).await);
    rec.check("GET kb: after the delete", &c.get(&url).await);
    rec.check("GET search: after the delete", &c.get(&format!("{url}/search?q=deploy")).await);
    rec.finish();
}
