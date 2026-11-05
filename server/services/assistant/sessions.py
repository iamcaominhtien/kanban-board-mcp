"""One Claude Code conversation per thing an assistant talks about (AI v2): `docs:<page>`, `board:<project>`,
`chat:<chat id>`, `idea:<idea>`, `sketch:<sketch>`. The id is kept in the `docs_ai_session` table (scope = the name,
member_id = "assistant"); it is resumed only while the CLI still has it on disk, and one turn at a time uses it."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlmodel import select

import database
from models import DocsAiSession
from services.ai.cli import session_exists
from services.ai.store import now_iso

MEMBER = "assistant"
_LOCKS: dict[str, asyncio.Lock] = {}


def page_name(page_id: str) -> str:
    """The conversation of a Docs page."""
    return f"docs:{page_id}"


def board_name(project_id: str) -> str:
    """The conversation of a project's board."""
    return f"board:{project_id}"


def chat_name(chat_id: str) -> str:
    """The conversation of a Board AI chat."""
    return f"chat:{chat_id}"


def idea_name(idea_id: str) -> str:
    """The conversation of an idea."""
    return f"idea:{idea_id}"


def sketch_name(sketch_id: str) -> str:
    """The conversation of a sketch."""
    return f"sketch:{sketch_id}"


def is_busy(name: str) -> bool:
    """Whether a turn is using the conversation now."""
    lock = _LOCKS.get(name)
    return bool(lock and lock.locked())


@asynccontextmanager
async def exclusive(name: str) -> AsyncIterator[None]:
    """Hold the conversation while a turn uses it (a CLI session cannot be resumed twice at once)."""
    lock = _LOCKS.setdefault(name, asyncio.Lock())
    async with lock:
        yield


async def lookup(name: str, config_dir: str | None) -> str | None:
    """The session to resume, or None when there is none or the CLI no longer has it."""
    async with database.async_session() as session:
        row = await session.get(DocsAiSession, (name, MEMBER))
        if row is None:
            return None
        if session_exists(row.session_id, config_dir, "claude-code"):
            return row.session_id
        await session.delete(row)
        await session.commit()
        return None


async def remember(name: str, project_id: str, session_id: str) -> None:
    """Keep the conversation's session id for the next turn."""
    async with database.async_session() as session:
        row = await session.get(DocsAiSession, (name, MEMBER))
        if row is None:
            row = DocsAiSession(
                scope=name,
                member_id=MEMBER,
                project_id=project_id,
                session_id=session_id,
            )
        row.session_id = session_id
        row.calls = (row.calls or 0) + 1
        row.updated_at = now_iso()
        session.add(row)
        await session.commit()


async def forget(name: str) -> None:
    """Drop the conversation: the next turn starts a new one."""
    async with database.async_session() as session:
        for row in (
            await session.exec(select(DocsAiSession).where(DocsAiSession.scope == name))
        ).all():
            await session.delete(row)
        await session.commit()


def asked_by(person: str | None, prompt: str) -> str:
    """A shared conversation's prompt starts with who is asking."""
    if not person or person in ("system", "user"):
        return prompt
    return f"{person} is asking.\n\n{prompt}"
