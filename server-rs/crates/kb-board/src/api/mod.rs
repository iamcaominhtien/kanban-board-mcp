//! The REST routes of this area.

use kb_base::Routes;

pub mod data;
pub mod logs;
pub mod members;
pub mod projects;
pub mod tickets;
pub mod workspace;

/// Every route of this area (the app merges them, in the order the Python app included its routers).
pub fn routes() -> Routes {
    // the order of `main.py`: projects, tickets, members, data, workspace, logs
    Routes::new()
        .merge(projects::routes())
        .merge(tickets::routes())
        .merge(members::routes())
        .merge(data::routes())
        .merge(workspace::routes())
        .merge(logs::routes())
}
