"""Ticket activity log entries: who changed what, and when."""

import json
from contextvars import ContextVar, Token
from datetime import UTC, datetime
from typing import Any

HUMAN_ACTOR = "user"
AGENT_ACTOR = "agent"
MAX_TEXT = 200

_actor: ContextVar[str] = ContextVar("activity_actor", default=HUMAN_ACTOR)


def set_actor(name: str) -> Token:
    """Set the actor recorded on activity entries; return a token for `reset_actor`."""
    return _actor.set(name)


def reset_actor(token: Token) -> None:
    """Restore the actor that was active before `set_actor`."""
    _actor.reset(token)


def current_actor() -> str:
    """Return the actor for the current request or task."""
    return _actor.get()


def clip(value: Any) -> Any:
    """Shorten free text so one long note cannot bloat the log."""
    if isinstance(value, str) and len(value) > MAX_TEXT:
        return value[: MAX_TEXT - 1] + "…"
    return value


def entry(
    field: str,
    from_: Any,
    to: Any,
    *,
    ref: str | None = None,
    actor: str | None = None,
    at: str | None = None,
) -> dict:
    """Build one activity-log entry for a field change.

    Args:
        field: Field that changed.
        from_: Previous value.
        to: New value.
        ref: Related id, e.g. a comment id.
        actor: Who changed it; defaults to the current actor.
        at: ISO time; defaults to now.

    Returns:
        The entry as a dict.
    """
    out: dict[str, Any] = {
        "field": field,
        "from": from_,
        "to": to,
        "at": at or datetime.now(UTC).isoformat(),
        "actor": actor or current_actor(),
    }
    if ref:
        out["ref"] = clip(ref)
    return out


def record(
    ticket: Any,
    field: str,
    from_: Any,
    to: Any,
    *,
    ref: str | None = None,
    actor: str | None = None,
) -> None:
    """Append an entry to the ticket's activity log (the caller commits).

    Args:
        ticket: Ticket whose log to extend.
        field: Field that changed.
        from_: Previous value, clipped for storage.
        to: New value, clipped for storage.
        ref: Related id, e.g. a comment id.
        actor: Who changed it; defaults to the current actor.
    """
    try:
        log = json.loads(ticket.activity_log or "[]")
    except ValueError:
        log = []
    log.append(entry(field, clip(from_), clip(to), ref=ref, actor=actor))
    ticket.activity_log = json.dumps(log)


def author_actor(author: str | None) -> str | None:
    """A comment/work-log author is the actor, unless it is just the default."""
    return author if author and author != HUMAN_ACTOR else None
