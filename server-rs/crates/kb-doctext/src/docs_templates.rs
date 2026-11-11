//! `services/docs_templates.py`: static Markdown starters for new Docs pages.
//!
//! The Python dict ends with `**ba_templates.docs_templates()` (the BA's documents, issue #273): that module
//! (`services/ba_templates/`, Markdown files read from disk) is not ported yet. `static_templates()` holds the five
//! starters this file defines; `templates(extra)` is the whole dict once the BA's templates are handed in.

/// One starter: `{name, description, markdown}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    /// Name in the New page dialog.
    pub name: String,
    /// One line under the name.
    pub description: String,
    /// The page the starter creates.
    pub markdown: String,
}

fn template(name: &str, description: &str, markdown: &str) -> Template {
    Template { name: name.to_string(), description: description.to_string(), markdown: markdown.to_string() }
}

/// The starters `docs_templates.py` defines itself, in the order of its `TEMPLATES`, by key.
pub fn static_templates() -> Vec<(String, Template)> {
    vec![
        ("blank".to_string(), template("Blank", "Start from an empty page", "")),
        (
            "requirements".to_string(),
            template(
                "Requirements",
                "Goals, scope and criteria",
                "## Summary\n\nOne or two sentences on what this is and why it matters.\n\n\
                 ## Goals\n\n- Goal one\n- Goal two\n\n\
                 ## Requirements\n\n\
                 | ID | Requirement | Priority |\n|---|---|---|\n\
                 | R1 | Describe the requirement | Must |\n\
                 | R2 | Describe the requirement | Should |\n\n\
                 ## Acceptance criteria\n\n- [ ] Given / when / then…\n",
            ),
        ),
        (
            "meeting-notes".to_string(),
            template(
                "Meeting notes",
                "Attendees, notes, action items",
                "## Attendees\n\n- Name\n\n## Notes\n\n- Topic\n\n\
                 ## Action items\n\n- [ ] Owner: task\n",
            ),
        ),
        (
            "decision-log".to_string(),
            template(
                "Decision log",
                "Context, options, outcome",
                "## Context\n\nWhat made this decision necessary?\n\n\
                 ## Options\n\n1. Option A\n2. Option B\n\n\
                 ## Outcome\n\nThe chosen option and why.\n",
            ),
        ),
        (
            "technical-design".to_string(),
            template(
                "Technical design",
                "Overview, diagram, API, rollout",
                "## Overview\n\nWhat are we building and why?\n\n\
                 ## Diagram\n\n```text\nclient -> api -> db\n```\n\n\
                 ## API\n\n| Method | Path | Description |\n|---|---|---|\n\
                 | GET | `/resource` | Describe it |\n\n\
                 ## Rollout\n\n- [ ] Ship behind a flag\n- [ ] Announce\n",
            ),
        ),
    ]
}

/// `TEMPLATES`: the static starters followed by the BA's (`ba_templates.docs_templates()`, which the caller reads
/// until that module is ported).
pub fn templates(ba: Vec<(String, Template)>) -> Vec<(String, Template)> {
    let mut all = static_templates();
    all.extend(ba);
    all
}
