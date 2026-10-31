"""Canvas API: boards, notes, arrows and labels on one large plane, with versions, comments and AI proposals.

Writes that carry files are multipart; the plane itself (layout) is JSON and merges per item. Errors use the Docs
error shape ``{detail: {code, message, ...}}``. The files of a frame are served with a strict policy (no scripts, no
outside requests, sandboxed), so a frame opened on its own is as locked as inside the editor.
"""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import activity as svc_activity
from services import canvas_comments as comments
from services import canvas_proposals as proposals
from services import canvases as svc
from services.docs_ai import DocsAiError, access, engine, jobs
from services.docs_ai import settings as ai_settings
from services.docs_text import DocsError

router = APIRouter(tags=["canvases"])
Session = Annotated[AsyncSession, Depends(get_session)]

# What a frame's files may do when opened by themselves: nothing but draw. The editor adds `sandbox` on the iframe too.
FRAME_CSP = (
    "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
    "media-src 'self' data:; form-action 'none'; base-uri 'none'; sandbox"
)
_FRAME_HEADERS = {
    "Content-Security-Policy": FRAME_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": "*",  # a sandboxed frame has an opaque origin; fonts need this
    "Cache-Control": "private, max-age=31536000, immutable",
}


async def _bytes(file: UploadFile) -> bytes:
    """Read an upload, stopping a byte past the largest possible canvas so a huge file is refused cheaply."""
    try:
        return await file.read(svc.MAX_CANVAS_BYTES + 1)
    finally:
        await file.close()


async def _files(
    uploads: list[UploadFile], paths: list[str] | None
) -> dict[str, bytes]:
    """``{path: bytes}`` of uploaded files; ``paths`` (same order) override the file names (folders)."""
    out: dict[str, bytes] = {}
    for i, f in enumerate(uploads):
        name = (
            paths[i] if paths and i < len(paths) and paths[i] else f.filename
        ) or f"file{i}"
        out[name] = await _bytes(f)
    return out


async def _changed() -> None:
    await board_events.publish("invalidate")


# --- canvases ---------------------------------------------------------------------------------------------------


@router.get("/canvases")
async def get_canvases(
    owner_kind: str, owner_id: str, session: Session
) -> list[dict[str, Any]]:
    """List the canvases of one page, ticket, idea or comment's ticket."""
    return await svc.list_canvases(session, owner_kind, owner_id)


class NewCanvas(BaseModel):
    """A new canvas."""

    owner_kind: str
    owner_id: str
    title: Optional[str] = None
    project_id: Optional[str] = None
    start: str = "blank"  # blank | none
    size: str = "desktop"


@router.post("/canvases", status_code=201)
async def post_canvas(body: NewCanvas, session: Session) -> dict[str, Any]:
    """Create a canvas for a ticket, comment, Docs page or idea (one empty frame, or none for "from files")."""
    out = await svc.create_canvas(
        session,
        owner_kind=body.owner_kind,
        owner_id=body.owner_id,
        title=body.title,
        project_id=body.project_id,
        start=body.start,
        size=body.size if body.size in svc.SIZE_PRESETS else "desktop",
    )
    await _changed()
    return out


class NewCanvasPage(BaseModel):
    """Docs › New page › Canvas."""

    project_id: str
    title: str = "Canvas"
    parent_id: Optional[str] = None


@router.post("/canvases/pages", status_code=201)
async def post_canvas_page(body: NewCanvasPage, session: Session) -> dict[str, Any]:
    """A Docs page of kind `canvas` with its canvas."""
    out = await svc.create_docs_canvas(
        session, body.project_id, body.title, parent_id=body.parent_id
    )
    await _changed()
    return out


@router.get("/canvases/{canvas_id}")
async def get_canvas(canvas_id: str, session: Session) -> dict[str, Any]:
    """The canvas with its file, locks and counts."""
    return await svc.get_canvas(session, canvas_id)


class Upsert(BaseModel):
    """Layout changes merged per item."""

    base_rev: int
    upsert: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    remove: list[str] = Field(default_factory=list)
    title: Optional[str] = None
    force: bool = False
    checkpoint: bool = False
    name: Optional[str] = None
    note: Optional[str] = None


@router.patch("/canvases/{canvas_id}")
async def patch_canvas(
    canvas_id: str, body: Upsert, session: Session
) -> dict[str, Any]:
    """Save layout changes (moves, notes, arrows, labels, tabs). 409 `canvas_conflict` names the items both changed."""
    out = await svc.save(
        session,
        canvas_id,
        base_rev=body.base_rev,
        upsert=body.upsert,
        remove=body.remove,
        title=body.title,
        force=body.force,
        checkpoint=body.checkpoint,
        name=body.name,
        note=body.note,
    )
    await _changed()
    return out


@router.delete("/canvases/{canvas_id}")
async def del_canvas(canvas_id: str, session: Session) -> dict[str, Any]:
    """Unlink a canvas. The row and files are kept and it can be restored."""
    out = await svc.delete_canvas(session, canvas_id)
    await _changed()
    return out


@router.post("/canvases/{canvas_id}/restore")
async def post_restore_canvas(canvas_id: str, session: Session) -> dict[str, Any]:
    """Bring an unlinked canvas back."""
    out = await svc.restore_canvas(session, canvas_id)
    await _changed()
    return out


class MoveBody(BaseModel):
    """Move to Docs."""

    title: Optional[str] = None
    parent_id: Optional[str] = None


@router.post("/canvases/{canvas_id}/move-to-docs")
async def post_move_to_docs(
    canvas_id: str, body: MoveBody, session: Session
) -> dict[str, Any]:
    """Give an inline canvas its own Docs page; the text it came from keeps showing it."""
    out = await svc.move_to_docs(session, canvas_id, body.title, body.parent_id)
    await _changed()
    return out


@router.post("/canvases/{canvas_id}/copy", status_code=201)
async def post_copy(
    canvas_id: str, session: Session, title: Optional[str] = None
) -> dict[str, Any]:
    """Save a copy: a second canvas with the same frames, notes and arrows (comments and history stay behind)."""
    out = await svc.copy_canvas(session, canvas_id, title)
    await _changed()
    return out


# --- frames -----------------------------------------------------------------------------------------------------


@router.post("/canvases/{canvas_id}/boards", status_code=201)
async def post_board(
    canvas_id: str,
    session: Session,
    kind: Annotated[str, Form()] = "empty",
    name: Annotated[Optional[str], Form()] = None,
    page: Annotated[Optional[str], Form()] = None,
    ref: Annotated[Optional[str], Form()] = None,
    size: Annotated[Optional[str], Form()] = None,
    entry: Annotated[Optional[str], Form()] = None,
    x: Annotated[Optional[float], Form()] = None,
    y: Annotated[Optional[float], Form()] = None,
    files: Annotated[Optional[list[UploadFile]], File()] = None,
    paths: Annotated[Optional[list[str]], Form()] = None,
) -> dict[str, Any]:
    """Add a frame: an HTML page (files), a picture, a Sketch or Diagram (`ref`), or an empty one."""
    out = await svc.add_board(
        session,
        canvas_id,
        name=name,
        kind=kind,
        page=page,
        files=await _files(files, paths) if files else None,
        entry=entry,
        ref=ref,
        size=size if size in svc.SIZE_PRESETS else None,
        x=x,
        y=y,
    )
    await _changed()
    return out


@router.post("/canvases/{canvas_id}/import", status_code=201)
async def post_import(
    canvas_id: str,
    session: Session,
    files: Annotated[list[UploadFile], File()],
    page: Annotated[Optional[str], Form()] = None,
) -> dict[str, Any]:
    """Each file becomes a frame: HTML files, pictures, or a ZIP of a built page."""
    uploads = [(f.filename or "file", await _bytes(f)) for f in files]
    out = await svc.import_files(session, canvas_id, uploads, page=page)
    await _changed()
    return out


@router.post("/canvases/{canvas_id}/boards/{board_id}/duplicate", status_code=201)
async def post_duplicate(
    canvas_id: str, board_id: str, session: Session
) -> dict[str, Any]:
    """Copy a frame next to the original."""
    out = await svc.duplicate_board(session, canvas_id, board_id)
    await _changed()
    return out


@router.get("/canvases/{canvas_id}/boards/{board_id}/source")
async def get_source(canvas_id: str, board_id: str, session: Session) -> dict[str, Any]:
    """The text files of an HTML frame (for the source editor)."""
    return await svc.board_source(session, canvas_id, board_id)


class SourceFile(BaseModel):
    """One text file of a frame."""

    path: str
    text: str


class ContentBody(BaseModel):
    """The new source of a frame."""

    files: list[SourceFile]
    entry: Optional[str] = None
    base_content_rev: Optional[int] = None
    release: bool = True


@router.put("/canvases/{canvas_id}/boards/{board_id}/content")
async def put_content(
    canvas_id: str, board_id: str, body: ContentBody, session: Session
) -> dict[str, Any]:
    """Save a frame's source (the person editing holds the lock). 423 `board_locked` if somebody else does."""
    files = {f.path: f.text.encode("utf-8") for f in body.files}
    out = await svc.put_board_content(
        session,
        canvas_id,
        board_id,
        files={**await svc.board_binary_files(session, canvas_id, board_id), **files},
        entry=body.entry,
        base_content_rev=body.base_content_rev,
        release=body.release,
    )
    await _changed()
    return out


@router.post("/canvases/{canvas_id}/boards/{board_id}/replace")
async def post_replace(
    canvas_id: str,
    board_id: str,
    session: Session,
    files: Annotated[list[UploadFile], File()],
    paths: Annotated[Optional[list[str]], Form()] = None,
    entry: Annotated[Optional[str], Form()] = None,
) -> dict[str, Any]:
    """Replace a frame's content with uploaded files (an HTML file, several files, or a ZIP)."""
    data = await _files(files, paths)
    if len(data) == 1:
        ((name, blob),) = data.items()
        if name.lower().endswith(".zip"):
            data = svc._strip_common_root(svc._unzip(blob))  # noqa: SLF001
        elif name.lower().endswith((".html", ".htm")):
            data = {"index.html": blob}
    out = await svc.put_board_content(
        session, canvas_id, board_id, files=data, entry=entry
    )
    await _changed()
    return out


@router.post("/canvases/{canvas_id}/boards/{board_id}/lock")
async def post_lock(canvas_id: str, board_id: str, session: Session) -> dict[str, Any]:
    """Take the lock on a frame (423 `board_locked` if somebody else has it)."""
    out = await svc.lock_board(session, canvas_id, board_id)
    await _changed()
    return out


@router.post("/canvases/{canvas_id}/boards/{board_id}/heartbeat")
async def post_heartbeat(
    canvas_id: str, board_id: str, session: Session
) -> dict[str, Any]:
    """Still editing."""
    return await svc.heartbeat_board(session, canvas_id, board_id)


@router.delete("/canvases/{canvas_id}/boards/{board_id}/lock")
async def del_lock(canvas_id: str, board_id: str, session: Session) -> dict[str, Any]:
    """Let go of the lock."""
    out = await svc.unlock_board(session, canvas_id, board_id)
    await _changed()
    return out


@router.get("/canvases/{canvas_id}/boards/{board_id}/r/{rev}/{path:path}")
async def get_board_file(
    canvas_id: str, board_id: str, rev: int, path: str, session: Session
) -> Response:
    """A file of a frame at one revision, with a policy that lets it draw and nothing else."""
    data, media = await svc.read_board_file(session, canvas_id, board_id, rev, path)
    return Response(
        data,
        media_type=media.split(";")[0],
        headers={**_FRAME_HEADERS, "Content-Type": media},
    )


@router.get("/canvases/{canvas_id}/boards/{board_id}/snapshot.png")
async def get_snapshot(
    canvas_id: str, board_id: str, session: Session, rev: Optional[int] = None
) -> Response:
    """A wireframe picture of an HTML or empty frame (drawn below 40% zoom)."""
    png = await svc.board_snapshot(session, canvas_id, board_id, rev)
    return Response(
        png, media_type="image/png", headers={"Cache-Control": "private, max-age=300"}
    )


@router.get("/canvases/{canvas_id}/overview.png")
async def get_overview(
    canvas_id: str, session: Session, page: Optional[str] = None
) -> Response:
    """A wireframe picture of one page tab: what an export writes where the canvas stood."""
    png = await svc.overview_png(session, canvas_id, page)
    return Response(
        png,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=0, must-revalidate"},
    )


@router.get("/canvases/{canvas_id}/download")
async def get_download(
    canvas_id: str,
    session: Session,
    board_id: Optional[str] = None,
    version: Optional[int] = None,
) -> Response:
    """A ZIP of every frame (with `canvas.json`), or of one frame."""
    data, name = await svc.export_zip(session, canvas_id, board_id, version)
    return Response(
        data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


# --- versions ---------------------------------------------------------------------------------------------------


@router.get("/canvases/{canvas_id}/versions")
async def get_versions(canvas_id: str, session: Session) -> list[dict[str, Any]]:
    """Versions, newest first."""
    return await svc.list_versions(session, canvas_id)


class NewVersion(BaseModel):
    """A named version of the canvas as it is now."""

    name: Optional[str] = None
    note: Optional[str] = None


@router.post("/canvases/{canvas_id}/versions", status_code=201)
async def post_version(
    canvas_id: str, body: NewVersion, session: Session
) -> dict[str, Any]:
    """Make a version now."""
    out = await svc.make_version(session, canvas_id, name=body.name, note=body.note)
    await _changed()
    return out


@router.get("/canvases/{canvas_id}/compare")
async def get_compare(
    canvas_id: str, a: int, b: int, session: Session
) -> dict[str, Any]:
    """Two versions board by board."""
    return await svc.compare(session, canvas_id, a, b)


@router.get("/canvases/{canvas_id}/boards/{board_id}/source-diff")
async def get_source_diff(
    canvas_id: str, board_id: str, a: int, b: int, session: Session
) -> dict[str, Any]:
    """Line diff of a frame's source between two versions."""
    return await svc.source_diff(session, canvas_id, board_id, a, b)


@router.get("/canvases/{canvas_id}/versions/{n}")
async def get_version(canvas_id: str, n: int, session: Session) -> dict[str, Any]:
    """One version with the canvas file as it was."""
    return await svc.get_version(session, canvas_id, n)


class VersionName(BaseModel):
    """Name a version."""

    name: Optional[str] = None


@router.patch("/canvases/{canvas_id}/versions/{n}")
async def patch_version(
    canvas_id: str, n: int, body: VersionName, session: Session
) -> dict[str, Any]:
    """Name (or unname) a version."""
    return await svc.name_version(session, canvas_id, n, body.name)


@router.post("/canvases/{canvas_id}/versions/{n}/restore")
async def post_restore_version(
    canvas_id: str, n: int, session: Session
) -> dict[str, Any]:
    """Restore a version (makes a new version; nothing is lost)."""
    out = await svc.restore_version(session, canvas_id, n)
    await _changed()
    return out


# --- comments ---------------------------------------------------------------------------------------------------


@router.get("/canvases/{canvas_id}/threads")
async def get_threads(
    canvas_id: str, session: Session, state: Optional[str] = None
) -> list[dict[str, Any]]:
    """Comment threads in pin order."""
    return await comments.list_threads(session, canvas_id, state)


class NewThread(BaseModel):
    """A new pin with its first comment."""

    body: str
    board_id: Optional[str] = None
    x: float = 0.5
    y: float = 0.5
    page: Optional[str] = None


@router.post("/canvases/{canvas_id}/threads", status_code=201)
async def post_thread(
    canvas_id: str, body: NewThread, session: Session
) -> dict[str, Any]:
    """Pin a comment to a frame (0..1 inside it) or to the plane."""
    out = await comments.add_thread(
        session,
        canvas_id,
        body=body.body,
        board_id=body.board_id,
        x=body.x,
        y=body.y,
        page=body.page,
    )
    await _changed()
    return out


class Body(BaseModel):
    """Comment text."""

    body: str


@router.post("/canvases/threads/{thread_id}/replies", status_code=201)
async def post_reply(thread_id: str, body: Body, session: Session) -> dict[str, Any]:
    """Reply in a thread."""
    out = await comments.reply(session, thread_id, body.body)
    await _changed()
    return out


@router.post("/canvases/threads/{thread_id}/resolve")
async def post_resolve(thread_id: str, session: Session) -> dict[str, Any]:
    """Resolve a thread."""
    out = await comments.set_status(session, thread_id, "resolved")
    await _changed()
    return out


@router.post("/canvases/threads/{thread_id}/reopen")
async def post_reopen(thread_id: str, session: Session) -> dict[str, Any]:
    """Reopen a thread."""
    out = await comments.set_status(session, thread_id, "open")
    await _changed()
    return out


@router.patch("/canvases/comments/{comment_id}")
async def patch_comment(
    comment_id: str, body: Body, session: Session
) -> dict[str, Any]:
    """Edit your own comment."""
    return await comments.edit_comment(session, comment_id, body.body)


@router.delete("/canvases/comments/{comment_id}")
async def del_comment(comment_id: str, session: Session) -> dict[str, Any]:
    """Delete your own comment."""
    out = await comments.delete_comment(session, comment_id)
    await _changed()
    return out


# --- AI proposals -----------------------------------------------------------------------------------------------


@router.get("/canvases/{canvas_id}/proposals")
async def get_proposals(
    canvas_id: str, session: Session, status: Optional[str] = "open"
) -> list[dict[str, Any]]:
    """AI proposals (open ones by default), each with before and after."""
    return await proposals.list_proposals(
        session, canvas_id, status if status != "all" else None
    )


class Decision(BaseModel):
    """Accept and/or reject frames of a proposal."""

    accept: list[str] | str = "all"
    reject: list[str] | str | None = None


@router.post("/canvases/{canvas_id}/proposals/{proposal_id}/decide")
async def post_decide(
    canvas_id: str, proposal_id: str, body: Decision, session: Session
) -> dict[str, Any]:
    """Accept (all, or some) and reject frames. Accepted frames save as one new version."""
    out = await proposals.decide(
        session, canvas_id, proposal_id, accept=body.accept, reject=body.reject
    )
    await _changed()
    return out


@router.get("/canvases/{canvas_id}/proposals/{proposal_id}/{board_id}/{path:path}")
async def get_proposal_file(
    canvas_id: str, proposal_id: str, board_id: str, path: str, session: Session
) -> Response:
    """A file of a proposal (the "After" preview), served as locked as a frame."""
    data, media = await proposals.read_file(
        session, canvas_id, proposal_id, board_id, path
    )
    return Response(
        data,
        media_type=media.split(";")[0],
        headers={
            **_FRAME_HEADERS,
            "Content-Type": media,
            "Cache-Control": "private, no-store",
        },
    )


class AskBody(BaseModel):
    """Ask AI about frames (Ctrl J)."""

    board_ids: list[str]
    request: str
    member_id: Optional[str] = None


@router.post("/canvases/{canvas_id}/ai/ask", status_code=202)
async def post_ask(canvas_id: str, body: AskBody, session: Session) -> dict[str, Any]:
    """Start a Docs AI job that prepares a proposal for the frames. Nothing changes until a person accepts."""
    c = await svc._canvas(session, canvas_id)  # noqa: SLF001
    await svc.member_role(session, c)
    if not c.project_id:
        raise DocsAiError(
            "unavailable", "AI works on canvases that belong to a project."
        )
    await ai_settings.require_enabled(session, c.project_id)
    if c.page_id:
        from models import DocsPage

        page = await session.get(DocsPage, c.page_id)
        if page is not None and not await access.ai_can_read(session, page):
            raise DocsAiError("hidden", "This page is hidden from AI.")
    await engine.check_ready(
        c.project_id, await engine.resolve(c.project_id, body.member_id)
    )
    job = await jobs.start(
        session,
        project_id=c.project_id,
        kind="canvas",
        started_by=svc_activity.current_actor(),
        page_id=c.page_id,
        member_id=body.member_id,
        instruction=body.request[:200],
        result={
            "input": {
                "canvas_id": c.id,
                "board_ids": body.board_ids,
                "request": body.request,
            }
        },
    )
    return jobs.to_dict(job)


@router.post("/canvases/threads/{thread_id}/propose", status_code=202)
async def post_propose_from_thread(thread_id: str, session: Session) -> dict[str, Any]:
    """ "Propose a fix" on an AI comment: start the same job with the comment as the request, on its frame."""
    t = await comments.thread_by_id(session, thread_id)
    if not t["board_id"]:
        raise DocsError(
            422, "no_board", "Pin the comment to a frame to propose a fix for it."
        )
    first = t["comments"][0]["body"] if t["comments"] else ""
    return await post_ask(
        t["canvas_id"],
        AskBody(board_ids=[t["board_id"]], request=f"Fix this: {first}"),
        session,
    )
