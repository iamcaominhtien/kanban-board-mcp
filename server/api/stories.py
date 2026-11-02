"""REST API of Stories and of what the PM decided in a person's place (design/screens/ai-story-flow.md B–F, M1;
the contract is docs/specs/ai-story-flow-implementation.md)."""

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import Project
from services import stories as svc_stories
from services.ai import decisions as svc_decisions

router = APIRouter(tags=["stories"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


async def _project(session, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")


async def _view(session, story_id: str) -> dict:
    try:
        return await svc_stories.full_view(session, story_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


async def _act(session, story_id: str, fn, *args, **kwargs) -> dict:
    try:
        await fn(session, story_id, *args, **kwargs)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except svc_stories.StoryError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await _view(session, story_id)


class StoryBody(BaseModel):
    """A new Story: its title, goal, criteria, who approves the plan and its budget."""

    title: str = Field(min_length=1, max_length=300)
    goal: str = ""
    criteria: list[str] = []
    approve: Optional[Literal["person", "pm"]] = None
    budget_tokens: int = Field(default=0, ge=0)
    hand: bool = True


class HandBody(BaseModel):
    """Handing a Draft to the PM, with who approves the plan and the budget."""

    approve: Optional[Literal["person", "pm"]] = None
    budget_tokens: Optional[int] = Field(default=None, ge=0)


class NoteBody(BaseModel):
    """An optional note from the person."""

    note: Optional[str] = None


class ReviseBody(BaseModel):
    """What the person wants changed in the plan."""

    note: str = Field(min_length=1, max_length=2000)


class PlanItem(BaseModel):
    """One ticket of the plan and what it waits for."""

    ticket_id: str
    after: list[str] = []


class PlanBody(BaseModel):
    """The plan's order and waits, edited in place."""

    items: list[PlanItem]


class StoryPatch(BaseModel):
    """The Story's budget or who approves its plan."""

    budget_tokens: Optional[int] = Field(default=None, ge=0)
    approve: Optional[Literal["person", "pm"]] = None


@router.get("/projects/{project_id}/stories")
async def list_stories(project_id: str, session: Session) -> list[dict]:
    """The project's Stories, oldest first (the board, the Flow picker, the clusters)."""
    await _project(session, project_id)
    return await svc_stories.listing(session, project_id)


@router.post("/projects/{project_id}/stories")
async def create_story(project_id: str, body: StoryBody, session: Session) -> dict:
    """A new Story: a Draft, or handed to the PM at once (F)."""
    await _project(session, project_id)
    try:
        sid = await svc_stories.create(
            session,
            project_id,
            title=body.title,
            goal=body.goal,
            criteria=body.criteria,
            approve=body.approve,
            budget_tokens=body.budget_tokens,
            hand=body.hand,
            by=_by(),
        )
    except svc_stories.StoryError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await _view(session, sid)


@router.get("/stories/{story_id}")
async def get_story(story_id: str, session: Session) -> dict:
    """One Story with its plan, its decisions and its children (E)."""
    return await _view(session, story_id)


@router.patch("/stories/{story_id}")
async def patch_story(story_id: str, body: StoryPatch, session: Session) -> dict:
    """Its budget or who approves its plan."""
    return await _act(
        session,
        story_id,
        svc_stories.update,
        by=_by(),
        budget_tokens=body.budget_tokens,
        approve=body.approve,
    )


@router.post("/stories/{story_id}/hand")
async def post_hand(story_id: str, body: HandBody, session: Session) -> dict:
    """A Draft handed to the PM: the PM writes the plan."""
    return await _act(
        session,
        story_id,
        svc_stories.hand_over,
        by=_by(),
        approve=body.approve,
        budget_tokens=body.budget_tokens,
    )


@router.post("/tickets/{ticket_id}/make-story")
async def post_make_story(ticket_id: str, session: Session) -> dict:
    """A ticket becomes a Story; its children are the plan."""
    try:
        sid = await svc_stories.make_story(session, ticket_id, by=_by())
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except svc_stories.StoryError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return await _view(session, sid)


@router.post("/stories/{story_id}/plan/approve")
async def post_plan_approve(story_id: str, session: Session) -> dict:
    """The person approves the plan: the Story runs."""
    return await _act(session, story_id, svc_stories.approve_plan, by=_by())


@router.post("/stories/{story_id}/plan/reject")
async def post_plan_reject(story_id: str, body: NoteBody, session: Session) -> dict:
    """The person turns the plan down: its tickets go to the Recycle Bin, the Story back to Draft."""
    return await _act(
        session, story_id, svc_stories.reject_plan, by=_by(), note=body.note
    )


@router.post("/stories/{story_id}/plan/revise")
async def post_plan_revise(story_id: str, body: ReviseBody, session: Session) -> dict:
    """The person tells the PM what to change: the PM writes the next version."""
    return await _act(
        session, story_id, svc_stories.revise_plan, by=_by(), note=body.note
    )


@router.patch("/stories/{story_id}/plan")
async def patch_plan(story_id: str, body: PlanBody, session: Session) -> dict:
    """The order and the waits of the plan, edited in place."""
    return await _act(
        session,
        story_id,
        svc_stories.edit_plan,
        [i.model_dump() for i in body.items],
        by=_by(),
    )


@router.post("/stories/{story_id}/pause")
async def post_pause(story_id: str, session: Session) -> dict:
    """Nothing new starts until it is resumed."""
    return await _act(session, story_id, svc_stories.pause, by=_by(), paused=True)


@router.post("/stories/{story_id}/resume")
async def post_resume(story_id: str, session: Session) -> dict:
    """The Story goes on from where it was."""
    return await _act(session, story_id, svc_stories.pause, by=_by(), paused=False)


@router.post("/stories/{story_id}/reopen")
async def post_reopen(story_id: str, session: Session) -> dict:
    """A Story that was Done or dropped is opened again."""
    return await _act(session, story_id, svc_stories.reopen, by=_by())


@router.post("/stories/{story_id}/drop")
async def post_drop(story_id: str, session: Session) -> dict:
    """The Story is dropped (Won't do)."""
    return await _act(session, story_id, svc_stories.drop, by=_by())


@router.get("/projects/{project_id}/ai/decisions")
async def list_decisions(
    project_id: str,
    session: Session,
    story: Optional[str] = None,
    kind: Optional[str] = None,
    overridden: Optional[bool] = None,
    since: Optional[str] = None,
    limit: int = 100,
) -> dict:
    """What the PM decided in the person's place, newest first, with the totals (M1)."""
    await _project(session, project_id)
    return await svc_decisions.listing(
        session,
        project_id,
        story=story,
        kind=kind,
        overridden=overridden,
        since=since,
        limit=limit,
    )


@router.post("/ai/decisions/{decision_id}/override")
async def post_override(decision_id: str, body: NoteBody, session: Session) -> dict:
    """Undo what the PM decided, while nothing was built on it."""
    try:
        return await svc_decisions.override(
            session, decision_id, by=_by(), note=body.note
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except svc_decisions.DecisionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
