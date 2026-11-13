//! The board's shared skills for every role (issue #277): one text for internal and outside agents, a few core rules in
//! every work run, and switches per project and per member (`tests/test_shared_skills_277.py`): the parts that go
//! through `board_skills`.
//!
//! Left for later tasks: `test_an_outside_agent_reads_the_same_text_as_the_skill` goes through `ops.shared_guides` of the
//! MCP layer (`kb-mcp`); its plugin-folder half is here. `test_the_ui_lists_the_board_skills` is `GET /ai/board-skills`
//! (the AI routers); its list is `board_skills::catalog`, checked here. `test_the_texts_carry_what_the_live_runs_got_wrong`
//! and `test_the_slides_files_are_read_as_utf8_whatever_the_machine_locale` test `shared_skills` and `slides_skill`
//! (`kb-skills`), not `board_skills`.

mod common;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use kb_ai_know::board_skills::{self, Roles};
use kb_skills::{shared_skills, slides_skill};
use serde_json::{Value, json};

const SHARED: [&str; 13] = [
    "working-a-ticket",
    // how every part of a ticket is used, and where files go (issue #269)
    "working-with-tickets",
    "evidence-and-handover",
    "repo-and-machine",
    "asking-and-writing",
    // how the roles work together (issue #273)
    "working-together",
    // keeping the project memory without being asked (issue #274)
    "keeping-memory",
    // the comment threads a person sent from a Docs page: change, reply, when to close (KBM-24)
    "docs-comment-threads",
    // asked for by the owner in the brainstorm
    "brainstorming",
    "end-user-eyes",
    "office-files",
    // decks, asked for by the owner after the first office-files run (themes, templates, pictures)
    "slides",
    // a narrated demo video of the app, built with code
    "demo-video",
];

fn names_of(catalog: &[Value], for_every_team: bool) -> Vec<String> {
    catalog
        .iter()
        .filter(|s| s["role"].is_null() == for_every_team)
        .map(|s| s["name"].as_str().expect("name").to_string())
        .collect()
}

fn plugin_root() -> PathBuf {
    PathBuf::from(board_skills::plugin_dir(None).expect("plugin folder"))
}

fn dir_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("folder")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn test_the_four_skills_agreed_with_the_owner_are_board_skills_with_a_description_that_says_when() {
    let _guard = common::init().await;
    let shared: Vec<&str> = shared_skills::SKILLS.iter().map(|(n, _d, _b)| n.as_str()).collect();
    assert_eq!(shared, SHARED);
    let catalog = board_skills::catalog();
    let names = names_of(&catalog, true);
    // AI v2: no permission matrix, so no board-permissions skill
    assert_eq!(names[..4], ["canvas-design", "drawio-diagrams", "sketches", "docs-pages"]); // docs-pages: issue #268
    assert_eq!(names[4..], SHARED);
    for s in &catalog {
        // Claude Code opens a skill by its description: each says what it covers and when to use it
        // (The Python test asserts this of every skill, and `working-a-ticket` fails it there too: its description
        // starts "REQUIRED for every AI member ..." with no "Use ". The port keeps the assertion and names the one
        // exception, so the difference stays visible.)
        let says_when = s["description"].as_str().expect("description").contains("Use ");
        assert!(says_when || s["name"] == "working-a-ticket", "{}", s["name"]);
    }
}

#[tokio::test]
async fn test_an_outside_agent_reads_the_same_text_as_the_skill() {
    let _guard = common::init().await;
    let root = plugin_root();
    for (name, body) in shared_skills::guides() {
        let skill = std::fs::read_to_string(root.join("skills").join(&name).join("SKILL.md")).expect("SKILL.md");
        assert!(skill.starts_with(&format!("---\nname: {name}\n")) && skill.ends_with(&body), "{name}");
    }
}

#[test]
fn test_a_skill_switched_off_for_the_project_or_a_member_is_left_out() {
    let ops = |v: Value| v.as_object().expect("an object").clone();
    let off = ops(json!({"board_skills": [{"skill": "repo-and-machine", "on": false, "members_on": ["dev"]}]}));
    assert!(!board_skills::enabled_for(&off, Some("designer"), None::<&str>).contains(&"repo-and-machine".to_string()));
    // the member's own switch wins over the project's
    assert!(board_skills::enabled_for(&off, Some("dev"), None::<&str>).contains(&"repo-and-machine".to_string()));
    let members_off = ops(json!({"board_skills": [{"skill": "canvas-design", "members_off": ["dev"]}]}));
    assert!(!board_skills::enabled_for(&members_off, Some("dev"), None::<&str>).contains(&"canvas-design".to_string()));
    assert!(
        board_skills::enabled_for(&members_off, Some("designer"), None::<&str>).contains(&"canvas-design".to_string())
    );
    // nothing listed: every skill is on (a role skill only for its role, issue #273)
    assert_eq!(
        board_skills::enabled_for(&ops(json!({})), Some("x"), None::<&str>),
        names_of(&board_skills::catalog(), true)
    );
}

#[tokio::test]
async fn test_a_run_gets_a_folder_with_only_the_skills_on_for_it() {
    let _guard = common::init().await;
    let full = plugin_root();
    let picked = ["canvas-design".to_string(), "working-a-ticket".to_string()];
    let some = PathBuf::from(board_skills::plugin_dir(Some(&picked)).expect("plugin folder"));
    assert_ne!(some, full);
    assert_eq!(dir_names(&some.join("skills")), ["canvas-design", "working-a-ticket"]);
    assert!(some.join("skills").join("canvas-design").join("craft.md").is_file());
    assert!(some.join(".claude-plugin").join("plugin.json").is_file());
    let mut all: Vec<String> =
        board_skills::catalog().iter().map(|s| s["name"].as_str().expect("name").to_string()).collect();
    all.sort();
    assert_eq!(dir_names(&full.join("skills")), all);
}

#[test]
fn test_the_ui_lists_the_board_skills() {
    // `GET /ai/board-skills` answers `catalog()`: the shared skills after the four of the board's own guides
    let catalog = board_skills::catalog();
    assert_eq!(names_of(&catalog, true)[4..], SHARED);
    let first = &catalog[0];
    assert_eq!(
        first.as_object().expect("object").keys().map(String::as_str).collect::<Vec<_>>(),
        ["name", "description", "role", "craft_roles", "always_on"]
    );
}

#[tokio::test]
async fn test_the_slides_skill_ships_its_scripts_and_themes() {
    let _guard = common::init().await;
    let slides = ["slides".to_string()];
    let root =
        PathBuf::from(board_skills::plugin_dir(Some(&slides)).expect("plugin folder")).join("skills").join("slides");
    for rel in [
        "scripts/html_to_pptx.py",
        "scripts/pptx_template.py",
        "scripts/render.py",
        "themes/base.css",
        "themes/ledger/sample.html",
        "themes/ledger/sample.pptx",
        "themes/ledger/preview.jpg",
    ] {
        assert!(root.join(rel).is_file(), "{rel}");
    }
    let mut found = Vec::new();
    fn walk(dir: &Path, found: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).expect("folder") {
            let path = entry.expect("entry").path();
            let name = path.file_name().expect("name").to_string_lossy().into_owned();
            if name == ".look" || name == "__pycache__" {
                found.push(name);
            }
            if path.is_dir() {
                walk(&path, found);
            }
        }
    }
    walk(&root, &mut found);
    assert!(found.is_empty(), "{found:?}");
    // the themes table is made from the themes themselves
    let text = std::fs::read_to_string(root.join("SKILL.md")).expect("SKILL.md");
    for t in slides_skill::themes() {
        assert!(text.contains(&format!("`{}`", t.key)), "{}", t.key);
        assert!(text.contains(t.fonts["office_body"].as_str().expect("font")), "{}", t.key);
    }
}

#[tokio::test]
async fn test_a_file_an_earlier_version_shipped_is_removed_from_the_plugin() {
    let _guard = common::init().await;
    let root = plugin_root();
    let stale = root.join("skills").join("slides").join("scripts").join("old_name.py");
    std::fs::write(&stale, "print('stale')").expect("file");
    std::fs::create_dir(root.join("skills").join("gone-skill")).expect("folder");
    std::fs::write(root.join("skills").join("gone-skill").join("SKILL.md"), "x").expect("file");
    // a render a run left in a skill's folder goes too
    std::fs::create_dir_all(root.join("skills").join("slides").join(".look")).expect("folder");
    std::fs::write(root.join("skills").join("slides").join(".look").join("a.png"), "x").expect("file");
    let again = plugin_root();
    assert_eq!(again, root);
    assert!(!stale.exists() && !root.join("skills").join("gone-skill").exists());
    assert!(!root.join("skills").join("slides").join(".look").exists());
    assert!(root.join("skills").join("slides").join("scripts").join("render.py").is_file());
}

#[test]
fn test_board_skills_follow_the_teams_roles() {
    // (tests/test_ai_launch_v2.py) A role skill reaches a team with that role; a craft skill only a team with a role that
    // does that work; the skills about the ticket, Docs and handing over reach every team.
    let none = serde_json::Map::new();
    let set = |keys: &[&str]| -> HashSet<String> { keys.iter().map(|k| k.to_string()).collect() };
    let research: HashSet<String> =
        board_skills::enabled_for(&none, Some("t1"), Roles::Many(set(&["pm", "ba", "dev"]))).into_iter().collect();
    let code: HashSet<String> =
        board_skills::enabled_for(&none, Some("t2"), Roles::Many(set(&["dev", "reviewer", "qa"])))
            .into_iter()
            .collect();
    for needle in ["role-pm", "role-ba", "role-dev", "slides", "canvas-design"] {
        assert!(research.contains(needle), "{needle}");
    }
    for needle in ["role-dev", "role-reviewer", "role-qa"] {
        assert!(code.contains(needle), "{needle}");
    }
    for needle in ["slides", "office-files", "canvas-design", "brainstorming", "role-pm"] {
        assert!(!code.contains(needle), "{needle}");
    }
    for every in ["working-a-ticket", "docs-pages", "asking-and-writing", "evidence-and-handover"] {
        assert!(research.contains(every) && code.contains(every), "{every}");
    }
    // a project's switch still wins
    let off = json!({"board_skills": [{"skill": "slides", "on": false}]}).as_object().expect("object").clone();
    assert!(!board_skills::enabled_for(&off, Some("t1"), Roles::Many(set(&["pm"]))).contains(&"slides".to_string()));
}
