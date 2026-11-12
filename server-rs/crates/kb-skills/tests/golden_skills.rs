//! Golden vectors from the Python server (`contract/golden/gen_skills.py` -> `skills.json`): every text constant
//! and every assembled output of `shared_skills` and `role_skills`, and for each skill folder the names and the
//! SHA-256 of every file `files()` hands out. A long text is stored as its hash and length.

use std::collections::BTreeMap;
use std::path::Path;

use kb_skills::{assets, ba_templates, demo_video_skill, role_skills, shared_skills, slides_skill};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../contract/golden/skills.json")).expect("skills.json")
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A text against its `{sha256, chars, bytes}` entry.
fn check_text(what: &str, text: &str, expected: &Value) {
    assert_eq!(text.chars().count() as u64, expected["chars"].as_u64().unwrap(), "{what}: length in characters");
    assert_eq!(text.len() as u64, expected["bytes"].as_u64().unwrap(), "{what}: length in bytes");
    assert_eq!(hex(text.as_bytes()), expected["sha256"].as_str().unwrap(), "{what}: sha256");
}

/// A list of files against `[[name, sha256, size], ...]`, in the same order.
fn check_files(what: &str, files: &[(String, &[u8])], expected: &Value) {
    let want: Vec<(String, String, u64)> = expected
        .as_array()
        .unwrap_or_else(|| panic!("{what}: a list"))
        .iter()
        .map(|e| (e[0].as_str().unwrap().to_string(), e[1].as_str().unwrap().to_string(), e[2].as_u64().unwrap()))
        .collect();
    let got: Vec<(String, String, u64)> =
        files.iter().map(|(name, bytes)| (name.clone(), hex(bytes), bytes.len() as u64)).collect();
    assert_eq!(
        got.iter().map(|g| &g.0).collect::<Vec<_>>(),
        want.iter().map(|w| &w.0).collect::<Vec<_>>(),
        "{what}: names and order"
    );
    for (g, w) in got.iter().zip(&want) {
        assert_eq!(g, w, "{what}: {}", g.0);
    }
}

fn borrowed(files: Vec<(&'static str, &'static [u8])>) -> Vec<(String, &'static [u8])> {
    files.into_iter().map(|(n, b)| (n.to_string(), b)).collect()
}

#[test]
fn the_shared_skills_are_the_same_texts() {
    let g = &golden()["shared"];
    let skills = g["skills"].as_array().unwrap();
    assert_eq!(shared_skills::SKILLS.len(), skills.len());
    for ((name, desc, body), want) in shared_skills::SKILLS.iter().zip(skills) {
        assert_eq!(name, want["name"].as_str().unwrap());
        check_text(&format!("{name} description"), desc, &want["description"]);
        check_text(&format!("{name} body"), body, &want["body"]);
    }
}

#[test]
fn the_shared_skill_files_guides_and_core_rules() {
    let g = &golden()["shared"];
    let files = shared_skills::skill_files();
    let want = g["skill_files"].as_object().unwrap();
    assert_eq!(
        files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(),
        want.keys().map(String::as_str).collect::<Vec<_>>()
    );
    for (name, text) in &files {
        check_text(&format!("SKILL.md of {name}"), text, &want[name]);
    }
    let guides = shared_skills::guides();
    let want = g["guides"].as_object().unwrap();
    assert_eq!(
        guides.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(),
        want.keys().map(String::as_str).collect::<Vec<_>>()
    );
    for (name, text) in &guides {
        check_text(&format!("guide {name}"), text, &want[name]);
    }
    let rules = g["core_rules"].as_array().unwrap();
    assert_eq!(shared_skills::CORE_RULES.len(), rules.len());
    for (i, (rule, want)) in shared_skills::CORE_RULES.iter().zip(rules).enumerate() {
        check_text(&format!("core rule {i}"), rule, want);
    }
    check_text("header", &shared_skills::header("some-name", "some description"), &g["header_example"]);
}

#[test]
fn the_ticket_guide_in_kb_board_is_the_shared_tickets_skill() {
    let want = &golden()["shared"]["tickets"];
    let (name, desc, body) = &*shared_skills::TICKETS;
    assert_eq!(name, want["name"].as_str().unwrap());
    check_text("working-with-tickets description", desc, &want["description"]);
    check_text("working-with-tickets body", body, &want["body"]);
}

#[test]
fn the_files_a_shared_skill_carries() {
    let want = golden()["shared"]["extra_files"].clone();
    let got = shared_skills::extra_files();
    assert_eq!(
        got.iter().map(|g| g.0.as_str()).collect::<Vec<_>>(),
        want.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>()
    );
    for (skill, files) in &got {
        let files: Vec<(String, &[u8])> = files.iter().map(|(n, b)| (n.clone(), *b)).collect();
        check_files(&format!("extra files of {skill}"), &files, &want[skill]);
    }
}

#[test]
fn the_role_skills_are_the_same_texts() {
    let g = &golden()["roles"];
    let skills = g["skills"].as_array().unwrap();
    assert_eq!(role_skills::ROLE_SKILLS.len(), skills.len());
    for ((role, name, desc, body), want) in role_skills::ROLE_SKILLS.iter().zip(skills) {
        assert_eq!((*role, *name), (want["role"].as_str().unwrap(), want["name"].as_str().unwrap()));
        check_text(&format!("{name} description"), desc, &want["description"]);
        check_text(&format!("{name} body"), body, &want["body"]);
    }
    let files = role_skills::skill_files();
    let want = g["skill_files"].as_object().unwrap();
    assert_eq!(
        files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(),
        want.keys().map(String::as_str).collect::<Vec<_>>()
    );
    for (name, text) in &files {
        check_text(&format!("SKILL.md of {name}"), text, &want[name]);
    }
    let names: Vec<&str> = g["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    assert_eq!(role_skills::names(), names);
    let by_role: BTreeMap<String, String> = g["skill_of_role"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();
    let ours = role_skills::skill_of_role();
    assert_eq!(
        ours.iter().map(|o| o.0).collect::<Vec<_>>(),
        g["skill_of_role"].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>()
    );
    for (role, name) in ours {
        assert_eq!(by_role[role], name);
    }
}

#[test]
fn the_role_lookups_answer_as_python_does() {
    let g = &golden()["roles"];
    for (name, role) in g["role_of_skill"].as_object().unwrap() {
        assert_eq!(role_skills::role_of_skill(name), role.as_str(), "role_of_skill({name:?})");
    }
    for (role, want) in g["guide"].as_object().unwrap() {
        match (role_skills::guide(role), want.is_null()) {
            (None, true) => {}
            (Some(text), false) => check_text(&format!("guide of {role:?}"), text, want),
            (got, _) => panic!("guide({role:?}): {:?} against {want}", got.map(|t| t.len())),
        }
    }
    let want = &g["extra_files"];
    for (skill, files) in role_skills::extra_files() {
        let files: Vec<(String, &[u8])> = files.iter().map(|(n, b)| (n.clone(), *b)).collect();
        check_files(&format!("extra files of {skill}"), &files, &want[&skill]);
    }
}

#[test]
fn the_slides_skill() {
    let g = &golden()["slides"];
    assert_eq!(slides_skill::NAME, g["name"].as_str().unwrap());
    check_text("slides description", slides_skill::DESCRIPTION, &g["description"]);
    check_text("slides body", &slides_skill::body(), &g["body"]);
    let themes = slides_skill::themes();
    let want = g["themes"].as_array().unwrap();
    assert_eq!(themes.len(), want.len());
    for (theme, want) in themes.iter().zip(want) {
        assert_eq!(theme.key, want["key"].as_str().unwrap());
        assert_eq!(theme.label, want["label"].as_str().unwrap());
        assert_eq!(theme.for_, want["for"].as_str().unwrap());
        assert_eq!(theme.fonts, want["fonts"]);
    }
    check_files("slides files()", &slides_skill::files(), &g["files"]);
}

#[test]
fn the_demo_video_skill() {
    let g = &golden()["demo_video"];
    assert_eq!(demo_video_skill::name(), g["name"].as_str().unwrap());
    check_text("demo-video description", demo_video_skill::description(), &g["description"]);
    check_text("demo-video body", &demo_video_skill::body(), &g["body"]);
    check_files("demo-video files()", &demo_video_skill::files(), &g["files"]);
}

#[test]
fn the_ba_templates() {
    let g = &golden()["ba_templates"];
    let docs = g["docs"].as_object().unwrap();
    assert_eq!(ba_templates::DOCS.len(), docs.len());
    for ((key, name, desc), (want_key, want)) in ba_templates::DOCS.iter().zip(docs) {
        assert_eq!(key, want_key);
        assert_eq!((*name, *desc), (want[0].as_str().unwrap(), want[1].as_str().unwrap()));
        check_text(&format!("template {key}"), &ba_templates::text(key).expect("template"), &g["text"][key]);
    }
    check_files("ba_templates files()", &ba_templates::files(), &g["files"]);
    let starters = ba_templates::docs_templates();
    let want = g["docs_templates"].as_object().unwrap();
    assert_eq!(
        starters.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(),
        want.keys().map(String::as_str).collect::<Vec<_>>()
    );
    for (key, template) in &starters {
        assert_eq!(template.name, want[key]["name"].as_str().unwrap());
        assert_eq!(template.description, want[key]["description"].as_str().unwrap());
        check_text(&format!("starter {key}"), &template.markdown, &want[key]["markdown"]);
    }
    assert!(ba_templates::text("nope").is_none());
}

#[test]
fn design_and_office_examples() {
    let g = golden();
    check_files("design_examples", &borrowed(assets::design_examples::files()), &g["design_examples"]);
    let office = g["office_examples"].as_array().unwrap();
    assert_eq!(office.len(), 1);
    assert_eq!(office[0][0], "deck_example.py");
    assert_eq!(hex(assets::office_examples::deck_example()), office[0][1].as_str().unwrap());
}

/// Every file of the packages, whatever `files()` filters out, and the embedded index against the folder on disk:
/// a file added to `assets/` without regenerating `src/asset_index.rs` fails here.
#[test]
fn every_embedded_file_is_the_python_file() {
    let g = golden();
    for (folder, want) in g["folders"].as_object().unwrap() {
        let got = borrowed(assets::folder_files(folder));
        check_files(&format!("assets/{folder}"), &got, want);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let mut on_disk = Vec::new();
    let mut todo = vec![root.clone()];
    while let Some(dir) = todo.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                todo.push(path);
            } else {
                on_disk.push(path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    on_disk.sort();
    let mut embedded: Vec<String> =
        ["slides_skill", "demo_video_skill", "ba_templates", "design_examples", "office_examples"]
            .iter()
            .flat_map(|folder| assets::folder_files(folder).into_iter().map(move |(rel, _)| format!("{folder}/{rel}")))
            .collect();
    embedded.sort();
    assert_eq!(embedded, on_disk, "src/asset_index.rs is out of date: run scripts/gen_assets_index.py");
    for rel in &on_disk {
        let bytes = std::fs::read(root.join(rel)).unwrap();
        let (folder, inner) = rel.split_once('/').unwrap();
        assert_eq!(assets::file(folder, inner).unwrap(), bytes.as_slice(), "{rel}");
    }
}

#[test]
fn files_are_listed_component_by_component() {
    // Python sorts paths by their parts: `a/b` comes before `a.c`, which a sort of the text would not do
    let found = assets::folder_files("slides_skill");
    let rels: Vec<&str> = found.iter().map(|f| f.0).collect();
    let mut by_parts = rels.clone();
    by_parts.sort_by(|a, b| a.split('/').cmp(b.split('/')));
    assert_eq!(rels, by_parts);
    assert!(rels.iter().position(|r| *r == "guide.md") < rels.iter().position(|r| r.starts_with("scripts/")));
}
