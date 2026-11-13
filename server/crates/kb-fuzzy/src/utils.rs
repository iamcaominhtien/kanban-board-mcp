//! Helpers shared by the scorers. `rapidfuzz.utils.default_process` is not ported: no call site passes a processor.

/// Characters the compiled rapidfuzz splits words on (`str.split()` in the Python reference): Python's
/// `str.isspace()` minus U+0085 and U+00A0, which the compiled library does not treat as whitespace.
pub(crate) fn is_py_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{1c}'..='\u{20}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}
