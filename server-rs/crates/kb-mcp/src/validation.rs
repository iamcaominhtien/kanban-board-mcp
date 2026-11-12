//! The arguments of a tool call, checked as FastMCP and Pydantic check them.
//!
//! FastMCP builds a Pydantic model from the tool function's signature and the registry makes it refuse unknown
//! arguments (`registry._reject_unknown_arguments`). Here one validator does the same from the tool's `inputSchema`
//! (the schema *is* that model, exported), so every tool gets it without code of its own:
//!
//! 1. `pre_parse_json`: text given for a parameter that is not plain text is read as JSON when it holds a list, an
//!    object or `null` (clients often send those as text).
//! 2. each parameter in the order of the schema: required or its default, then its type in Pydantic's lax mode
//!    (`"yes"` is a boolean, `"12"` and `12.0` are integers, a number is never text), its allowed values and limits;
//! 3. arguments the schema does not name are refused.
//!
//! The result is the arguments the tool function receives: every parameter of the schema, the coerced value or the
//! default. A failure is the text of Pydantic's `ValidationError`.

use serde_json::{Map, Value, json};

use crate::pydantic::{LineError, expected_values, format_errors};

/// Validate `arguments` against a tool's `inputSchema`; `title` is the model's name (`<tool>Arguments`).
pub fn validate_arguments(
    title: &str,
    schema: &Value,
    arguments: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    check_arguments(schema, arguments).map_err(|errors| format_errors(title, &errors))
}

/// `validate_arguments` with the errors as a list (for a caller that prints them its own way).
pub fn check_arguments(schema: &Value, arguments: &Map<String, Value>) -> Result<Map<String, Value>, Vec<LineError>> {
    let empty = Map::new();
    let properties = schema.get("properties").and_then(Value::as_object).unwrap_or(&empty);
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let data = pre_parse_json(properties, arguments);
    let whole = Value::Object(data.clone());

    let mut errors = Vec::new();
    let mut out = Map::new();
    for (name, property) in properties {
        let loc = vec![name.clone()];
        match data.get(name) {
            Some(value) => {
                if let Some(value) = validate_value(property, value, &loc, &mut errors) {
                    out.insert(name.clone(), value);
                }
            }
            None if required.contains(&name.as_str()) => {
                errors.push(LineError::new(&loc, "missing", "Field required", &whole));
            }
            None => {
                out.insert(name.clone(), property.get("default").cloned().unwrap_or(Value::Null));
            }
        }
    }
    for (name, value) in &data {
        if !properties.contains_key(name) {
            errors.push(LineError::new(
                std::slice::from_ref(name),
                "extra_forbidden",
                "Extra inputs are not permitted",
                value,
            ));
        }
    }
    if errors.is_empty() { Ok(out) } else { Err(errors) }
}

/// A parameter annotated `str` and nothing else (FastMCP leaves its text alone).
fn is_plain_text(property: &Value) -> bool {
    property.get("type").and_then(Value::as_str) == Some("string")
        && property.get("enum").is_none()
        && property.get("const").is_none()
}

/// FastMCP's `pre_parse_json`: text that is JSON for a list, an object or `null` is replaced by that value, unless
/// the parameter is plain text. Text that is JSON for a string, a number or a boolean stays text (`"12"` for a
/// text-or-nothing parameter must not become a number).
fn pre_parse_json(properties: &Map<String, Value>, arguments: &Map<String, Value>) -> Map<String, Value> {
    let mut data = arguments.clone();
    for (name, value) in arguments {
        let (Some(property), Value::String(text)) = (properties.get(name), value) else { continue };
        if is_plain_text(property) {
            continue;
        }
        if let Ok(parsed @ (Value::Null | Value::Array(_) | Value::Object(_))) = serde_json::from_str::<Value>(text) {
            data.insert(name.clone(), parsed);
        }
    }
    data
}

fn kind_of(schema: &Value) -> Option<&str> {
    schema.get("type").and_then(Value::as_str)
}

/// The name of a union member in an error's location, as pydantic-core tags it.
fn union_tag(schema: &Value) -> String {
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let shown: Vec<String> = values.iter().map(kb_base::pyjson::py_repr).collect();
        return format!("literal[{}]", shown.join(","));
    }
    match kind_of(schema) {
        Some("string") => "str".into(),
        Some("integer") => "int".into(),
        Some("number") => "float".into(),
        Some("boolean") => "bool".into(),
        Some("array") => format!("list[{}]", schema.get("items").map(union_tag).unwrap_or_else(|| "any".into())),
        Some("object") => "dict[str,any]".into(),
        _ => "any".into(),
    }
}

/// Whether `value` already is of the member's type (the union's first, strict pass).
fn is_exact(schema: &Value, value: &Value) -> bool {
    match kind_of(schema) {
        Some("string") => value.is_string(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("number") => value.is_f64(),
        Some("boolean") => value.is_boolean(),
        Some("array") => value.is_array(),
        Some("object") => value.is_object(),
        Some("null") => value.is_null(),
        _ => true,
    }
}

/// One value against its schema: the value the function gets, or `None` after adding the errors.
fn validate_value(schema: &Value, value: &Value, loc: &[String], errors: &mut Vec<LineError>) -> Option<Value> {
    if let Some(members) = schema.get("anyOf").and_then(Value::as_array) {
        let nullable = members.iter().any(|m| kind_of(m) == Some("null"));
        if nullable && value.is_null() {
            return Some(Value::Null);
        }
        let others: Vec<&Value> = members.iter().filter(|m| kind_of(m) != Some("null")).collect();
        if let [only] = others.as_slice() {
            // `X | None`: the error is X's own
            return validate_value(only, value, loc, errors);
        }
        // a union: the member the value already is, else the first that reads it, else every member's errors
        let mut all = Vec::new();
        for strict in [true, false] {
            for member in &others {
                if strict && !is_exact(member, value) {
                    continue;
                }
                let mut own = Vec::new();
                let mut member_loc = loc.to_vec();
                member_loc.push(union_tag(member));
                if let Some(read) = validate_value(member, value, &member_loc, &mut own) {
                    return Some(read);
                }
                if !strict {
                    all.extend(own);
                }
            }
        }
        errors.extend(all);
        return None;
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if allowed.contains(value) {
            return Some(value.clone());
        }
        errors.push(LineError::new(
            loc,
            "literal_error",
            format!("Input should be {}", expected_values(allowed)),
            value,
        ));
        return None;
    }
    if let Some(allowed) = schema.get("const") {
        if allowed == value {
            return Some(value.clone());
        }
        let expected = expected_values(std::slice::from_ref(allowed));
        errors.push(LineError::new(loc, "literal_error", format!("Input should be {expected}"), value));
        return None;
    }
    match kind_of(schema) {
        Some("string") => validate_str(schema, value, loc, errors),
        Some("boolean") => validate_bool(value, loc, errors),
        Some("integer") => validate_int(schema, value, loc, errors),
        Some("number") => validate_float(schema, value, loc, errors),
        Some("array") => validate_list(schema, value, loc, errors),
        Some("object") => match value {
            Value::Object(_) => Some(value.clone()),
            _ => {
                errors.push(LineError::new(loc, "dict_type", "Input should be a valid dictionary", value));
                None
            }
        },
        Some("null") => match value {
            Value::Null => Some(Value::Null),
            _ => {
                errors.push(LineError::new(loc, "none_required", "Input should be None", value));
                None
            }
        },
        _ => Some(value.clone()),
    }
}

fn plural(n: u64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn validate_str(schema: &Value, value: &Value, loc: &[String], errors: &mut Vec<LineError>) -> Option<Value> {
    let Value::String(text) = value else {
        errors.push(LineError::new(loc, "string_type", "Input should be a valid string", value));
        return None;
    };
    let length = text.chars().count() as u64;
    if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
        if length < min {
            let msg = format!("String should have at least {min} character{}", plural(min));
            errors.push(LineError::new(loc, "string_too_short", msg, value));
            return None;
        }
    }
    if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
        if length > max {
            let msg = format!("String should have at most {max} character{}", plural(max));
            errors.push(LineError::new(loc, "string_too_long", msg, value));
            return None;
        }
    }
    if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
        if regex::Regex::new(pattern).is_ok_and(|re| !re.is_match(text)) {
            let msg = format!("String should match pattern '{pattern}'");
            errors.push(LineError::new(loc, "string_pattern_mismatch", msg, value));
            return None;
        }
    }
    Some(value.clone())
}

/// Pydantic's lax boolean: `true`/`false`, 0 and 1 (also as `0.0` and `1.0`), and the words it knows.
fn validate_bool(value: &Value, loc: &[String], errors: &mut Vec<LineError>) -> Option<Value> {
    const UNREADABLE: &str = "Input should be a valid boolean, unable to interpret input";
    let read = match value {
        Value::Bool(b) => Ok(*b),
        Value::String(text) => match text.to_lowercase().as_str() {
            "0" | "off" | "f" | "false" | "n" | "no" => Ok(false),
            "1" | "on" | "t" | "true" | "y" | "yes" => Ok(true),
            _ => Err(("bool_parsing", UNREADABLE)),
        },
        Value::Number(n) if !n.is_f64() => match n.as_i64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(("bool_parsing", UNREADABLE)),
        },
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => Ok(false),
            Some(1.0) => Ok(true),
            _ => Err(("bool_type", "Input should be a valid boolean")),
        },
        _ => Err(("bool_type", "Input should be a valid boolean")),
    };
    match read {
        Ok(b) => Some(Value::Bool(b)),
        Err((kind, msg)) => {
            errors.push(LineError::new(loc, kind, msg, value));
            None
        }
    }
}

/// `int("12")` as pydantic-core reads text: spaces around, a sign, digits with single underscores, and a
/// fraction of zeros (`"12.0"`).
fn str_as_int(text: &str) -> Option<i64> {
    let text = kb_base::pytext::strip(text);
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let whole = match digits.split_once('.') {
        Some((whole, zeros)) if !zeros.is_empty() && zeros.chars().all(|c| c == '0') => whole,
        Some(_) => return None,
        None => digits,
    };
    if whole.is_empty() || whole.starts_with('_') || whole.ends_with('_') || whole.contains("__") {
        return None;
    }
    let plain: String = whole.chars().filter(|c| *c != '_').collect();
    if !plain.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: i64 = plain.parse().ok()?;
    Some(if negative { -n } else { n })
}

/// The limits of a number (`ge`, `le`, `gt`, `lt` of the Python `Field`), checked on the value read; the error
/// shows the input as it was given.
fn check_limits(schema: &Value, read: f64, value: &Value, loc: &[String], errors: &mut Vec<LineError>) -> bool {
    let limits: [(&str, &'static str, &str, fn(f64, f64) -> bool); 4] = [
        ("exclusiveMinimum", "greater_than", "greater than", |v, l| v > l),
        ("minimum", "greater_than_equal", "greater than or equal to", |v, l| v >= l),
        ("exclusiveMaximum", "less_than", "less than", |v, l| v < l),
        ("maximum", "less_than_equal", "less than or equal to", |v, l| v <= l),
    ];
    for (key, kind, words, holds) in limits {
        let Some(limit) = schema.get(key).filter(|l| l.is_number()) else { continue };
        if !holds(read, limit.as_f64().unwrap_or(0.0)) {
            let shown = kb_base::pyjson::py_str(limit);
            errors.push(LineError::new(loc, kind, format!("Input should be {words} {shown}"), value));
            return false;
        }
    }
    true
}

/// Pydantic's lax integer: an integer, a boolean, a float without a fraction, or text that is one.
fn validate_int(schema: &Value, value: &Value, loc: &[String], errors: &mut Vec<LineError>) -> Option<Value> {
    let read: Result<i64, (&'static str, &str)> = match value {
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::Number(n) if !n.is_f64() => {
            n.as_i64().ok_or(("int_parsing_size", "Unable to parse input string as an integer, exceeded maximum size"))
        }
        Value::Number(n) => match n.as_f64() {
            Some(f) if !f.is_finite() => Err(("finite_number", "Input should be a finite number")),
            Some(f) if f.fract() == 0.0 => Ok(f as i64),
            _ => Err(("int_from_float", "Input should be a valid integer, got a number with a fractional part")),
        },
        Value::String(text) => str_as_int(text)
            .ok_or(("int_parsing", "Input should be a valid integer, unable to parse string as an integer")),
        _ => Err(("int_type", "Input should be a valid integer")),
    };
    match read {
        Ok(n) => check_limits(schema, n as f64, value, loc, errors).then(|| json!(n)),
        Err((kind, msg)) => {
            errors.push(LineError::new(loc, kind, msg, value));
            None
        }
    }
}

/// Pydantic's lax float: a number, a boolean, or text that is a number.
fn validate_float(schema: &Value, value: &Value, loc: &[String], errors: &mut Vec<LineError>) -> Option<Value> {
    let read: Result<f64, (&'static str, &str)> = match value {
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::Number(n) => n.as_f64().ok_or(("float_type", "Input should be a valid number")),
        Value::String(text) => kb_base::pytext::strip(text)
            .parse::<f64>()
            .map_err(|_| ("float_parsing", "Input should be a valid number, unable to parse string as a number")),
        _ => Err(("float_type", "Input should be a valid number")),
    };
    match read {
        Ok(f) => check_limits(schema, f, value, loc, errors).then(|| json!(f)),
        Err((kind, msg)) => {
            errors.push(LineError::new(loc, kind, msg, value));
            None
        }
    }
}

fn validate_list(schema: &Value, value: &Value, loc: &[String], errors: &mut Vec<LineError>) -> Option<Value> {
    let Value::Array(items) = value else {
        errors.push(LineError::new(loc, "list_type", "Input should be a valid list", value));
        return None;
    };
    let count = items.len() as u64;
    let before = errors.len();
    let mut out = Vec::with_capacity(items.len());
    match schema.get("items") {
        Some(item_schema) => {
            for (index, item) in items.iter().enumerate() {
                let mut item_loc = loc.to_vec();
                item_loc.push(index.to_string());
                if let Some(read) = validate_value(item_schema, item, &item_loc, errors) {
                    out.push(read);
                }
            }
        }
        None => out.extend(items.iter().cloned()),
    }
    if errors.len() > before {
        return None;
    }
    if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
        if count < min {
            let msg = format!("List should have at least {min} item{} after validation, not {count}", plural(min));
            errors.push(LineError::new(loc, "too_short", msg, value));
            return None;
        }
    }
    if let Some(max) = schema.get("maxItems").and_then(Value::as_u64) {
        if count > max {
            let msg = format!("List should have at most {max} item{} after validation, not {count}", plural(max));
            errors.push(LineError::new(loc, "too_long", msg, value));
            return None;
        }
    }
    Some(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        json!({
            "properties": {
                "action": {"enum": ["a", "b"], "type": "string"},
                "name": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null},
                "limit": {"default": 100, "maximum": 500, "minimum": 1, "type": "integer"},
                "flag": {"anyOf": [{"type": "boolean"}, {"type": "null"}], "default": null},
                "tags": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null},
                "plain": {"type": "string", "default": "x"}
            },
            "required": ["action"],
            "type": "object",
            "additionalProperties": false
        })
    }

    fn check(arguments: Value) -> Result<Map<String, Value>, String> {
        validate_arguments("tArguments", &schema(), arguments.as_object().expect("an object"))
    }

    #[test]
    fn defaults_fill_what_is_left_out_and_values_are_coerced() {
        let got = check(json!({"action": "a", "flag": "yes", "limit": "12", "tags": "[\"x\"]", "name": "null"}));
        assert_eq!(
            Value::Object(got.expect("valid")),
            json!({"action": "a", "name": null, "limit": 12, "flag": true, "tags": ["x"], "plain": "x"})
        );
        // plain text is never read as JSON
        let got = check(json!({"action": "b", "plain": "[1]", "limit": 5.0})).expect("valid");
        assert_eq!(got["plain"], "[1]");
        assert_eq!(got["limit"], 5);
    }

    #[test]
    fn errors_come_in_the_order_of_the_schema_then_the_unknown_arguments() {
        let text = check(json!({"zz": 1, "tags": ["a", 2], "limit": 0})).expect_err("invalid");
        let locs: Vec<&str> = text.lines().filter(|l| !l.starts_with(' ')).skip(1).collect();
        assert_eq!(locs, ["action", "limit", "tags.1", "zz"]);
        assert!(text.starts_with("4 validation errors for tArguments\naction\n  Field required [type=missing, "));
        assert!(text.contains("Input should be greater than or equal to 1 [type=greater_than_equal, input_value=0"));
    }
}
