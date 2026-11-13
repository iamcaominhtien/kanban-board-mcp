//! Pydantic's `ValidationError` as text.
//!
//! FastMCP validates a tool's arguments, and the MCP SDK every incoming message, with Pydantic 2.12; the text of
//! the error (`str(exc)`) is what the agent reads, so it is built here line for line: the count and the model's
//! name, then for each error its location, its message, the kind, the input (Python's `repr`, shortened in the
//! middle when long) and the type of the input, and the link to the documentation of the kind.

use kb_base::pyjson;
use serde_json::Value;

/// The version in the documentation link (`pydantic.version.version_short()` of the reference server).
pub const VERSION_SHORT: &str = "2.12";

/// One line error of a `ValidationError`.
#[derive(Debug, Clone, PartialEq)]
pub struct LineError {
    /// Where: field names, list indexes and union members, outermost first.
    pub loc: Vec<String>,
    /// The message (`Input should be a valid string`).
    pub msg: String,
    /// The kind (`string_type`).
    pub kind: &'static str,
    /// The input the error is about.
    pub input: Value,
}

impl LineError {
    /// An error at `loc`.
    pub fn new(loc: &[String], kind: &'static str, msg: impl Into<String>, input: &Value) -> Self {
        Self { loc: loc.to_vec(), msg: msg.into(), kind, input: input.clone() }
    }
}

/// `type(value).__name__` of the Python object a JSON value is read as.
pub fn input_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `repr(value)` as an error shows it: at most 50 bytes, else the first 25 and the last 24 around `...` (cut at
/// character boundaries, as pydantic-core does).
pub fn truncated_repr(value: &Value) -> String {
    const MAX_LEN: usize = 50;
    let text = pyjson::py_repr(value);
    if text.len() <= MAX_LEN {
        return text;
    }
    let mid_point = MAX_LEN.div_ceil(2);
    let mut head = mid_point;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - (mid_point - 1);
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}...{}", &text[..head], &text[tail..])
}

/// `str(ValidationError)`: `title` is the name of the model (`get_projectsArguments`).
pub fn format_errors(title: &str, errors: &[LineError]) -> String {
    let count = errors.len();
    let mut out = format!("{count} validation error{} for {title}", if count == 1 { "" } else { "s" });
    for error in errors {
        out.push('\n');
        if !error.loc.is_empty() {
            out.push_str(&error.loc.join("."));
            out.push('\n');
        }
        out.push_str(&format!(
            "  {} [type={}, input_value={}, input_type={}]\n    For further information visit \
             https://errors.pydantic.dev/{VERSION_SHORT}/v/{}",
            error.msg,
            error.kind,
            truncated_repr(&error.input),
            input_type(&error.input),
            error.kind
        ));
    }
    out
}

/// The errors on one line, as `tools/routing.py` shortens them: `loc: msg; loc: msg`.
pub fn short(errors: &[LineError]) -> String {
    errors.iter().map(|e| format!("{}: {}", e.loc.join("."), e.msg)).collect::<Vec<_>>().join("; ")
}

/// `'a', 'b' or 'c'`: the allowed values of a `Literal` in its error message.
pub fn expected_values(values: &[Value]) -> String {
    let shown: Vec<String> = values.iter().map(pyjson::py_repr).collect();
    match shown.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        Some((last, _)) => last.clone(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_error_as_pydantic_prints_it() {
        let errors =
            [LineError::new(&["field".to_string()], "extra_forbidden", "Extra inputs are not permitted", &json!(1))];
        assert_eq!(
            format_errors("XArguments", &errors),
            "1 validation error for XArguments\nfield\n  Extra inputs are not permitted [type=extra_forbidden, \
             input_value=1, input_type=int]\n    For further information visit \
             https://errors.pydantic.dev/2.12/v/extra_forbidden"
        );
    }

    #[test]
    fn a_long_input_is_cut_in_the_middle() {
        let long = json!("0123456789 0123456789 0123456789 0123456789 0123456789 end");
        assert_eq!(truncated_repr(&long), "'0123456789 0123456789 01...23456789 0123456789 end'");
        // bytes are counted, and a character is never cut
        let accents = json!("Hà Nội café ☕ 東京 ééééééééééééééééééééééééééééééééééééééé");
        assert_eq!(truncated_repr(&accents), "'Hà Nội café ☕ 東...ééééééééééé'");
        assert_eq!(truncated_repr(&json!({"a": [1, 2.0, null, true]})), "{'a': [1, 2.0, None, True]}");
    }

    #[test]
    fn the_values_of_a_literal() {
        assert_eq!(expected_values(&[json!("a")]), "'a'");
        assert_eq!(expected_values(&[json!("a"), json!("b")]), "'a' or 'b'");
        assert_eq!(expected_values(&[json!("a"), json!("b"), json!(3)]), "'a', 'b' or 3");
    }
}
