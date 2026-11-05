"""Docs AI proposals are gone in AI v2: the assistant edits directly and the page's history undoes it. The routes
answer 410 so an older UI says so instead of failing."""

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["docs-ai"])
GONE = "Proposals are gone in AI v2: the assistant edits directly and the page's history undoes it."


@router.get("/docs/pages/{page_id}/ai/proposals")
async def page_proposals(page_id: str) -> list:
    """No proposals any more: an empty list, so pages render."""
    return []


@router.get("/projects/{project_id}/docs/ai/proposals/pages")
async def proposal_pages(project_id: str) -> list:
    """No proposals any more: an empty list, so the tree renders."""
    return []


@router.post("/docs/ai/proposals/{proposal_id}/{rest:path}")
async def proposal_action(proposal_id: str, rest: str) -> None:
    """Gone: accepting or rejecting a proposal."""
    raise HTTPException(status_code=410, detail=GONE)
