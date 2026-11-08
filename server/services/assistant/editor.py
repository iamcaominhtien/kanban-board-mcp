"""AI in every editor on the assistant engine (AI v2): the /ai menu and the selection bar. A request is one turn
with the `editor-write` skill; its result is held (services/assistant/drafts.py) until the person accepts it into
their text or discards it. Nothing is written for them, except an accepted list of criteria added to the ticket."""

import asyncio
import logging
from typing import Any

from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from services import tickets as svc_tickets

from . import drafts, engine
from . import settings as svc_settings
from .errors import AssistError

logger = logging.getLogger("kanban.assistant.editor")

# action: (label, hint, what the result is, the skill's action)
ACTIONS: dict[str, tuple[str, str, str, str]] = {
    "improve": ("Improve", "Clearer and tighter, same meaning", "replace", "rewrite"),
    "shorten": ("Shorten", "The same, in fewer words", "replace", "shorten"),
    "fix_spelling": ("Fix spelling", "Spelling and grammar only", "replace", "fix"),
    "explain": ("Explain", "In plain words, as an answer", "answer", "custom"),
    "ask": (
        "Ask AI…",
        "Write from a prompt, with this page as context",
        "replace",
        "write",
    ),
    "continue": ("Continue writing", "Carry on from the cursor", "insert", "continue"),
    "summarise": (
        "Summarise",
        "The text above, as a short list",
        "insert",
        "summarise",
    ),
    "criteria": (
        "Draft acceptance criteria",
        "From this description (tickets only)",
        "list",
        "list_criteria",
    ),
    "translate": ("Translate…", "The paragraph above", "replace", "translate"),
    "split": ("Split", "One criterion into several", "list", "list_criteria"),
    "more_criteria": (
        "Draft more",
        "Criteria that are not covered yet",
        "list",
        "list_criteria",
    ),
}
BAR = ["improve", "shorten", "fix_spelling", "explain", "ask"]
SURFACES: dict[str, dict[str, Any]] = {
    "ticket_description": {
        "label": "Ticket description",
        "menu": ["ask", "continue", "summarise", "criteria", "translate"],
        "bar": BAR,
    },
    "acceptance_criteria": {
        "label": "Acceptance criteria",
        "menu": ["improve", "split", "more_criteria"],
        "bar": ["improve", "split"],
    },
    "comment": {
        "label": "Comment box",
        "menu": ["improve", "translate", "summarise"],
        "bar": BAR,
    },
    "doc": {
        "label": "Docs page",
        "menu": ["ask", "continue", "summarise", "translate"],
        "bar": BAR,
    },
    "idea": {
        "label": "Idea page",
        "menu": ["ask", "continue", "summarise", "translate"],
        "bar": BAR,
    },
    "debug_note": {
        "label": "Debug notes",
        "menu": ["improve", "summarise", "translate"],
        "bar": ["improve", "summarise", "translate"],
    },
    "test_case": {
        "label": "Test case note",
        "menu": ["ask", "continue", "summarise", "translate"],
        "bar": BAR,
    },
}
DOC_SURFACES = ("doc", "idea")
MAX_SELECTION = 12000
MAX_AROUND = 2000
MAX_PROMPT = 2000
EXTRA = {
    "explain": "Explain the selection in plain words, as an answer (do not rewrite it).",
    "split": "Split the selected criterion into several smaller criteria.",
    "more_criteria": "Draft acceptance criteria that the existing ones (in `before`) do not cover yet.",
}


def _info(action: str) -> dict[str, str]:
    label, hint, result, _skill_action = ACTIONS[action]
    return {"action": action, "label": label, "hint": hint, "result": result}


def _surface(surface: str) -> dict[str, Any]:
    if surface not in SURFACES:
        raise AssistError("invalid", "Unknown editor.")
    return SURFACES[surface]


async def state(session: AsyncSession, project_id: str, surface: str) -> dict[str, Any]:
    """Whether AI is available in this editor, its /ai menu and its selection bar."""
    spec = _surface(surface)
    feature = "docs" if surface in DOC_SURFACES else "drafting"
    info = await engine.ready(project_id)
    if not await svc_settings.feature_on(session, feature):
        availability = {
            "code": "feature_off",
            "message": "AI in editors is off in Settings › AI.",
        }
    elif info["state"] != "ready":
        availability = {"code": "not_configured", "message": info["message"]}
    else:
        availability = {"code": "ok"}
    return {
        "surface": surface,
        "label": spec["label"],
        "availability": availability,
        "menu": [_info(a) for a in spec["menu"]],
        "bar": [_info(a) for a in spec["bar"]],
        "estimate": None,
        "member_id": None,
    }


def _check(body: dict[str, Any]) -> dict[str, Any]:
    spec = _surface(body.get("surface") or "")
    action = body.get("action") or ""
    if action not in ACTIONS or action not in {*spec["menu"], *spec["bar"]}:
        raise AssistError("invalid", "This editor does not offer that.")
    if len(body.get("selection") or "") > MAX_SELECTION:
        raise AssistError("too_large", "The selection is too long: select less text.")
    if len(body.get("prompt") or "") > MAX_PROMPT:
        raise AssistError(
            "too_large", f"Keep the instruction under {MAX_PROMPT} characters."
        )
    if action == "ask" and not (body.get("prompt") or "").strip():
        raise AssistError("invalid", "Write what you want first.")
    if (
        action in ("improve", "shorten", "fix_spelling", "explain", "split")
        and not (body.get("selection") or "").strip()
    ):
        raise AssistError("invalid", "Select some text first.")
    return body


def preview(body: dict[str, Any]) -> dict[str, Any]:
    """ "What will be sent": the pieces of this request. The assistant may also read the ticket or the page itself."""
    body = _check(body)
    pieces = []
    for kind, label, text in (
        (
            "instruction",
            "Your instruction",
            body.get("prompt") or ACTIONS[body["action"]][0],
        ),
        ("selection", "Selected text", body.get("selection") or ""),
        ("before", "Text before the cursor", (body.get("before") or "")[-MAX_AROUND:]),
        ("after", "Text after the cursor", (body.get("after") or "")[:MAX_AROUND]),
    ):
        if text:
            pieces.append(
                {
                    "kind": kind,
                    "label": label,
                    "chars": len(text),
                    "tokens": len(text) // 4 + 1,
                    "preview": text[:200],
                }
            )
    include = body.get("include") or {}
    if body.get("ticket_id") and include.get("ticket", True):
        pieces.append(
            {
                "kind": "ticket",
                "label": f"Ticket {body['ticket_id']} (read by the assistant)",
                "chars": 0,
                "tokens": 0,
                "preview": "",
            }
        )
    if (body.get("doc_id") or body.get("idea_id")) and include.get("page", True):
        pieces.append(
            {
                "kind": "page",
                "label": "This page (read by the assistant)",
                "chars": 0,
                "tokens": 0,
                "preview": "",
            }
        )
    return {
        "pieces": pieces,
        "tokens": sum(p["tokens"] for p in pieces),
        "estimate": None,
        "private_skipped": [],
        "never_sent": ["Passwords, API keys and files outside the board"],
    }


async def start(
    session: AsyncSession, project_id: str, body: dict[str, Any], by: str
) -> dict[str, Any]:
    """Ask for a draft: it is written in the background (poll it); the text is not touched."""
    body = _check(body)
    surface = body["surface"]
    feature = "docs" if surface in DOC_SURFACES else "drafting"
    if not await svc_settings.feature_on(session, feature):
        raise AssistError("feature_off", "AI in editors is off in Settings › AI.")
    info = await engine.ready(project_id)
    if info["state"] != "ready":
        raise AssistError("not_configured", info["message"])
    draft = drafts.new(
        project_id,
        "editor_doc" if surface in DOC_SURFACES else "editor",
        by,
        {"input": body, "action": body["action"], "result": None},
        ticket_id=body.get("ticket_id"),
        doc_id=body.get("doc_id"),
    )
    drafts.track(draft["id"], asyncio.create_task(_write(draft["id"], feature)))
    return draft


def _items(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        line = line.strip().lstrip("-*•").strip()
        if line[:3].lower() in ("[ ]", "[x]"):
            line = line[3:].strip()
        if line and line[0].isdigit() and "." in line[:4]:
            line = line.split(".", 1)[1].strip()
        if line:
            out.append(line)
    return out


async def _write(draft_id: str, feature: str, continue_from: str = "") -> None:
    draft = drafts.DRAFTS.get(draft_id)
    if draft is None:
        return
    body = draft["payload"]["input"]
    action = body["action"]
    include = body.get("include") or {}
    inputs = {
        "surface": body["surface"],
        "action": ACTIONS[action][3],
        "selection": body.get("selection") if include.get("selection", True) else None,
        "before": (body.get("before") or "")[-MAX_AROUND:],
        "after": (body.get("after") or "")[:MAX_AROUND],
        "prompt": " ".join(
            x for x in (EXTRA.get(action, ""), body.get("prompt") or "") if x
        ),
        "language": body.get("language"),
        "ticket_id": body.get("ticket_id") if include.get("ticket", True) else None,
        "doc_id": body.get("doc_id") if include.get("page", True) else None,
        "idea_id": body.get("idea_id") if include.get("page", True) else None,
        "continue_from": continue_from or None,
    }
    try:
        out = await engine.turn(
            draft["project_id"],
            name=f"editor:{draft_id}",
            skill="editor-write",
            inputs=inputs,
            by=draft["owner"],
            feature=feature,
            ticket_id=body.get("ticket_id"),
            timeout_s=180.0,
        )
    except asyncio.CancelledError:
        draft["status"] = "cancelled"
        raise
    except AssistError as exc:
        draft["status"], draft["result"] = (
            "failed",
            {"error": {"code": exc.code, "message": str(exc)}},
        )
        return
    draft["cost"] = round(draft["cost"] + out.cost, 6)
    draft["tokens"] += out.tokens_in + out.tokens_out
    draft["member_name"] = out.member
    if out.state != "finished":
        draft["status"] = "cancelled" if out.state == "cancelled" else "failed"
        draft["result"] = {
            "error": {
                "code": "unavailable",
                "message": out.error or "The assistant could not write this.",
            }
        }
        return
    text = (out.data().get("text") or out.text or "").strip()
    if not text:
        draft["status"], draft["result"] = (
            "failed",
            {
                "error": {
                    "code": "invalid_output",
                    "message": "The assistant wrote nothing. Try again.",
                }
            },
        )
        return
    kind = ACTIONS[action][2]
    result: dict[str, Any] = {"kind": kind, "cut_short": False}
    if kind == "list":
        result["items"] = _items(text)
    else:
        result["text"] = (continue_from + text) if continue_from else text
    draft["raw"] = text
    draft["payload"]["result"] = result
    draft["status"] = "open"
    await board_events.publish(board_events.INVALIDATE)


async def accept(
    draft_id: str, by: str, items: list[str] | None = None
) -> dict[str, Any]:
    """Accept: the editor has put the text in. An accepted list of criteria is added to the ticket."""
    draft = drafts.get(draft_id)
    if draft["owner"] != by:
        raise AssistError("forbidden", "This draft is someone else's.")
    if draft["status"] != "open":
        raise AssistError("conflict", "This draft is not ready or was already closed.")
    result = draft["payload"].get("result") or {}
    created: list[str] = []
    body = draft["payload"]["input"]
    if (
        result.get("kind") == "list"
        and draft["ticket_id"]
        and body["surface"] in ("ticket_description", "acceptance_criteria")
    ):
        async with database.async_session() as session:
            for item in items if items is not None else result.get("items") or []:
                item = (item or "").strip()
                if (
                    item
                    and await svc_tickets.add_acceptance_criterion(
                        session, draft["ticket_id"], item
                    )
                    is not None
                ):
                    created.append(item)
        await board_events.publish(board_events.INVALIDATE)
    draft["status"], draft["applied_by"] = "applied", by
    from services.ai.store import now_iso

    draft["applied_at"] = now_iso()
    out: dict[str, Any] = {"draft": draft}
    if created:
        out["created"] = created
    return out


async def again(draft_id: str, by: str, *, go_on: bool = False) -> dict[str, Any]:
    """Try again (the same request, written again) or Continue (carry on from what it has)."""
    draft = drafts.get(draft_id)
    if draft["owner"] != by:
        raise AssistError("forbidden", "This draft is someone else's.")
    if draft["status"] == "pending":
        return draft
    if draft["kind"] not in ("editor", "editor_doc"):
        raise AssistError("invalid", "This draft cannot be written again.")
    before = ((draft["payload"].get("result") or {}).get("text") or "") if go_on else ""
    draft["status"], draft["result"] = "pending", {}
    feature = "docs" if draft["kind"] == "editor_doc" else "drafting"
    drafts.track(draft_id, asyncio.create_task(_write(draft_id, feature, before)))
    return draft
