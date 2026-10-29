"""REST API of the Idea Space: stages, triage, merge, votes, assumptions, evidence, comments, log, activity, promote.

The basic idea routes (list, create, get, patch, delete, legacy status) are in `api/idea_tickets.py`; this router
is included before it so its fixed paths (`/counts`, `/similar`, ...) win over `/{ticket_id}`.
"""

import json
from typing import Annotated, Any, Literal, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import (
    IDEA_SOURCES,
    IdeaAssumption,
    IdeaComment,
    IdeaLogEntry,
    IdeaTicket,
    IdeaTicketRead,
    Member,
    Ticket,
    TicketRead,
)
from services import activity as act
from services import idea_promote, idea_similarity
from services import idea_space as space
from services import idea_tickets as base
from services.docs_access import role_in

router = APIRouter(prefix="/api/idea-tickets", tags=["idea-space"])
Session = Annotated[AsyncSession, Depends(get_session)]

Stage = Literal[
    "inbox", "exploring", "ready", "building", "parked", "shipped", "archived"
]
Impact = Literal["low", "medium", "high"]
AssumptionState = Literal[
    "untested", "testing", "validated", "disproved", "invalidated"
]


def _fail(status: int, code: str, message: str, **extra: Any) -> NoReturn:
    raise HTTPException(
        status_code=status, detail={"code": code, "message": message, **extra}
    )


def _rule(exc: space.IdeaRuleError) -> NoReturn:
    status = 404 if exc.code == "not_found" else 409
    _fail(status, exc.code, str(exc), **exc.extra)


def _value(exc: ValueError) -> NoReturn:
    text = str(exc)
    if "not found" in text:
        _fail(404, "not_found", text)
    _fail(400, "invalid", text)


def _actor() -> str:
    return act.current_actor()


async def can_edit(session: AsyncSession, idea: IdeaTicket) -> bool:
    """Whether the current actor may move and edit the idea: members and admins of its project (anyone for an
    idea with no project). Viewers can still add ideas, vote and comment."""
    actor = _actor()
    if idea.project_id is None or actor in (act.HUMAN_ACTOR, act.AGENT_ACTOR):
        return True
    rows = await session.exec(
        select(Member).where(Member.project_id == idea.project_id)
    )
    return role_in(list(rows.all()), actor) in ("member", "admin")


async def _need_edit(session: AsyncSession, idea_id: str) -> IdeaTicket:
    idea = await session.get(IdeaTicket, idea_id)
    if idea is None:
        _fail(404, "not_found", f"Idea ticket '{idea_id}' not found")
    if not await can_edit(session, idea):
        _fail(
            403,
            "read_only",
            "Only owners and members can change ideas. You can still vote and comment.",
        )
    return idea


async def reads(session: AsyncSession, ideas: list[IdeaTicket]) -> list[IdeaTicketRead]:
    """Read models for ideas, with the ticket each became (id, title, status, project) filled in."""
    ids = {i.promoted_to_ticket_id for i in ideas if i.promoted_to_ticket_id}
    tickets: dict[str, Ticket] = {}
    if ids:
        rows = await session.exec(select(Ticket).where(Ticket.id.in_(ids)))
        tickets = {t.id: t for t in rows.all()}
    out = []
    for idea in ideas:
        item = IdeaTicketRead.from_idea_ticket(idea)
        t = tickets.get(idea.promoted_to_ticket_id or "")
        if t is not None:
            item.ticket = {
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "project_id": t.project_id,
                "assignee": t.assignee,
            }
        out.append(item)
    return out


async def read(session: AsyncSession, idea: IdeaTicket) -> IdeaTicketRead:
    """The read model of one idea."""
    return (await reads(session, [idea]))[0]


async def _done(session: AsyncSession, idea: IdeaTicket) -> IdeaTicketRead:
    await board_events.publish("invalidate")
    return await read(session, idea)


# ── listing, counts, search ────────────────────────────────────────────────


class IdeaListRow(IdeaTicketRead):
    """An idea as a list row: the idea with its warnings (stale, waiting too long, at risk)."""

    warnings: list[str] = Field(default_factory=list)


@router.get("/space", response_model=list[IdeaListRow])
async def list_space(
    session: Session,
    project_id: str | None = None,
    scope: Literal["project", "all", "none"] = "project",
    stage: Annotated[list[Stage] | None, Query()] = None,
    active: bool = False,
    q: str | None = None,
    source: str | None = None,
    tag: str | None = None,
    sort: Literal["readiness", "updated", "created", "votes", "title"] = "readiness",
) -> list[IdeaListRow]:
    """List ideas for the Idea Space views: one project, all projects, or ideas with no project."""
    if source is not None and source not in IDEA_SOURCES:
        _fail(400, "invalid", f"source must be one of: {', '.join(IDEA_SOURCES)}")
    try:
        ideas = await space.list_ideas(
            session,
            project_id=project_id,
            scope=scope,
            stages=stage,
            active=active,
            q=q,
            source=source,
            tag=tag,
            sort=sort,
        )
    except ValueError as exc:
        _value(exc)
    rows = await reads(session, ideas)
    return [
        IdeaListRow(**r.model_dump(), warnings=space.warnings(i))
        for r, i in zip(rows, ideas)
    ]


@router.get("/counts")
async def get_counts(session: Session) -> dict[str, Any]:
    """Counts for the project switcher, stage filters and the sidebar badge."""
    return await space.counts(session)


@router.get("/similar")
async def get_similar(
    session: Session,
    text: str,
    exclude: str | None = None,
    project_id: str | None = None,
    kinds: Annotated[list[Literal["idea", "ticket", "doc"]] | None, Query()] = None,
    limit: int = Query(default=5, ge=1, le=20),
) -> list[dict[str, Any]]:
    """Ideas, tickets and Docs that look like the text (local search, no model)."""
    return await idea_similarity.find_similar(
        session,
        text,
        exclude_idea_id=exclude,
        project_id=project_id,
        kinds=tuple(kinds or ("idea", "ticket", "doc")),
        limit=limit,
    )


@router.get("/tag-suggestions")
async def get_tag_suggestions(
    session: Session, text: str, exclude: str | None = None
) -> list[str]:
    """Tags used by the ideas and tickets that look like the text."""
    return await idea_similarity.suggest_tags(session, text, exclude)


@router.get("/by-ticket/{ticket_id}")
async def by_ticket(ticket_id: str, session: Session) -> dict[str, Any]:
    """What the ticket page needs: the idea it started as and the assumption it tests (either may be null)."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        _fail(404, "not_found", f"Ticket '{ticket_id}' not found")
    out: dict[str, Any] = {"from_idea": None, "tests": None}
    if ticket.from_idea_id:
        idea = await session.get(IdeaTicket, ticket.from_idea_id)
        if idea is not None:
            idea = await base._reload(session, idea.id)
            checked = sum(1 for a in idea.assumption_records if a.status == "validated")
            out["from_idea"] = {
                "id": idea.id,
                "title": idea.title,
                "stage": idea.stage,
                "demand": idea_promote.demand_note(idea),
                "assumptions_total": len(idea.assumption_records),
                "assumptions_checked": checked,
                "confirmed": [
                    a.text for a in idea.assumption_records if a.status == "validated"
                ],
                "log_count": len(idea.log_records),
                "outcome": idea.outcome,
                "open": [
                    {
                        "id": a.id,
                        "text": a.text,
                        "test_ticket_id": a.test_ticket_id,
                    }
                    for a in idea.assumption_records
                    if a.status in ("untested", "testing")
                ],
            }
    if ticket.tests_assumption_id:
        a = await session.get(IdeaAssumption, ticket.tests_assumption_id)
        if a is not None:
            out["tests"] = {
                "idea_id": a.idea_id,
                "assumption_id": a.id,
                "text": a.text,
                "status": a.status,
                "impact": a.impact,
            }
    return out


# ── stage, triage, merge ───────────────────────────────────────────────────


class StageBody(BaseModel):
    """Move an idea to a stage (Keep, Park, Archive, Restore or drag)."""

    to: Stage
    park_until: str | None = None
    park_note: str | None = Field(default=None, max_length=500)
    archive_reason: (
        Literal["already_exists", "too_big", "not_now", "wrong_direction", "other"]
        | None
    ) = None
    archive_note: str | None = Field(default=None, max_length=500)
    force: bool = False
    via: str | None = Field(default=None, max_length=40)
    project_id: str | None = None
    tags: list[str] | None = None


@router.post("/{idea_id}/stage", response_model=IdeaTicketRead)
async def post_stage(idea_id: str, body: StageBody, session: Session) -> IdeaTicketRead:
    """Move an idea to another stage. Keep may also set the project and tags in the same step."""
    await _need_edit(session, idea_id)
    try:
        if body.project_id is not None:
            await space.assign_project(session, idea_id, body.project_id, _actor())
        if body.tags is not None:
            await space.update_page(session, idea_id, tags=body.tags, author=_actor())
        idea = await space.move_stage(
            session,
            idea_id,
            body.to,
            author=_actor(),
            park_until=body.park_until,
            park_note=body.park_note,
            archive_reason=body.archive_reason,
            archive_note=body.archive_note,
            force=body.force,
            via=body.via,
        )
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


@router.post("/{idea_id}/undo", response_model=IdeaTicketRead)
async def post_undo(idea_id: str, session: Session) -> IdeaTicketRead:
    """Take back the last stage move."""
    await _need_edit(session, idea_id)
    try:
        idea = await space.undo_last_move(session, idea_id, _actor())
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


class ParkManyBody(BaseModel):
    """Park several ideas for the same time."""

    ids: list[str] = Field(min_length=1, max_length=200)
    park_until: str
    park_note: str | None = Field(default=None, max_length=500)


@router.post("/park-many", response_model=list[IdeaTicketRead])
async def post_park_many(body: ParkManyBody, session: Session) -> list[IdeaTicketRead]:
    """Park several ideas in one step."""
    for i in body.ids:
        await _need_edit(session, i)
    try:
        ideas = await space.park_many(
            session, body.ids, body.park_until, _actor(), body.park_note
        )
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")
    return await reads(session, ideas)


class MergeBody(BaseModel):
    """Merge this idea into another."""

    into_id: str


@router.post("/{idea_id}/merge", response_model=IdeaTicketRead)
async def post_merge(idea_id: str, body: MergeBody, session: Session) -> IdeaTicketRead:
    """Merge the idea into another idea; returns the target. Can be undone for 10 minutes."""
    await _need_edit(session, idea_id)
    await _need_edit(session, body.into_id)
    try:
        target = await space.merge(session, idea_id, body.into_id, _actor())
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    return await _done(session, target)


@router.post("/{idea_id}/undo-merge", response_model=IdeaTicketRead)
async def post_undo_merge(idea_id: str, session: Session) -> IdeaTicketRead:
    """Undo the last merge into this idea (within 10 minutes)."""
    await _need_edit(session, idea_id)
    try:
        target = await space.undo_merge(session, idea_id, _actor())
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    return await _done(session, target)


class VoteBody(BaseModel):
    """Add or remove "I want this"; the voter defaults to the current actor."""

    voter: str | None = None
    on: bool = True


@router.post("/{idea_id}/vote", response_model=IdeaTicketRead)
async def post_vote(idea_id: str, body: VoteBody, session: Session) -> IdeaTicketRead:
    """Vote for an idea (one per person), or take the vote back. Anyone who can see the idea may vote."""
    try:
        idea = await space.vote(session, idea_id, body.voter or _actor(), body.on)
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


class OutcomeBody(BaseModel):
    """The answer to "Did it work as expected?" after an idea shipped."""

    outcome: Literal["worked", "partly", "no"]
    note: str | None = Field(default=None, max_length=1000)


@router.post("/{idea_id}/outcome", response_model=IdeaTicketRead)
async def post_outcome(
    idea_id: str, body: OutcomeBody, session: Session
) -> IdeaTicketRead:
    """Save the outcome of a shipped idea."""
    await _need_edit(session, idea_id)
    try:
        idea = await space.record_outcome(
            session, idea_id, body.outcome, body.note, _actor()
        )
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


# ── page, project ──────────────────────────────────────────────────────────


class PageBody(BaseModel):
    """Edit the idea page and the small fields next to it; omitted fields stay as they are."""

    body: str | None = Field(default=None, max_length=200_000)
    details: str | None = Field(default=None, max_length=20_000)
    title: str | None = Field(default=None, max_length=200)
    tags: list[str] | None = None
    owner: str | None = None
    effort_guess: str | None = None
    workspace_retention: Literal["open_then_30", "30_days", "forever"] | None = None
    ai: bool = False


@router.patch("/{idea_id}/page", response_model=IdeaTicketRead)
async def patch_page(idea_id: str, body: PageBody, session: Session) -> IdeaTicketRead:
    """Edit the page (markdown body), details, title, tags, owner, effort guess or workspace retention."""
    await _need_edit(session, idea_id)
    sent = body.model_dump(exclude_unset=True)
    kwargs: dict[str, Any] = {
        k: sent[k]
        for k in ("body", "details", "title", "tags", "workspace_retention")
        if k in sent
    }
    for k in ("owner", "effort_guess"):
        if k in sent:
            kwargs[k] = sent[k]
    try:
        idea = await space.update_page(
            session, idea_id, author=_actor(), ai=bool(sent.get("ai")), **kwargs
        )
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


class ProjectBody(BaseModel):
    """Assign the idea to a project, move it to another, or take it out of its project (null)."""

    project_id: str | None = None


@router.put("/{idea_id}/project", response_model=IdeaTicketRead)
async def put_project(
    idea_id: str, body: ProjectBody, session: Session
) -> IdeaTicketRead:
    """Choose the project of an idea."""
    await _need_edit(session, idea_id)
    try:
        idea = await space.assign_project(session, idea_id, body.project_id, _actor())
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


# ── assumptions ────────────────────────────────────────────────────────────


class AssumptionCreate(BaseModel):
    """A new assumption: "We believe …"."""

    text: str = Field(min_length=1, max_length=500)
    impact: Impact = "medium"
    ai: bool = False


class AssumptionEdit(BaseModel):
    """Change an assumption; omitted fields stay as they are."""

    text: str | None = Field(default=None, max_length=500)
    impact: Impact | None = None
    status: AssumptionState | None = None
    test_ticket_id: str | None = None


@router.post("/{idea_id}/assumption-records", response_model=IdeaTicketRead)
async def post_assumption_record(
    idea_id: str, body: AssumptionCreate, session: Session
) -> IdeaTicketRead:
    """Add an assumption with its impact."""
    await _need_edit(session, idea_id)
    try:
        idea = await base.add_assumption(
            session, idea_id, body.text, impact=body.impact, author=_actor()
        )
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


@router.patch(
    "/{idea_id}/assumption-records/{assumption_id}", response_model=IdeaTicketRead
)
async def patch_assumption_record(
    idea_id: str, assumption_id: str, body: AssumptionEdit, session: Session
) -> IdeaTicketRead:
    """Change an assumption's text, impact, status or test ticket."""
    await _need_edit(session, idea_id)
    sent = body.model_dump(exclude_unset=True)
    try:
        idea = None
        if {"text", "impact", "test_ticket_id"} & sent.keys():
            kwargs: dict[str, Any] = {}
            if "text" in sent:
                kwargs["text"] = sent["text"]
            if "impact" in sent:
                kwargs["impact"] = sent["impact"]
            if "test_ticket_id" in sent:
                kwargs["test_ticket_id"] = sent["test_ticket_id"]
            idea = await base.update_assumption(
                session, idea_id, assumption_id, author=_actor(), **kwargs
            )
        if sent.get("status"):
            idea = await base.update_assumption_status(
                session, idea_id, assumption_id, sent["status"], author=_actor()
            )
        if idea is None:
            idea = await space.get_or_raise(session, idea_id)
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


class TestTicketBody(BaseModel):
    """Create a small ticket that tests an assumption."""

    title: str | None = Field(default=None, max_length=200)
    assignee: str | None = None


@router.post(
    "/{idea_id}/assumption-records/{assumption_id}/test-ticket",
    response_model=dict,
    status_code=201,
)
async def post_test_ticket(
    idea_id: str, assumption_id: str, body: TestTicketBody, session: Session
) -> dict[str, Any]:
    """Create a test ticket for an assumption, linked both ways; the assumption becomes Testing."""
    await _need_edit(session, idea_id)
    try:
        idea, ticket = await space.create_test_ticket(
            session, idea_id, assumption_id, body.title, body.assignee, _actor()
        )
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")
    return {
        "idea": (await read(session, idea)).model_dump(),
        "ticket": TicketRead.from_ticket(ticket).model_dump(),
    }


class ResolveBody(BaseModel):
    """What the test showed."""

    outcome: Literal["validated", "disproved", "unsure"]


@router.post(
    "/{idea_id}/assumption-records/{assumption_id}/resolve",
    response_model=IdeaTicketRead,
)
async def post_resolve(
    idea_id: str, assumption_id: str, body: ResolveBody, session: Session
) -> IdeaTicketRead:
    """Answer "validated or disproved?" after a test ticket was closed."""
    await _need_edit(session, idea_id)
    try:
        idea = await space.resolve_assumption(
            session, idea_id, assumption_id, body.outcome, _actor()
        )
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


# ── evidence ───────────────────────────────────────────────────────────────


class EvidenceBody(BaseModel):
    """A piece of evidence for one or more assumptions."""

    assumption_ids: list[str] = Field(min_length=1)
    kind: Literal["comment", "file", "link", "ticket", "sketch", "diagram", "note"]
    ref: str = Field(min_length=1, max_length=4000)
    title: str = Field(default="", max_length=300)


@router.get("/{idea_id}/evidence")
async def get_evidence(idea_id: str, session: Session) -> list[dict[str, Any]]:
    """The Evidence tab: each piece once with the assumptions it supports."""
    try:
        return space.list_evidence(await space.get_or_raise(session, idea_id))
    except ValueError as exc:
        _value(exc)


@router.post("/{idea_id}/evidence", response_model=IdeaTicketRead, status_code=201)
async def post_evidence(
    idea_id: str, body: EvidenceBody, session: Session
) -> IdeaTicketRead:
    """Attach evidence to assumptions."""
    await _need_edit(session, idea_id)
    try:
        idea = await space.add_evidence(
            session,
            idea_id,
            body.assumption_ids,
            body.kind,
            body.ref,
            body.title,
            _actor(),
        )
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


@router.delete("/{idea_id}/evidence/{evidence_id}", response_model=IdeaTicketRead)
async def del_evidence(
    idea_id: str, evidence_id: str, session: Session
) -> IdeaTicketRead:
    """Remove a piece of evidence."""
    await _need_edit(session, idea_id)
    try:
        idea = await space.delete_evidence(session, idea_id, evidence_id, _actor())
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


# ── comments ───────────────────────────────────────────────────────────────


def _comment(c: IdeaComment) -> dict[str, Any]:
    return {
        "id": c.id,
        "idea_id": c.idea_id,
        "author": c.author,
        "body": c.body,
        "ai": c.ai,
        "run_id": c.run_id,
        "created_at": c.created_at,
        "edited_at": c.edited_at,
    }


class CommentBody(BaseModel):
    """The text of a comment."""

    body: str = Field(min_length=1, max_length=20_000)


@router.get("/{idea_id}/comments")
async def get_comments(idea_id: str, session: Session) -> list[dict[str, Any]]:
    """The idea's comments, oldest first."""
    if await session.get(IdeaTicket, idea_id) is None:
        _fail(404, "not_found", f"Idea ticket '{idea_id}' not found")
    return [_comment(c) for c in await space.list_comments(session, idea_id)]


@router.post("/{idea_id}/comments", status_code=201)
async def post_comment(
    idea_id: str, body: CommentBody, session: Session
) -> dict[str, Any]:
    """Comment on an idea. Anyone who can see it may comment."""
    try:
        c = await space.add_comment(session, idea_id, body.body, _actor())
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")
    return _comment(c)


@router.patch("/{idea_id}/comments/{comment_id}")
async def patch_comment(
    idea_id: str, comment_id: str, body: CommentBody, session: Session
) -> dict[str, Any]:
    """Edit a comment."""
    try:
        c = await space.edit_comment(session, idea_id, comment_id, body.body)
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")
    return _comment(c)


@router.delete("/{idea_id}/comments/{comment_id}", status_code=204)
async def del_comment(idea_id: str, comment_id: str, session: Session) -> None:
    """Delete a comment."""
    try:
        await space.delete_comment(session, idea_id, comment_id)
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")


# ── research log ───────────────────────────────────────────────────────────


def _entry(e: IdeaLogEntry) -> dict[str, Any]:
    try:
        attachments = json.loads(e.attachments or "[]")
    except ValueError:
        attachments = []
    return {
        "id": e.id,
        "idea_id": e.idea_id,
        "kind": e.kind,
        "body": e.body,
        "author": e.author,
        "ai": e.ai,
        "pinned": e.pinned,
        "assumption_id": e.assumption_id,
        "attachments": attachments,
        "ticket_id": e.ticket_id,
        "created_at": e.created_at,
    }


class LogBody(BaseModel):
    """A research log entry."""

    kind: Literal[
        "note", "research", "interview", "experiment", "finding", "decision"
    ] = "note"
    body: str = Field(min_length=1, max_length=20_000)
    assumption_id: str | None = None
    attachments: list[dict[str, str]] = Field(default_factory=list, max_length=20)
    ticket_id: str | None = None
    ai: bool = False


class LogPatch(BaseModel):
    """Edit, re-kind or pin a log entry."""

    body: str | None = Field(default=None, max_length=20_000)
    kind: (
        Literal["note", "research", "interview", "experiment", "finding", "decision"]
        | None
    ) = None
    pinned: bool | None = None


@router.get("/{idea_id}/log")
async def get_log(idea_id: str, session: Session) -> list[dict[str, Any]]:
    """The research log: pinned first, then newest first."""
    if await session.get(IdeaTicket, idea_id) is None:
        _fail(404, "not_found", f"Idea ticket '{idea_id}' not found")
    return [_entry(e) for e in await space.list_log(session, idea_id)]


@router.post("/{idea_id}/log", status_code=201)
async def post_log(idea_id: str, body: LogBody, session: Session) -> dict[str, Any]:
    """Add to the research log (members only)."""
    await _need_edit(session, idea_id)
    try:
        e = await space.add_log_entry(
            session,
            idea_id,
            body.kind,
            body.body,
            _actor(),
            ai=body.ai,
            assumption_id=body.assumption_id,
            attachments=body.attachments,
            ticket_id=body.ticket_id,
        )
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")
    return _entry(e)


@router.patch("/{idea_id}/log/{entry_id}")
async def patch_log(
    idea_id: str, entry_id: str, body: LogPatch, session: Session
) -> dict[str, Any]:
    """Edit, re-kind or pin a log entry."""
    await _need_edit(session, idea_id)
    try:
        e = await space.update_log_entry(
            session, idea_id, entry_id, body.body, body.pinned, body.kind
        )
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")
    return _entry(e)


@router.delete("/{idea_id}/log/{entry_id}", status_code=204)
async def del_log(idea_id: str, entry_id: str, session: Session) -> None:
    """Delete a log entry."""
    await _need_edit(session, idea_id)
    try:
        await space.delete_log_entry(session, idea_id, entry_id, _actor())
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")


class LogEvidenceBody(BaseModel):
    """The assumption a finding supports."""

    assumption_id: str


@router.post("/{idea_id}/log/{entry_id}/evidence", response_model=IdeaTicketRead)
async def post_log_as_evidence(
    idea_id: str, entry_id: str, body: LogEvidenceBody, session: Session
) -> IdeaTicketRead:
    """ "Use as evidence": a log entry becomes evidence for an assumption."""
    await _need_edit(session, idea_id)
    try:
        idea = await space.log_entry_as_evidence(
            session, idea_id, entry_id, body.assumption_id, _actor()
        )
    except ValueError as exc:
        _value(exc)
    return await _done(session, idea)


# ── activity ───────────────────────────────────────────────────────────────


@router.get("/{idea_id}/activity")
async def get_activity(
    idea_id: str,
    session: Session,
    filter: Literal["stage", "assumptions", "evidence", "page", "ai", "links"]
    | None = None,
) -> dict[str, Any]:
    """Who changed what and when, newest first, with the counts the filters show."""
    try:
        idea = await space.get_or_raise(session, idea_id)
        items = space.activity(idea, filter)
        counts = {
            name: len(space.activity(idea, name)) for name in space.ACTIVITY_FILTERS
        }
        counts["all"] = len(space.activity(idea))
    except ValueError as exc:
        _value(exc)
    return {"items": items, "counts": counts}


# ── promote ────────────────────────────────────────────────────────────────


@router.get("/{idea_id}/promote/preview")
async def get_promote_preview(
    idea_id: str, session: Session, project_id: str | None = None
) -> dict[str, Any]:
    """What Promote would create. Nothing is written."""
    try:
        return await idea_promote.preview(session, idea_id, project_id)
    except ValueError as exc:
        _value(exc)


class PromoteBody(BaseModel):
    """Create the ticket from an idea."""

    project_id: str | None = None
    title: str | None = Field(default=None, max_length=200)
    type: Literal["bug", "feature", "task", "chore"] = "feature"
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    status: Literal["backlog", "todo", "in-progress", "review", "testing"] = "backlog"
    description: str | None = None
    sub_tickets: list[str] = Field(default_factory=list, max_length=10)
    acknowledge_not_ready: bool = False
    workspace: Literal["move", "copy", "leave"] = "leave"


@router.post("/{idea_id}/promote", status_code=201)
async def post_promote(
    idea_id: str, body: PromoteBody, session: Session
) -> dict[str, Any]:
    """Promote an idea: create the ticket (and sub-tickets) and make the idea Building. A person must press
    Create: an AI member cannot promote."""
    await _need_edit(session, idea_id)
    try:
        idea, ticket, children = await idea_promote.promote(
            session,
            idea_id,
            project_id=body.project_id,
            title=body.title,
            type=body.type,
            priority=body.priority,
            status=body.status,
            description=body.description,
            sub_tickets=body.sub_tickets,
            acknowledge_not_ready=body.acknowledge_not_ready,
            author=_actor(),
        )
    except space.IdeaRuleError as exc:
        _rule(exc)
    except ValueError as exc:
        _value(exc)
    await board_events.publish("invalidate")
    return {
        "idea": (await read(session, idea)).model_dump(),
        "ticket": TicketRead.from_ticket(ticket).model_dump(),
        "sub_tickets": [TicketRead.from_ticket(c).model_dump() for c in children],
    }
