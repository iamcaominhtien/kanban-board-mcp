from typing import Annotated, Literal, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import IdeaTicketCreateBody, IdeaTicketRead, IdeaTicketUpdate, TicketRead
from services.idea_tickets import (
    add_assumption,
    add_microthought,
    create_idea_ticket,
    delete_assumption,
    delete_idea_ticket,
    delete_microthought,
    get_idea_ticket,
    list_idea_tickets,
    promote_idea_to_ticket,
    update_assumption_status,
    update_idea_status,
    update_idea_ticket,
)

router = APIRouter(tags=["idea-tickets"])

Session = Annotated[AsyncSession, Depends(get_session)]


def _read(ticket) -> IdeaTicketRead:
    return IdeaTicketRead.from_idea_ticket(ticket)


def _404(detail: str = "Idea ticket not found") -> NoReturn:
    raise HTTPException(status_code=404, detail=detail)


@router.get("/api/idea-tickets", response_model=list[IdeaTicketRead])
async def get_idea_tickets(
    session: Session,
    project_id: str = Query(...),
    idea_status: str | None = None,
    q: str | None = None,
) -> list[IdeaTicketRead]:
    tickets = await list_idea_tickets(
        session,
        project_id=project_id,
        idea_status=idea_status,
        q=q,
    )
    return [_read(t) for t in tickets]


@router.post("/api/idea-tickets", response_model=IdeaTicketRead, status_code=201)
async def post_idea_ticket(
    body: IdeaTicketCreateBody,
    session: Session,
) -> IdeaTicketRead:
    try:
        ticket = await create_idea_ticket(
            session,
            project_id=body.project_id,
            title=body.title,
            description=body.description,
            idea_color=body.idea_color,
            idea_emoji=body.idea_emoji,
            idea_energy=body.idea_energy,
            tags=body.tags,
            problem_statement=body.problem_statement,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return _read(ticket)


@router.get("/api/idea-tickets/{ticket_id}", response_model=IdeaTicketRead)
async def get_one_idea_ticket(ticket_id: str, session: Session) -> IdeaTicketRead:
    ticket = await get_idea_ticket(session, ticket_id)
    if ticket is None:
        _404()
    return _read(ticket)


@router.patch("/api/idea-tickets/{ticket_id}", response_model=IdeaTicketRead)
async def patch_idea_ticket(
    ticket_id: str, data: IdeaTicketUpdate, session: Session
) -> IdeaTicketRead:
    update_fields = data.model_dump(exclude_unset=True)
    try:
        ticket = await update_idea_ticket(session, ticket_id, **update_fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete("/api/idea-tickets/{ticket_id}", status_code=204)
async def del_idea_ticket(ticket_id: str, session: Session) -> None:
    found = await delete_idea_ticket(session, ticket_id)
    if not found:
        _404()
    await board_events.publish("invalidate")


class AssumptionBody(BaseModel):
    text: str = Field(..., max_length=500)


class AssumptionStatusBody(BaseModel):
    status: Literal["untested", "validated", "invalidated"]


@router.post("/api/idea-tickets/{ticket_id}/assumptions", response_model=IdeaTicketRead)
async def post_assumption(
    ticket_id: str, body: AssumptionBody, session: Session
) -> IdeaTicketRead:
    try:
        ticket = await add_assumption(session, ticket_id, body.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return _read(ticket)


@router.patch(
    "/api/idea-tickets/{ticket_id}/assumptions/{assumption_id}",
    response_model=IdeaTicketRead,
)
async def patch_assumption_status(
    ticket_id: str, assumption_id: str, body: AssumptionStatusBody, session: Session
) -> IdeaTicketRead:
    try:
        ticket = await update_assumption_status(
            session, ticket_id, assumption_id, body.status
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return _read(ticket)


class MicrothoughtBody(BaseModel):
    text: str = Field(..., max_length=500)


@router.post(
    "/api/idea-tickets/{ticket_id}/microthoughts", response_model=IdeaTicketRead
)
async def post_microthought(
    ticket_id: str, body: MicrothoughtBody, session: Session
) -> IdeaTicketRead:
    try:
        ticket = await add_microthought(session, ticket_id, body.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete(
    "/api/idea-tickets/{ticket_id}/assumptions/{assumption_id}",
    response_model=IdeaTicketRead,
)
async def del_assumption(
    ticket_id: str, assumption_id: str, session: Session
) -> IdeaTicketRead:
    try:
        ticket = await delete_assumption(session, ticket_id, assumption_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete(
    "/api/idea-tickets/{ticket_id}/microthoughts/{microthought_id}",
    response_model=IdeaTicketRead,
)
async def del_microthought(
    ticket_id: str, microthought_id: str, session: Session
) -> IdeaTicketRead:
    try:
        ticket = await delete_microthought(session, ticket_id, microthought_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return _read(ticket)


class IdeaStatusUpdateBody(BaseModel):
    new_status: str
    reason: str | None = Field(default=None, max_length=500)


class IdeaPromoteBody(BaseModel):
    project_id: str
    title: str | None = None
    type: Literal["bug", "feature", "task", "chore"] = "feature"
    priority: Literal["low", "medium", "high", "critical"] = "medium"


@router.patch("/api/idea-tickets/{ticket_id}/status", response_model=IdeaTicketRead)
async def patch_idea_status(
    ticket_id: str, body: IdeaStatusUpdateBody, session: Session
) -> IdeaTicketRead:
    try:
        ticket = await update_idea_status(
            session, ticket_id, new_status=body.new_status, reason=body.reason
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return _read(ticket)


@router.post("/api/idea-tickets/{ticket_id}/promote", response_model=TicketRead)
async def promote_idea(
    ticket_id: str, body: IdeaPromoteBody, session: Session
) -> TicketRead:
    try:
        new_ticket = await promote_idea_to_ticket(
            session,
            idea_ticket_id=ticket_id,
            project_id=body.project_id,
            title=body.title,
            type_=body.type,
            priority=body.priority,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return TicketRead.from_ticket(new_ticket)
