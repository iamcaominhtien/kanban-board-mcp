"""When the whole project was paused: intervals read from the audit log (Pause all AI and Resume entries).

Paused time is its own measure: it is not waiting for a person and not a bottleneck (design/screens/ai-paused.md, G)."""

from datetime import UTC, datetime

from sqlmodel.ext.asyncio.session import AsyncSession

from . import audit
from .store import get_settings, loads, parse_iso


async def intervals(
    session: AsyncSession,
    project_id: str,
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[dict]:
    """Pauses overlapping [since, until], oldest first: {from, to, by, reason, resumed_by}. `to` is None while the
    project is still paused. Times are clipped to the window."""
    now = datetime.now(UTC)
    until = until or now
    rows = await audit.list_entries(
        session, project_id, actions=["kill_switch", "resume_all"], limit=500
    )
    rows = sorted(rows, key=lambda e: e.created_at or "")
    out: list[dict] = []
    open_: dict | None = None
    for e in rows:
        at = parse_iso(e.created_at)
        if at is None:
            continue
        if e.action == "kill_switch":
            detail = loads(e.detail, {})
            if (
                open_ is not None
            ):  # paused twice: the first one ended when the second began
                open_["to"] = at
                out.append(open_)
            open_ = {
                "from": at,
                "to": None,
                "by": e.member_name or e.on_behalf_of or None,
                "reason": (detail.get("reason") or "").strip() or None,
                "resumed_by": None,
            }
        elif open_ is not None:
            open_["to"] = at
            open_["resumed_by"] = e.member_name or e.on_behalf_of or None
            out.append(open_)
            open_ = None
    settings = await get_settings(session, project_id)
    if settings.paused_all:
        if open_ is None:
            # The entry was pruned: the settings still know when and by whom
            open_ = {
                "from": parse_iso(settings.paused_at) or now,
                "to": None,
                "by": settings.paused_by,
                "reason": settings.paused_reason,
                "resumed_by": None,
            }
        out.append(open_)
    elif open_ is not None:
        # Resumed without an entry (pruned): treat it as over now
        open_["to"] = now
        out.append(open_)
    result = []
    for p in out:
        end = p["to"] or until
        if end <= (since or datetime.min.replace(tzinfo=UTC)) or p["from"] >= until:
            continue
        result.append(
            {
                **p,
                "from": max(p["from"], since) if since else p["from"],
                "to": (min(end, until).isoformat() if p["to"] is not None else None),
            }
        )
        result[-1]["from"] = result[-1]["from"].isoformat()
    return result


def overlap_s(pauses: list[dict], start: datetime, end: datetime) -> float:
    """Seconds of [start, end] that fall inside a pause (an open pause runs to `end`)."""
    total = 0.0
    for p in pauses:
        a = parse_iso(p["from"])
        b = parse_iso(p["to"]) if p["to"] else end
        if a is None or b is None:
            continue
        lo, hi = max(a, start), min(b, end)
        if hi > lo:
            total += (hi - lo).total_seconds()
    return total
