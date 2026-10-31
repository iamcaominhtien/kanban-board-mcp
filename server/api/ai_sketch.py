"""AI help in the Sketch tool: one conversation per person and sketch, on the scoped-chat engine. The panel's state and
"What will be sent" live here, the chat itself is the generic `/ai/scopes/sketch/{id}` and `/ai/assist/chats/...` routes;
this file adds the one thing those cannot take: a message with the picture of the drawing and attached files (multipart).
Errors carry a `code` the editor maps to a state (viewer, AI off, over budget, no AI member...); `api.assist` turns them
into responses. The answer is written in the background: poll the chat."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services.ai.assist import attachments as svc_files
from services.ai.assist import chat as svc_chat
from services.ai.assist import sketch_ai as svc
from services.ai.assist import sketch_scope as svc_scope
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
    """Whether the person may use AI in the sketch editor, who answers, the limits and what a message costs."""
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
    """One message as the editor would send it, without the picture and files themselves (only their sizes)."""

    owner_kind: str
    owner_id: str
    prompt: str = ""
    title: str = ""
    project_id: Optional[str] = None
    sketch_id: Optional[str] = None
    chat_id: Optional[str] = None
    width: int = 1
    height: int = 1
    with_image: bool = True
    image_width: int = 0
    image_height: int = 0
    image_bytes: int = 0
    attachments: list[dict[str, Any]] = []


@router.post("/ai/sketch/preview")
async def post_sketch_ai_preview(body: PreviewBody, session: Session) -> dict:
    """ "What will be sent": the picture, the title, the question, the text of the place, the attachments; what is never
    sent; the cost. Sends nothing."""
    return await svc_scope.preview(session, body.model_dump(), _by())


async def _read(file: UploadFile, limit: int) -> bytes:
    try:
        return await file.read(limit + 1)
    finally:
        await file.close()


@router.post("/ai/sketch/chats/{chat_id}/messages")
async def post_sketch_ai_message(
    chat_id: str,
    session: Session,
    text: Annotated[str, Form()],
    width: Annotated[int, Form()],
    height: Annotated[int, Form()],
    title: Annotated[str, Form()] = "",
    with_image: Annotated[bool, Form()] = True,
    member_id: Annotated[Optional[str], Form()] = None,
    image: Annotated[Optional[UploadFile], File()] = None,
    files: Annotated[Optional[list[UploadFile]], File()] = None,
) -> dict:
    """Ask in the sketch chat. `image` is the flattened picture of the canvas as it is now (PNG, 4 MB at most; sent with
    every message); `files` are pictures (PNG, JPEG, WebP, GIF; 4, 5 MB each) and text files (200 KB each) the person
    attached; `width` and `height` are the canvas size the shapes of a drawing are clamped to. The answer is written in
    the background."""
    if len(text.strip()) > svc.MAX_PROMPT:
        raise AssistError(
            "invalid", f"Keep the message under {svc.MAX_PROMPT} characters."
        )
    if len(files or []) > svc_files.MAX_IMAGES + svc_files.MAX_TEXT_FILES:
        raise AssistError(
            "invalid",
            f"At most {svc_files.MAX_IMAGES + svc_files.MAX_TEXT_FILES} files can be attached to one message.",
        )
    picture = await _read(image, svc.MAX_IMAGE_BYTES) if image is not None else None
    incoming = [
        svc_files.Incoming(
            f.filename or "file", await _read(f, svc_files.MAX_IMAGE_BYTES)
        )
        for f in files or []
    ]
    return await svc_chat.send(
        session,
        chat_id,
        _by(),
        text,
        member_id=member_id,
        turn={
            "title": title,
            "width": width,
            "height": height,
            "with_image": with_image,
            "picture": picture or None,
            "files": incoming,
        },
    )


@router.get("/ai/sketch/chats/{chat_id}/files/{turn_id}/{file}")
async def get_sketch_ai_file(
    chat_id: str, turn_id: str, file: str, session: Session
) -> FileResponse:
    """A picture or file kept with the person's own chat (never served by `/uploads`; anyone else gets 404)."""
    path = await svc_scope.read_file(session, chat_id, turn_id, file, _by())
    mime = svc_scope.mime_of(file)
    return FileResponse(
        path,
        media_type=mime,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
        filename=None if mime.startswith("image/") else file,
        content_disposition_type="inline"
        if mime.startswith("image/")
        else "attachment",
    )


@router.post("/ai/sketch/drafts/{draft_id}/accept")
async def post_sketch_ai_accept(draft_id: str, session: Session) -> dict:
    """Accept: the editor already drew the shapes on the AI layer (one undoable step); this records it in the audit log
    and closes the proposal. Discard uses `POST /ai/assist/drafts/{id}/discard`."""
    return await svc.accept(session, draft_id, _by())


class IdeaBody(BaseModel):
    """Which idea of an answer was added as a label."""

    index: int


@router.post("/ai/sketch/drafts/{draft_id}/idea")
async def post_sketch_ai_idea(draft_id: str, body: IdeaBody, session: Session) -> dict:
    """The person added idea number `index` of the answer as a text label; the thread remembers it."""
    return await svc.idea_added(session, draft_id, _by(), body.index)
