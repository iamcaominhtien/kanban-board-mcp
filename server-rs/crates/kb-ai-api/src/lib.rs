//! The REST routes of the AI team (`api/ai*.py`, `api/schedules.py`), on top of every AI crate.
//!
//! Served: the routers of `ai_accounts`, `ai`, `ai_hooks`, `ai_knowledge`, `ai_code`, `ai_tools`, `ai_board` and
//! `ai_power`. `api/schedules.py` waits for the schedules service.

pub mod api;
pub mod model;
pub mod schemas;
