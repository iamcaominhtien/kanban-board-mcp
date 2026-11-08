"""Board health on the assistant engine (AI v2): "Run now" is one turn with the `board-health` skill; its findings
are kept as `ai_insight` rows (re-found ones are updated, not duplicated). Snooze, dismiss and restore are plain
code. Acting on an insight used to prepare a draft to apply; now the person asks the Board AI in the chat."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from models import AiDigest, AiInsight
from services.ai.store import loads, now_iso

from . import engine, sessions
from . import settings as svc_settings
from .errors import AssistError

KINDS = ("stuck", "wip", "chain", "unassigned", "at_risk", "priority")


def insight_out(i: AiInsight) -> dict[str, Any]:
    """An insight as the API shows it."""
    return {
        "id": i.id,
        "project_id": i.project_id,
        "kind": i.kind,
        "ticket_id": i.ticket_id,
        "title": i.title,
        "detail": i.detail,
        "data": loads(i.data, {}),
        "score": i.score,
        "state": i.state,
        "snoozed_until": i.snoozed_until,
        "seen": i.seen,
        "draft_id": None,
        "created_at": i.created_at,
        "updated_at": i.updated_at,
    }


def _when(iso: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(iso) if iso else None
    except ValueError:
        return None


async def _rows(session: AsyncSession, project_id: str) -> list[AiInsight]:
    rows = list(
        (
            await session.exec(
                select(AiInsight).where(AiInsight.project_id == project_id)
            )
        ).all()
    )
    now = datetime.now(UTC)
    woke = False
    for i in rows:
        if i.state == "snoozed" and (_when(i.snoozed_until) or now) <= now:
            i.state, i.seen, woke = "open", False, True
            session.add(i)
    if woke:
        await session.commit()
    return rows


async def panel(session: AsyncSession, project_id: str) -> dict[str, Any]:
    """The Board health panel: the latest digest, insights by state, the schedule, the unseen count."""
    row = await svc_settings.get(session)
    cfg = svc_settings.health_config(row)
    member, _profile = await svc_settings.first_team(session, project_id)
    team_name = member.name if member else "Board AI"
    rows = await _rows(session, project_id)
    needs = sorted(
        [i for i in rows if i.state == "open"], key=lambda i: i.score, reverse=True
    )[: int(cfg.get("max_insights") or 8)]
    dg = (
        await session.exec(
            select(AiDigest)
            .where(AiDigest.project_id == project_id)
            .order_by(col(AiDigest.created_at).desc())
            .limit(1)
        )
    ).first()
    return {
        "digest": (
            {
                "id": dg.id,
                "day": dg.day,
                "created_at": dg.created_at,
                "cost": dg.cost,
                "tokens": dg.tokens,
                **loads(dg.summary, {}),
            }
            if dg
            else None
        ),
        "needs_action": [insight_out(i) for i in needs],
        "snoozed": [insight_out(i) for i in rows if i.state == "snoozed"],
        "dismissed": [insight_out(i) for i in rows if i.state == "dismissed"],
        "unseen": len([i for i in needs if not i.seen]),
        "drafts": [],
        "schedule": cfg,
        "board_ai": team_name,
        "enabled": svc_settings.features(row).get("health", True),
    }


async def chips(session: AsyncSession, project_id: str) -> list[dict[str, Any]]:
    """Insight chips for board cards: the strongest open insight of each ticket."""
    out: dict[str, dict[str, Any]] = {}
    for i in sorted(
        await _rows(session, project_id), key=lambda i: i.score, reverse=True
    ):
        if i.state != "open" or not i.ticket_id or i.ticket_id in out:
            continue
        out[i.ticket_id] = {
            "ticket_id": i.ticket_id,
            "label": loads(i.data, {}).get("chip")
            or i.kind.replace("_", " ").capitalize(),
            "why": i.title,
            "insight_id": i.id,
            "kind": i.kind,
        }
    return list(out.values())


async def check(project_id: str, by: str) -> dict[str, Any]:
    """Run the check now: the assistant reads the board and says what needs attention."""
    async with database.async_session() as session:
        if not await svc_settings.feature_on(session, "health"):
            raise AssistError("feature_off", "Board health is off in Settings › AI.")
    out = await engine.turn(
        project_id,
        name=sessions.board_name(project_id) + ":health",
        skill="board-health",
        inputs={"project_id": project_id},
        by=by,
        feature="health",
    )
    if out.state != "finished":
        raise AssistError("unavailable", out.error or "The check could not finish.")
    data = out.data()
    found: set[str] = set()
    async with database.async_session() as session:
        existing = {
            i.key: i
            for i in (
                await session.exec(
                    select(AiInsight).where(AiInsight.project_id == project_id)
                )
            ).all()
        }
        for item in data.get("insights") or []:
            if not isinstance(item, dict) or not item.get("title"):
                continue
            kind = item.get("kind") if item.get("kind") in KINDS else "at_risk"
            key = hashlib.sha1(
                f"{kind}\0{item.get('ticket_id') or ''}\0{item['title']}".encode()
            ).hexdigest()[:16]
            found.add(key)
            row = existing.get(key)
            if row is None:
                row = AiInsight(
                    project_id=project_id,
                    kind=kind,
                    key=key,
                    ticket_id=item.get("ticket_id") or None,
                    title=str(item["title"])[:200],
                )
            elif row.state == "resolved":
                row.state, row.seen = "open", False
            row.detail = str(item.get("detail") or "")[:1000]
            row.data = json.dumps(
                item.get("data") if isinstance(item.get("data"), dict) else {}
            )
            row.score = float(item.get("score") or 0)
            row.updated_at = now_iso()
            session.add(row)
        for key, row in existing.items():
            if key not in found and row.state == "open":
                row.state, row.updated_at = "resolved", now_iso()
                session.add(row)
        if data.get("summary"):
            session.add(
                AiDigest(
                    project_id=project_id,
                    day=now_iso()[:10],
                    summary=json.dumps(
                        {
                            "text": str(data["summary"]),
                            "done": [],
                            "in_progress": [],
                            "blocked": [],
                            "tickets": len(found),
                        }
                    ),
                    cost=out.cost,
                    tokens=out.tokens_in + out.tokens_out,
                )
            )
        await session.commit()
        result = await panel(session, project_id)
    await board_events.publish(board_events.INVALIDATE)
    return result


async def set_state(
    session: AsyncSession, insight_id: str, action: str, *, hours: int = 24
) -> dict[str, Any]:
    """Snooze, dismiss or restore an insight."""
    i = await session.get(AiInsight, insight_id)
    if i is None:
        raise AssistError("not_found", "Insight not found.")
    if action == "snooze":
        i.state, i.snoozed_until = (
            "snoozed",
            (datetime.now(UTC) + timedelta(hours=max(1, hours))).isoformat(),
        )
    elif action == "dismiss":
        i.state = "dismissed"
    elif action == "restore":
        i.state, i.snoozed_until = "open", None
    elif action == "act":
        raise AssistError(
            "gone", "Drafts are gone in AI v2: ask the Board AI in the chat to do this."
        )
    else:
        raise AssistError("invalid", "Unknown action.")
    i.updated_at = now_iso()
    session.add(i)
    await session.commit()
    await session.refresh(i)
    await board_events.publish(board_events.INVALIDATE)
    return insight_out(i)


async def snooze_all(session: AsyncSession, project_id: str, hours: int = 24) -> int:
    """Snooze every open insight. Returns how many."""
    rows = (
        await session.exec(
            select(AiInsight).where(
                AiInsight.project_id == project_id, AiInsight.state == "open"
            )
        )
    ).all()
    until = (datetime.now(UTC) + timedelta(hours=hours)).isoformat()
    for i in rows:
        i.state, i.snoozed_until = "snoozed", until
        session.add(i)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return len(rows)


async def mark_seen(session: AsyncSession, project_id: str) -> None:
    """The panel was opened: nothing is unseen any more."""
    rows = (
        await session.exec(
            select(AiInsight).where(
                AiInsight.project_id == project_id, col(AiInsight.seen).is_(False)
            )
        )
    ).all()  # noqa: E712
    for i in rows:
        i.seen = True
        session.add(i)
    await session.commit()
