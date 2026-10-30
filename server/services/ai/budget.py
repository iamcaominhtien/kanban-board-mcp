"""Budget checks shared by the scheduler, the API loop and the member status: the agent's daily budget, monthly cap
and tokens per day, the board's daily cap, monthly budget and tokens, and the run counts of automatic runs: the
board's runs per day (scheduled and AI-to-AI runs) and the runners' scheduled runs per day. A run a person starts
(a mention, an assignment, a question) is never counted against a run limit. "Today" starts at local midnight and the month on the 1st, local time (design/screens/ai-safety-cost.md, C).
A person can raise today's cap (an approved "Raise cap"); the raise ends at midnight."""

from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import or_
from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiGrant, AiMember, AiProjectSettings, AiRun, AiUsage


def today_start() -> datetime:
    """Local midnight, in UTC."""
    now = datetime.now().astimezone()
    return now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)


def day_key(at: datetime | None = None) -> str:
    """The local calendar day as YYYY-MM-DD."""
    return (at or datetime.now()).astimezone().date().isoformat()


def month_start() -> datetime:
    """The 1st of this month at local midnight, in UTC."""
    now = datetime.now().astimezone()
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)


def local_day(iso: str | None) -> str | None:
    """The local calendar date (YYYY-MM-DD) of a stored UTC time, so "today" rolls over at local midnight."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone().date().isoformat()


def day_bounds(days_ago: int = 0) -> tuple[str, datetime, datetime]:
    """(local date, start, end) in UTC of the local calendar day `days_ago` days back; DST-safe because the day is
    counted on the calendar and each midnight is resolved on its own."""
    day: date = datetime.now().astimezone().date() - timedelta(days=days_ago)
    start = datetime.combine(day, time.min).astimezone().astimezone(UTC)
    end = (
        datetime.combine(day + timedelta(days=1), time.min).astimezone().astimezone(UTC)
    )
    return day.isoformat(), start, end


async def spent(
    session: AsyncSession,
    since: datetime,
    *,
    member_id: str | None = None,
    project_id: str | None = None,
    until: datetime | None = None,
    whole_group: bool = False,
) -> float:
    """Metered spend since `since`: runs of one agent or one project, plus its one-shot calls.
    `whole_group` counts the agent's copies in other projects too (its budget is one)."""
    stmt = select(func.coalesce(func.sum(AiRun.cost_usd), 0.0)).where(
        AiRun.metered == True,  # noqa: E712
        col(AiRun.started_at) >= since.isoformat(),
    )
    if until:
        stmt = stmt.where(col(AiRun.started_at) < until.isoformat())
    ids = [member_id] if member_id else []
    if member_id and whole_group:
        from .multiproject import group_ids

        ids = await group_ids(session, member_id)
    if member_id:
        stmt = stmt.where(col(AiRun.member_id).in_(ids))
    if project_id:
        stmt = stmt.where(AiRun.project_id == project_id)
    runs = float((await session.exec(stmt)).one() or 0.0)
    if not member_id:
        if not project_id:
            return runs
        # The project's one-shot calls (chat, drafts, editor help) count toward the board's caps too
        board_calls = select(func.coalesce(func.sum(AiUsage.cost), 0.0)).where(
            AiUsage.metered == True,  # noqa: E712
            AiUsage.project_id == project_id,
            col(AiUsage.created_at) >= since.isoformat(),
        )
        if until:
            board_calls = board_calls.where(col(AiUsage.created_at) < until.isoformat())
        return runs + float((await session.exec(board_calls)).one() or 0.0)
    # The agent's own one-shot calls (Board AI answers, schedule reviews, dry runs) spend its budget too
    calls = select(func.coalesce(func.sum(AiUsage.cost), 0.0)).where(
        AiUsage.metered == True,  # noqa: E712
        col(AiUsage.member_id).in_(ids),
        col(AiUsage.created_at) >= since.isoformat(),
    )
    if until:
        calls = calls.where(col(AiUsage.created_at) < until.isoformat())
    return runs + float((await session.exec(calls)).one() or 0.0)


async def tokens_since(
    session: AsyncSession,
    since: datetime,
    *,
    member_id: str | None = None,
    project_id: str | None = None,
) -> int:
    """Tokens (in + out) of metered runs since `since`."""
    stmt = select(func.coalesce(func.sum(AiRun.tokens_in + AiRun.tokens_out), 0)).where(
        AiRun.metered == True,  # noqa: E712
        col(AiRun.started_at) >= since.isoformat(),
    )
    if member_id:
        stmt = stmt.where(AiRun.member_id == member_id)
    if project_id:
        stmt = stmt.where(AiRun.project_id == project_id)
    return int((await session.exec(stmt)).one() or 0)


def run_kind(run) -> str:
    """`schedule` for a run a schedule starts, `ai` for a hop of an AI-to-AI @mention chain, else `person`."""
    if run.trigger == "schedule":
        return "schedule"
    return "ai" if (run.chain or "[]") not in ("[]", "") else "person"


async def runs_today(
    session: AsyncSession,
    member_id: str | None,
    *,
    project_id: str | None = None,
    kinds: tuple[str, ...] = ("schedule", "ai"),
) -> int:
    """Automatic runs the agent (or the whole project) started today. `kinds` picks which: `schedule` and `ai`
    (the default); runs a person starts are not counted."""
    stmt = select(func.count()).where(
        col(AiRun.started_at) >= today_start().isoformat()
    )
    scheduled = AiRun.trigger == "schedule"
    chained = AiRun.chain != "[]"
    if kinds == ("schedule",):
        stmt = stmt.where(scheduled)
    else:
        stmt = stmt.where(or_(scheduled, chained))
    if member_id:
        stmt = stmt.where(AiRun.member_id == member_id)
    if project_id:
        stmt = stmt.where(AiRun.project_id == project_id)
    return int((await session.exec(stmt)).one() or 0)


async def _raise_today(session: AsyncSession, member_id: str | None) -> float:
    """Dollars added to today's cap by an approved "Raise cap" (agent, or board when `member_id` is None)."""
    stmt = select(AiGrant).where(
        AiGrant.kind == "cap_raise",
        AiGrant.day == day_key(),
        col(AiGrant.revoked_at).is_(None),
    )
    stmt = stmt.where(
        AiGrant.member_id == member_id
        if member_id
        else col(AiGrant.member_id).is_(None)
    )
    return float(sum(g.amount for g in (await session.exec(stmt)).all()))


def _hit(label: str, reason: str, scope: str, kind: str) -> dict:
    return {"label": label, "reason": reason, "scope": scope, "kind": kind}


async def blocked_detail(
    session: AsyncSession,
    profile: AiMember,
    settings: AiProjectSettings,
    run_kind: str | None = None,
) -> dict | None:
    """Why a budget or limit stops new runs of this agent: {label, reason, scope: agent | board, kind}, or None.
    `kind` is daily, monthly, tokens or runs. The run limits only stop automatic runs: pass the `run_kind` of the
    run that wants to start (`schedule`, `ai` or `person`); without it only budgets are checked."""
    today, month = today_start(), month_start()
    board_runs = settings.board_runs_per_day
    if board_runs and run_kind in ("schedule", "ai"):
        n = await runs_today(session, None, project_id=profile.project_id)
        if n >= board_runs:
            return _hit(
                "Runs per day used up",
                f"Board scheduled and AI-started runs per day used up ({n} of {board_runs}); resets at 00:00",
                "board",
                "runs",
            )
    if profile.connection == "local":
        if profile.max_runs_per_day and run_kind == "schedule":
            n = await runs_today(session, profile.id, kinds=("schedule",))
            if n >= profile.max_runs_per_day:
                return _hit(
                    "Runs per day used up",
                    f"Scheduled runs per day used up ({n} of {profile.max_runs_per_day}); resets at 00:00",
                    "agent",
                    "runs",
                )
        return None
    if profile.connection != "api_key":
        return None
    mine = await spent(session, today, member_id=profile.id, whole_group=True)
    daily = profile.daily_budget
    if daily is not None:
        daily += await _raise_today(session, profile.id)
        if mine >= daily:
            return _hit(
                "Over budget — paused",
                f"Over budget — paused (${mine:.2f} of ${daily:.2f}); resets at 00:00",
                "agent",
                "daily",
            )
    if profile.tokens_per_day:
        used = await tokens_since(session, today, member_id=profile.id)
        if used >= profile.tokens_per_day:
            return _hit(
                "Over budget — paused",
                f"Tokens per day used up ({used:,} of {profile.tokens_per_day:,}); resets at 00:00",
                "agent",
                "tokens",
            )
    if profile.monthly_cap is not None:
        m = await spent(session, month, member_id=profile.id, whole_group=True)
        if m >= profile.monthly_cap:
            return _hit(
                "Over budget — paused",
                f"Monthly cap reached (${m:.2f} of ${profile.monthly_cap:.2f}); resets on the 1st",
                "agent",
                "monthly",
            )
    if settings.board_daily_cap is not None:
        b = await spent(session, today, project_id=profile.project_id)
        cap = settings.board_daily_cap + await _raise_today(session, None)
        if b >= cap:
            return _hit(
                "Over budget — paused",
                f"Board daily cap reached (${b:.2f} of ${cap:.2f}); resets at 00:00",
                "board",
                "daily",
            )
    if settings.board_tokens_per_day:
        used = await tokens_since(session, today, project_id=profile.project_id)
        if used >= settings.board_tokens_per_day:
            return _hit(
                "Over budget — paused",
                f"Board tokens per day used up ({used:,} of {settings.board_tokens_per_day:,}); resets at 00:00",
                "board",
                "tokens",
            )
    if settings.board_monthly_budget is not None:
        b = await spent(session, month, project_id=profile.project_id)
        if b >= settings.board_monthly_budget:
            return _hit(
                "Over budget — paused",
                f"Board monthly budget reached (${b:.2f} of ${settings.board_monthly_budget:.2f})",
                "board",
                "monthly",
            )
    return None


async def blocked(
    session: AsyncSession,
    profile: AiMember,
    settings: AiProjectSettings,
    run_kind: str | None = None,
) -> tuple[str, str] | None:
    """(label, reason) when a budget or limit stops new runs of this agent, else None."""
    hit = await blocked_detail(session, profile, settings, run_kind)
    return (hit["label"], hit["reason"]) if hit else None
