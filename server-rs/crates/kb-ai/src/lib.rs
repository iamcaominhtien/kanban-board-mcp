//! The AI team (`server/services/ai/`). This part holds the base the rest imports: state, limits, texts and checks that
//! start no processes. The runs, the launcher, the schedules, the worktrees and the REST routes come in later tasks.

pub mod api;
pub mod audit;
pub mod budget;
pub mod comment_view;
pub mod config_model;
pub mod context;
pub mod guard;
pub mod hook_guard;
pub mod hooks;
pub mod injection;
pub mod mcp_sources;
pub mod ops;
pub mod paths;
pub mod pictures;
pub mod power;
pub mod profiles;
pub mod providers;
pub mod quota;
pub mod runner_link;
pub mod seams;
pub mod steps;
pub mod store;
pub mod transcripts;
