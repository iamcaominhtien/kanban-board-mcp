"""Docs AI API: what the assistant does with one page for people who read or edit it. Every endpoint starts a job
(`docs_ai_job`) and returns it; the UI polls `GET /docs/ai/jobs/{id}`."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import DocsPage
from services import docs as svc_docs
from services.assistant import docs as svc
from services.docs_ai import DocsAiError, jobs
from services.docs_ai import settings as svc_settings

from .settings import by

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


async def gate(session: AsyncSession, page_id: str, *, edit: bool = False) -> DocsPage:
    """The person may read (or edit) the page, Docs AI is on for the project, and an assistant can answer."""
    page = await svc_docs.get_page(session, page_id, edit=edit)
    await svc_settings.require_enabled(session, page.project_id)
    await svc.ready_or_raise(page.project_id)
    return page


async def launch(
    session: AsyncSession,
    page: DocsPage,
    kind: str,
    instruction: str = "",
    **inputs: Any,
) -> dict[str, Any]:
    """Create the job for a page and run it in the background."""
    job = await jobs.start(
        session,
        project_id=page.project_id,
        kind=kind,
        started_by=by(),
        page_id=page.id,
        instruction=instruction,
        result={"input": inputs},
    )
    return jobs.to_dict(job)


class SummaryBody(BaseModel):
    """The draft text to summarise instead of the published page (optional)."""

    markdown: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/summary", status_code=202)
async def post_summary(
    page_id: str, session: Session, body: Optional[SummaryBody] = None
) -> dict[str, Any]:
    """A short summary of the page, not saved anywhere. Result: `{text, title, cost, metered}`."""
    page = await gate(session, page_id)
    return await launch(
        session,
        page,
        "summary",
        "Summarise this page",
        markdown=body.markdown if body else None,
    )


class ExplainBody(BaseModel):
    """The selected passage to explain, and its section."""

    selection: str
    section: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/explain", status_code=202)
async def post_explain(
    page_id: str, body: ExplainBody, session: Session
) -> dict[str, Any]:
    """Explain a selection. Result: `{text, from, section, cost, metered}`."""
    page = await gate(session, page_id)
    selection = body.selection.strip()
    if not selection or len(selection) > 4000:
        raise DocsAiError("invalid", "Select a passage (up to 4,000 characters) first.")
    return await launch(
        session,
        page,
        "explain",
        f"Explain: {selection[:200]}",
        selection=selection,
        section=body.section,
    )


class TranslateBody(BaseModel):
    """The language to translate the page (or one section) into."""

    language: str
    section: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/translate", status_code=202)
async def post_translate(
    page_id: str, body: TranslateBody, session: Session
) -> dict[str, Any]:
    """The page translated as a view. Result: `{markdown, language, kept_original_blocks, cost, metered}`."""
    page = await gate(session, page_id)
    language = " ".join(body.language.split())[:40]
    if not language:
        raise DocsAiError("invalid", "Pick a language.")
    return await launch(
        session,
        page,
        "translate",
        f"Translate into {language}",
        language=language,
        section=body.section,
    )


class CheckBody(BaseModel):
    """The draft text to check instead of the published page (optional)."""

    markdown: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/check", status_code=202)
async def post_check(
    page_id: str, session: Session, body: Optional[CheckBody] = None
) -> dict[str, Any]:
    """Read the page and the style guide page. Result: `{findings: [{id, kind, quote, section, message,
    suggestion?}], style_page, ignored, cost, metered}`."""
    page = await gate(session, page_id)
    return await launch(
        session,
        page,
        "check",
        "Check this page",
        markdown=body.markdown if body else None,
    )


class FixBody(BaseModel):
    """The draft text the fix applies to, and the check job the finding came from."""

    markdown: Optional[str] = None
    job_id: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/check/{finding_id}/fix", status_code=202)
async def post_fix(
    page_id: str, finding_id: str, session: Session, body: Optional[FixBody] = None
) -> dict[str, Any]:
    """`{old, new}` for one finding (people who can edit the page). The editor applies it as a draft change."""
    page = await gate(session, page_id, edit=True)
    finding = await svc.find_finding(
        session, page.project_id, page.id, finding_id, body.job_id if body else None
    )
    return await launch(
        session,
        page,
        "check_fix",
        f"Fix: {finding.get('message', '')}"[:300],
        finding=finding,
        markdown=body.markdown if body else None,
    )


class IgnoreBody(BaseModel):
    """The finding to hide on this page."""

    key: str


@router.post("/docs/pages/{page_id}/ai/check/ignore")
async def post_ignore(
    page_id: str, body: IgnoreBody, session: Session
) -> dict[str, Any]:
    """Hide a finding for this page (people who can edit it); later checks skip it."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    await svc_settings.require_enabled(session, page.project_id)
    await svc.ignore(session, page.id, body.key, by())
    return {"ok": True, "key": body.key.strip()}


class DiagramBody(BaseModel):
    """What to draw: a selection or an instruction, or the diagram to change."""

    selection: Optional[str] = None
    instruction: Optional[str] = None
    diagram_id: Optional[str] = None
    label: Optional[str] = None
    markdown: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/diagram", status_code=202)
async def post_diagram(
    page_id: str, body: DiagramBody, session: Session
) -> dict[str, Any]:
    """Draw the selection (or the page) as an editable draw.io diagram, or change one. Result `{diagram_id, label,
    markdown, changed, cost, metered}`; put `markdown` in the draft."""
    page = await gate(session, page_id, edit=True)
    return await launch(
        session,
        page,
        "diagram",
        (body.instruction or "Draw a diagram")[:200],
        selection=body.selection,
        request=body.instruction,
        diagram_id=body.diagram_id,
        label=body.label,
        markdown=body.markdown,
    )
