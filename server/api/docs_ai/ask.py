"""Docs AI API: Ask the docs. `POST …/docs/ai/ask` starts a job (kind `ask`); the UI polls `GET /docs/ai/jobs/{id}`.
The answer is written by the Docs assistant (services/assistant) with the `docs-ask` skill."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import Project
from services import docs as svc_docs
from services import docs_access
from services.assistant import docs as svc
from services.docs_ai import DocsAiError, jobs
from services.docs_ai import settings as svc_settings

from .settings import by

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


class AskBody(BaseModel):
    """A question for the docs."""

    question: str
    scope: str = "space"
    page_id: Optional[str] = None


@router.post("/projects/{project_id}/docs/ai/ask", status_code=202)
async def post_ask(project_id: str, body: AskBody, session: Session) -> dict[str, Any]:
    """Ask the docs. Result (when the job is finished): `{answer, verdict, citations, pages_read, pages_cited}`."""
    project = await session.get(Project, project_id)
    if project is None:
        raise DocsAiError("not_found", "Project not found.")
    await docs_access.require_reader(session, project)
    await svc_settings.require_enabled(session, project_id)
    question = " ".join(body.question.split())
    if not question:
        raise DocsAiError("invalid", "Write a question first.")
    if len(question) > svc.MAX_QUESTION:
        raise DocsAiError(
            "invalid", f"Keep the question under {svc.MAX_QUESTION} characters."
        )
    if body.scope not in svc.SCOPES:
        raise DocsAiError("invalid", "Scope: this space, this page or all my projects.")
    page_id = None
    if body.scope == "page":
        page = await svc_docs.get_page(session, body.page_id or "")
        if page.project_id != project_id:
            raise DocsAiError("invalid", "That page is not in this space.")
        page_id = page.id
    await svc.ready_or_raise(project_id)
    job = await jobs.start(
        session,
        project_id=project_id,
        kind="ask",
        started_by=by(),
        page_id=page_id,
        instruction=question,
        result={"question": question, "scope": body.scope, "page_id": page_id},
    )
    return jobs.to_dict(job)


@router.post("/docs/ai/ask/{job_id}/chat", status_code=201)
async def post_open_as_chat(job_id: str, session: Session) -> dict[str, str]:
    """ "Open as chat": a Board AI chat holding the question and the finished answer."""
    return {"chat_id": await svc.open_as_chat(session, job_id, by())}


class FeedbackBody(BaseModel):
    """ "Was this right?"."""

    rating: str
    reason: Optional[str] = None


@router.post("/docs/ai/ask/{job_id}/feedback")
async def post_feedback(
    job_id: str, body: FeedbackBody, session: Session
) -> dict[str, Any]:
    """Thumbs up or down on an answer, stored on the job result."""
    return await svc.feedback(session, job_id, by(), body.rating, body.reason or "")


class StaleBody(BaseModel):
    """ "Report as out of date"."""

    reason: str
    job_id: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/report-stale")
async def post_report_stale(
    page_id: str, body: StaleBody, session: Session
) -> dict[str, Any]:
    """Flag a page as possibly out of date: a freshness check of the page starts."""
    page = await svc_docs.get_page(session, page_id)
    await svc_settings.require_enabled(session, page.project_id)
    job = await jobs.start(
        session,
        project_id=page.project_id,
        kind="freshness",
        started_by=by(),
        page_id=page.id,
        instruction=f"Reported: {body.reason}"[:300],
    )
    return {"ok": True, "job_id": job.id}
