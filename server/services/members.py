import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Member, Ticket

_DEFAULT_COLORS = [
    "#3B82F6",
    "#10B981",
    "#F59E0B",
    "#EF4444",
    "#8B5CF6",
    "#EC4899",
    "#06B6D4",
    "#84CC16",
]


async def list_members(session: AsyncSession, project_id: str) -> list[Member]:
    result = await session.exec(select(Member).where(Member.project_id == project_id))
    return list(result.all())


async def get_member(session: AsyncSession, member_id: str) -> Member | None:
    return await session.get(Member, member_id)


async def create_member(
    session: AsyncSession,
    project_id: str,
    name: str,
    color: str | None = None,
) -> Member:
    if not color:
        existing = await list_members(session, project_id)
        color = _DEFAULT_COLORS[len(existing) % len(_DEFAULT_COLORS)]
    member = Member(
        id=str(uuid.uuid4()),
        project_id=project_id,
        name=name,
        color=color,
    )
    session.add(member)
    await session.commit()
    await session.refresh(member)
    return member


async def remove_member(session: AsyncSession, project_id: str, member_id: str) -> bool:
    member = await session.get(Member, member_id)
    if member is None or member.project_id != project_id:
        return False

    creator_check = await session.exec(
        select(Ticket)
        .where(Ticket.project_id == project_id)
        .where(Ticket.created_by == member_id)
        .limit(1)
    )
    if creator_check.first() is not None:
        raise ValueError("Cannot remove member who created tickets")

    assignee_check = await session.exec(
        select(Ticket)
        .where(Ticket.project_id == project_id)
        .where(Ticket.assignee == member_id)
        .limit(1)
    )
    if assignee_check.first() is not None:
        # Unassign all tickets assigned to this member
        tickets_result = await session.exec(
            select(Ticket)
            .where(Ticket.project_id == project_id)
            .where(Ticket.assignee == member_id)
        )
        for ticket in tickets_result.all():
            ticket.assignee = None
            session.add(ticket)

    await session.delete(member)
    await session.commit()
    return True
