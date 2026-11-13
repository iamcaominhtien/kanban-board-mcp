//! Small helpers shared by the AI modules (AI v2 keeps one: a rough token estimate).

/// Rough token count (4 characters per token); the provider's own count is the truth.
pub fn estimate_tokens(text: Option<&str>) -> i64 {
    (text.map_or(0, |t| t.chars().count()) as i64 + 3) / 4
}
