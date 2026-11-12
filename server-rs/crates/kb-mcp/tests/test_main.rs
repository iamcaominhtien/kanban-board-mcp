//! `tests/test_main.py`, the test of the MCP mount (the others are tests of the app).

mod common;

/// GET /mcp/ must not return 404 - a protocol response or 405 is acceptable.
///
/// Note the trailing slash: the mount only matches "/mcp/" and deeper paths, so bare "/mcp" falls through to the
/// SPA catch-all route instead of ever reaching the MCP app.
#[tokio::test]
async fn test_mcp_endpoint_is_reachable() {
    let s = common::start().await;
    let response = s.client().get("/mcp/").await;
    assert_ne!(response.status, 404, "/mcp/ returned 404 — mount path misconfigured. Got: {}", response.status);
    // (a GET that does not ask for an event stream is refused by the MCP transport itself)
    assert_eq!(response.status, 406);
    assert_eq!(response.json()["jsonrpc"], "2.0");
}
