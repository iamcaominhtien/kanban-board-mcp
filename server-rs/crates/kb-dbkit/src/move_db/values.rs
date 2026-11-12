//! Values as a copy reads and writes them: one cell of any table of any engine, and the conversions between what a
//! source holds and what a target column takes (`dbkit/move.py`, "Values").
//!
//! The Python code let SQLAlchemy read each row as Python values (`None`, `bool`, `int`, `float`, `str`, `bytes`)
//! and converted them with the model column's type. `Cell` is that value; the column's kind comes from
//! `kb_db::entities::META` ("bool" | "int" | "bigint" | "float" | "str").

use kb_base::{pyjson, pytext};
use kb_db::sea_orm::Value as DbValue;

/// One value of one row.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

impl Cell {
    /// `value is None`.
    pub fn is_null(&self) -> bool {
        matches!(self, Cell::Null)
    }

    /// The whole number this is, when it is one (`int(value)` of a count or a counter).
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Cell::Int(i) => Some(*i),
            Cell::Bool(b) => Some(i64::from(*b)),
            Cell::Float(f) if f.fract() == 0.0 && f.abs() < 9.0e18 => Some(*f as i64),
            Cell::Text(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        }
    }

    /// The text this is, when it is text.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Cell::Text(s) => Some(s),
            _ => None,
        }
    }

    /// `str(value)` as Python prints it (`None`, `True`, `1.5`, the text itself).
    pub fn py_str(&self) -> String {
        match self {
            Cell::Null => "None".into(),
            Cell::Bool(true) => "True".into(),
            Cell::Bool(false) => "False".into(),
            Cell::Int(i) => i.to_string(),
            Cell::Float(f) => float_str(*f),
            Cell::Text(s) => s.clone(),
            Cell::Bytes(b) => format!("{b:?}"),
        }
    }

    /// `len(value)` when the value is text (characters) or bytes, as the stop report gives it.
    pub fn length(&self) -> Option<usize> {
        match self {
            Cell::Text(s) => Some(s.chars().count()),
            Cell::Bytes(b) => Some(b.len()),
            _ => None,
        }
    }

    /// Python truthiness (`bool(value)`).
    fn truthy(&self) -> bool {
        match self {
            Cell::Null => false,
            Cell::Bool(b) => *b,
            Cell::Int(i) => *i != 0,
            Cell::Float(f) => *f != 0.0,
            Cell::Text(s) => !s.is_empty(),
            Cell::Bytes(b) => !b.is_empty(),
        }
    }

    /// The value as a statement parameter. A NULL is given the type of the column it goes into (`kind`), because
    /// PostgreSQL checks a parameter's type even when its value is NULL.
    pub fn to_db_value(&self, kind: &str) -> DbValue {
        match self {
            Cell::Null => match kind {
                "bool" => DbValue::Bool(None),
                "int" | "bigint" => DbValue::BigInt(None),
                "float" => DbValue::Double(None),
                _ => DbValue::String(None),
            },
            Cell::Bool(b) => DbValue::Bool(Some(*b)),
            Cell::Int(i) => DbValue::BigInt(Some(*i)),
            Cell::Float(f) => DbValue::Double(Some(*f)),
            Cell::Text(s) => DbValue::String(Some(s.clone())),
            Cell::Bytes(b) => DbValue::Bytes(Some(b.clone())),
        }
    }
}

/// `str(f)` of a Python float (`1.0`, `1e+16`, `inf`, `nan`).
fn float_str(f: f64) -> String {
    if f.is_nan() {
        "nan".into()
    } else if f.is_infinite() {
        if f > 0.0 { "inf".into() } else { "-inf".into() }
    } else {
        pyjson::float_repr(f)
    }
}

/// `re.fullmatch(r"\s*-?\d+\s*", text)` and then `int(text)`; `None` when it is not a whole number (or one too large
/// for any engine's integer).
fn int_of_text(text: &str) -> Option<i64> {
    let body = pytext::strip(text);
    let digits = body.strip_prefix('-').unwrap_or(body);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    body.parse::<i64>().ok()
}

/// `float(text)`; `None` where Python raises `ValueError`.
fn float_of_text(text: &str) -> Option<f64> {
    let body = pytext::strip(text);
    if body.is_empty() {
        return None;
    }
    body.replace('_', "").parse::<f64>().ok().filter(|_| !body.starts_with('_') && !body.ends_with('_'))
}

/// `_coercer(column)(value)`: the value as the target column's type takes it (SQLite lets a text column hold a
/// number; PostgreSQL does not). A value that cannot be converted is left as it is, and the target says why.
pub fn coerce(kind: &str, value: Cell) -> Cell {
    match kind {
        // SQLAlchemy's Boolean read every value of the column as `bool(value)` before the copy saw it
        "bool" => match value {
            Cell::Null | Cell::Bool(_) => value,
            other => Cell::Bool(other.truthy()),
        },
        "int" | "bigint" => match value {
            Cell::Null | Cell::Int(_) => value,
            Cell::Bool(b) => Cell::Int(i64::from(b)),
            Cell::Float(f) if f.fract() == 0.0 && f.is_finite() && f.abs() < 9.0e18 => Cell::Int(f as i64),
            Cell::Text(s) => match int_of_text(&s) {
                Some(i) => Cell::Int(i),
                None => Cell::Text(s),
            },
            other => other,
        },
        "float" => match value {
            Cell::Null | Cell::Float(_) => value,
            Cell::Int(i) => Cell::Float(i as f64),
            Cell::Bool(b) => Cell::Float(if b { 1.0 } else { 0.0 }),
            Cell::Text(s) => match float_of_text(&s) {
                Some(f) => Cell::Float(f),
                None => Cell::Text(s),
            },
            other => other,
        },
        "str" => match value {
            Cell::Null | Cell::Text(_) => value,
            Cell::Bytes(b) => Cell::Text(String::from_utf8_lossy(&b).into_owned()),
            Cell::Bool(b) => Cell::Text(if b { "1" } else { "0" }.into()),
            other => Cell::Text(other.py_str()),
        },
        _ => value,
    }
}

/// `_row_bytes(row)`: how much a row weighs in a batch (text by its characters, anything else 8).
pub fn row_bytes(row: &[Cell]) -> usize {
    row.iter().map(|v| v.length().unwrap_or(8)).sum()
}

/// The number a value is in Python's `==` between numbers (`True == 1 == 1.0`).
fn number(value: &Cell) -> Option<f64> {
    match value {
        Cell::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Cell::Int(i) => Some(*i as f64),
        Cell::Float(f) => Some(*f),
        _ => None,
    }
}

/// Python's `a == b` for two values read from a database.
fn py_eq(a: &Cell, b: &Cell) -> bool {
    match (a, b) {
        (Cell::Null, Cell::Null) => true,
        (Cell::Text(x), Cell::Text(y)) => x == y,
        (Cell::Bytes(x), Cell::Bytes(y)) => x == y,
        // two whole numbers compare exactly (a float would lose the last digits of a large integer)
        (Cell::Int(x), Cell::Int(y)) => x == y,
        (Cell::Int(x), Cell::Bool(y)) | (Cell::Bool(y), Cell::Int(x)) => *x == i64::from(*y),
        _ => match (number(a), number(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
    }
}

/// `float(value)`; `None` where Python raises.
fn to_float(value: &Cell) -> Option<f64> {
    match value {
        Cell::Text(s) => float_of_text(s),
        other => number(other),
    }
}

/// `_same(a, b)`: equal, or two numbers that differ only by what a float loses between engines.
pub fn same(a: &Cell, b: &Cell) -> bool {
    if py_eq(a, b) {
        return true;
    }
    if matches!(a, Cell::Float(_)) || matches!(b, Cell::Float(_)) {
        return match (to_float(a), to_float(b)) {
            (Some(x), Some(y)) => (x - y).abs() <= 1e-9 * x.abs().max(1.0),
            _ => false,
        };
    }
    false
}

/// A key that is equal for two values exactly when Python's `==` (and `hash`) says so: how sampled rows are found
/// again by their primary key.
pub fn key_of(value: &Cell) -> String {
    match value {
        Cell::Null => "n".into(),
        Cell::Text(s) => format!("s{s}"),
        Cell::Bytes(b) => format!("b{b:?}"),
        Cell::Int(i) => format!("i{i}"),
        Cell::Bool(b) => format!("i{}", i64::from(*b)),
        Cell::Float(f) if f.fract() == 0.0 && f.abs() < 9.0e18 => format!("i{}", *f as i64),
        Cell::Float(f) => format!("f{f:?}"),
    }
}

/// `f"{n:,}"`.
pub fn commas(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if n < 0 {
        out.push('-');
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_in_a_number_column_is_converted() {
        assert_eq!(coerce("int", Cell::Text("12".into())), Cell::Int(12));
        assert_eq!(coerce("str", Cell::Int(12)), Cell::Text("12".into()));
        assert_eq!(coerce("str", Cell::Null), Cell::Null);
    }

    #[test]
    fn values_convert_as_the_python_coercers_did() {
        assert_eq!(coerce("bool", Cell::Int(1)), Cell::Bool(true));
        assert_eq!(coerce("bool", Cell::Int(0)), Cell::Bool(false));
        assert_eq!(coerce("bool", Cell::Null), Cell::Null);
        assert_eq!(coerce("int", Cell::Text(" -7\n".into())), Cell::Int(-7));
        assert_eq!(coerce("int", Cell::Text("7.5".into())), Cell::Text("7.5".into()));
        assert_eq!(coerce("int", Cell::Float(3.0)), Cell::Int(3));
        assert_eq!(coerce("int", Cell::Float(3.5)), Cell::Float(3.5));
        assert_eq!(coerce("int", Cell::Bool(true)), Cell::Int(1));
        assert_eq!(coerce("float", Cell::Int(2)), Cell::Float(2.0));
        assert_eq!(coerce("float", Cell::Text("1e3".into())), Cell::Float(1000.0));
        assert_eq!(coerce("float", Cell::Text("abc".into())), Cell::Text("abc".into()));
        assert_eq!(coerce("str", Cell::Float(1.0)), Cell::Text("1.0".into()));
        assert_eq!(coerce("str", Cell::Float(1e16)), Cell::Text("1e+16".into()));
        assert_eq!(coerce("str", Cell::Bool(true)), Cell::Text("1".into()));
        assert_eq!(coerce("str", Cell::Bytes(vec![0x68, 0x69, 0xff])), Cell::Text("hi\u{fffd}".into()));
    }

    #[test]
    fn rows_weigh_their_text_in_characters() {
        assert_eq!(row_bytes(&[Cell::Text("héllo🎯".into()), Cell::Null, Cell::Int(5), Cell::Bytes(vec![1, 2])]), 24);
    }

    #[test]
    fn same_allows_what_a_float_loses() {
        assert!(same(&Cell::Int(1), &Cell::Bool(true)));
        assert!(same(&Cell::Float(0.1 + 0.2), &Cell::Float(0.3)));
        assert!(same(&Cell::Int(2), &Cell::Float(2.0)));
        assert!(!same(&Cell::Float(1.5), &Cell::Float(1.6)));
        assert!(!same(&Cell::Text("1".into()), &Cell::Int(1)));
        assert!(same(&Cell::Text("1.5".into()), &Cell::Float(1.5)));
        assert!(!same(&Cell::Null, &Cell::Float(0.0)));
        assert!(!same(&Cell::Int(i64::MAX), &Cell::Int(i64::MAX - 1)));
        assert_eq!(key_of(&Cell::Bool(true)), key_of(&Cell::Float(1.0)));
    }

    #[test]
    fn numbers_get_thousands_separators() {
        assert_eq!(commas(0), "0");
        assert_eq!(commas(999), "999");
        assert_eq!(commas(1000), "1,000");
        assert_eq!(commas(-1234567), "-1,234,567");
    }
}
