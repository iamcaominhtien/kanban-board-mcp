import uuid

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from services.git_repo import normalize_repo_path
from models import Project, ProjectCreate, ProjectUpdate
from services.members import create_member as _create_member


async def list_projects(session: AsyncSession) -> list[Project]:
    """Return all projects."""
    result = await session.exec(select(Project))
    return list(result.all())


async def get_project(session: AsyncSession, project_id: str) -> Project | None:
    """Return a project by id, or None."""
    return await session.get(Project, project_id)


async def create_project(session: AsyncSession, data: ProjectCreate) -> Project:
    """Create a project.

    Args:
        data: Name, prefix and color; the prefix must be uppercase, at most 6 characters.

    Returns:
        The created project.

    Raises:
        ValueError: If the prefix is invalid or already used.
    """
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
    """Apply a partial update.

    Args:
        project_id: Project to update.
        data: Fields to change; an empty `repo_path` unlinks the repository.

    Returns:
        The updated project, or None if it does not exist.
    """
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


def _owned_by(table, project_id: str, seen: tuple[str, ...] = ()):
    """SQL condition selecting the rows of `table` that belong to the project, or None when the table is not tied to a
    project (a global setting). A table with a `project_id` column is selected by it; a child table (a chat's messages,
    a page's versions) through its foreign key to a table that is."""
    if table.name == "project":
        return None
    if "project_id" in table.columns:
        return table.c.project_id == project_id
    for fk in table.foreign_keys:
        parent = fk.column.table
        if parent.name == "project" or parent.name in seen:
            continue
        inner = _owned_by(parent, project_id, (*seen, table.name))
        if inner is not None:
            return fk.parent.in_(select(fk.column).where(inner))
    return None


async def delete_project(session: AsyncSession, project_id: str) -> bool:
    """Delete a project with everything in it: tickets, members, docs, AI members and runs, chats, ideas, sketches...

    The database does not enforce foreign keys, so the rows are removed here: every table tied to the project, child
    tables first, then the project. Files that tickets uploaded stay on disk.

    Args:
        project_id: Project to delete.

    Returns:
        True if deleted, False if it does not exist.
    """
    project = await session.get(Project, project_id)
    if project is None:
        return False

    for table in reversed(SQLModel.metadata.sorted_tables):
        condition = _owned_by(table, project_id)
        if condition is not None:
            await session.execute(table.delete().where(condition))
    # the one child table without a foreign key to its page
    await session.execute(
        text(
            "DELETE FROM docs_ai_ignore WHERE page_id NOT IN (SELECT id FROM docs_page)"
        )
    )
    await session.execute(
        SQLModel.metadata.tables["project"]
        .delete()
        .where(SQLModel.metadata.tables["project"].c.id == project_id)
    )
    await session.commit()
    return True
