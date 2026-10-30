"""AI help in the Sketch tool: ask about a drawing, brainstorm around it, or have shapes drawn on an AI layer. Errors carry
a `code` the editor maps to a state (viewer, AI off, over budget, no AI member...); `api.assist` turns them into
responses. The answer is written in the background: poll `GET /ai/assist/drafts/{id}`."""

import json
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services.ai.assist import drafts as svc_drafts
from services.ai.assist import sketch_ai as svc
from services.ai.assist.settings import AssistError

router = APIRouter(tags=["ai-sketch"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


@router.get("/ai/sketch/state")
async def get_sketch_ai_state(
    session: Session,
    owner_kind: str = Query(...),
    owner_id: str = Query(...),
    project_id: Optional[str] = None,
    sketch_id: Optional[str] = None,
) -> dict:
    """Whether the person may use AI in the sketch editor, who answers, the limits and what a request costs."""
    return await svc.state(
        session,
        {
            "owner_kind": owner_kind,
            "owner_id": owner_id,
            "project_id": project_id,
            "sketch_id": sketch_id,
        },
        _by(),
    )


class PreviewBody(BaseModel):
    """One request as the editor would send it, without the picture itself (only its size)."""

    owner_kind: str
    owner_id: str
    mode: str
    prompt: str = ""
    title: str = ""
    project_id: Optional[str] = None
    sketch_id: Optional[str] = None
    width: int = 1
    height: int = 1
    with_image: bool = True
    image_width: int = 0
    image_height: int = 0
    image_bytes: int = 0
    history: list[dict[str, Any]] = []


@router.post("/ai/sketch/preview")
async def post_sketch_ai_preview(body: PreviewBody, session: Session) -> dict:
    """ "What will be sent": the picture, the title, the question; what is never sent; the cost. Sends nothing."""
    return await svc.preview(session, body.model_dump(), _by())


@router.post("/ai/sketch/drafts", status_code=201)
async def post_sketch_ai_draft(
    session: Session,
    owner_kind: Annotated[str, Form()],
    owner_id: Annotated[str, Form()],
    mode: Annotated[str, Form()],
    width: Annotated[int, Form()],
    height: Annotated[int, Form()],
    prompt: Annotated[str, Form()] = "",
    title: Annotated[str, Form()] = "",
    project_id: Annotated[Optional[str], Form()] = None,
    sketch_id: Annotated[Optional[str], Form()] = None,
    history: Annotated[str, Form()] = "[]",
    image: Annotated[Optional[UploadFile], File()] = None,
) -> dict:
    """Ask (`mode` ask | ideas | draw). `image` is the flattened picture (PNG, 4 MB at most); `width` and `height` are the
    canvas size the shapes of `draw` are clamped to. Written in the background, so poll the draft."""
    data = None
    if image is not None:
        try:
            data = await image.read(svc.MAX_IMAGE_BYTES + 1)
        finally:
            await image.close()
    try:
        hist = json.loads(history or "[]")
    except ValueError as exc:
        raise AssistError(
            "invalid", "The earlier questions are not valid JSON."
        ) from exc
    d = await svc.start(
        session,
        {
            "owner_kind": owner_kind,
            "owner_id": owner_id,
            "mode": mode,
            "width": width,
            "height": height,
            "prompt": prompt,
            "title": title,
            "project_id": project_id,
            "sketch_id": sketch_id,
            "history": hist if isinstance(hist, list) else [],
        },
        data or None,
        _by(),
    )
    return svc_drafts.describe(d)


@router.post("/ai/sketch/drafts/{draft_id}/accept")
async def post_sketch_ai_accept(draft_id: str, session: Session) -> dict:
    """Accept: the editor already drew the shapes on the AI layer (one undoable step) or added the idea as a label; this
    records it in the audit log and closes the draft. Discard uses `POST /ai/assist/drafts/{id}/discard`."""
    return await svc.accept(session, draft_id, _by())
