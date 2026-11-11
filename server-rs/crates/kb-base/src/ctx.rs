//! Values that follow the current task, as Python's `ContextVar` does.
//!
//! A request, an MCP call and a background job each run inside `scope`, which gives the task an empty set of
//! values. Code anywhere below sets and reads typed values (`set::<Actor>(..)`, `get::<Actor>()`); a task started
//! with `spawn` gets a copy of the values of the task that started it, as `asyncio.create_task` copies the context.
//! Outside any scope, reads give `None` and writes are dropped.

use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

type Values = HashMap<TypeId, Arc<dyn Any + Send + Sync>>;

tokio::task_local! {
    static VALUES: RefCell<Values>;
}

/// Run `fut` with a context of its own, starting from a copy of the current one (empty when there is none).
pub async fn scope<F: Future>(fut: F) -> F::Output {
    let values = snapshot();
    VALUES.scope(RefCell::new(values), fut).await
}

/// `asyncio.create_task(fut)`: a new task that starts with a copy of the current context.
pub fn spawn<F>(fut: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let values = snapshot();
    tokio::spawn(VALUES.scope(RefCell::new(values), fut))
}

fn snapshot() -> Values {
    VALUES.try_with(|v| v.borrow().clone()).unwrap_or_default()
}

/// What `set` returns: give it to `reset` to restore the value that was there before.
#[must_use = "pass the token to ctx::reset to restore the previous value"]
pub struct Token {
    key: TypeId,
    previous: Option<Arc<dyn Any + Send + Sync>>,
}

/// `var.set(value)`: the value of type `T` for the rest of this task.
pub fn set<T: Any + Send + Sync>(value: T) -> Token {
    let key = TypeId::of::<T>();
    let previous = VALUES.try_with(|v| v.borrow_mut().insert(key, Arc::new(value))).ok().flatten();
    Token { key, previous }
}

/// `var.reset(token)`.
pub fn reset(token: Token) {
    let _ = VALUES.try_with(|v| {
        let mut values = v.borrow_mut();
        match token.previous {
            Some(previous) => values.insert(token.key, previous),
            None => values.remove(&token.key),
        };
    });
}

/// Remove the value of type `T` (the variable is back at its default).
pub fn clear<T: Any + Send + Sync>() {
    let _ = VALUES.try_with(|v| v.borrow_mut().remove(&TypeId::of::<T>()));
}

/// `var.get()`: the value of type `T` set in this task, or `None` (the caller supplies the default).
pub fn get<T: Any + Send + Sync + Clone>() -> Option<T> {
    VALUES
        .try_with(|v| v.borrow().get(&TypeId::of::<T>()).and_then(|value| value.downcast_ref::<T>().cloned()))
        .ok()
        .flatten()
}

/// Run `fut` with `value` set, then restore what was there (a `set` / `try` / `finally reset` in Python).
pub async fn with<T: Any + Send + Sync, F: Future>(value: T, fut: F) -> F::Output {
    let token = set(value);
    let out = fut.await;
    reset(token);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, PartialEq, Debug)]
    struct Name(String);

    #[tokio::test]
    async fn values_follow_the_task_and_are_copied_to_spawned_tasks() {
        assert_eq!(get::<Name>(), None);
        scope(async {
            let token = set(Name("a".into()));
            assert_eq!(get::<Name>(), Some(Name("a".into())));
            let child = spawn(async {
                let seen = get::<Name>();
                let _ = set(Name("child".into()));
                seen
            });
            assert_eq!(child.await.unwrap(), Some(Name("a".into())));
            assert_eq!(get::<Name>(), Some(Name("a".into())));
            let inner = set(Name("b".into()));
            reset(inner);
            assert_eq!(get::<Name>(), Some(Name("a".into())));
            reset(token);
            assert_eq!(get::<Name>(), None);
        })
        .await;
    }
}
