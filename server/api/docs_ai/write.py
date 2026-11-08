"""Docs AI API: write a page with the assistant, tidy on import, history and publishing helpers."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services import docs as svc_docs
from services.assistant import docs as svc
from services.docs_ai import DocsAiError, jobs, tidy
from services.docs_ai import settings as svc_settings

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


class WriteSource(BaseModel):
    """Where a page is written from: a ticket, an idea, notes or a prompt."""

    kind: str
    ticket_id: Optional[str] = None
    idea_id: Optional[str] = None
    text: Optional[str] = None


class WriteInclude(BaseModel):
    """What the assistant may read besides the source."""

    comments: bool = True
    linked_pages: bool = True
    code_changes: bool = False


class WritePreviewBody(BaseModel):
    """The sources picked in the Write dialog."""

    source: WriteSource
    page_kind: Optional[str] = None
    include: WriteInclude = Field(default_factory=WriteInclude)
    title: Optional[str] = None


class WriteBody(WritePreviewBody):
    """The sources picked in the Write dialog, and where the page goes."""

    parent_id: Optional[str] = None


@router.post("/projects/{project_id}/docs/ai/write/preview")
async def write_preview(
    project_id: str, body: WritePreviewBody, session: Session
) -> dict[str, Any]:
    """ "What will be sent": what the assistant starts reading from."""
    return await svc.write_preview(session, project_id, body.model_dump())


@router.post("/projects/{project_id}/docs/ai/write")
async def write_page(
    project_id: str, body: WriteBody, session: Session
) -> dict[str, Any]:
    """Write a page from the picked sources: a `write` job. Its result is `{page_id, title, gaps, sources, cost}`."""
    job = await svc.start_write(session, project_id, body.model_dump(), _by())
    return jobs.to_dict(job)


@router.get("/docs/pages/{page_id}/ai/markers")
async def page_markers(page_id: str, session: Session) -> dict[str, Any]:
    """The Needs input markers still in the page (checked before publishing; publishing stays possible)."""
    return await svc.markers_of(session, page_id)


@router.post("/docs/pages/{page_id}/ai/accepted")
async def page_accepted(page_id: str, session: Session) -> dict[str, Any]:
    """The editor accepted AI text."""
    await svc_docs.get_page(session, page_id, edit=True)
    return {"ok": True}


async def _page_job(
    session: AsyncSession, page_id: str, kind: str, instruction: str, **inputs: Any
) -> dict[str, Any]:
    page = await svc_docs.get_page(session, page_id)
    await svc_settings.require_enabled(session, page.project_id)
    await svc.ready_or_raise(page.project_id)
    job = await jobs.start(
        session,
        project_id=page.project_id,
        kind=kind,
        started_by=_by(),
        page_id=page.id,
        instruction=instruction,
        result={"input": inputs},
    )
    return jobs.to_dict(job)


class HistorySummaryBody(BaseModel):
    """The two versions to compare."""

    from_version: int
    to_version: int


@router.post("/docs/pages/{page_id}/ai/history-summary")
async def history_summary(
    page_id: str, body: HistorySummaryBody, session: Session
) -> dict[str, Any]:
    """ "What changed since v12": a `history_summary` job."""
    if body.to_version <= body.from_version:
        raise DocsAiError("invalid", "Pick a later version to compare with.")
    return await _page_job(
        session,
        page_id,
        "history_summary",
        f"What changed v{body.from_version} → v{body.to_version}",
        from_version=body.from_version,
        to_version=body.to_version,
    )


class PublishNoteBody(BaseModel):
    """The draft text about to be published (optional)."""

    markdown: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/publish-note")
async def publish_note(
    page_id: str, body: PublishNoteBody, session: Session
) -> dict[str, Any]:
    """A suggested change note for publishing: a `publish_note` job (`result.note`)."""
    return await _page_job(
        session,
        page_id,
        "publish_note",
        "Suggest a change note",
        markdown=body.markdown,
    )


@router.post("/projects/{project_id}/docs/ai/since-viewed")
async def since_viewed(project_id: str, session: Session) -> dict[str, Any]:
    """ "Changes since you last viewed": a `since_viewed` job, one line per page."""
    await svc_settings.require_enabled(session, project_id)
    await svc.ready_or_raise(project_id)
    job = await jobs.start(
        session,
        project_id=project_id,
        kind="since_viewed",
        started_by=_by(),
        instruction="Changes since you last viewed",
    )
    return jobs.to_dict(job)


class TidyOptions(BaseModel):
    """What a tidy import may change."""

    split_by_heading: bool = False
    ticket_chips: bool = False
    see_links: bool = False
    heading_levels: bool = False


class TidyBody(BaseModel):
    """The Markdown to import and what to tidy in it."""

    markdown: str
    filename: str = "import.md"
    options: TidyOptions = Field(default_factory=TidyOptions)
    accept_see_links: list[str] = Field(default_factory=list)


@router.post("/projects/{project_id}/docs/ai/tidy")
async def tidy_import(
    project_id: str, body: TidyBody, session: Session
) -> dict[str, Any]:
    """Preview a tidy import (no model): the pages and what changed in each."""
    return await tidy.tidy(
        session,
        project_id,
        body.markdown,
        body.options.model_dump(),
        filename=body.filename,
        accept_see_links=body.accept_see_links,
    )
