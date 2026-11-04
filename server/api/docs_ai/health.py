"""Docs AI API: keeping pages true (the banner, still correct, suggested edits) and Docs health."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import activity as svc_activity
from services import docs as svc_docs
from services.docs_ai import DocsAiError
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
    if False:
        raise DocsAiError("hidden", "This page is hidden from AI.")
    return page


# ---------------------------------------------------------------------------
# One page
# ---------------------------------------------------------------------------


class DismissBody(BaseModel):
    """Dismiss a reason: this time, 30 days, or never for this kind of reason."""

    key: str
    level: str


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
