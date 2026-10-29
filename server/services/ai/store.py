"""Small loaders shared by the AI services."""

import json
from datetime import UTC, datetime

from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, AiProjectSettings, AiRun, Member


def now_iso() -> str:
    """Current UTC time, ISO formatted."""
    return datetime.now(UTC).isoformat()


def parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO time, or None."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def loads(value, default):
    """json.loads that falls back to `default`."""
    if value is None or value == "":
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


async def get_profile(
    session: AsyncSession, member_id: str
) -> tuple[Member | None, AiMember | None]:
    """The Member row and its AI profile (either may be None)."""
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    return member, profile


async def get_settings(session: AsyncSession, project_id: str) -> AiProjectSettings:
    """The project's AI settings, created with defaults on first use."""
    settings = await session.get(AiProjectSettings, project_id)
    if settings is None:
        settings = AiProjectSettings(project_id=project_id)
        session.add(settings)
        try:
            await session.commit()
        except IntegrityError:
            # Two first requests raced to create it: use the row the other one wrote
            await session.rollback()
            return await session.get(AiProjectSettings, project_id)
        await session.refresh(settings)
    return settings


async def ai_names(session: AsyncSession, project_id: str) -> set[str]:
    """Names of the project's AI members (current and removed): text they wrote is data only."""
    rows = await session.exec(
        select(Member).where(
            Member.project_id == project_id, Member.kind.in_(["ai", "ai_removed"])
        )
    )
    return {m.name for m in rows.all()}


async def active_runs(
    session: AsyncSession, *, member_id: str | None = None, ticket_id: str | None = None
) -> list[AiRun]:
    """Runs that are queued, starting, running or waiting for input."""
    stmt = select(AiRun).where(
        AiRun.state.in_(["queued", "starting", "running", "needs_input"])
    )
    if member_id:
        stmt = stmt.where(AiRun.member_id == member_id)
    if ticket_id:
        stmt = stmt.where(AiRun.ticket_id == ticket_id)
    return list((await session.exec(stmt)).all())
