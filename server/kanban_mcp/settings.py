"""Switches read from the environment."""

import os


def ideas_enabled() -> bool:
    """Whether the Idea Space tools are exposed over MCP (off by default)."""
    return os.environ.get("KANBAN_MCP_IDEA_TOOLS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
