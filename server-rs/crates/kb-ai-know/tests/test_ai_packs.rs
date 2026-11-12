//! Members made from the ready-made packs get the tools their pack's work needs (`tests/test_ai_packs.py`).
//!
//! Left for the `kb-mcp` task: the last assertion of the Python test, that the MCP server's instructions carry "Which
//! drawing" (`kanban_mcp.instructions`). The pack service itself (`save_pack`, `list_packs`, `import_pack`,
//! `install_plugins`) has no Python test of its own; the tests at the end of this file are new and go through the
//! database.

mod common;

use kb_ai_know::packs;
use serde_json::{Map, Value, json};

fn persona_of(key: &str) -> String {
    packs::BUILTIN.iter().find(|p| p["key"] == key).and_then(|p| p["persona"].as_str()).unwrap_or_default().to_string()
}

#[test]
fn test_the_roles_know_which_drawing_to_use() {
    for role in ["ba", "pm", "dev", "designer"] {
        assert!(persona_of(role).contains("draw.io Diagram"), "{role}");
    }
    // the Designer presents a design document and measures it against the guide's exemplar boards
    let designer = persona_of("designer");
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
        assert!(designer.contains(needle), "{needle}");
    }
}

fn body(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

#[tokio::test]
async fn a_project_saves_versions_lists_exports_and_deletes_its_own_packs() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let session = kb_db::session();
    // editing a ready-made pack makes the project's own copy, from the ready-made fields
    let first = packs::save_pack(
        &session,
        &pid,
        "Dev (TDD)",
        &body(json!({"name": "My Dev", "effort": "high", "plugins": ["tdd"]})),
        "An",
    )
    .await
    .expect("saved");
    assert_eq!(first["key"], "dev_tdd");
    assert_eq!(first["version"], 1);
    assert_eq!(first["builtin"], false);
    assert_eq!(first["name"], "My Dev");
    assert_eq!(first["effort"], "high");
    let again = packs::save_pack(&session, &pid, "dev_tdd", &body(json!({"name": "My Dev", "model": "opus"})), "Bao")
        .await
        .expect("saved");
    assert_eq!(again["version"], 2);
    assert_eq!(again["effort"], "high", "the earlier fields stay");
    assert_eq!(again["model"], "opus");
    assert_eq!(again["updated_by"], "Bao");
    let row = kb_db::entities::ai_role_pack::Entity::find_by_id(first["id"].as_str().expect("id").to_string())
        .one(&session)
        .await
        .expect("row")
        .expect("a row");
    let history: Vec<Value> = serde_json::from_str(&row.history).expect("history");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["version"], 1);
    assert_eq!(history[0]["by"], "An");
    // a ready-made key keeps its place in the list, the project's version wins; its own packs follow by name
    packs::save_pack(&session, &pid, "zeta", &body(json!({"name": "Zeta"})), "An").await.expect("saved");
    packs::save_pack(&session, &pid, "alpha", &body(json!({"name": "alpha"})), "An").await.expect("saved");
    let listed = packs::list_packs(&session, &pid).await.expect("list");
    let keys: Vec<&str> = listed.iter().map(|p| p["key"].as_str().expect("key")).collect();
    assert_eq!(&keys[..12], packs::BUILTIN_KEYS.iter().map(String::as_str).collect::<Vec<_>>().as_slice());
    assert_eq!(&keys[12..], ["alpha", "dev_tdd", "zeta"], "by name: alpha, My Dev, Zeta");
    let dev = listed.iter().find(|p| p["key"] == "dev").expect("dev");
    assert_eq!(dev["builtin"], true, "the key `dev` is not `dev_tdd`");
    let own = packs::get_pack(&session, &pid, "dev_tdd").await.expect("get").expect("a pack");
    assert_eq!(own["version"], 2);
    let ready = packs::get_pack(&session, &pid, "qa").await.expect("get").expect("a pack");
    assert_eq!((ready["id"].as_str(), ready["version"].as_i64()), (Some("builtin:qa"), Some(packs::BUILTIN_VERSION)));
    assert!(packs::get_pack(&session, &pid, "nope").await.expect("get").is_none());
    // export and import carry the whole pack
    let file = packs::export(&own);
    assert_eq!(file["format"], packs::FORMAT);
    let (other, _an) = common::project().await;
    let imported = packs::import_pack(&session, &other, &file, "An").await.expect("imported");
    assert_eq!(imported["pack"]["name"], "My Dev");
    assert_eq!(imported["missing"], json!(["tdd"]), "the plugin the pack names is not installed there");
    let refused = packs::import_pack(&session, &other, &json!({"format": "x"}), "An").await;
    assert_eq!(refused.expect_err("refused").to_string(), "This is not a role pack file.");
    // delete: its own pack goes, the ready-made one is back in its place
    assert!(packs::delete_pack(&session, &pid, "dev_tdd").await.expect("deleted"));
    assert!(!packs::delete_pack(&session, &pid, "dev_tdd").await.expect("deleted"));
    session.commit().await.expect("commit");
}

use kb_db::sea_orm::EntityTrait;

#[tokio::test]
async fn a_pack_is_checked_before_it_is_saved() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let session = kb_db::session();
    for (key, input, why) in [
        ("x", json!({}), "A pack needs a name."),
        ("x", json!({"name": "X", "model": "gpt"}), "The model is haiku, sonnet, opus or a full model id."),
        ("x", json!({"name": "X", "effort": "ultra"}), "The effort is low, medium, high, xhigh or max."),
        ("x", json!({"name": "X", "plugins": "tdd"}), "plugins must be a list."),
        ("!!!", json!({"name": "X"}), "A pack needs a key."),
    ] {
        let err = packs::save_pack(&session, &pid, key, &body(input.clone()), "An").await.expect_err("refused");
        assert_eq!(err.to_string(), why, "{input}");
    }
    // the edit dialog sends null lists: nothing to change, not a bad value
    let ok =
        packs::save_pack(&session, &pid, "pm", &body(json!({"name": "PM", "personas": null, "plugins": null})), "An")
            .await
            .expect("saved");
    assert!(ok.get("personas").is_none());
}
