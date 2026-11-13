//! The board's shared skills: how any AI member works on a ticket, whatever its role (issue #277).
//!
//! Agreed with the owner on 2 Nov from what live runs got wrong, then three more they asked for (brainstorming, the
//! end user's eyes, office files): a report that claimed what nobody did, a server left running so the run never
//! ended, a hand-in without screenshots, a choice a person should have made, English labels on a Vietnamese canvas.
//! Issue #273 added how the roles work together (`working-together`). The few rules that matter most ride in the
//! instructions of the board's MCP server (`CORE_RULES`); the detail is here, as skills of the board's own plugin
//! (`services/ai/board_skills.py`) that Claude Code opens when the work calls for them, and through
//! `docs_read(guides)` for agents outside Claude Code. A project can switch each one off, for every member or for one
//! (`ops.board_skills`).
//!
//! Each skill is short and concrete: rules with their reason and one example, nothing the persona or the run's
//! rules already say. The texts are in `text/shared/` (one `<name>.md` and `<name>.description.txt` each), copied
//! character for character from the Python module and checked against `contract/golden/skills.json`.

use std::sync::LazyLock;

use crate::{demo_video_skill, slides_skill};

/// One skill: (name, description, text).
pub type Skill = (String, String, String);

/// A skill whose text is in a file: (name, description, text).
type Text = (&'static str, &'static str, &'static str);

/// `_header(name, description)`: the front matter of a SKILL.md.
pub fn header(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n")
}

/// The `working-a-ticket` skill.
pub const WORKING_A_TICKET: Text = (
    "working-a-ticket",
    include_str!("text/shared/working-a-ticket.description.txt"),
    include_str!("text/shared/working-a-ticket.md"),
);

/// The `evidence-and-handover` skill.
pub const EVIDENCE_AND_HANDOVER: Text = (
    "evidence-and-handover",
    include_str!("text/shared/evidence-and-handover.description.txt"),
    include_str!("text/shared/evidence-and-handover.md"),
);

/// The `repo-and-machine` skill.
pub const REPO_AND_MACHINE: Text = (
    "repo-and-machine",
    include_str!("text/shared/repo-and-machine.description.txt"),
    include_str!("text/shared/repo-and-machine.md"),
);

/// The `asking-and-writing` skill.
pub const ASKING_AND_WRITING: Text = (
    "asking-and-writing",
    include_str!("text/shared/asking-and-writing.description.txt"),
    include_str!("text/shared/asking-and-writing.md"),
);

/// The `brainstorming` skill.
pub const BRAINSTORMING: Text = (
    "brainstorming",
    include_str!("text/shared/brainstorming.description.txt"),
    include_str!("text/shared/brainstorming.md"),
);

/// The `end-user-eyes` skill.
pub const END_USER_EYES: Text = (
    "end-user-eyes",
    include_str!("text/shared/end-user-eyes.description.txt"),
    include_str!("text/shared/end-user-eyes.md"),
);

/// The `office-files` skill.
pub const OFFICE_FILES: Text = (
    "office-files",
    include_str!("text/shared/office-files.description.txt"),
    include_str!("text/shared/office-files.md"),
);

/// The `working-together` skill.
pub const WORKING_TOGETHER: Text = (
    "working-together",
    include_str!("text/shared/working-together.description.txt"),
    include_str!("text/shared/working-together.md"),
);

/// The `docs-comment-threads` skill.
pub const DOCS_COMMENT_THREADS: Text = (
    "docs-comment-threads",
    include_str!("text/shared/docs-comment-threads.description.txt"),
    include_str!("text/shared/docs-comment-threads.md"),
);

/// The `keeping-memory` skill.
pub const KEEPING_MEMORY: Text = (
    "keeping-memory",
    include_str!("text/shared/keeping-memory.description.txt"),
    include_str!("text/shared/keeping-memory.md"),
);

/// `TICKETS`: how every part of a ticket is used, and where files go (issue #269); the text of
/// `kb_board::ticket_guide`.
pub static TICKETS: LazyLock<Skill> = LazyLock::new(|| {
    (
        kb_board::ticket_guide::NAME.to_string(),
        kb_board::ticket_guide::DESCRIPTION.to_string(),
        kb_board::ticket_guide::GUIDE.clone(),
    )
});

/// `SLIDES`: decks (themes, templates, pictures).
pub static SLIDES: LazyLock<Skill> =
    LazyLock::new(|| (slides_skill::NAME.to_string(), slides_skill::DESCRIPTION.to_string(), slides_skill::body()));

/// `DEMO_VIDEO`: a narrated demo video of the app, built with code (asked for by the owner).
pub static DEMO_VIDEO: LazyLock<Skill> = LazyLock::new(|| {
    (demo_video_skill::name().to_string(), demo_video_skill::description().to_string(), demo_video_skill::body())
});

fn owned(skill: Text) -> Skill {
    (skill.0.to_string(), skill.1.to_string(), skill.2.to_string())
}

/// `SKILLS`: every shared skill, in the order the board lists them.
pub static SKILLS: LazyLock<Vec<Skill>> = LazyLock::new(|| {
    vec![
        owned(WORKING_A_TICKET),
        TICKETS.clone(),
        owned(EVIDENCE_AND_HANDOVER),
        owned(REPO_AND_MACHINE),
        owned(ASKING_AND_WRITING),
        // how the roles work together (issue #273)
        owned(WORKING_TOGETHER),
        // remembering what was learned and what a person said, without being asked (issue #274)
        owned(KEEPING_MEMORY),
        // the comment threads of a Docs page sent to a team: change, reply, and when to close (KBM-24)
        owned(DOCS_COMMENT_THREADS),
        owned(BRAINSTORMING),
        owned(END_USER_EYES),
        owned(OFFICE_FILES),
        SLIDES.clone(),
        // a narrated demo video of the app, built with code (asked for by the owner)
        DEMO_VIDEO.clone(),
    ]
});

/// Each shared skill's SKILL.md: `{name: text}`.
pub fn skill_files() -> Vec<(String, String)> {
    SKILLS.iter().map(|(name, desc, body)| (name.clone(), header(name, desc) + body)).collect()
}

/// The files a shared skill carries beside its SKILL.md: `{skill: {relative path: bytes}}`.
pub fn extra_files() -> Vec<(String, Vec<(String, &'static [u8])>)> {
    vec![
        (slides_skill::NAME.to_string(), slides_skill::files()),
        (demo_video_skill::name().to_string(), demo_video_skill::files()),
    ]
}

/// Each shared skill's text without its header, for an agent outside Claude Code: `{name: text}`.
pub fn guides() -> Vec<(String, String)> {
    SKILLS.iter().map(|(name, _desc, body)| (name.clone(), body.clone())).collect()
}

/// The few rules that matter most, in the board's MCP server instructions: a run often skips a skill it was only
/// told about.
pub const CORE_RULES: [&str; 8] = [
    include_str!("text/core_rules/00.txt"),
    include_str!("text/core_rules/01.txt"),
    include_str!("text/core_rules/02.txt"),
    include_str!("text/core_rules/03.txt"),
    include_str!("text/core_rules/04.txt"),
    include_str!("text/core_rules/05.txt"),
    include_str!("text/core_rules/06.txt"),
    include_str!("text/core_rules/07.txt"),
];
