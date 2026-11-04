"""The one provider of AI v2: Claude Code on the person's machine. Prices are samples for the usage page only
(the user is on a subscription; dollars on the board are estimates)."""

PROVIDERS: dict[str, dict] = {
    "claude-code": {
        "label": "Claude Code",
        "connection": "local",
        "cli": "claude",
        "models": ["haiku", "sonnet", "opus"],
        "default_model": "sonnet",
    },
}

DEFAULT_PRICE = (3.0, 15.0)
PRICES: dict[str, tuple[float, float]] = {
    "claude-sonnet": (3.0, 15.0),
    "claude-haiku": (1.0, 5.0),
    "claude-opus": (5.0, 25.0),
    "sonnet": (3.0, 15.0),
    "haiku": (1.0, 5.0),
    "opus": (5.0, 25.0),
}
PRICES_UPDATED = "2026-10-01"


def price_for(model: str | None) -> tuple[float, float]:
    """Sample price of a model (longest matching prefix), dollars per million tokens in and out."""
    name = (model or "").lower()
    best = None
    for key in PRICES:
        if name.startswith(key) or key in name:
            if best is None or len(key) > len(best):
                best = key
    return PRICES[best] if best else DEFAULT_PRICE


def cost_of(model: str | None, tokens_in: int, tokens_out: int) -> float:
    """Estimated dollars of one call."""
    pin, pout = price_for(model)
    return (tokens_in * pin + tokens_out * pout) / 1_000_000


def merged_config(raw: dict | None) -> dict:
    """A team's configuration with the lists normalised (MCP servers, skills, plugins, hooks)."""
    out = dict(raw or {})
    for key in ("mcp_servers", "skills", "plugins", "hooks", "disallowed_tools"):
        value = out.get(key)
        out[key] = list(value) if isinstance(value, list) else []
    return out
