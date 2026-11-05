"""Board AI assistant API (AI v2): settings, the chat (one Claude Code conversation per chat), board health. The
routes keep the paths the UI calls. Drafts to apply are gone: the assistant acts directly with the asker's rights,
so those routes answer 410; the transient results of the editors and the sketch chat stay readable here."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import Project, Ticket
from services import activity as svc_activity
from services.assistant import chat as svc_chat
from services.assistant import drafts as svc_drafts
from services.assistant import editor as svc_editor
from services.assistant import engine
from services.assistant import health as svc_health
from services.assistant import settings as svc_settings
from services.assistant.errors import STATUS, AssistError

router = APIRouter(tags=["ai-assistant"])
Session = Annotated[AsyncSession, Depends(get_session)]
DRAFTS_GONE = "Drafts are gone in AI v2: ask the Board AI in the chat; it does the change itself and says what it did."


async def assist_error_handler(_request: Request, exc: AssistError) -> JSONResponse:
    """`{"detail": message, "code": …}` with the status the code maps to."""
    return JSONResponse(
        status_code=STATUS.get(exc.code, 400),
        content={"detail": str(exc), "code": exc.code, **exc.extra},
    )


def _by() -> str:
    return svc_activity.current_actor() or "user"


async def _project(session: AsyncSession, project_id: str) -> Project:
    p = await session.get(Project, project_id)
    if p is None:
        raise AssistError("not_found", "Project not found.")
    return p


# --------------------------------------------------------------------------- status and settings


@router.get("/projects/{project_id}/ai/assist")
async def get_assist(project_id: str, session: Session) -> dict:
    """Settings › AI for this project plus the dock's state (who answers, features, spend, unseen insights)."""
    await _project(session, project_id)
    out = await svc_settings.describe(session, project_id)
    info = await engine.ready(project_id)
    out["board_ai"]["state"] = info["state"]
    panel = await svc_health.panel(session, project_id)
    out["unseen_insights"] = panel["unseen"]
    out["last_check"] = panel["digest"]["created_at"] if panel["digest"] else None
    from sqlmodel import func, select

    out["ticket_count"] = (
        await session.exec(
            select(func.count())
            .select_from(Ticket)
            .where(Ticket.project_id == project_id)
        )
    ).one()
    out["over_budget"] = False
    return out


class AssistSettingsBody(BaseModel):
    """Board-wide Board AI settings."""

    features: Optional[dict[str, bool]] = None
    language: Optional[str] = None
    tone: Optional[str] = None
    style_guide: Optional[str] = None
    monthly_cap: Optional[float] = None
    per_request_cap: Optional[float] = None
    over_cap: Optional[str] = None
    data_scope: Optional[list[dict[str, Any]] | dict[str, bool]] = None
    excluded_docs: Optional[list[str]] = None
    health: Optional[dict[str, Any]] = None


@router.patch("/projects/{project_id}/ai/assist")
async def patch_assist(
    project_id: str, body: AssistSettingsBody, session: Session
) -> dict:
    """Change the board-wide settings."""
    await _project(session, project_id)
    await svc_settings.update(session, body.model_dump(exclude_unset=True))
    await board_events.publish(board_events.INVALIDATE)
    return await get_assist(project_id, session)


# --------------------------------------------------------------------------- chat


@router.get("/projects/{project_id}/ai/assist/chats")
async def get_chats(project_id: str, session: Session, q: Optional[str] = None) -> dict:
    """The person's chats (private to them)."""
    await _project(session, project_id)
    return await svc_chat.list_chats(session, project_id, _by(), q)


class ChatBody(BaseModel):
    """A new chat."""

    scope: str = "project"
    ticket_id: Optional[str] = None
    doc_id: Optional[str] = None
    scope_id: Optional[str] = None
    member_id: Optional[str] = None
    fresh: bool = False


@router.post("/projects/{project_id}/ai/assist/chats", status_code=201)
async def post_chat(project_id: str, body: ChatBody, session: Session) -> dict:
    """New chat, or the person's latest chat about the same ticket or page."""
    await _project(session, project_id)
    c = await svc_chat.create_chat(session, project_id, _by(), **body.model_dump())
    return await svc_chat.detail(session, c.id, _by())


@router.get("/ai/scopes/{kind}/{scope_id}")
async def get_scope(kind: str, scope_id: str, session: Session) -> dict:
    """The chat panel's state for a ticket, a page or an idea: what it reads and whether this person may ask."""
    return await svc_chat.scope_state(session, kind, scope_id, _by())


class ScopeChatBody(BaseModel):
    """Open the person's chat about a thing."""

    fresh: bool = False


@router.post("/ai/scopes/{kind}/{scope_id}/chat")
async def post_scope_chat(
    kind: str, scope_id: str, session: Session, body: Optional[ScopeChatBody] = None
) -> dict:
    """The person's saved chat about this thing (private to them), or a new one with `fresh`."""
    c = await svc_chat.scope_chat(
        session, kind, scope_id, _by(), fresh=bool(body and body.fresh)
    )
    return await svc_chat.detail(session, c.id, _by())


@router.get("/tickets/{ticket_id}/ai/estimate")
async def get_estimate(
    ticket_id: str, session: Session, member_id: str, mode: str = Query("ask")
) -> dict:
    """What @mentioning an AI team in a comment would do (shown before the comment is sent). Runs on the account's
    subscription: no cost estimate."""
    from models import AiTeam, Member

    t = await session.get(Ticket, ticket_id)
    member = await session.get(Member, member_id)
    if t is None or member is None:
        raise AssistError("not_found", "Ticket or AI team not found.")
    team = await session.get(AiTeam, member_id)
    available = team is not None and not team.paused
    return {
        "member_id": member.id,
        "member_name": member.name,
        "mode": "work" if mode == "work" else "ask",
        "available": available,
        "reason": None
        if available
        else ("Paused" if team is not None else "Not an AI team"),
        "status": None,
        "metered": False,
        "estimate": {"metered": False, "usd": None, "tokens_in": 0, "tokens_out": 0},
        "reads": [
            "The ticket and its comments",
            "Linked pages",
            "The project's folder",
        ],
        "can_edit_code": mode == "work",
        "stops_at": "review",
    }


@router.get("/ai/assist/chats/{chat_id}")
async def get_chat(chat_id: str, session: Session) -> dict:
    """A chat with its messages."""
    return await svc_chat.detail(session, chat_id, _by())


class ChatPatch(BaseModel):
    """Scope switch / include a page."""

    scope: Optional[str] = None
    ticket_id: Optional[str] = None
    doc_id: Optional[str] = None
    include_doc: Optional[str] = None
    member_id: Optional[str] = None


@router.patch("/ai/assist/chats/{chat_id}")
async def patch_chat(chat_id: str, body: ChatPatch, session: Session) -> dict:
    """Change what the chat is about, or include a page for it."""
    await svc_chat.update_chat(
        session, chat_id, _by(), body.model_dump(exclude_unset=True)
    )
    return await svc_chat.detail(session, chat_id, _by())


@router.delete("/ai/assist/chats/{chat_id}", status_code=204)
async def del_chat(chat_id: str, session: Session) -> None:
    """Delete a chat."""
    await svc_chat.delete_chat(session, chat_id, _by())


class MessageBody(BaseModel):
    """A question."""

    text: str
    draft: bool = False
    send_all: bool = False
    doc_ids: list[str] = []
    filters: dict[str, Any] = {}
    mode: str = "ask"
    member_id: Optional[str] = None
    member_form: Optional[dict[str, Any]] = None


@router.post("/ai/assist/chats/{chat_id}/messages")
async def post_message(chat_id: str, body: MessageBody, session: Session) -> dict:
    """Ask; the answer is written into the returned AI message (poll it)."""
    return await svc_chat.send(
        session, chat_id, _by(), body.text, doc_ids=body.doc_ids, mode=body.mode
    )


@router.get("/ai/assist/messages/{message_id}")
async def get_message(message_id: str, session: Session) -> dict:
    """One message (polled while it is written)."""
    return await svc_chat.get_message(session, message_id, _by())


class FeedbackBody(BaseModel):
    """Thumbs up / down on an answer (None clears it)."""

    thumb: Optional[str] = None
    reason: str = ""


@router.post("/ai/assist/messages/{message_id}/feedback")
async def post_feedback(message_id: str, body: FeedbackBody, session: Session) -> dict:
    """Keep the asker's verdict on an answer."""
    return await svc_chat.set_feedback(
        session, message_id, _by(), body.thumb, body.reason
    )


@router.post("/ai/assist/messages/{message_id}/stop")
async def post_stop(message_id: str, session: Session) -> dict:
    """Stop the answer."""
    return await svc_chat.stop(session, message_id, _by())


class RetryBody(BaseModel):
    """Try again, or Continue."""

    send_all: bool = False
    continue_: bool = Field(default=False, alias="continue")


@router.post("/ai/assist/messages/{message_id}/retry")
async def post_retry(
    message_id: str, session: Session, body: Optional[RetryBody] = None
) -> dict:
    """Try again: the same question, answered again."""
    return await svc_chat.retry(
        session, message_id, _by(), continue_=bool(body and body.continue_)
    )


class PostCommentBody(BaseModel):
    """Post an answer as a comment (optionally edited first)."""

    text: Optional[str] = None


@router.post("/ai/assist/messages/{message_id}/post-comment")
async def post_message_as_comment(
    message_id: str, session: Session, body: Optional[PostCommentBody] = None
) -> dict:
    """ "Post as comment": share a ticket chat answer with the team, as a comment with the AI badge."""
    return await svc_chat.post_as_comment(
        session, message_id, _by(), body.text if body else None
    )


# --------------------------------------------------------------------------- drafts (gone, except editor results)


@router.post("/projects/{project_id}/ai/assist/drafts", status_code=410)
async def post_draft(project_id: str) -> None:
    """Gone: the Board AI no longer prepares drafts to apply."""
    raise HTTPException(status_code=410, detail=DRAFTS_GONE)


@router.get("/ai/assist/drafts/{draft_id}")
async def get_draft(draft_id: str) -> dict:
    """A result of an editor or the sketch chat (polled while it is written)."""
    return svc_drafts.get(draft_id)


@router.get("/tickets/{ticket_id}/ai/assist/drafts")
async def get_ticket_drafts(ticket_id: str) -> list[dict]:
    """No drafts any more: an empty list, so the ticket renders."""
    return []


@router.get("/projects/{project_id}/ai/assist/drafts")
async def get_project_drafts(project_id: str) -> list[dict]:
    """No drafts any more: an empty list, so pages render."""
    return []


@router.post("/ai/assist/drafts/{draft_id}/discard")
async def post_discard(draft_id: str) -> dict:
    """Discard a result of an editor or the sketch chat."""
    return svc_drafts.close(draft_id, "discarded", _by())


@router.post("/ai/assist/drafts/{draft_id}/cancel")
async def post_cancel(draft_id: str) -> dict:
    """Stop a result that is being written."""
    return svc_drafts.close(draft_id, "cancelled", _by())


@router.post("/ai/assist/drafts/{draft_id}/regenerate")
async def post_regenerate(draft_id: str) -> dict:
    """Try again: the same editor request, written again."""
    return await svc_editor.again(draft_id, _by())


@router.post("/ai/assist/drafts/{draft_id}/{action}", status_code=410)
async def post_draft_action(draft_id: str, action: str) -> None:
    """Gone: apply, undo and request-apply belonged to drafts the Board AI prepared."""
    raise HTTPException(status_code=410, detail=DRAFTS_GONE)


@router.patch("/ai/assist/drafts/{draft_id}", status_code=410)
async def patch_draft(draft_id: str) -> None:
    """Gone with the drafts."""
    raise HTTPException(status_code=410, detail=DRAFTS_GONE)


# --------------------------------------------------------------------------- matching (the assistant does it when asked)


@router.get("/projects/{project_id}/ai/assist/similar")
async def get_similar(project_id: str, text: str = Query("")) -> list[dict]:
    """Similar tickets were found by the old matcher; the assistant now says so when asked. Empty list."""
    return []


@router.get("/projects/{project_id}/ai/assist/assignees")
async def get_assignees(
    project_id: str, text: str = Query(""), ticket_id: Optional[str] = None
) -> list[dict]:
    """Suggested assignees came from the old matcher. Empty list."""
    return []


@router.get("/tickets/{ticket_id}/ai/assist/coverage")
async def get_coverage(ticket_id: str, session: Session) -> dict:
    """Test cases by acceptance criterion (no model): which criteria have a test case."""
    import json as _json

    t = await session.get(Ticket, ticket_id)
    if t is None:
        raise AssistError("not_found", "Ticket not found.")
    criteria = _json.loads(t.acceptance_criteria or "[]")
    cases = _json.loads(t.test_cases or "[]")
    cov = [
        {
            "index": n,
            "id": c.get("id"),
            "text": c.get("text") or "",
            "cases": [
                tc.get("code") or tc.get("title") or ""
                for tc in cases
                if tc.get("criterion_id") == c.get("id")
            ],
        }
        for n, c in enumerate(criteria)
    ]
    return {
        "coverage": cov,
        "covered": len([c for c in cov if c["cases"]]),
        "total": len(cov),
    }


# --------------------------------------------------------------------------- board health


@router.get("/projects/{project_id}/ai/assist/health")
async def get_health(project_id: str, session: Session) -> dict:
    """The Board health panel."""
    await _project(session, project_id)
    return await svc_health.panel(session, project_id)


@router.get("/projects/{project_id}/ai/assist/chips")
async def get_chips(project_id: str, session: Session) -> list[dict]:
    """Insight chips for board cards."""
    return await svc_health.chips(session, project_id)


@router.post("/projects/{project_id}/ai/assist/health/run")
async def post_health_run(project_id: str, session: Session) -> dict:
    """Run the check now: the assistant reads the board."""
    await _project(session, project_id)
    return await svc_health.check(project_id, _by())


@router.post("/projects/{project_id}/ai/assist/health/seen")
async def post_health_seen(project_id: str, session: Session) -> dict:
    """The panel was opened."""
    await svc_health.mark_seen(session, project_id)
    return {"ok": True}


@router.post("/projects/{project_id}/ai/assist/health/snooze-all")
async def post_snooze_all(project_id: str, session: Session) -> dict:
    """Snooze every open insight for a day."""
    return {"snoozed": await svc_health.snooze_all(session, project_id)}


class InsightBody(BaseModel):
    """Snooze length."""

    hours: int = 24


@router.post("/ai/assist/insights/{insight_id}/{action}")
async def post_insight(
    insight_id: str, action: str, session: Session, body: Optional[InsightBody] = None
) -> dict:
    """snooze | dismiss | restore (`act` made a draft: 410)."""
    return await svc_health.set_state(
        session, insight_id, action, hours=body.hours if body else 24
    )
