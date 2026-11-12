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
    let extra: Vec<&str> = passed
        .keys()
        .map(String::as_str)
        .filter(|p| !op.required.contains(p) && !op.optional.contains(p))
        .collect();
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
