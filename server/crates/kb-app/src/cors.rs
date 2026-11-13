//! `CORSMiddleware` of Starlette as `main.py` configures it: every origin, no credentials, the methods and headers
//! listed below. Nothing happens to a request without an `Origin`; a preflight is answered here (200 `OK`, or 400
//! `Disallowed CORS ...`); any other response gets `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers`.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;

// Wildcard is safe: the server binds to 127.0.0.1 (loopback only), so it is not reachable from external networks.
const ALLOW_METHODS: [&str; 6] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ALLOW_HEADERS: [&str; 8] = [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
    "Last-Event-ID",
    "X-Request-Id",
    "X-Actor",
    "X-Kanban-Secret",
];
const SAFELISTED_HEADERS: [&str; 4] = ["Accept", "Accept-Language", "Content-Language", "Content-Type"];
const EXPOSE_HEADERS: [&str; 1] = ["x-request-id"];
const MAX_AGE: u32 = 600;

fn text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).map(|value| value.as_bytes().iter().map(|b| char::from(*b)).collect())
}

/// `sorted(SAFELISTED_HEADERS | set(allow_headers))`.
fn allowed_headers() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = SAFELISTED_HEADERS.iter().chain(ALLOW_HEADERS.iter()).copied().collect();
    all.sort_unstable();
    all.dedup();
    all
}

fn plain_text(status: StatusCode, body: &str, extra: Vec<(&'static str, String)>) -> Response {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    for (name, value) in extra {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

/// `CORSMiddleware.preflight_response`.
fn preflight_response(request_headers: &HeaderMap) -> Response {
    let requested_method = text(request_headers, "access-control-request-method").unwrap_or_default();
    let requested_headers = text(request_headers, "access-control-request-headers");
    let requested_private_network = text(request_headers, "access-control-request-private-network");
    let allowed = allowed_headers();

    let mut failures: Vec<&str> = Vec::new();
    if !ALLOW_METHODS.contains(&requested_method.as_str()) {
        failures.push("method");
    }
    if let Some(requested) = &requested_headers {
        let allowed_lower: Vec<String> = allowed.iter().map(|h| h.to_lowercase()).collect();
        if requested.split(',').any(|header| !allowed_lower.iter().any(|a| *a == header.to_lowercase().trim())) {
            failures.push("headers");
        }
    }
    if requested_private_network.is_some() {
        failures.push("private-network");
    }
    let headers = vec![
        ("access-control-allow-origin", "*".to_string()),
        ("access-control-allow-methods", ALLOW_METHODS.join(", ")),
        ("access-control-max-age", MAX_AGE.to_string()),
        ("access-control-allow-headers", allowed.join(", ")),
    ];
    if failures.is_empty() {
        plain_text(StatusCode::OK, "OK", headers)
    } else {
        plain_text(StatusCode::BAD_REQUEST, &format!("Disallowed CORS {}", failures.join(", ")), headers)
    }
}

/// The middleware.
pub async fn cors(request: Request, next: Next) -> Response {
    if !request.headers().contains_key(header::ORIGIN) {
        return next.run(request).await;
    }
    if request.method() == Method::OPTIONS && request.headers().contains_key("access-control-request-method") {
        return preflight_response(request.headers());
    }
    let mut response = next.run(request).await;
    // an unhandled exception is answered by Starlette's outermost middleware, past this one: no CORS headers
    let unhandled = response.status() == StatusCode::INTERNAL_SERVER_ERROR
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| value.as_bytes().starts_with(b"text/plain"));
    if !unhandled {
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        if let Ok(value) = HeaderValue::from_str(&EXPOSE_HEADERS.join(", ")) {
            headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, value);
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowed_headers_are_sorted_with_the_safelisted_ones() {
        assert_eq!(
            allowed_headers().join(", "),
            "Accept, Accept-Language, Authorization, Content-Language, Content-Type, Last-Event-ID, X-Actor, \
             X-Kanban-Secret, X-Request-Id, X-Requested-With"
        );
    }

    #[test]
    fn a_preflight_is_refused_for_an_unknown_method_or_header() {
        let mut headers = HeaderMap::new();
        headers.insert("access-control-request-method", HeaderValue::from_static("TRACE"));
        headers.insert("access-control-request-headers", HeaderValue::from_static("x-actor, x-other"));
        let response = preflight_response(&headers);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        headers.insert("access-control-request-method", HeaderValue::from_static("POST"));
        headers.insert("access-control-request-headers", HeaderValue::from_static("X-Actor , content-type"));
        assert_eq!(preflight_response(&headers).status(), StatusCode::OK);
    }
}
