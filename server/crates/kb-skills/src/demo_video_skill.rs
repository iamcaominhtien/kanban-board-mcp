//! The `demo-video` skill: a narrated 1080p demo video of the app (or of a feature), built with code from a scenario
//! file.
//!
//! `SKILL.md` is the skill's text (it is also the project skill `.claude/skills/demo-video`, a link to this folder).
//! Its folder ships with it in the board's plugin: `scripts/` (a throwaway board, the stage, the sound and the
//! build), `scenarios/`. The stock sounds and the Python packages are fetched on first use, outside the skill folder
//! (the board rewrites it).

use std::sync::LazyLock;

use kb_base::pytext;

use crate::assets;

const FOLDER: &str = "demo_video_skill";

const SHIP: [&str; 4] = [".py", ".json", ".html", ".md"];

/// `SKILL.md`, its name, its description and where its body starts (`^---\nname: (.+)\ndescription: (.+)\n---\n`).
struct Head {
    text: String,
    name: String,
    description: String,
    end: usize,
}

static HEAD: LazyLock<Head> = LazyLock::new(|| {
    let text = assets::read_text(FOLDER, "SKILL.md").unwrap_or_default();
    let parsed = (|| {
        let rest = text.strip_prefix("---\nname: ")?;
        let (name, rest) = rest.split_once('\n')?;
        let rest = rest.strip_prefix("description: ")?;
        let (description, rest) = rest.split_once('\n')?;
        let rest = rest.strip_prefix("---\n")?;
        (!name.is_empty() && !description.is_empty())
            .then(|| (pytext::strip(name).to_string(), pytext::strip(description).to_string(), text.len() - rest.len()))
    })();
    // Python asserts "SKILL.md must start with its name and description"; the embedded file is checked by a test
    let (name, description, end) = parsed.unwrap_or_default();
    Head { text, name, description, end }
});

/// The skill's name, from SKILL.md.
pub fn name() -> &'static str {
    &HEAD.name
}

/// The skill's description, from SKILL.md.
pub fn description() -> &'static str {
    &HEAD.description
}

/// The skill's text, without its front matter (the board writes its own header).
pub fn body() -> String {
    HEAD.text[HEAD.end..].trim_start_matches('\n').to_string()
}

/// The files the skill ships beside its SKILL.md: `{relative path: bytes}`.
pub fn files() -> Vec<(String, &'static [u8])> {
    assets::folder_files(FOLDER)
        .into_iter()
        .filter(|(rel, _)| {
            let name = rel.rsplit('/').next().unwrap_or_default();
            SHIP.contains(&assets::suffix(rel))
                && name != "SKILL.md"
                && name != "__init__.py"
                && !rel.split('/').any(|part| part == "__pycache__")
        })
        .map(|(rel, bytes)| (rel.to_string(), bytes))
        .collect()
}
