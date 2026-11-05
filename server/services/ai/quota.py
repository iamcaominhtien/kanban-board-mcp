"""The usage window of a Claude account (design/screens/ai-operations.md, E).

On a subscription what runs out is the window of an account, not money. Claude Code reports it in every run's stream:
``{"type": "rate_limit_event", "rate_limit_info": {"status", "resetsAt", "rateLimitType", "unifiedWindows":
{"five_hour": {"utilization": 0..1, "resetsAt", "status"}, "seven_day": {...}}}}`` (spike S5). The board keeps the last
reading per account and, when a window is used up, holds every run of that account until it reopens. A hold is not a
failure and is never counted as a try.

An account here is an ``AiAccount`` id, or ``"local"`` for Claude Code members that run on the person's own CLI
login (``"local:<provider>"`` for another CLI's own login, so its runs never count on Claude's). Windows and slots
are Claude's: only Claude Code runs wait on them.

Concurrency: at most ``max_parallel`` CLI runs per account at once (2 by default, set per account).
"""

from datetime import UTC, datetime

from sqlmodel import col, select

import database
from models import AiAccount, AiAccountState, AiTeam, AiRun

LOCAL = "local"
DEFAULT_PARALLEL = 2
NEAR = 0.8  # "quota near" signal and the bar's amber


def key_for(profile: AiTeam | None, run: AiRun | None = None) -> str:
    """Which account a run spends: the run's own override (urgent work moved), else the member's account, else this
    computer's own login of the member's CLI."""
    if run is not None and getattr(run, "account_id", None):
        return run.account_id
    if profile is not None and profile.account_id:
        return profile.account_id
    provider = (profile.provider if profile else None) or "claude-code"
    return LOCAL if provider == "claude-code" else f"{LOCAL}:{provider}"


def _iso(epoch) -> str | None:
    try:
        return datetime.fromtimestamp(int(epoch), UTC).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


async def state(session, key: str) -> AiAccountState:
    """The account's row, created on first use."""
    row = await session.get(AiAccountState, key)
    if row is None:
        await database.insert_missing(session, AiAccountState, key=key)
        row = await session.get(AiAccountState, key)
    return row


def parse_event(event: dict) -> dict | None:
    """A ``rate_limit_event`` → {status, resets_at, type, five_hour: {used, resets_at, status}, seven_day: {...}}."""
    if not isinstance(event, dict) or event.get("type") != "rate_limit_event":
        return None
    info = event.get("rate_limit_info") or {}
    out: dict = {
        "status": info.get("status"),
        "resets_at": _iso(info.get("resetsAt")),
        "type": info.get("rateLimitType"),
    }
    for name, window in (info.get("unifiedWindows") or {}).items():
        if isinstance(window, dict):
            out[name] = {
                "used": window.get("utilization"),
                "resets_at": _iso(window.get("resetsAt")),
                "status": window.get("status"),
            }
    return out


async def record(key: str, reading: dict) -> AiAccountState:
    """Keep the latest reading of an account; a rejected window holds the account until it reopens."""
    async with database.async_session() as session:
        row = await state(session, key)
        for name, prefix in (("five_hour", "five_hour"), ("seven_day", "seven_day")):
            w = reading.get(name)
            if not w:
                continue
            if isinstance(w.get("used"), (int, float)):
                setattr(row, f"{prefix}_used", float(w["used"]))
            setattr(row, f"{prefix}_resets_at", w.get("resets_at"))
            setattr(row, f"{prefix}_status", w.get("status"))
        if reading.get("status") == "rejected" and reading.get("resets_at"):
            hold(row, reading["resets_at"], reading.get("type"))
        row.updated_at = datetime.now(UTC).isoformat()
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row


def hold(row: AiAccountState, until: str, window: str | None = None) -> None:
    """Hold every run of the account until `until` (the reset the CLI reported)."""
    current = row.held_until
    if current is None or current < until:
        row.held_until = until
    label = {"five_hour": "5-hour", "seven_day": "weekly"}.get(window or "", "usage")
    row.held_reason = f"The {label} window is used up"


async def hold_until(key: str, until: str, window: str | None = None) -> None:
    """Hold an account from outside a reading (a result that says the limit was hit)."""
    async with database.async_session() as session:
        row = await state(session, key)
        hold(row, until, window)
        row.updated_at = datetime.now(UTC).isoformat()
        session.add(row)
        await session.commit()


def held(row: AiAccountState | None, now: datetime | None = None) -> str | None:
    """The reset time while the account is held, else None."""
    if row is None or not row.held_until:
        return None
    try:
        until = datetime.fromisoformat(row.held_until)
    except ValueError:
        return None
    return row.held_until if until > (now or datetime.now(UTC)) else None


async def release_expired(session) -> list[str]:
    """Accounts whose window reopened: clear the hold (their runs start in the same tick)."""
    rows = (
        await session.exec(
            select(AiAccountState).where(col(AiAccountState.held_until).is_not(None))
        )
    ).all()
    out = []
    for row in rows:
        if held(row) is None:
            row.held_until = None
            row.held_reason = None
            session.add(row)
            out.append(row.key)
    if out:
        await session.commit()
    return out


async def running_on(session, key: str) -> list[AiRun]:
    """CLI runs going on an account right now."""
    rows = (
        await session.exec(
            select(AiRun, AiTeam)
            .join(AiTeam, AiTeam.id == AiRun.member_id)
            .where(
                col(AiRun.state).in_(["starting", "running"]),
                AiTeam.connection != "api_key",
            )
        )
    ).all()
    return [run for run, profile in rows if key_for(profile, run) == key]


def _local(when: str | None) -> str:
    try:
        return (
            datetime.fromisoformat(when).astimezone().strftime("%H:%M") if when else ""
        )
    except ValueError:
        return ""


async def blocking(session, run: AiRun, profile: AiTeam) -> str | None:
    """Why a queued CLI run waits on its account (the window or the slots), or None."""
    if profile.connection == "api_key" or profile.provider != "claude-code":
        # windows and slots are Claude's (the accounts page shows only those): another CLI is not held by them
        return None
    key = key_for(profile, run)
    # A check only reads: an account without a row yet is not held and has the default slots. Creating the row here
    # made every scheduler tick a write (taking SQLite's write lock) for nothing
    row = await session.get(AiAccountState, key) or AiAccountState(key=key)
    until = held(row)
    if until:
        return f"Waiting for the next window: {row.held_reason or 'the usage window is used up'}, reopens {_local(until)}"
    going = [r for r in await running_on(session, key) if r.id != run.id]
    limit = max(1, row.max_parallel or DEFAULT_PARALLEL)
    if len(going) >= limit:
        return (
            f"Waiting for a free slot on the account ({len(going)} of {limit} in use)"
        )
    return None


async def room(session, exclude: str | None = None) -> list[dict]:
    """Claude accounts that could take one more run now: signed in, not held, a slot free. Best first."""
    accounts = (
        await session.exec(
            select(AiAccount).where(
                AiAccount.cli == "claude", AiAccount.status == "signed_in"
            )
        )
    ).all()
    out = []
    for acct in accounts:
        if acct.id == exclude:
            continue
        row = await state(session, acct.id)
        if held(row):
            continue
        going = len(await running_on(session, acct.id))
        limit = max(1, row.max_parallel or DEFAULT_PARALLEL)
        if going >= limit:
            continue
        out.append(
            {
                "account_id": acct.id,
                "name": acct.name,
                "email": acct.email,
                "plan": acct.plan,
                "used": row.five_hour_used,
                "free": limit - going,
            }
        )
    return sorted(out, key=lambda a: a["used"] if a["used"] is not None else 0.5)


async def overview(session) -> list[dict]:
    """Every account's window for the accounts page: used, reset, held, slots, what waits on it."""
    accounts = (
        await session.exec(select(AiAccount).where(AiAccount.cli == "claude"))
    ).all()
    keys = [(a.id, a) for a in accounts]
    has_local = (
        await session.exec(
            select(AiTeam).where(
                col(AiTeam.account_id).is_(None),
                AiTeam.provider == "claude-code",
                AiTeam.connection != "api_key",
            )
        )
    ).first()
    if has_local:
        keys.append((LOCAL, None))
    queued = (
        await session.exec(
            select(AiRun, AiTeam)
            .join(AiTeam, AiTeam.id == AiRun.member_id)
            .where(AiRun.state == "queued")
        )
    ).all()
    out = []
    for key, acct in keys:
        row = await state(session, key)
        going = await running_on(session, key)
        waiting = [r for r, p in queued if key_for(p, r) == key]
        out.append(
            {
                "key": key,
                "name": acct.name if acct else "This computer's own Claude login",
                "email": acct.email if acct else None,
                "plan": acct.plan if acct else None,
                "status": acct.status if acct else "signed_in",
                "max_parallel": row.max_parallel or DEFAULT_PARALLEL,
                "running": [
                    {
                        "run_id": r.id,
                        "ticket_id": r.ticket_id,
                        "member_id": r.member_id,
                        "started_at": r.started_at,
                    }
                    for r in going
                ],
                "waiting": len(waiting),
                "five_hour": {
                    "used": row.five_hour_used,
                    "resets_at": row.five_hour_resets_at,
                    "status": row.five_hour_status,
                },
                "seven_day": {
                    "used": row.seven_day_used,
                    "resets_at": row.seven_day_resets_at,
                    "status": row.seven_day_status,
                },
                "held_until": held(row),
                "held_reason": row.held_reason if held(row) else None,
                "move_urgent": row.move_urgent,
                "read_at": row.updated_at,
            }
        )
    await session.commit()
    return out


async def set_account(
    session,
    key: str,
    *,
    max_parallel: int | None = None,
    move_urgent: bool | None = None,
) -> AiAccountState:
    """Change an account's limit or its "move urgent work by itself" switch."""
    row = await state(session, key)
    if max_parallel is not None:
        row.max_parallel = max(1, min(int(max_parallel), 20))
    if move_urgent is not None:
        row.move_urgent = bool(move_urgent)
    row.updated_at = datetime.now(UTC).isoformat()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row
