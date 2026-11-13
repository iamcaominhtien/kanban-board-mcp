//! The app's routes, matched the way Starlette matches them.
//!
//! Each area builds its REST routes with `Routes`; the app merges them in the order the Python app included its
//! routers. A request goes to the **first** registered route whose path and method both match. A route that
//! matches the path only is remembered, and when no later route matches fully it answers 405 with its own method in
//! `Allow`; when nothing matches the path the answer is 404. (axum on its own takes the most specific path whatever
//! the order, which gives other answers wherever two routes overlap: `/tickets/{id}` and `/tickets/counts`.) HEAD
//! is not answered by a GET route, as in FastAPI.
//!
//! Paths are written in FastAPI's syntax (`/uploads/{file_path:path}`). The table of (method, path) pairs is what
//! `kanban-server --routes` prints and what the route coverage check compares with the OpenAPI snapshot of the
//! Python server.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::Request;
use axum::handler::Handler;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{self, MethodRouter};
use regex::Regex;
use serde_json::json;
use tower::ServiceExt;

struct Entry {
    method: String,
    path: String,
    handler: MethodRouter,
    listed: bool,
}

/// Routes in registration order.
#[derive(Default)]
pub struct Routes {
    entries: Vec<Entry>,
}

macro_rules! method {
    ($(#[$doc:meta] $name:ident => $verb:literal),* $(,)?) => {$(
        #[$doc]
        pub fn $name<H, T>(self, path: &str, handler: H) -> Self
        where
            H: Handler<T, ()>,
            T: 'static,
        {
            self.add($verb, path, routing::$name(handler))
        }
    )*};
}

impl Routes {
    /// No routes yet.
    pub fn new() -> Self {
        Self::default()
    }

    method! {
        /// `@router.get(path)`.
        get => "GET",
        /// `@router.post(path)`.
        post => "POST",
        /// `@router.put(path)`.
        put => "PUT",
        /// `@router.patch(path)`.
        patch => "PATCH",
        /// `@router.delete(path)`.
        delete => "DELETE",
    }

    /// A route that is not in the OpenAPI schema (`include_in_schema=False`, or the outcome FastAPI gives for a
    /// path that another route's parameter swallows): served for `method`, not counted.
    pub fn hidden(mut self, method: &str, path: &str, method_router: MethodRouter) -> Self {
        self.entries.push(Entry {
            method: method.to_string(),
            path: path.to_string(),
            handler: method_router,
            listed: false,
        });
        self
    }

    /// A WebSocket or any other route built by hand, listed under `method`.
    pub fn add(mut self, method: &str, path: &str, method_router: MethodRouter) -> Self {
        self.entries.push(Entry {
            method: method.to_string(),
            path: path.to_string(),
            handler: method_router,
            listed: true,
        });
        self
    }

    /// `app.include_router(other)`.
    pub fn merge(mut self, other: Routes) -> Self {
        self.entries.extend(other.entries);
        self
    }

    /// `APIRouter(prefix=prefix)`: every path of `other` under `prefix`.
    pub fn nest(mut self, prefix: &str, other: Routes) -> Self {
        self.entries.extend(other.entries.into_iter().map(|mut entry| {
            entry.path = format!("{prefix}{}", entry.path);
            entry
        }));
        self
    }

    /// The router that serves these routes, and the table of (method, path) in FastAPI's path syntax.
    pub fn into_parts(self) -> (Router, Vec<(String, String)>) {
        let table =
            self.entries.iter().filter(|e| e.listed).map(|e| (e.method.clone(), e.path.clone())).collect::<Vec<_>>();
        let served: Arc<Vec<Served>> = Arc::new(self.entries.into_iter().map(Served::new).collect());
        let router = Router::new().fallback(move |request: Request| {
            let served = served.clone();
            async move { dispatch(&served, request).await }
        });
        (router, table)
    }
}

/// A route as the dispatcher keeps it: its method, its path as a pattern and a router of its own (so the route's
/// extractors see its own path parameters).
struct Served {
    method: String,
    pattern: Regex,
    router: Router,
}

impl Served {
    fn new(entry: Entry) -> Self {
        Self {
            pattern: path_pattern(&entry.path),
            router: Router::new().route(&axum_path(&entry.path), entry.handler),
            method: entry.method,
        }
    }
}

/// Starlette's `compile_path`: `{name}` is one or more characters without a slash, `{name:path}` is the rest.
///
/// One difference, on purpose: Starlette lets `{name:path}` be empty (`/uploads/`), and axum cannot hand an empty
/// catch-all to a handler. Here it needs at least one character, and a router that serves the empty case registers
/// it as a route of its own (`hidden("GET", "/uploads/", ...)`).
fn path_pattern(path: &str) -> Regex {
    let mut pattern = String::from("^");
    let mut rest = path;
    while let Some(start) = rest.find('{') {
        pattern.push_str(&regex::escape(&rest[..start]));
        let end = rest[start..].find('}').map(|e| start + e).unwrap_or(rest.len());
        let inner = &rest[start + 1..end];
        pattern.push_str(if inner.ends_with(":path") { ".+" } else { "[^/]+" });
        rest = rest.get(end + 1..).unwrap_or("");
    }
    pattern.push_str(&regex::escape(rest));
    pattern.push('$');
    Regex::new(&pattern).expect("a route path written in the code is a valid pattern")
}

/// `/uploads/{file_path:path}` as axum writes it: `/uploads/{*file_path}`.
fn axum_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let end = rest[start..].find('}').map(|e| start + e).unwrap_or(rest.len());
        let inner = &rest[start + 1..end];
        match inner.strip_suffix(":path") {
            Some(name) => out.push_str(&format!("{{*{name}}}")),
            None => out.push_str(&format!("{{{inner}}}")),
        }
        rest = rest.get(end + 1..).unwrap_or("");
    }
    out.push_str(rest);
    out
}

/// The path as Starlette matches it: percent-decoded.
fn decoded(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 {
            if let Some(byte) = path.get(i + 1..i + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Starlette's answer when no route matches.
fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"detail": "Not Found"}))).into_response()
}

/// FastAPI's 405: `{"detail": "Method Not Allowed"}` and the method of the route in `Allow`.
fn method_not_allowed(allow: &str) -> Response {
    let mut response = (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"detail": "Method Not Allowed"}))).into_response();
    if let Ok(value) = HeaderValue::from_str(allow) {
        response.headers_mut().insert(header::ALLOW, value);
    }
    response
}

/// Starlette's `Router.__call__`: the first full match serves; else the first partial match answers 405; else 404.
async fn dispatch(served: &[Served], request: Request) -> Response {
    let path = decoded(request.uri().path());
    let method = request.method().as_str().to_string();
    let mut partial: Option<&Served> = None;
    for route in served {
        if !route.pattern.is_match(&path) {
            continue;
        }
        if route.method == method {
            return match route.router.clone().oneshot(request).await {
                Ok(response) => response,
                Err(never) => match never {},
            };
        }
        if partial.is_none() {
            partial = Some(route);
        }
    }
    match partial {
        Some(route) => method_not_allowed(&route.method),
        None => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Path;

    #[test]
    fn catch_all_paths_are_rewritten_for_axum() {
        assert_eq!(axum_path("/uploads/{file_path:path}"), "/uploads/{*file_path}");
        assert_eq!(
            axum_path("/projects/{project_id}/tickets/{ticket_id}"),
            "/projects/{project_id}/tickets/{ticket_id}"
        );
        assert_eq!(axum_path("/health"), "/health");
    }

    #[test]
    fn the_table_lists_nested_routes_with_their_prefix() {
        async fn ok() -> &'static str {
            "ok"
        }
        let inner = Routes::new().get("/", ok).post("/{id}", ok).hidden("GET", "/secret", routing::get(ok));
        let (_, table) = Routes::new().get("/health", ok).nest("/projects", inner).into_parts();
        assert_eq!(
            table,
            vec![
                ("GET".into(), "/health".into()),
                ("GET".into(), "/projects/".into()),
                ("POST".into(), "/projects/{id}".into())
            ]
        );
    }

    async fn call(router: &Router, method: &str, path: &str) -> (u16, String, String) {
        let request = Request::builder().method(method).uri(path).body(Body::empty()).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let allow = response.headers().get(header::ALLOW).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, allow, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn the_first_registered_route_that_matches_wins() {
        async fn item(Path(id): Path<String>) -> String {
            format!("item {id}")
        }
        async fn counts() -> &'static str {
            "counts"
        }
        async fn patch_item(Path(id): Path<String>) -> String {
            format!("patched {id}")
        }
        async fn rest(Path(rest): Path<String>) -> String {
            format!("ui {rest}")
        }
        // the parameter is registered first, as a FastAPI router may do: it swallows the literal
        let (router, _) = Routes::new()
            .get("/things/{id}", item)
            .get("/things/counts", counts)
            .patch("/other/{name}", patch_item)
            .get("/{full_path:path}", rest)
            .into_parts();
        assert_eq!(call(&router, "GET", "/things/counts").await.2, "item counts");
        assert_eq!(call(&router, "GET", "/things/a%20b").await.2, "item a b");
        // a path that matches a route of another method only: the later catch-all serves a GET, anything else is 405
        assert_eq!(call(&router, "GET", "/other/x").await.2, "ui other/x");
        let (status, allow, body) = call(&router, "DELETE", "/other/x").await;
        assert_eq!((status, allow.as_str(), body.as_str()), (405, "PATCH", r#"{"detail":"Method Not Allowed"}"#));
        // HEAD is not answered by a GET route
        assert_eq!(call(&router, "HEAD", "/things/1").await.0, 405);
        assert_eq!(call(&router, "POST", "/nothing/here/at/all").await.0, 405);
        let (bare, _) = Routes::new().get("/only", counts).into_parts();
        let (status, _, body) = call(&bare, "GET", "/nope").await;
        assert_eq!((status, body.as_str()), (404, r#"{"detail":"Not Found"}"#));
    }
}
