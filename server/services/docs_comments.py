"""Docs comments: inline threads tied to selected text, page comments, replies, mentions and events.

Comments belong to the page, not to a version. They are re-matched against the new text on every
publish; a thread whose text can no longer be found is *orphaned* (kept, warned, can be re-attached).
"""

import json
import re
from datetime import UTC, datetime
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    DocsComment,
    DocsCommentEvent,
    DocsCommentRead,
    DocsCommentThread,
    DocsPage,
    Member,
)
from services import activity, docs_access
from services import docs_anchors as anchors
from services.docs import _latest_version, get_page
from services.docs_text import DocsError

MAX_BODY = 4000
SNIPPET = 140
ROLES = docs_access.ROLES
STATES = ("all", "open", "resolved")


def _now() -> str:
    return datetime.now(UTC).isoformat()


# --- people and permissions -------------------------------------------------


_members = docs_access.members_of
role_in = docs_access.role_in


def _need_member(role: str) -> None:
    if role == "viewer":
        raise DocsError(
            403,
            "read_only",
            "Viewers can read comments but cannot add them. Ask a project member for access.",
        )


_MEMBER_LINK = re.compile(r"@\[([^\]\n]{1,200})\]\(member:([\w-]{1,64})\)")


def plain_mentions(body: str) -> str:
    """Show ``@[Name](member:id)`` mentions (what the mention picker inserts) as ``@Name``."""
    return _MEMBER_LINK.sub(lambda m: "@" + m.group(1), body)


_IMAGE = re.compile(r"!\[([^\]\n]{0,200})\]\(([^()\s]{0,500})\)")
_LINK = re.compile(r"(?<!!)\[([^\]\n]{1,200})\]\(([^()\s]{0,500})\)")


def snippet_of(body: str) -> str:
    """One-line preview of a comment for notifications: mentions as ``@Name``, images and diagrams as words."""
    text = plain_mentions(body)
    text = _IMAGE.sub(
        lambda m: "[diagram]" if m.group(2).startswith("diagram:") else "[image]", text
    )
    text = _LINK.sub(
        lambda m: "[diagram]" if m.group(2).startswith("diagram:") else m.group(1),
        text,
    )
    return " ".join(text.split())[:SNIPPET]


def mentions_in(body: str, members: list[Member]) -> list[Member]:
    """Members @mentioned in a comment body.

    Both the picker's ``@[Name](member:id)`` and a typed ``@Name`` count (the longest names first so
    "@Ann Lee" beats "@Ann"). Names that are not project members are ignored.
    """
    found: list[Member] = []
    by_id = {m.id: m for m in members}
    for m in _MEMBER_LINK.finditer(body):
        hit = by_id.get(m.group(2))
        if hit and hit not in found:
            found.append(hit)
    text = plain_mentions(body)
    for m in sorted(members, key=lambda m: -len(m.name)):
        pat = r"(?<![\w@])@" + re.escape(m.name) + r"(?!\w)"
        if re.search(pat, text, re.IGNORECASE) and m not in found:
            found.append(m)
    return found


def _clean_body(body: str | None) -> str:
    text = (body or "").strip()
    if not text:
        raise DocsError(422, "empty_comment", "Write something before posting")
    if len(text) > MAX_BODY:
        raise DocsError(
            422, "comment_too_long", f"A comment is limited to {MAX_BODY} characters"
        )
    return text


def _json_obj(raw: str | None) -> dict[str, Any] | None:
    try:
        v = json.loads(raw) if raw else None
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def _json_list(raw: str | None) -> list[Any]:
    try:
        v = json.loads(raw or "[]")
    except ValueError:
        return []
    return v if isinstance(v, list) else []


# --- lookups ----------------------------------------------------------------


async def _thread(session: AsyncSession, thread_id: str) -> DocsCommentThread:
    t = await session.get(DocsCommentThread, thread_id)
    if t is None:
        raise DocsError(404, "thread_not_found", "Comment thread not found")
    return t


async def _thread_page(session: AsyncSession, thread: DocsCommentThread) -> DocsPage:
    return await get_page(session, thread.page_id)


async def _comments_of(session: AsyncSession, thread_id: str) -> list[DocsComment]:
    rows = await session.exec(
        select(DocsComment)
        .where(DocsComment.thread_id == thread_id)
        .order_by(DocsComment.created_at, DocsComment.id)  # type: ignore[arg-type]
    )
    return list(rows.all())


async def _page_blocks(session: AsyncSession, page: DocsPage) -> list[anchors.Block]:
    latest = await _latest_version(session, page)
    return anchors.blocks_of(latest.markdown if latest else "")


# --- serialization -----------------------------------------------------------


def _comment_out(
    c: DocsComment, members: list[Member], actor: str, role: str
) -> dict[str, Any]:
    by_id = {m.id: m for m in members}
    mentioned = [by_id[i] for i in _json_list(c.mentions) if i in by_id]
    mine = c.author == actor
    return {
        "id": c.id,
        "thread_id": c.thread_id,
        "author": c.author,
        "body": c.body,
        "mentions": [{"id": m.id, "name": m.name} for m in mentioned],
        "created_at": c.created_at,
        "edited_at": c.edited_at,
        # set on an AI member's reply: {member_id, job_id, cost, sources, can_suggest, kind?, proposal_id?}
        "ai": _json_obj(c.ai),
        "can_edit": mine and role != "viewer" and not c.ai,
        "can_delete": role != "viewer" and (mine or role == "admin"),
    }


async def _read_marks(
    session: AsyncSession, thread_ids: list[str], reader: str
) -> dict[str, str]:
    if not thread_ids:
        return {}
    rows = await session.exec(
        select(DocsCommentRead).where(
            DocsCommentRead.thread_id.in_(thread_ids),  # type: ignore[attr-defined]
            DocsCommentRead.reader == reader,
        )
    )
    return {r.thread_id: r.read_at for r in rows.all()}


def _numbers(threads: list[DocsCommentThread]) -> dict[str, int]:
    """Number the open, attached inline threads in page order (the numbers on the highlights)."""
    live = [
        t
        for t in threads
        if t.kind == "inline" and t.status == "open" and t.anchor_state == "attached"
    ]
    live.sort(
        key=lambda t: (t.anchor_pos is None, t.anchor_pos or 0, t.created_at, t.id)
    )
    return {t.id: i + 1 for i, t in enumerate(live)}


async def _serialize(
    session: AsyncSession,
    threads: list[DocsCommentThread],
    members: list[Member],
    actor: str,
    role: str,
    numbers: dict[str, int],
) -> list[dict[str, Any]]:
    ids = [t.id for t in threads]
    comments: dict[str, list[DocsComment]] = {i: [] for i in ids}
    if ids:
        rows = await session.exec(
            select(DocsComment)
            .where(DocsComment.thread_id.in_(ids))  # type: ignore[attr-defined]
            .order_by(DocsComment.created_at, DocsComment.id)  # type: ignore[arg-type]
        )
        for c in rows.all():
            comments[c.thread_id].append(c)
    marks = await _read_marks(session, ids, actor)
    out = []
    for t in threads:
        cs = comments[t.id]
        seen = marks.get(t.id)
        unread = any(
            c.author != actor and (seen is None or c.created_at > seen) for c in cs
        )
        out.append(
            {
                "id": t.id,
                "page_id": t.page_id,
                "kind": t.kind,
                "status": t.status,
                "number": numbers.get(t.id),
                "anchor": (
                    {
                        "quote": t.anchor_quote,
                        "prefix": t.anchor_prefix,
                        "suffix": t.anchor_suffix,
                        "section": t.anchor_section,
                        "state": t.anchor_state,
                        "pos": t.anchor_pos,
                    }
                    if t.kind == "inline"
                    else None
                ),
                "created_by": t.created_by,
                "created_at": t.created_at,
                "resolved_by": t.resolved_by,
                "resolved_at": t.resolved_at,
                "unread": unread,
                "comments": [_comment_out(c, members, actor, role) for c in cs],
                "can_reply": role != "viewer",
                "can_resolve": role != "viewer",
            }
        )
    return out


async def list_comments(
    session: AsyncSession,
    page_id: str,
    *,
    state: str = "all",
    kind: str | None = None,
) -> dict[str, Any]:
    """List a page's comment threads with counts and the caller's role.

    Args:
        page_id: Page to list.
        state: ``all``, ``open`` or ``resolved``; filters inline threads only.
        kind: ``inline`` or ``page`` to list one kind; both when omitted.

    Returns:
        ``{threads, counts, role, me, members}``; inline threads come first, orphaned ones last.

    Raises:
        DocsError: 404 if the page is missing or in the Recycle Bin; 422 on a bad filter.
    """
    if state not in STATES:
        raise DocsError(422, "bad_state", f"state must be one of {list(STATES)}")
    if kind not in (None, "inline", "page"):
        raise DocsError(422, "bad_kind", "kind must be inline or page")
    page = await get_page(session, page_id)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    role = role_in(members, actor)
    rows = await session.exec(
        select(DocsCommentThread)
        .where(DocsCommentThread.page_id == page_id)
        .order_by(DocsCommentThread.created_at, DocsCommentThread.id)  # type: ignore[arg-type]
    )
    every = list(rows.all())
    numbers = _numbers(every)
    inline = [t for t in every if t.kind == "inline"]
    shown = [
        t
        for t in every
        if (kind is None or t.kind == kind)
        and (t.kind == "page" or state == "all" or t.status == state)
    ]
    shown.sort(
        key=lambda t: (
            t.kind == "page",
            t.anchor_state == "orphaned",
            t.anchor_pos is None,
            t.anchor_pos or 0,
            t.created_at,
        )
    )
    from services.docs_ai import threads as ai_threads

    out_threads = await _serialize(session, shown, members, actor, role, numbers)
    docs_ai = await ai_threads.annotate(session, page, out_threads)
    return {
        "threads": out_threads,
        "counts": {
            "all": len(inline),
            "open": sum(t.status == "open" for t in inline),
            "resolved": sum(t.status == "resolved" for t in inline),
            "orphaned": sum(
                t.anchor_state == "orphaned" and t.status == "open" for t in inline
            ),
            "page": sum(t.kind == "page" for t in every),
        },
        "role": role,
        "me": actor,
        # `kind` human | ai; AI members carry `ai` (status for the @ picker) only while Docs AI is on
        "members": await ai_threads.member_rows(
            session, page.project_id, members, docs_ai
        ),
        "docs_ai": docs_ai,
    }


async def _one(session: AsyncSession, thread: DocsCommentThread) -> dict[str, Any]:
    page = await _thread_page(session, thread)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    rows = await session.exec(
        select(DocsCommentThread).where(DocsCommentThread.page_id == page.id)
    )
    numbers = _numbers(list(rows.all()))
    out = await _serialize(
        session, [thread], members, actor, role_in(members, actor), numbers
    )
    from services.docs_ai import threads as ai_threads

    await ai_threads.annotate(session, page, out)
    return out[0]


async def get_thread(session: AsyncSession, thread_id: str) -> dict[str, Any]:
    """One thread as the comments list shows it."""
    return await _one(session, await _thread(session, thread_id))


# --- events -------------------------------------------------------------------


async def _record_event(
    session: AsyncSession,
    page: DocsPage,
    thread: DocsCommentThread,
    comment: DocsComment | None,
    kind: str,
    actor: str,
    members: list[Member],
    *,
    notify_thread: bool,
) -> None:
    """Write one Activity entry; ``recipients`` lists who is notified (never the actor).

    Mentioned people are always notified. For replies, resolves and reopens the thread starter and
    everyone who replied are notified too.
    """
    mentioned = [m.name for m in mentions_in(comment.body, members)] if comment else []
    people: list[str] = list(mentioned)
    if notify_thread:
        people.append(thread.created_by)
        for c in await _comments_of(session, thread.id):
            people.append(c.author)
    recipients: list[str] = []
    for p in people:
        if p.casefold() != actor.casefold() and p.casefold() not in {
            r.casefold() for r in recipients
        }:
            recipients.append(p)
    snippet = snippet_of(comment.body if comment else (thread.anchor_quote or ""))
    session.add(
        DocsCommentEvent(
            project_id=page.project_id,
            page_id=page.id,
            thread_id=thread.id,
            comment_id=comment.id if comment else None,
            kind=kind,
            actor=actor,
            mentioned=json.dumps(mentioned),
            recipients=json.dumps(recipients),
            page_title=page.title,
            snippet=snippet,
        )
    )


async def list_events(
    session: AsyncSession,
    project_id: str,
    *,
    recipient: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List a project's comment events (Activity), newest first.

    Args:
        project_id: Project to list.
        recipient: Only events that notify this person; all events when omitted.
        limit: Maximum entries.
    """
    rows = await session.exec(
        select(DocsCommentEvent)
        .where(DocsCommentEvent.project_id == project_id)
        .order_by(DocsCommentEvent.created_at.desc())  # type: ignore[attr-defined]
        .limit(max(1, min(limit, 200)) * (4 if recipient else 1))
    )
    out = []
    for e in rows.all():
        recipients = _json_list(e.recipients)
        if recipient and recipient.casefold() not in {
            str(r).casefold() for r in recipients
        }:
            continue
        out.append(
            {
                "id": e.id,
                "page_id": e.page_id,
                "page_title": e.page_title,
                "thread_id": e.thread_id,
                "comment_id": e.comment_id,
                "kind": e.kind,
                "actor": e.actor,
                "mentioned": _json_list(e.mentioned),
                "recipients": recipients,
                "snippet": e.snippet,
                "created_at": e.created_at,
            }
        )
    return out[: max(1, min(limit, 200))]


# --- writes -------------------------------------------------------------------


async def create_thread(
    session: AsyncSession,
    page_id: str,
    *,
    kind: str,
    body: str,
    anchor: dict[str, Any] | None = None,
    ai: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start a thread: an inline comment on selected text, or a page comment.

    Args:
        page_id: Page to comment on.
        kind: ``inline`` or ``page``.
        body: Comment text (Markdown; ``@Name`` mentions project members).
        anchor: For inline threads, ``{quote, prefix, suffix, section}`` of the selection.
        ai: Set when an AI member writes the comment (Docs AI): ``{member_id, job_id, cost, sources, can_suggest}``.

    Returns:
        The new thread.

    Raises:
        DocsError: 403 for a viewer; 422 on empty text or a missing or oversized selection.
    """
    if kind not in ("inline", "page"):
        raise DocsError(422, "bad_kind", "kind must be inline or page")
    page = await get_page(session, page_id)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    _need_member(role_in(members, actor))
    text = _clean_body(body)
    thread = DocsCommentThread(page_id=page.id, kind=kind, created_by=actor)
    if kind == "inline":
        quote = anchors.normalize((anchor or {}).get("quote") or "")
        if not quote:
            raise DocsError(
                422, "no_selection", "Select some text before adding a comment"
            )
        if len(quote) > anchors.MAX_QUOTE:
            raise DocsError(
                422,
                "selection_too_long",
                f"Select at most {anchors.MAX_QUOTE} characters",
            )
        thread.anchor_quote = quote
        thread.anchor_prefix = (anchor or {}).get("prefix") or ""
        thread.anchor_suffix = (anchor or {}).get("suffix") or ""
        thread.anchor_section = (anchor or {}).get("section") or None
        # Text typed in a draft may not be published yet: it stays attached, without a position, until
        # the next publish re-matches it.
        hit = anchors.find_anchor(
            await _page_blocks(session, page),
            quote,
            thread.anchor_prefix,
            thread.anchor_suffix,
            thread.anchor_section,
        )
        thread.anchor_pos = hit.pos if hit else None
    session.add(thread)
    await session.flush()
    comment = DocsComment(
        thread_id=thread.id,
        author=actor,
        body=text,
        mentions=json.dumps([m.id for m in mentions_in(text, members)]),
        ai=json.dumps(ai) if ai else None,
    )
    session.add(comment)
    await session.flush()
    await _record_event(
        session, page, thread, comment, "comment", actor, members, notify_thread=False
    )
    await _mark_read(session, thread.id, actor)
    await session.commit()
    return await _one(session, thread)


async def add_reply(
    session: AsyncSession,
    thread_id: str,
    body: str,
    *,
    ai: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Reply in a thread and notify the people mentioned, the thread starter and earlier repliers.

    ``ai`` is set when an AI member writes the reply (Docs AI): it is shown with an AI badge and never starts
    another AI run.
    """
    thread = await _thread(session, thread_id)
    page = await _thread_page(session, thread)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    _need_member(role_in(members, actor))
    text = _clean_body(body)
    comment = DocsComment(
        thread_id=thread.id,
        author=actor,
        body=text,
        mentions=json.dumps([m.id for m in mentions_in(text, members)]),
        ai=json.dumps(ai) if ai else None,
    )
    session.add(comment)
    await session.flush()
    await _record_event(
        session, page, thread, comment, "reply", actor, members, notify_thread=True
    )
    await _mark_read(session, thread.id, actor)
    await session.commit()
    return await _one(session, thread)


async def edit_comment(
    session: AsyncSession, comment_id: str, body: str
) -> dict[str, Any]:
    """Edit your own comment; it is then shown as edited."""
    comment = await session.get(DocsComment, comment_id)
    if comment is None:
        raise DocsError(404, "comment_not_found", "Comment not found")
    thread = await _thread(session, comment.thread_id)
    page = await _thread_page(session, thread)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    _need_member(role_in(members, actor))
    if comment.author != actor:
        raise DocsError(403, "not_author", "You can only edit your own comments")
    text = _clean_body(body)
    if text != comment.body:
        comment.body = text
        comment.mentions = json.dumps([m.id for m in mentions_in(text, members)])
        comment.edited_at = _now()
        session.add(comment)
    await session.commit()
    return await _one(session, thread)


async def delete_comment(session: AsyncSession, comment_id: str) -> dict[str, Any]:
    """Delete a comment.

    The author may delete their own comments and an admin any comment. Deleting the first comment of
    a thread removes the whole thread (and its highlight); deleting a reply removes only that reply.

    Returns:
        ``{deleted: "comment" | "thread", thread_id}``.
    """
    comment = await session.get(DocsComment, comment_id)
    if comment is None:
        raise DocsError(404, "comment_not_found", "Comment not found")
    thread = await _thread(session, comment.thread_id)
    page = await _thread_page(session, thread)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    role = role_in(members, actor)
    _need_member(role)
    if comment.author != actor and role != "admin":
        raise DocsError(
            403, "not_author", "Only the author or an admin can delete a comment"
        )
    comments = await _comments_of(session, thread.id)
    if comments and comments[0].id == comment.id:
        await delete_threads(session, [thread.id])
        await session.commit()
        return {"deleted": "thread", "thread_id": thread.id}
    await session.delete(comment)
    await session.commit()
    return {"deleted": "comment", "thread_id": thread.id}


async def set_status(
    session: AsyncSession, thread_id: str, status: str
) -> dict[str, Any]:
    """Resolve or reopen a thread; the resolver and time are recorded.

    Raises:
        DocsError: 403 for a viewer; 422 if the page comment thread is asked to resolve (page comments
            are not resolvable).
    """
    thread = await _thread(session, thread_id)
    page = await _thread_page(session, thread)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    _need_member(role_in(members, actor))
    if thread.kind != "inline":
        raise DocsError(422, "not_resolvable", "Only inline threads can be resolved")
    if thread.status == status:
        return await _one(session, thread)
    if status == "resolved" and activity.current_ai():
        # An AI that resolves a thread says what it did first: the person who opened it should not have to guess
        replied = (
            await session.exec(
                select(DocsComment).where(
                    DocsComment.thread_id == thread.id, DocsComment.author == actor
                )
            )
        ).first()
        if replied is None:
            raise DocsError(
                422,
                "reply_first",
                "Reply in this thread first (what you changed, or why not), then resolve it.",
            )
    thread.status = status
    thread.resolved_by = actor if status == "resolved" else None
    thread.resolved_at = _now() if status == "resolved" else None
    session.add(thread)
    await _record_event(
        session,
        page,
        thread,
        None,
        "resolved" if status == "resolved" else "reopened",
        actor,
        members,
        notify_thread=True,
    )
    await session.commit()
    return await _one(session, thread)


async def reattach(
    session: AsyncSession, thread_id: str, anchor: dict[str, Any]
) -> dict[str, Any]:
    """Attach an orphaned (or any inline) thread to a new selection."""
    thread = await _thread(session, thread_id)
    page = await _thread_page(session, thread)
    actor = activity.current_actor()
    members = await _members(session, page.project_id)
    _need_member(role_in(members, actor))
    if thread.kind != "inline":
        raise DocsError(422, "not_inline", "Only inline threads have an anchor")
    quote = anchors.normalize(anchor.get("quote") or "")
    if not quote or len(quote) > anchors.MAX_QUOTE:
        raise DocsError(422, "no_selection", "Select some text to attach the thread to")
    thread.anchor_quote = quote
    thread.anchor_prefix = anchor.get("prefix") or ""
    thread.anchor_suffix = anchor.get("suffix") or ""
    thread.anchor_section = anchor.get("section") or None
    thread.anchor_state = "attached"
    hit = anchors.find_anchor(
        await _page_blocks(session, page),
        quote,
        thread.anchor_prefix,
        thread.anchor_suffix,
        thread.anchor_section,
    )
    thread.anchor_pos = hit.pos if hit else None
    session.add(thread)
    await session.commit()
    return await _one(session, thread)


async def _mark_read(session: AsyncSession, thread_id: str, reader: str) -> None:
    rows = await session.exec(
        select(DocsCommentRead).where(
            DocsCommentRead.thread_id == thread_id, DocsCommentRead.reader == reader
        )
    )
    mark = rows.first()
    if mark is None:
        session.add(DocsCommentRead(thread_id=thread_id, reader=reader))
    else:
        mark.read_at = _now()
        session.add(mark)


async def mark_read(session: AsyncSession, thread_id: str) -> dict[str, Any]:
    """Mark a thread as read by the caller (clears its unread dot)."""
    thread = await _thread(session, thread_id)
    await _mark_read(session, thread.id, activity.current_actor())
    await session.commit()
    return await _one(session, thread)


# --- anchors across publishes ---------------------------------------------------


async def _inline_threads(
    session: AsyncSession, page_id: str
) -> list[DocsCommentThread]:
    rows = await session.exec(
        select(DocsCommentThread).where(
            DocsCommentThread.page_id == page_id, DocsCommentThread.kind == "inline"
        )
    )
    return list(rows.all())


async def rematch_page(
    session: AsyncSession, page: DocsPage, markdown: str
) -> dict[str, list[str]]:
    """Re-match every inline thread's anchor against new page text (the caller commits).

    A match keeps the thread attached and refreshes its quote, context and position (so a thread
    follows moved or slightly edited text). No match orphans it. An orphaned thread whose exact text
    is back (for example after restoring an older version) is attached again.

    Returns:
        Thread ids by outcome: ``attached``, ``moved`` (found with changed text) and ``orphaned``.
    """
    blocks = anchors.blocks_of(markdown)
    result: dict[str, list[str]] = {"attached": [], "moved": [], "orphaned": []}
    for t in await _inline_threads(session, page.id):
        hit = anchors.find_anchor(
            blocks,
            t.anchor_quote or "",
            t.anchor_prefix,
            t.anchor_suffix,
            t.anchor_section,
        )
        if t.anchor_state == "orphaned" and (hit is None or not hit.exact):
            continue
        if hit is None:
            t.anchor_state = "orphaned"
            t.anchor_pos = None
            result["orphaned"].append(t.id)
        else:
            if not hit.exact:
                result["moved"].append(t.id)
            else:
                result["attached"].append(t.id)
            t.anchor_state = "attached"
            t.anchor_quote = hit.quote
            t.anchor_prefix = hit.prefix
            t.anchor_suffix = hit.suffix
            t.anchor_section = hit.section
            t.anchor_pos = hit.pos
        session.add(t)
    return result


async def anchor_preview(
    session: AsyncSession, page_id: str, markdown: str
) -> dict[str, Any]:
    """Say which open threads would be orphaned if ``markdown`` were published, without changing anything."""
    page = await get_page(session, page_id)
    blocks = anchors.blocks_of(markdown)
    orphaned = []
    for t in await _inline_threads(session, page.id):
        if t.status != "open" or t.anchor_state == "orphaned":
            continue
        if (
            anchors.find_anchor(
                blocks,
                t.anchor_quote or "",
                t.anchor_prefix,
                t.anchor_suffix,
                t.anchor_section,
            )
            is None
        ):
            orphaned.append({"id": t.id, "quote": t.anchor_quote})
    return {"orphaned": orphaned, "count": len(orphaned)}


# --- cleanup --------------------------------------------------------------------


async def delete_threads(session: AsyncSession, thread_ids: list[str]) -> None:
    """Delete threads with their comments and read marks (the caller commits)."""
    if not thread_ids:
        return
    for model in (DocsComment, DocsCommentRead):
        rows = await session.exec(
            select(model).where(model.thread_id.in_(thread_ids))  # type: ignore[attr-defined]
        )
        for row in rows.all():
            await session.delete(row)
    rows = await session.exec(
        select(DocsCommentThread).where(DocsCommentThread.id.in_(thread_ids))  # type: ignore[attr-defined]
    )
    for row in rows.all():
        await session.delete(row)
    await session.flush()


async def delete_for_pages(session: AsyncSession, page_ids: list[str]) -> None:
    """Delete every thread, comment and event of pages that are being erased for good."""
    if not page_ids:
        return
    rows = await session.exec(
        select(DocsCommentThread.id).where(
            DocsCommentThread.page_id.in_(page_ids)  # type: ignore[attr-defined]
        )
    )
    await delete_threads(session, list(rows.all()))
    events = await session.exec(
        select(DocsCommentEvent).where(
            DocsCommentEvent.page_id.in_(page_ids)  # type: ignore[attr-defined]
        )
    )
    for e in events.all():
        await session.delete(e)
