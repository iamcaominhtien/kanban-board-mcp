//! The shell of the app (`main.py`): `/health`, `/version`, `/events`, the middlewares (CORS, the app's secret,
//! request logging) and the answers for methods and paths no route serves. Every value was read from the Python
//! server; the same checks run on both servers.

mod common;

use common::*;
use serde_json::json;
use std::time::Duration;
use testkit::{Options, Server, skip_unless_available};

const GENERIC_HINT: &str = "This request must come from the board's own window. An AI run changes the board through the kanban MCP tools, not the REST API or a browser.";
const UPLOADS_HINT: &str = "This request must come from the board's own window. To attach a picture or a file, write it as a path in your working folder inside the Markdown of the MCP call: ![shot](qa/evidence/TC-1.png) or [sample](docs/sample.xlsx) in docs_write, a comment, a work log or a test case proof; the board copies it. For the ticket's scratch folder, manage_ticket(action='workspace') gives its path: write the file there with your own file tools.";
const DOCS_HINT: &str = "This request must come from the board's own window. To check the links of a Docs page use docs_read(action='check_links'); to read a page, docs_read(action='get'). The board's window cannot be driven from a browser outside the app.";

#[tokio::test]
async fn health_says_ok() {
    if !skip_unless_available("health_says_ok") {
        return;
    }
    let s = Server::start().await;
    let r = get(&s, "/health").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "{\"status\":\"ok\"}");
    assert_headers(&r, "/health", &[("content-length", "15"), ("content-type", "application/json")]);
    s.stop().await;
}

#[tokio::test]
async fn version_names_the_server_and_the_oldest_ui() {
    if !skip_unless_available("version_names_the_server_and_the_oldest_ui") {
        return;
    }
    let s = Server::start().await;
    let r = get(&s, "/version").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type").as_deref(), Some("application/json"));
    let body = r.json();
    let keys: Vec<&str> = body.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(keys, ["version", "latest", "min_supported_version"]);
    assert_eq!(body["version"], body["latest"]);
    s.stop().await;
}

/// The events stream: its headers and the first block, before any event.
#[tokio::test]
async fn the_event_stream_opens_with_a_connected_comment() {
    if !skip_unless_available("the_event_stream_opens_with_a_connected_comment") {
        return;
    }
    let s = Server::start().await;
    let mut response = client().get(format!("{}/events", s.base_url())).send().await.expect("GET /events");
    assert_eq!(response.status().as_u16(), 200);
    let headers: std::collections::BTreeMap<String, String> = response
        .headers()
        .iter()
        .filter(|(k, _)| !["date", "server"].contains(&k.as_str()))
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let want: std::collections::BTreeMap<String, String> = [
        ("cache-control", "no-cache"),
        ("content-type", "text/event-stream; charset=utf-8"),
        ("x-accel-buffering", "no"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    // a stream has no length: the servers frame it differently (chunked), which is not part of the contract
    let headers: std::collections::BTreeMap<String, String> =
        headers.into_iter().filter(|(k, _)| k != "transfer-encoding").collect();
    assert_eq!(headers, want);
    let first =
        tokio::time::timeout(Duration::from_secs(5), response.chunk()).await.expect("first chunk").expect("read");
    assert_eq!(first.as_deref(), Some(&b": connected\n\n"[..]));
    s.stop().await;
}

#[tokio::test]
async fn a_request_with_an_origin_gets_the_cors_headers_and_one_without_gets_none() {
    if !skip_unless_available("a_request_with_an_origin_gets_the_cors_headers_and_one_without_gets_none") {
        return;
    }
    let s = Server::start().await;
    let r = send(&s, "GET", "/health", &[("origin", "http://x.test")], None).await;
    assert_headers(
        &r,
        "simple request",
        &[
            ("access-control-allow-origin", "*"),
            ("access-control-expose-headers", "x-request-id"),
            ("content-length", "15"),
            ("content-type", "application/json"),
        ],
    );
    // an error answer too
    let r = send(&s, "GET", "/uploads/nope.png", &[("origin", "http://x.test")], None).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.header("access-control-allow-origin").as_deref(), Some("*"));
    assert_eq!(r.header("access-control-expose-headers").as_deref(), Some("x-request-id"));
    // no origin, no CORS
    let r = get(&s, "/health").await;
    assert!(r.header("access-control-allow-origin").is_none() && r.header("vary").is_none());
    s.stop().await;
}

const ALLOW_HEADERS: &str = "Accept, Accept-Language, Authorization, Content-Language, Content-Type, Last-Event-ID, X-Actor, X-Kanban-Secret, X-Request-Id, X-Requested-With";

#[tokio::test]
async fn a_preflight_is_answered_by_the_cors_middleware() {
    if !skip_unless_available("a_preflight_is_answered_by_the_cors_middleware") {
        return;
    }
    let s = Server::start().await;
    let preflight = |method: &'static str, headers: Option<&'static str>, private: bool| {
        let mut h = vec![("origin", "http://x.test"), ("access-control-request-method", method)];
        if let Some(headers) = headers {
            h.push(("access-control-request-headers", headers));
        }
        if private {
            h.push(("access-control-request-private-network", "true"));
        }
        h
    };
    let r = send(&s, "OPTIONS", "/health", &preflight("GET", Some("x-actor,content-type"), false), None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "OK");
    let want = [
        ("access-control-allow-headers", ALLOW_HEADERS),
        ("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        ("access-control-allow-origin", "*"),
        ("access-control-max-age", "600"),
        ("content-length", "2"),
        ("content-type", "text/plain; charset=utf-8"),
    ];
    assert_headers(&r, "preflight", &want);
    // any path: the middleware answers before the router looks
    let r = send(&s, "OPTIONS", "/no/such/path", &preflight("DELETE", None, false), None).await;
    assert_eq!((r.status, r.text()), (200, "OK".to_string()));
    let r = send(&s, "OPTIONS", "/health", &preflight("POST", Some("X-Actor , x-kanban-secret"), false), None).await;
    assert_eq!(r.status, 200);

    // what is refused is named, in this order
    for (method, headers, private, text) in [
        ("TRACE", None, false, "Disallowed CORS method"),
        ("GET", Some("x-actor, x-bad"), false, "Disallowed CORS headers"),
        ("GET", Some(""), false, "Disallowed CORS headers"),
        ("GET", None, true, "Disallowed CORS private-network"),
        ("get", None, false, "Disallowed CORS method"),
        ("TRACE", Some("x-bad"), true, "Disallowed CORS method, headers, private-network"),
    ] {
        let r = send(&s, "OPTIONS", "/health", &preflight(method, headers, private), None).await;
        assert_eq!(r.status, 400, "{method} {headers:?}");
        assert_eq!(r.text(), text);
        let want = [
            ("access-control-allow-headers", ALLOW_HEADERS),
            ("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"),
            ("access-control-allow-origin", "*"),
            ("access-control-max-age", "600"),
            ("content-length", &text.len().to_string()),
            ("content-type", "text/plain; charset=utf-8"),
        ];
        assert_headers(&r, text, &want);
    }
    // OPTIONS without the preflight headers is an ordinary request: no route has it
    let r = send(&s, "OPTIONS", "/health", &[("origin", "http://x.test")], None).await;
    assert_eq!(r.status, 405);
    assert_eq!(r.header("allow").as_deref(), Some("GET"));
    assert_eq!(r.header("access-control-allow-origin").as_deref(), Some("*"));
    s.stop().await;
}

fn with_secret() -> Options {
    Options { secret: Some("s3cret-value".into()), ..Options::default() }
}

#[tokio::test]
async fn a_request_that_changes_something_needs_the_apps_secret() {
    if !skip_unless_available("a_request_that_changes_something_needs_the_apps_secret") {
        return;
    }
    let s = Server::start_with(with_secret()).await;
    for method in ["POST", "PUT", "PATCH", "DELETE"] {
        for (uri, hint) in [
            ("/nope", GENERIC_HINT),
            ("/projects", GENERIC_HINT),
            ("/uploads/images", UPLOADS_HINT),
            ("/workspace/files", UPLOADS_HINT),
            ("/docs/resolve", DOCS_HINT),
            ("/docs/pages/x", DOCS_HINT),
        ] {
            let r = send(&s, method, uri, &[], None).await;
            assert_eq!(r.status, 403, "{method} {uri}");
            assert_eq!(r.json(), json!({"detail": hint}), "{method} {uri}");
            assert_headers(
                &r,
                "403",
                &[("content-length", &r.body.len().to_string()), ("content-type", "application/json")],
            );
        }
    }
    // a wrong secret is no secret
    let r = send(&s, "POST", "/nope", &[("x-kanban-secret", "wrong")], None).await;
    assert_eq!(r.status, 403);
    let r = send(&s, "POST", "/nope", &[("x-kanban-secret", "")], None).await;
    assert_eq!(r.status, 403);
    // the right one goes through to the router (nothing answers POST /nope)
    let r = send(&s, "POST", "/nope", &[("x-kanban-secret", "s3cret-value")], None).await;
    assert_eq!((r.status, r.json()), (405, json!({"detail": "Method Not Allowed"})));
    // reading is free, and so is a preflight
    assert_eq!(get(&s, "/health").await.status, 200);
    assert_eq!(get(&s, "/uploads/nope.png").await.status, 404);
    let r =
        send(&s, "OPTIONS", "/nope", &[("origin", "http://x.test"), ("access-control-request-method", "POST")], None)
            .await;
    assert_eq!(r.status, 200);
    let r = send(&s, "OPTIONS", "/nope", &[], None).await;
    assert_eq!(r.status, 405);
    s.stop().await;
}

#[tokio::test]
async fn the_endpoints_of_the_ai_and_the_client_log_are_not_checked() {
    if !skip_unless_available("the_endpoints_of_the_ai_and_the_client_log_are_not_checked") {
        return;
    }
    let s = Server::start_with(with_secret()).await;
    for uri in ["/mcp/", "/logs/client", "/ai/hooks/x", "/internal/ai/x"] {
        let r = send(&s, "POST", uri, &[], Some(b"{}".to_vec())).await;
        assert_ne!(r.status, 403, "POST {uri}: {}", r.text());
    }
    s.stop().await;
}

/// The secret middleware is outside CORS, so its refusal carries no CORS headers.
#[tokio::test]
async fn a_refusal_for_the_secret_has_no_cors_headers() {
    if !skip_unless_available("a_refusal_for_the_secret_has_no_cors_headers") {
        return;
    }
    let s = Server::start_with(with_secret()).await;
    let r = send(&s, "POST", "/nope", &[("origin", "http://x.test")], None).await;
    assert_eq!(r.status, 403);
    assert!(r.header("access-control-allow-origin").is_none());
    s.stop().await;
}

/// `log_requests`: a failed request is logged with its status and time, a successful one is not.
#[tokio::test]
async fn failed_requests_are_logged_with_their_time() {
    if !skip_unless_available("failed_requests_are_logged_with_their_time") {
        return;
    }
    let s = Server::start().await;
    get(&s, "/health").await;
    get(&s, "/nope").await;
    send(&s, "POST", "/nope", &[], None).await;
    get(&s, "/uploads/_private/x").await;
    let mut log = String::new();
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        log = std::fs::read_to_string(s.log_dir().join("kanban.log")).unwrap_or_default();
        if log.contains("/uploads/_private/x -> 400") {
            break;
        }
    }
    let re = |method: &str, path: &str, status: u16| {
        let pattern = format!(r" WARNING kanban\.http {method} {path} -> {status} \(\d+ms\)$");
        regex::Regex::new(&pattern).expect("regex")
    };
    for (method, path, status) in [("GET", "/nope", 404), ("POST", "/nope", 405), ("GET", "/uploads/_private/x", 400)] {
        assert!(
            log.lines().any(|line| re(method, path, status).is_match(line)),
            "{method} {path} -> {status} not in:\n{log}"
        );
    }
    assert!(!log.contains("GET /health"), "{log}");
    assert!(log.lines().any(|l| l.contains(" INFO kanban.http Server started (version ")), "{log}");
    s.stop().await;
}
