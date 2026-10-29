"""Append-only AI audit log. Each entry carries the hash of the one before it, so an edit or a removed row is
detectable (design/screens/ai-safety-cost.md, E). Entries are redacted before they are written."""

import asyncio
import hashlib
import json
import weakref
from datetime import UTC, datetime, timedelta

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import AiAudit, AiProjectSettings

from .secrets import redact_obj

# One lock per event loop: an asyncio.Lock binds to the first loop that waits on it, and a lock still held
# when its loop closed would block every later loop (the test suite runs each case in a fresh loop).
_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = (
    weakref.WeakKeyDictionary()
)


def _lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _locks.get(loop)
    if lock is None:
        lock = _locks[loop] = asyncio.Lock()
    return lock


def _digest(prev: str, entry: AiAudit) -> str:
    body = json.dumps(
        [
            prev,
            entry.id,
            entry.seq,
            entry.project_id,
            entry.member_id,
            entry.on_behalf_of,
            entry.run_id,
            entry.action,
            entry.target,
            entry.result,
            entry.detail,
            entry.created_at,
        ],
        sort_keys=True,
    )
    return hashlib.sha256(body.encode()).hexdigest()


async def record(
    project_id: str,
    action: str,
    result: str,
    *,
    member_id: str | None = None,
    member_name: str = "",
    on_behalf_of: str | None = None,
    run_id: str | None = None,
    target: str | None = None,
    detail: dict | None = None,
) -> AiAudit:
    """Append an entry in its own session, so it is kept even when the action itself fails."""
    async with _lock():
        async with database.async_session() as session:
            last = (
                await session.exec(
                    select(AiAudit).order_by(col(AiAudit.seq).desc()).limit(1)
                )
            ).first()
            entry = AiAudit(
                seq=(last.seq + 1) if last else 1,
                project_id=project_id,
                member_id=member_id,
                member_name=member_name,
                on_behalf_of=on_behalf_of,
                run_id=run_id,
                action=action,
                target=target,
                result=result,
                detail=json.dumps(redact_obj(detail or {})),
                created_at=datetime.now(UTC).isoformat(),
                prev_hash=last.hash if last else "",
            )
            entry.hash = _digest(entry.prev_hash, entry)
            session.add(entry)
            await session.commit()
            await session.refresh(entry)
            return entry


async def verify_chain(session: AsyncSession) -> dict:
    """Recompute the hash chain; report the first entry that does not match. After retention removed the oldest
    entries the first remaining one anchors the chain."""
    rows = (await session.exec(select(AiAudit).order_by(col(AiAudit.seq)))).all()
    prev = rows[0].prev_hash if rows else ""
    for row in rows:
        if row.prev_hash != prev or _digest(prev, row) != row.hash:
            return {"ok": False, "broken_at": row.id, "checked": len(rows)}
        prev = row.hash
    return {"ok": True, "broken_at": None, "checked": len(rows)}


def to_dict(entry: AiAudit) -> dict:
    """An audit entry for the API."""
    try:
        detail = json.loads(entry.detail or "{}")
    except ValueError:
        detail = {}
    return {
        "id": entry.id,
        "seq": entry.seq,
        "project_id": entry.project_id,
        "member_id": entry.member_id,
        "member_name": entry.member_name,
        "on_behalf_of": entry.on_behalf_of,
        "run_id": entry.run_id,
        "action": entry.action,
        "target": entry.target,
        "result": entry.result,
        "detail": detail,
        "created_at": entry.created_at,
        "reverted_at": entry.reverted_at,
        "reverted_by": entry.reverted_by,
    }


def _filtered(
    stmt,
    *,
    member_id: str | None = None,
    result: str | None = None,
    run_id: str | None = None,
    q: str | None = None,
    actions: list[str] | None = None,
    since: str | None = None,
    until: str | None = None,
    on_behalf_of: str | None = None,
):
    if member_id:
        stmt = stmt.where(AiAudit.member_id == member_id)
    if on_behalf_of:
        stmt = stmt.where(AiAudit.on_behalf_of == on_behalf_of)
    if result:
        stmt = stmt.where(AiAudit.result == result)
    if run_id:
        stmt = stmt.where(AiAudit.run_id == run_id)
    if q:
        stmt = stmt.where(col(AiAudit.target).contains(q.strip().upper()))
    if actions:
        stmt = stmt.where(col(AiAudit.action).in_(actions))
    if since:
        stmt = stmt.where(col(AiAudit.created_at) >= since)
    if until:
        stmt = stmt.where(col(AiAudit.created_at) < until)
    return stmt


async def list_entries(
    session: AsyncSession,
    project_id: str,
    *,
    member_id: str | None = None,
    result: str | None = None,
    run_id: str | None = None,
    q: str | None = None,
    actions: list[str] | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 100,
    before_seq: int | None = None,
    on_behalf_of: str | None = None,
) -> list[AiAudit]:
    """Newest first, with optional filters (`since` / `until` are UTC ISO times; `until` is exclusive)."""
    stmt = _filtered(
        select(AiAudit).where(AiAudit.project_id == project_id),
        member_id=member_id,
        result=result,
        run_id=run_id,
        q=q,
        actions=actions,
        since=since,
        until=until,
        on_behalf_of=on_behalf_of,
    )
    if before_seq:
        stmt = stmt.where(AiAudit.seq < before_seq)
    stmt = stmt.order_by(col(AiAudit.seq).desc()).limit(max(1, min(limit, 500)))
    return list((await session.exec(stmt)).all())


async def count_results(
    session: AsyncSession,
    project_id: str,
    *,
    member_id: str | None = None,
    run_id: str | None = None,
    q: str | None = None,
    actions: list[str] | None = None,
    since: str | None = None,
    until: str | None = None,
    on_behalf_of: str | None = None,
) -> dict[str, int]:
    """Entries per result under every filter but the result itself (the counters beside the filter chips)."""
    stmt = _filtered(
        select(AiAudit.result, func.count())
        .where(AiAudit.project_id == project_id)
        .group_by(AiAudit.result),
        member_id=member_id,
        run_id=run_id,
        q=q,
        actions=actions,
        since=since,
        until=until,
        on_behalf_of=on_behalf_of,
    )
    return {r: n for r, n in (await session.exec(stmt)).all()}


def redaction_count(entry: AiAudit) -> int:
    """How many secrets were masked in the entry before it was saved (the ••••• placeholders)."""
    return (entry.detail or "").count("••••")


async def enrich(session: AsyncSession, rows: list[AiAudit]) -> list[dict]:
    """Entries with the run number and cost columns (E1) and the chips the drawer needs."""
    from models import AiRun

    ids = list({e.run_id for e in rows if e.run_id})
    runs = (
        {
            r.id: r
            for r in (
                await session.exec(select(AiRun).where(col(AiRun.id).in_(ids)))
            ).all()
        }
        if ids
        else {}
    )
    out = []
    for e in rows:
        d = to_dict(e)
        run = runs.get(e.run_id or "")
        d["run_number"] = run.number if run else None
        d["run_cost"] = round(run.cost_usd, 4) if run and run.metered else None
        d["redactions"] = redaction_count(e)
        out.append(d)
    return out


_TRIGGER_TEXT = {
    "assign": "{by} assigned {ticket}",
    "run_button": "{by} started a run on {ticket}",
    "mention": "{by} mentioned the AI on {ticket}",
    "ask": "{by} asked a question on {ticket}",
    "retry": "{by} retried the run on {ticket}",
    "request_changes": "{by} requested changes on {ticket}",
    "answer": "{by} answered the AI on {ticket}",
    "schedule": "A schedule started a run on {ticket}",
}


async def trace(session: AsyncSession, entry: AiAudit) -> list[dict]:
    """Why it did this: the prompt-source trace of an entry (E1). Each step has a trust label."""
    from models import AiApproval, AiRun

    detail = loads_json(entry.detail)
    steps: list[dict] = []
    run = await session.get(AiRun, entry.run_id) if entry.run_id else None
    if run is not None:
        text = _TRIGGER_TEXT.get(run.trigger, "{by} started run #{n} on {ticket}")
        chain = loads_json(run.chain, [])
        steps.append(
            {
                "text": text.format(
                    by=run.started_by, ticket=run.ticket_id, n=run.number
                ),
                "trust": "data_only" if chain else "trusted",
            }
        )
        steps.append(
            {
                "text": f"Run #{run.number} read the {run.ticket_id} description",
                "trust": "trusted",
            }
        )
    source = detail.get("source")
    if isinstance(source, dict) and source.get("comment_id"):
        steps.append(
            {
                "text": f"It also read a flagged comment ({source.get('author') or 'unknown author'})",
                "trust": "untrusted",
            }
        )
    tool = detail.get("tool")
    called = f"Called {tool}.{detail.get('op')}" if tool else entry.action
    label = {
        "approved": "Approval",
        "needs_approval": "Approval",
        "blocked": "Blocked",
        "denied": "Denied",
    }.get(entry.result, "Allowed")
    steps.append({"text": called, "trust": None, "chip": label})
    approval_id = detail.get("approval_id")
    if approval_id and not str(approval_id).startswith("remembered:"):
        a = await session.get(AiApproval, approval_id)
        if a is not None and a.decided_by:
            steps.append(
                {
                    "text": f"{a.status.capitalize()} by {a.decided_by}",
                    "trust": "trusted",
                }
            )
    return steps


def loads_json(value, default=None):
    """json.loads that falls back to `default` (an empty dict unless given)."""
    try:
        out = json.loads(value) if value else None
    except (TypeError, ValueError):
        out = None
    return out if out is not None else ({} if default is None else default)


PROTECTED_DAYS = (
    365  # blocked, denied and injection entries are kept at least this long
)
_PROTECTED_RESULTS = ("blocked", "denied")


async def prune() -> int:
    """Retention: remove entries older than their project's retention from the start of the chain. Blocked,
    denied and injection entries stay a year at least; removal stops at the first entry that has to stay, so the
    chain remains one run of consecutive entries."""
    async with database.async_session() as session:
        settings = {
            s.project_id: s
            for s in (await session.exec(select(AiProjectSettings))).all()
        }
        if not any(s.audit_retention_days for s in settings.values()):
            return 0
        now = datetime.now(UTC)
        removed = 0
        while True:
            batch = (
                await session.exec(
                    select(AiAudit).order_by(col(AiAudit.seq)).limit(200)
                )
            ).all()
            if not batch:
                break
            stop = False
            for e in batch:
                s = settings.get(e.project_id)
                days = s.audit_retention_days if s else None
                if not days:
                    stop = True
                    break
                keep = days
                if e.result in _PROTECTED_RESULTS or e.action == "injection_detected":
                    keep = max(days, PROTECTED_DAYS)
                if e.created_at >= (now - timedelta(days=keep)).isoformat():
                    stop = True
                    break
                await session.delete(e)
                removed += 1
            await session.commit()
            if stop:
                break
        return removed
