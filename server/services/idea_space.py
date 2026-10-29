"""Idea Space rules: stage moves, triage decisions, merge, votes, evidence, comments, research log and counts.

The data model is in `models.py` (IdeaTicket and its records) and the one-time conversion in the
`idea_space_model` migration; basic create/update lives in `services/idea_tickets.py`.
"""

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    ARCHIVE_REASONS,
    EVIDENCE_KINDS,
    IDEA_STAGES,
    LOG_KINDS,
    WORKSPACE_RETENTIONS,
    IdeaAdvice,
    IdeaAssumption,
    IdeaComment,
    IdeaEvidence,
    IdeaLogEntry,
    IdeaTicket,
    IdeaVote,
    Project,
    Ticket,
    idea_readiness,
)
from services import idea_tickets as base
from services.idea_tickets import DEFAULT_AUTHOR, add_trail
from services.tickets import create_ticket as svc_create_ticket

UTC = timezone.utc
OPEN_STAGES = ("inbox", "exploring", "ready", "parked")
ACTIVE_STAGES = ("exploring", "ready", "building")
CLOSED_STAGES = ("shipped", "archived")
MERGE_UNDO_MINUTES = 10
STALE_DAYS = 30
WAITING_DAYS = 14

# The legacy status the current Idea board shows for each stage.
LEGACY_STATUS_FOR_STAGE = {
    "inbox": "draft",
    "parked": "draft",
    "exploring": "in_review",
    "ready": "approved",
    "building": "approved",
    "shipped": "approved",
    "archived": "dropped",
}


class IdeaRuleError(ValueError):
    """A request that breaks a rule of the Idea Space; `code` tells a client which one."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        """Keep the machine-readable `code` and any `extra` details for the API to return."""
        super().__init__(message)
        self.code = code
        self.extra = extra


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _today() -> date:
    return datetime.now(UTC).date()


def _json(value: str, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else fallback
    except (TypeError, ValueError):
        return fallback


async def get_or_raise(session: AsyncSession, idea_id: str) -> IdeaTicket:
    """The idea with all its records loaded.

    Raises:
        ValueError: If there is no such idea.
    """
    idea = await session.get(IdeaTicket, idea_id)
    if idea is None:
        raise ValueError(f"Idea ticket '{idea_id}' not found")
    return await base._reload(session, idea_id)


async def _save(session: AsyncSession, idea: IdeaTicket) -> IdeaTicket:
    now = _now()
    idea.updated_at = now
    idea.last_touched_at = now
    session.add(idea)
    await session.commit()
    return await base._reload(session, idea.id)


# ── listing, counts ────────────────────────────────────────────────────────


def _rank(idea: IdeaTicket) -> tuple:
    """Sort key for "Readiness": the ideas closest to ready first, then the most recently touched."""
    r = idea_readiness(idea.assumption_records)
    order = {"ready": 0, "growing": 1, "at_risk": 2, "not_started": 3}[r["state"]]
    tested = (r["validated"] / r["total"]) if r["total"] else 0
    return (order, -tested, "".join(chr(255 - ord(c)) for c in (idea.updated_at or "")))


def _matches_text(idea: IdeaTicket, q: str) -> bool:
    needle = q.strip().lower()
    hay = " ".join(
        [
            idea.id,
            idea.title,
            idea.description,
            idea.body,
            idea.problem_statement or "",
            " ".join(str(t) for t in _json(idea.tags, [])),
            " ".join(a.text for a in idea.assumption_records),
        ]
    ).lower()
    return all(word in hay for word in needle.split())


async def list_ideas(
    session: AsyncSession,
    project_id: str | None = None,
    scope: str = "project",
    stages: Iterable[str] | None = None,
    active: bool = False,
    q: str | None = None,
    source: str | None = None,
    tag: str | None = None,
    sort: str = "readiness",
) -> list[IdeaTicket]:
    """List ideas for the Idea Space views.

    Args:
        project_id: The project to look at when `scope` is "project".
        scope: "project" (one project), "all" (every idea) or "none" (ideas with no project).
        stages: Only ideas in these stages.
        active: Only Exploring, Ready and Building ideas (the "Active" filter).
        q: Words that all have to appear in the title, text, tags or an assumption.
        source: Only ideas from this source.
        tag: Only ideas with this tag.
        sort: readiness (default), updated, created, votes or title.

    Returns:
        The matching ideas. Parked ideas whose date has come are returned to the Inbox first.
    """
    if scope not in ("project", "all", "none"):
        raise ValueError("scope must be project, all or none")
    if scope == "project" and not project_id:
        raise ValueError("project_id is required when scope is project")
    await base.wake_parked_ideas(session, project_id if scope == "project" else None)
    stmt = select(IdeaTicket)
    if scope == "project":
        stmt = stmt.where(IdeaTicket.project_id == project_id)
    elif scope == "none":
        stmt = stmt.where(IdeaTicket.project_id.is_(None))
    wanted = list(stages) if stages else []
    for stage in wanted:
        if stage not in IDEA_STAGES:
            raise ValueError(f"Unknown stage '{stage}'")
    if wanted:
        stmt = stmt.where(IdeaTicket.stage.in_(wanted))
    if active:
        stmt = stmt.where(IdeaTicket.stage.in_(ACTIVE_STAGES))
    if source:
        stmt = stmt.where(IdeaTicket.source == source)
    ideas = list((await session.exec(stmt)).all())
    if tag:
        ideas = [i for i in ideas if tag in [str(t) for t in _json(i.tags, [])]]
    if q and q.strip():
        ideas = [i for i in ideas if _matches_text(i, q)]
    keys = {
        "readiness": _rank,
        "updated": lambda i: "".join(chr(255 - ord(c)) for c in (i.updated_at or "")),
        "created": lambda i: "".join(chr(255 - ord(c)) for c in (i.created_at or "")),
        "votes": lambda i: -len(i.vote_records),
        "title": lambda i: i.title.lower(),
    }
    if sort not in keys:
        raise ValueError(f"sort must be one of: {', '.join(keys)}")
    return sorted(ideas, key=keys[sort])


async def counts(session: AsyncSession) -> dict[str, Any]:
    """Counts for the project switcher, the stage filters and the sidebar badge.

    Returns:
        {total_inbox (all projects, for the sidebar badge), all: {...}, none: {...}, projects: [{project_id, ...}]}
        where each {...} is {inbox, active, parked, shipped, archived, total (not archived)} and `stages`.
    """
    await base.wake_parked_ideas(session)
    ideas = list((await session.exec(select(IdeaTicket))).all())

    def bucket() -> dict[str, Any]:
        return {"stages": {s: 0 for s in IDEA_STAGES}, "active": 0, "total": 0}

    result: dict[str, Any] = {"all": bucket(), "none": bucket()}
    projects: dict[str, dict[str, Any]] = {}
    for idea in ideas:
        targets = [result["all"]]
        if idea.project_id is None:
            targets.append(result["none"])
        else:
            targets.append(
                projects.setdefault(
                    idea.project_id, {"project_id": idea.project_id, **bucket()}
                )
            )
        for b in targets:
            b["stages"][idea.stage] += 1
            if idea.stage in ACTIVE_STAGES:
                b["active"] += 1
            if idea.stage != "archived":
                b["total"] += 1
    result["projects"] = list(projects.values())
    result["total_inbox"] = result["all"]["stages"]["inbox"]
    return result


# ── stage moves ────────────────────────────────────────────────────────────


_MOVES = {
    "inbox": {"exploring", "parked", "archived"},
    "exploring": {"ready", "parked", "archived"},
    "ready": {"exploring", "parked", "archived"},
    "parked": {"inbox", "exploring", "ready", "archived"},
    "building": set(),
    "shipped": {"exploring", "archived"},
    "archived": {"inbox", "exploring"},
}


def _snapshot(idea: IdeaTicket) -> str:
    return json.dumps(
        {
            "stage": idea.stage,
            "idea_status": idea.idea_status,
            "park_until": idea.park_until,
            "park_note": idea.park_note,
            "archive_reason": idea.archive_reason,
            "archive_note": idea.archive_note,
            "stage_changed_at": idea.stage_changed_at,
            "after": None,
        }
    )


def _parse_date(value: str | None) -> str:
    try:
        parsed = date.fromisoformat((value or "").strip()[:10])
    except ValueError as exc:
        raise IdeaRuleError(
            "park_needs_date", "Parking needs a date (YYYY-MM-DD)"
        ) from exc
    if parsed < _today():
        raise IdeaRuleError("park_date_past", "The date to come back on is in the past")
    return parsed.isoformat()


_ADVICE_FOR_STAGE = {"exploring": "keep", "parked": "park", "archived": "archive"}


async def _close_advice(
    session: AsyncSession, idea_id: str, action: str | None
) -> None:
    """The idea left the Inbox: its open AI advice is accepted when the person did what it said, ignored if not."""
    rows = (
        await session.exec(
            select(IdeaAdvice).where(
                IdeaAdvice.idea_id == idea_id, IdeaAdvice.state == "open"
            )
        )
    ).all()
    for advice in rows:
        advice.state = "accepted" if advice.action == action else "ignored"
        session.add(advice)
    if rows:
        await session.commit()


async def move_stage(
    session: AsyncSession,
    idea_id: str,
    to_stage: str,
    *,
    author: str | None = DEFAULT_AUTHOR,
    park_until: str | None = None,
    park_note: str | None = None,
    archive_reason: str | None = None,
    archive_note: str | None = None,
    force: bool = False,
    via: str | None = None,
) -> IdeaTicket:
    """Move an idea to another stage by a person's decision (Keep, Park, Archive, Restore, drag).

    Args:
        idea_id: The idea.
        to_stage: Target stage. Building and Shipped are never reached this way: Promote and the ticket do that.
        author: Who decided.
        park_until: Date (YYYY-MM-DD) the idea returns to the Inbox; required for Parked.
        park_note: Why it was parked.
        archive_reason: One of ARCHIVE_REASONS; required for Archived.
        archive_note: An optional note others see when they search.
        force: Move to Ready although the readiness checks are not met.
        via: A short label recorded in the activity ("Keep", "Triage", "Drag").

    Returns:
        The updated idea.

    Raises:
        IdeaRuleError: With `code` building_locked, not_allowed, not_ready, park_needs_date, park_date_past,
            archive_needs_reason or use_promote.
        ValueError: If the idea or stage does not exist.
    """
    if to_stage not in IDEA_STAGES:
        raise ValueError(f"Unknown stage '{to_stage}'")
    idea = await get_or_raise(session, idea_id)
    if idea.stage == to_stage:
        return idea
    if idea.stage == "building":
        raise IdeaRuleError(
            "building_locked",
            "Not allowed while the ticket is open. Close or remove the ticket first.",
        )
    if to_stage == "building":
        raise IdeaRuleError("use_promote", "Promote the idea to make it Building")
    if to_stage not in _MOVES[idea.stage]:
        raise IdeaRuleError(
            "not_allowed", f"An idea cannot move from {idea.stage} to {to_stage}"
        )

    readiness = idea_readiness(idea.assumption_records)
    if to_stage == "ready" and readiness["state"] != "ready" and not force:
        raise IdeaRuleError(
            "not_ready",
            "Not every high-impact assumption is validated yet",
            readiness=readiness,
        )
    if to_stage == "parked":
        until = _parse_date(park_until)
    if to_stage == "archived":
        if archive_reason not in ARCHIVE_REASONS:
            raise IdeaRuleError(
                "archive_needs_reason",
                f"Archiving needs a reason: {', '.join(ARCHIVE_REASONS)}",
            )

    now = _now()
    before = idea.stage
    snapshot = json.loads(_snapshot(idea))
    idea.stage = to_stage
    idea.idea_status = LEGACY_STATUS_FOR_STAGE[to_stage]
    idea.stage_changed_at = now
    idea.park_until = until if to_stage == "parked" else None
    idea.park_note = (park_note or None) if to_stage == "parked" else None
    idea.archive_reason = archive_reason if to_stage == "archived" else None
    idea.archive_note = (archive_note or None) if to_stage == "archived" else None
    snapshot["after"] = now
    idea.prev_state = json.dumps(snapshot)

    label = f"Stage: {before} → {to_stage}"
    if to_stage == "parked":
        label += f" until {idea.park_until}"
    if to_stage == "archived":
        label += f" ({archive_reason.replace('_', ' ')})"
    if to_stage == "ready" and readiness["state"] != "ready":
        label += " without the checks"
    add_trail(
        idea,
        label,
        now,
        author,
        kind="stage",
        meta={"from": before, "to": to_stage, **({"via": via} if via else {})},
    )
    saved = await _save(session, idea)
    if before == "inbox":
        await _close_advice(session, idea_id, _ADVICE_FOR_STAGE.get(to_stage))
    return saved


async def undo_last_move(
    session: AsyncSession, idea_id: str, author: str | None = DEFAULT_AUTHOR
) -> IdeaTicket:
    """Take back the last stage move (the Z key in triage).

    Raises:
        IdeaRuleError: With `nothing_to_undo` when there is no move to take back, or `building_locked`.
    """
    idea = await get_or_raise(session, idea_id)
    snap = _json(idea.prev_state, {})
    if not snap or snap.get("after") != idea.stage_changed_at:
        raise IdeaRuleError("nothing_to_undo", "There is no move to undo")
    if idea.stage == "building":
        raise IdeaRuleError("building_locked", "The idea has been promoted since")
    now = _now()
    before = idea.stage
    idea.stage = snap["stage"]
    idea.idea_status = snap.get("idea_status") or LEGACY_STATUS_FOR_STAGE[idea.stage]
    idea.park_until = snap.get("park_until")
    idea.park_note = snap.get("park_note")
    idea.archive_reason = snap.get("archive_reason")
    idea.archive_note = snap.get("archive_note")
    idea.stage_changed_at = now
    idea.prev_state = "{}"
    add_trail(
        idea,
        f"Undid the move: {before} → {idea.stage}",
        now,
        author,
        kind="stage",
        meta={"from": before, "to": idea.stage, "undo": True},
    )
    return await _save(session, idea)


async def park_many(
    session: AsyncSession,
    idea_ids: list[str],
    park_until: str,
    author: str | None = DEFAULT_AUTHOR,
    park_note: str | None = None,
) -> list[IdeaTicket]:
    """Park several ideas in one step ("Park all for a month")."""
    return [
        await move_stage(
            session,
            i,
            "parked",
            author=author,
            park_until=park_until,
            park_note=park_note,
            via="Park all",
        )
        for i in idea_ids
    ]


# ── project assignment, page ───────────────────────────────────────────────


async def assign_project(
    session: AsyncSession,
    idea_id: str,
    project_id: str | None,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Give an idea a project, move it to another one, or remove it from its project (None).

    The page, assumptions, evidence and history stay with the idea. Links to tickets keep working.
    """
    idea = await get_or_raise(session, idea_id)
    if project_id is not None and await session.get(Project, project_id) is None:
        raise ValueError(f"Project '{project_id}' not found")
    if idea.project_id == project_id:
        return idea
    now = _now()
    old = idea.project_id
    idea.project_id = project_id
    add_trail(
        idea,
        "Project: "
        + ("no project" if old is None else old)
        + " → "
        + ("no project" if project_id is None else project_id),
        now,
        author,
        kind="project",
        meta={"from": old, "to": project_id},
    )
    return await _save(session, idea)


async def update_page(
    session: AsyncSession,
    idea_id: str,
    *,
    body: str | None = None,
    details: str | None = None,
    owner: str | None | object = base._SKIP,
    effort_guess: str | None | object = base._SKIP,
    workspace_retention: str | None = None,
    tags: list | None = None,
    title: str | None = None,
    author: str | None = DEFAULT_AUTHOR,
    ai: bool = False,
) -> IdeaTicket:
    """Edit the idea page (its markdown body and details), owner, effort guess, tags or title.

    Text edits are recorded with a short before/after so Activity can show what changed.
    """
    idea = await get_or_raise(session, idea_id)
    now = _now()
    if body is not None and body != idea.body:
        old = idea.body
        idea.body = body
        add_trail(
            idea,
            "Page text edited" + (" with AI" if ai else ""),
            now,
            author,
            kind="page",
            meta={"from": old[:600], "to": body[:600]},
            ai=ai,
        )
    if details is not None and details != idea.details:
        idea.details = details
        add_trail(idea, "Details edited", now, author, kind="page")
    if owner is not base._SKIP and owner != idea.owner:
        idea.owner = owner  # type: ignore[assignment]
        add_trail(idea, f"Owner: {owner or 'nobody'}", now, author, kind="link")
    if effort_guess is not base._SKIP and effort_guess != idea.effort_guess:
        idea.effort_guess = effort_guess  # type: ignore[assignment]
        add_trail(
            idea,
            f"Effort guess: {effort_guess or 'none'}",
            now,
            author,
            kind="page",
            ai=ai,
        )
    if workspace_retention is not None:
        if workspace_retention not in WORKSPACE_RETENTIONS:
            raise ValueError(
                f"workspace_retention must be one of: {', '.join(WORKSPACE_RETENTIONS)}"
            )
        idea.workspace_retention = workspace_retention
    if tags is not None:
        idea.tags = json.dumps(tags)
    if title is not None and title.strip() and title.strip() != idea.title:
        idea.title = title.strip()
        add_trail(idea, "Title edited", now, author, kind="page")
    return await _save(session, idea)


async def record_outcome(
    session: AsyncSession,
    idea_id: str,
    outcome: str,
    note: str | None = None,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Save the answer to "Did it work as expected?" on a Shipped idea.

    Args:
        outcome: worked, partly or no.
    """
    if outcome not in ("worked", "partly", "no"):
        raise ValueError("outcome must be worked, partly or no")
    idea = await get_or_raise(session, idea_id)
    idea.outcome = outcome
    idea.outcome_note = note
    add_trail(
        idea,
        f"Outcome after shipping: {outcome}",
        _now(),
        author,
        kind="stage",
        meta={"outcome": outcome},
    )
    return await _save(session, idea)


# ── merge ──────────────────────────────────────────────────────────────────


async def merge(
    session: AsyncSession,
    source_id: str,
    target_id: str,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Merge an idea into another: its text and source are added to the target, the votes carry over,
    and the source is archived as merged. The merge can be undone for MERGE_UNDO_MINUTES.

    Returns:
        The target idea.

    Raises:
        IdeaRuleError: With `merge_self`, `not_allowed` (either idea is Building, Shipped or Archived).
    """
    if source_id == target_id:
        raise IdeaRuleError("merge_self", "An idea cannot be merged into itself")
    source = await get_or_raise(session, source_id)
    target = await get_or_raise(session, target_id)
    for idea in (source, target):
        if idea.stage not in OPEN_STAGES + ("exploring",):
            raise IdeaRuleError(
                "not_allowed", f"{idea.id} is {idea.stage} and cannot be merged"
            )
    now = _now()
    existing = {v.voter for v in target.vote_records}
    added = [v.voter for v in source.vote_records if v.voter not in existing]
    if author and author not in existing and author not in added:
        added.append(author)
    undo = {
        "source": source.id,
        "source_snapshot": json.loads(_snapshot(source)),
        "target_body": target.body,
        "votes": added,
        "at": now,
    }
    piece = f"\n\n---\n**Merged from {source.id}: {source.title}**\n\n{source.body or source.description}".rstrip()
    if source.source_ref and source.source_ref != "{}":
        ref = _json(source.source_ref, {})
        if ref.get("quote"):
            piece += f"\n\n> {ref['quote']}"
    target.body = (target.body + piece).strip()
    for voter in added:
        session.add(IdeaVote(idea_id=target.id, voter=voter, created_at=now))
    target.merge_undo = json.dumps(undo)
    add_trail(
        target,
        f"Merged {source.id} “{source.title}” into this idea",
        now,
        author,
        kind="merge",
        meta={"source": source.id},
    )
    await _save(session, target)

    source.stage = "archived"
    source.idea_status = "dropped"
    source.stage_changed_at = now
    source.archive_reason = "already_exists"
    source.archive_note = f"Merged into {target.id}"
    source.merged_into_id = target.id
    source.merged_at = now
    source.park_until = None
    add_trail(
        source,
        f"Merged into {target.id} “{target.title}”",
        now,
        author,
        kind="merge",
        meta={"target": target.id},
    )
    await _save(session, source)
    await _close_advice(session, source.id, "merge")
    return await base._reload(session, target.id)


async def undo_merge(
    session: AsyncSession, target_id: str, author: str | None = DEFAULT_AUTHOR
) -> IdeaTicket:
    """Undo the last merge into `target_id`, within MERGE_UNDO_MINUTES of it.

    Raises:
        IdeaRuleError: With `nothing_to_undo` or `undo_expired`.
    """
    target = await get_or_raise(session, target_id)
    undo = _json(target.merge_undo, {})
    if not undo:
        raise IdeaRuleError("nothing_to_undo", "There is no merge to undo")
    at = datetime.fromisoformat(undo["at"])
    if datetime.now(UTC) - at > timedelta(minutes=MERGE_UNDO_MINUTES):
        raise IdeaRuleError(
            "undo_expired",
            f"A merge can be undone for {MERGE_UNDO_MINUTES} minutes; after that, split it by hand",
        )
    now = _now()
    target.body = undo["target_body"]
    for vote in list(target.vote_records):
        if vote.voter in undo["votes"]:
            target.vote_records.remove(vote)
    target.merge_undo = "{}"
    add_trail(
        target,
        f"Undid the merge of {undo['source']}",
        now,
        author,
        kind="merge",
        meta={"source": undo["source"], "undo": True},
    )
    await _save(session, target)
    source = await get_or_raise(session, undo["source"])
    snap = undo["source_snapshot"]
    source.stage = snap["stage"]
    source.idea_status = (
        snap.get("idea_status") or LEGACY_STATUS_FOR_STAGE[snap["stage"]]
    )
    source.park_until = snap.get("park_until")
    source.archive_reason = snap.get("archive_reason")
    source.archive_note = snap.get("archive_note")
    source.merged_into_id = None
    source.merged_at = None
    source.stage_changed_at = now
    add_trail(source, f"Merge into {target.id} undone", now, author, kind="merge")
    await _save(session, source)
    return await base._reload(session, target.id)


# ── votes ──────────────────────────────────────────────────────────────────


async def vote(
    session: AsyncSession, idea_id: str, voter: str, on: bool = True
) -> IdeaTicket:
    """Add or remove one person's "I want this" (one per person per idea)."""
    voter = voter.strip()
    if not voter:
        raise ValueError("voter cannot be empty")
    idea = await get_or_raise(session, idea_id)
    have = next((v for v in idea.vote_records if v.voter == voter), None)
    if on and have is None:
        session.add(IdeaVote(idea_id=idea.id, voter=voter))
        add_trail(idea, f"{voter} wants this", _now(), voter, kind="vote")
    elif not on and have is not None:
        idea.vote_records.remove(have)
        add_trail(idea, f"{voter} no longer wants this", _now(), voter, kind="vote")
    else:
        return idea
    return await _save(session, idea)


# ── assumptions: evidence, tests, outcome of a test ────────────────────────


def _assumption(idea: IdeaTicket, assumption_id: str) -> IdeaAssumption:
    found = next((a for a in idea.assumption_records if a.id == assumption_id), None)
    if found is None:
        raise ValueError(f"Assumption '{assumption_id}' not found")
    return found


async def add_evidence(
    session: AsyncSession,
    idea_id: str,
    assumption_ids: list[str],
    kind: str,
    ref: str,
    title: str = "",
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Attach a piece of evidence (comment, file, link, ticket, sketch, diagram or note) to assumptions.

    One piece of evidence can support many assumptions: pass several ids.
    """
    if kind not in EVIDENCE_KINDS:
        raise ValueError(f"kind must be one of: {', '.join(EVIDENCE_KINDS)}")
    if not assumption_ids:
        raise ValueError("Choose at least one assumption")
    if not ref.strip():
        raise ValueError("ref cannot be empty")
    idea = await get_or_raise(session, idea_id)
    now = _now()
    for aid in assumption_ids:
        a = _assumption(idea, aid)
        session.add(
            IdeaEvidence(
                assumption_id=a.id,
                kind=kind,
                title=title.strip(),
                ref=ref.strip(),
                created_by=author,
                created_at=now,
            )
        )
    add_trail(
        idea,
        f"Evidence added ({kind}): {title.strip() or ref.strip()[:60]}",
        now,
        author,
        kind="evidence",
        meta={"assumptions": assumption_ids},
    )
    return await _save(session, idea)


async def delete_evidence(
    session: AsyncSession,
    idea_id: str,
    evidence_id: str,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Remove one piece of evidence from its assumption."""
    idea = await get_or_raise(session, idea_id)
    for a in idea.assumption_records:
        found = next((e for e in a.evidence if e.id == evidence_id), None)
        if found is not None:
            a.evidence.remove(found)
            await session.flush()
            add_trail(idea, "Evidence removed", _now(), author, kind="evidence")
            return await _save(session, idea)
    raise ValueError(f"Evidence '{evidence_id}' not found")


def list_evidence(idea: IdeaTicket) -> list[dict[str, Any]]:
    """The Evidence tab: each distinct piece once, with the assumptions it supports."""
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for a in idea.assumption_records:
        for e in a.evidence:
            item = grouped.setdefault(
                (e.kind, e.ref),
                {
                    "kind": e.kind,
                    "ref": e.ref,
                    "title": e.title,
                    "created_by": e.created_by,
                    "created_at": e.created_at,
                    "ids": [],
                    "assumptions": [],
                },
            )
            item["ids"].append(e.id)
            item["assumptions"].append({"id": a.id, "text": a.text})
    return sorted(grouped.values(), key=lambda i: i["created_at"], reverse=True)


async def create_test_ticket(
    session: AsyncSession,
    idea_id: str,
    assumption_id: str,
    title: str | None = None,
    assignee: str | None = None,
    author: str | None = DEFAULT_AUTHOR,
) -> tuple[IdeaTicket, Ticket]:
    """Create an ordinary ticket that tests an assumption, linked both ways; the assumption becomes Testing.

    Raises:
        IdeaRuleError: With `needs_project` when the idea has no project, `already_has_test`.
    """
    idea = await get_or_raise(session, idea_id)
    a = _assumption(idea, assumption_id)
    if idea.project_id is None:
        raise IdeaRuleError(
            "needs_project", "Choose a project for the idea to create a test ticket"
        )
    if a.test_ticket_id and await session.get(Ticket, a.test_ticket_id) is not None:
        raise IdeaRuleError(
            "already_has_test", f"{a.test_ticket_id} already tests this assumption"
        )
    ticket = await svc_create_ticket(
        session,
        project_id=idea.project_id,
        title=(title or f"Test: {a.text}")[:200],
        description=(
            f"Tests an assumption of idea {idea.id} “{idea.title}”:\n\n> {a.text}\n\n"
            "When this ticket is Done, say whether the assumption is validated or disproved."
        ),
        type="task",
        priority="medium",
        tags=["idea-test"],
        assignee=assignee,
    )
    ticket = await session.get(Ticket, ticket.id)
    ticket.tests_assumption_id = a.id
    session.add(ticket)
    idea = await get_or_raise(session, idea_id)
    a = _assumption(idea, assumption_id)
    a.test_ticket_id = ticket.id
    if a.status == "untested":
        a.status = "testing"
    a.updated_at = _now()
    session.add(a)
    add_trail(
        idea,
        f"Test ticket {ticket.id} created for “{a.text[:60]}”",
        _now(),
        author,
        kind="assumption",
        meta={"assumption": a.id, "ticket": ticket.id},
    )
    return await _save(session, idea), ticket


async def resolve_assumption(
    session: AsyncSession,
    idea_id: str,
    assumption_id: str,
    outcome: str,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Answer "what did the test show?": validated, disproved, or unsure (nothing changes, it is noted)."""
    if outcome not in ("validated", "disproved", "unsure"):
        raise ValueError("outcome must be validated, disproved or unsure")
    if outcome == "unsure":
        idea = await get_or_raise(session, idea_id)
        a = _assumption(idea, assumption_id)
        add_trail(
            idea,
            f"Not sure yet about “{a.text[:60]}”",
            _now(),
            author,
            kind="assumption",
        )
        return await _save(session, idea)
    return await base.update_assumption_status(
        session, idea_id, assumption_id, outcome, author=author
    )


# ── comments ───────────────────────────────────────────────────────────────


async def add_comment(
    session: AsyncSession,
    idea_id: str,
    body: str,
    author: str | None = DEFAULT_AUTHOR,
    ai: bool = False,
    run_id: str | None = None,
) -> IdeaComment:
    """Write a comment on the idea page."""
    body = body.strip()
    if not body:
        raise ValueError("body cannot be empty")
    idea = await get_or_raise(session, idea_id)
    comment = IdeaComment(
        idea_id=idea.id,
        author=author,
        body=body,
        ai=ai,
        run_id=run_id,
        created_at=_now(),
    )
    session.add(comment)
    idea.updated_at = comment.created_at
    session.add(idea)
    await session.commit()
    await session.refresh(comment)
    return comment


async def edit_comment(
    session: AsyncSession, idea_id: str, comment_id: str, body: str
) -> IdeaComment:
    """Change the text of a comment; an AI comment stops being marked AI once a person edits it."""
    comment = await session.get(IdeaComment, comment_id)
    if comment is None or comment.idea_id != idea_id:
        raise ValueError(f"Comment '{comment_id}' not found")
    if not body.strip():
        raise ValueError("body cannot be empty")
    comment.body = body.strip()
    comment.edited_at = _now()
    comment.ai = False
    session.add(comment)
    await session.commit()
    await session.refresh(comment)
    return comment


async def delete_comment(session: AsyncSession, idea_id: str, comment_id: str) -> None:
    """Delete a comment."""
    comment = await session.get(IdeaComment, comment_id)
    if comment is None or comment.idea_id != idea_id:
        raise ValueError(f"Comment '{comment_id}' not found")
    await session.delete(comment)
    await session.commit()


async def list_comments(session: AsyncSession, idea_id: str) -> list[IdeaComment]:
    """The idea's comments, oldest first."""
    result = await session.exec(
        select(IdeaComment)
        .where(IdeaComment.idea_id == idea_id)
        .order_by(IdeaComment.created_at)
    )
    return list(result.all())


# ── research log ───────────────────────────────────────────────────────────


async def add_log_entry(
    session: AsyncSession,
    idea_id: str,
    kind: str,
    body: str,
    author: str | None = DEFAULT_AUTHOR,
    ai: bool = False,
    assumption_id: str | None = None,
    attachments: list[dict] | None = None,
    ticket_id: str | None = None,
) -> IdeaLogEntry:
    """Add an entry to the research log (note, research, interview, experiment, finding or decision)."""
    if kind not in LOG_KINDS:
        raise ValueError(f"kind must be one of: {', '.join(LOG_KINDS)}")
    if not body.strip():
        raise ValueError("body cannot be empty")
    idea = await get_or_raise(session, idea_id)
    if idea.stage in CLOSED_STAGES:
        raise IdeaRuleError(
            "idea_closed", "The idea is closed: reopen it to add to the log"
        )
    if assumption_id:
        _assumption(idea, assumption_id)
    entry = IdeaLogEntry(
        idea_id=idea.id,
        kind=kind,
        body=body.strip(),
        author=author,
        ai=ai,
        assumption_id=assumption_id,
        attachments=json.dumps(attachments or []),
        ticket_id=ticket_id,
        created_at=_now(),
    )
    session.add(entry)
    add_trail(
        idea,
        f"Log entry ({kind}): {body.strip()[:60]}",
        entry.created_at,
        author,
        kind="log",
        ai=ai,
    )
    await _save(session, idea)
    await session.refresh(entry)
    return entry


async def update_log_entry(
    session: AsyncSession,
    idea_id: str,
    entry_id: str,
    body: str | None = None,
    pinned: bool | None = None,
    kind: str | None = None,
) -> IdeaLogEntry:
    """Edit a log entry's text or kind, or pin it."""
    entry = await session.get(IdeaLogEntry, entry_id)
    if entry is None or entry.idea_id != idea_id:
        raise ValueError(f"Log entry '{entry_id}' not found")
    if body is not None:
        if not body.strip():
            raise ValueError("body cannot be empty")
        entry.body = body.strip()
    if kind is not None:
        if kind not in LOG_KINDS:
            raise ValueError(f"kind must be one of: {', '.join(LOG_KINDS)}")
        entry.kind = kind
    if pinned is not None:
        entry.pinned = pinned
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


async def delete_log_entry(
    session: AsyncSession,
    idea_id: str,
    entry_id: str,
    author: str | None = DEFAULT_AUTHOR,
) -> None:
    """Delete a log entry (it stays in Activity as "entry deleted")."""
    entry = await session.get(IdeaLogEntry, entry_id)
    if entry is None or entry.idea_id != idea_id:
        raise ValueError(f"Log entry '{entry_id}' not found")
    idea = await get_or_raise(session, idea_id)
    await session.delete(entry)
    add_trail(idea, f"Log entry deleted ({entry.kind})", _now(), author, kind="log")
    await _save(session, idea)


async def list_log(session: AsyncSession, idea_id: str) -> list[IdeaLogEntry]:
    """The research log, pinned entries first, then newest first."""
    result = await session.exec(
        select(IdeaLogEntry).where(IdeaLogEntry.idea_id == idea_id)
    )
    return sorted(result.all(), key=lambda e: (not e.pinned, _neg(e.created_at)))


def _neg(text: str) -> str:
    return "".join(chr(255 - ord(c)) for c in text)


async def log_entry_as_evidence(
    session: AsyncSession,
    idea_id: str,
    entry_id: str,
    assumption_id: str,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """ "Use as evidence": a finding becomes a note of evidence for an assumption in one click."""
    entry = await session.get(IdeaLogEntry, entry_id)
    if entry is None or entry.idea_id != idea_id:
        raise ValueError(f"Log entry '{entry_id}' not found")
    entry.assumption_id = assumption_id
    session.add(entry)
    return await add_evidence(
        session,
        idea_id,
        [assumption_id],
        "note",
        f"log:{entry.id}",
        title=entry.body[:80],
        author=author,
    )


# ── activity ───────────────────────────────────────────────────────────────

ACTIVITY_FILTERS = {
    "stage": {"stage", "created", "merge"},
    "assumptions": {"assumption"},
    "evidence": {"evidence"},
    "page": {"page"},
    "ai": None,  # entries made by an AI member
    "links": {"project", "link"},
}


def activity(idea: IdeaTicket, filter_: str | None = None) -> list[dict[str, Any]]:
    """The idea's activity, newest first; `filter_` is one of ACTIVITY_FILTERS."""
    if filter_ is not None and filter_ not in ACTIVITY_FILTERS:
        raise ValueError(f"filter must be one of: {', '.join(ACTIVITY_FILTERS)}")
    items = list(reversed(_json(idea.activity_trail, [])))
    if filter_ == "ai":
        return [i for i in items if i.get("ai")]
    if filter_:
        wanted = ACTIVITY_FILTERS[filter_] or set()
        return [i for i in items if i.get("kind") in wanted]
    return items


# ── what the lists warn about ──────────────────────────────────────────────


def warnings(idea: IdeaTicket) -> list[str]:
    """Badges for a list row: stale, waiting too long in the Inbox, parked due, at risk."""
    out = []
    now = datetime.now(UTC)
    changed = idea.updated_at or idea.created_at
    try:
        age = (now - datetime.fromisoformat(changed)).days
    except ValueError:
        age = 0
    if idea.stage in ("exploring", "ready") and age >= STALE_DAYS:
        out.append(f"stale:{age}")
    if idea.stage == "inbox":
        try:
            waited = (now - datetime.fromisoformat(idea.created_at)).days
        except ValueError:
            waited = 0
        if waited >= WAITING_DAYS:
            out.append(f"waiting:{waited}")
    if idea_readiness(idea.assumption_records)["state"] == "at_risk":
        out.append("at_risk")
    return out
