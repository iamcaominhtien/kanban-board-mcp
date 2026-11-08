"""Members made from the ready-made packs get the tools their pack's work needs."""

from services.ai import packs
from tests.ai_helpers import env  # noqa: F401


def _pack(key: str) -> dict:
    return next(p for p in packs.BUILTIN if p["key"] == key)


def test_the_roles_know_which_drawing_to_use():
    from kanban_mcp import instructions
    from services.ai import packs

    personas = {p["key"]: p["persona"] for p in packs.BUILTIN}
    for role in ("ba", "pm", "dev", "designer"):
        assert "draw.io Diagram" in personas[role], role
    # the Designer presents a design document and measures it against the guide's exemplar boards
    for needle in (
        "design document",
        "exemplar boards",
        "Foundations board",
        "side by side",
        "spec per screen",
        "craft.md",
        "three ways",
        "template-like",
    ):
        assert needle in personas["designer"], needle
    text = (
        instructions.INSTRUCTIONS
        if hasattr(instructions, "INSTRUCTIONS")
        else instructions._INSTRUCTIONS_TAIL
    )
    assert "Which drawing" in text
