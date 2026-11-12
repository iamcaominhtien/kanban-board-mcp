//! The order of the routes of this crate is the order of the Python app (`api/ai_accounts.py`, `api/ai.py`,
//! `api/ai_hooks.py`, `api/ai_knowledge.py`, `api/ai_code.py`, `api/ai_tools.py`, `api/ai_board.py`, `api/ai_power.py`,
//! `api/schedules.py`): the first route that matches a path and a method serves it, so the order is behavior.
//! `contract/golden/ai_route_order.txt` is the route table of `main.app` for those routers (`METHOD path`, in
//! registration order, the sign-in terminal's WebSocket left out as it is not a listed route):
//!
//! ```text
//! cd server && KANBAN_CONFIG_DIR=.. KANBAN_DB_PATH=.. KANBAN_LOG_DIR=.. .venv/bin/python -c "import main; ..."
//! ```

/// `api/schedules.py` is included right after the projects' router, before everything else here; the Rust app
/// registers this crate's routers one after the other, and no route registered before them can take a path of the
/// schedules (the order is checked against the OpenAPI table of `kb-app`'s route coverage), so the schedules' routes
/// come last here: the two groups are compared each in its own order.
fn is_schedule(line: &str) -> bool {
    line.contains("/ai/schedules") || line.contains("/ai/schedule-runs")
}

#[test]
fn the_order_of_the_routes_is_pythons() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/golden/ai_route_order.txt");
    let want: Vec<String> =
        std::fs::read_to_string(&path).expect("the recorded route table").lines().map(str::to_string).collect();
    let (_, table) = kb_ai_api::api::routes().into_parts();
    let got: Vec<String> = table.iter().map(|(method, path)| format!("{method} {path}")).collect();
    assert_eq!(got.len(), want.len(), "the number of routes");
    for schedules in [false, true] {
        let got: Vec<&String> = got.iter().filter(|l| is_schedule(l) == schedules).collect();
        let want: Vec<&String> = want.iter().filter(|l| is_schedule(l) == schedules).collect();
        assert_eq!(got.len(), want.len(), "the number of routes (schedules: {schedules})");
        for (i, (got, want)) in got.iter().zip(&want).enumerate() {
            assert_eq!(got, want, "route {i} (schedules: {schedules})");
        }
    }
}
