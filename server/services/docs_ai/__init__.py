"""Docs AI: AI inside the Docs space (design/screens/docs-ai.md and docs-ai-care.md).

Layout: `access` decides what an AI may read, `settings` holds the per-project switches, `engine` makes one metered
call as an AI member, `jobs` records every Docs AI call; one module per feature builds on them. AI never edits a
published page: the output is a draft, a proposal, a dashed block or a list to review.
"""

from .errors import DocsAiError

__all__ = ["DocsAiError"]
