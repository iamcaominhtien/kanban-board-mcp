//! The REST routes of this area.

use kb_base::Routes;

pub mod settings;

/// Every route of this area (the app merges them at the position of `app.include_router(settings_router)` in
/// `main.py`: after the members router, before the database router).
pub fn routes() -> Routes {
    settings::routes()
}
