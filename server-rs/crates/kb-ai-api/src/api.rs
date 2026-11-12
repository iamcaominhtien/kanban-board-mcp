//! The REST routes of the AI team.

use kb_base::Routes;

/// Every route of this area (the app merges them, in the order the Python app included its routers).
pub fn routes() -> Routes {
    Routes::new()
}
