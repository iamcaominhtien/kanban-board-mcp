"""Small helpers shared by the AI modules (AI v2 keeps one: a rough token estimate)."""


def estimate_tokens(text: str | None) -> int:
    """Rough token count (4 characters per token); the provider's own count is the truth."""
    return (len(text or "") + 3) // 4
