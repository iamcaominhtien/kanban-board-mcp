"""Docs AI API: what AI does with one page for people who read or edit it (docs-ai.md E and F).

Summarise, Explain and Translate are open to everyone who can read the page; Check this page and its fixes work on the
caller's draft, so fixing and ignoring need edit rights. Every endpoint starts a job (`docs_ai_job`) and returns it;
the UI polls `GET /docs/ai/jobs/{id}`. Nothing here changes a page.
"""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import DocsPage
from services import docs as svc_docs
from services.docs_ai import DocsAiError, access, check, diagram, engine, jobs, reader  # noqa: F401 - register the handlers
from services.docs_ai import settings as svc_settings

from .settings import by

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


async def gate(session: AsyncSession, page_id: str, *, edit: bool = False) -> DocsPage:
    """Everything that must hold before a page-level Docs AI call: the person may read (or edit) the page, Docs AI is
    on for the project, the page is not hidden from AI, and the AI member is ready (not paused, within budget)."""
    page = await svc_docs.get_page(session, page_id, edit=edit)
    await svc_settings.require_enabled(session, page.project_id)
    if not await access.ai_can_read(session, page):
        raise DocsAiError(
            "hidden",
            "This page is hidden from AI. Ask, summaries and AI runs skip it. People can still read and edit it.",
        )
    await engine.check_ready(page.project_id, await engine.resolve(page.project_id))
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
    """Summarise: the editor sends its draft; the reader sends nothing and gets the published text."""

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
    """Explain text selected on the page."""

    selection: str
    section: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/explain", status_code=202)
async def post_explain(
    page_id: str, body: ExplainBody, session: Session
) -> dict[str, Any]:
    """Explain a selection. Result: `{text, from: "Architecture › API", section, cost, metered}`. The selection must
    occur on the published page."""
    page = await gate(session, page_id)
    selection = body.selection.strip()
    if not selection or len(selection) > 4000:
        raise DocsAiError("invalid", "Select a passage (up to 4,000 characters) first.")
    _page, text = await reader.load_page(session, page_id)
    if not reader.selection_in_page(text, selection):
        raise DocsAiError("invalid", "That text is not on the published page.")
    return await launch(
        session,
        page,
        "explain",
        f"Explain: {selection[:200]}",
        selection=selection,
        section=body.section,
    )


class TranslateBody(BaseModel):
    """Translate view."""

    language: str
    section: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/translate", status_code=202)
async def post_translate(
    page_id: str, body: TranslateBody, session: Session
) -> dict[str, Any]:
    """The page translated as a view. Result: `{markdown, language, kept_original_blocks, cost, metered}`, plus
    `too_long: {read_sections, total_sections}` and `sections: [{slug, title}]` when only the first sections fit
    (send `section` to translate one of them)."""
    page = await gate(session, page_id)
    language = reader.check_language(body.language)
    return await launch(
        session,
        page,
        "translate",
        f"Translate into {language}",
        language=language,
        section=body.section,
    )


class CheckBody(BaseModel):
    """Check this page: the draft being edited, else the published text."""

    markdown: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/check", status_code=202)
async def post_check(
    page_id: str, session: Session, body: Optional[CheckBody] = None
) -> dict[str, Any]:
    """Read the page and the style guide page. Result: `{findings: [{id, kind: unclear|missing|unknown_link|style,
    quote, section, message, suggestion?}], style_page, ignored, cost, metered}`."""
    page = await gate(session, page_id)
    return await launch(
        session,
        page,
        "check",
        "Check this page",
        markdown=body.markdown if body else None,
    )


class FixBody(BaseModel):
    """Fix one finding against the current draft text."""

    markdown: Optional[str] = None
    job_id: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/check/{finding_id}/fix", status_code=202)
async def post_fix(
    page_id: str, finding_id: str, session: Session, body: Optional[FixBody] = None
) -> dict[str, Any]:
    """`{old, new}` for one finding (people who can edit the page). The editor applies it as a draft change."""
    page = await gate(session, page_id, edit=True)
    finding = await check.find_finding(
        session,
        page.project_id,
        page.id,
        finding_id,
        by(),
        body.job_id if body else None,
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
    """The finding to hide."""

    key: str


@router.post("/docs/pages/{page_id}/ai/check/ignore")
async def post_ignore(
    page_id: str, body: IgnoreBody, session: Session
) -> dict[str, Any]:
    """Hide a finding for this page (people who can edit it); later checks skip it."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    await svc_settings.require_enabled(session, page.project_id)
    await check.ignore(session, page.id, body.key, by())
    return {"ok": True, "key": body.key.strip()}


class DiagramBody(BaseModel):
    """Draw a diagram of a passage (or the page), or change a diagram the page shows (`diagram_id`)."""

    selection: Optional[str] = None
    instruction: Optional[str] = None
    diagram_id: Optional[str] = None
    label: Optional[str] = None
    markdown: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/diagram", status_code=202)
async def post_diagram(
    page_id: str, body: DiagramBody, session: Session
) -> dict[str, Any]:
    """Draw the selection (or the page) as an editable draw.io diagram, or change one. The page is not touched:
    result `{diagram_id, label, version, markdown, changed, cost, metered}`; put `markdown` in the draft."""
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
