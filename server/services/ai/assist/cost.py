"""Cost shown before an AI request is sent (design/screens/ai-where-you-work.md, B, C, D, F): "About $0.01 per
answer". Estimated from the size of what is sent and the sample price table; a local runner is not metered."""

from models import AiMember

from ..llm import estimate_tokens
from ..providers import cost_of

# Typical answer length used for the estimate, by kind of request
ANSWER_TOKENS = {"answer": 400, "draft": 600, "run": 1500, "sketch_draw": 1200}


def estimate(
    profile: AiMember | None,
    text_in: str | int,
    kind: str = "answer",
) -> dict:
    """What a request would cost.

    Args:
        profile: The AI member that would answer; None when none is set up.
        text_in: The text that would be sent, or its token count.
        kind: "answer" (chat), "draft" (editor), "sketch_draw" (shapes for a sketch) or "run" (a work run, shown as a
            rough ceiling).

    Returns:
        {"metered", "usd", "tokens_in", "tokens_out"}; `usd` is None when the member is not metered.
    """
    tin = text_in if isinstance(text_in, int) else estimate_tokens(text_in)
    tin += 400  # the fixed system prompt
    tout = ANSWER_TOKENS.get(kind, 400)
    metered = bool(profile and profile.connection == "api_key")
    usd = round(cost_of(profile.model, tin, tout), 4) if metered and profile else None
    return {"metered": metered, "usd": usd, "tokens_in": tin, "tokens_out": tout}
