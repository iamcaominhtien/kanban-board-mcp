"""Docs AI: AI inside the Docs space (design/screens/docs-ai.md and docs-ai-care.md).

Layout: `settings` holds the per-project switches and says which AI team answers, `jobs` records every Docs AI call
(the work the Docs UI polls); the turn itself runs on the assistant engine (`services/assistant`), which keeps the
session of each page and the cost on its `ai_run`. An AI edits pages directly; the page's history undoes it.
"""

from .errors import DocsAiError

__all__ = ["DocsAiError"]
