//! `tests/test_shared_skills_277.py` (issue #277), the part that waited for `launch`: a run is handed a plugin folder
//! with the board's skills that are on for its team (`--plugin-dir`), the project's and the member's switches reach
//! that folder, and the prompts name the skill every run opens first. The switches themselves are tested with
//! `board_skills` (`crates/kb-ai-know/tests/test_shared_skills_277.rs`). New tests, no Python counterpart of their own
//! (Python covers this through whole runs).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::path::Path;

use kb_ai_know::board_skills;
use serde_json::json;

fn skills_in(dir: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(Path::new(dir).join("skills"))
        .expect("the skills of the plugin folder")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn plugin_dirs(args: &[String]) -> Vec<String> {
    args.iter().enumerate().filter(|(_, a)| *a == "--plugin-dir").map(|(i, _)| args[i + 1].clone()).collect()
}

#[tokio::test]
async fn a_run_is_handed_the_board_plugin_and_the_skills_on_for_its_team() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Dev An", json!({})).await; // dev, reviewer, qa
    let id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let prepared = common::launch_of(id, Some(&tid), "kbr_skills", "s-skills").await;
    // the board's own plugin (the hooks) first, then the skills
    assert_eq!(plugin_dirs(&prepared.args), prepared.plugin_dirs);
    assert_eq!(prepared.plugin_dirs.len(), 2);
    assert!(Path::new(&prepared.plugin_dirs[0]).join("hooks").join("hooks.json").is_file());
    let folder = &prepared.plugin_dirs[1];
    assert!(Path::new(folder).join(".claude-plugin").join("plugin.json").is_file());
    let on = skills_in(folder);
    let mut expected = board_skills::enabled_for(
        &Default::default(),
        Some(id),
        ["dev", "reviewer", "qa"].map(String::from).into_iter().collect::<std::collections::HashSet<_>>(),
    );
    expected.sort();
    assert_eq!(on, expected);
    for every in
        ["working-a-ticket", "docs-pages", "asking-and-writing", "evidence-and-handover", "role-dev", "role-qa"]
    {
        assert!(on.iter().any(|s| s == every), "{every}");
        assert!(Path::new(folder).join("skills").join(every).join("SKILL.md").is_file(), "{every}");
    }
    for other in ["slides", "canvas-design", "role-pm"] {
        assert!(!on.iter().any(|s| s == other), "{other} is not for a team of dev, reviewer and qa");
    }
    // the lead and every role are told to open the one skill that is always on
    assert!(
        prepared
            .system
            .contains("REQUIRED, for you and every role: before any other work, open `kanban-board:working-a-ticket`")
    );
    let sub =
        std::fs::read_to_string(common::flag(&prepared.args, "--append-subagent-system-prompt-file")).expect("file");
    assert!(sub.contains("`kanban-board:working-a-ticket` with the Skill tool"));
}

#[tokio::test]
async fn test_a_skill_switched_off_for_the_project_or_a_member_is_left_out() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Dev An", json!({})).await;
    let other = common::team_of(&pid, "Dev Binh", json!({})).await;
    let (id, other_id) = (team["id"].as_str().expect("id"), other["id"].as_str().expect("id"));
    common::set_ops(
        &pid,
        json!({"board_skills": [
            {"skill": "repo-and-machine", "on": false, "members_on": [id]},
            {"skill": "docs-pages", "members_off": [id]},
            {"skill": "working-a-ticket", "on": false},
        ]}),
    )
    .await;
    let mine = common::launch_of(id, None, "kbr_skills", "s-mine").await;
    let theirs = common::launch_of(other_id, None, "kbr_skills", "s-theirs").await;
    let (mine, theirs) = (skills_in(&mine.plugin_dirs[1]), skills_in(&theirs.plugin_dirs[1]));
    let has = |list: &[String], name: &str| list.iter().any(|s| s == name);
    // the member's own switch wins over the project's
    assert!(has(&mine, "repo-and-machine") && !has(&theirs, "repo-and-machine"));
    assert!(!has(&mine, "docs-pages") && has(&theirs, "docs-pages"));
    // the skill every run opens first cannot be switched off
    assert!(has(&mine, "working-a-ticket") && has(&theirs, "working-a-ticket"));
}
