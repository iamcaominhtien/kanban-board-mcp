//! The REST routes of the AI team.

use kb_base::Routes;

pub mod ai;
pub mod ai_accounts;
pub mod ai_board;
pub mod ai_code;
pub mod ai_hooks;
pub mod ai_knowledge;
pub mod ai_power;
pub mod ai_tools;
pub mod schedules;

/// Every route of this area (the app merges them, in the order `main.py` includes the routers): accounts, `ai`, hooks,
/// knowledge, code, tools, board, power.
pub fn routes() -> Routes {
    Routes::new()
        .merge(ai_accounts::routes())
        .merge(ai::routes())
        .merge(ai_hooks::routes())
        .merge(ai_knowledge::routes())
        .merge(ai_code::routes())
        .merge(ai_tools::routes())
        .merge(ai_board::routes())
        .merge(ai_power::routes())
        // `main.py` includes it second, after the projects' router: no route the app registers before this crate can
        // take one of its paths, so its place here is the same
        .merge(schedules::routes())
}
