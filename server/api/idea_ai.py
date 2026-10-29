"""REST API of the optional AI helpers of the Idea Space (design: `design/screens/idea-ai-help.md`).

Every helper only suggests. Switches are per project and off by default; with AI off nothing here is needed and
the rest of the Idea Space works unchanged.
"""

import json
from typing import Annotated, Any, Literal, NoReturn

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from api.idea_space import _fail
from database import get_session
from models import IdeaTicket, Member
from services import activity as act
from services import idea_ai

from services.docs_access import role_in

router = APIRouter(prefix="/api/idea-ai", tags=["idea-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _ai_error(exc: idea_ai.IdeaAiError) -> NoReturn:
    _fail(409, exc.code, str(exc), **exc.extra)


async def _need_member(session: AsyncSession, project_id: str | None) -> None:
    """Only members can ask the AI; viewers can still read what was suggested."""
    if project_id is None or act.current_actor() in (act.HUMAN_ACTOR, act.AGENT_ACTOR):
        return
    rows = await session.exec(select(Member).where(Member.project_id == project_id))
    if role_in(list(rows.all()), act.current_actor()) not in ("member", "admin"):
        _fail(
            403,
            "not_member",
            "Only members can ask the AI. You can still read what it suggested.",
        )


async def _need_admin(session: AsyncSession, project_id: str | None) -> None:
    actor = act.current_actor()
    if project_id is None or actor == act.HUMAN_ACTOR:
        return
    rows = await session.exec(select(Member).where(Member.project_id == project_id))
    if role_in(list(rows.all()), actor) != "admin":
        _fail(403, "read_only", "Only project admins change the AI settings.")


def _scope(project_id: str | None) -> str:
    return "project" if project_id else "all"


@router.get("/status")
async def get_status(session: Session, project_id: str | None = None) -> dict[str, Any]:
    """Whether AI help is available for the project (or for ideas with no project), and why not."""
    return await idea_ai.status(session, project_id)


class SettingsBody(BaseModel):
    """Switches of the AI helpers; omitted values stay as they are."""

    enabled: bool | None = None
    triage_advice: bool | None = None
    weekly_grooming: bool | None = None
    ask: bool | None = None
    read_docs: bool | None = None
    read_repo: bool | None = None
    daily_cap: float | None = Field(default=None, gt=0, le=1000)


@router.get("/settings")
async def get_settings_route(
    session: Session, project_id: str | None = None
) -> dict[str, Any]:
    """The AI settings and the status of the project's Board AI."""
    return await idea_ai.status(session, project_id)


@router.put("/settings")
async def put_settings(
    body: SettingsBody, session: Session, project_id: str | None = None
) -> dict[str, Any]:
    """Change the AI switches of a project (admins)."""
    await _need_admin(session, project_id)
    try:
        await idea_ai.update_settings(
            session, project_id, **body.model_dump(exclude_unset=True)
        )
    except ValueError as exc:
        _fail(400, "invalid", str(exc))
    return await idea_ai.status(session, project_id)


class AdviceBody(BaseModel):
    """Ask for triage advice on Inbox ideas."""

    idea_ids: list[str] = Field(min_length=1, max_length=30)


@router.post("/advice")
async def post_advice(body: AdviceBody, session: Session) -> dict[str, Any]:
    """Read the ideas and suggest Keep, Park, Merge or Archive for each. Nothing is applied. An idea the AI is not
    sure about gets no advice (it is listed in `none`)."""
    advice, none, errors = [], [], []
    for idea_id in body.idea_ids:
        idea = await session.get(IdeaTicket, idea_id)
        if idea is None:
            errors.append(
                {"idea_id": idea_id, "code": "not_found", "message": "Idea not found"}
            )
            continue
        await _need_member(session, idea.project_id)
        try:
            found = await idea_ai.advise(session, idea_id, person=act.current_actor())
        except idea_ai.IdeaAiError as exc:
            if exc.code in ("off", "no_member", "unavailable", "cap"):
                _ai_error(exc)  # nothing else can work either
            errors.append({"idea_id": idea_id, "code": exc.code, "message": str(exc)})
            continue
        (none.append(idea_id) if found is None else advice.append(found.id))
    return {
        "advice": await idea_ai.advice_for(session, body.idea_ids),
        "none": none,
        "errors": errors,
    }


@router.get("/advice")
async def get_advice(
    session: Session, idea_ids: Annotated[list[str], Query()]
) -> list[dict[str, Any]]:
    """Open advice for the ideas, each marked `stale` when the idea changed after the AI read it."""
    return await idea_ai.advice_for(session, idea_ids)


class AdviceState(BaseModel):
    """What happened to a piece of advice."""

    state: Literal["accepted", "ignored"]


@router.post("/advice/{advice_id}/state")
async def post_advice_state(
    advice_id: str, body: AdviceState, session: Session
) -> dict[str, Any]:
    """Mark advice accepted or ignored (the person did the move themselves, with the usual dialogs)."""
    try:
        a = await idea_ai.set_advice_state(session, advice_id, body.state)
    except ValueError as exc:
        _fail(404, "not_found", str(exc))
    return {"id": a.id, "state": a.state}


class AskBody(BaseModel):
    """A question about the ideas in view."""

    question: str = Field(min_length=1, max_length=1000)
    project_id: str | None = None
    scope: Literal["project", "all", "none"] = "project"


@router.post("/ask")
async def post_ask(body: AskBody, session: Session) -> dict[str, Any]:
    """Ask about ideas ("what should we test next?"). The answer lists the ideas it used."""
    await _need_member(session, body.project_id)
    try:
        return await idea_ai.ask(
            session,
            body.question,
            project_id=body.project_id,
            scope=body.scope if body.project_id or body.scope != "project" else "all",
            person=act.current_actor(),
        )
    except idea_ai.IdeaAiError as exc:
        _ai_error(exc)


class ShapeBody(BaseModel):
    """What to help with on an idea page."""

    idea_id: str
    kind: Literal["problem", "assumptions", "tests", "effort", "exists", "ask"]
    question: str | None = Field(default=None, max_length=1000)


@router.post("/shape")
async def post_shape(body: ShapeBody, session: Session) -> dict[str, Any]:
    """Draft the problem, assumptions, cheapest tests, an effort guess, what already exists, or an answer. The
    drafts come back; a person adds each one (with the AI chip) from the page."""
    idea = await session.get(IdeaTicket, body.idea_id)
    if idea is None:
        _fail(404, "not_found", f"Idea ticket '{body.idea_id}' not found")
    await _need_member(session, idea.project_id)
    try:
        return await idea_ai.shape(
            session,
            body.idea_id,
            body.kind,
            question=body.question,
            person=act.current_actor(),
        )
    except idea_ai.IdeaAiError as exc:
        _ai_error(exc)
    except ValueError as exc:
        _fail(400, "invalid", str(exc))


class PrepareBody(BaseModel):
    """The idea to prepare a ticket from."""

    idea_id: str


@router.post("/prepare-ticket")
async def post_prepare_ticket(body: PrepareBody, session: Session) -> dict[str, Any]:
    """Draft the ticket text, acceptance criteria and a split for the Promote dialog."""
    idea = await session.get(IdeaTicket, body.idea_id)
    if idea is None:
        _fail(404, "not_found", f"Idea ticket '{body.idea_id}' not found")
    await _need_member(session, idea.project_id)
    try:
        return await idea_ai.prepare_ticket(
            session, body.idea_id, person=act.current_actor()
        )
    except idea_ai.IdeaAiError as exc:
        _ai_error(exc)


def _digest(d) -> dict[str, Any]:
    return {
        "id": d.id,
        "project_id": d.project_id or None,
        "text": d.text,
        "items": json.loads(d.items or "[]"),
        "ai": d.ai,
        "cost": d.cost,
        "ideas_read": d.ideas_read,
        "created_at": d.created_at,
    }


@router.get("/digest")
async def get_digest(
    session: Session, project_id: str | None = None
) -> dict[str, Any] | None:
    """The newest weekly digest. A digest is not a notification: nobody is pinged."""
    d = await idea_ai.latest_digest(session, project_id)
    return _digest(d) if d else None


class DigestBody(BaseModel):
    """Which project's digest to write now."""

    project_id: str | None = None


@router.post("/digest/run", status_code=201)
async def post_digest_run(body: DigestBody, session: Session) -> dict[str, Any]:
    """Write the digest now (members). The findings are local; AI adds a sentence only when it is on."""
    await _need_member(session, body.project_id)
    return _digest(
        await idea_ai.groom(session, body.project_id, person=act.current_actor())
    )
