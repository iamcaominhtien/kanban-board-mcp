"""Docs AI settings, per-page flags and the job list (Settings > Docs > AI; page info)."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import activity as svc_activity
from services import docs_access
from services.docs_ai import DocsAiError, jobs
from services.docs_ai import settings as svc

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def by() -> str:
    """The person making the request (X-Actor)."""
    return svc_activity.current_actor() or "user"


async def require_admin(session: AsyncSession, project_id: str) -> None:
    """Docs AI settings are for project admins (the board's own user counts as one)."""
    from models import Project

    project = await session.get(Project, project_id)
    if project is None:
        raise DocsAiError("not_found", "Project not found.")
    info = await docs_access.access_of(session, project)
    if not info["access"] or info["role"] != "admin":
        raise DocsAiError(
            "forbidden", "Only project admins can change Docs AI settings."
        )


class DocsAiBody(BaseModel):
    """Settings > Docs > AI."""

    enabled: Optional[bool] = None
    member_id: Optional[str] = None
    read_scope: Optional[str] = None
    picked_pages: Optional[list[str]] = None
    style_page_id: Optional[str] = None
    edits_mode: Optional[str] = None
    proposal_days: Optional[int] = None
    freshness_on: Optional[bool] = None
    guidance_limit: Optional[int] = None
    digest_on: Optional[bool] = None


@router.get("/projects/{project_id}/docs/ai")
async def get_docs_ai(project_id: str, session: Session) -> dict[str, Any]:
    """The switches, who answers and the state the Docs UI should show (`off`, `no_member` or `ready`)."""
    return await svc.describe(session, project_id)


@router.patch("/projects/{project_id}/docs/ai")
async def patch_docs_ai(
    project_id: str, body: DocsAiBody, session: Session
) -> dict[str, Any]:
    """Change the switches (project admins)."""
    await require_admin(session, project_id)
    await svc.update(session, project_id, body.model_dump(exclude_unset=True), by())
    await board_events.publish(board_events.INVALIDATE)
    return await svc.describe(session, project_id)


class PageFlagsBody(BaseModel):
    """Page info: hide from AI, use as AI guidance."""

    hidden: Optional[bool] = None
    guidance: Optional[bool] = None


@router.patch("/docs/pages/{page_id}/ai")
async def patch_page_flags(
    page_id: str, body: PageFlagsBody, session: Session
) -> dict[str, Any]:
    """Hide a page from AI and/or mark it as guidance every AI run reads (people who can edit the page)."""
    from services import docs as svc_docs

    await svc_docs.get_page(session, page_id, edit=True)
    page = await svc.set_page_flags(
        session, page_id, hidden=body.hidden, guidance=body.guidance
    )
    await board_events.publish(board_events.INVALIDATE)
    return {"id": page.id, "ai_hidden": page.ai_hidden, "ai_guidance": page.ai_guidance}


@router.get("/projects/{project_id}/docs/ai/jobs")
async def list_docs_ai_jobs(
    project_id: str,
    session: Session,
    page_id: Optional[str] = None,
    thread_id: Optional[str] = None,
    kind: Optional[str] = None,
    state: Optional[str] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[dict[str, Any]]:
    """Docs AI calls of the project, newest first (progress, pages read, cost)."""
    rows = await jobs.list_jobs(
        session,
        project_id,
        page_id=page_id,
        thread_id=thread_id,
        kind=kind,
        state=state,
        limit=limit,
    )
    return [jobs.to_dict(j) for j in rows]


@router.get("/docs/ai/jobs/{job_id}")
async def get_docs_ai_job(job_id: str, session: Session) -> dict[str, Any]:
    """One Docs AI call."""
    return jobs.to_dict(await jobs.get(session, job_id))


@router.post("/docs/ai/jobs/{job_id}/cancel")
async def cancel_docs_ai_job(job_id: str, session: Session) -> dict[str, Any]:
    """Stop a running Docs AI call."""
    return jobs.to_dict(await jobs.cancel(session, job_id, by()))
