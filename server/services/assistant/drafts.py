"""The transient results of the editors and the sketch chat (AI v2): text the assistant wrote that a person accepts
into their editor or discards. They live in memory only (the board's own drafts table is gone: the assistant acts
directly, and a result nobody took is not worth keeping across a restart)."""

import asyncio
import uuid
from typing import Any

from services.ai.store import now_iso

from .errors import AssistError

DRAFTS: dict[str, dict[str, Any]] = {}
TASKS: dict[str, asyncio.Task] = {}
MAX = 400


def new(
    project_id: str,
    kind: str,
    owner: str,
    payload: dict[str, Any],
    *,
    ticket_id: str | None = None,
    doc_id: str | None = None,
    chat_message_id: str | None = None,
    member_name: str = "Board AI",
) -> dict[str, Any]:
    """Hold a new result (pending until it is written)."""
    if len(DRAFTS) >= MAX:
        for key in list(DRAFTS)[: MAX // 4]:
            DRAFTS.pop(key, None)
    draft = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "kind": kind,
        "owner": owner,
        "member_id": None,
        "member_name": member_name,
        "ticket_id": ticket_id,
        "doc_id": doc_id,
        "chat_message_id": chat_message_id,
        "insight_id": None,
        "status": "pending",
        "payload": payload,
        "result": {},
        "raw": "",
        "cost": 0.0,
        "tokens": 0,
        "created_at": now_iso(),
        "expires_at": None,
        "applied_at": None,
        "applied_by": None,
    }
    DRAFTS[draft["id"]] = draft
    return draft


def get(draft_id: str) -> dict[str, Any]:
    """A held result, or `not_found` once it is gone."""
    draft = DRAFTS.get(draft_id)
    if draft is None:
        raise AssistError("not_found", "That draft is gone. Ask again.")
    return draft


def close(draft_id: str, status: str, by: str | None = None) -> dict[str, Any]:
    """Discard or cancel a draft (a draft being written is stopped)."""
    draft = get(draft_id)
    task = TASKS.pop(draft_id, None)
    if task is not None and not task.done():
        task.cancel()
    if draft["status"] in ("pending", "open", "failed"):
        draft["status"] = status
    return draft


def track(draft_id: str, task: asyncio.Task) -> None:
    """Remember the task writing a result, so it can be stopped."""
    TASKS[draft_id] = task
    task.add_done_callback(
        lambda t: TASKS.pop(draft_id, None) if TASKS.get(draft_id) is t else None
    )
