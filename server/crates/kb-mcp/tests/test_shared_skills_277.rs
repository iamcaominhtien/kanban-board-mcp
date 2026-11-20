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
    // without a name: the guides every ticket needs, and `more` names the ones read when the work needs them
    let guides = call(&s.mcp(), "docs_read", json!({"action": "guides"})).await;
    let on_request = kb_mcp::operations::canvases::GUIDES_ON_REQUEST;
    let names: Vec<&str> = guides.as_object().expect("guides").keys().map(String::as_str).collect();
    let core: Vec<&str> = SHARED.iter().copied().filter(|n| !on_request.contains(n)).collect();
    assert_eq!(names, [core.clone(), vec!["more"]].concat());
    let more: Vec<&str> = guides["more"].as_object().expect("more").keys().map(String::as_str).collect();
    assert_eq!(more, on_request);
    assert!(guides["more"]["slides"].as_str().is_some_and(|d| !d.is_empty()), "what each is for");
    // with a name: that guide, the same text as the skill
    let shared = kb_skills::shared_skills::guides();
    let root = s.db_path().parent().expect("the data folder").join("board-skills");
    for name in SHARED {
        let one = call(&s.mcp(), "docs_read", json!({"action": "guides", "query": name})).await;
        let body = &shared.iter().find(|(n, _)| n == name).expect("a shared guide").1;
        // Claude Code's `${CLAUDE_SKILL_DIR}` is the guide's folder on this machine
        let dir = root.join("skills").join(name);
        let body = body.replace("${CLAUDE_SKILL_DIR}", dir.to_string_lossy().as_ref());
        assert!(one[name].as_str().expect("text").starts_with(body.as_str()), "{name}");
        if core.contains(&name) {
            assert_eq!(one[name], guides[name], "{name}");
        }
    }
    // a guide with files says where they are, so an outside agent can run its scripts
    let slides = root.join("skills").join("slides");
    let one = call(&s.mcp(), "docs_read", json!({"action": "guides", "query": "slides"})).await;
    let text = one["slides"].as_str().expect("text");
    assert!(text.contains(slides.to_string_lossy().as_ref()));
    // its commands name that folder, not Claude Code's variable
    assert!(!text.contains("${CLAUDE_SKILL_DIR}") && text.matches(slides.to_string_lossy().as_ref()).count() > 1);
    let unknown = common::call_err(&s.mcp(), "docs_read", json!({"action": "guides", "query": "cooking"})).await;
    assert!(unknown.contains("No guide 'cooking'") && unknown.contains("slides"), "{unknown}");
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
