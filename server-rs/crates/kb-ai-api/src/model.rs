//! What Pydantic does with the body of a route whose model keeps only the keys that were sent
//! (`body.model_dump(exclude_unset=True)`): the keys the model declares are checked for their type and kept in the
//! order the model declares them; a key the model does not know is dropped.

use kb_base::{ApiError, ApiResult};
use serde_json::{Map, Value, json};

/// The type a model field is declared with (every one is `Optional`: `null` is always accepted).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `str`.
    Str,
    /// `int` (a float with no fraction is accepted, as Pydantic does).
    Int,
    /// `float` (kept as a float, an `int` is converted as Pydantic does).
    Float,
    /// `dict[str, Any]`.
    Object,
    /// `list[str]`.
    StrList,
}

/// One entry of the 422 list.
fn problem(key: &str, kind: &str, msg: &str) -> Value {
    json!({"type": kind, "loc": ["body", key], "msg": msg})
}

/// The `model_dump(exclude_unset=True)` of a model made of `spec`: its fields that were sent, in the model's order.
/// A value of the wrong type answers 422 as FastAPI does (the field is in `loc`).
pub fn fields(mut body: Map<String, Value>, spec: &[(&str, Kind)]) -> ApiResult<Map<String, Value>> {
    let mut out = Map::new();
    let mut errors: Vec<Value> = Vec::new();
    for (key, kind) in spec {
        let Some(value) = body.remove(*key) else { continue };
        if value.is_null() {
            out.insert((*key).to_string(), value);
            continue;
        }
        match (kind, &value) {
            (Kind::Str, Value::String(_)) | (Kind::Object, Value::Object(_)) => {
                out.insert((*key).to_string(), value);
            }
            (Kind::Int, Value::Number(n)) => {
                if n.is_i64() || n.is_u64() {
                    out.insert((*key).to_string(), value);
                } else if let Some(f) = n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15) {
                    out.insert((*key).to_string(), json!(f as i64));
                } else {
                    errors.push(problem(key, "int_from_float", "Input should be a valid integer, got a number with a fractional part"));
                }
            }
            (Kind::Float, Value::Number(n)) => {
                out.insert((*key).to_string(), json!(n.as_f64().unwrap_or(0.0)));
            }
            (Kind::StrList, Value::Array(items)) => {
                if items.iter().all(Value::is_string) {
                    out.insert((*key).to_string(), value);
                } else {
                    errors.push(problem(key, "string_type", "Input should be a valid string"));
                }
            }
            (Kind::Str, _) => errors.push(problem(key, "string_type", "Input should be a valid string")),
            (Kind::Int, _) => errors.push(problem(key, "int_type", "Input should be a valid integer")),
            (Kind::Float, _) => errors.push(problem(key, "float_type", "Input should be a valid number")),
            (Kind::Object, _) => errors.push(problem(key, "dict_type", "Input should be a valid dictionary")),
            (Kind::StrList, _) => errors.push(problem(key, "list_type", "Input should be a valid list")),
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(ApiError::unprocessable(Value::Array(errors)))
    }
}

/// A SQL `LIMIT` from a query parameter that may be negative (SQLite reads a negative limit as no limit).
pub fn limit_of(limit: i64) -> u64 {
    if limit < 0 { i64::MAX as u64 } else { limit as u64 }
}
