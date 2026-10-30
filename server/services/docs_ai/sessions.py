"""One Claude Code session for each (Docs page, AI member) and, the same way, for each (ticket, AI member):
whatever is asked of that member on the page (an Ask, a
tag in a thread, a suggested edit, a summary, the chat about the page) goes into the same conversation, so the AI
remembers what was said and done on that page. Everyone who talks to the member on the page shares it; the prompt
names who is asking.

Only a local Claude Code member has sessions; an API-key member gets what it needs in each prompt (rolling summaries).
A session is resumed only while the CLI still has it on disk and the page is readable by AI; otherwise a new one
starts and replaces it. Calls on the same (page, member) wait for each other: a CLI session cannot be resumed twice
at once. A ticket's session is shared by the member's runs (a tag, "Do the work", a re-run) and by chats about the
ticket; a chat that finds a run using it answers in a conversation of its own for that message instead of waiting.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import database
from models import DocsAiSession
from services.ai.cli import session_exists
from services.ai.store import now_iso

_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}


def page_scope(page_id: str) -> str:
    """The key of a page's session."""
    return f"page:{page_id}"


def ticket_scope(ticket_id: str) -> str:
    """The key of a ticket's session."""
    return f"ticket:{ticket_id}"


def is_busy(scope: str, member_id: str) -> bool:
    """Whether a call is using the (scope, member) conversation right now."""
    lock = _LOCKS.get((scope, member_id))
    return bool(lock and lock.locked())


@asynccontextmanager
async def exclusive(scope: str, member_id: str) -> AsyncIterator[None]:
    """Hold the (page, member) conversation while a call uses it."""
    lock = _LOCKS.setdefault((scope, member_id), asyncio.Lock())
    async with lock:
        yield


async def lookup(scope: str, member_id: str) -> str | None:
    """The session to resume, or None when there is none or the CLI no longer has it."""
    async with database.async_session() as session:
        row = await session.get(DocsAiSession, (scope, member_id))
        if row is None:
            return None
        if session_exists(row.session_id):
            return row.session_id
        await session.delete(row)
        await session.commit()
        return None


async def remember(
    scope: str, member_id: str, project_id: str, session_id: str
) -> None:
    """Keep `session_id` as the conversation of (page, member)."""
    async with database.async_session() as session:
        row = await session.get(DocsAiSession, (scope, member_id))
        if row is None:
            row = DocsAiSession(
                scope=scope,
                member_id=member_id,
                project_id=project_id,
                session_id=session_id,
            )
        row.session_id = session_id
        row.calls = (row.calls or 0) + 1
        row.updated_at = now_iso()
        session.add(row)
        await session.commit()


async def forget(scope: str, member_id: str | None = None) -> None:
    """Drop a page's session (the page was hidden from AI or deleted), for one member or all."""
    from sqlmodel import select

    async with database.async_session() as session:
        stmt = select(DocsAiSession).where(DocsAiSession.scope == scope)
        if member_id:
            stmt = stmt.where(DocsAiSession.member_id == member_id)
        for row in (await session.exec(stmt)).all():
            await session.delete(row)
        await session.commit()


def asked_by(person: str | None, prompt: str) -> str:
    """The prompt of a shared conversation starts with who is asking."""
    if not person or person in ("system", "user"):
        return prompt
    return f"{person} is asking.\n\n{prompt}"
