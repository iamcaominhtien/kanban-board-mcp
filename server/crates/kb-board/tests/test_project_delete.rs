//! Deleting a project takes everything in it along: tickets, members, AI members, docs and their versions, chats and
//! their messages. Another project is left alone. (`tests/test_project_delete.py`)
//!
//! The Python test made the AI team, the tickets, the page and the chat through routes and models that are not
//! ported yet; here those rows are added to the server's SQLite file, in the stored formats.

mod common;

use common::{NOW, count, id, insert, ticket};
use serde_json::{Value, json};
use testkit::{Client, Server, Target, skip_unless_available, target};

async fn _count(s: &Server, sql: &str, p: &str) -> i64 {
    count(s, sql, &[json!(p)]).await
}

async fn _new_project(c: &Client, name: &str, prefix: &str) -> String {
    let p = c.post("/projects", json!({"name": name, "prefix": prefix, "color": "#2E6F40"})).await.json();
    c.post(&format!("/projects/{}/members", id(&p)), json!({"name": "An Nguyen"})).await;
    id(&p)
}

/// `_runner`: a team on the fake CLI, which is a member of kind "ai" and an `ai_team` row with the same id.
async fn _runner(s: &Server, pid: &str, name: &str) {
    let team_id = format!("team-{pid}");
    let row = json!({"id": team_id, "project_id": pid, "name": name, "color": "#7C3AED", "role": "member",
        "kind": "ai", "created_at": NOW});
    insert(s, "member", &row).await;
    let row = json!({"id": team_id, "project_id": pid, "provider": "claude-code", "connection": "local",
        "description": "", "cli_path": "/tmp/fake_claude.py", "working_dir": "/tmp/repo", "model": "haiku",
        "persona": "", "config": "{}", "permission_mode": "bypass", "max_parallel": 2, "scope": "assigned",
        "paused": false, "health": "unknown", "created_at": NOW, "updated_at": NOW});
    insert(s, "ai_team", &row).await;
}

/// A project with tickets (one a sub-ticket), an AI member, a docs page with a version and a chat with a message.
async fn _fill(s: &Server, c: &Client, name: &str, prefix: &str) -> (String, String, String) {
    let pid = _new_project(c, name, prefix).await;
    _runner(s, &pid, name).await;
    let parent = format!("{prefix}-1");
    ticket(s, &parent, &pid, &format!("{name} parent"), json!({"status": "todo"})).await;
    ticket(s, &format!("{prefix}-2"), &pid, &format!("{name} child"), json!({"status": "todo", "parent_id": parent}))
        .await;
    let page = format!("page-{prefix}");
    let row = json!({"id": page, "project_id": pid, "position": 0, "title": format!("{name} page"),
        "slug": format!("{name}-page"), "status": "draft", "version": 0, "created_by": "user", "updated_by": "user",
        "created_at": NOW, "updated_at": NOW, "kind": "page"});
    insert(s, "docs_page", &row).await;
    let row = json!({"id": format!("version-{prefix}"), "page_id": page, "version": 1, "title": "v1", "markdown": "",
        "author": "user", "created_at": NOW, "diagram_versions": "{}", "with_ai": false});
    insert(s, "docs_version", &row).await;
    let chat = format!("chat-{prefix}");
    let row = json!({"id": chat, "project_id": pid, "owner": "An Nguyen", "title": "New chat", "scope": "project",
        "include_docs": "[]", "cost": 0.0, "tokens": 0, "applied": false, "summary": "", "compactions": 0,
        "created_at": NOW, "updated_at": NOW});
    insert(s, "ai_chat", &row).await;
    let row = json!({"id": format!("message-{prefix}"), "chat_id": chat, "role": "user", "text": "hi",
        "state": "done", "steps": "[]", "context": "{}", "actions": "[]", "error": "{}", "cost": 0.0, "tokens_in": 0,
        "tokens_out": 0, "metered": true, "feedback": "{}", "created_at": NOW});
    insert(s, "ai_chat_message", &row).await;
    (pid, page, chat)
}

#[tokio::test]
async fn test_a_project_goes_with_all_it_holds_and_the_other_stays() {
    if !skip_unless_available("test_a_project_goes_with_all_it_holds_and_the_other_stays") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (gone, page, chat) = _fill(&s, &c, "Gone", "GON").await;
    let (kept, kept_page, kept_chat) = _fill(&s, &c, "Kept", "KEP").await;

    let r = c.delete(&format!("/projects/{gone}")).await;
    assert_eq!(r.status, 204, "{}", r.text());

    for table in ["ticket", "member", "ai_team", "docs_page", "ai_chat"] {
        assert_eq!(
            _count(&s, &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?"), &gone).await,
            0,
            "{table}"
        );
    }
    assert_eq!(_count(&s, "SELECT COUNT(*) FROM project WHERE id = ?", &gone).await, 0);
    assert_eq!(_count(&s, "SELECT COUNT(*) FROM docs_version WHERE page_id = ?", &page).await, 0);
    assert_eq!(_count(&s, "SELECT COUNT(*) FROM ai_chat_message WHERE chat_id = ?", &chat).await, 0);

    // the other project is whole
    assert_eq!(_count(&s, "SELECT COUNT(*) FROM ticket WHERE project_id = ?", &kept).await, 2);
    assert_eq!(_count(&s, "SELECT COUNT(*) FROM docs_version WHERE page_id = ?", &kept_page).await, 1);
    assert_eq!(_count(&s, "SELECT COUNT(*) FROM ai_chat_message WHERE chat_id = ?", &kept_chat).await, 1);
    if target() == Target::Python {
        // the ticket routes are not ported yet: drop this condition when they are
        assert_eq!(c.get(&format!("/projects/{kept}/tickets")).await.status, 200);
    }
    assert_eq!(c.get(&format!("/projects/{kept}")).await.status, 200);
    assert_eq!(c.delete(&format!("/projects/{gone}")).await.status, 404);
}

/// Not in the Python suite: after the delete no table holds a row of the project, whatever the table (the delete
/// walks every table of the schema), and every row of the other project is as it was.
#[tokio::test]
async fn nothing_of_a_deleted_project_is_left_in_any_table() {
    if !skip_unless_available("nothing_of_a_deleted_project_is_left_in_any_table") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (gone, page, chat) = _fill(&s, &c, "Gone", "GON").await;
    let (_kept, kept_page, _) = _fill(&s, &c, "Kept", "KEP").await;
    // rows of the tables that reach the project through another table, or through nothing at all
    for (page_id, key) in [(page.as_str(), "k1"), (kept_page.as_str(), "k2"), ("page-of-no-project", "k3")] {
        insert(&s, "docs_ai_ignore", &json!({"page_id": page_id, "key": key, "by": "user", "at": NOW})).await;
    }
    let before = s.dump_db().await;

    c.delete(&format!("/projects/{gone}")).await.assert_status(204);

    let after = s.dump_db().await;
    let mentions = |row: &Value| {
        let text = row.to_string();
        [gone.as_str(), page.as_str(), chat.as_str(), "GON-1", "GON-2"]
            .iter()
            .any(|id| text.contains(&format!("\"{id}\"")))
    };
    let mut emptied = Vec::new();
    for (table, rows) in before.as_object().expect("tables") {
        let rows = rows.as_array().expect("rows");
        let kept_rows: Vec<&Value> = rows.iter().filter(|row| !mentions(row)).collect();
        let now: Vec<&Value> = after[table].as_array().expect("rows").iter().collect();
        // docs_ai_ignore: a row whose page is in no project goes too (the table has no link to its page)
        let kept_rows: Vec<&Value> = if table == "docs_ai_ignore" {
            kept_rows.into_iter().filter(|row| row["page_id"] == json!(kept_page)).collect()
        } else {
            kept_rows
        };
        assert_eq!(now, kept_rows, "{table}");
        if kept_rows.len() < rows.len() {
            emptied.push(table.as_str());
        }
    }
    emptied.sort_unstable();
    assert_eq!(
        emptied,
        vec![
            "ai_chat",
            "ai_chat_message",
            "ai_team",
            "docs_ai_ignore",
            "docs_ai_settings",
            "docs_page",
            "docs_version",
            "member",
            "project",
            "ticket"
        ]
    );
}
