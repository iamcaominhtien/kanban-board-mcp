//! `tests/test_shared_skills_277.py`, the tests that go through the MCP server: the board's shared skills for every
//! role (issue #277): the same text for an outside agent (`docs_read(guides)`) as for a skill, and the instructions
//! that say where the guides are.
//!
//! The Python file's other tests are about the AI team (the skill catalogue and the folders written for a run, the
//! packs and prompts, the switches per project and member) or about the skill assets, and wait for the AI port or are
//! unit tests of `kb-skills`. The half of `test_an_outside_agent_reads_the_same_text_as_the_skill` that reads the
//! SKILL.md files of the plugin folder (`board_skills.plugin_dir()`) waits for the AI port.

mod common;

use common::call;
use serde_json::json;
use testkit::Options;

const SHARED: [&str; 13] = [
    "working-a-ticket",
    "working-with-tickets",
    "evidence-and-handover",
    "repo-and-machine",
    "asking-and-writing",
    "working-together",
    "keeping-memory",
    "docs-comment-threads",
    "brainstorming",
    "end-user-eyes",
    "office-files",
    "slides",
    "demo-video",
];

#[tokio::test]
async fn test_an_outside_agent_reads_the_same_text_as_the_skill() {
    let s = common::start().await;
    let guides = call(&s.mcp(), "docs_read", json!({"action": "guides"})).await;
    let names: Vec<&str> = guides.as_object().expect("guides").keys().map(String::as_str).collect();
    assert_eq!(names, SHARED);
    let shared = kb_skills::shared_skills::guides();
    for (name, text) in guides.as_object().expect("guides") {
        let body = &shared.iter().find(|(n, _)| n == name).expect("a shared guide").1;
        assert!(text.as_str().expect("text").starts_with(body.as_str()), "{name}");
    }
    // a guide with files says where they are, so an outside agent can run its scripts
    let root = s.db_path().parent().expect("the data folder").join("board-skills");
    let slides = root.join("skills").join("slides");
    assert!(guides["slides"].as_str().expect("text").contains(slides.to_string_lossy().as_ref()));
}

#[tokio::test]
async fn test_an_outside_agent_is_told_where_the_guides_are() {
    let s = common::start_with(Options {
        env: vec![("KANBAN_MCP_IDEA_TOOLS".to_string(), "1".to_string())],
        ..Options::default()
    })
    .await;
    let reply = s.mcp().initialize().await;
    let text = reply["instructions"].as_str().expect("instructions");
    assert!(text.contains("docs_read(guides)") && text.chars().count() < 10_000);
    // and the core rules themselves, as a board run has them in its prompt
    for rule in kb_skills::shared_skills::CORE_RULES {
        assert!(text.contains(rule), "{rule}");
    }
}
