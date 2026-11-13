//! Python's arithmetic where Rust's own would differ in the last digit of a number that is shown or stored.

/// `sum(values)` of floats as Python adds them since 3.12 (Neumaier's compensated sum): adding costs one by one with
/// `+` can end one unit in the last place away, which a rounded total then shows.
pub fn sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let (mut total, mut c) = (0.0f64, 0.0f64);
    for x in values {
        let t = total + x;
        if total.abs() >= x.abs() {
            c += (total - t) + x;
        } else {
            c += (x - t) + total;
        }
        total = t;
    }
    // (the compensation never turns an infinite or overflowed sum into a NaN)
    if c != 0.0 && c.is_finite() {
        total += c;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::sum;

    #[test]
    fn a_sum_is_compensated_as_in_python() {
        // Python 3.12: sum([0.1] * 10) == 1.0, where adding them one by one gives 0.9999999999999999
        assert_eq!(sum([0.1; 10]), 1.0);
        assert_ne!([0.1f64; 10].iter().sum::<f64>(), 1.0);
        // sum([1e16, 1.0, -1e16]) == 1.0
        assert_eq!(sum([1e16, 1.0, -1e16]), 1.0);
        assert_eq!(sum(std::iter::empty()), 0.0);
        assert!(sum([f64::INFINITY, 1.0]).is_infinite());
    }
}
