"""Docs AI API (design/screens/docs-ai.md and docs-ai-care.md): one router assembled from a module per feature.

Every endpoint is gated by `services.docs_ai.settings.require_enabled`, except the settings themselves. Errors are
`DocsAiError`: `{"detail": message, "code": …}` with the status the code maps to.
"""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from api.routing import add_routes
from services.docs_ai import DocsAiError

from . import ask, health, page, proposals, settings, threads, tickets, write

# No tags here: each module's router has tags=["docs-ai"] already, and tags on this router would
# make add_routes() build every route again (they used to come out as ["docs-ai", "docs-ai"]).
router = APIRouter()
for _module in (settings, ask, page, write, proposals, threads, health, tickets):
    add_routes(router, _module.router)


async def docs_ai_error_handler(_request: Request, exc: DocsAiError) -> JSONResponse:
    """`{"detail": message, "code": …}` with the status the code maps to."""
    return JSONResponse(
        status_code=exc.status,
        content={"detail": str(exc), "code": exc.code, **exc.extra},
    )
