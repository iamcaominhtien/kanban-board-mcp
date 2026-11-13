//! Visual tools (issue #267): the draw.io and Sketch guides are skills of the board's own plugin, and each role that
//! draws is pointed at the right tool (`tests/test_visual_tools_267.py`): the parts that go through `board_skills`,
//! `packs` and `plugins`.
//!
//! Left for later tasks: `test_the_instructions_say_which_tool_and_where_the_guides_are` (the MCP instructions,
//! `kb-mcp`), and every test of the file that goes through the diagram, sketch and picture tools or the routes (`kb-mcp`
//! and `kb-draw`'s tools): they do not use these modules.

mod common;

use std::path::PathBuf;

use kb_ai_know::{board_skills, packs, plugins};
use kb_draw::visual_guides;
use serde_json::Value;

fn persona_of(key: &str) -> String {
    packs::BUILTIN.iter().find(|p| p["key"] == key).and_then(|p| p["persona"].as_str()).unwrap_or_default().to_string()
}

#[tokio::test]
async fn test_the_diagram_and_sketch_guides_are_skills_and_the_same_text_through_docs_read() {
    let _guard = common::init().await;
    let root = PathBuf::from(board_skills::plugin_dir(None).expect("plugin folder")).join("skills");
    let guide = visual_guides::diagram_guide();
    let drawio = std::fs::read_to_string(root.join("drawio-diagrams").join("SKILL.md")).expect("SKILL.md");
    assert_eq!(drawio, format!("{}{}", visual_guides::DRAWIO_HEADER, guide["guide"].as_str().expect("guide")));
    let sketches = std::fs::read_to_string(root.join("sketches").join("SKILL.md")).expect("SKILL.md");
    assert_eq!(sketches, format!("{}{}", visual_guides::SKETCH_HEADER, guide["sketches"].as_str().expect("guide")));
    let names: Vec<Value> = board_skills::catalog().iter().map(|s| s["name"].clone()).collect();
    assert_eq!(names[..3], ["canvas-design", "drawio-diagrams", "sketches"]);
    // what the guide must teach (the issue's list) and the choice of tool at its top
    let text = guide["guide"].as_str().expect("guide");
    for needle in [
        "## Which tool",
        "**Flowchart**",
        "**Swimlane flowchart**",
        "**Sequence**",
        "**State machine**",
        "## 2. Layout on a grid",
        "## 3. Style from one palette",
        "## 4. Labels",
        "## 5. Groups, containers and lanes",
        "## 7. Changing an existing diagram",
        "change **only those cells**",
        "docs_read(action='picture'",
        "## 9. Hand it in",
    ] {
        assert!(text.contains(needle), "{needle}");
    }
    // the Sketch decision is written down, with its reason
    let sketch = guide["sketches"].as_str().expect("guide");
    assert!(sketch.contains("You read Sketches; you do not draw them"));
    assert!(sketch.contains("fake hand-drawn look"));
}

#[test]
fn test_each_role_that_draws_is_pointed_at_the_right_tool() {
    for role in ["pm", "ba", "designer", "dev"] {
        assert!(persona_of(role).contains("drawio-diagrams"), "{role}");
    }
    assert!(persona_of("designer").contains("docs_read(picture)"));
    assert!(persona_of("ba").contains("never one you draw"));
    // live runs: a BA and a Dev that were only told a diagram "helps" drew none (#267)
    assert!(persona_of("ba").contains("you hand in a draw.io Diagram"));
    assert!(persona_of("dev").contains("carries a draw.io Diagram"));
    const { assert!(packs::BUILTIN_VERSION >= 10) }; // 11 since issue #273 (a skill per role)
}

#[test]
fn test_flow_is_suggested_and_the_draw_io_guide_says_how_its_files_reach_the_board() {
    let flow = plugins::CATALOGUE.iter().find(|c| c["key"] == "flow").expect("flow");
    assert_eq!(flow["source"], "https://github.com/iamcaominhtien/flow");
    assert_eq!(flow["plugin"], "flow");
    assert!(flow.get("ui").is_none_or(|v| !kb_base::pyjson::truthy(v)));
    let roles: std::collections::HashSet<&str> =
        flow["roles"].as_array().expect("roles").iter().map(|r| r.as_str().expect("role")).collect();
    assert_eq!(roles, ["pm", "ba", "designer", "dev"].into_iter().collect());
    for needle in ["**With Flow.**", "flow.py build", "flow:author", "flow:edit-drawio", "node-<id>"] {
        assert!(visual_guides::DRAWIO.contains(needle), "{needle}");
    }
}
