"""Docs AI API: keeping pages true (the banner, still correct, suggested edits) and Docs health."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import activity as svc_activity
from services import docs as svc_docs
from services.docs_ai import DocsAiError, access, jobs
from services.docs_ai import freshness as fresh
from services.docs_ai import health as svc
from services.docs_ai import settings as svc_settings

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def by() -> str:
    """The person making the request (X-Actor)."""
    return svc_activity.current_actor() or "user"


async def _editable_page(session: AsyncSession, page_id: str, *, ai: bool = True):
    """The page, for someone who can edit it, with Docs AI on and the page readable by AI."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    await svc_settings.require_enabled(session, page.project_id)
    if ai and not await access.ai_can_read(session, page):
        raise DocsAiError("hidden", "This page is hidden from AI.")
    return page


# ---------------------------------------------------------------------------
# One page
# ---------------------------------------------------------------------------


@router.post("/docs/pages/{page_id}/ai/freshness")
async def check_freshness(page_id: str, session: Session) -> dict[str, Any]:
    """Check on demand whether the page still matches its tickets and linked pages (a job; `result.check` is what
    `GET` returns). People who can edit the page."""
    return jobs.to_dict(await fresh.start_check(session, page_id, by()))


@router.get("/docs/pages/{page_id}/ai/freshness")
async def get_freshness(page_id: str, session: Session) -> dict[str, Any]:
    """The banner data: `{state, stale, reasons, hidden, checked_at, ...}`. Only people who can edit the page see it;
    a page hidden from AI is never flagged."""
    page = await _editable_page(session, page_id)
    return fresh.describe(await fresh.get_check(session, page.id), page)


@router.post("/docs/pages/{page_id}/ai/freshness/still-correct")
async def still_correct(page_id: str, session: Session) -> dict[str, Any]:
    """ "Still correct": hide the banner for 30 days; it returns only when what the page depends on changes."""
    page = await _editable_page(session, page_id)
    row = await fresh.still_correct(session, page.id, by())
    await board_events.publish(board_events.INVALIDATE)
    return fresh.describe(row, page)


class DismissBody(BaseModel):
    """Dismiss a reason: this time, 30 days, or never for this kind of reason."""

    key: str
    level: str


@router.post("/docs/pages/{page_id}/ai/freshness/dismiss")
async def dismiss_reason(
    page_id: str, body: DismissBody, session: Session
) -> dict[str, Any]:
    """Dismiss one reason (`level`: once, 30d or never). Remembered per page."""
    page = await _editable_page(session, page_id)
    row = await fresh.dismiss(session, page.id, body.key, body.level, by())
    await board_events.publish(board_events.INVALIDATE)
    return fresh.describe(row, page)


@router.post("/docs/pages/{page_id}/ai/freshness/suggest")
async def suggest_edits(page_id: str, session: Session) -> dict[str, Any]:
    """Suggest edits for what the check found: a job whose `result.proposal_id` is ONE proposal to review. The page is
    not touched."""
    return jobs.to_dict(await fresh.start_suggest(session, page_id, by()))


# ---------------------------------------------------------------------------
# The space
# ---------------------------------------------------------------------------


async def _reader(session: AsyncSession, project_id: str) -> None:
    await svc_docs._project(session, project_id)  # noqa: SLF001
    await svc_settings.require_enabled(session, project_id)


@router.get("/projects/{project_id}/docs/ai/health")
async def get_health(project_id: str, session: Session) -> dict[str, Any]:
    """Docs health: out of date, missing docs, broken links and overlaps, with the counts."""
    await _reader(session, project_id)
    return await svc.get(session, project_id)


@router.get("/projects/{project_id}/docs/ai/health/count")
async def get_health_count(project_id: str, session: Session) -> dict[str, int]:
    """The number beside "Docs health" in the tree."""
    await _reader(session, project_id)
    return {"count": await svc.count(session, project_id)}


@router.post("/projects/{project_id}/docs/ai/health/run")
async def run_health(project_id: str, session: Session) -> dict[str, Any]:
    """Run now: recompute the lists and check the pages whose dependencies changed (people who can edit)."""
    await svc_docs._project(session, project_id, edit=True)  # noqa: SLF001
    out = await svc.run(session, project_id, by())
    await board_events.publish(board_events.INVALIDATE)
    return out


class HealthDismissBody(BaseModel):
    """Dismiss one row of Docs health."""

    kind: str
    id: str
    level: str


@router.post("/projects/{project_id}/docs/ai/health/dismiss")
async def dismiss_health(
    project_id: str, body: HealthDismissBody, session: Session
) -> dict[str, Any]:
    """Dismiss an item (`level`: once = until the next run, 30d or never)."""
    await svc_docs._project(session, project_id, edit=True)  # noqa: SLF001
    out = await svc.dismiss(session, project_id, body.kind, body.id, body.level, by())
    await board_events.publish(board_events.INVALIDATE)
    return out
