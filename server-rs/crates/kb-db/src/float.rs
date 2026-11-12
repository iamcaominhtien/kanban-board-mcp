//! A float column, read as the Python server read it.
//!
//! The float columns are double precision on SQLite (`FLOAT` has REAL affinity) and on PostgreSQL (`FLOAT` is
//! `double precision`): a value comes back as it was stored. On MySQL and MariaDB `FLOAT` is single precision. The
//! Python driver asked in the text protocol, where the server prints a `FLOAT` with at most six significant digits,
//! so a stored 0.1 came back as `0.1` and 1234.5678 as `1234.57`. The Rust driver asks in the binary protocol and
//! gets the four bytes; widened to a double they are `0.10000000149011612` and `1234.5677490234375`.
//!
//! `Float` is the type of every float column of the entities (and the type to ask for when a hand-written statement
//! reads one): on MySQL a value that arrives as a `FLOAT` becomes the number of the server's own text for it; a
//! `DOUBLE` (a `SUM` or an `AVG` of a float column, which the server computes and prints in double precision) and
//! every value of the other engines is taken as it is. Apart from that it is an `f64`: it derefs to one, compares
//! and computes with one, and is written to JSON as one.

use std::fmt;
use std::iter::Sum;
use std::ops::{Add, AddAssign, Deref, Div, Mul, Neg, Sub, SubAssign};

use sea_orm::sea_query::{ArrayType, ColumnType, Nullable, ValueType, ValueTypeErr};
use sea_orm::{ActiveValue, ColIdx, IntoActiveValue, QueryResult, TryGetError, TryGetable, Value};
use serde::{Deserialize, Serialize};

/// The value of a float column.
#[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Float(pub f64);

impl Float {
    /// The number.
    pub fn get(self) -> f64 {
        self.0
    }
}

/// What the Python server read for a single-precision value: the server's text for it (the value rounded to six
/// significant digits, as `my_gcvt` prints a `FLOAT`), parsed as a double.
pub fn as_mysql_text(value: f32) -> f64 {
    if !value.is_finite() {
        return f64::from(value);
    }
    // six significant digits of the exact value, ties to even: `dtoa(x, mode 4, FLT_DIG)`
    format!("{:.5e}", f64::from(value)).parse().unwrap_or_else(|_| f64::from(value))
}

/// Whether the value at `index` came from MySQL as a single-precision `FLOAT`.
fn is_mysql_float<I: ColIdx>(res: &QueryResult, index: I) -> bool {
    use sea_orm::sqlx::{Row, TypeInfo, ValueRef};
    let Some(row) = res.try_as_mysql_row() else { return false };
    row.try_get_raw(index.as_sqlx_mysql_index()).is_ok_and(|value| value.type_info().name() == "FLOAT")
}

impl TryGetable for Float {
    fn try_get_by<I: ColIdx>(res: &QueryResult, index: I) -> Result<Self, TryGetError> {
        let value = <f64 as TryGetable>::try_get_by(res, index)?;
        // the driver widened the four bytes of a FLOAT without loss, so narrowing gives them back
        Ok(Float(if is_mysql_float(res, index) { as_mysql_text(value as f32) } else { value }))
    }
}

impl From<Float> for Value {
    fn from(source: Float) -> Self {
        source.0.into()
    }
}

impl ValueType for Float {
    fn try_from(v: Value) -> Result<Self, ValueTypeErr> {
        <f64 as ValueType>::try_from(v).map(Float)
    }

    fn type_name() -> String {
        "Float".to_owned()
    }

    fn array_type() -> ArrayType {
        ArrayType::Double
    }

    fn column_type() -> ColumnType {
        ColumnType::Double
    }
}

impl Nullable for Float {
    fn null() -> Value {
        <f64 as Nullable>::null()
    }
}

impl IntoActiveValue<Float> for Float {
    fn into_active_value(self) -> ActiveValue<Float> {
        ActiveValue::Set(self)
    }
}

impl Deref for Float {
    type Target = f64;

    fn deref(&self) -> &f64 {
        &self.0
    }
}

impl From<f64> for Float {
    fn from(value: f64) -> Self {
        Float(value)
    }
}

impl From<Float> for f64 {
    fn from(value: Float) -> Self {
        value.0
    }
}

impl fmt::Display for Float {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl PartialEq<f64> for Float {
    fn eq(&self, other: &f64) -> bool {
        self.0 == *other
    }
}

impl PartialEq<Float> for f64 {
    fn eq(&self, other: &Float) -> bool {
        *self == other.0
    }
}

impl PartialOrd<f64> for Float {
    fn partial_cmp(&self, other: &f64) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(other)
    }
}

impl PartialOrd<Float> for f64 {
    fn partial_cmp(&self, other: &Float) -> Option<std::cmp::Ordering> {
        self.partial_cmp(&other.0)
    }
}

impl Neg for Float {
    type Output = f64;

    fn neg(self) -> f64 {
        -self.0
    }
}

/// Arithmetic gives a plain `f64`: only what a column holds is a `Float`.
macro_rules! arithmetic {
    ($($trait:ident $method:ident),*) => {$(
        impl $trait<f64> for Float {
            type Output = f64;

            fn $method(self, other: f64) -> f64 {
                $trait::$method(self.0, other)
            }
        }

        impl $trait<Float> for f64 {
            type Output = f64;

            fn $method(self, other: Float) -> f64 {
                $trait::$method(self, other.0)
            }
        }

        impl $trait<Float> for Float {
            type Output = f64;

            fn $method(self, other: Float) -> f64 {
                $trait::$method(self.0, other.0)
            }
        }
    )*};
}

arithmetic!(Add add, Sub sub, Mul mul, Div div);

impl AddAssign<f64> for Float {
    fn add_assign(&mut self, other: f64) {
        self.0 += other;
    }
}

impl SubAssign<f64> for Float {
    fn sub_assign(&mut self, other: f64) {
        self.0 -= other;
    }
}

impl AddAssign<Float> for f64 {
    fn add_assign(&mut self, other: Float) {
        *self += other.0;
    }
}

impl Sum<Float> for f64 {
    fn sum<I: Iterator<Item = Float>>(iter: I) -> f64 {
        iter.map(|value| value.0).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_precision_value_reads_as_the_servers_text() {
        // what MariaDB prints for the FLOAT, parsed (the same pairs are proved against the server and the Python
        // driver in `tests/common`)
        for (stored, read) in [
            (0.1, 0.1),
            (1234.5678, 1234.57),
            (1e-7, 1e-7),
            (16_777_217.0, 16_777_200.0),
            (-0.002_5, -0.002_5),
            (0.0, 0.0),
            (123_456_789.0, 123_457_000.0),
            (1.0 / 3.0, 0.333_333),
            (2.5, 2.5),
            (3.0e38, 3.0e38),
            (1_000_005.0, 1_000_000.0),
            (1_000_015.0, 1_000_020.0),
        ] {
            let got = as_mysql_text(stored as f32);
            assert_eq!(got.to_bits(), f64::to_bits(read), "{stored} stored as FLOAT reads {got}, not {read}");
        }
        assert!(as_mysql_text(-0.0).is_sign_negative());
    }

    #[test]
    fn it_is_an_f64_everywhere_else() {
        let cost = Float(0.25);
        assert_eq!(cost + 0.5, 0.75);
        assert_eq!(1.0 - cost, 0.75);
        assert_eq!(cost * cost, 0.0625);
        assert!(cost > 0.1 && 0.3 > cost && cost == 0.25);
        assert_eq!(cost.max(1.0), 1.0);
        assert_eq!([cost, Float(0.5)].into_iter().sum::<f64>(), 0.75);
        assert_eq!(serde_json::to_string(&cost).unwrap(), "0.25");
        assert_eq!(serde_json::from_str::<Float>("0.25").unwrap(), cost);
        assert_eq!(serde_json::from_str::<Option<Float>>("null").unwrap(), None);
        assert_eq!(format!("{cost} {cost:.3}"), "0.25 0.250");
        assert_eq!(Value::from(cost), Value::Double(Some(0.25)));
        assert_eq!(f64::from(cost), 0.25);
    }
}
