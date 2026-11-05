"""REST API of wave 3 (design/screens/ai-board-wave3.md): the Board AI's tiers, the AI signals, standing orders and
their firings, pull requests the board opened, the knowledge base, and the eval suites."""

import tempfile
from pathlib import Path
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiKnowledgeDoc, AiWatchedPr, Project
from services.ai import github as svc_github
from services.ai import kb as svc_kb

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


def _fail(exc: Exception, status: int = 422):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


async def _project(session, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")


@router.get("/projects/{project_id}/ai/pulls")
async def get_pulls(project_id: str, session: Session) -> list[dict]:
    """The pull requests the board opened and watches."""
    await svc_github.watch_new(session)
    rows = (
        await session.exec(
            select(AiWatchedPr)
            .where(AiWatchedPr.project_id == project_id)
            .order_by(AiWatchedPr.number)
        )
    ).all()
    return [svc_github.to_dict(r) for r in rows]


@router.post("/projects/{project_id}/ai/pulls/poll")
async def post_poll(project_id: str) -> dict:
    """Ask gh about every open pull request now."""
    return {"changes": await svc_github.tick_project(project_id)}


@router.post("/tickets/{ticket_id}/ai/pull/{what}")
async def post_pull_action(
    ticket_id: str, what: Literal["ci-to-dev", "comments-to-dev"]
) -> dict:
    """Give the red CI (with its log) or the review comments back to the ticket's Dev."""
    run_id = await (
        svc_github.back_to_dev({"ticket_id": ticket_id})
        if what == "ci-to-dev"
        else svc_github.comments_to_dev(ticket_id)
    )
    if run_id is None:
        raise HTTPException(
            status_code=409, detail="Nothing to hand back, or no Dev on this ticket."
        )
    return {"run_id": run_id}


# --------------------------------------------------------------------------- knowledge base


@router.get("/projects/{project_id}/ai/kb")
async def get_kb(project_id: str, session: Session) -> dict:
    """The table of contents of what the project's AIs can search, and which stores it uses."""
    await _project(session, project_id)
    return {
        "stores": await svc_kb.stores_for(session, project_id),
        "documents": await svc_kb.table_of_contents(session, project_id, person=_by()),
        # the shared store as a list of its own, searched or not (the Shared tab, WV-7)
        "shared_documents": await svc_kb.shared_store(session, person=_by()),
    }


@router.get("/projects/{project_id}/ai/kb/search")
async def get_kb_search(project_id: str, q: str, session: Session) -> list[dict]:
    """Keyword search (BM25), as the AIs run it."""
    return await svc_kb.search(session, project_id, q, person=_by())


@router.post("/projects/{project_id}/ai/kb", status_code=201)
async def post_kb(
    project_id: str,
    session: Session,
    file: Optional[UploadFile] = File(default=None),
    title: str = Form(default=""),
    text: str = Form(default=""),
    store: Literal["project", "shared"] = Form(default="project"),
    private: bool = Form(default=False),
) -> dict:
    """Add a document: a file (PDF, image, text, code) or pasted text. Everything becomes text on the way in."""
    await _project(session, project_id)
    if store == "shared" and "shared" not in await svc_kb.stores_for(
        session, project_id
    ):
        raise HTTPException(
            status_code=409,
            detail="This project does not use the shared store; turn it on in the project's AI settings first.",
        )
    name = (file.filename if file else None) or title or "Untitled"
    if file is not None:
        data = await file.read()
        if len(data) > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Files are limited to 50 MB.")
        with tempfile.TemporaryDirectory(prefix="kanban-kb-") as tmp:
            # the upload's own name never makes the path: a fixed name with a known suffix (the name is kept apart)
            path = Path(tmp) / f"upload{svc_kb.known_suffix(name)}"
            path.write_bytes(data)
            kind, body = await svc_kb.to_text(str(path), name, project_id=project_id)
    else:
        kind, body = "text", text
    if not body.strip():
        raise HTTPException(status_code=422, detail="Nothing readable was found in it.")
    try:
        doc = await svc_kb.add(
            session,
            project_id=project_id,
            store=store,
            title=title or name,
            kind=kind,
            body=body,
            by=_by(),
            source_name=name,
            private=private,
        )
    except ValueError as exc:
        _fail(exc)
    return svc_kb.to_dict(doc)


@router.get("/ai/kb/{doc_id}")
async def get_kb_doc(doc_id: str, session: Session) -> dict:
    """One document's details (not its full text)."""
    doc = await session.get(AiKnowledgeDoc, doc_id)
    if doc is None or doc.deleted_at or not svc_kb.visible(doc, person=_by()):
        raise HTTPException(status_code=404, detail="Document not found")
    return {**svc_kb.to_dict(doc), "text_preview": (doc.text or "")[:2000]}


class KbPatch(BaseModel):
    """Move a document to the shared store (a deliberate move), or change who sees it."""

    store: Optional[Literal["project", "shared"]] = None
    private: Optional[bool] = None


@router.patch("/ai/kb/{doc_id}")
async def patch_kb_doc(doc_id: str, body: KbPatch, session: Session) -> dict:
    """Putting a document into the shared store says who will be able to read it. Only who added a document changes
    who sees it; the shared store takes a document only from a project that opted in to it."""
    person = _by()
    doc = await session.get(AiKnowledgeDoc, doc_id)
    if doc is None or doc.deleted_at or not svc_kb.visible(doc, person=person):
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.created_by and doc.created_by != person:
        raise HTTPException(
            status_code=403,
            detail=f"Only {doc.created_by}, who added it, can change who sees it.",
        )
    if body.store == "shared" and doc.store != "shared":
        if not doc.project_id or "shared" not in await svc_kb.stores_for(
            session, doc.project_id
        ):
            raise HTTPException(
                status_code=409,
                detail="This project does not use the shared store; turn it on in the project's AI settings first.",
            )
    if body.store == "project" and doc.store != "project" and not doc.project_id:
        raise HTTPException(
            status_code=409, detail="This document came from no project."
        )
    if body.store is not None:
        doc.store = body.store
    if body.private is not None:
        doc.private = body.private
    session.add(doc)
    await session.commit()
    await svc_kb.reindex(session, doc)
    await session.commit()
    return svc_kb.to_dict(doc)


@router.delete("/ai/kb/{doc_id}", status_code=204)
async def delete_kb_doc(doc_id: str, session: Session) -> None:
    """Delete a document from the knowledge base."""
    doc = await session.get(AiKnowledgeDoc, doc_id)
    if doc is None or doc.deleted_at or not svc_kb.visible(doc, person=_by()):
        raise HTTPException(status_code=404, detail="Document not found")
    await svc_kb.remove(session, doc)


# --------------------------------------------------------------------------- evals
