import uuid

from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services.git_repo import normalize_repo_path
from models import Member, Project, ProjectCreate, ProjectUpdate, Ticket
from services.members import create_member as _create_member


async def list_projects(session: AsyncSession) -> list[Project]:
    """Return all projects."""
    result = await session.exec(select(Project))
    return list(result.all())


async def get_project(session: AsyncSession, project_id: str) -> Project | None:
    """Return a project by id, or None."""
    return await session.get(Project, project_id)


async def create_project(session: AsyncSession, data: ProjectCreate) -> Project:
    """Create a project; the prefix must be uppercase, at most 6 characters."""
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
        await session.flush()
        await _create_member(session, project.id, "Admin", "#3B82F6", commit=False)
        await session.commit()
        await session.refresh(project)
    except IntegrityError as exc:
        await session.rollback()
        raise ValueError("A project with this prefix already exists") from exc
    return project


async def update_project(
    session: AsyncSession, project_id: str, data: ProjectUpdate
) -> Project | None:
    """Apply a partial update; return None if the project does not exist."""
    project = await session.get(Project, project_id)
    if project is None:
        return None

    update_data = data.model_dump(exclude_none=True)
    if "repo_path" in update_data:
        raw_path = update_data["repo_path"].strip()
        # Empty string unlinks the repository; anything else must be a real git repo.
        update_data["repo_path"] = normalize_repo_path(raw_path) if raw_path else None
    if "worktree_template" in update_data:
        raw_tmpl = (
            update_data["worktree_template"].strip()
            if update_data["worktree_template"]
            else ""
        )
        update_data["worktree_template"] = raw_tmpl if raw_tmpl else None
    for field, value in update_data.items():
        setattr(project, field, value)

    session.add(project)
    await session.commit()
    await session.refresh(project)
    return project


async def delete_project(session: AsyncSession, project_id: str) -> bool:
    """Delete a project; return False if it does not exist."""
    project = await session.get(Project, project_id)
    if project is None:
        return False

    ticket_result = await session.exec(
        select(Ticket).where(Ticket.project_id == project_id).limit(1)
    )
    if ticket_result.first() is not None:
        raise ValueError("Project has tickets — cannot delete")

    member_result = await session.exec(
        select(Member).where(Member.project_id == project_id)
    )
    for m in member_result.all():
        await session.delete(m)
    await session.delete(project)
    await session.commit()
    return True
