"""REST API of project knowledge (design/screens/ai-operations.md, H): the project's instructions for every AI and
the lessons its AIs learned."""

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import Project
from services.ai import knowledge as svc_knowledge
from services.ai import memory as svc_memory

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


async def _project(session, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")


@router.get("/projects/{project_id}/ai/knowledge")
async def get_knowledge(project_id: str, session: Session) -> dict:
    """Instructions, lessons, and what they add to every prompt (tokens)."""
    await _project(session, project_id)
    return await svc_knowledge.summary(session, project_id)


class InstructionsBody(BaseModel):
    """The project's instructions for every AI."""

    instructions: str


@router.put("/projects/{project_id}/ai/knowledge/instructions")
async def put_instructions(
    project_id: str, body: InstructionsBody, session: Session
) -> dict:
    """Replace the instructions (the previous text is kept in the history). Takes effect on the next run."""
    await _project(session, project_id)
    if len(body.instructions) > 40_000:
        raise HTTPException(
            status_code=422, detail="Instructions are limited to 40,000 characters."
        )
    await svc_knowledge.set_instructions(
        session, project_id, body.instructions, by=_by()
    )
    return await svc_knowledge.summary(session, project_id)


class LessonBody(BaseModel):
    """A lesson a person writes (kept at once)."""

    text: str


@router.post("/projects/{project_id}/ai/lessons", status_code=201)
async def post_lesson(project_id: str, body: LessonBody, session: Session) -> dict:
    """Add a lesson yourself."""
    await _project(session, project_id)
    try:
        row = await svc_knowledge.add_lesson(session, project_id, body.text, by=_by())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if row is None:
        raise HTTPException(status_code=409, detail="This lesson is already there.")
    return svc_knowledge.lesson_dict(row)


class LessonPatch(BaseModel):
    """Keep, edit or drop a lesson."""

    text: Optional[str] = None
    state: Optional[Literal["proposed", "kept", "dropped"]] = None


@router.patch("/ai/lessons/{lesson_id}")
async def patch_lesson(lesson_id: str, body: LessonPatch, session: Session) -> dict:
    """Keep it, edit and keep it, or say no (dropped)."""
    try:
        row = await svc_knowledge.update_lesson(
            session, lesson_id, by=_by(), text=body.text, state=body.state
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return svc_knowledge.lesson_dict(row)


@router.delete("/ai/lessons/{lesson_id}", status_code=204)
async def delete_lesson(lesson_id: str, session: Session) -> None:
    """Delete a lesson (it stays dropped, so the same proposal is not made again)."""
    try:
        await svc_knowledge.update_lesson(session, lesson_id, by=_by(), state="dropped")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --------------------------------------------------------------------------- notes an AI keeps (issue #274)


class NoteBody(BaseModel):
    """A note a person writes into an AI memory, or an edit of one."""

    text: str
    scope: Optional[Literal["role", "member", "ticket"]] = None
    scope_key: Optional[str] = None
    kind: Optional[Literal["learned", "feedback"]] = None


@router.post("/projects/{project_id}/ai/notes", status_code=201)
async def post_note(project_id: str, body: NoteBody, session: Session) -> dict:
    """Write a note into a role's, a member's or a ticket's memory (a person's correction, say)."""
    await _project(session, project_id)
    if not body.scope or not body.scope_key:
        raise HTTPException(status_code=422, detail="Say whose memory it goes in.")
    try:
        row, _what = await svc_memory.write(
            session,
            project_id,
            body.scope,
            body.scope_key,
            body.text,
            by=_by(),
            kind=body.kind or "feedback",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return svc_memory.note_dict(row)


async def _note(session, note_id: str):
    from models import AiMemoryNote

    row = await session.get(AiMemoryNote, note_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Note not found.")
    return row


@router.patch("/ai/notes/{note_id}")
async def patch_note(note_id: str, body: NoteBody, session: Session) -> dict:
    """Edit a note an AI wrote."""
    row = await _note(session, note_id)
    try:
        row, _what = await svc_memory.write(
            session,
            row.project_id,
            row.scope,
            row.scope_key,
            body.text,
            by=_by(),
            kind=body.kind or row.kind,
            note_id=note_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return svc_memory.note_dict(row)


@router.delete("/ai/notes/{note_id}", status_code=204)
async def delete_note(note_id: str, session: Session) -> None:
    """Remove a note."""
    row = await _note(session, note_id)
    await svc_memory.forget(session, row.project_id, note_id)
