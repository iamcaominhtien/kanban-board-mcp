"""Docs AI: AI inside the Docs space (design/screens/docs-ai.md and docs-ai-care.md).

Layout: `access` decides what an AI may read, `settings` holds the per-project switches, `engine` makes one metered
call as an AI member, `jobs` records every Docs AI call, `sessions` keeps one Claude Code session for each (page,
member); one module per feature builds on them. What the AI writes for a person is a draft, a proposal, a dashed block,
a diagram or a list to review; an AI member's own page edits follow the project's edit mode (direct by default).
"""

from .errors import DocsAiError

__all__ = ["DocsAiError"]
