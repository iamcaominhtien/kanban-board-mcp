//! `tests/test_visual_tools_267.py` (issue #267), the part that waited for `launch`: the drawing guides reach a run as
//! skills of the plugin folder it is started with, a team with a Designer also gets the canvas guide and its files, and
//! the lead's rules say which skill is for which drawing. The guides' texts are tested with `board_skills`
//! (`crates/kb-ai-know/tests/test_visual_tools_267.rs`). New test, no Python counterpart of its own.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::path::Path;

use serde_json::json;

#[tokio::test]
async fn a_run_gets_the_drawing_guides_as_skills_of_its_plugin_folder() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let code = common::team_of(&pid, "Dev An", json!({})).await;
    let ui = common::team_of(&pid, "UI Team", json!({"pack_key": "feature_ui"})).await;
    let code = common::launch_of(code["id"].as_str().expect("id"), None, "kbr_draw", "s-code").await;
    let ui = common::launch_of(ui["id"].as_str().expect("id"), None, "kbr_draw", "s-ui").await;
    let skill = |run: &kb_ai_run::launch::Launch, rel: &str| Path::new(&run.plugin_dirs[1]).join("skills").join(rel);
    for run in [&code, &ui] {
        assert!(skill(run, "drawio-diagrams/SKILL.md").is_file());
        assert!(skill(run, "sketches/SKILL.md").is_file());
        assert!(run.system.contains(
            "- a diagram: `kanban-board:drawio-diagrams`; a screen or a mockup: `kanban-board:canvas-design`"
        ));
    }
    // a craft skill only for a team with a role that does that work
    assert!(!skill(&code, "canvas-design").exists());
    assert!(skill(&ui, "canvas-design/SKILL.md").is_file() && skill(&ui, "canvas-design/craft.md").is_file());
    assert!(std::fs::read_dir(skill(&ui, "canvas-design/examples")).expect("examples").count() > 0);
    // two teams with different skills get folders of their own
    assert_ne!(code.plugin_dirs[1], ui.plugin_dirs[1]);
    assert!(ui.agents["designer"]["prompt"].as_str().expect("prompt").contains("draw.io Diagram"));
}
