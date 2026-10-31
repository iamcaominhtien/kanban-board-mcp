"""Comments on a canvas: pinned to a frame (the pin moves with it) or to a point of the plane, in threads that can be
resolved. They behave like Docs comments and belong to the canvas, so they follow it when it moves to Docs.

An AI member comments under its own name and can offer a proposal; it never resolves a person's thread.
"""

import json
import re
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, CanvasComment, CanvasThread, Member
from services import activity, canvases
from services.docs_text import DocsError

MAX_BODY = 4000


def _body(text: str) -> str:
    body = (text or "").strip()
    if not body:
        raise DocsError(422, "empty_comment", "A comment needs some text.")
    return body[:MAX_BODY]


def _mentions(body: str) -> list[str]:
    return sorted(
        set(re.findall(r"(?<![\w@])@([\w][\w .-]{0,40}?)(?=[\s,.;:!?)]|$)", body))
    )


async def _is_ai(session: AsyncSession, c: Any, author: str) -> bool:
    """Whether an author is one of the project's AI members."""
    if not c.project_id:
        return False
    rows = await session.exec(select(Member).where(Member.project_id == c.project_id))
    for m in rows.all():
        if (
            m.name.casefold() == author.casefold()
            and await session.get(AiMember, m.id) is not None
        ):
            return True
    return False


async def _out_comment(
    session: AsyncSession, c: Any, m: CanvasComment
) -> dict[str, Any]:
    ai = json.loads(m.ai) if m.ai else None
    return {
        "id": m.id,
        "thread_id": m.thread_id,
        "author": m.author,
        "body": m.body,
        "mentions": json.loads(m.mentions or "[]"),
        "ai": ai,
        "is_ai": ai is not None,
        "created_at": m.created_at,
        "edited_at": m.edited_at,
    }


async def _thread_out(session: AsyncSession, c: Any, t: CanvasThread) -> dict[str, Any]:
    rows = (
        await session.exec(
            select(CanvasComment)
            .where(CanvasComment.thread_id == t.id)
            .order_by(CanvasComment.created_at)  # type: ignore[arg-type]
        )
    ).all()
    comments = [await _out_comment(session, c, m) for m in rows]
    return {
        "id": t.id,
        "canvas_id": t.canvas_id,
        "number": t.number,
        "board_id": t.board_id,
        "x": t.x,
        "y": t.y,
        "page": t.page,
        "status": t.status,
        "created_by": t.created_by,
        "created_at": t.created_at,
        "resolved_by": t.resolved_by,
        "resolved_at": t.resolved_at,
        "comments": comments,
        "by_ai": bool(comments and comments[0]["is_ai"]),
    }


async def open_count(session: AsyncSession, canvas_id: str) -> int:
    """Open threads of a canvas."""
    rows = await session.exec(
        select(CanvasThread).where(
            CanvasThread.canvas_id == canvas_id, CanvasThread.status == "open"
        )
    )
    return len(rows.all())


async def list_threads(
    session: AsyncSession, canvas_id: str, state: str | None = None
) -> list[dict[str, Any]]:
    """The canvas's threads in pin order, with their comments. ``state``: ``open``, ``resolved`` or all."""
    c = await canvases._canvas(session, canvas_id)  # noqa: SLF001
    stmt = (
        select(CanvasThread)
        .where(CanvasThread.canvas_id == c.id)
        .order_by(CanvasThread.number)
    )  # type: ignore[arg-type]
    if state in ("open", "resolved"):
        stmt = stmt.where(CanvasThread.status == state)
    return [await _thread_out(session, c, t) for t in (await session.exec(stmt)).all()]


async def add_thread(
    session: AsyncSession,
    canvas_id: str,
    *,
    body: str,
    board_id: str | None = None,
    x: float = 0.5,
    y: float = 0.5,
    page: str | None = None,
    ai: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start a thread on a frame (``x``/``y`` are 0..1 inside it) or on the plane (plane units, with ``page``).

    Raises:
        DocsError: 403 for viewers; 404 for a frame that is not on the canvas.
    """
    c = await canvases._canvas(session, canvas_id)  # noqa: SLF001
    await canvases.member_role(session, c)
    doc = canvases.read_doc(c.id)
    if board_id:
        canvases.board_of(doc, board_id)
        x, y = max(0.0, min(1.0, x)), max(0.0, min(1.0, y))
    else:
        page = (
            page if page in {p["id"] for p in doc["pages"]} else doc["pages"][0]["id"]
        )
    existing = (
        await session.exec(select(CanvasThread).where(CanvasThread.canvas_id == c.id))
    ).all()
    number = max([t.number for t in existing] + [0]) + 1
    actor = activity.current_actor()
    text = _body(body)
    t = CanvasThread(
        canvas_id=c.id,
        number=number,
        board_id=board_id,
        x=x,
        y=y,
        page=page,
        created_by=actor,
    )
    session.add(t)
    await session.flush()
    session.add(
        CanvasComment(
            thread_id=t.id,
            author=actor,
            body=text,
            mentions=json.dumps(_mentions(text)),
            ai=json.dumps(ai) if ai is not None else None,
        )
    )
    await session.commit()
    return await _thread_out(session, c, t)


async def _thread(session: AsyncSession, thread_id: str) -> tuple[Any, CanvasThread]:
    t = await session.get(CanvasThread, thread_id)
    if t is None:
        raise DocsError(404, "thread_not_found", "That comment thread was not found.")
    return await canvases._canvas(session, t.canvas_id), t  # noqa: SLF001


async def reply(
    session: AsyncSession,
    thread_id: str,
    body: str,
    *,
    ai: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Reply in a thread."""
    c, t = await _thread(session, thread_id)
    await canvases.member_role(session, c)
    text = _body(body)
    session.add(
        CanvasComment(
            thread_id=t.id,
            author=activity.current_actor(),
            body=text,
            mentions=json.dumps(_mentions(text)),
            ai=json.dumps(ai) if ai is not None else None,
        )
    )
    await session.commit()
    return await _thread_out(session, c, t)


async def edit_comment(
    session: AsyncSession, comment_id: str, body: str
) -> dict[str, Any]:
    """Edit your own comment."""
    m = await session.get(CanvasComment, comment_id)
    if m is None:
        raise DocsError(404, "comment_not_found", "That comment was not found.")
    c, t = await _thread(session, m.thread_id)
    await canvases.member_role(session, c)
    if m.author != activity.current_actor():
        raise DocsError(403, "not_yours", "You can only edit your own comments.")
    m.body = _body(body)
    m.mentions = json.dumps(_mentions(m.body))
    m.edited_at = canvases._now()  # noqa: SLF001
    session.add(m)
    await session.commit()
    return await _thread_out(session, c, t)


async def delete_comment(session: AsyncSession, comment_id: str) -> dict[str, Any]:
    """Delete your own comment; deleting a thread's first comment removes the thread."""
    m = await session.get(CanvasComment, comment_id)
    if m is None:
        raise DocsError(404, "comment_not_found", "That comment was not found.")
    c, t = await _thread(session, m.thread_id)
    await canvases.member_role(session, c)
    if m.author != activity.current_actor():
        raise DocsError(403, "not_yours", "You can only delete your own comments.")
    first = (
        await session.exec(
            select(CanvasComment)
            .where(CanvasComment.thread_id == t.id)
            .order_by(CanvasComment.created_at)  # type: ignore[arg-type]
        )
    ).first()
    if first is not None and first.id == m.id:
        for x in (
            await session.exec(
                select(CanvasComment).where(CanvasComment.thread_id == t.id)
            )
        ).all():
            await session.delete(x)
        await session.delete(t)
        await session.commit()
        return {"deleted": "thread", "thread_id": t.id}
    await session.delete(m)
    await session.commit()
    return {"deleted": "comment", "thread": await _thread_out(session, c, t)}


async def set_status(
    session: AsyncSession, thread_id: str, status: str
) -> dict[str, Any]:
    """Resolve or reopen a thread. An AI member never resolves a person's thread.

    Raises:
        DocsError: 403 when an AI member tries to resolve a thread a person started.
    """
    c, t = await _thread(session, thread_id)
    await canvases.member_role(session, c)
    actor = activity.current_actor()
    if (
        status == "resolved"
        and await _is_ai(session, c, actor)
        and not await _is_ai(session, c, t.created_by)
    ):
        raise DocsError(
            403, "ai_cannot_resolve", "AI members do not resolve a person's thread."
        )
    t.status = status
    t.resolved_by = actor if status == "resolved" else None
    t.resolved_at = canvases._now() if status == "resolved" else None  # noqa: SLF001
    session.add(t)
    await session.commit()
    return await _thread_out(session, c, t)


async def thread_by_id(session: AsyncSession, thread_id: str) -> dict[str, Any]:
    """One thread."""
    c, t = await _thread(session, thread_id)
    return await _thread_out(session, c, t)
