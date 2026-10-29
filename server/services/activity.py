"""Ticket activity log entries: who changed what, and when."""

import json
from contextvars import ContextVar, Token
from datetime import UTC, datetime
from typing import Any

HUMAN_ACTOR = "user"
AGENT_ACTOR = "agent"
MAX_TEXT = 200

_actor: ContextVar[str] = ContextVar("activity_actor", default=HUMAN_ACTOR)
# Set while an AI member acts: {"member_id", "on_behalf_of", "run_id"}; every entry then records
# "AI name, on behalf of person" (design/components/ai-ticket-work.md, G).
_ai: ContextVar[dict | None] = ContextVar("activity_ai", default=None)
# Set while a person applies a Board AI draft: entries read "suggested by <AI name>"
# (design/screens/ai-board-assistant.md, B2).
_suggested: ContextVar[str | None] = ContextVar("activity_suggested", default=None)


def set_suggested(name: str | None) -> Token:
    """Mark the changes of the current task as suggested by the Board AI; return a token for `reset_suggested`."""
    return _suggested.set(name)


def reset_suggested(token: Token) -> None:
    """Restore the attribution that was active before `set_suggested`."""
    _suggested.reset(token)


def set_ai(info: dict | None) -> Token:
    """Mark the current task as acting for an AI member; return a token for `reset_ai`."""
    return _ai.set(info)


def reset_ai(token: Token) -> None:
    """Restore the AI attribution that was active before `set_ai`."""
    _ai.reset(token)


def current_ai() -> dict | None:
    """The AI member the current task acts for, if any."""
    return _ai.get()


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
    ai = _ai.get()
    if ai:
        out["ai"] = True
        out["on_behalf_of"] = ai.get("on_behalf_of")
        out["run_id"] = ai.get("run_id")
        out["member_id"] = ai.get("member_id")
    suggested = _suggested.get()
    if suggested:
        out["suggested_by"] = suggested
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
