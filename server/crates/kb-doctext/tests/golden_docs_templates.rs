//! `services/docs_templates.py` and `services/docs_guide.py` against what Python holds
//! (`contract/golden/docs_templates.json`, `docs_guide.json`): the long texts are equal character for character.

mod common;

use common::{load, s};
use kb_doctext::{docs_guide, docs_templates};

#[test]
fn golden_docs_templates() {
    let data = load("docs_templates.json");
    let python = data["templates"].as_array().expect("templates");
    let rust = docs_templates::static_templates();
    assert_eq!(rust.len(), 5, "the five starters of docs_templates.py itself");
    for (n, (key, t)) in rust.iter().enumerate() {
        let (pkey, pval) = (s(&python[n][0]), &python[n][1]);
        assert_eq!(key, pkey, "template {n}: key (and order)");
        assert_eq!(t.name, s(&pval["name"]), "{key}: name");
        assert_eq!(t.description, s(&pval["description"]), "{key}: description");
        assert_eq!(t.markdown, s(&pval["markdown"]), "{key}: markdown");
    }
    // the rest is ba_templates.docs_templates(): handed in by the caller and put after the five
    let ba: Vec<(String, docs_templates::Template)> = python[5..]
        .iter()
        .map(|e| {
            let v = &e[1];
            (
                s(&e[0]).to_string(),
                docs_templates::Template {
                    name: s(&v["name"]).to_string(),
                    description: s(&v["description"]).to_string(),
                    markdown: s(&v["markdown"]).to_string(),
                },
            )
        })
        .collect();
    assert_eq!(ba.len(), 8);
    let all = docs_templates::templates(ba);
    let keys: Vec<&str> = all.iter().map(|(k, _)| k.as_str()).collect();
    let python_keys: Vec<&str> = python.iter().map(|e| s(&e[0])).collect();
    assert_eq!(keys, python_keys);
    println!("docs_templates.json: {} templates ({} defined in docs_templates.py)", python.len(), rust.len());
}

#[test]
fn golden_docs_guide() {
    let data = load("docs_guide.json");
    assert_eq!(docs_guide::GUIDE, s(&data["GUIDE"]));
    assert_eq!(docs_guide::SKILL_HEADER, s(&data["SKILL_HEADER"]));
    let out = serde_json::Value::Object(docs_guide::guide());
    assert_eq!(out, data["guide"]);
    assert_eq!(out.as_object().map(|m| m.len()), Some(1));
}
