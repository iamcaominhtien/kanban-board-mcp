"""REST API of workflows (design/screens/ai-team-process.md E–L): templates, a ticket's workflow and its steps, the
person's decisions, review depth, arbitration, test-first evidence, the measures per template, and who holds what."""

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiTicketWorkflow, Project, Ticket
from services.ai import workflow as svc_workflow

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


def _fail(exc: Exception, status: int = 422):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


async def _ticket(session, ticket_id: str) -> Ticket:
    t = await session.get(Ticket, ticket_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return t


@router.get("/projects/{project_id}/ai/workflows")
async def get_templates(project_id: str, session: Session) -> list[dict]:
    """The four ready-made templates and the project's own."""
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return await svc_workflow.list_templates(session, project_id)


@router.get("/projects/{project_id}/ai/workflows/{key}")
async def get_template(project_id: str, key: str, session: Session) -> dict:
    """One template."""
    t = await svc_workflow.get_template(session, project_id, key)
    if t is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return t


@router.put("/projects/{project_id}/ai/workflows/{key}")
async def put_template(project_id: str, key: str, body: dict, session: Session) -> dict:
    """Create or change a template: a new version; tickets already on it keep theirs. Warns past two stops for you."""
    try:
        return await svc_workflow.save_template(
            session, project_id, key, body, by=_by()
        )
    except svc_workflow.WorkflowError as exc:
        _fail(exc)


@router.get("/projects/{project_id}/ai/workflow-metrics")
async def get_metrics(project_id: str, session: Session, days: int = 30) -> list[dict]:
    """Per template: tickets, median time, passed review first, rounds, cost per ticket (design L)."""
    return await svc_workflow.metrics(session, project_id, days=days)


@router.get("/projects/{project_id}/ai/workflow-board")
async def get_board(project_id: str, session: Session) -> list[dict]:
    """Every ticket on a workflow with its current step, role and holder (filters "needs my review", "AI in role X")."""
    rows = (
        await session.exec(
            select(AiTicketWorkflow).where(AiTicketWorkflow.project_id == project_id)
        )
    ).all()
    out = []
    for wf in rows:
        view = await svc_workflow.view(session, wf.ticket_id)
        current = next(
            (
                s
                for s in view["steps"]
                if s["state"] in ("pending", "active", "waiting", "blocked", "failed")
            ),
            None,
        )
        out.append(
            {
                "ticket_id": wf.ticket_id,
                "template_key": wf.template_key,
                "template_name": wf.template_name,
                "state": wf.state,
                "stop_reason": wf.stop_reason,
                "review_depth": wf.review_depth,
                "pace": wf.pace or "normal",
                "step": current["label"] if current else None,
                "step_kind": current["kind"] if current else None,
                "role": current["role"] if current else None,
                "holder_id": current["member_id"] if current else None,
                "holder_name": current["member_name"] if current else None,
                "waits_for_person": bool(current and current["kind"] == "person"),
            }
        )
    return out


class AttachBody(BaseModel):
    """Put a ticket on a workflow."""

    template_key: str
    depth: Optional[Literal["light", "standard", "deep"]] = None
    pace: Optional[Literal["normal", "fast"]] = None


@router.get("/tickets/{ticket_id}/ai/workflow")
async def get_workflow(ticket_id: str, session: Session) -> dict | None:
    """The ticket's workflow: every step row with who did it, the depth, the rounds, the stop and the rulings."""
    await _ticket(session, ticket_id)
    return await svc_workflow.view(session, ticket_id)


@router.post("/tickets/{ticket_id}/ai/workflow")
async def post_workflow(ticket_id: str, body: AttachBody, session: Session) -> dict:
    """Put the ticket on a workflow and start its first step."""
    ticket = await _ticket(session, ticket_id)
    try:
        await svc_workflow.attach(
            session,
            ticket,
            body.template_key,
            by=_by(),
            depth=body.depth,
            pace=body.pace,
        )
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return await svc_workflow.view(session, ticket_id)


@router.delete("/tickets/{ticket_id}/ai/workflow", status_code=204)
async def delete_workflow(ticket_id: str, session: Session) -> None:
    """Take the ticket off its workflow (its steps stay as history)."""
    await svc_workflow.detach(session, ticket_id, by=_by())


class DecideBody(BaseModel):
    """A person's decision on the step that waits for them."""

    approve: bool
    note: Optional[str] = None


@router.post("/tickets/{ticket_id}/ai/workflow/decide")
async def post_decide(ticket_id: str, body: DecideBody, session: Session) -> dict:
    """Approve the design (or any step that waits for you), or send it back with a note."""
    try:
        await svc_workflow.decide_person_step(
            ticket_id, approve=body.approve, note=body.note, by=_by()
        )
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return await svc_workflow.view(session, ticket_id)


class DepthBody(BaseModel):
    """The review depth."""

    depth: Literal["light", "standard", "deep"]


@router.patch("/tickets/{ticket_id}/ai/workflow/depth")
async def patch_depth(ticket_id: str, body: DepthBody, session: Session) -> dict:
    """Set the review depth by hand (it is then never raised by itself)."""
    try:
        await svc_workflow.set_depth(session, ticket_id, body.depth, by=_by())
    except svc_workflow.WorkflowError as exc:
        _fail(exc)
    return await svc_workflow.view(session, ticket_id)


class PaceBody(BaseModel):
    """The ticket's pace."""

    pace: Literal["normal", "fast"]


@router.patch("/tickets/{ticket_id}/ai/workflow/pace")
async def patch_pace(ticket_id: str, body: PaceBody, session: Session) -> dict:
    """Fast mode on or off for this ticket: the steps not reached yet are skipped or put back, every AI step runs one
    effort level lower and the review one depth lower; a step sent back runs at its full effort."""
    await _ticket(session, ticket_id)
    try:
        await svc_workflow.set_pace(session, ticket_id, body.pace, by=_by())
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return await svc_workflow.view(session, ticket_id)


class SendBackBody(BaseModel):
    """Send the ticket back to a role's step."""

    role: str
    note: str


@router.post("/tickets/{ticket_id}/ai/workflow/send-back")
async def post_send_back(ticket_id: str, body: SendBackBody, session: Session) -> dict:
    """You may change the step: back to a role's step, with a note."""
    row = await svc_workflow.send_back(
        ticket_id, to_role=body.role, note=body.note, by=_by(), from_role="person"
    )
    if row is None:
        raise HTTPException(
            status_code=409, detail="No step of that role to send it back to."
        )
    return await svc_workflow.view(session, ticket_id)


class RulingBody(BaseModel):
    """A person's ruling when two AIs cannot agree."""

    side: Literal["reviewer", "dev", "split"]
    reason: str = ""


@router.post("/tickets/{ticket_id}/ai/arbitration")
async def post_arbitration(ticket_id: str, body: RulingBody, session: Session) -> dict:
    """Side with the reviewer, with the developer, or split the ticket."""
    try:
        out = await svc_workflow.apply_ruling(
            ticket_id, body.side, by=_by(), reason=body.reason
        )
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return {**out, "workflow": await svc_workflow.view(session, ticket_id)}


@router.get("/tickets/{ticket_id}/ai/tdd")
async def get_tdd(ticket_id: str, session: Session) -> dict:
    """Proof that the test went red first: a red run on an assertion, then a green one with the same command."""
    await _ticket(session, ticket_id)
    return await svc_workflow.tdd_evidence(ticket_id)


class SkipBody(BaseModel):
    """Skip the stuck step for this ticket only."""

    step_id: Optional[str] = None


class TddBody(BaseModel):
    """Accept without test-first evidence: this once (with why), or turn the rule off for the project."""

    rule_off: bool = False
    reason: Optional[str] = None


class EvidenceBody(BaseModel):
    """Accept a testing step that finished with nothing to show, and why."""

    reason: str


class ResumeBody(BaseModel):
    """Let a ticket stopped at its token cap go on: the same cap again, or a higher one for this ticket."""

    cap: Optional[int] = None


@router.post("/tickets/{ticket_id}/ai/tdd/accept")
async def post_tdd_accept(ticket_id: str, body: TddBody, session: Session) -> dict:
    """Accept the work without test-first evidence just this once, or turn the rule off for the project."""
    try:
        await svc_workflow.accept_tdd(
            ticket_id, by=_by(), rule_off=body.rule_off, reason=body.reason
        )
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return await svc_workflow.view(session, ticket_id)


@router.post("/tickets/{ticket_id}/ai/evidence/accept")
async def post_evidence_accept(
    ticket_id: str, body: EvidenceBody, session: Session
) -> dict:
    """Accept a testing step that finished with no evidence, with why (ai-story-flow N)."""
    try:
        await svc_workflow.accept_evidence(ticket_id, by=_by(), reason=body.reason)
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return await svc_workflow.view(session, ticket_id)


@router.post("/tickets/{ticket_id}/ai/workflow/resume")
async def post_resume(
    ticket_id: str, session: Session, body: Optional[ResumeBody] = None
) -> dict:
    """Let a workflow stopped at its token cap go on, with the same cap again or a higher one for this ticket."""
    try:
        await svc_workflow.resume(ticket_id, by=_by(), cap=body.cap if body else None)
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return await svc_workflow.view(session, ticket_id)


@router.post("/tickets/{ticket_id}/ai/workflow/skip")
async def post_skip(ticket_id: str, body: SkipBody, session: Session) -> dict:
    """Skip the step (no member for its role, or a person's choice) and go on."""
    try:
        await svc_workflow.skip_step(ticket_id, by=_by(), step_id=body.step_id)
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return await svc_workflow.view(session, ticket_id)


class ReviewerBody(BaseModel):
    """An odd job's optional reviewer (an AI member), or null."""

    member_id: Optional[str] = None


@router.put("/tickets/{ticket_id}/ai/reviewer")
async def put_reviewer(ticket_id: str, body: ReviewerBody, session: Session) -> dict:
    """A ticket handed straight to one AI gets an optional reviewer: it reviews the work when it finishes (D14)."""
    ticket = await _ticket(session, ticket_id)
    try:
        wf = await svc_workflow.set_reviewer(session, ticket, body.member_id, by=_by())
    except svc_workflow.WorkflowError as exc:
        _fail(exc, 409)
    return {"ticket_id": ticket_id, "reviewer_id": wf.reviewer_id}


@router.get("/tickets/{ticket_id}/ai/reviewer")
async def get_reviewer(ticket_id: str, session: Session) -> dict:
    """The odd job's reviewer, if any."""
    wf = await session.get(AiTicketWorkflow, ticket_id)
    reviewer = wf.reviewer_id if wf is not None and not wf.template_key else None
    return {"ticket_id": ticket_id, "reviewer_id": reviewer}
