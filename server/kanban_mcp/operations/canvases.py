"""Canvas operations: boards of HTML, pictures, Sketches and Diagrams with notes and comments on one plane.

An agent reads a canvas as data (frames, notes, arrows, comments, open proposals), comments on it, and *proposes* a
changed frame from a local folder. It never changes a frame itself and never takes a lock from a person: a person sees
before and after and accepts or rejects (docs/specs/canvas.md).
"""

from pathlib import Path
from typing import Annotated

import services.canvases as svc_canvases
from pydantic import Field

from .. import common
from ..common import ProjectId, notify_on_success

CanvasId = Annotated[
    str,
    Field(
        description="Canvas id 'cv_xxxxxxxx' (the id inside `(canvas:cv_xxxxxxxx)` in a text)."
    ),
]
MAX_INLINE = 60_000


def _error(exc: "svc_canvases.DocsError") -> ValueError:
    hint = {
        "board_locked": " A person is editing that frame; your proposal is kept for them to accept once they save.",
        "proposal_stale": " Read the canvas again and propose against the new version.",
    }.get(exc.code, "")
    return ValueError(f"{exc.message}{hint}")


async def _same_project(project_id: str | None) -> None:
    """An AI run may only touch canvases of the project it works in."""
    from services.ai import guard

    ctx = guard.current()
    if ctx is not None and project_id != ctx.project_id:
        raise ValueError(
            "That canvas belongs to another project than this run works in, so it was left alone."
        )


async def list_project_canvases(project_id: ProjectId) -> list[dict]:
    """List a project's canvases: [{id, title, owner_kind, owner_id, page_id, version, rev, boards, updated_by, updated_at, markdown}]."""
    async with common.async_session() as session:
        return await svc_canvases.list_for_project(session, project_id)


async def read_canvas(
    canvas_id: CanvasId,
    board_id: Annotated[
        str | None,
        Field(
            description="A frame id 'b_xxxxxxxx' from this canvas: also returns that frame's source text."
        ),
    ] = None,
    path: Annotated[
        str | None,
        Field(
            description="With board_id: an absolute folder to write the frame's files to (edit them, then docs_write(canvas_propose))."
        ),
    ] = None,
) -> dict:
    """Read a canvas: {id, title, rev, version, markdown, pages, boards, notes, arrows, labels, comments, proposals, locks}."""
    from services import canvas_comments, canvas_proposals

    async with common.async_session() as session:
        try:
            out = await svc_canvases.get_canvas(session, canvas_id)
            await _same_project(out["project_id"])
            doc = out["doc"]
            threads = await canvas_comments.list_threads(session, canvas_id)
            props = await canvas_proposals.list_proposals(session, canvas_id)
            result = {
                "id": out["id"],
                "title": out["title"],
                "rev": out["rev"],
                "version": out["version"],
                "markdown": out["markdown"],
                "owner_kind": out["owner_kind"],
                "owner_id": out["owner_id"],
                "pages": [{"id": p["id"], "name": p["name"]} for p in doc["pages"]],
                "boards": [
                    {
                        "id": b["id"],
                        "page": b["page"],
                        "name": b["name"],
                        "kind": b["kind"],
                        "x": b["x"],
                        "y": b["y"],
                        "width": b["w"],
                        "height": b["h"],
                        "order": b.get("order", 0),
                        "ref": b.get("ref"),
                        "entry": (b.get("content") or {}).get("entry"),
                        "files": [
                            f["path"] for f in (b.get("content") or {}).get("files", [])
                        ],
                        "blocked": (b.get("content") or {}).get("blocked", []),
                        "locked_by": next(
                            (
                                lk["holder"]
                                for lk in out["locks"]
                                if lk["board_id"] == b["id"]
                            ),
                            None,
                        ),
                    }
                    for b in doc["boards"]
                ],
                "notes": [
                    {
                        "id": n["id"],
                        "page": n["page"],
                        "text": n["text"],
                        "color": n["color"],
                        "by": n["by"],
                    }
                    for n in doc["notes"]
                ],
                "arrows": [
                    {
                        "id": a["id"],
                        "from": a["from"],
                        "to": a["to"],
                        "label": a.get("label", ""),
                    }
                    for a in doc["arrows"]
                ],
                "labels": [
                    {"id": t["id"], "page": t["page"], "text": t["text"]}
                    for t in doc["labels"]
                ],
                "comments": [
                    {
                        "thread_id": t["id"],
                        "board_id": t["board_id"],
                        "status": t["status"],
                        "number": t["number"],
                        "comments": [
                            {"author": c["author"], "body": c["body"]}
                            for c in t["comments"]
                        ],
                    }
                    for t in threads
                ],
                "proposals": [
                    {
                        "id": p["id"],
                        "author": p["author"],
                        "note": p["note"],
                        "boards": [
                            {"board_id": c["board_id"], "status": c["status"]}
                            for c in p["changes"]
                        ],
                    }
                    for p in props
                ],
                "locks": out["locks"],
            }
            if board_id:
                src = await svc_canvases.board_source(session, canvas_id, board_id)
                board = svc_canvases.board_of(doc, board_id)
                result["board"] = {
                    "id": board_id,
                    "name": board["name"],
                    "kind": board["kind"],
                    "content_rev": src["rev"],
                    "entry": src["entry"],
                }
                if path:
                    root = Path(path)
                    if not root.is_absolute():
                        raise ValueError(f"Give an absolute folder (got {path!r}).")
                    written = []
                    content = board.get("content")
                    if content:
                        src_root = svc_canvases.board_dir(
                            canvas_id, board_id, content["rev"]
                        )
                        for f in content["files"]:
                            target = root / f["path"]
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes((src_root / f["path"]).read_bytes())
                            written.append(str(target))
                    result["board"]["path"] = str(root)
                    result["board"]["written"] = written
                else:
                    total = 0
                    inline = []
                    for f in src["files"]:
                        total += len(f["text"])
                        if total <= MAX_INLINE:
                            inline.append(f)
                    result["board"]["files"] = inline
                    result["board"]["truncated"] = total > MAX_INLINE
            return result
        except svc_canvases.DocsError as exc:
            raise _error(exc) from exc


@notify_on_success
async def comment_on_canvas(
    canvas_id: CanvasId,
    body: Annotated[
        str, Field(description="Comment text (Markdown; @Name mentions a member).")
    ],
    board_id: Annotated[
        str | None, Field(description="Pin a new comment to this frame.")
    ] = None,
    thread_id: Annotated[
        str | None,
        Field(description="Reply in this thread instead of starting a new one."),
    ] = None,
    x: Annotated[
        float | None,
        Field(description="Pin position inside the frame, 0 to 1 (default 0.5)."),
    ] = None,
    y: Annotated[
        float | None,
        Field(description="Pin position inside the frame, 0 to 1 (default 0.5)."),
    ] = None,
) -> dict:
    """Comment on a canvas under your own name. Returns the thread {id, number, board_id, status, comments}. You never resolve a person's thread."""
    from services import canvas_comments
    from services.ai import guard

    async with common.async_session() as session:
        try:
            c = await svc_canvases._canvas(session, canvas_id)  # noqa: SLF001
            await _same_project(c.project_id)
            ai = (
                {"member": guard.current().member_name, "can_propose": bool(board_id)}
                if guard.current()
                else None
            )
            if thread_id:
                return await canvas_comments.reply(session, thread_id, body, ai=ai)
            return await canvas_comments.add_thread(
                session,
                canvas_id,
                body=body,
                board_id=board_id,
                ai=ai,
            )
        except svc_canvases.DocsError as exc:
            raise _error(exc) from exc


@notify_on_success
async def propose_canvas_change(
    canvas_id: CanvasId,
    board_id: Annotated[
        str, Field(description="The HTML frame 'b_xxxxxxxx' to change.")
    ],
    path: Annotated[
        str,
        Field(
            description="Absolute folder with the frame's new files (as written by docs_read(canvas, board_id, path)); files you leave out stay as they are."
        ),
    ],
    note: Annotated[
        str | None, Field(description="One sentence on what you changed.")
    ] = None,
    request: Annotated[
        str | None, Field(description="What you were asked to do.")
    ] = None,
) -> dict:
    """Propose a changed frame. Nothing changes until a person accepts it (they see before and after). Returns {id, status, boards, waiting_for}. If a person is editing the frame the proposal is kept and shown when they finish."""
    from services import canvas_proposals
    from services.ai import guard

    root = Path(path)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError(f"Give an absolute folder that exists (got {path!r}).")
    files: dict[str, bytes] = {}
    total = 0
    for p in sorted(root.rglob("*")):
        if p.is_file():
            total += p.stat().st_size
            if total > svc_canvases.MAX_BOARD_BYTES:
                raise ValueError(
                    f"That folder is over {svc_canvases.MAX_BOARD_BYTES // (1024 * 1024)} MB, the most a frame can hold."
                )
            files[p.relative_to(root).as_posix()] = p.read_bytes()
    async with common.async_session() as session:
        try:
            c = await svc_canvases._canvas(session, canvas_id)  # noqa: SLF001
            await _same_project(c.project_id)
            ctx = guard.current()
            out = await canvas_proposals.create(
                session,
                canvas_id,
                changes=[{"board_id": board_id, "files": files}],
                note=note or "",
                member_id=ctx.member_id if ctx else None,
            )
        except svc_canvases.DocsError as exc:
            raise _error(exc) from exc
    return {
        "id": out["id"],
        "status": out["status"],
        "boards": [c_["name"] for c_ in out["changes"]],
        "lines_changed": sum(c_["lines"] for c_ in out["changes"]),
        "waiting_for": next(
            (c_["waiting_for"] for c_ in out["changes"] if c_["waiting_for"]), None
        ),
        "message": "Proposed. A person sees before and after and accepts or rejects it; nothing was changed.",
    }
