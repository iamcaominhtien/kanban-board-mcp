//! The REST routes of the AI team.

use kb_base::Routes;

pub mod ai_accounts;
pub mod ai_hooks;
pub mod ai_knowledge;
pub mod ai_power;

/// Every route of this area (the app merges them, in the order the Python app included its routers).
pub fn routes() -> Routes {
    // the order of `main.py` (the routers of the other `api/ai*.py` files come in between, with the next routes
    // task): accounts, hooks, knowledge, power
    Routes::new()
        .merge(ai_accounts::routes())
        .merge(ai_hooks::routes())
        .merge(ai_knowledge::routes())
        .merge(ai_power::routes())
}
