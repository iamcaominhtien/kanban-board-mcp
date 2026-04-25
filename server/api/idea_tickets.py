from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import IdeaTicketCreateBody, IdeaTicketRead, IdeaTicketUpdate
from services.idea_tickets import (
    create_idea_ticket,
    delete_idea_ticket,
    get_idea_ticket,
    list_idea_tickets,
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
