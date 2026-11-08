"""AI in every editor (AI v2): the /ai menu, the selection bar. A request is one assistant turn with the
`editor-write` skill; its result is held until the person accepts or discards it (`GET /ai/assist/drafts/{id}`)."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import Project
from services import activity as svc_activity
from services.assistant import editor as svc_editor
from services.assistant.errors import AssistError

router = APIRouter(tags=["ai-assistant"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


async def _project(session: AsyncSession, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise AssistError("not_found", "Project not found.")


class EditorBody(BaseModel):
    """One request from an editor: where it is, what to do, the text around the cursor and what to read besides."""

    surface: str
    action: str
    selection: str = ""
    before: str = ""
    after: str = ""
    prompt: str = ""
    language: str = ""
    ticket_id: Optional[str] = None
    doc_id: Optional[str] = None
    idea_id: Optional[str] = None
    include: dict[str, bool] = {}


@router.get("/projects/{project_id}/ai/editor/state")
async def get_editor_state(
    project_id: str,
    session: Session,
    surface: str = Query(...),
    ticket_id: Optional[str] = None,
    idea_id: Optional[str] = None,
) -> dict:
    """Whether the person may use AI in this editor, and the /ai menu and the selection bar for it."""
    await _project(session, project_id)
    return await svc_editor.state(session, project_id, surface)


@router.post("/projects/{project_id}/ai/editor/preview")
async def post_editor_preview(
    project_id: str, body: EditorBody, session: Session
) -> dict:
    """ "What will be sent": the pieces of this request. Sends nothing."""
    await _project(session, project_id)
    return svc_editor.preview(body.model_dump())


@router.post("/projects/{project_id}/ai/editor/drafts", status_code=201)
async def post_editor_draft(
    project_id: str, body: EditorBody, session: Session
) -> dict:
    """Ask for a draft. It is written in the background (poll `GET /ai/assist/drafts/{id}`); the text is not touched."""
    await _project(session, project_id)
    return await svc_editor.start(session, project_id, body.model_dump(), _by())


class AcceptBody(BaseModel):
    """What was accepted (a list of criteria can be trimmed or edited first)."""

    items: Optional[list[str]] = None


@router.post("/ai/editor/drafts/{draft_id}/accept")
async def post_editor_accept(
    draft_id: str, body: Optional[AcceptBody] = None
) -> dict[str, Any]:
    """Accept: the editor has put the text in; an accepted list of criteria is added to the ticket."""
    return await svc_editor.accept(draft_id, _by(), body.items if body else None)


@router.post("/ai/editor/drafts/{draft_id}/continue")
async def post_editor_continue(draft_id: str) -> dict:
    """Continue a draft: carry on from what it has."""
    return await svc_editor.again(draft_id, _by(), go_on=True)
