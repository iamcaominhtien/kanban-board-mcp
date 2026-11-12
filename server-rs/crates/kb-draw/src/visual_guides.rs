//! `services/visual_guides.py`: what an AI is told about draw.io diagrams and Sketches, and which drawing tool to use
//! (issue #267).
//!
//! Same pattern as the canvas design guide (`canvas_design`): one text in one place. Every Claude Code run of an AI
//! member gets it as a skill of the board's own plugin (`drawio-diagrams`, `sketches`;
//! `services/ai/board_skills.py`), and any other MCP agent reads the same text with `docs_read(diagram_guide)`; a test
//! checks the two are the same. The short rule for choosing the tool rides in the MCP instructions (`CHOOSING` is the
//! long form, at the top of the diagram guide).
//!
//! The Sketch decision, agreed in the issue: an AI reads Sketches and never draws one. A Sketch is a person's hand
//! drawing (pen strokes on layers); its worth is that a person drew it while thinking. An AI drawing strokes with
//! code gives a fake hand-drawn look that nobody can edit by its parts, and what an AI wants to show is better as a
//! Diagram (editable boxes and arrows) or a Canvas frame (the real screen). So the Sketch guide is about reading one
//! and turning it into the right drawing, with one exception: a screenshot put on a Sketch for a person to mark on.
//!
//! The texts are copied character for character into `src/text/`.

use serde_json::{Map, Value};

/// The front matter of the `drawio-diagrams` skill file.
pub const DRAWIO_HEADER: &str = include_str!("text/drawio_header.md");

/// The front matter of the `sketches` skill file.
pub const SKETCH_HEADER: &str = include_str!("text/sketch_header.md");

/// The rule for choosing the drawing tool (the top of the diagram guide).
pub const CHOOSING: &str = include_str!("text/choosing.md");

/// The draw.io guide: its opening, `CHOOSING`, then the numbered sections.
pub const DRAWIO: &str =
    concat!(include_str!("text/drawio_head.md"), include_str!("text/choosing.md"), include_str!("text/drawio_tail.md"));

/// The Sketch guide.
pub const SKETCH: &str = include_str!("text/sketch.md");

/// The texts an agent outside Claude Code reads with docs_read(diagram_guide): the same as the two skills.
pub fn diagram_guide() -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("guide".into(), Value::String(DRAWIO.to_string()));
    out.insert("sketches".into(), Value::String(SKETCH.to_string()));
    out
}
