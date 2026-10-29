"""The usage dashboard and the limits table (design/screens/ai-safety-cost.md, C1 and C4).

All days are local days: "today" starts at local midnight, the month on the 1st (budget.today_start / month_start).
Runs are counted on the day they started; spend is the metered cost of those runs.
"""

import csv
import io
from datetime import datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, AiRun, Member, Ticket

from . import budget
from .members import _secs
from .providers import PRICES, PRICES_UPDATED
from .store import get_settings, loads

RANGES = ("today", "7d", "month", "custom")


def _local(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    return dt.astimezone() if dt.tzinfo else dt.astimezone()


def resolve_range(
    key: str, since: str | None, until: str | None
) -> tuple[str, datetime, datetime]:
    """(key, first local midnight, local midnight after the last day) of a range."""
    today = budget.today_start().astimezone()
    tomorrow = today + timedelta(days=1)
    if key == "today":
        return key, today, tomorrow
    if key == "7d":
        return key, today - timedelta(days=6), tomorrow
    if key == "custom" and since:
        try:
            a = datetime.fromisoformat(since).astimezone()
            b = (
                datetime.fromisoformat(until).astimezone() + timedelta(days=1)
                if until
                else tomorrow
            )
            if b > a:
                return key, a, min(b, a + timedelta(days=366))
        except ValueError:
            pass
    first = budget.month_start().astimezone()
    return "month", first, tomorrow


async def _runs_between(
    session: AsyncSession, project_id: str, a: datetime, b: datetime
) -> list[AiRun]:
    rows = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                col(AiRun.started_at) >= a.isoformat(),
                col(AiRun.started_at) < b.isoformat(),
            )
        )
    ).all()
    return list(rows)


def _day(run: AiRun) -> str:
    d = _local(run.started_at)
    return d.date().isoformat() if d else ""


async def dashboard(
    session: AsyncSession,
    project_id: str,
    key: str = "month",
    since: str | None = None,
    until: str | None = None,
) -> dict:
    """Everything the dashboard shows for a range: tiles, stacked days with the forecast, the agent table, the most
    expensive runs, spend by ticket and the price table."""
    key, a, b = resolve_range(key, since, until)
    settings = await get_settings(session, project_id)
    members = {
        m.id: m
        for m in (
            await session.exec(select(Member).where(Member.project_id == project_id))
        ).all()
    }
    profiles = {
        p.id: p
        for p in (
            await session.exec(
                select(AiMember).where(AiMember.project_id == project_id)
            )
        ).all()
    }
    runs = await _runs_between(session, project_id, a, b)

    def name(mid: str) -> str:
        return members[mid].name if mid in members else "Removed"

    # --- days, stacked by agent
    days: dict[str, dict] = {}
    cursor = a
    while cursor < b:
        days[cursor.date().isoformat()] = {
            "date": cursor.date().isoformat(),
            "cost_usd": 0.0,
            "runs": 0,
            "by_agent": {},
            "forecast": False,
        }
        cursor += timedelta(days=1)
    series_ids: list[str] = []
    for r in runs:
        d = days.get(_day(r))
        if d is None:
            continue
        d["runs"] += 1
        if r.metered:
            d["cost_usd"] += r.cost_usd
            d["by_agent"][r.member_id] = (
                d["by_agent"].get(r.member_id, 0.0) + r.cost_usd
            )
            if r.member_id not in series_ids:
                series_ids.append(r.member_id)

    # --- forecast at the 7-day average (month view only)
    today_dt = budget.today_start().astimezone()
    last7 = [today_dt - timedelta(days=i) for i in range(7)]
    week_runs = await _runs_between(
        session, project_id, last7[-1], today_dt + timedelta(days=1)
    )
    week_total = sum(r.cost_usd for r in week_runs if r.metered)
    per_day = week_total / 7
    month_first = budget.month_start().astimezone()
    month_runs = await _runs_between(
        session, project_id, month_first, today_dt + timedelta(days=1)
    )
    month_spent = sum(r.cost_usd for r in month_runs if r.metered)
    next_month = (month_first.replace(day=28) + timedelta(days=4)).replace(day=1)
    last_day = next_month - timedelta(days=1)
    remaining = max(0, (last_day.date() - today_dt.date()).days)
    forecast = month_spent + per_day * remaining
    if key == "month":
        for i in range(1, remaining + 1):
            dt = today_dt + timedelta(days=i)
            days[dt.date().isoformat()] = {
                "date": dt.date().isoformat(),
                "cost_usd": round(per_day, 4),
                "runs": 0,
                "by_agent": {},
                "forecast": True,
            }
    month_budget = settings.board_monthly_budget
    today_spent = sum(
        r.cost_usd
        for r in await _runs_between(
            session, project_id, today_dt, today_dt + timedelta(days=1)
        )
        if r.metered
    )

    # --- agents
    month_by_agent: dict[str, float] = {}
    for r in month_runs:
        if r.metered:
            month_by_agent[r.member_id] = (
                month_by_agent.get(r.member_id, 0.0) + r.cost_usd
            )
    agents: dict[str, dict] = {}
    for r in runs:
        e = agents.setdefault(
            r.member_id,
            {
                "member_id": r.member_id,
                "name": name(r.member_id),
                "provider": profiles[r.member_id].provider
                if r.member_id in profiles
                else None,
                "runs": 0,
                "tokens": 0,
                "seconds": 0,
                "cost_usd": 0.0,
                "metered": r.metered,
            },
        )
        e["runs"] += 1
        e["tokens"] += r.tokens_in + r.tokens_out
        e["seconds"] += _secs(r)
        e["cost_usd"] += r.cost_usd if r.metered else 0.0
    for mid, e in agents.items():
        p = profiles.get(mid)
        cap = p.monthly_cap if p else None
        e["monthly_cap"] = cap
        e["pct_of_cap"] = (
            round(month_by_agent.get(mid, 0.0) / cap * 100)
            if cap and e["metered"]
            else None
        )
        e["cost_usd"] = round(e["cost_usd"], 4)

    # --- most expensive runs and spend by ticket
    metered_runs = [r for r in runs if r.metered]
    top = sorted(metered_runs, key=lambda r: r.cost_usd, reverse=True)[:5]
    by_ticket: dict[str, dict] = {}
    for r in runs:
        t = by_ticket.setdefault(
            r.ticket_id, {"ticket_id": r.ticket_id, "runs": 0, "cost_usd": 0.0}
        )
        t["runs"] += 1
        t["cost_usd"] += r.cost_usd if r.metered else 0.0
    ticket_rows = sorted(by_ticket.values(), key=lambda t: -t["cost_usd"])[:5]
    titles = {
        t.id: t.title
        for t in (
            await session.exec(
                select(Ticket).where(
                    col(Ticket.id).in_([t["ticket_id"] for t in ticket_rows])
                )
            )
        ).all()
    }
    api_runs = sum(1 for r in runs if r.metered)
    return {
        "range": {
            "key": key,
            "since": a.date().isoformat(),
            "until": (b - timedelta(days=1)).date().isoformat(),
        },
        "tiles": {
            "spend": round(sum(r.cost_usd for r in runs if r.metered), 4),
            "month_spend": round(month_spent, 4),
            "month_budget": month_budget,
            "today": round(today_spent, 4),
            "daily_cap": settings.board_daily_cap,
            "forecast": round(forecast, 2),
            "forecast_per_day": round(per_day, 2),
            "forecast_date": last_day.date().isoformat(),
            "forecast_within": month_budget is None or forecast <= month_budget,
            "runs": len(runs),
            "api_runs": api_runs,
            "local_runs": len(runs) - api_runs,
        },
        "days": [
            {
                "date": d["date"],
                "cost_usd": round(d["cost_usd"], 4),
                "runs": d["runs"],
                "forecast": d["forecast"],
                "by_agent": [
                    {"member_id": mid, "cost_usd": round(c, 4)}
                    for mid, c in d["by_agent"].items()
                ],
            }
            for d in sorted(days.values(), key=lambda d: d["date"])
        ],
        "series": [{"member_id": mid, "name": name(mid)} for mid in series_ids],
        "agents": sorted(agents.values(), key=lambda e: (-e["cost_usd"], -e["runs"])),
        "top_runs": [
            {
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "number": r.number,
                "name": name(r.member_id),
                "cost_usd": round(r.cost_usd, 4),
                "tokens_in": r.tokens_in,
            }
            for r in top
        ],
        "tickets": [
            {
                "ticket_id": t["ticket_id"],
                "title": titles.get(t["ticket_id"], ""),
                "runs": t["runs"],
                "cost_usd": round(t["cost_usd"], 4),
            }
            for t in ticket_rows
        ],
        "prices": {
            "updated": PRICES_UPDATED,
            "rows": [
                {"model": model, "input": pin, "output": pout}
                for model, (pin, pout) in PRICES.items()
            ],
        },
        "board_daily_cap": settings.board_daily_cap,
        "board_monthly_budget": settings.board_monthly_budget,
    }


def to_csv(data: dict) -> str:
    """The dashboard's days and agents as CSV (Export CSV)."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["section", "key", "runs", "tokens", "seconds", "cost_usd"])
    for d in data["days"]:
        if not d["forecast"]:
            w.writerow(["day", d["date"], d["runs"], "", "", f"{d['cost_usd']:.4f}"])
    for a in data["agents"]:
        w.writerow(
            [
                "agent",
                a["name"],
                a["runs"],
                a["tokens"],
                a["seconds"],
                f"{a['cost_usd']:.4f}" if a["metered"] else "not metered",
            ]
        )
    for t in data["tickets"]:
        w.writerow(
            ["ticket", t["ticket_id"], t["runs"], "", "", f"{t['cost_usd']:.4f}"]
        )
    return buf.getvalue()


def _cell(used: float | int, cap: float | int | None) -> dict:
    return {
        "used": round(used, 4) if isinstance(used, float) else used,
        "cap": cap,
        "full": bool(cap) and used >= cap,
    }


async def limits(session: AsyncSession, project_id: str) -> dict:
    """The limits table: one row for the board and one per agent, with what is used now (C4)."""
    settings = await get_settings(session, project_id)
    today, month = budget.today_start(), budget.month_start()
    members = {
        m.id: m
        for m in (
            await session.exec(
                select(Member).where(
                    Member.project_id == project_id, Member.kind == "ai"
                )
            )
        ).all()
    }
    profiles = (
        await session.exec(
            select(AiMember)
            .where(AiMember.project_id == project_id)
            .order_by(AiMember.created_at)
        )
    ).all()
    running = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                col(AiRun.state).in_(["starting", "running"]),
            )
        )
    ).all()
    board = {
        "name": "All AI in this board",
        "daily": _cell(
            await budget.spent(session, today, project_id=project_id),
            settings.board_daily_cap,
        ),
        "monthly": _cell(
            await budget.spent(session, month, project_id=project_id),
            settings.board_monthly_budget,
        ),
        "tokens": _cell(
            await budget.tokens_since(session, today, project_id=project_id),
            settings.board_tokens_per_day,
        ),
        "parallel": _cell(len(running), settings.board_max_parallel),
        "runs": _cell(
            await budget.runs_today(session, None, project_id=project_id),
            settings.board_runs_per_day,
        ),
        "at_cap": settings.board_at_cap,
    }
    rows = []
    for p in profiles:
        m = members.get(p.id)
        if m is None:
            continue
        cfg = loads(p.config, {})
        metered = p.connection == "api_key"
        row = {
            "member_id": p.id,
            "name": m.name,
            "provider": p.provider,
            "connection": p.connection,
            "metered": metered,
            "parallel": p.max_parallel,
            "at_cap": cfg.get("at_cap", "pause"),
            "per_run_minutes": cfg.get("run_timeout_min", 30) if not metered else None,
            "cap_per_run": p.cap_per_run if metered else None,
            "runs": _cell(await budget.runs_today(session, p.id), p.max_runs_per_day)
            if not metered
            else None,
        }
        if metered:
            row["daily"] = _cell(
                await budget.spent(session, today, member_id=p.id), p.daily_budget
            )
            row["monthly"] = _cell(
                await budget.spent(session, month, member_id=p.id), p.monthly_cap
            )
            row["tokens"] = _cell(
                await budget.tokens_since(session, today, member_id=p.id),
                p.tokens_per_day,
            )
        rows.append(row)
    return {"board": board, "agents": rows}
