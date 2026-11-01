"""REST API of wave 3 (design/screens/ai-board-wave3.md): the Board AI's tiers, the AI signals, standing orders and
their firings, pull requests the board opened, the knowledge base, and the eval suites."""

import tempfile
from pathlib import Path
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiKnowledgeDoc, AiOrderFiring, AiStandingOrder, AiWatchedPr, Project
from services.ai import evals as svc_evals
from services.ai import github as svc_github
from services.ai import kb as svc_kb
from services.ai import ops as svc_ops
from services.ai import orders as svc_orders
from services.ai import signals as svc_signals
from services.ai.assist import tiers as svc_tiers
from services.ai.store import get_settings

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


def _fail(exc: Exception, status: int = 422):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


async def _project(session, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")


# --------------------------------------------------------------------------- the Board AI's tiers


@router.get("/projects/{project_id}/ai/board-ai")
async def get_board_ai(project_id: str, session: Session) -> dict:
    """Whether the Board AI acts as you (D23), and every action with its tier and lock."""
    await _project(session, project_id)
    cfg = svc_ops.get(await get_settings(session, project_id)).get("board_ai") or {}
    return {
        "acts": bool(cfg.get("acts")),
        "tiers": svc_tiers.table(cfg.get("tiers")),
        "locked": svc_tiers.LOCKED,
        "bulk_tickets": svc_tiers.BULK_TICKETS,
    }


class BoardAiBody(BaseModel):
    """The Board AI's mode and the project's tier changes (only the middle tier lowered to the first)."""

    acts: Optional[bool] = None
    tiers: Optional[dict[str, Literal["free", "undo", "ask"]]] = None


@router.patch("/projects/{project_id}/ai/board-ai")
async def patch_board_ai(project_id: str, body: BoardAiBody, session: Session) -> dict:
    """Change the mode or lower a middle-tier action; a locked one is refused by the server."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    cur = svc_ops.get(settings).get("board_ai") or {}
    patch = dict(cur)
    if body.acts is not None:
        patch["acts"] = body.acts
    if body.tiers is not None:
        try:
            patch["tiers"] = svc_tiers.check_overrides(body.tiers)
        except ValueError as exc:
            _fail(exc)
    svc_ops.update(settings, {"board_ai": patch})
    session.add(settings)
    await session.commit()
    return await get_board_ai(project_id, session)


@router.get("/projects/{project_id}/ai/signals")
async def get_signals(project_id: str, session: Session) -> list[dict]:
    """The AI signals now: a hang, three failed runs, a window nearly used, a long Needs you, a waiting arbitration."""
    await _project(session, project_id)
    return await svc_signals.compute(session, project_id)


# --------------------------------------------------------------------------- standing orders


@router.get("/ai/order-templates")
async def get_order_templates() -> dict:
    """The ready-made rules and what a rule may do."""
    return {
        "templates": svc_orders.TEMPLATES,
        "actions": svc_orders.ACTIONS,
        "signals": list(svc_signals.RULE_KINDS),
    }


class SentenceBody(BaseModel):
    """A rule in words."""

    sentence: str


@router.post("/projects/{project_id}/ai/orders/parse")
async def post_parse(project_id: str, body: SentenceBody) -> dict:
    """What a sentence most likely means, as a rule to read and change before it is saved."""
    try:
        return {"rule": svc_orders.parse_sentence(body.sentence)}
    except svc_orders.OrderError as exc:
        _fail(exc)


@router.get("/projects/{project_id}/ai/orders")
async def get_orders(project_id: str, session: Session) -> list[dict]:
    """The project's standing orders."""
    rows = (
        await session.exec(
            select(AiStandingOrder).where(AiStandingOrder.project_id == project_id)
        )
    ).all()
    return [svc_orders.to_dict(r) for r in rows]


class OrderBody(BaseModel):
    """A new standing order."""

    name: str = ""
    sentence: str = ""
    rule: dict
    template: Optional[str] = None


@router.post("/projects/{project_id}/ai/orders", status_code=201)
async def post_order(project_id: str, body: OrderBody, session: Session) -> dict:
    """Save a rule (off; Start the trial is next). The server refuses anything outside the middle tier."""
    await _project(session, project_id)
    try:
        row = await svc_orders.create(
            session,
            project_id,
            name=body.name,
            sentence=body.sentence,
            rule=body.rule,
            by=_by(),
            template=body.template,
        )
    except svc_orders.OrderError as exc:
        _fail(exc)
    return svc_orders.to_dict(row)


class OrderPatch(BaseModel):
    """Change a rule or its state."""

    state: Optional[Literal["off", "trial", "on"]] = None
    trial_days: Optional[int] = None
    rule: Optional[dict] = None
    name: Optional[str] = None


@router.patch("/ai/orders/{order_id}")
async def patch_order(order_id: str, body: OrderPatch, session: Session) -> dict:
    """Start the trial, turn it on (only after its trial ran), pause it, or edit it (a changed rule that was live goes
    back to its trial)."""
    row = await session.get(AiStandingOrder, order_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    try:
        if body.rule is not None:
            row = await svc_orders.change_rule(session, row, body.rule)
        if body.name is not None:
            row.name = body.name[:120]
        session.add(row)
        await session.commit()
        if body.state is not None:
            row = await svc_orders.set_state(
                session, row, body.state, trial_days=body.trial_days
            )
    except svc_orders.OrderError as exc:
        _fail(exc)
    return svc_orders.to_dict(row)


@router.delete("/ai/orders/{order_id}", status_code=204)
async def delete_order(order_id: str, session: Session) -> None:
    """Delete a rule (its history goes with it)."""
    row = await session.get(AiStandingOrder, order_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    await session.delete(row)
    await session.commit()


@router.get("/projects/{project_id}/ai/firings")
async def get_firings(
    project_id: str, session: Session, order_id: Optional[str] = None, limit: int = 100
) -> list[dict]:
    """Everything the rules did (and would have done in trial), newest first."""
    stmt = select(AiOrderFiring).where(AiOrderFiring.project_id == project_id)
    if order_id:
        stmt = stmt.where(AiOrderFiring.order_id == order_id)
    rows = (
        await session.exec(
            stmt.order_by(col(AiOrderFiring.at).desc()).limit(min(limit, 500))
        )
    ).all()
    return [svc_orders.firing_dict(r) for r in rows]


@router.post("/ai/firings/{firing_id}/undo")
async def post_undo_firing(firing_id: str, session: Session) -> dict:
    """Put one firing back; says what it could not take back."""
    row = await session.get(AiOrderFiring, firing_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Firing not found")
    try:
        text = await svc_orders.undo(session, row, by=_by())
    except svc_orders.OrderError as exc:
        _fail(exc, 409)
    return {"text": text, "firing": svc_orders.firing_dict(row)}


@router.post("/projects/{project_id}/ai/orders/tick")
async def post_tick(project_id: str) -> dict:
    """Look at the signals once now (the loop does it every 30 s)."""
    fired = await svc_orders.tick(project_id)
    return {"fired": [svc_orders.firing_dict(f) for f in fired]}


# --------------------------------------------------------------------------- GitHub


@router.get("/projects/{project_id}/ai/pulls")
async def get_pulls(project_id: str, session: Session) -> list[dict]:
    """The pull requests the board opened and watches."""
    await svc_github.watch_new(session)
    rows = (
        await session.exec(
            select(AiWatchedPr).where(AiWatchedPr.project_id == project_id)
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
            path = Path(tmp) / Path(name).name
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


@router.get("/ai/evals/suites")
async def get_suites() -> list[dict]:
    """The seven suites and whether each can run from here."""
    return [
        {
            "key": s["key"],
            "name": s["name"],
            "tasks": len(s["tasks"]),
            "runnable": bool(s["tasks"]),
        }
        for s in svc_evals.SUITES
    ]


class EvalBody(BaseModel):
    """Run a suite with one AI member (use a light model)."""

    suite: str
    member_id: str


@router.post("/ai/evals/run")
async def post_eval(body: EvalBody, session: Session) -> dict:
    """Start a suite on the sandbox project."""
    try:
        return await svc_evals.start(session, body.suite, body.member_id, by=_by())
    except ValueError as exc:
        _fail(exc)


@router.get("/ai/evals/marks")
async def get_marks(session: Session, suite: Optional[str] = None) -> list[dict]:
    """Every mark, newest first (the trend is the useful part)."""
    return await svc_evals.marks(session, suite)
