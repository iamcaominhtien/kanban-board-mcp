//! One ticket worked through the MCP tools from start to finish, then what the database holds: the `ticket` table
//! and the notification tables (`notification`, `notify_event`, `notify_follow`, `notify_prefs`) of `testkit`'s
//! `dump_db`, ids, times and folders normalized, must be the same on both servers. This checks the stored bytes
//! (the JSON columns as `json.dumps` writes them, the activity log with the agent as the actor) and which
//! notifications a change made through MCP triggers: none. A ticket change raises no notification (the centre is
//! fed by AI runs, the Docs comments and pages, and the schedules), so the notification tables stay empty on both
//! servers; the comparison is there to catch a change that starts to raise one on only one of them.
//!
//! The scenario creates tickets with their criteria, comments (with a mention), a work log, test cases and an
//! attachment, blocks and links two tickets, works a branch on a temporary git repository (commits with fixed
//! dates, so that their hashes are the same on both servers), and moves the ticket through its statuses to done,
//! reopens it and closes it again.
//!
//! The dump of the Python server is kept in `contract/golden/mcp_ticket_scenario.json`; each server is compared
//! with it. To write it again after the scenario changes:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_ticket_scenario`.

mod common;

use std::path::Path;
use std::process::Command;

use common::{call, call_err};
use serde_json::{Map, Value, json};
use testkit::{Mcp, Target, normalize, target};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/mcp_ticket_scenario.json");
const TABLES: [&str; 5] = ["ticket", "notification", "notify_event", "notify_follow", "notify_prefs"];

/// Run git in a folder, with an author, a committer and dates that do not change.
fn git(folder: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(folder)
        .env("GIT_AUTHOR_NAME", "Tester")
        .env("GIT_AUTHOR_EMAIL", "tester@example.com")
        .env("GIT_COMMITTER_NAME", "Tester")
        .env("GIT_COMMITTER_EMAIL", "tester@example.com")
        .env("GIT_AUTHOR_DATE", "2026-01-01T12:00:00+00:00")
        .env("GIT_COMMITTER_DATE", "2026-01-01T12:00:00+00:00")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository with one commit on `main`.
fn repository() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("kbrepo").tempdir().expect("a folder for the repository");
    git(dir.path(), &["init", "-q"]);
    git(dir.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);
    std::fs::write(dir.path().join("README.md"), "# Scenario\n").expect("a file");
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-qm", "init"]);
    dir
}

/// `manage_ticket(action=..., **rest)`.
async fn manage(mcp: &Mcp, action: &str, rest: Value) -> Value {
    call(mcp, "manage_ticket", with(json!({"action": action}), rest)).await
}

/// `ticket_items(ticket_id=..., item=..., action=..., **rest)`.
async fn item(mcp: &Mcp, ticket_id: &str, item: &str, action: &str, rest: Value) -> Value {
    call(mcp, "ticket_items", with(json!({"ticket_id": ticket_id, "item": item, "action": action}), rest)).await
}

/// `ticket_branches(ticket_id=..., action=..., **rest)`.
async fn branch(mcp: &Mcp, ticket_id: &str, action: &str, rest: Value) -> Value {
    call(mcp, "ticket_branches", with(json!({"ticket_id": ticket_id, "action": action}), rest)).await
}

fn with(mut base: Value, rest: Value) -> Value {
    for (key, value) in rest.as_object().expect("an object") {
        base[key] = value.clone();
    }
    base
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a text")
}

/// The whole scenario, on the server of the current target.
async fn scenario(s: &testkit::Server, repo: &Path, files: &Path) {
    let mcp = s.mcp();
    let project = call(&mcp, "manage_project", json!({"action": "create", "name": "Scenario", "prefix": "SCN"})).await;
    let pid = project["id"].clone();
    let linked = call(
        &mcp,
        "manage_project",
        json!({"action": "update", "project_id": pid, "repo_path": repo.to_str().expect("text")}),
    )
    .await;
    assert!(linked["repo_path"].is_string(), "{linked}");
    let bao = call(&mcp, "manage_project", json!({"action": "add_member", "project_id": pid, "name": "Bao"})).await;
    let ha = call(&mcp, "manage_project", json!({"action": "add_member", "project_id": pid, "name": "Hà My"})).await;

    // the tickets: one with everything, one that waits for it, a story with a sub-ticket
    let a = manage(
        &mcp,
        "create",
        json!({"project_id": pid, "title": "Login: a wrong password shows no message", "type": "bug", "priority": "high",
               "status": "todo", "description": "Steps in [[Login spec]].", "estimate": 3, "start_date": "2026-06-01",
               "due_date": "2026-06-30", "tags": ["auth", "p1"], "assignee": bao["id"],
               "acceptance_criteria": ["A wrong password shows a message", "The field keeps its text"]}),
    )
    .await;
    let a_id = text(&a["id"]).to_string();
    let b = manage(&mcp, "create", json!({"project_id": pid, "title": "Show the goal", "parent_id": null})).await;
    let b_id = text(&b["id"]).to_string();
    let story = manage(&mcp, "create", json!({"project_id": pid, "title": "Export a month", "type": "story"})).await;
    manage(&mcp, "create", json!({"project_id": pid, "title": "The file", "parent_id": story["id"]})).await;

    // changes of fields, by name and by clearing
    manage(&mcp, "update", json!({"ticket_id": a_id, "priority": "critical", "status": "in-progress"})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "review_requested_from": ha["id"], "estimate": 5})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "clear_fields": ["review_requested_from", "estimate"]})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "assignee": ha["id"], "tags": ["auth", "mobile"]})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "title": "Login: a wrong password shows a message"})).await;
    call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": a_id, "status": "wont_do"})).await;

    // comments, with a mention of a member and of a page
    let mention = format!("cc @[Bao](member:{}) see [[Login spec]]", text(&bao["id"]));
    let after = item(&mcp, &a_id, "comment", "add", json!({"text": mention, "author": "Claude", "role": "Reviewer"})).await;
    let cid = after["comments"][0]["id"].clone();
    item(&mcp, &a_id, "comment", "add", json!({"text": "second", "author": "user"})).await;
    item(&mcp, &a_id, "comment", "update", json!({"item_id": cid, "text": "cc again @[Hà My](member:".to_string() + text(&ha["id"]) + ")"}))
        .await;
    item(&mcp, &a_id, "comment", "delete", json!({"item_id": cid})).await;
    item(&mcp, &a_id, "comment", "restore", json!({"item_id": cid})).await;

    // a branch in the repository: created from main, a commit on it, merged, renamed, another one deleted with git
    branch(&mcp, &a_id, "add", json!({"name": "feat/scn-1-login"})).await;
    git(repo, &["checkout", "-q", "feat/scn-1-login"]);
    std::fs::write(repo.join("login.txt"), "login\n").expect("a file");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "login"]);
    git(repo, &["checkout", "-q", "main"]);
    call_err(
        &mcp,
        "ticket_branches",
        json!({"ticket_id": a_id, "action": "update", "branch": "feat/scn-1-login", "status": "merged"}),
    )
    .await;
    let updated = branch(&mcp, &a_id, "update", json!({"branch": "feat/scn-1-login", "pr_url": "https://example.com/pr/1"})).await;
    assert!(updated["branches"][0]["commit_hash"].is_string(), "{updated}");
    git(repo, &["merge", "-q", "--ff-only", "feat/scn-1-login"]);
    branch(&mcp, &a_id, "update", json!({"branch": "feat/scn-1-login", "status": "merged"})).await;
    branch(&mcp, &a_id, "update", json!({"branch": "feat/scn-1-login", "name": "feat/scn-1-done"})).await;
    branch(&mcp, &a_id, "add", json!({"name": "feat/scratch", "branch_from": "main"})).await;
    call_err(&mcp, "ticket_branches", json!({"ticket_id": a_id, "action": "add", "name": "feat/scratch"})).await;
    branch(&mcp, &a_id, "checkout", json!({"branch": "feat/scratch"})).await;
    git(repo, &["checkout", "-q", "main"]);
    branch(&mcp, &a_id, "delete", json!({"branch": "feat/scratch", "delete_git_branch": true})).await;
    git(repo, &["branch", "feat/adopted"]);
    branch(&mcp, &a_id, "add", json!({"name": "feat/adopted", "adopt": true, "status": "open"})).await;
    branch(&mcp, &a_id, "delete", json!({"branch": "feat/adopted"})).await;
    branch(&mcp, &b_id, "add", json!({"name": "only/board", "commit_hash": "abc", "ahead_count": 2})).await;

    // the work log, linked to the branch, and the criteria, sub-tasks and test cases
    item(&mcp, &a_id, "work_log", "add", json!({"author": "Claude", "role": "Developer", "note": "The message is never rendered", "log_kind": "root_cause", "pinned": true, "linked_branch": "feat/scn-1-done"})).await;
    item(&mcp, &a_id, "work_log", "add", json!({"author": "QA", "role": "Tester", "note": "Blocked on the build", "log_kind": "blocked"})).await;
    item(&mcp, &a_id, "work_log", "add", json!({"author": "Claude", "role": "Developer", "note": "Fixed", "log_kind": "resolved"})).await;
    let ticket = call(&mcp, "get_ticket", json!({"ticket_id": a_id})).await;
    let log_id = ticket["work_log"][1]["id"].clone();
    item(&mcp, &a_id, "work_log", "update", json!({"item_id": log_id, "note": "Blocked on the build (cleared)", "pinned": true})).await;
    item(&mcp, &a_id, "work_log", "delete", json!({"item_id": log_id})).await;
    item(&mcp, &a_id, "sub_task", "add", json!({"text": "Confirm the spec"})).await;
    let ticket = call(&mcp, "get_ticket", json!({"ticket_id": a_id})).await;
    item(&mcp, &a_id, "sub_task", "toggle", json!({"item_id": ticket["sub_tasks"][0]["id"]})).await;
    item(&mcp, &a_id, "criterion", "add", json!({"text": "A third criterion"})).await;
    let ticket = call(&mcp, "get_ticket", json!({"ticket_id": a_id})).await;
    let criteria = ticket["acceptance_criteria"].as_array().expect("criteria").clone();
    item(&mcp, &a_id, "criterion", "delete", json!({"item_id": criteria[2]["id"]})).await;
    item(&mcp, &a_id, "test_case", "add", json!({"title": "Wrong password", "description": "Type a wrong one", "expected_result": "A message", "assignee": ha["id"]})).await;
    item(&mcp, &a_id, "test_case", "add", json!({"title": "Right password", "status": "running"})).await;
    item(&mcp, &a_id, "test_case", "update", json!({"item_id": "TC-2", "status": "fail", "notes": "It logs in"})).await;

    // an attachment and a picture in a comment
    let shot = files.join("shot.png");
    std::fs::write(&shot, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89").expect("a picture");
    let report = files.join("report.txt");
    std::fs::write(&report, "all green\n").expect("a text");
    item(&mcp, &a_id, "attachment", "add", json!({"path": shot.to_str().expect("text"), "text": "The login screen", "author": "Claude"})).await;
    item(&mcp, &a_id, "attachment", "add", json!({"path": report.to_str().expect("text"), "post": false})).await;
    item(&mcp, &a_id, "work_log", "add", json!({"author": "Claude", "role": "Tester", "note": format!("Proof: ![shot]({})", shot.to_str().expect("text"))})).await;
    item(&mcp, &a_id, "test_case", "update", json!({"item_id": "TC-1", "status": "pass", "proof": format!("![shot]({})", shot.to_str().expect("text"))})).await;

    // relations: A blocks B, they relate, the block is lifted and made again; a sub-ticket link to the story
    manage(&mcp, "block", json!({"ticket_id": b_id, "target_id": a_id})).await;
    let link = manage(&mcp, "link", json!({"ticket_id": a_id, "target_id": b_id, "relation_type": "causes"})).await;
    manage(&mcp, "link", json!({"ticket_id": b_id, "target_id": a_id, "relation_type": "duplicates"})).await;
    manage(&mcp, "unlink", json!({"ticket_id": a_id, "link_id": link["id"]})).await;
    call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": b_id, "status": "done"})).await;
    manage(&mcp, "unblock", json!({"ticket_id": b_id, "target_id": a_id})).await;
    manage(&mcp, "block", json!({"ticket_id": b_id, "target_id": a_id})).await;

    // pending and back
    manage(&mcp, "pend", json!({"ticket_id": b_id, "reason_type": "ticket", "target_id": a_id, "note": "waits for the login"})).await;
    manage(&mcp, "pend", json!({"ticket_id": a_id, "reason_type": "person", "member_id": ha["id"]})).await;
    manage(&mcp, "resume", json!({"ticket_id": a_id, "reason": "answered", "add_comment": true})).await;
    manage(&mcp, "pend", json!({"ticket_id": a_id, "reason_type": "party", "party": "Acme"})).await;
    manage(&mcp, "resume", json!({"ticket_id": a_id})).await;

    // to done: the guards refuse it until the criteria are checked and every test case passes
    manage(&mcp, "update", json!({"ticket_id": a_id, "block_done_if_acs_incomplete": true, "block_done_if_tcs_incomplete": true})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "status": "review"})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "status": "testing"})).await;
    call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": a_id, "status": "done"})).await;
    for criterion in &criteria[..2] {
        item(&mcp, &a_id, "criterion", "toggle", json!({"item_id": criterion["id"]})).await;
    }
    call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": a_id, "status": "done"})).await;
    item(&mcp, &a_id, "test_case", "update", json!({"item_id": "TC-2", "status": "pass", "proof": "Not provable: no screen"})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "status": "done"})).await;
    manage(&mcp, "reopen", json!({"ticket_id": a_id, "reason": "regression", "reset_ac": true, "reset_tests": true, "unassign": true})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "block_done_if_acs_incomplete": false, "block_done_if_tcs_incomplete": false})).await;
    manage(&mcp, "update", json!({"ticket_id": a_id, "status": "done"})).await;
    manage(&mcp, "update", json!({"ticket_id": b_id, "status": "wont_do", "wont_do_reason": "superseded"})).await;
    manage(&mcp, "reopen", json!({"ticket_id": b_id})).await;
    manage(&mcp, "delete", json!({"ticket_id": b_id})).await;

    // what a person does on the board, next to what the tools did: the actor of each change is in the log
    let an = s.client().header("X-Actor", "An Nguyen");
    let mention = format!("Thanks @[Bao](member:{})", text(&bao["id"]));
    an.post(&format!("/tickets/{a_id}/comments"), json!({"text": mention, "author": "An Nguyen"})).await.assert_status(200);
    an.patch(&format!("/tickets/{a_id}"), json!({"assignee": bao["id"], "priority": "low"})).await.assert_status(200);
    an.patch(&format!("/tickets/{a_id}"), json!({"status": "review", "review_requested_from": ha["id"]})).await.assert_status(200);
    manage(&mcp, "update", json!({"ticket_id": a_id, "status": "done"})).await;
}

/// The rows of a table as the dump gives them, in an order that does not depend on the ids and times each server
/// made: sorted by the row with every id and time left out.
fn stable(rows: &Value) -> Vec<Value> {
    static VARIABLE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
        )
        .expect("a pattern")
    });
    let mut keyed: Vec<(String, Value)> = rows
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| (VARIABLE.replace_all(&row.to_string(), "<x>").into_owned(), row.clone()))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    keyed.into_iter().map(|(_, row)| row).collect()
}

/// The tables to compare, normalized as one value so that an id is the same `<uuid:N>` in all of them.
fn tables(dump: &Value, folders: &[(String, &str)]) -> Map<String, Value> {
    let mut chosen = Map::new();
    for table in TABLES {
        let rows = stable(&dump[table]);
        chosen.insert(table.to_string(), Value::Array(rows));
    }
    // the folders of this run, and the name an uploaded file is stored under
    let mut text = serde_json::to_string(&Value::Object(chosen)).expect("json");
    for (folder, name) in folders {
        text = text.replace(folder.as_str(), name);
    }
    let stored = regex::Regex::new(r"(/uploads/[A-Za-z0-9_.-]*?)-[0-9a-f]{6,12}(\.[a-z0-9]+)").expect("a pattern");
    let text = stored.replace_all(&text, "$1-<random>$2");
    let value: Value = serde_json::from_str(&text).expect("json");
    normalize(&value).as_object().expect("an object").clone()
}

#[tokio::test]
async fn a_ticket_worked_through_mcp_leaves_the_same_rows_as_python_does() {
    let s = common::start().await;
    let repo = repository();
    let files = tempfile::Builder::new().prefix("kbfiles").tempdir().expect("a folder for the files");
    scenario(&s, repo.path(), files.path()).await;
    let dir = s.dir().to_string_lossy().into_owned();
    let mut folders = vec![
        (repo.path().to_string_lossy().into_owned(), "<repo>"),
        (files.path().to_string_lossy().into_owned(), "<files>"),
        (dir.clone(), "<dir>"),
    ];
    if let Ok(real) = std::fs::canonicalize(&dir) {
        folders.push((real.to_string_lossy().into_owned(), "<dir>"));
    }
    if let Ok(real) = std::fs::canonicalize(repo.path()) {
        folders.push((real.to_string_lossy().into_owned(), "<repo>"));
    }
    folders.sort_by_key(|(folder, _)| std::cmp::Reverse(folder.len()));
    let got = tables(&s.dump_db().await, &folders);

    if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        assert_eq!(target(), Target::Python, "the golden file is what the Python server stores");
        std::fs::write(GOLDEN, serde_json::to_string_pretty(&got).expect("json") + "\n").expect("write the golden file");
    }
    if let Ok(path) = std::env::var("KANBAN_DUMP_TO") {
        std::fs::write(path, serde_json::to_string_pretty(&got).expect("json") + "\n").expect("write the rows");
    }
    let golden: Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(GOLDEN).expect("the golden file")).expect("it parses");
    assert_eq!(got["ticket"].as_array().expect("rows").len(), 3, "the tickets left: A, the story and its ticket");
    for table in TABLES {
        let (got, expected) = (got[table].as_array().expect("rows"), golden[table].as_array().expect("rows"));
        assert_eq!(got.len(), expected.len(), "{table}: the number of rows");
        for (got, expected) in got.iter().zip(expected) {
            for (column, value) in expected.as_object().expect("a row") {
                assert_eq!(&got[column], value, "{table} {}: {column}", expected.get("id").unwrap_or(&Value::Null));
            }
            assert_eq!(
                got.as_object().expect("a row").len(),
                expected.as_object().expect("a row").len(),
                "{table}: the columns"
            );
        }
    }
}
