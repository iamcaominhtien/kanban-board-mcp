//! A router that remembers what it serves.
//!
//! Each area builds its REST routes with `Routes`; the app merges them. The table of (method, path) pairs is what
//! `kanban-server --routes` prints, and what the route coverage check compares with the OpenAPI snapshot of the
//! Python server. Paths use FastAPI's syntax for a catch-all (`{name:path}`), which is written `{*name}` for axum.

use axum::Router;
use axum::handler::Handler;
use axum::routing::{self, MethodRouter};

/// Routes and the table of what they are.
#[derive(Default)]
pub struct Routes {
    router: Router,
    table: Vec<(String, String)>,
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
        /// `@router.get(path)` (HEAD is answered too, as Starlette does).
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

    /// A route that is not in the OpenAPI schema (`include_in_schema=False`): served, not counted.
    pub fn hidden(mut self, path: &str, method_router: MethodRouter) -> Self {
        self.router = self.router.route(&axum_path(path), method_router);
        self
    }

    /// A WebSocket or any other route built by hand, listed under `method`.
    pub fn add(mut self, method: &str, path: &str, method_router: MethodRouter) -> Self {
        self.table.push((method.to_string(), path.to_string()));
        self.router = self.router.route(&axum_path(path), method_router);
        self
    }

    /// `app.include_router(other)`.
    pub fn merge(mut self, other: Routes) -> Self {
        self.router = self.router.merge(other.router);
        self.table.extend(other.table);
        self
    }

    /// `APIRouter(prefix=prefix)`: every path of `other` under `prefix`.
    pub fn nest(mut self, prefix: &str, other: Routes) -> Self {
        self.router = self.router.nest(&axum_path(prefix), other.router);
        self.table.extend(other.table.into_iter().map(|(method, path)| (method, format!("{prefix}{path}"))));
        self
    }

    /// The axum router and the table of (method, path) in FastAPI's path syntax.
    pub fn into_parts(self) -> (Router, Vec<(String, String)>) {
        (self.router, self.table)
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let inner = Routes::new().get("/", ok).post("/{id}", ok);
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
}
