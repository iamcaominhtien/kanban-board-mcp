//! `services/canvas_design.py`: what an AI is told about designing a frame: one guide, in one place.
//!
//! `GUIDE` is given whole to every Claude Code run of an AI team that has a designer, PM or BA role, as the
//! `canvas-design` skill (`services/ai/board_skills.py`, `CRAFT_ROLES`), and to any other MCP agent through
//! docs_read(design_guide). It is not in the MCP server instructions: Claude Code keeps only their first 10,000
//! characters. The repository's skill file, `.claude/skills/canvas-design/SKILL.md`, is `SKILL_HEADER` + `GUIDE`;
//! `tests/test_canvas_mcp.py` fails if the file differs. The skill carries exemplar boards too (trimmed from the
//! board's own design canvas, in `assets/design_examples/`): the bar for how a design board is presented, never a
//! brand to copy.
//!
//! The texts are copied character for character into `src/text/` (long text, loaded with `include_str!`), and the
//! examples into `assets/design_examples/` (loaded with `include_bytes!`); a golden test checks them against Python.

/// An exemplar board file: its name in the skill's `examples/` folder and its bytes.
pub type Example = (&'static str, &'static [u8]);

/// The exemplar boards (an HTML page and its picture each) the skill carries in its `examples/` folder, sorted by name
/// (`sorted(p for p in EXAMPLES.iterdir() if p.suffix in (".html", ".png"))`).
pub fn examples() -> [Example; 4] {
    [
        ("foundations.html", include_bytes!("../assets/design_examples/foundations.html")),
        ("foundations.png", include_bytes!("../assets/design_examples/foundations.png")),
        ("states.html", include_bytes!("../assets/design_examples/states.html")),
        ("states.png", include_bytes!("../assets/design_examples/states.png")),
    ]
}

/// The front matter of the skill file.
pub const SKILL_HEADER: &str = include_str!("text/canvas_design_skill_header.md");

/// The design guide: the skill's `SKILL.md` after `SKILL_HEADER`, and `docs_read(design_guide)`.
pub const GUIDE: &str = include_str!("text/canvas_design_guide.md");

/// How a design stops looking machine-made: the skill's craft.md, beside SKILL.md (and in docs_read(design_guide)).
pub const CRAFT: &str = include_str!("text/canvas_design_craft.md");
