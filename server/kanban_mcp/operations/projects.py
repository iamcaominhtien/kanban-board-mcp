"""Project operations."""

import services.projects as svc_projects
from models import ProjectCreate, ProjectRead, ProjectUpdate
from pydantic import Field
from typing import Annotated
from .. import common
from ..common import ProjectId, notify_on_success


async def list_projects() -> list[dict]:
    """List all projects (boards). Start here: most other tools need a project's `id` (a UUID).
    Each project has a `prefix` that starts its ticket IDs (prefix 'IAM' -> tickets 'IAM-1', 'IAM-2'),
    and may have a linked git `repo_path` (needed by the branch tools)."""
    async with common.async_session() as session:
        projects = await svc_projects.list_projects(session)
        return [ProjectRead.model_validate(p).model_dump() for p in projects]


@notify_on_success
async def create_project(
    name: Annotated[str, Field(description="Display name, e.g. 'My App'.")],
    prefix: Annotated[
        str,
        Field(
            description="Ticket-ID prefix: uppercase letters/digits, at most 6 chars, unique (e.g. 'MYAPP'). Lower-case input is upper-cased."
        ),
    ],
    color: Annotated[
        str, Field(description="Hex accent color, e.g. '#6366f1'.")
    ] = "#6366f1",
) -> dict:
    """Create a project (board). A member named 'Admin' is created with it. Returns the project with its `id` (UUID)."""
    async with common.async_session() as session:
        data = ProjectCreate(name=name, prefix=prefix.upper(), color=color)
        project = await svc_projects.create_project(session, data)
        return ProjectRead.model_validate(project).model_dump()


@notify_on_success
async def update_project(
    project_id: ProjectId,
    name: Annotated[str | None, Field(description="New display name.")] = None,
    color: Annotated[str | None, Field(description="New hex accent color.")] = None,
    repo_path: Annotated[
        str | None,
        Field(
            description="Absolute path of a local git repository to link to this project (required before add_branch can create real git branches). Empty string unlinks it."
        ),
    ] = None,
    worktree_template: Annotated[
        str | None,
        Field(
            description="Default path template for git worktrees, e.g. '../worktrees/{project}/{ticket_id}-{branch}'."
        ),
    ] = None,
    worktree_by_default: Annotated[
        bool | None, Field(description="Create a worktree by default for new branches.")
    ] = None,
) -> dict:
    """Change a project's name, color or git settings. Only the fields you pass change. Returns the project."""
    fields = {
        "name": name,
        "color": color,
        "repo_path": repo_path,
        "worktree_template": worktree_template,
        "worktree_by_default": worktree_by_default,
    }
    data = ProjectUpdate(**{k: v for k, v in fields.items() if v is not None})
    async with common.async_session() as session:
        project = await svc_projects.update_project(session, project_id, data)
        if project is None:
            raise ValueError(
                f"Project '{project_id}' not found. Use get_projects to see project ids."
            )
        return ProjectRead.model_validate(project).model_dump()
