//! `tests/test_projects.py`, and one check per route of `api/projects.py` that both servers answer the same
//! status and JSON for the success case and for each error.

mod common;

use std::time::Duration;

use common::{count, id, member, project, scalar, ticket};
use serde_json::{Value, json};
use testkit::{Server, normalize, skip_unless_available};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_returns_empty() {
    if !skip_unless_available("test_list_returns_empty") {
        return;
    }
    let s = Server::start().await;
    let response = s.client().get("/projects").await;
    assert_eq!(response.status, 200);
    assert_eq!(response.json(), json!([]));
}

#[tokio::test]
async fn test_create_project_appears_in_list() {
    if !skip_unless_available("test_create_project_appears_in_list") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let payload = json!({"name": "My Project", "prefix": "MYP", "color": "#ff0000"});
    let create_response = c.post("/projects", payload).await;
    assert_eq!(create_response.status, 201);
    let created = create_response.json();
    assert_eq!(created["prefix"], "MYP");
    assert_eq!(created["ticket_counter"], 0);

    let list_response = c.get("/projects").await;
    assert_eq!(list_response.status, 200);
    let projects = list_response.json();
    assert_eq!(projects.as_array().expect("list").len(), 1);
    assert_eq!(projects[0]["id"], created["id"]);
}

#[tokio::test]
async fn test_create_duplicate_prefix_returns_error() {
    if !skip_unless_available("test_create_duplicate_prefix_returns_error") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let payload = json!({"name": "Project A", "prefix": "DUP", "color": "#aabbcc"});
    c.post("/projects", payload.clone()).await;
    let response = c.post("/projects", payload).await;
    assert_eq!(response.status, 400);
}

#[tokio::test]
async fn test_get_nonexistent_returns_404() {
    if !skip_unless_available("test_get_nonexistent_returns_404") {
        return;
    }
    let s = Server::start().await;
    let response = s.client().get("/projects/does-not-exist").await;
    assert_eq!(response.status, 404);
}

#[tokio::test]
async fn test_update_name_reflected_in_get() {
    if !skip_unless_available("test_update_name_reflected_in_get") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let payload = json!({"name": "Original", "prefix": "UPD", "color": "#123456"});
    let create_resp = c.post("/projects", payload).await;
    let project_id = id(&create_resp.json());

    let patch_resp = c.patch(&format!("/projects/{project_id}"), json!({"name": "Updated Name"})).await;
    assert_eq!(patch_resp.status, 200);
    assert_eq!(patch_resp.json()["name"], "Updated Name");

    let get_resp = c.get(&format!("/projects/{project_id}")).await;
    assert_eq!(get_resp.json()["name"], "Updated Name");
}

#[tokio::test]
async fn test_update_nonexistent_returns_404() {
    if !skip_unless_available("test_update_nonexistent_returns_404") {
        return;
    }
    let s = Server::start().await;
    let response = s.client().patch("/projects/ghost", json!({"name": "x"})).await;
    assert_eq!(response.status, 404);
}

#[tokio::test]
async fn test_delete_project_then_404() {
    if !skip_unless_available("test_delete_project_then_404") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let payload = json!({"name": "To Delete", "prefix": "DEL", "color": "#000000"});
    let create_resp = c.post("/projects", payload).await;
    let project_id = id(&create_resp.json());

    let del_resp = c.delete(&format!("/projects/{project_id}")).await;
    assert_eq!(del_resp.status, 204);

    let get_resp = c.get(&format!("/projects/{project_id}")).await;
    assert_eq!(get_resp.status, 404);
}

#[tokio::test]
async fn test_delete_nonexistent_returns_404() {
    if !skip_unless_available("test_delete_nonexistent_returns_404") {
        return;
    }
    let s = Server::start().await;
    let response = s.client().delete("/projects/no-such-id").await;
    assert_eq!(response.status, 404);
}

#[tokio::test]
async fn test_delete_project_with_tickets_deletes_the_tickets_too() {
    if !skip_unless_available("test_delete_project_with_tickets_deletes_the_tickets_too") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let proj_payload = json!({"name": "Has Tickets", "prefix": "HAS", "color": "#abcdef"});
    let create_resp = c.post("/projects", proj_payload).await;
    let project_id = id(&create_resp.json());

    // Insert a ticket directly into the test DB
    ticket(&s, "HAS-1", &project_id, "A ticket", json!({})).await;
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ticket WHERE id = ?", &[json!("HAS-1")]).await, 1);

    let del_resp = c.delete(&format!("/projects/{project_id}")).await;
    // the UI asks "All its tickets will be lost?" and means it
    assert_eq!(del_resp.status, 204);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ticket WHERE id = ?", &[json!("HAS-1")]).await, 0);
}

#[tokio::test]
async fn test_create_project_invalid_prefix_lowercase_returns_400() {
    if !skip_unless_available("test_create_project_invalid_prefix_lowercase_returns_400") {
        return;
    }
    let s = Server::start().await;
    let payload = json!({"name": "Bad Prefix", "prefix": "lower", "color": "#ffffff"});
    let response = s.client().post("/projects", payload).await;
    assert_eq!(response.status, 400);
}

#[tokio::test]
async fn test_create_project_prefix_too_long_returns_400() {
    if !skip_unless_available("test_create_project_prefix_too_long_returns_400") {
        return;
    }
    let s = Server::start().await;
    let payload = json!({"name": "Long Prefix", "prefix": "TOOLONG", "color": "#ffffff"});
    let response = s.client().post("/projects", payload).await;
    assert_eq!(response.status, 400);
}

// ---------------------------------------------------------------------------
// The same status and JSON on both servers, route by route (not in the Python suite)
// ---------------------------------------------------------------------------

/// A project as every route returns it, ids replaced.
fn read(name: &str, prefix: &str, color: &str) -> Value {
    json!({
        "id": "<uuid:1>", "name": name, "prefix": prefix, "color": color, "ticket_counter": 0, "repo_path": null,
        "worktree_template": null, "worktree_by_default": false, "docs_enabled": true, "docs_edit_policy": "members",
    })
}

/// The entries of a 422 answer as `(type, loc)`: Pydantic's wording differs, what is wrong and where does not.
fn problems(detail: &Value) -> Vec<(String, Value)> {
    let list = detail.as_array().unwrap_or_else(|| panic!("a validation list, got {detail}"));
    list.iter().map(|e| (e["type"].as_str().unwrap_or("").to_string(), e["loc"].clone())).collect()
}

#[tokio::test]
async fn post_project_answers_the_same() {
    if !skip_unless_available("post_project_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();

    // created; the prefix is stored without the spaces around it
    let r = c.post("/projects", json!({"name": "My Project", "prefix": " MYP1 ", "color": "#ff0000"})).await;
    assert_eq!(r.status, 201);
    assert_eq!(normalize(&r.json()), read("My Project", "MYP1", "#ff0000"));

    // a new project has an Admin member and Docs AI switched off
    let dump = normalize(&s.dump_db().await);
    assert_eq!(
        dump["project"],
        json!([{"id": "<uuid:1>", "name": "My Project", "prefix": "MYP1", "color": "#ff0000", "ticket_counter": 0,
            "repo_path": null, "worktree_template": null, "worktree_by_default": 0, "docs_enabled": 1,
            "docs_edit_policy": "members"}])
    );
    assert_eq!(
        dump["member"],
        json!([{"id": "<uuid:2>", "project_id": "<uuid:1>", "name": "Admin", "color": "#3B82F6", "role": "member",
            "kind": "human", "created_at": "<time>"}])
    );
    assert_eq!(
        dump["docs_ai_settings"],
        json!([{"project_id": "<uuid:1>", "enabled": 0, "member_id": null, "style_page_id": null, "freshness_on": 1,
            "digest_on": 1, "updated_by": null, "updated_at": "<time>"}])
    );
    // times are stored as Python's isoformat: microseconds and +00:00
    let created_at = scalar(&s, "SELECT created_at FROM member", &[]).await;
    let created_at = created_at.as_str().expect("created_at");
    assert_eq!(created_at.len(), 32, "{created_at}");
    assert!(created_at.ends_with("+00:00") && created_at.as_bytes()[19] == b'.', "{created_at}");

    // the prefix rules
    for prefix in ["lower", "TOOLONG", "123", "", "Ab", "   "] {
        let r = c.post("/projects", json!({"name": "P", "prefix": prefix, "color": "#ffffff"})).await;
        assert_eq!(r.status, 400, "{prefix:?}");
        assert_eq!(r.json(), json!({"detail": "prefix must be uppercase and at most 6 characters"}), "{prefix:?}");
    }
    // digits and other characters are fine beside an uppercase letter; six characters, not six bytes
    for prefix in ["A1", "ÉÉÉÉÉÉ", "A-B"] {
        let r = c.post("/projects", json!({"name": "P", "prefix": prefix, "color": "#ffffff"})).await;
        assert_eq!(r.status, 201, "{prefix:?}: {}", r.text());
        assert_eq!(r.json()["prefix"], prefix);
    }

    // a prefix is used once; nothing of the refused project is kept
    let r = c.post("/projects", json!({"name": "Again", "prefix": "MYP1", "color": "#000000"})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), json!({"detail": "A project with this prefix already exists"}));
    assert_eq!(count(&s, "SELECT COUNT(*) FROM project", &[]).await, 4);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM member", &[]).await, 4);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM docs_ai_settings", &[]).await, 4);

    // a body the server cannot read
    let r = c.post("/projects", json!({"name": "No prefix", "color": "#000000"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("missing".to_string(), json!(["body", "prefix"]))]);
    let r = c.post_empty("/projects").await;
    assert_eq!(r.status, 422);
    assert_eq!(problems(&r.detail()), vec![("missing".to_string(), json!(["body"]))]);
    let r = c.post("/projects", json!({"name": 5, "prefix": "NUM", "color": "#000000"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "name"]));
}

#[tokio::test]
async fn get_projects_answers_the_same() {
    if !skip_unless_available("get_projects_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    assert_eq!(c.get("/projects").await.json(), json!([]));
    // in the order they were made (SQLite), not by name
    project(&c, "Zeta", "ZET").await;
    project(&c, "Alpha", "ALP").await;
    let r = c.get("/projects").await;
    assert_eq!(r.status, 200);
    let mut second = read("Alpha", "ALP", "#123456");
    second["id"] = json!("<uuid:2>");
    assert_eq!(normalize(&r.json()), json!([read("Zeta", "ZET", "#123456"), second]));
}

#[tokio::test]
async fn get_one_project_answers_the_same() {
    if !skip_unless_available("get_one_project_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "One", "ONE").await;
    let r = c.get(&format!("/projects/{}", id(&p))).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json(), p);
    assert_eq!(normalize(&r.json()), read("One", "ONE", "#123456"));

    let r = c.get("/projects/does-not-exist").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json(), json!({"detail": "Project not found"}));
}

#[tokio::test]
async fn patch_project_answers_the_same() {
    if !skip_unless_available("patch_project_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "Original", "UPD").await;
    let path = format!("/projects/{}", id(&p));

    // name and color; a field that is null or absent is left alone
    let r = c.patch(&path, json!({"name": "Updated Name", "color": "#654321", "repo_path": null})).await;
    assert_eq!(r.status, 200);
    assert_eq!(normalize(&r.json()), read("Updated Name", "UPD", "#654321"));
    let r = c.patch(&path, json!({})).await;
    assert_eq!(r.status, 200);
    assert_eq!(normalize(&r.json()), read("Updated Name", "UPD", "#654321"));
    // the prefix and the counter cannot be changed here
    let r = c.patch(&path, json!({"prefix": "NEW", "ticket_counter": 9, "id": "x"})).await;
    assert_eq!(normalize(&r.json()), read("Updated Name", "UPD", "#654321"));

    // worktree settings: the template is stored without the spaces around it, an empty one is no template
    let r = c.patch(&path, json!({"worktree_template": "  ../wt/{branch}  ", "worktree_by_default": true})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["worktree_template"], "../wt/{branch}");
    assert_eq!(r.json()["worktree_by_default"], true);
    let r = c.patch(&path, json!({"worktree_template": "   ", "worktree_by_default": false})).await;
    assert_eq!(r.json()["worktree_template"], Value::Null);
    assert_eq!(r.json()["worktree_by_default"], false);

    // linking a repository: the path is resolved and must be the root of a git working tree
    let dir = tempfile::tempdir().expect("temporary folder");
    let root = std::fs::canonicalize(dir.path()).expect("resolved").to_string_lossy().into_owned();
    let repo = format!("{root}/repo");
    std::fs::create_dir_all(format!("{repo}/sub")).expect("mkdir");
    let init = std::process::Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&repo).status();
    assert!(init.expect("git runs").success());
    let r = c.patch(&path, json!({"repo_path": format!("  {repo}/sub/..  ")})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["repo_path"], json!(repo));
    for (given, shown) in [
        (format!("{root}/plain"), format!("{root}/plain")),
        (format!("{repo}/sub"), format!("{repo}/sub")),
        (format!("{repo}/../nope/"), format!("{root}/nope")),
    ] {
        std::fs::create_dir_all(format!("{root}/plain")).expect("mkdir");
        let r = c.patch(&path, json!({"repo_path": given})).await;
        assert_eq!(r.status, 400, "{given}");
        assert_eq!(r.json(), json!({"detail": format!("Not a git repository: {shown}")}));
    }
    // still linked after the refused ones; an empty path unlinks
    assert_eq!(c.get(&path).await.json()["repo_path"], json!(repo));
    let r = c.patch(&path, json!({"repo_path": "  "})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["repo_path"], Value::Null);

    // Docs settings: the board's own user is an admin
    let r = c.patch(&path, json!({"docs_enabled": false, "docs_edit_policy": "admins"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["docs_enabled"], false);
    assert_eq!(r.json()["docs_edit_policy"], "admins");
    // a member who is an admin may, any other name may not (members, viewers, strangers, the agent)
    member(&c, &id(&p), "Ada", "admin").await;
    member(&c, &id(&p), "Mia", "member").await;
    member(&c, &id(&p), "Vy", "viewer").await;
    let r = c.clone().header("x-actor", "ADA").patch(&path, json!({"docs_edit_policy": "everyone"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["docs_edit_policy"], "everyone");
    for actor in ["Mia", "Vy", "Nobody", "agent"] {
        for body in [
            json!({"docs_enabled": true}),
            json!({"docs_edit_policy": "members"}),
            json!({"docs_enabled": false, "name": "x"}),
        ] {
            let r = c.clone().header("x-actor", actor).patch(&path, body).await;
            assert_eq!(r.status, 403, "{actor}");
            assert_eq!(r.json(), json!({"detail": "Only project admins can change Docs settings."}));
        }
        // anything else they may change
        let r = c.clone().header("x-actor", actor).patch(&path, json!({"color": "#111111"})).await;
        assert_eq!(r.status, 200, "{actor}");
    }
    let now = c.get(&path).await.json();
    assert_eq!((now["docs_enabled"].clone(), now["name"].clone()), (json!(false), json!("Updated Name")));

    // a project that does not exist: the Docs check comes first
    let r = c.patch("/projects/ghost", json!({"name": "x"})).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json(), json!({"detail": "Project not found"}));
    let r = c.patch("/projects/ghost", json!({"docs_enabled": true})).await;
    assert_eq!(r.status, 404);
    let r = c.clone().header("x-actor", "Mia").patch("/projects/ghost", json!({"docs_enabled": true})).await;
    assert_eq!(r.status, 403);
    // a repository is checked only for a project that exists
    let r = c.patch("/projects/ghost", json!({"repo_path": "/nope"})).await;
    assert_eq!(r.status, 404);

    // a body the server cannot read
    let r = c.patch(&path, json!({"docs_edit_policy": "nobody"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "docs_edit_policy"]));
    let r = c.patch(&path, json!({"name": ["x"]})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "name"]));
}

#[tokio::test]
async fn del_project_answers_the_same() {
    if !skip_unless_available("del_project_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "To Delete", "DEL").await;
    let r = c.delete(&format!("/projects/{}", id(&p))).await;
    assert_eq!(r.status, 204);
    assert!(r.body.is_empty(), "{}", r.text());
    for table in ["project", "member", "docs_ai_settings"] {
        assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM {table}"), &[]).await, 0, "{table}");
    }
    let r = c.delete(&format!("/projects/{}", id(&p))).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json(), json!({"detail": "Project not found"}));
    // the prefix is free again
    project(&c, "Again", "DEL").await;
}

#[tokio::test]
async fn every_change_of_a_project_is_announced() {
    if !skip_unless_available("every_change_of_a_project_is_announced") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let mut events = s.events().await;
    let p = project(&c, "Announced", "ANN").await;
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    c.patch(&format!("/projects/{}", id(&p)), json!({"name": "Renamed"})).await.assert_status(200);
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    c.delete(&format!("/projects/{}", id(&p))).await.assert_status(204);
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    // a refused change announces nothing
    c.post("/projects", json!({"name": "Bad", "prefix": "bad", "color": "#000000"})).await.assert_status(400);
    c.delete("/projects/ghost").await.assert_status(404);
    assert_eq!(events.next(Duration::from_millis(700)).await, None);
}
