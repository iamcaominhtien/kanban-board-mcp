//! `tests/test_shared_skills_277.py`: the board's shared skills for every role (issue #277): one text for internal
//! and outside agents, a few core rules in every work run.
//!
//! The parts of the Python file that need other areas wait for them: the catalog and the plugin folder of a run
//! (`services/ai/board_skills.py`, `kb-ai`), the REST list of board skills (`/ai/board-skills`), the packs' personas,
//! the per-project switches, `kanban_mcp.operations.shared_guides` and the MCP instructions (`kb-mcp`). What is here
//! is what this crate owns: the names and order, the texts, the files a skill carries.

use kb_skills::{role_skills, shared_skills, slides_skill};

const SHARED: [&str; 13] = [
    "working-a-ticket",
    // how every part of a ticket is used, and where files go (issue #269)
    "working-with-tickets",
    "evidence-and-handover",
    "repo-and-machine",
    "asking-and-writing",
    // how the roles work together (issue #273)
    "working-together",
    // keeping the project memory without being asked (issue #274)
    "keeping-memory",
    // the comment threads a person sent from a Docs page: change, reply, when to close (KBM-24)
    "docs-comment-threads",
    // asked for by the owner in the brainstorm
    "brainstorming",
    "end-user-eyes",
    "office-files",
    // decks, asked for by the owner after the first office-files run (themes, templates, pictures)
    "slides",
    // a narrated demo video of the app, built with code
    "demo-video",
];

#[test]
fn test_the_four_skills_agreed_with_the_owner_are_board_skills_with_a_description_that_says_when() {
    let names: Vec<&str> = shared_skills::SKILLS.iter().map(|s| s.0.as_str()).collect();
    assert_eq!(names, SHARED);
    // Claude Code opens a skill by its description: each says what it covers and when to use it. (The catalog of
    // `board_skills`, in `kb-ai`, builds the descriptions the Python test checks for "Use "; `working-a-ticket` says
    // "REQUIRED for every AI member" instead. Here: every description is there, and a role's says when.)
    for (name, description, _body) in shared_skills::SKILLS.iter() {
        assert!(!description.is_empty(), "{name}");
    }
    for (_role, name, description, _body) in role_skills::ROLE_SKILLS {
        assert!(description.contains("Use "), "{name}");
    }
}

#[test]
fn test_an_outside_agent_reads_the_same_text_as_the_skill() {
    // the skill file (what the plugin writes) is the header and the guide an outside agent reads
    let guides = shared_skills::guides();
    assert_eq!(guides.iter().map(|g| g.0.as_str()).collect::<Vec<_>>(), SHARED);
    let files = shared_skills::skill_files();
    for ((name, text), (guide_name, body)) in files.iter().zip(&guides) {
        assert_eq!(name, guide_name);
        assert!(text.starts_with(&format!("---\nname: {name}\n")), "{name}");
        assert!(text.ends_with(body.as_str()), "{name}");
    }
    for (role, name, _desc, body) in role_skills::ROLE_SKILLS {
        assert_eq!(role_skills::guide(role), Some(body));
        let file = role_skills::skill_files().into_iter().find(|f| f.0 == name).expect("role skill file");
        assert!(file.1.starts_with(&format!("---\nname: {name}\n")) && file.1.ends_with(body));
    }
}

#[test]
fn test_the_texts_carry_what_the_live_runs_got_wrong() {
    let text = shared_skills::guides().into_iter().map(|g| g.1).collect::<Vec<_>>().join("\n");
    for needle in [
        "only what is true",        // a report claimed a person changed the background
        "What you start, you stop", // http.server left running kept the run open
        "Never invent evidence",
        "ai_run(action='ask')",               // "nobody was there to answer, so I chose"
        "The project's language, everywhere", // English page names on a Vietnamese canvas
        // the three the owner asked for: a brainstorm in rounds, the user's view, files that were looked at
        "**2 or 3 approaches**",
        "Five seconds",
        "soffice --headless --convert-to pdf",
        "**Formulas, not typed results**",
        "is a sentence that states",
        // how to look at a file on any machine, and decks
        "Quick Look",
        "ai_run(action='ask')` whether to install LibreOffice",
        "scripts/html_to_pptx.py",
        "pptx_template.py inventory",
        "only its subject has",
        "licence",
    ] {
        assert!(text.contains(needle), "{needle}");
    }
}

#[test]
fn test_an_outside_agent_is_told_where_the_guides_are() {
    // the instructions themselves are `kb-mcp`'s; what they carry from here is the core rules, which a work run also
    // has in its prompt
    assert_eq!(shared_skills::CORE_RULES.len(), 8);
    let total: usize = shared_skills::CORE_RULES.iter().map(|r| r.chars().count()).sum();
    assert!(total < 10_000);
    for rule in shared_skills::CORE_RULES {
        assert!(!rule.is_empty() && !rule.contains('\n'));
    }
}

#[test]
fn test_the_slides_skill_ships_its_scripts_and_themes() {
    let files = slides_skill::files();
    let names: Vec<&str> = files.iter().map(|f| f.0.as_str()).collect();
    for rel in [
        "scripts/html_to_pptx.py",
        "scripts/pptx_template.py",
        "scripts/render.py",
        "themes/base.css",
        "themes/ledger/sample.html",
        "themes/ledger/sample.pptx",
        "themes/ledger/preview.jpg",
    ] {
        assert!(names.contains(&rel), "{rel}");
    }
    assert!(!names.iter().any(|n| n.ends_with(".look") || n.contains("__pycache__")));
    // the themes table is made from the themes themselves
    let text = slides_skill::body();
    for theme in slides_skill::themes() {
        assert!(text.contains(&format!("`{}`", theme.key)), "{}", theme.key);
        assert!(text.contains(theme.fonts["office_body"].as_str().unwrap()), "{}", theme.key);
    }
}

#[test]
fn test_the_slides_files_are_read_as_utf8_whatever_the_machine_locale() {
    // A Windows machine reads text as cp1252 by default: the Vietnamese themes would not decode and the board server
    // would fail to start (the slides text is built at start).
    for (rel, bytes) in slides_skill::files().iter().filter(|f| f.0.ends_with(".py")) {
        let source = std::str::from_utf8(bytes).expect("utf-8 source");
        for line in source.lines() {
            if line.contains(".read_text(") || line.contains(".write_text(") {
                assert!(
                    line.contains("encoding=\"utf-8") || line.contains("encoding='utf-8"),
                    "{rel}: {}",
                    line.trim()
                );
            }
        }
    }
}
