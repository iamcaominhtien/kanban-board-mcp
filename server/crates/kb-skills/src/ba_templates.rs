//! `services/ba_templates/` (issue #273): the BA's templates, one kind of document per situation.
//!
//! The files ride beside the `role-ba` skill (`templates/`) and, except the checklist, are page templates on Docs.
//! `kb-doctext` holds a copy of the eight Markdown templates for the Docs starters (`docs_templates`); this module
//! is the one the skill folder uses, and `docs_templates()` gives the starters from it.

use kb_doctext::docs_templates::Template;

use crate::assets;

const FOLDER: &str = "ba_templates";

/// key -> (name, what it is for); the order the BA's skill and the New page dialog list them.
pub const DOCS: [(&str, &str, &str); 8] = [
    ("feature-spec", "Feature spec", "Stories, scenarios, numbered requirements, edge cases"),
    ("bugfix-spec", "Bugfix spec", "Current, expected and unchanged behaviour"),
    ("decision-table", "Decision table", "One row per combination of conditions"),
    ("use-case", "Use case", "Main scenario and what can go differently"),
    ("example-map", "Example map", "Rules, their examples, open questions"),
    ("one-pager", "One-pager", "Problem, appetite, solution, no-gos"),
    ("data-dictionary", "Data dictionary", "Fields, types, examples, rules"),
    ("nfr-checklist", "Quality requirements", "Speed, safety, access, formats"),
];

/// A template's Markdown (`name` without `.md`, or a path such as `examples/feature-spec-example`); `None` where
/// Python raises `FileNotFoundError`.
pub fn text(name: &str) -> Option<String> {
    assets::read_text(FOLDER, &format!("{name}.md"))
}

/// Every file the BA's skill carries, by its path under `templates/`.
pub fn files() -> Vec<(String, &'static [u8])> {
    assets::folder_files(FOLDER)
        .into_iter()
        .filter(|(rel, _)| rel.ends_with(".md"))
        .map(|(rel, bytes)| (format!("templates/{rel}"), bytes))
        .collect()
}

/// The page templates for Docs: `{key: {name, description, markdown}}`, in the order of `DOCS`; the list that
/// `kb_doctext::docs_templates::templates` appends to the static starters.
pub fn docs_templates() -> Vec<(String, Template)> {
    DOCS.iter()
        .map(|(key, name, description)| {
            (
                key.to_string(),
                Template {
                    name: name.to_string(),
                    description: description.to_string(),
                    markdown: text(key).unwrap_or_default(),
                },
            )
        })
        .collect()
}
