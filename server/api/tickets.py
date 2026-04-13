from pathlib import Path
from typing import Annotated, Literal, NoReturn, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import ActivityEventRead, TicketCreateBody, TicketRead, TicketUpdate
from uploads import (
    MAX_DESCRIPTION_IMAGE_BYTES,
    MIME_BY_EXTENSION,
    SUPPORTED_IMAGE_EXTENSIONS,
    SUPPORTED_IMAGE_MIME_TYPES,
    build_markdown_alt_text,
    build_upload_filename,
    get_uploads_dir,
)
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
    get_project_activities,
    get_ticket,
    link_block,
    list_tickets,
    toggle_acceptance_criterion,
    unlink_block,
    update_test_case,
    update_ticket,
)

router = APIRouter(tags=["tickets"])

Session = Annotated[AsyncSession, Depends(get_session)]


def _read(ticket) -> TicketRead:
    return TicketRead.from_ticket(ticket)


def _404(detail: str = "Ticket not found") -> NoReturn:
    raise HTTPException(status_code=404, detail=detail)


class DescriptionImageUploadResponse(BaseModel):
    url: str
    markdown: str
    filename: str
    content_type: str
    size: int


async def _read_upload_bytes(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0

    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_DESCRIPTION_IMAGE_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Image exceeds the 5MB upload limit.",
            )
        chunks.append(chunk)

    return b"".join(chunks)


def _validate_upload(file: UploadFile) -> tuple[str, str]:
    filename = file.filename or ""
    extension = Path(filename).suffix.lower()
    content_type = (file.content_type or "").lower()

    if extension not in SUPPORTED_IMAGE_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported image type. Use png, jpg, jpeg, gif, or webp.",
        )

    expected_content_type = MIME_BY_EXTENSION[extension]
    if (
        content_type not in SUPPORTED_IMAGE_MIME_TYPES
        or content_type != expected_content_type
    ):
        raise HTTPException(
            status_code=400,
            detail="Unsupported image type. Use png, jpg, jpeg, gif, or webp.",
        )

    return filename, content_type


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
    include_wont_do: bool = False,
) -> list[TicketRead]:
    tickets = await list_tickets(
        session,
        project_id,
        status=status,
        priority=priority,
        q=q,
        include_wont_do=include_wont_do,
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
            start_date=body.start_date,
            tags=body.tags,
            assignee=body.assignee,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
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
    try:
        ticket = await update_ticket(session, ticket_id, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete("/tickets/{ticket_id}", status_code=204)
async def del_ticket(ticket_id: str, session: Session) -> None:
    found = await delete_ticket(session, ticket_id)
    if not found:
        _404()
    await board_events.publish("invalidate")


@router.post(
    "/uploads/images", response_model=DescriptionImageUploadResponse, status_code=201
)
async def upload_description_image(
    file: UploadFile = File(...),
) -> DescriptionImageUploadResponse:
    filename, content_type = _validate_upload(file)

    try:
        payload = await _read_upload_bytes(file)
    finally:
        await file.close()

    stored_filename = build_upload_filename(filename)
    destination = get_uploads_dir() / stored_filename
    destination.write_bytes(payload)

    url = f"/uploads/{stored_filename}"
    alt_text = build_markdown_alt_text(filename)

    return DescriptionImageUploadResponse(
        url=url,
        markdown=f"![{alt_text}]({url})",
        filename=stored_filename,
        content_type=content_type,
        size=len(payload),
    )


# ---------------------------------------------------------------------------
# Quick status update
# ---------------------------------------------------------------------------


class StatusBody(BaseModel):
    status: Literal["backlog", "todo", "in-progress", "done"]


@router.patch("/tickets/{ticket_id}/status", response_model=TicketRead)
async def patch_status(
    ticket_id: str, body: StatusBody, session: Session
) -> TicketRead:
    ticket = await update_ticket(session, ticket_id, TicketUpdate(status=body.status))
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
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
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete("/tickets/{ticket_id}/comments/{comment_id}", response_model=TicketRead)
async def del_comment(ticket_id: str, comment_id: str, session: Session) -> TicketRead:
    ticket = await delete_comment(session, ticket_id, comment_id)
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
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
    await board_events.publish("invalidate")
    return _read(ticket)


@router.patch(
    "/tickets/{ticket_id}/acceptance-criteria/{criterion_id}/toggle",
    response_model=TicketRead,
)
async def toggle_ac(ticket_id: str, criterion_id: str, session: Session) -> TicketRead:
    ticket = await toggle_acceptance_criterion(session, ticket_id, criterion_id)
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete(
    "/tickets/{ticket_id}/acceptance-criteria/{criterion_id}",
    response_model=TicketRead,
)
async def del_ac(ticket_id: str, criterion_id: str, session: Session) -> TicketRead:
    ticket = await delete_acceptance_criterion(session, ticket_id, criterion_id)
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
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
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete("/tickets/{ticket_id}/work-log/{log_id}", response_model=TicketRead)
async def del_work_log(ticket_id: str, log_id: str, session: Session) -> TicketRead:
    ticket = await delete_work_log(session, ticket_id, log_id)
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
    return _read(ticket)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


class TestCaseCreateBody(BaseModel):
    title: str
    status: Literal["pending", "pass", "fail"] = "pending"
    proof: Optional[str] = None
    note: Optional[str] = None


class TestCaseUpdateBody(BaseModel):
    status: Literal["pending", "pass", "fail"]
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
    await board_events.publish("invalidate")
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
    await board_events.publish("invalidate")
    return _read(ticket)


@router.delete("/tickets/{ticket_id}/test-cases/{tc_id}", response_model=TicketRead)
async def del_test_case(ticket_id: str, tc_id: str, session: Session) -> TicketRead:
    ticket = await delete_test_case(session, ticket_id, tc_id)
    if ticket is None:
        _404()
    await board_events.publish("invalidate")
    return _read(ticket)


# ---------------------------------------------------------------------------
# Project activities (for event timeline)
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/activities", response_model=list[ActivityEventRead])
async def get_project_activities_handler(
    project_id: str,
    session: Session,
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[ActivityEventRead]:
    return await get_project_activities(session, project_id, limit)


# ---------------------------------------------------------------------------
# Block / Blocked-by relationships
# ---------------------------------------------------------------------------


class BlockPairRead(BaseModel):
    blocker: TicketRead
    blocked: TicketRead


@router.post("/tickets/{ticket_id}/blocks/{target_id}", response_model=BlockPairRead)
async def post_block(ticket_id: str, target_id: str, session: Session) -> BlockPairRead:
    try:
        result = await link_block(session, ticket_id, target_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        _404("One or both tickets not found")
    blocker, blocked = result
    await board_events.publish("invalidate")
    return BlockPairRead(blocker=_read(blocker), blocked=_read(blocked))


@router.delete("/tickets/{ticket_id}/blocks/{target_id}", response_model=BlockPairRead)
async def delete_block(
    ticket_id: str, target_id: str, session: Session
) -> BlockPairRead:
    result = await unlink_block(session, ticket_id, target_id)
    if result is None:
        _404("One or both tickets not found")
    blocker, blocked = result
    await board_events.publish("invalidate")
    return BlockPairRead(blocker=_read(blocker), blocked=_read(blocked))
