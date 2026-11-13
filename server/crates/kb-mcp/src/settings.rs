//! Switches read from the environment.

use std::sync::LazyLock;

/// `ideas_enabled()` for a value of `KANBAN_MCP_IDEA_TOOLS`.
pub fn is_on(value: &str) -> bool {
    matches!(kb_base::pytext::strip(value).to_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

/// Whether the Idea Space tools are exposed over MCP (off by default). Read once: the Python server builds its
/// tool list and its instructions when it starts.
pub fn ideas_enabled() -> bool {
    static ENABLED: LazyLock<bool> =
        LazyLock::new(|| is_on(&std::env::var("KANBAN_MCP_IDEA_TOOLS").unwrap_or_default()));
    *ENABLED
}

#[cfg(test)]
mod tests {
    use super::is_on;

    #[test]
    fn the_words_that_switch_the_idea_tools_on() {
        for on in ["1", "true", "yes", "on", " ON ", "True\n"] {
            assert!(is_on(on), "{on:?}");
        }
        for off in ["", "0", "false", "no", "off", "2", "enabled"] {
            assert!(!is_on(off), "{off:?}");
        }
    }
}
