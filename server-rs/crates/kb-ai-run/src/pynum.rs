//! Python's arithmetic where a number is shown or stored and Rust's own would differ in the last digit: `sum()` of
//! floats (compensated since Python 3.12), `round(x, n)` and `round(x)` (ties go to the even digit).

use serde_json::{Value, json};

pub use kb_base::pynum::sum;

/// `round(x, digits)`: the nearest value with that many decimals of the exact number, a tie going to the even
/// digit.
pub fn round_to(x: f64, digits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{x:.digits$}").parse().unwrap_or(x)
}

/// `round(x)`: the nearest whole number, a half going to the even one.
pub fn round_int(x: f64) -> i64 {
    x.round_ties_even() as i64
}

/// `round(sum(x or 0 for x in values), digits)` as JSON: Python's sum of nothing but zeros is the int `0` (`0.0 or 0`
/// is the int), and `round` keeps an int an int.
pub fn rounded_sum_or_zero(values: &[f64], digits: usize) -> Value {
    if values.iter().all(|v| *v == 0.0) { json!(0) } else { json!(round_to(sum(values.iter().copied()), digits)) }
}

/// `f"{value:g}"`: six significant digits, no trailing zeros, an exponent outside 1e-4..1e6.
pub fn fmt_g(value: f64) -> String {
    if value == 0.0 {
        return if value.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    if !value.is_finite() {
        return if value.is_nan() {
            "nan".into()
        } else if value > 0.0 {
            "inf".into()
        } else {
            "-inf".into()
        };
    }
    let sci = format!("{value:.5e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if !(-4..6).contains(&exp) {
        let mantissa =
            if mantissa.contains('.') { mantissa.trim_end_matches('0').trim_end_matches('.') } else { mantissa };
        let sign = if exp < 0 { '-' } else { '+' };
        return format!("{mantissa}e{sign}{:02}", exp.abs());
    }
    let decimals = (5 - exp).max(0) as usize;
    let text = format!("{value:.decimals$}");
    if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.').to_string() } else { text }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_and_rounds_as_python_does() {
        assert_eq!(sum([0.1; 10]), 1.0);
        assert_eq!(sum([0.1, 0.2, 0.3]), 0.6);
        assert_eq!(sum([1e100, 1.0, -1e100]), 1.0);
        assert_eq!(sum(Vec::<f64>::new()), 0.0);
        assert_eq!(round_to(2.675, 2), 2.67);
        assert_eq!(round_to(0.125, 2), 0.12);
        assert_eq!(round_to(1.25, 1), 1.2);
        assert_eq!(round_to(1.35, 1), 1.4);
        assert_eq!(round_int(0.5), 0);
        assert_eq!(round_int(1.5), 2);
        assert_eq!(round_int(2.5), 2);
        assert_eq!(round_int(-0.5), 0);
        assert_eq!(rounded_sum_or_zero(&[0.0, 0.0], 2), json!(0));
        assert_eq!(rounded_sum_or_zero(&[], 2), json!(0));
        assert_eq!(rounded_sum_or_zero(&[0.1, 0.2], 2), json!(0.3));
        assert_eq!(fmt_g(2.0), "2");
        assert_eq!(fmt_g(0.5), "0.5");
        assert_eq!(fmt_g(1.25), "1.25");
        assert_eq!(fmt_g(24.0), "24");
        assert_eq!(fmt_g(1234567.0), "1.23457e+06");
        assert_eq!(fmt_g(0.00001), "1e-05");
    }
}
