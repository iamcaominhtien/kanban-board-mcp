"""AI in every editor (design/screens/ai-where-you-work.md, D): what the editor may offer, "What will be sent", the
draft and its acceptance. Errors carry a `code` the editor maps to a state (viewer, AI off, over budget, no AI
member, conflict…); `api.assist` turns them into responses."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import Project
from services import activity as svc_activity
from services.ai.assist import drafts as svc_drafts
from services.ai.assist import editor as svc_editor
from services.ai.assist.settings import AssistError

router = APIRouter(tags=["ai-editor"])
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
    # "This ticket / This page / Selected text" chips: {"ticket": bool, "page": bool, "selection": bool}
    include: dict[str, bool] = {}


@router.get("/projects/{project_id}/ai/editor/state")
async def get_editor_state(
    project_id: str,
    session: Session,
    surface: str = Query(...),
    ticket_id: Optional[str] = None,
    idea_id: Optional[str] = None,
) -> dict:
    """Whether the person may use AI in this editor, the /ai menu and the selection bar for it, and the cost."""
    await _project(session, project_id)
    return await svc_editor.state(
        session, project_id, surface, _by(), ticket_id, idea_id
    )


@router.post("/projects/{project_id}/ai/editor/preview")
async def post_editor_preview(
    project_id: str, body: EditorBody, session: Session
) -> dict:
    """ "What will be sent": the list of what the model would read for this request. Sends nothing."""
    await _project(session, project_id)
    return await svc_editor.preview(session, project_id, body.model_dump(), _by())


@router.post("/projects/{project_id}/ai/editor/drafts", status_code=201)
async def post_editor_draft(
    project_id: str, body: EditorBody, session: Session
) -> dict:
    """Ask for a draft. It is written in the background (poll `GET /ai/assist/drafts/{id}`); the text is not touched."""
    await _project(session, project_id)
    d = await svc_editor.start(session, project_id, body.model_dump(), _by())
    return svc_drafts.describe(d)


class AcceptBody(BaseModel):
    """What was accepted (a list of criteria can be trimmed or edited first)."""

    items: Optional[list[str]] = None


@router.post("/ai/editor/drafts/{draft_id}/accept")
async def post_editor_accept(
    draft_id: str, session: Session, body: Optional[AcceptBody] = None
) -> dict[str, Any]:
    """Accept (Tab): the editor has put the text in; this records "edited with AI by <person>" in Activity and in the
    audit log, and adds an accepted list of criteria to the ticket."""
    return await svc_editor.accept(
        session, draft_id, _by(), body.model_dump(exclude_none=True) if body else None
    )


@router.post("/ai/editor/drafts/{draft_id}/continue")
async def post_editor_continue(draft_id: str, session: Session) -> dict:
    """Continue a draft that was cut short at the length limit; what it had is kept."""
    d = await svc_editor.continue_draft(session, draft_id, _by())
    return svc_drafts.describe(d)
