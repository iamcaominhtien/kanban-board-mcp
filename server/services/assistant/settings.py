"""Board-wide assistant settings (the `ai_assist_settings` row): feature switches, tone, caps; usage metering."""

from typing import Any

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import AiAssistSettings, AiTeam, AiUsage, DocsAiSettings, Member
from services.ai import budget
from services.ai.store import loads, now_iso

from .errors import AssistError

FEATURES = {
    "chat": "Ask AI (chat)",
    "drafting": "Drafting in editors",
    "health": "Board health",
    "docs": "Docs AI",
    "sketch": "Sketch AI",
}
DESCRIPTIONS = {
    "chat": "Ask AI dock, ⌘J, answers with sources",
    "drafting": "Ask AI, rewrite and continue in every editor",
    "health": "Daily insights",
    "docs": "Summaries, sections, link suggestions",
    "sketch": "Draw and edit sketches with AI",
}
DEFAULT_FEATURES = {k: True for k in FEATURES}
DEFAULT_HEALTH = {
    "on": True,
    "time": "08:00",
    "days": [0, 1, 2, 3, 4],
    "stuck_days": 3,
    "wip_limit": 3,
    "max_insights": 8,
    "return_if_worse": True,
    "weekend": False,
    "badge_toast": True,
    "offer_draft": False,
}
TONES = ("neutral", "friendly", "concise")
STYLE_GUIDE_MAX = 1000


async def get(session: AsyncSession) -> AiAssistSettings:
    """The board-wide assistant settings, created with defaults on first use."""
    row = await session.get(AiAssistSettings, 1)
    if row is None:
        await database.insert_missing(session, AiAssistSettings, id=1)
        await session.commit()
        row = await session.get(AiAssistSettings, 1)
    return row


def features(row: AiAssistSettings) -> dict[str, bool]:
    """The feature switches, with defaults."""
    return {**DEFAULT_FEATURES, **loads(row.features, {})}


def health_config(row: AiAssistSettings) -> dict:
    """The board-health schedule, with defaults."""
    return {**DEFAULT_HEALTH, **loads(row.health, {})}


async def feature_on(session: AsyncSession, feature: str) -> bool:
    """Whether a feature is switched on."""
    return features(await get(session)).get(feature, True)


async def month_spend(session: AsyncSession, feature: str | None = None) -> float:
    """What the assistants cost this month (one feature, or all)."""
    stmt = select(func.coalesce(func.sum(AiUsage.cost), 0.0)).where(
        col(AiUsage.created_at) >= budget.month_start().isoformat()
    )
    if feature:
        stmt = stmt.where(AiUsage.feature == feature)
    return round(float((await session.exec(stmt)).one() or 0), 4)


async def record_usage(
    session: AsyncSession,
    project_id: str,
    feature: str,
    person: str | None,
    *,
    tokens_in: int = 0,
    tokens_out: int = 0,
    cost: float = 0.0,
    member_id: str | None = None,
) -> AiUsage:
    """Meter one assistant turn (the usage page sums these)."""
    row = AiUsage(
        project_id=project_id,
        feature=feature,
        member_id=member_id,
        person=person,
        cost=float(cost or 0),
        tokens_in=int(tokens_in or 0),
        tokens_out=int(tokens_out or 0),
        metered=False,
        created_at=now_iso(),
    )
    session.add(row)
    await session.commit()
    return row


async def first_team(
    session: AsyncSession, project_id: str
) -> tuple[Member, AiTeam] | tuple[None, None]:
    """The project's first AI team: the assistant runs with its account, model and folder when there is one."""
    rows = (
        await session.exec(
            select(Member)
            .where(Member.project_id == project_id, Member.kind == "ai")
            .order_by(col(Member.name))
        )
    ).all()
    for m in rows:
        profile = await session.get(AiTeam, m.id)
        if profile is not None and not profile.paused:
            return m, profile
    return None, None


async def answering_team(
    session: AsyncSession, project_id: str, feature: str = "chat"
) -> tuple[Member, AiTeam] | tuple[None, None]:
    """The AI team that answers a request of `feature`. Docs AI answers with the team chosen in Settings › Docs › AI
    ("AI that answers"); with none chosen, or for any other feature, it is the project's first unpaused team.

    Raises:
        AssistError: `paused` when the team chosen for Docs AI is paused (the choice is not silently replaced).
    """
    if feature == "docs":
        row = await session.get(DocsAiSettings, project_id)
        if row is not None and row.member_id:
            member = await session.get(Member, row.member_id)
            profile = await session.get(AiTeam, row.member_id)
            if (
                member is not None
                and member.project_id == project_id
                and member.kind == "ai"
                and profile is not None
            ):
                if profile.paused:
                    raise AssistError(
                        "paused",
                        f"{member.name} is paused. Resume it in Members, or pick another AI team in Settings › Docs.",
                    )
                return member, profile
    return await first_team(session, project_id)


async def describe(session: AsyncSession, project_id: str) -> dict[str, Any]:
    """Settings › AI for a project, and the dock's state."""
    row = await get(session)
    member, profile = await first_team(session, project_id)
    return {
        "board_ai": {
            "state": "ready",
            "id": member.id if member else None,
            "name": member.name if member else "Board AI",
            "provider": "claude-code",
            "provider_label": "Claude Code",
            "connection": "local",
            "metered": False,
            "status": None,
            "fallback": None,
        },
        "features": [
            {
                "key": k,
                "label": lbl,
                "description": DESCRIPTIONS.get(k, ""),
                "on": features(row).get(k, True),
                "cost_month": await month_spend(session, k),
            }
            for k, lbl in FEATURES.items()
        ],
        "language": row.language or "",
        "tone": row.tone or "neutral",
        "style_guide": row.style_guide or "",
        "style_guide_max": STYLE_GUIDE_MAX,
        "data_scope": [],
        "excluded_docs": [],
        "monthly_cap": row.monthly_cap,
        "per_request_cap": row.per_request_cap,
        "over_cap": row.over_cap or "warn",
        "used_month": await month_spend(session),
        "resets": budget.month_start().isoformat()[:10],
        "health": health_config(row),
        "sent": {},
    }


async def update(session: AsyncSession, data: dict[str, Any]) -> AiAssistSettings:
    """Change the board-wide assistant settings; keys left out stay as they are."""
    import json

    row = await get(session)
    if "features" in data and isinstance(data["features"], dict):
        row.features = json.dumps(
            {
                **features(row),
                **{k: bool(v) for k, v in data["features"].items() if k in FEATURES},
            }
        )
    if "language" in data:
        row.language = (data["language"] or "")[:40]
    if data.get("tone") in TONES:
        row.tone = data["tone"]
    if "style_guide" in data:
        row.style_guide = (data["style_guide"] or "")[:STYLE_GUIDE_MAX]
    for key in ("monthly_cap", "per_request_cap"):
        if key in data:
            setattr(row, key, data[key])
    if data.get("over_cap") in ("pause", "warn"):
        row.over_cap = data["over_cap"]
    if "health" in data and isinstance(data["health"], dict):
        row.health = json.dumps({**health_config(row), **data["health"]})
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row
