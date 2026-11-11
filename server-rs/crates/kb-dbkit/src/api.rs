//! The REST routes of this area.

use kb_base::Routes;

/// Every route of this area (the app merges them, in the order the Python app included its routers).
pub fn routes() -> Routes {
    Routes::new()
}
