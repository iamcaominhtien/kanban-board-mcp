"""Docs AI API: proposals from AI members (docs-ai-care B). Review on the page, accept into your draft, reject."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import DocsAiProposal, DocsPage
from services import activity as svc_activity
from services.docs_ai import DocsAiError, proposals
from services.docs_ai import settings as svc_settings

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def by() -> str:
    """The person making the request (X-Actor)."""
    return svc_activity.current_actor() or "user"


class NoteBody(BaseModel):
    """An optional reason (the AI member sees it when a change is rejected)."""

    note: Optional[str] = None


class EditBody(BaseModel):
    """The text a change should put on the page instead."""

    new: str


async def _proposal(session: AsyncSession, proposal_id: str) -> DocsAiProposal:
    p = await session.get(DocsAiProposal, proposal_id)
    if p is None:
        raise DocsAiError("not_found", "That proposal does not exist.")
    await svc_settings.require_enabled(session, p.project_id)
    return p


async def _out(session: AsyncSession, p: DocsAiProposal) -> dict[str, Any]:
    await session.refresh(p)
    return await proposals.view(session, p, actor=by())


@router.get("/docs/pages/{page_id}/ai/proposals")
async def page_proposals(page_id: str, session: Session) -> dict[str, Any]:
    """Waiting and recent proposals of a page. Only people who can edit the page see them."""
    page = await session.get(DocsPage, page_id)
    if page is None or page.deleted_at:
        raise DocsAiError("not_found", "Page not found.")
    await svc_settings.require_enabled(session, page.project_id)
    if not await proposals.can_edit_page(session, page.project_id, by()):
        return {"proposals": [], "can_review": False}
    return {
        "proposals": await proposals.list_for_page(session, page_id, actor=by()),
        "can_review": True,
    }


@router.get("/projects/{project_id}/docs/ai/proposals/pages")
async def waiting_pages(project_id: str, session: Session) -> list[str]:
    """Page ids with a proposal waiting (the purple dot in the tree)."""
    await svc_settings.require_enabled(session, project_id)
    if not await proposals.can_edit_page(session, project_id, by()):
        return []
    return await proposals.waiting_page_ids(session, project_id)


@router.post("/docs/ai/proposals/{proposal_id}/changes/{n}/accept")
async def accept_change(proposal_id: str, n: int, session: Session) -> dict[str, Any]:
    """Accept one change: its text goes into your draft of the page (you publish it yourself)."""
    p = await _proposal(session, proposal_id)
    p = await proposals.decide_change(session, p.id, n, by=by(), accept=True)
    return await _out(session, p)


@router.post("/docs/ai/proposals/{proposal_id}/changes/{n}/reject")
async def reject_change(
    proposal_id: str, n: int, session: Session, body: Optional[NoteBody] = None
) -> dict[str, Any]:
    """Reject one change, with an optional reason."""
    p = await _proposal(session, proposal_id)
    p = await proposals.decide_change(
        session, p.id, n, by=by(), accept=False, note=body.note if body else None
    )
    return await _out(session, p)


@router.post("/docs/ai/proposals/{proposal_id}/changes/{n}")
async def edit_change(
    proposal_id: str, n: int, body: EditBody, session: Session
) -> dict[str, Any]:
    """Edit the text a change puts on the page, before accepting it."""
    p = await _proposal(session, proposal_id)
    p = await proposals.edit_change(session, p.id, n, by=by(), new=body.new)
    return await _out(session, p)


@router.post("/docs/ai/proposals/{proposal_id}/accept-all")
async def accept_all(
    proposal_id: str, session: Session, body: Optional[NoteBody] = None
) -> dict[str, Any]:
    """Accept every change that still applies into your draft."""
    p = await _proposal(session, proposal_id)
    p = await proposals.decide_all(
        session, p.id, by=by(), accept=True, note=body.note if body else None
    )
    return await _out(session, p)


@router.post("/docs/ai/proposals/{proposal_id}/reject-all")
async def reject_all(
    proposal_id: str, session: Session, body: Optional[NoteBody] = None
) -> dict[str, Any]:
    """Reject the proposal (the AI member sees the reason)."""
    p = await _proposal(session, proposal_id)
    p = await proposals.decide_all(
        session, p.id, by=by(), accept=False, note=body.note if body else None
    )
    return await _out(session, p)
