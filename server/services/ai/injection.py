"""Text that looks like instructions to an AI (design/screens/ai-safety-cost.md, F).

Detection is a hint for people ("Looks like instructions: treated as plain text"), never a gate: what stops a fooled
model is the permission layer. Trust comes from who wrote a text, never from its wording, and there is no "mark as
safe".
"""

import re

# (pattern, the phrase shown to the person)
_PATTERNS: list[tuple[re.Pattern, str]] = [
    (
        re.compile(
            r"ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)",
            re.I,
        ),
        "ignore previous instructions",
    ),
    (
        re.compile(
            r"disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|your)\s+(?:instructions?|rules?)",
            re.I,
        ),
        "disregard your instructions",
    ),
    (
        re.compile(
            r"\b(?:delete|drop|wipe|erase|remove)\s+(?:the\s+|this\s+|all\s+)?(?:project|board|tickets?|database|repo(?:sitory)?)\b",
            re.I,
        ),
        "delete the project",
    ),
    (
        re.compile(r"\byou\s+are\s+now\b|\bnew\s+instructions?\s*:", re.I),
        "you are now / new instructions",
    ),
    (
        re.compile(
            r"\b(?:reveal|print|show|send)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|api\s*key|secrets?|tokens?)\b",
            re.I,
        ),
        "reveal secrets",
    ),
    (
        re.compile(
            r"\b(?:fetch|download|curl|wget|visit)\b[^.\n]{0,60}https?://", re.I
        ),
        "fetch a link",
    ),
    (
        re.compile(r"\bfollow\s+(?:it|that|the\s+(?:link|instructions?))\b", re.I),
        "follow it",
    ),
    (
        re.compile(
            r"\b(?:change|raise|grant|give)\b[^.\n]{0,30}\b(?:permissions?|admin|owner)\b",
            re.I,
        ),
        "change permissions",
    ),
    (re.compile(r"\bapprove\s+(?:it|this|every|all)\b", re.I), "auto-approve"),
]


def phrases(text: str | None) -> list[str]:
    """The suspicious phrases found in a text, each at most once, in order of appearance."""
    found: list[tuple[int, str]] = []
    for pattern, label in _PATTERNS:
        m = pattern.search(text or "")
        if m:
            found.append((m.start(), m.group(0).strip()[:80]))
    found.sort()
    return [p for _, p in found]


def trust_of(author: str, humans: set[str], ai_names: set[str]) -> str:
    """trusted | data_only | untrusted by who wrote it: project members are trusted, AI members are data only,
    anyone else (guests, imports, external tools) is untrusted."""
    if author in ("user", "Board") or author in humans:
        return "trusted"
    if author in ai_names:
        return "data_only"
    return "untrusted"


def flags_for_comments(
    comments: list[dict], humans: set[str], ai_names: set[str]
) -> list[dict]:
    """Per comment that looks like instructions or comes from an untrusted source: {comment_id, author, trust,
    phrases, hidden}. Trusted people's comments are only flagged when they look like instructions."""
    out = []
    for c in comments:
        if c.get("deleted_at"):
            continue
        author = c.get("author") or "user"
        trust = trust_of(author, humans, ai_names)
        found = phrases(c.get("text")) if trust != "trusted" else []
        if trust == "untrusted" or found:
            out.append(
                {
                    "comment_id": c.get("id"),
                    "author": author,
                    "trust": trust,
                    "phrases": found,
                }
            )
    return out
