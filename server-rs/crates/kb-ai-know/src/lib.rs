//! What the AI team knows and is given: role packs and roles, the board's own skills, memory, the knowledge base,
//! plugins (`services/ai/{packs,roles,board_skills,memory,kb,knowledge,plugins}.py`). Built on `kb-ai`.
//!
//! Every text an agent or a person reads (the ready-made packs, their personas, the plugin catalogue) is copied
//! character for character into `src/text/` and loaded with `include_str!`; `tests/golden_ai_know.rs` proves them equal
//! to the Python ones by SHA-256 and length (`contract/golden/ai_know.json`).

pub mod board_skills;
pub mod kb;
pub mod knowledge;
mod light;
pub mod memory;
pub mod packs;
pub mod pdf;
pub mod plugins;
pub mod roles;
pub mod seams;
