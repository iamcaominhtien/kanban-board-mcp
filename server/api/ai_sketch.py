"""AI in the sketch editor (AI v2): a question about the drawing is one assistant turn with the `sketch-ask` skill
on the sketch's chat; the picture of the canvas and the attached files are saved for the turn and read by the
assistant. It answers in words and with ideas to add as labels; it does not draw shapes for the person."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import AiChat, Project
from services import activity as svc_activity
from services.ai import launch
from services.assistant import chat as svc_chat
from services.assistant import drafts as svc_drafts
from services.assistant import engine
from services.assistant import settings as svc_settings
from services.assistant.errors import AssistError

router = APIRouter(tags=["ai-assistant"])
Session = Annotated[AsyncSession, Depends(get_session)]

MAX_PROMPT = 2000
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TEXT_BYTES = 200 * 1024
MAX_IMAGES = 4
MAX_TEXT_FILES = 3
IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
NEVER_SENT = ["Other sketches, hidden layers' names and files outside the board"]


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
    """Whether the person may use AI in the sketch editor, and the limits of a message."""
    availability: dict[str, Any] = {"code": "ok"}
    if not await svc_settings.feature_on(session, "sketch"):
        availability = {
            "code": "feature_off",
            "message": "Sketch AI is off in Settings › AI.",
        }
    elif not project_id or await session.get(Project, project_id) is None:
        availability = {
            "code": "not_shared",
            "message": "Put the sketch in a project to ask the AI about it.",
        }
    else:
        info = await engine.ready(project_id)
        if info["state"] != "ready":
            availability = {"code": "not_configured", "message": info["message"]}
    return {
        "availability": availability,
        "member_id": None,
        "estimates": None,
        "limits": {
            "max_ops": 0,
            "max_points": 0,
            "max_text": 200,
            "max_prompt": MAX_PROMPT,
            "max_image_bytes": MAX_IMAGE_BYTES,
            "attachments": {
                "max_images": MAX_IMAGES,
                "max_image_bytes": MAX_FILE_BYTES,
                "max_text_files": MAX_TEXT_FILES,
                "max_text_bytes": MAX_TEXT_BYTES,
                "image_types": IMAGE_TYPES,
            },
        },
        "never_sent": NEVER_SENT,
    }


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
async def post_sketch_ai_preview(body: PreviewBody) -> dict:
    """ "What will be sent": the question, the picture, the attachments. Sends nothing."""
    pieces = []
    if body.prompt.strip():
        pieces.append(
            {
                "kind": "question",
                "label": "Your question",
                "chars": len(body.prompt),
                "tokens": len(body.prompt) // 4 + 1,
                "preview": body.prompt[:200],
            }
        )
    if body.title:
        pieces.append(
            {
                "kind": "title",
                "label": "The sketch's title",
                "chars": len(body.title),
                "tokens": len(body.title) // 4 + 1,
                "preview": body.title,
            }
        )
    if body.with_image and body.image_bytes:
        pieces.append(
            {
                "kind": "picture",
                "label": f"The drawing ({body.image_width}×{body.image_height})",
                "chars": 0,
                "tokens": 1500,
                "preview": "",
            }
        )
    for a in body.attachments:
        pieces.append(
            {
                "kind": "attachment",
                "label": str(a.get("name") or "file"),
                "chars": int(a.get("chars") or 0),
                "tokens": int(a.get("chars") or 0) // 4,
                "preview": "",
            }
        )
    return {
        "pieces": pieces,
        "tokens": sum(p["tokens"] for p in pieces),
        "estimate": None,
        "draw_estimate": None,
        "never_sent": NEVER_SENT,
        "injections": [],
    }


async def _read(file: UploadFile, limit: int, what: str) -> bytes:
    try:
        data = await file.read(limit + 1)
    finally:
        await file.close()
    if len(data) > limit:
        raise AssistError(
            "too_large", f"{what} is too large (at most {limit // 1024} KB)."
        )
    return data


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
    """Ask in the sketch chat. `image` is the flattened picture of the canvas as it is now; `files` are pictures and
    text files the person attached. The answer is written in the background."""
    if len(text.strip()) > MAX_PROMPT:
        raise AssistError("invalid", f"Keep the message under {MAX_PROMPT} characters.")
    if len(files or []) > MAX_IMAGES + MAX_TEXT_FILES:
        raise AssistError(
            "invalid",
            f"At most {MAX_IMAGES + MAX_TEXT_FILES} files can be attached to one message.",
        )
    saved: list[tuple[str, bytes]] = []
    if image is not None and with_image:
        saved.append(
            (
                "canvas.png",
                await _read(image, MAX_IMAGE_BYTES, "The picture of the drawing"),
            )
        )
    for f in files or []:
        saved.append(
            (
                f.filename or "file",
                await _read(f, MAX_FILE_BYTES, f.filename or "A file"),
            )
        )
    return await svc_chat.send(
        session,
        chat_id,
        _by(),
        text,
        files=saved,
        skill="sketch-ask",
        extra={"title": title, "canvas": {"w": width, "h": height, "title": title}},
    )


@router.get("/ai/sketch/chats/{chat_id}/files/{turn_id}/{file}")
async def get_sketch_ai_file(
    chat_id: str, turn_id: str, file: str, session: Session
) -> FileResponse:
    """A picture or file kept with the person's own chat turn (anyone else gets 404)."""
    from pathlib import Path

    from models import AiRun

    chat = await session.get(AiChat, chat_id)
    run = await session.get(AiRun, turn_id)
    if (
        chat is None
        or chat.owner != _by()
        or run is None
        or run.target != f"chat:{chat_id}"
    ):
        raise AssistError("not_found", "File not found.")
    path = launch.run_dir(turn_id) / Path(file).name
    if not path.is_file() or path.suffix.lower() in (".md", ".log", ".json"):
        raise AssistError("not_found", "File not found.")
    image = path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".gif")
    return FileResponse(
        path,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
        filename=None if image else path.name,
        content_disposition_type="inline" if image else "attachment",
    )


@router.post("/ai/sketch/drafts/{draft_id}/accept")
async def post_sketch_ai_accept(draft_id: str) -> dict:
    """Close the proposal of an answer (the assistant no longer draws shapes; there is nothing to place)."""
    draft = svc_drafts.get(draft_id)
    if draft["status"] == "open":
        draft["status"], draft["applied_by"] = "applied", _by()
    return draft


class IdeaBody(BaseModel):
    """Which idea of an answer was added as a label."""

    index: int


@router.post("/ai/sketch/drafts/{draft_id}/idea")
async def post_sketch_ai_idea(draft_id: str, body: IdeaBody) -> dict:
    """The person added idea number `index` of the answer as a text label; the proposal remembers it."""
    draft = svc_drafts.get(draft_id)
    result = draft["payload"].get("result") or {}
    if not 0 <= body.index < len(result.get("ideas") or []):
        raise AssistError("invalid", "That idea is not in the answer.")
    result["added"] = sorted({*(result.get("added") or []), body.index})
    return draft
