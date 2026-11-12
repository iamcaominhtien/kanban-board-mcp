//! The one provider of AI v2: Claude Code on the person's machine. Prices are samples for the usage page only
//! (the user is on a subscription; dollars on the board are estimates).

use serde_json::{Map, Value, json};

/// `PROVIDERS`: the providers by key.
pub fn providers() -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        "claude-code".into(),
        json!({
            "label": "Claude Code",
            "connection": "local",
            "cli": "claude",
            "binary": "claude",
            "install": "npm install -g @anthropic-ai/claude-code",
            "guide_url": "https://docs.claude.com/en/docs/claude-code/setup",
            "models": ["haiku", "sonnet", "opus"],
            "default_model": "sonnet",
        }),
    );
    out
}

/// The price used for a model no key matches.
pub const DEFAULT_PRICE: (f64, f64) = (3.0, 15.0);

/// `PRICES`, in the order of the Python dict (a tie is won by the first key).
pub const PRICES: [(&str, (f64, f64)); 6] = [
    ("claude-sonnet", (3.0, 15.0)),
    ("claude-haiku", (1.0, 5.0)),
    ("claude-opus", (5.0, 25.0)),
    ("sonnet", (3.0, 15.0)),
    ("haiku", (1.0, 5.0)),
    ("opus", (5.0, 25.0)),
];
/// When the sample prices were last looked at.
pub const PRICES_UPDATED: &str = "2026-10-01";

/// Sample price of a model (longest matching prefix), dollars per million tokens in and out.
pub fn price_for(model: Option<&str>) -> (f64, f64) {
    let name = model.unwrap_or("").to_lowercase();
    let mut best: Option<(&str, (f64, f64))> = None;
    for (key, price) in PRICES {
        if (name.starts_with(key) || name.contains(key))
            && best.is_none_or(|(b, _)| key.chars().count() > b.chars().count())
        {
            best = Some((key, price));
        }
    }
    best.map_or(DEFAULT_PRICE, |(_, price)| price)
}

/// Estimated dollars of one call.
pub fn cost_of(model: Option<&str>, tokens_in: i64, tokens_out: i64) -> f64 {
    let (pin, pout) = price_for(model);
    (tokens_in as f64 * pin + tokens_out as f64 * pout) / 1_000_000.0
}

/// A team's configuration with the lists normalised (MCP servers, skills, plugins, hooks).
pub fn merged_config(raw: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut out = raw.cloned().unwrap_or_default();
    for key in ["mcp_servers", "skills", "plugins", "hooks", "disallowed_tools"] {
        let value = match out.get(key) {
            Some(Value::Array(items)) => Value::Array(items.clone()),
            _ => Value::Array(Vec::new()),
        };
        out.insert(key.to_string(), value);
    }
    out
}
