//! `tests/test_ai_memory.py`: the route halves. A note a test writes with `memory.write` is written through
//! `POST /projects/{pid}/ai/notes`, which calls it. The MCP tool test, the pick of notes for a run, `paths_in` and the
//! skill test are for `kb-ai-know`, `kb-mcp` and `kb-skills`; a team a test needs is a row added to the database.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use common::{exec, id, project, scalar, start, team, ticket};
use serde_json::{Value, json};

#[tokio::test]
async fn test_notes_are_capped_deduplicated_replaced_and_editable_by_a_person() {
    let Some(f) = start("test_notes_are_capped_deduplicated_replaced_and_editable_by_a_person", true, &[]).await else {
        return;
    };
    let c = &f.c;
    let (pid, _) = project(c).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    let url = format!("/projects/{pid}/ai/notes");
    let note = |text: &str| json!({"text": text, "scope": "ticket", "scope_key": tid});
    let first = c.post(&url, note("One")).await;
    assert_eq!(first.status, 201);
    let first = first.json();
    // the same text again is the note that is there
    let same = c.post(&url, note("one")).await;
    assert!(same.status == 201 && id(&same.json()) == id(&first));
    // the least a ticket keeps is 15 notes
    for i in 0..14 {
        c.post(&url, note(&format!("Fact {i}"))).await.assert_status(201);
    }
    let full = c.post(&url, note("One too many")).await;
    assert!(full.status == 422 && full.detail().as_str().expect("detail").contains("memory is full"));
    let first_id = id(&first);
    let row = c.patch(&format!("/ai/notes/{first_id}"), json!({"text": "One, corrected", "scope": "ticket"})).await;
    assert!(row.status == 200 && row.json()["text"] == "One, corrected");
    let r = c.patch(&format!("/ai/notes/{first_id}"), json!({"text": "Edited by An"})).await;
    assert!(r.status == 200 && r.json()["written_by"].as_str().is_some_and(|w| !w.is_empty()));
    assert_eq!(c.delete(&format!("/ai/notes/{first_id}")).await.status, 204);
    let r = c.post(&url, json!({"text": "Use the colour tokens.", "scope": "role", "scope_key": "designer"})).await;
    assert!(r.status == 201 && r.json()["kind"] == "feedback");
    // errors of the routes
    assert_eq!(c.delete(&format!("/ai/notes/{first_id}")).await.status, 404);
    assert_eq!(c.patch("/ai/notes/nope", json!({"text": "x"})).await.status, 404);
    assert_eq!(c.post(&url, json!({"text": "x"})).await.status, 422);
    assert_eq!(c.post(&url, json!({"text": "x", "scope": "role"})).await.status, 422);
    assert_eq!(c.post(&url, json!({"text": "  ", "scope": "role", "scope_key": "dev"})).await.status, 422);
    assert_eq!(c.post("/projects/nope/ai/notes", note("x")).await.status, 404);
}

#[tokio::test]
async fn test_stale_memory_is_flagged_for_a_person() {
    let Some(f) = start("test_stale_memory_is_flagged_for_a_person", true, &[]).await else { return };
    let c = &f.c;
    let (pid, _) = project(c).await;
    let repo = tempfile::tempdir().expect("repo folder");
    std::fs::create_dir_all(repo.path().join("server")).expect("server folder");
    std::fs::write(repo.path().join("server/models.py"), "").expect("models.py");
    team(&f.server, &pid, "Claude Code · Backend", json!({"working_dir": repo.path().to_string_lossy()})).await;
    let lesson = |text: &str| json!({"text": text});
    let url = format!("/projects/{pid}/ai/lessons");
    let gone = c.post(&url, lesson("Settings live in server/old_config.py, not in server/models.py.")).await.json();
    let fine = c.post(&url, lesson("The models are in server/models.py.")).await.json();
    let notes = format!("/projects/{pid}/ai/notes");
    let note = |text: &str| json!({"text": text, "scope": "role", "scope_key": "dev"});
    let old = c.post(&notes, note("Always run the dev server with npm run dev in the foreground.")).await.json();
    let new = c.post(&notes, note("Never run the dev server with npm run dev in the foreground.")).await.json();
    // make the order certain
    for (note, at) in [(&old, "2026-01-01T00:00:00"), (&new, "2026-02-01T00:00:00")] {
        exec(&f.server, "UPDATE ai_memory_note SET created_at = ? WHERE id = ?", &[json!(at), note["id"].clone()])
            .await;
    }
    assert_eq!(scalar(&f.server, "SELECT COUNT(*) FROM ai_memory_note", &[]).await, json!(2));
    let page = c.get(&format!("/projects/{pid}/ai/knowledge")).await.json();
    let mut flags: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    for flag in page["flags"].as_array().expect("flags") {
        flags.entry(id(flag)).or_default().push(flag.clone());
    }
    let gone_flags = &flags[&id(&gone)];
    assert_eq!(gone_flags[0]["kind"], "missing_path");
    assert_eq!(gone_flags[0]["paths"], json!(["server/old_config.py"]));
    assert!(!flags.contains_key(&id(&fine)));
    let old_flags = &flags[&id(&old)];
    assert_eq!(old_flags[0]["kind"], "newer");
    assert!(old_flags[0]["text"].as_str().expect("text").contains("contradict"));
    assert!(!flags.contains_key(&id(&new)));
}
