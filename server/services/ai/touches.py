"""You stepped in (design/screens/ai-team-review.md, A; AI v2): every time a person had to touch the work of the
project's AI teams, and whether the touch was needed.

Nothing here is stored per touch. A touch is worked out, newest first, from what the board already keeps:

- an answer to a team's question: the run's question and answer;
- a run started by hand (the Run button): `ai_run.trigger` and `started_by`;
- a run stopped by a person or retried by one: `ended_by` (no stop code) and the `retry` trigger;
- a message to a lead that is working: `ai_run_message` (direction in; `/compact` is a command and a message that only started a new run are not touches);
- a ticket edited while a run works on it, an account signed in again, a team (or the whole project) paused and
  resumed: audit entries written when the action happens (`record_edit`, `record_signin`, and the pause routes).

The only thing stored is the mark a person gives to a touch (`ai_touch_mark`), under the touch's stable key, so a
clean-up of runs or of the audit log never takes a mark with it. Approvals and a status ceiling do not exist in AI v2,
so no touch is "by rule" yet: the tab has no such mark until a rule exists.
"""

import logging
from collections import Counter
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiAudit, AiRun, AiRunMessage, AiTeam, AiTouchMark, Member

from . import audit, compact, knowledge
from .store import ai_names, loads, now_iso, parse_iso

logger = logging.getLogger("kanban.ai.touches")

RANGES = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}
DEFAULT_RANGE = "7d"
MARKS = ("needed", "avoidable")
LIMIT = 500
LESSON_MAX = 600

KINDS: dict[str, str] = {
    "answer": "Answered a team's question",
    "run_by_hand": "Started a run by hand",
    "stop": "Stopped a run",
    "retry": "Retried a run",
    "message": "Sent a message to the lead",
    "edit": "Edited a ticket while a run worked on it",
    "signin": "Signed an account in again",
    "pause": "Paused or resumed",
}

# Names the board uses for itself: what they did is not a person stepping in
MACHINE = {
    "board",
    "system",
    "schedule",
    "scheduler",
    "runner",
    "auto",
    "github",
    "api",
    "",
}

# Audit actions written for touches that no other table keeps
EDIT_ACTION = "ticket_edited_during_run"
SIGNIN_ACTION = "account_signin"
PAUSE_ACTIONS = ("team_paused", "team_resumed", "project_paused", "project_resumed")
# the lesson_id of a touch while its lesson is being made (a second request finds the touch taken)
CLAIMED = "pending"
RUN_ENDED = ("finished", "failed", "cancelled", "timed_out")
# a stop that comes with a pause or a removal of the team by the same person is part of it, not a touch of its own
STOP_WITH_PAUSE_S = 60
EDIT_COALESCE_S = 300  # typing in the description saves again and again: one touch per run per five minutes


def is_person(name: str | None, ai: set[str] | None = None) -> bool:
    """Whether this actor name is a person (not the board, a schedule or one of the project's AIs)."""
    n = (name or "").strip()
    return bool(n) and n.lower() not in MACHINE and n not in (ai or set())


def _clip(text: str | None, n: int = 160) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def since_of(range_key: str, now: datetime | None = None) -> datetime:
    """The start of a range ("24h", "7d", "30d", "90d"; anything else is the default)."""
    days = RANGES.get(range_key, RANGES[DEFAULT_RANGE])
    return (now or datetime.now(UTC)) - timedelta(days=days)


# --------------------------------------------------------------------------- recording


async def record_edit(
    session: AsyncSession, ticket_id: str, *, by: str | None, what: str = ""
) -> int:
    """A person edited a ticket while a run was on it: one audit entry per such run (coalesced), written when it
    happens. Returns how many were written."""
    from .store import active_runs

    runs = [
        r
        for r in await active_runs(session, ticket_id=ticket_id)
        if r.state in ("starting", "running", "needs_input") and r.kind == "team"
    ]
    if not runs or not is_person(by, await ai_names(session, runs[0].project_id)):
        return 0
    written = 0
    now = datetime.now(UTC)
    for r in runs:
        last = (
            await session.exec(
                select(AiAudit)
                .where(AiAudit.run_id == r.id, AiAudit.action == EDIT_ACTION)
                .order_by(col(AiAudit.seq).desc())
                .limit(1)
            )
        ).first()
        when = parse_iso(last.created_at) if last else None
        if (
            when
            and last
            and last.on_behalf_of == by
            and (now - when).total_seconds() < EDIT_COALESCE_S
        ):
            continue
        member = await session.get(Member, r.member_id)
        await audit.record(
            r.project_id,
            EDIT_ACTION,
            "info",
            member_id=r.member_id,
            member_name=member.name if member else "",
            on_behalf_of=by,
            run_id=r.id,
            target=ticket_id,
            detail={"what": what or "the ticket"},
        )
        written += 1
    return written


async def record_signin(session: AsyncSession, account, by: str) -> int:
    """A person opened the sign-in of an AI account: one audit entry per project whose teams run as this account."""
    try:
        teams = (
            await session.exec(select(AiTeam).where(AiTeam.account_id == account.id))
        ).all()
        by_project: dict[str, list[AiTeam]] = {}
        for t in teams:
            by_project.setdefault(t.project_id, []).append(t)
        for project_id, rows in by_project.items():
            await audit.record(
                project_id,
                SIGNIN_ACTION,
                "info",
                on_behalf_of=by,
                detail={
                    "account": account.name,
                    "account_id": account.id,
                    "team_ids": [t.id for t in rows],
                },
            )
        return len(by_project)
    except Exception:  # noqa: BLE001 - a note about the sign-in must never fail the sign-in
        logger.exception("Could not record the sign-in of %s as a touch", account.id)
        return 0


async def record_pause(
    project_id: str, action: str, by: str, detail: dict | None = None
) -> None:
    """The whole project's AI was paused or resumed by a person (the teams' own pauses are recorded by `teams`)."""
    try:
        await audit.record(
            project_id, action, "info", on_behalf_of=by, detail=detail or {}
        )
    except Exception:  # noqa: BLE001 - the audit entry must never undo the pause
        logger.exception("Could not record %s as a touch", action)


def carry_answer(question_json: str | None, answer: str | None) -> list[dict]:
    """The answered questions of a run to keep when it asks a new one (a run holds one question; the earlier ones, with
    their answers, move to `previous` so each answer stays a touch)."""
    old = loads(question_json, {}) or {}
    previous = list(old.get("previous") or [])
    if answer and old.get("answered_at"):
        previous.append(
            {
                "text": old.get("text", ""),
                "answer": answer,
                "answered_at": old["answered_at"],
                "answered_by": old.get("answered_by"),
            }
        )
    return previous[-20:]


def answers_of(r: AiRun) -> list[dict]:
    """Every answered question of a run, oldest first: {index, text, answer, at, by}."""
    q = loads(r.question, {}) or {}
    pairs = [
        {
            "text": p.get("text", ""),
            "answer": p.get("answer", ""),
            "at": p.get("answered_at"),
            "by": p.get("answered_by"),
        }
        for p in q.get("previous") or []
        if isinstance(p, dict)
    ]
    if r.answer and q.get("answered_at"):
        pairs.append(
            {
                "text": q.get("text", ""),
                "answer": r.answer,
                "at": q["answered_at"],
                "by": q.get("answered_by"),
            }
        )
    for i, p in enumerate(pairs):
        p["index"] = i
    return pairs


# --------------------------------------------------------------------------- reading


def _cancelled_runs(e: AiAudit) -> bool:
    """Whether this audit entry is a pause or removal that also stopped the team's runs (so those stops belong to it)."""
    if e.action == "team_removed":
        return True
    d = loads(e.detail, {}) or {}
    if e.action == "team_paused":
        return bool(d.get("cancel_current"))
    if e.action == "project_paused":
        return bool(
            d.get("cancel_running", True)
        )  # an entry from before the flag was kept: assume it stopped them
    return False


def _with_pause(r: AiRun, pauses: list[tuple[str | None, datetime | None]]) -> bool:
    """Whether this run was stopped as part of the same person's pause or removal of its team."""
    ended = parse_iso(r.ended_at)
    return bool(
        ended
        and any(
            who == r.ended_by
            and at is not None
            and abs((ended - at).total_seconds()) <= STOP_WITH_PAUSE_S
            for who, at in pauses
        )
    )


def _touch(
    key: str,
    kind: str,
    at: str | None,
    who: str,
    *,
    team_ids: list[str],
    ticket_id: str | None = None,
    run_id: str | None = None,
    details: str = "",
    via: str | None = None,
) -> dict:
    return {
        "id": key,
        "kind": kind,
        "label": KINDS[kind],
        "at": at,
        "who": who,
        "via": via,
        "team_ids": team_ids,
        "ticket_id": ticket_id,
        "run_id": run_id,
        "details": details,
        "mark": None,
        "marked_by": None,
        "marked_at": None,
        "lesson_id": None,
    }


async def collect(
    session: AsyncSession,
    project_id: str,
    since: datetime,
    *,
    key: str | None = None,
) -> list[dict]:
    """Every touch of the project since this time, newest first (team ids, not names: the caller adds them).

    With `key` only the rows that touch can come from are read (its run, its message, its audit entry): marking a
    touch or making a lesson from it does not read the whole range again."""
    iso = since.isoformat()
    ai = await ai_names(session, project_id)
    out: list[dict] = []
    # where a keyed touch comes from: a run, a message (and its run) or an audit entry
    src, _, rest = (key or "").partition(":")
    run_id = rest.split(":")[0] if key and src not in ("msg", "audit") else None
    msg_id = rest if src == "msg" else None
    audit_id = rest if src == "audit" else None
    audit_iso = iso
    if msg_id:
        m = await session.get(AiRunMessage, msg_id)
        run_id = m.run_id if m else "-"
    if key:
        iso = ""  # the key says what to read: no window
        audit_iso = ""
        if src == "stop" and run_id:
            r = await session.get(AiRun, run_id)
            ended = parse_iso(r.ended_at) if r else None
            # a stop is judged against the pauses made around the time it ended
            audit_iso = (
                (ended - timedelta(seconds=STOP_WITH_PAUSE_S + 1)).isoformat()
                if ended
                else "~"
            )

    run_where = [AiRun.project_id == project_id, AiRun.kind == "team"]
    if key:
        run_where.append(AiRun.id == (run_id or "-"))
    else:
        run_where.append(
            or_(
                AiRun.queued_at >= iso,
                col(AiRun.ended_at) >= iso,
                col(AiRun.ended_at).is_(None),
            )
        )
    runs = (await session.exec(select(AiRun).where(*run_where))).all()
    by_id = {r.id: r for r in runs}
    audit_where = [
        AiAudit.project_id == project_id,
        AiAudit.created_at >= audit_iso,
        col(AiAudit.action).in_(
            [EDIT_ACTION, SIGNIN_ACTION, "team_removed", *PAUSE_ACTIONS]
        ),
    ]
    if audit_id:
        audit_where.append(AiAudit.id == audit_id)
    elif key and src != "stop":
        audit_where.append(AiAudit.id == "-")  # a run's touch needs no audit entry
    rows = (await session.exec(select(AiAudit).where(*audit_where))).all()
    # when a person paused or removed a team: the runs they stopped with it are part of that
    pauses = [
        (e.on_behalf_of, parse_iso(e.created_at)) for e in rows if _cancelled_runs(e)
    ]
    answered: dict[str, list[tuple[str, str]]] = {}  # run id -> [(who, when)]
    for r in runs:
        team, ticket = [r.member_id], r.ticket_id
        for a in answers_of(r):
            if a["at"] and a["at"] >= iso and is_person(a["by"], ai):
                answered.setdefault(r.id, []).append((a["by"], a["at"]))
                out.append(
                    _touch(
                        f"answer:{r.id}" + (f":{a['index']}" if a["index"] else ""),
                        "answer",
                        a["at"],
                        a["by"],
                        team_ids=team,
                        ticket_id=ticket,
                        run_id=r.id,
                        details=f"“{_clip(a['text'], 110)}” → “{_clip(a['answer'], 110)}”",
                    )
                )
        if r.queued_at >= iso and is_person(r.started_by, ai):
            if r.trigger == "run_button":
                out.append(
                    _touch(
                        f"run:{r.id}",
                        "run_by_hand",
                        r.queued_at,
                        r.started_by,
                        team_ids=team,
                        ticket_id=ticket,
                        run_id=r.id,
                        details=_clip(r.instruction) or f"Run #{r.number}",
                    )
                )
            elif r.trigger == "retry":
                out.append(
                    _touch(
                        f"retry:{r.id}",
                        "retry",
                        r.queued_at,
                        r.started_by,
                        team_ids=team,
                        ticket_id=ticket,
                        run_id=r.id,
                        details=f"Run #{r.number} continues the one before it",
                    )
                )
        if (
            r.state == "cancelled"
            and not r.stop_code
            and r.ended_at
            and r.ended_at >= iso
            and is_person(r.ended_by, ai)
            and not _with_pause(r, pauses)
        ):
            out.append(
                _touch(
                    f"stop:{r.id}",
                    "stop",
                    r.ended_at,
                    r.ended_by or "",
                    team_ids=team,
                    ticket_id=ticket,
                    run_id=r.id,
                    details=_clip(r.ended_reason) or f"Run #{r.number} stopped",
                )
            )

    # a message into a run, not from an AI session
    msg_where = [
        AiRunMessage.direction == "in",
        AiRunMessage.at >= iso,
        col(AiRunMessage.run_id).in_(
            select(AiRun.id).where(AiRun.project_id == project_id)
        ),
    ]
    if msg_id:
        msg_where.append(AiRunMessage.id == msg_id)
    elif key:
        msg_where.append(AiRunMessage.id == "-")  # only a message touch reads messages
    msgs = (await session.exec(select(AiRunMessage).where(*msg_where))).all()
    missing = [m.run_id for m in msgs if m.run_id not in by_id]
    if missing:
        for r in (
            await session.exec(select(AiRun).where(col(AiRun.id).in_(missing)))
        ).all():
            by_id[r.id] = r
    for m in msgs:
        run = by_id.get(m.run_id)
        if (
            run is None
            or run.kind != "team"
            or not is_person(m.peer, ai)
            or m.text
            == compact.WISH  # /compact is a command, not a message to the lead
        ):
            continue
        if run.state in RUN_ENDED and run.ended_at and run.ended_at <= m.at:
            continue  # sent to a run that had ended: it only started a new run, which is not a touch
        if any(
            who == m.peer
            and abs(
                (
                    (parse_iso(m.at) or datetime.now(UTC))
                    - (parse_iso(at) or datetime.now(UTC))
                ).total_seconds()
            )
            < 10
            for who, at in answered.get(m.run_id, [])
        ):
            continue  # an answer sent through the message box is one touch, not two
        out.append(
            _touch(
                f"msg:{m.id}",
                "message",
                m.at,
                m.peer,
                team_ids=[run.member_id],
                ticket_id=run.ticket_id,
                run_id=run.id,
                details=f"“{_clip(m.text, 140)}”",
            )
        )

    for e in rows:
        if e.action == "team_removed" or not is_person(e.on_behalf_of, ai):
            continue
        d = loads(e.detail, {}) or {}
        via = d.get("via")
        if e.action == EDIT_ACTION:
            out.append(
                _touch(
                    f"audit:{e.id}",
                    "edit",
                    e.created_at,
                    e.on_behalf_of or "",
                    team_ids=[e.member_id] if e.member_id else [],
                    ticket_id=e.target,
                    run_id=e.run_id,
                    details=f"Changed {d.get('what') or 'the ticket'} while the lead was working",
                    via=via,
                )
            )
        elif e.action == SIGNIN_ACTION:
            out.append(
                _touch(
                    f"audit:{e.id}",
                    "signin",
                    e.created_at,
                    e.on_behalf_of or "",
                    team_ids=list(d.get("team_ids") or []),
                    details=f"Signed in the account “{d.get('account', '')}”",
                    via=via,
                )
            )
        else:
            whole = e.action.startswith("project_")
            verb = "Paused" if e.action.endswith("paused") else "Resumed"
            out.append(
                _touch(
                    f"audit:{e.id}",
                    "pause",
                    e.created_at,
                    e.on_behalf_of or "",
                    team_ids=[e.member_id] if e.member_id else [],
                    details=f"{verb} "
                    + ("all the project's AI" if whole else e.member_name or "a team"),
                    via=via,
                )
            )

    out.sort(key=lambda t: t["at"] or "", reverse=True)
    mark_where = [AiTouchMark.project_id == project_id]
    if key:
        mark_where.append(AiTouchMark.key == key)
    marks = {
        m.key: m
        for m in (await session.exec(select(AiTouchMark).where(*mark_where))).all()
    }
    for t in out:
        m = marks.get(t["id"])
        if m:
            t.update(
                mark=m.mark,
                marked_by=m.marked_by,
                marked_at=m.marked_at,
                lesson_id=m.lesson_id,
            )
    return out


async def stepped_in(
    session: AsyncSession,
    project_id: str,
    *,
    range_key: str = DEFAULT_RANGE,
    team_id: str | None = None,
    kind: str | None = None,
    mark: str | None = None,
) -> dict:
    """The tab: totals of the range, a row per kind and per team, and the touches (filtered by team, kind and mark)."""
    since = since_of(range_key)
    touches = await collect(session, project_id, since)
    teams = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id,
                col(Member.kind).in_(["ai", "ai_removed"]),
            )
        )
    ).all()
    names = {m.id: m.name for m in teams}
    iso = since.isoformat()
    runs = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                AiRun.kind == "team",
                AiRun.queued_at >= iso,
            )
        )
    ).all()
    runs_by_team = Counter(r.member_id for r in runs)
    tickets = {r.ticket_id for r in runs if r.ticket_id}
    for t in touches:
        t["team_names"] = [names.get(i, "") for i in t["team_ids"] if names.get(i)]
        t["team_id"] = t["team_ids"][0] if t["team_ids"] else None
        t["team_name"] = ", ".join(t["team_names"]) or "All teams"
    kinds = Counter(t["kind"] for t in touches)
    per_team: Counter = Counter()
    for t in touches:
        for i in t["team_ids"]:
            per_team[i] += 1
    total = len(touches)
    on_tickets = sum(1 for t in touches if t["ticket_id"] in tickets)
    marked = Counter(t["mark"] for t in touches)
    items = [
        t
        for t in touches
        if (not team_id or team_id in t["team_ids"])
        and (not kind or t["kind"] == kind)
        and (not mark or (mark == "unmarked" and not t["mark"]) or t["mark"] == mark)
    ]
    return {
        "range": range_key if range_key in RANGES else DEFAULT_RANGE,
        "since": iso,
        "totals": {
            "touches": total,
            "needed": marked["needed"],
            "avoidable": marked["avoidable"],
            "unmarked": marked[None],
            "tickets": len(tickets),
            "runs": len(runs),
            "per_ticket": round(on_tickets / len(tickets), 1) if tickets else None,
        },
        "kinds": [
            {"key": k, "label": KINDS[k], "total": kinds.get(k, 0)}
            for k in KINDS
            if kinds.get(k)
        ],
        "all_kinds": [{"key": k, "label": v} for k, v in KINDS.items()],
        "teams": [
            {
                "id": m.id,
                "name": m.name,
                "removed": m.kind == "ai_removed",
                "touches": per_team.get(m.id, 0),
                "runs": runs_by_team.get(m.id, 0),
                "per_10_runs": round(per_team.get(m.id, 0) * 10 / runs_by_team[m.id], 1)
                if runs_by_team.get(m.id)
                else None,
            }
            for m in teams
            if m.kind == "ai" or per_team.get(m.id) or runs_by_team.get(m.id)
        ],
        "items": items[:LIMIT],
        "truncated": len(items) > LIMIT,
    }


# --------------------------------------------------------------------------- marks and lessons


class TouchError(ValueError):
    """The mark or lesson could not be set."""


async def _find(session: AsyncSession, project_id: str, key: str) -> dict:
    """The touch with this key, read from the rows it comes from (any age)."""
    for t in await collect(session, project_id, since_of("90d"), key=key):
        if t["id"] == key:
            return t
    raise TouchError("This touch is no longer in the list.")


async def set_mark(
    session: AsyncSession, project_id: str, key: str, mark: str | None, *, by: str
) -> dict:
    """Give a touch the mark needed or avoidable, or take it away (mark None). The mark stays."""
    if mark is not None and mark not in MARKS:
        raise TouchError("A mark is “needed” or “avoidable”.")
    row = await session.get(AiTouchMark, key)
    if row is not None and row.project_id != project_id:
        raise TouchError("This touch belongs to another project.")
    if mark is None:
        if row is not None and row.lesson_id:
            raise TouchError("A lesson was made from this touch: its mark stays.")
        if row is not None:
            await session.delete(row)
            await session.commit()
        return {
            "id": key,
            "mark": None,
            "marked_by": None,
            "marked_at": None,
            "lesson_id": None,
        }
    if row is None:
        await _find(session, project_id, key)  # only a touch of the list can be marked
        row = AiTouchMark(key=key, project_id=project_id, mark=mark, marked_by=by)
    else:
        row.mark, row.marked_by, row.marked_at = mark, by, now_iso()
    session.add(row)
    try:
        await session.commit()
    except (
        IntegrityError
    ):  # two first marks of the same touch at once: the later one updates the earlier
        await session.rollback()
        row = await session.get(AiTouchMark, key)
        if row is None:
            raise TouchError("Could not save the mark. Try again.") from None
        row.mark, row.marked_by, row.marked_at = mark, by, now_iso()
        session.add(row)
        await session.commit()
    await session.refresh(row)
    return {
        "id": key,
        "mark": row.mark,
        "marked_by": row.marked_by,
        "marked_at": row.marked_at,
        "lesson_id": row.lesson_id,
    }


def draft_lesson(touch: dict) -> str:
    """A starting sentence for the lesson a person writes from an avoidable touch.

    It always ends with "Next time, do this without a person."; when the whole is too long the details are shortened."""
    ticket = f" on {touch['ticket_id']}" if touch.get("ticket_id") else ""
    head = f"{touch['label']}{ticket}: "
    tail = " Next time, do this without a person."
    details = " ".join((touch["details"] or "").split())
    room = LESSON_MAX - len(head) - len(tail) - 1  # one for the full stop
    if len(details) > room:
        details = details[: max(room - 1, 0)].rstrip() + "…"
    if details and details[-1] not in ".!?…":
        details += "."
    return f"{head}{details}{tail}"


async def make_lesson(
    session: AsyncSession, project_id: str, key: str, text: str | None, *, by: str
) -> dict:
    """“Make a lesson” on an avoidable touch: a proposed lesson in Memory, linked to the touch."""
    touch = await _find(session, project_id, key)
    if touch["mark"] != "avoidable":
        raise TouchError("Mark the touch Avoidable first.")
    if touch["lesson_id"]:
        raise TouchError("A lesson was already made from this touch.")
    body = (text or "").strip() or draft_lesson(touch)
    # Memory keeps 600 characters of a lesson: say so instead of dropping the end without a word
    if len(" ".join(body.split())) > LESSON_MAX:
        raise TouchError(f"The lesson is limited to {LESSON_MAX} characters.")
    # claim the touch first, in one statement: a second request at the same time finds it taken
    claimed = await session.execute(
        update(AiTouchMark)
        .where(col(AiTouchMark.key) == key, col(AiTouchMark.lesson_id).is_(None))
        .values(lesson_id=CLAIMED)
    )
    await session.commit()
    if not claimed.rowcount:
        raise TouchError("A lesson was already made from this touch.")
    lesson = None
    try:
        lesson = await knowledge.add_lesson(
            session,
            project_id,
            body,
            by=by,
            state="proposed",
            source_ticket_id=touch["ticket_id"],
            source_run_id=touch["run_id"],
            proposed_by=by,
        )
    finally:
        await session.execute(
            update(AiTouchMark)
            .where(col(AiTouchMark.key) == key)
            .values(lesson_id=lesson.id if lesson is not None else None)
        )
        await session.commit()
    if lesson is None:
        raise TouchError("Memory already has a lesson with this text.")
    return {"id": key, "lesson": knowledge.lesson_dict(lesson), "lesson_id": lesson.id}


__all__ = [
    "KINDS",
    "RANGES",
    "TouchError",
    "collect",
    "draft_lesson",
    "is_person",
    "make_lesson",
    "answers_of",
    "carry_answer",
    "record_edit",
    "record_pause",
    "record_signin",
    "set_mark",
    "stepped_in",
]
