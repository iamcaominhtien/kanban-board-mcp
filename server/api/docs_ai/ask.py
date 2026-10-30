"""Docs AI API: Ask the docs (design/screens/docs-ai.md, C).

`POST …/docs/ai/ask` starts a job (kind `ask`) and returns it; the UI polls `GET /docs/ai/jobs/{id}` and reads the
answer from its `result`. Ask is never automatic, and viewers may ask (it reads, it never writes).
"""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import Project
from services import docs as svc_docs
from services import docs_access
from services.docs_ai import DocsAiError, access, ask, engine, jobs  # noqa: F401 - registers the "ask" handler
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
    """Ask the docs. Result (when the job is finished): `{answer, verdict, citations, closest, conflicts, pages_read,
    pages_cited, index_updated_at, too_long}`; the cost is on the job. Fails with `docs_ai_off`, `no_member`,
    `paused` or `over_budget` before anything is sent."""
    project = await session.get(Project, project_id)
    if project is None:
        raise DocsAiError("not_found", "Project not found.")
    await docs_access.require_reader(session, project)
    await svc_settings.require_enabled(session, project_id)
    question = " ".join(body.question.split())
    if not question:
        raise DocsAiError("invalid", "Write a question first.")
    if len(question) > ask.MAX_QUESTION:
        raise DocsAiError(
            "invalid", f"Keep the question under {ask.MAX_QUESTION} characters."
        )
    if body.scope not in ask.SCOPES:
        raise DocsAiError("invalid", "Scope: this space, this page or all my projects.")
    page_id = None
    if body.scope == "page":
        page = await svc_docs.get_page(session, body.page_id or "")
        if page.project_id != project_id:
            raise DocsAiError("invalid", "That page is not in this space.")
        page_id = page.id
    await engine.check_ready(project_id, await engine.resolve(project_id))
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
    """ "Open as chat": a Board AI chat (this project, or this page) holding the question and the finished answer."""
    return {"chat_id": await ask.open_as_chat(session, job_id, by())}


class FeedbackBody(BaseModel):
    """ "Was this right?"."""

    rating: str
    reason: Optional[str] = None


@router.post("/docs/ai/ask/{job_id}/feedback")
async def post_feedback(
    job_id: str, body: FeedbackBody, session: Session
) -> dict[str, Any]:
    """Thumbs up or down on an answer, stored on the job result."""
    return await ask.feedback(session, job_id, by(), body.rating, body.reason or "")


class StaleBody(BaseModel):
    """ "Report as out of date"."""

    reason: str
    job_id: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/report-stale")
async def post_report_stale(
    page_id: str, body: StaleBody, session: Session
) -> dict[str, Any]:
    """Flag a page as possibly out of date (Docs health lists it). The page itself is not edited."""
    page = await svc_docs.get_page(session, page_id)
    return await ask.report_stale(session, page, by(), body.reason, body.job_id)
