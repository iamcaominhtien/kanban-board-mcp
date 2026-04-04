from typing import Annotated, NoReturn, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import TicketCreateBody, TicketRead, TicketUpdate
from services.tickets import (
    add_acceptance_criterion,
    add_comment,
    add_test_case,
    add_work_log,
    create_ticket,
    delete_acceptance_criterion,
    delete_comment,
    delete_test_case,
    delete_ticket,
    delete_work_log,
    get_ticket,
    list_tickets,
    toggle_acceptance_criterion,
    update_test_case,
    update_ticket,
)

router = APIRouter(tags=["tickets"])

Session = Annotated[AsyncSession, Depends(get_session)]


def _read(ticket) -> TicketRead:
    return TicketRead.from_ticket(ticket)


def _404(detail: str = "Ticket not found") -> NoReturn:
    raise HTTPException(status_code=404, detail=detail)


# ---------------------------------------------------------------------------
# Core CRUD
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/tickets", response_model=list[TicketRead])
async def get_tickets(
    project_id: str,
    session: Session,
    status: Optional[str] = None,
    priority: Optional[str] = None,
    q: Optional[str] = None,
) -> list[TicketRead]:
    tickets = await list_tickets(
        session, project_id, status=status, priority=priority, q=q
    )
    return [_read(t) for t in tickets]


@router.post(
    "/projects/{project_id}/tickets", response_model=TicketRead, status_code=201
)
async def post_ticket(
    project_id: str, body: TicketCreateBody, session: Session
) -> TicketRead:
    try:
        ticket = await create_ticket(
            session,
            project_id=project_id,
            title=body.title,
            type=body.type,
            priority=body.priority,
            status=body.status,
            description=body.description,
            parent_id=body.parent_id,
            estimate=body.estimate,
            due_date=body.due_date,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _read(ticket)


@router.get("/tickets/{ticket_id}", response_model=TicketRead)
async def get_one_ticket(ticket_id: str, session: Session) -> TicketRead:
    ticket = await get_ticket(session, ticket_id)
    if ticket is None:
        _404()
    return _read(ticket)


@router.patch("/tickets/{ticket_id}", response_model=TicketRead)
async def patch_ticket(
    ticket_id: str, data: TicketUpdate, session: Session
) -> TicketRead:
    ticket = await update_ticket(session, ticket_id, data)
    if ticket is None:
        _404()
    return _read(ticket)


@router.delete("/tickets/{ticket_id}", status_code=204)
async def del_ticket(ticket_id: str, session: Session) -> None:
    found = await delete_ticket(session, ticket_id)
    if not found:
        _404()


# ---------------------------------------------------------------------------
# Quick status update
# ---------------------------------------------------------------------------


class StatusBody(BaseModel):
    status: str


@router.patch("/tickets/{ticket_id}/status", response_model=TicketRead)
async def patch_status(
    ticket_id: str, body: StatusBody, session: Session
) -> TicketRead:
    ticket = await update_ticket(session, ticket_id, TicketUpdate(status=body.status))
    if ticket is None:
        _404()
    return _read(ticket)


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


class CommentBody(BaseModel):
    text: str
    author: str = "user"


@router.post("/tickets/{ticket_id}/comments", response_model=TicketRead)
async def post_comment(
    ticket_id: str, body: CommentBody, session: Session
) -> TicketRead:
    ticket = await add_comment(session, ticket_id, body.text, body.author)
    if ticket is None:
        _404()
    return _read(ticket)


@router.delete("/tickets/{ticket_id}/comments/{comment_id}", response_model=TicketRead)
async def del_comment(ticket_id: str, comment_id: str, session: Session) -> TicketRead:
    ticket = await delete_comment(session, ticket_id, comment_id)
    if ticket is None:
        _404()
    return _read(ticket)


# ---------------------------------------------------------------------------
# Acceptance criteria
# ---------------------------------------------------------------------------


class ACBody(BaseModel):
    text: str


@router.post("/tickets/{ticket_id}/acceptance-criteria", response_model=TicketRead)
async def post_ac(ticket_id: str, body: ACBody, session: Session) -> TicketRead:
    ticket = await add_acceptance_criterion(session, ticket_id, body.text)
    if ticket is None:
        _404()
    return _read(ticket)


@router.patch(
    "/tickets/{ticket_id}/acceptance-criteria/{criterion_id}/toggle",
    response_model=TicketRead,
)
async def toggle_ac(ticket_id: str, criterion_id: str, session: Session) -> TicketRead:
    ticket = await toggle_acceptance_criterion(session, ticket_id, criterion_id)
    if ticket is None:
        _404()
    return _read(ticket)


@router.delete(
    "/tickets/{ticket_id}/acceptance-criteria/{criterion_id}",
    response_model=TicketRead,
)
async def del_ac(ticket_id: str, criterion_id: str, session: Session) -> TicketRead:
    ticket = await delete_acceptance_criterion(session, ticket_id, criterion_id)
    if ticket is None:
        _404()
    return _read(ticket)


# ---------------------------------------------------------------------------
# Work log
# ---------------------------------------------------------------------------


class WorkLogBody(BaseModel):
    author: str
    role: str
    note: str


@router.post("/tickets/{ticket_id}/work-log", response_model=TicketRead)
async def post_work_log(
    ticket_id: str, body: WorkLogBody, session: Session
) -> TicketRead:
    ticket = await add_work_log(session, ticket_id, body.author, body.role, body.note)
    if ticket is None:
        _404()
    return _read(ticket)


@router.delete("/tickets/{ticket_id}/work-log/{log_id}", response_model=TicketRead)
async def del_work_log(ticket_id: str, log_id: str, session: Session) -> TicketRead:
    ticket = await delete_work_log(session, ticket_id, log_id)
    if ticket is None:
        _404()
    return _read(ticket)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


class TestCaseCreateBody(BaseModel):
    title: str
    status: str = "pending"
    proof: Optional[str] = None
    note: Optional[str] = None


class TestCaseUpdateBody(BaseModel):
    status: str
    proof: Optional[str] = None
    note: Optional[str] = None


@router.post("/tickets/{ticket_id}/test-cases", response_model=TicketRead)
async def post_test_case(
    ticket_id: str, body: TestCaseCreateBody, session: Session
) -> TicketRead:
    ticket = await add_test_case(
        session, ticket_id, body.title, body.status, body.proof, body.note
    )
    if ticket is None:
        _404()
    return _read(ticket)


@router.patch("/tickets/{ticket_id}/test-cases/{tc_id}", response_model=TicketRead)
async def patch_test_case(
    ticket_id: str, tc_id: str, body: TestCaseUpdateBody, session: Session
) -> TicketRead:
    ticket = await update_test_case(
        session, ticket_id, tc_id, body.status, body.proof, body.note
    )
    if ticket is None:
        _404()
    return _read(ticket)


@router.delete("/tickets/{ticket_id}/test-cases/{tc_id}", response_model=TicketRead)
async def del_test_case(ticket_id: str, tc_id: str, session: Session) -> TicketRead:
    ticket = await delete_test_case(session, ticket_id, tc_id)
    if ticket is None:
        _404()
    return _read(ticket)
