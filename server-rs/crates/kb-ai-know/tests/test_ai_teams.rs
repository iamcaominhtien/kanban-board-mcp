//! The roles of a team (`tests/test_ai_teams.py`): the two tests that need only `roles` and `packs`.
//!
//! Left for later tasks: every other test of the file (teams, the wizard, the team routes, pause and resume, the team
//! check): `teams`, `launch` and the AI routers (`kb-ai-run` and later).

mod common;

use kb_ai_know::roles;
use serde_json::{Map, Value};

#[test]
fn test_roles_become_agents_json_and_markdown() {
    let rs = roles::catalogue();
    let keys: std::collections::HashSet<&str> = rs.iter().map(|r| r["key"].as_str().expect("key")).collect();
    for needed in ["dev", "reviewer", "qa", "pm", "designer"] {
        assert!(keys.contains(needed), "{needed}");
    }
    let agents = roles::agents_json(&rs[..3], "Report on the board.");
    for (_key, spec) in &agents {
        assert!(!spec["description"].as_str().expect("description").is_empty());
        assert!(spec["prompt"].as_str().expect("prompt").ends_with("Report on the board."));
    }
    let reviewer = rs.iter().find(|r| r["key"] == "reviewer").expect("reviewer");
    assert!(reviewer["tools"].is_null()); // no allow-list: bypass plus a short deny list
    let md = roles::agent_markdown(reviewer, "");
    assert!(md.starts_with("---\nname: reviewer\n") && !md.contains("tools:"));
    let dev = rs.iter().find(|r| r["key"] == "dev").expect("dev");
    assert!(dev["tools"].is_null()); // writes code: every tool of the run
}

#[tokio::test]
async fn test_every_team_pack_resolves_to_known_roles() {
    for (pack, _) in roles::TEAM_PACKS.iter() {
        let out = roles::roles_for(None, "p", Some(pack), &Map::new()).await.expect("roles");
        assert!(!out.is_empty() && out.iter().all(|r| r["prompt"].as_str().is_some_and(|p| !p.is_empty())), "{pack}");
    }
    let _: Option<Value> = None;
}
