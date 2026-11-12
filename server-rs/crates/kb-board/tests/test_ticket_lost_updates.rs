//! 4.0.2, `services/tickets._for_edit`: a ticket keeps its comments, criteria and sub-tasks as JSON lists and a
//! change rewrites the whole list, so two writers that read the ticket before either wrote lost one of the changes
//! while both were told it worked. The ticket is now read after the database's write lock is taken.
//!
//! There is no Python test of it; these go through the real server (the Python one with `PARITY_TARGET=python`) on
//! SQLite, and on PostgreSQL and MariaDB when `KANBAN_TEST_POSTGRES_URL` / `KANBAN_TEST_MYSQL_URL` name a server.

mod common;

use common::id;
use futures::future::join_all;
use kb_db::sea_orm::{ConnectionTrait, Database};
use serde_json::json;
use testkit::{Client, Options, Server, skip_unless_available};

const WRITERS: usize = 8;

/// A project and a ticket in it.
async fn ticket(c: &Client) -> String {
    let project = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await.json();
    let r = c.post(&format!("/projects/{}/tickets", id(&project)), json!({"title": "T", "type": "task"})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    id(&r.json())
}

/// Every writer changes the same ticket at once: comments, acceptance criteria and sub-tasks, `WRITERS` of each.
async fn concurrent_changes_all_survive(client: &Client) {
    let tid = ticket(client).await;
    let mut calls = Vec::new();
    for n in 0..WRITERS {
        let (t, c) = (tid.clone(), client.clone());
        calls.push(tokio::spawn(async move {
            c.post(&format!("/tickets/{t}/comments"), json!({"text": format!("comment {n}"), "author": "user"})).await
        }));
        let (t, c) = (tid.clone(), client.clone());
        calls.push(tokio::spawn(async move {
            c.post(&format!("/tickets/{t}/acceptance-criteria"), json!({"text": format!("criterion {n}")})).await
        }));
        let (t, c) = (tid.clone(), client.clone());
        calls.push(tokio::spawn(async move {
            c.post(&format!("/tickets/{t}/sub-tasks"), json!({"text": format!("sub-task {n}")})).await
        }));
    }
    for r in join_all(calls).await {
        let r = r.expect("the call ran");
        assert!(r.status == 200 || r.status == 201, "{} {}", r.status, r.text());
    }
    let t = client.get(&format!("/tickets/{tid}")).await.json();
    let texts = |key: &str| -> Vec<String> {
        let mut found: Vec<String> =
            t[key].as_array().expect(key).iter().map(|x| x["text"].as_str().expect("text").to_string()).collect();
        found.sort();
        found
    };
    for (key, word) in [("comments", "comment"), ("acceptance_criteria", "criterion"), ("sub_tasks", "sub-task")] {
        let mut expected: Vec<String> = (0..WRITERS).map(|n| format!("{word} {n}")).collect();
        expected.sort();
        assert_eq!(texts(key), expected, "{key} of {}", t["id"]);
    }
}

#[tokio::test]
async fn test_concurrent_comments_criteria_and_sub_tasks_all_survive_on_sqlite() {
    if !skip_unless_available("test_concurrent_comments_criteria_and_sub_tasks_all_survive_on_sqlite") {
        return;
    }
    let s = Server::start().await;
    concurrent_changes_all_survive(&s.client()).await;
}

/// A connection to the test server (sqlx reads no `sslmode=disable`: the options are left out, the servers need no TLS).
async fn admin(url: &str) -> kb_db::sea_orm::DatabaseConnection {
    Database::connect(url.split('?').next().unwrap_or(url)).await.expect("connect to the test server")
}

/// A database of this test's own on the server of `url` (the name starts `kanban_dbkit_`: the MariaDB test user may
/// create such databases), empty; the URL of it.
async fn own_database(url: &str, name: &str) -> String {
    let admin = admin(url).await;
    let quote = if url.starts_with("mysql") { '`' } else { '"' };
    admin.execute_unprepared(&format!("DROP DATABASE IF EXISTS {quote}{name}{quote}")).await.expect("DROP DATABASE");
    let create = if url.starts_with("mysql") {
        format!("CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
    } else {
        format!("CREATE DATABASE \"{name}\" ENCODING 'UTF8' TEMPLATE template0")
    };
    admin.execute_unprepared(&create).await.expect("CREATE DATABASE");
    let (head, query) = url.split_once('?').map_or((url, String::new()), |(h, q)| (h, format!("?{q}")));
    let base = head.rsplit_once('/').map_or(head, |(base, _)| base);
    format!("{base}/{name}{query}")
}

async fn on_server(test: &str, variable: &str, name: &str) {
    if !skip_unless_available(test) {
        return;
    }
    let Ok(url) = std::env::var(variable) else {
        println!("SKIPPED {test}: {variable} is not set");
        return;
    };
    let own = own_database(&url, name).await;
    let s = Server::start_with(Options {
        env: vec![("KANBAN_DATABASE_URL".to_string(), own)],
        fresh_db: true,
        ..Options::default()
    })
    .await;
    concurrent_changes_all_survive(&s.client()).await;
    s.stop().await;
    let admin = admin(&url).await;
    let quote = if url.starts_with("mysql") { '`' } else { '"' };
    let _ = admin.execute_unprepared(&format!("DROP DATABASE IF EXISTS {quote}{name}{quote}")).await;
}

#[tokio::test]
async fn test_concurrent_comments_criteria_and_sub_tasks_all_survive_on_postgresql() {
    on_server(
        "test_concurrent_comments_criteria_and_sub_tasks_all_survive_on_postgresql",
        "KANBAN_TEST_POSTGRES_URL",
        "kanban_dbkit_lost_updates",
    )
    .await;
}

#[tokio::test]
async fn test_concurrent_comments_criteria_and_sub_tasks_all_survive_on_mariadb() {
    on_server(
        "test_concurrent_comments_criteria_and_sub_tasks_all_survive_on_mariadb",
        "KANBAN_TEST_MYSQL_URL",
        "kanban_dbkit_lost_updates",
    )
    .await;
}
