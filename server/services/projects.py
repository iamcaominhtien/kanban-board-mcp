import uuid

from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Project, ProjectCreate, ProjectUpdate, Ticket


async def list_projects(session: AsyncSession) -> list[Project]:
    result = await session.exec(select(Project))
    return list(result.all())


async def get_project(session: AsyncSession, project_id: str) -> Project | None:
    return await session.get(Project, project_id)


async def create_project(session: AsyncSession, data: ProjectCreate) -> Project:
    prefix = data.prefix.strip()
    if not prefix.isupper() or len(prefix) > 6:
        raise ValueError("prefix must be uppercase and at most 6 characters")

    project = Project(
        id=str(uuid.uuid4()),
        name=data.name,
        prefix=prefix,
        color=data.color,
        ticket_counter=0,
    )
    try:
        session.add(project)
        await session.commit()
        await session.refresh(project)
    except IntegrityError as exc:
        await session.rollback()
        raise ValueError("A project with this prefix already exists") from exc
    return project


async def update_project(
    session: AsyncSession, project_id: str, data: ProjectUpdate
) -> Project | None:
    project = await session.get(Project, project_id)
    if project is None:
        return None

    update_data = data.model_dump(exclude_none=True)
    for field, value in update_data.items():
        setattr(project, field, value)

    session.add(project)
    await session.commit()
    await session.refresh(project)
    return project


async def delete_project(session: AsyncSession, project_id: str) -> bool:
    project = await session.get(Project, project_id)
    if project is None:
        return False

    ticket_result = await session.exec(
        select(Ticket).where(Ticket.project_id == project_id).limit(1)
    )
    if ticket_result.first() is not None:
        raise ValueError("Project has tickets — cannot delete")

    await session.delete(project)
    await session.commit()
    return True
