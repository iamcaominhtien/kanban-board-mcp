//! The launcher of the AI team v2 (`tests/test_ai_launch_v2.py`): the parts that go through `plugins` and `roles`.
//!
//! Left for the launcher (`kb-ai-run`, `launch.prepare` and `launch.board_rules`): the `prepared.plugin_dirs` and
//! `prepared.system` of `test_a_project_plugin_reaches_a_team_that_has_one_of_its_roles` (here its two inputs,
//! `plugins::dirs_for` and `plugins::skills_block`, are asserted), the `launch.board_rules` half of
//! `test_each_role_is_told_to_open_its_guide_and_the_lead_gets_the_skill_table`, and every other test of the file.
//! `test_board_skills_follow_the_teams_roles` is in `test_shared_skills_277.rs` next to the other `board_skills` tests.

mod common;

use std::collections::HashSet;

use kb_ai_know::{plugins, roles};
use kb_db::database;
use serde_json::json;

#[tokio::test]
async fn test_a_project_plugin_reaches_a_team_that_has_one_of_its_roles() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let (pid, _an) = common::project().await;
    // the standard pack: dev, reviewer, qa
    let (m, team) = common::team(&pid, "Claude Code · Backend", Default::default()).await;
    let folder = |name: &str| tmp.path().join(name);
    common::plugin_row(&pid, &folder("flow"), "flow", &["pm", "dev"], |_| {}).await;
    common::plugin_row(&pid, &folder("tufte"), "tufte", &["designer"], |_| {}).await;
    common::plugin_row(&pid, &folder("everyone"), "everyone", &[], |r| {
        r.default_on = kb_db::sea_orm::ActiveValue::Set(true);
    })
    .await;
    common::plugin_row(&pid, &folder("off-here"), "off-here", &["dev"], |r| {
        r.members = kb_db::sea_orm::ActiveValue::Set(json!({ m.id.clone(): false }).to_string());
    })
    .await;
    let session = database::session();
    let dirs = plugins::dirs_for(&session, &team, None).await.expect("dirs");
    let loaded: HashSet<String> = dirs.iter().map(|d| d.rsplit('/').next().unwrap_or_default().to_string()).collect();
    assert!(loaded.contains("flow") && loaded.contains("everyone"), "{loaded:?}");
    assert!(!loaded.contains("tufte") && !loaded.contains("off-here"), "{loaded:?}");
    // the run's prompt names the installed skills by the name the Skill tool takes
    let system = plugins::skills_block(&session, &team, None).await.expect("block");
    assert!(system.contains("`flow:flow-skill`") && system.contains("`everyone:everyone-skill`"), "{system}");
    assert!(!system.contains("tufte-skill"));
    // with the keys of other roles the answer follows them
    let designer: HashSet<String> = ["designer".to_string()].into_iter().collect();
    let dirs = plugins::dirs_for(&session, &team, Some(&designer)).await.expect("dirs");
    let loaded: HashSet<String> = dirs.iter().map(|d| d.rsplit('/').next().unwrap_or_default().to_string()).collect();
    assert_eq!(loaded, ["tufte", "everyone"].iter().map(|s| s.to_string()).collect());
    // a team's role keys come from its pack
    let keys = plugins::team_role_keys(&session, &team).await.expect("keys");
    assert_eq!(keys, ["dev", "reviewer", "qa"].iter().map(|s| s.to_string()).collect());
}

#[test]
fn test_each_role_is_told_to_open_its_guide_and_the_lead_gets_the_skill_table() {
    let rs: Vec<roles::Role> = vec![
        json!({"key": "dev", "prompt": "Code."}).as_object().expect("role").clone(),
        json!({"key": "designer", "prompt": "Draw."}).as_object().expect("role").clone(),
    ];
    let agents = roles::agents_json(&rs, "");
    assert!(agents["dev"]["prompt"].as_str().expect("prompt").contains("`kanban-board:role-dev`"));
    // no role guide of its own: canvas-design is its craft
    assert!(!agents["designer"]["prompt"].as_str().expect("prompt").contains("role-"));
}
