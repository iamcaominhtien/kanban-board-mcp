"""The comments of a ticket as the AI member behind the current MCP call may read them.

`get_ticket` serves people (their own MCP clients) and AI runs alike. For a call that carries an AI run's token the
comments get the same treatment the run's prompt gives them (`context.comments_for_reader`): secrets redacted, text by
other AIs and outsiders fenced as data, outsiders' comments held back unless the member reads external sources.
"""

import json

from sqlmodel import select

from models import Member

from . import guard
from .context import comments_for_reader
from .store import ai_names, get_profile


async def for_caller(session, project_id: str, raw: list[dict]) -> dict | None:
    """`{"comments": [...], "held_back": n}` for an AI caller; None when the caller is not an AI run."""
    ctx = await guard.resolve()
    if ctx is None:
        return None
    _, profile = await get_profile(session, ctx.member_id)
    humans = {
        m.name
        for m in (
            await session.exec(
                select(Member).where(
                    Member.project_id == project_id, Member.kind == "human"
                )
            )
        ).all()
    }
    names = await ai_names(session, project_id)
    comments, held_back = comments_for_reader(
        raw, names, humans, bool(profile and profile.allow_external)
    )
    return {"comments": comments, "held_back": held_back}


def pick(comments: list[dict], ids: list[str] | None, since: str | None) -> list[dict]:
    """Only the comments with these ids and/or written after `since` (an ISO date or time)."""
    if ids:
        wanted = set(ids)
        comments = [c for c in comments if c.get("id") in wanted]
    if since:
        comments = [c for c in comments if (c.get("at") or "") > since]
    return comments


def _loads(value) -> list:
    if isinstance(value, list):
        return value
    try:
        data = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []
