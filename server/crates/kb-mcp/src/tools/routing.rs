//! Routes a tool call to one operation, after checking that exactly the parameters it understands were passed.

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};

use crate::common::{self, ToolError, ToolResult};
use crate::pydantic;
use crate::validation::check_arguments;

/// The function behind an operation: its keyword arguments (by its own parameter names) to its result.
pub type OpFn = fn(Map<String, Value>) -> BoxFuture<'static, ToolResult>;

/// One operation behind a tool: the function, the parameters it needs and may take, and renames (tool parameter ->
/// function parameter) where a shared name is clearer for the agent.
#[derive(Clone, Copy)]
pub struct Op {
    /// The operation (`impl` in Python). It is given the passed parameters under the function's own names; with
    /// `params`, every parameter of that schema.
    pub run: OpFn,
    pub required: &'static [&'static str],
    pub optional: &'static [&'static str],
    pub rename: &'static [(&'static str, &'static str)],
    /// The constraints of the function's own parameters (enums, ranges, lengths), as the JSON schema of its
    /// arguments (`{"properties": {...}, "required": [...]}`): what `validate_call(impl)` enforces in Python.
    /// `None` when the function takes plain text, numbers and flags that the tool's schema already checked.
    pub params: Option<&'static str>,
}

impl Op {
    /// An operation with no renames and no constraints of its own.
    pub const fn new(run: OpFn, required: &'static [&'static str], optional: &'static [&'static str]) -> Self {
        Self { run, required, optional, rename: &[], params: None }
    }

    /// With renames (tool parameter -> function parameter).
    pub const fn rename(mut self, rename: &'static [(&'static str, &'static str)]) -> Self {
        self.rename = rename;
        self
    }

    /// With the schema of the function's own parameters.
    pub const fn params(mut self, schema: &'static str) -> Self {
        self.params = Some(schema);
        self
    }

    /// What the operation takes, for error messages.
    pub fn usage(&self) -> String {
        let need = if self.required.is_empty() { "nothing else".to_string() } else { self.required.join(", ") };
        let take =
            if self.optional.is_empty() { String::new() } else { format!("; optional: {}", self.optional.join(", ")) };
        format!("requires {need}{take}")
    }
}

/// Check the arguments against the operation, then run it with its own parameter names.
pub async fn route(label: &str, op: &Op, given: Map<String, Value>) -> ToolResult {
    let passed: Map<String, Value> = given.into_iter().filter(|(_, v)| !v.is_null()).collect();
    let missing: Vec<&str> = op.required.iter().copied().filter(|p| !passed.contains_key(*p)).collect();
    if !missing.is_empty() {
        return Err(ToolError::Value(format!("{label} {}. Missing: {}.", op.usage(), missing.join(", "))));
    }
    let extra: Vec<&str> =
        passed.keys().map(String::as_str).filter(|p| !op.required.contains(p) && !op.optional.contains(p)).collect();
    if !extra.is_empty() {
        return Err(ToolError::Value(format!("{label} does not use: {}. It {}.", extra.join(", "), op.usage())));
    }
    let mut kwargs: Map<String, Value> = passed
        .into_iter()
        .map(|(k, v)| {
            let name = op.rename.iter().find(|(from, _)| *from == k).map(|(_, to)| to.to_string()).unwrap_or(k);
            (name, v)
        })
        .collect();
    if let Some(schema) = op.params {
        let schema: Value = serde_json::from_str(schema).map_err(|err| ToolError::Other(err.to_string()))?;
        kwargs = check_arguments(&schema, &kwargs)
            .map_err(|errors| ToolError::Value(format!("{label}: {}", pydantic::short(&errors))))?;
    }
    (op.run)(kwargs).await
}

/// Run the operation that `action` names in a tool's table (checked by the AI guard when an AI run calls it).
pub async fn dispatch(
    tool: &'static str,
    table: &'static [(&'static str, Op)],
    action: &str,
    given: Map<String, Value>,
) -> ToolResult {
    let label = format!("{tool}(action='{action}')");
    let op = table.iter().find(|(name, _)| *name == action).map(|(_, op)| *op);
    let missing_key = kb_base::pytext::repr(action);
    let call = move |g: Map<String, Value>| -> BoxFuture<'static, ToolResult> {
        Box::pin(async move {
            match op {
                Some(op) => route(&label, &op, g).await,
                // `table[action]` raises a KeyError (the tool's schema only lets the actions of the table through)
                None => Err(ToolError::Other(missing_key)),
            }
        })
    };
    common::guarded(tool, action, given, Box::new(call)).await
}

/// The tool's own arguments without the `action` / `item` selectors.
pub fn params_of(mut values: Map<String, Value>) -> Map<String, Value> {
    for key in ["action", "item"] {
        values.shift_remove(key);
    }
    values
}

pub const MAX_BATCH: usize = 25;
/// A refusal that would repeat for every item (or a wait for a person): the rest of the batch is not tried
const STOPS: [&str; 4] = ["NEEDS_APPROVAL", "DENIED", "APPROVED_BUT_FAILED", "BLOCKED"];

/// Run one call per item, in order, each as a call of its own (so each goes through the AI guard, permissions and
/// audit as a single call would). An item that fails is reported and the others still run; the batch stops early
/// only at a refusal that would repeat or at an item that waits for a person.
///
/// `call` receives one item's own parameters. With `keep_results` false (the call returns a whole ticket) the
/// result of the last item that worked is returned once, as `ticket`.
pub async fn batch<F>(mut call: F, items: &Value, keep_results: bool) -> ToolResult
where
    F: FnMut(Map<String, Value>) -> BoxFuture<'static, ToolResult>,
{
    let items = match items {
        Value::Array(items) if !items.is_empty() => items,
        _ => return Err(ToolError::value("items: a non-empty list of objects, one per call.")),
    };
    if items.len() > MAX_BATCH {
        return Err(ToolError::Value(format!("items: at most {MAX_BATCH} per call; send the rest in another call.")));
    }
    let mut results: Vec<Value> = Vec::new();
    let mut last: Option<Value> = None;
    let mut stopped: Option<&str> = None;
    let mut done = 0;
    for (i, extra) in items.iter().enumerate() {
        if let Some(stopped) = stopped {
            results.push(json!({"index": i, "ok": false, "error": format!("Not run: {stopped}")}));
            continue;
        }
        let Value::Object(extra) = extra else {
            results.push(json!({"index": i, "ok": false, "error": "Each item is an object of parameters."}));
            continue;
        };
        match call(extra.clone()).await {
            // reported per item
            Err(exc) => {
                let message = exc.message().to_string();
                if STOPS.iter().any(|stop| message.starts_with(stop)) {
                    stopped = Some("the batch stopped at the first item that needs a person or is refused.");
                }
                results.push(json!({"index": i, "ok": false, "error": message}));
            }
            Ok(out) => {
                let mut row = Map::new();
                row.insert("index".into(), json!(i));
                row.insert("ok".into(), json!(true));
                if keep_results {
                    row.insert("result".into(), out.clone());
                }
                last = Some(out);
                done += 1;
                results.push(Value::Object(row));
            }
        }
    }
    let mut out = Map::new();
    out.insert("done".into(), json!(done));
    out.insert("failed".into(), json!(results.len() - done));
    out.insert("results".into(), Value::Array(results));
    if !keep_results {
        if let Some(last) = last.filter(|l| !l.is_null()) {
            out.insert("ticket".into(), last);
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::RequestAuthorization;
    use crate::hooks::{self, AiGuardHook, GuardedCall, RunContext};
    use async_trait::async_trait;
    use kb_base::{activity, ctx};

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    /// An operation that answers with what it was given.
    const ECHO: Op =
        Op::new(|kwargs| Box::pin(async move { Ok(Value::Object(kwargs)) }), &["ticket_id"], &["note", "n"]);

    #[test]
    fn usage_says_what_an_operation_takes() {
        assert_eq!(ECHO.usage(), "requires ticket_id; optional: note, n");
        assert_eq!(Op::new(ECHO.run, &["a", "b"], &[]).usage(), "requires a, b");
        assert_eq!(Op::new(ECHO.run, &[], &[]).usage(), "requires nothing else");
    }

    #[tokio::test]
    async fn route_checks_the_parameters_then_runs_with_the_functions_own_names() {
        let label = "t(action='a')";
        // null means left out
        let missing = route(label, &ECHO, object(json!({"ticket_id": null, "note": "x"}))).await;
        assert_eq!(
            missing,
            Err(ToolError::value("t(action='a') requires ticket_id; optional: note, n. Missing: ticket_id."))
        );
        let extra = route(label, &ECHO, object(json!({"ticket_id": "T-1", "color": "red", "name": "x"}))).await;
        assert_eq!(
            extra,
            Err(ToolError::value("t(action='a') does not use: color, name. It requires ticket_id; optional: note, n."))
        );
        let renamed = ECHO.rename(&[("note", "text")]);
        let ran = route(label, &renamed, object(json!({"ticket_id": "T-1", "note": "hello", "n": null}))).await;
        assert_eq!(ran, Ok(json!({"ticket_id": "T-1", "text": "hello"})));
    }

    #[tokio::test]
    async fn the_constraints_of_the_function_are_enforced_as_validate_call_does() {
        let limited = ECHO.params(
            r#"{"properties": {"ticket_id": {"type": "string"},
                 "n": {"type": "integer", "minimum": 0, "default": 0},
                 "note": {"anyOf": [{"enum": ["a", "b"], "type": "string"}, {"type": "null"}], "default": null}},
                "required": ["ticket_id"]}"#,
        );
        let refused = route("t(action='a')", &limited, object(json!({"ticket_id": "T-1", "n": -1, "note": "c"}))).await;
        assert_eq!(
            refused,
            Err(ToolError::value(
                "t(action='a'): n: Input should be greater than or equal to 0; note: Input should be 'a' or 'b'"
            ))
        );
        // values are coerced, and the function gets its defaults
        let ran = route("t(action='a')", &limited, object(json!({"ticket_id": "T-1", "n": "3"}))).await;
        assert_eq!(ran, Ok(json!({"ticket_id": "T-1", "n": 3, "note": null})));
    }

    #[test]
    fn the_selectors_are_not_parameters_of_an_operation() {
        let given = params_of(object(json!({"action": "add", "ticket_id": "T-1", "item": "comment", "text": null})));
        assert_eq!(Value::Object(given), json!({"ticket_id": "T-1", "text": null}));
    }

    fn one_call(extra: Map<String, Value>) -> BoxFuture<'static, ToolResult> {
        Box::pin(async move {
            match extra.get("title").and_then(Value::as_str) {
                Some("stop") => Err(ToolError::value("BLOCKED: not for an AI. Instead: ask a person.")),
                Some(title) => Ok(json!({"title": title})),
                None => Err(ToolError::value("title: Field required")),
            }
        })
    }

    #[tokio::test]
    async fn a_batch_runs_each_item_and_reports_the_ones_that_fail() {
        let items = json!([{"title": "A"}, {}, "not an object", {"title": "B"}]);
        let out = batch(one_call, &items, true).await.expect("a batch");
        assert_eq!(
            out,
            json!({"done": 2, "failed": 2, "results": [
                {"index": 0, "ok": true, "result": {"title": "A"}},
                {"index": 1, "ok": false, "error": "title: Field required"},
                {"index": 2, "ok": false, "error": "Each item is an object of parameters."},
                {"index": 3, "ok": true, "result": {"title": "B"}},
            ]})
        );
        // a call that returns the whole ticket: only the last one is kept, once
        let out = batch(one_call, &json!([{"title": "A"}, {"title": "B"}]), false).await.expect("a batch");
        assert_eq!(
            out,
            json!({"done": 2, "failed": 0, "results": [{"index": 0, "ok": true}, {"index": 1, "ok": true}], "ticket": {"title": "B"}})
        );
    }

    #[tokio::test]
    async fn a_batch_stops_at_a_refusal_that_would_repeat_and_has_a_size_limit() {
        let out =
            batch(one_call, &json!([{"title": "A"}, {"title": "stop"}, {"title": "C"}]), true).await.expect("a batch");
        assert_eq!(out["done"], 1);
        assert_eq!(out["results"][1]["error"], "BLOCKED: not for an AI. Instead: ask a person.");
        assert_eq!(
            out["results"][2],
            json!({"index": 2, "ok": false, "error": "Not run: the batch stopped at the first item that needs a person or is refused."})
        );
        for empty in [json!([]), json!(null), json!({"title": "A"}), json!("x")] {
            let refused = batch(one_call, &empty, true).await;
            assert_eq!(refused, Err(ToolError::value("items: a non-empty list of objects, one per call.")));
        }
        let many: Vec<Value> = (0..26).map(|i| json!({"title": format!("T{i}")})).collect();
        let refused = batch(one_call, &Value::Array(many), true).await;
        assert_eq!(refused, Err(ToolError::value("items: at most 25 per call; send the rest in another call.")));
    }

    /// A stand-in for the AI team's guard: one live run, whose calls are made under the AI's name.
    struct Guard;

    #[async_trait]
    impl AiGuardHook for Guard {
        async fn resolve(&self, authorization: Option<&str>) -> Result<Option<RunContext>, String> {
            match authorization.and_then(crate::common::request_token_of).as_deref() {
                None => Ok(None),
                Some("kbr_live") => Ok(Some(RunContext { member_name: "Dev team".into(), ..RunContext::default() })),
                Some(_) => Err("This AI run has ended (finished, cancelled or stopped by a person); the board no \
                                longer accepts its calls. Stop now."
                    .to_string()),
            }
        }

        async fn guarded(
            &self,
            _tool: &str,
            _action: &str,
            given: Map<String, Value>,
            authorization: Option<&str>,
            call: GuardedCall,
        ) -> ToolResult {
            let Some(run) = self.resolve(authorization).await.map_err(ToolError::Value)? else {
                return call(given).await;
            };
            let entered = activity::set_ai(Some(json!({"member_name": run.member_name})));
            let result = call(given).await;
            ctx::reset(entered);
            result
        }
    }

    const WHO: &[(&str, Op)] = &[(
        "who",
        Op::new(
            |_| Box::pin(crate::common::notify_on_success(async { Ok(json!(activity::current_actor())) })),
            &[],
            &[],
        ),
    )];

    #[tokio::test]
    async fn a_call_goes_through_the_ai_guard_with_the_token_of_its_request() {
        hooks::set_ai_guard_hook(Box::new(Guard));
        ctx::scope(async {
            // no token: a call from outside any run, made as the agent
            assert_eq!(dispatch("t", WHO, "who", Map::new()).await, Ok(json!("agent")));
            // a board run: made under the AI's name
            let _t = ctx::set(RequestAuthorization(Some("Bearer kbr_live".into())));
            assert_eq!(dispatch("t", WHO, "who", Map::new()).await, Ok(json!("Dev team")));
            assert_eq!(
                crate::common::resolve().await.map(|run| run.map(|r| r.member_name)),
                Ok(Some("Dev team".into()))
            );
            // a run that ended: refused with the guard's message
            let _t = ctx::set(RequestAuthorization(Some("Bearer kbr_gone".into())));
            let refused = dispatch("t", WHO, "who", Map::new()).await.expect_err("refused");
            assert!(refused.message().starts_with("This AI run has ended"), "{refused}");
            // another client's own bearer token is not a run
            let _t = ctx::set(RequestAuthorization(Some("Bearer some-other-token".into())));
            assert_eq!(dispatch("t", WHO, "who", Map::new()).await, Ok(json!("agent")));
            // an action the table does not have (the schema never lets one through): Python's KeyError
            let _t = ctx::set(RequestAuthorization(None));
            assert_eq!(dispatch("t", WHO, "nope", Map::new()).await, Err(ToolError::Other("'nope'".into())));
        })
        .await;
    }
}
