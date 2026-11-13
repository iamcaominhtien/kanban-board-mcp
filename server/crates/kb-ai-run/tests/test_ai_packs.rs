//! `tests/test_ai_packs.py`, the part that waited for `launch`: the roles of a team's pack are the agents of its run
//! (`--agents`), each with its persona. The Python test reads the personas from `packs.BUILTIN`
//! (`crates/kb-ai-know/tests/test_ai_packs.rs`); here the same sentences are looked for where a run gets them. New
//! tests, no Python counterpart of their own.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use kb_ai_know::roles;
use serde_json::{Value, json};

#[tokio::test]
async fn the_roles_of_each_pack_are_the_agents_of_its_run() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    for (pack, spec) in roles::TEAM_PACKS.iter() {
        let team = common::team_of(&pid, &format!("Team {pack}"), json!({"pack_key": pack})).await;
        let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
        let prepared = common::launch_of(team["id"].as_str().expect("id"), Some(&tid), "kbr_packs", "s-packs").await;
        let keys: Vec<Value> = prepared.agents.keys().map(|k| json!(k)).collect();
        assert_eq!(json!(keys), spec["roles"], "{pack}");
        // the file the CLI reads is the same JSON, one key per role
        let file: Value = serde_json::from_str(
            &std::fs::read_to_string(common::flag(&prepared.args, "--agents")).expect("agents.json"),
        )
        .expect("json");
        assert_eq!(file, Value::Object(prepared.agents.clone()), "{pack}");
        for (key, agent) in &prepared.agents {
            assert!(agent["description"].as_str().is_some_and(|d| !d.is_empty()), "{pack}: {key}");
            assert!(agent["prompt"].as_str().is_some_and(|p| !p.is_empty()), "{pack}: {key}");
            assert!(agent.get("tools").is_none(), "{pack}: {key} has every tool of the run");
        }
        // the lead is told its roles by key
        for key in prepared.agents.keys() {
            assert!(prepared.system.contains(&format!("\n- {key}: ")), "{pack}: {key}");
        }
    }
}

#[tokio::test]
async fn test_the_roles_know_which_drawing_to_use() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Everyone", json!({"pack_key": "full"})).await;
    let prepared = common::launch_of(team["id"].as_str().expect("id"), None, "kbr_packs", "s-draw").await;
    let prompt = |key: &str| prepared.agents[key]["prompt"].as_str().expect("prompt").to_string();
    for role in ["ba", "pm", "dev", "designer"] {
        assert!(prompt(role).contains("draw.io Diagram"), "{role}");
    }
    // the Designer presents a design document and measures it against the guide's exemplar boards
    for needle in [
        "design document",
        "exemplar boards",
        "Foundations board",
        "side by side",
        "spec per screen",
        "craft.md",
        "three ways",
        "template-like",
    ] {
        assert!(prompt("designer").contains(needle), "{needle}");
    }
    // a role with a guide of its own is told to open it
    assert!(prompt("dev").contains("`kanban-board:role-dev`"));
    assert!(!prepared.agents.contains_key("triage"));
}
