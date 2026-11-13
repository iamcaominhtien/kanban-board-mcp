//! Compares the routes the Rust app serves with the OpenAPI snapshot of the Python server
//! (`contract/openapi.json`).
//!
//! A route the Python server does not have is always a failure. Routes still to be ported are listed; with
//! `ROUTE_COVERAGE_STRICT=1` (the gate before the switch) any missing route is a failure too.

use std::collections::BTreeSet;

/// `/projects/{project_id}/x` and `/projects/{pid}/x` are the same route: compare with the names taken out.
fn shape(path: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in path.chars() {
        match c {
            '{' => {
                depth += 1;
                out.push_str("{}");
            }
            '}' => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

#[test]
fn every_route_is_one_the_python_server_has() {
    let contract = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/openapi.json");
    let openapi: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(contract).unwrap()).unwrap();
    let mut expected = BTreeSet::new();
    for (path, methods) in openapi["paths"].as_object().unwrap() {
        for method in methods.as_object().unwrap().keys() {
            if ["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                expected.insert(format!("{} {}", method.to_uppercase(), shape(path)));
            }
        }
    }
    let (_, table) = kb_app::routes().into_parts();
    let served: BTreeSet<String> = table.iter().map(|(method, path)| format!("{method} {}", shape(path))).collect();

    let extra: Vec<&String> = served.difference(&expected).collect();
    assert!(extra.is_empty(), "routes the Python server does not have: {extra:#?}");

    let missing: Vec<&String> = expected.difference(&served).collect();
    println!("route coverage: {} of {} served, {} to port", served.len(), expected.len(), missing.len());
    if std::env::var("ROUTE_COVERAGE_STRICT").is_ok_and(|v| v == "1") {
        assert!(missing.is_empty(), "routes still to port: {missing:#?}");
    }
}
