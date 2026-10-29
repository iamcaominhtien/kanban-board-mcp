"""Board AI assistant API (design/screens/ai-board-assistant.md): settings, chat, drafts, board health, similar tickets
and suggested assignees. Errors carry a `code` the UI maps to a state (not configured, over budget, viewer, conflict…)."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import AiDraft, Project, Ticket
from services import activity as svc_activity
from services.ai.assist import chat as svc_chat
from services.ai.assist import drafts as svc_drafts
from services.ai.assist import health as svc_health
from services.ai.assist import match as svc_match
from services.ai.assist import settings as svc_settings
from services.ai.assist.settings import AssistError

router = APIRouter(tags=["ai-assistant"])
Session = Annotated[AsyncSession, Depends(get_session)]

STATUS = {
    "not_found": 404,
    "invalid": 422,
    "invalid_output": 422,
    "no_criteria": 422,
    "viewer": 403,
    "forbidden": 403,
    "conflict": 409,
    "apply_failed": 409,
    "feature_off": 409,
    "not_configured": 409,
    "unavailable": 409,
    "over_budget": 409,
    "not_shared": 409,
}


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
    """Settings → AI for this project plus the dock's state (Board AI, features, budget, unseen insights, empty)."""
    await _project(session, project_id)
    out = await svc_settings.describe(session, project_id)
    panel = await svc_health.panel(session, project_id)
    out["unseen_insights"] = panel["unseen"]
    out["last_check"] = panel["digest"]["created_at"] if panel["digest"] else None
    out["ticket_count"] = await svc_settings.ticket_count(session, project_id)
    over = (
        out["monthly_cap"] is not None
        and out["over_cap"] == "pause"
        and out["board_ai"]["metered"]
        and out["used_month"] >= out["monthly_cap"]
    )
    out["over_budget"] = over
    return out


class AssistSettingsBody(BaseModel):
    """Board-wide Board AI settings (H)."""

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
    from events import INVALIDATE, publish

    await publish(INVALIDATE)
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


@router.post("/projects/{project_id}/ai/assist/chats", status_code=201)
async def post_chat(project_id: str, body: ChatBody, session: Session) -> dict:
    """New chat."""
    c = await svc_chat.create_chat(
        session,
        project_id,
        _by(),
        scope=body.scope,
        ticket_id=body.ticket_id,
        doc_id=body.doc_id,
    )
    return await svc_chat.chat_detail(session, c.id, _by())


@router.get("/ai/assist/chats/{chat_id}")
async def get_chat(chat_id: str, session: Session) -> dict:
    """A chat with its messages."""
    return await svc_chat.chat_detail(session, chat_id, _by())


class ChatPatch(BaseModel):
    """Scope switch / include a private doc."""

    scope: Optional[str] = None
    ticket_id: Optional[str] = None
    doc_id: Optional[str] = None
    include_doc: Optional[str] = None


@router.patch("/ai/assist/chats/{chat_id}")
async def patch_chat(chat_id: str, body: ChatPatch, session: Session) -> dict:
    """Change the chat's scope or include a private doc for it."""
    await svc_chat.update_chat(
        session, chat_id, _by(), body.model_dump(exclude_unset=True)
    )
    return await svc_chat.chat_detail(session, chat_id, _by())


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
    member_form: Optional[dict[str, Any]] = None


@router.post("/ai/assist/chats/{chat_id}/messages")
async def post_message(chat_id: str, body: MessageBody, session: Session) -> dict:
    """Ask; the answer streams into the returned AI message."""
    return await svc_chat.send(
        session,
        chat_id,
        _by(),
        body.text,
        draft_request=body.draft,
        send_all=body.send_all,
        doc_ids=body.doc_ids,
        filters=body.filters,
        member_form=body.member_form,
    )


@router.get("/ai/assist/messages/{message_id}")
async def get_message(message_id: str, session: Session) -> dict:
    """One message (polled while it streams)."""
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
    """Stop: the partial text is kept."""
    return await svc_chat.stop(session, message_id, _by())


class RetryBody(BaseModel):
    """Try again, Send now, or Send all."""

    send_all: bool = False


@router.post("/ai/assist/messages/{message_id}/retry")
async def post_retry(message_id: str, body: RetryBody, session: Session) -> dict:
    """Try again (also "Send now" on a rate limit and "Send all" on a truncated context)."""
    return await svc_chat.retry(session, message_id, _by(), send_all=body.send_all)


# --------------------------------------------------------------------------- drafts


class DraftBody(BaseModel):
    """Start a draft."""

    kind: str
    ticket_id: Optional[str] = None
    doc_id: Optional[str] = None
    data: dict[str, Any] = {}


@router.post("/projects/{project_id}/ai/assist/drafts", status_code=201)
async def post_draft(project_id: str, body: DraftBody, session: Session) -> dict:
    """Ask the Board AI for a draft; it is written in the background (poll it)."""
    await _project(session, project_id)
    d = await svc_drafts.start(
        session,
        project_id=project_id,
        kind=body.kind,
        owner=_by(),
        ticket_id=body.ticket_id,
        doc_id=body.doc_id,
        data=body.data,
    )
    return svc_drafts.describe(d)


@router.get("/ai/assist/drafts/{draft_id}")
async def get_draft(draft_id: str, session: Session) -> dict:
    """A draft (with any conflict found since it was written)."""
    d = await svc_drafts._get(session, draft_id)
    out = svc_drafts.describe(d)
    if d.status == "open":
        out["conflicts"] = await svc_drafts.conflicts(session, d)
        out["viewer"] = (
            await svc_drafts.role_of(session, d.project_id, _by()) == "viewer"
        )
        out["lead"] = await svc_drafts.project_lead(session, d.project_id)
    return out


@router.get("/tickets/{ticket_id}/ai/assist/drafts")
async def get_ticket_drafts(ticket_id: str, session: Session) -> list[dict]:
    """Drafts on a ticket, newest first."""
    return [
        svc_drafts.describe(d) for d in await svc_drafts.for_ticket(session, ticket_id)
    ]


class ApplyBody(BaseModel):
    """What the person accepted."""

    selected: Optional[list[int]] = None
    edits: Optional[dict[str, str]] = None
    hunks: Optional[list[str]] = None
    titles: Optional[dict[str, str]] = None
    update_parent: bool = False
    fields: Optional[dict[str, Any]] = None
    detail: Optional[dict[str, Any]] = None
    force: bool = False


@router.post("/ai/assist/drafts/{draft_id}/apply")
async def post_apply(draft_id: str, body: ApplyBody, session: Session) -> dict:
    """Apply / Accept / Create Ticket / Insert: the only write, done as the person."""
    d = await svc_drafts.apply(
        session, draft_id, _by(), body.model_dump(exclude_unset=True)
    )
    return svc_drafts.describe(d)


@router.post("/ai/assist/drafts/{draft_id}/undo")
async def post_undo(draft_id: str, session: Session) -> dict:
    """Undo an applied draft."""
    return svc_drafts.describe(await svc_drafts.undo(session, draft_id, _by()))


@router.post("/ai/assist/drafts/{draft_id}/discard")
async def post_discard(draft_id: str, session: Session) -> dict:
    """Discard."""
    return svc_drafts.describe(await svc_drafts.discard(session, draft_id))


@router.post("/ai/assist/drafts/{draft_id}/cancel")
async def post_cancel_draft(draft_id: str, session: Session) -> dict:
    """Stop a draft that is still being written."""
    return svc_drafts.describe(await svc_drafts.cancel(session, draft_id))


class RegenerateBody(BaseModel):
    """Regenerate (with feedback, one field, or past the per-request cap)."""

    feedback: Optional[str] = None
    field: Optional[str] = None
    allow_more: bool = False


@router.post("/ai/assist/drafts/{draft_id}/regenerate")
async def post_regenerate(
    draft_id: str, body: RegenerateBody, session: Session
) -> dict:
    """Regenerate, Ask for changes, Refresh draft, Regenerate field, Continue."""
    d = await svc_drafts.regenerate(
        session,
        draft_id,
        feedback=body.feedback,
        field=body.field,
        allow_more=body.allow_more,
    )
    return svc_drafts.describe(d)


class EditBody(BaseModel):
    """Edits made before applying."""

    payload: dict[str, Any]


@router.patch("/ai/assist/drafts/{draft_id}")
async def patch_draft(draft_id: str, body: EditBody, session: Session) -> dict:
    """Edit a draft (comment text, titles, selection)."""
    return svc_drafts.describe(await svc_drafts.edit(session, draft_id, body.payload))


@router.post("/ai/assist/drafts/{draft_id}/request-apply")
async def post_request_apply(draft_id: str, session: Session) -> dict:
    """A viewer asks the project lead to apply the draft."""
    return await svc_drafts.request_apply(session, draft_id, _by())


# --------------------------------------------------------------------------- matching


@router.get("/projects/{project_id}/ai/assist/similar")
async def get_similar(
    project_id: str,
    session: Session,
    text: str = Query(""),
    exclude: Optional[str] = None,
) -> list[dict]:
    """Tickets that look like a sentence (duplicate check)."""
    return await svc_match.similar(session, project_id, text, exclude=exclude)


@router.get("/projects/{project_id}/ai/assist/assignees")
async def get_assignees(
    project_id: str,
    session: Session,
    text: str = Query(""),
    ticket_id: Optional[str] = None,
) -> list[dict]:
    """Suggested assignees with reasons (C5)."""
    if ticket_id and not text:
        t = await session.get(Ticket, ticket_id)
        text = f"{t.title} {t.description}" if t else ""
    return await svc_match.suggest_assignee(
        session, project_id, text, exclude_ticket=ticket_id
    )


@router.get("/tickets/{ticket_id}/ai/assist/coverage")
async def get_coverage(ticket_id: str, session: Session) -> dict:
    """Coverage by acceptance criterion (E2)."""
    t = await session.get(Ticket, ticket_id)
    if t is None:
        raise AssistError("not_found", "Ticket not found.")
    cov = svc_drafts.coverage(t)
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
    """Run the check now."""
    await _project(session, project_id)
    return await svc_health.check(project_id)


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
    insight_id: str, action: str, body: InsightBody, session: Session
) -> dict:
    """act | snooze | dismiss | restore."""
    if action == "act":
        return await svc_health.act(session, insight_id, _by())
    return await svc_health.set_state(session, insight_id, action, hours=body.hours)


@router.get("/projects/{project_id}/ai/assist/drafts")
async def get_project_drafts(
    project_id: str,
    session: Session,
    kind: Optional[str] = None,
    doc_id: Optional[str] = None,
) -> list[dict]:
    """Open drafts of a project (e.g. a doc's dashed blocks)."""
    from sqlmodel import col, select

    stmt = select(AiDraft).where(AiDraft.project_id == project_id)
    if kind:
        stmt = stmt.where(AiDraft.kind == kind)
    if doc_id:
        stmt = stmt.where(AiDraft.doc_id == doc_id)
    rows = (
        await session.exec(stmt.order_by(col(AiDraft.created_at).desc()).limit(50))
    ).all()
    return [svc_drafts.describe(d) for d in rows]
