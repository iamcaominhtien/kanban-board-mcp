"""Docs AI API: write a page with AI, tidy on import, history and publishing helpers (docs-ai.md D, docs-ai-care.md D)."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services.docs_ai import history, jobs, tidy, write  # noqa: F401  (importing registers the job handlers)

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


class WriteSource(BaseModel):
    """What the page is written from."""

    kind: str
    ticket_id: Optional[str] = None
    idea_id: Optional[str] = None
    text: Optional[str] = None


class WriteInclude(BaseModel):
    """ "Also read": code changes stay off unless asked for."""

    comments: bool = True
    linked_pages: bool = True
    code_changes: bool = False


class WritePreviewBody(BaseModel):
    """Body of "What will be sent"."""

    source: WriteSource
    page_kind: Optional[str] = None
    include: WriteInclude = Field(default_factory=WriteInclude)
    title: Optional[str] = None


class WriteBody(WritePreviewBody):
    """Body of Write draft."""

    parent_id: Optional[str] = None


@router.post("/projects/{project_id}/docs/ai/write/preview")
async def write_preview(
    project_id: str, body: WritePreviewBody, session: Session
) -> dict[str, Any]:
    """ "What will be sent": the list, approximate tokens and cost, and the pages left out (hidden from AI)."""
    return await write.preview(session, project_id, body.model_dump())


@router.post("/projects/{project_id}/docs/ai/write")
async def write_page(
    project_id: str, body: WriteBody, session: Session
) -> dict[str, Any]:
    """Write a page from the picked sources: a `write` job. Its result is `{page_id, gaps, sources, cost}`; the text
    is the caller's private draft of a new, unpublished page."""
    job = await write.start(session, project_id, body.model_dump(), _by())
    return jobs.to_dict(job)


@router.get("/docs/pages/{page_id}/ai/markers")
async def page_markers(page_id: str, session: Session) -> dict[str, Any]:
    """The Needs input markers still in your draft (checked before publishing; publishing stays possible)."""
    return await write.markers_of_draft(session, page_id)


@router.post("/docs/pages/{page_id}/ai/accepted")
async def page_accepted(page_id: str, session: Session) -> dict[str, Any]:
    """The editor accepted AI text: mark your draft so History shows "with AI" once it is published."""
    return await write.mark_accepted(session, page_id)


class HistorySummaryBody(BaseModel):
    """A range of versions."""

    from_version: int
    to_version: int


@router.post("/docs/pages/{page_id}/ai/history-summary")
async def history_summary(
    page_id: str, body: HistorySummaryBody, session: Session
) -> dict[str, Any]:
    """ "What changed since v12": a `history_summary` job over the versions after `from_version` up to `to_version`."""
    job = await history.start_history_summary(
        session, page_id, body.from_version, body.to_version, _by()
    )
    return jobs.to_dict(job)


class PublishNoteBody(BaseModel):
    """The text to write a note for; your draft when left out."""

    markdown: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/publish-note")
async def publish_note(
    page_id: str, body: PublishNoteBody, session: Session
) -> dict[str, Any]:
    """A suggested change note from the draft-versus-published diff: a `publish_note` job (`result.note`)."""
    job = await history.start_publish_note(session, page_id, body.markdown, _by())
    return jobs.to_dict(job)


@router.post("/projects/{project_id}/docs/ai/since-viewed")
async def since_viewed(project_id: str, session: Session) -> dict[str, Any]:
    """ "Changes since you last viewed": a `since_viewed` job, one line per page, summary only."""
    job = await history.start_since_viewed(session, project_id, _by())
    return jobs.to_dict(job)


class TidyOptions(BaseModel):
    """Tidy while importing."""

    split_by_heading: bool = False
    ticket_chips: bool = False
    see_links: bool = False
    heading_levels: bool = False


class TidyBody(BaseModel):
    """A Markdown file and the tidy options; nothing is imported by this call."""

    markdown: str
    filename: str = "import.md"
    options: TidyOptions = Field(default_factory=TidyOptions)
    accept_see_links: list[str] = Field(default_factory=list)


@router.post("/projects/{project_id}/docs/ai/tidy")
async def tidy_import(
    project_id: str, body: TidyBody, session: Session
) -> dict[str, Any]:
    """Preview a tidy import: the pages and what changed in each. "see X" links are candidates for review: they are
    only added to the text when their ids are in `accept_see_links`. Import the result with the import endpoint."""
    return await tidy.tidy(
        session,
        project_id,
        body.markdown,
        body.options.model_dump(),
        filename=body.filename,
        accept_see_links=body.accept_see_links,
    )
