"""Project tools: reading projects (with members) and managing projects and members."""

from .routing import Op, dispatch, params_of
from models import MemberRead
from pydantic import Field
from typing import Annotated, Literal
from .. import operations as ops
import services.members as svc_members
from .. import common


async def get_projects(
    project_id: Annotated[
        str | None,
        Field(
            description="Omit to list every project. A project UUID returns that project with its members."
        ),
    ] = None,
) -> list[dict] | dict:
    """Start here: list the projects (boards). Most other tools need a project's `id` (a UUID). Each project has a
    `prefix` that starts its ticket IDs (prefix 'IAM' -> 'IAM-1', 'IAM-2') and may have a linked git `repo_path`
    (needed by real git branches). With `project_id` you get that project plus `members` [{id, name, color}]; use a
    member `id` as a ticket `assignee`."""
    projects = await ops.list_projects()
    if project_id is None:
        return projects
    for project in projects:
        if project["id"] == project_id:
            async with common.async_session() as session:
                members = await svc_members.list_members(session, project_id)
            return project | {
                "members": [MemberRead.model_validate(m).model_dump() for m in members]
            }
    shown = ", ".join(f"{p['prefix']}={p['id']}" for p in projects[:20]) or "none"
    raise ValueError(
        f"Project '{project_id}' not found. Pass a project UUID (not the prefix). Existing: {shown}."
    )


ProjectAction = Literal["create", "update", "add_member", "remove_member"]

PROJECT_OPS = {
    "create": Op(ops.create_project, ("name", "prefix"), ("color",)),
    "update": Op(
        ops.update_project,
        ("project_id",),
        ("name", "color", "repo_path", "worktree_template", "worktree_by_default"),
    ),
    "add_member": Op(ops.add_member, ("project_id", "name"), ("color",)),
    "remove_member": Op(ops.remove_member, ("project_id", "member_id")),
}


async def manage_project(
    action: Annotated[
        ProjectAction, Field(description="What to do; see the tool description.")
    ],
    project_id: Annotated[
        str | None,
        Field(
            description="Project UUID from get_projects (update, add_member, remove_member)."
        ),
    ] = None,
    name: Annotated[
        str | None,
        Field(description="Project name (create, update) or member name (add_member)."),
    ] = None,
    prefix: Annotated[
        str | None,
        Field(
            description="create: ticket-ID prefix, uppercase letters/digits, at most 6 chars, unique (e.g. 'MYAPP'); lower case is upper-cased."
        ),
    ] = None,
    color: Annotated[
        str | None,
        Field(
            description="Hex color such as '#6366f1': the project accent, or a member's avatar (auto-picked when omitted)."
        ),
    ] = None,
    repo_path: Annotated[
        str | None,
        Field(
            description="update: absolute path of a local git repository to link (needed before ticket_branches can create real git branches). '' unlinks it."
        ),
    ] = None,
    worktree_template: Annotated[
        str | None,
        Field(
            description="update: default path template for git worktrees, e.g. '../worktrees/{project}/{ticket_id}-{branch}'."
        ),
    ] = None,
    worktree_by_default: Annotated[
        bool | None,
        Field(description="update: create a worktree by default for new branches."),
    ] = None,
    member_id: Annotated[
        str | None,
        Field(
            description="remove_member: member id (UUID) from get_projects(project_id)."
        ),
    ] = None,
) -> dict:
    """Create or change a project and its members. `action`:
    - create: name, prefix [, color]. A member 'Admin' is created with it. Returns the project (`id` is a UUID).
    - update: project_id [, name, color, repo_path, worktree_template, worktree_by_default]. Only the fields you pass change. Returns the project.
    - add_member: project_id, name [, color]. Returns the member; its `id` is what tickets use as `assignee`.
    - remove_member: project_id, member_id. Refused (with the reason) while the member has open assigned tickets (reassign them first) or created tickets; closed tickets are unassigned. Returns {"ok": true}."""
    return await dispatch("manage_project", PROJECT_OPS, action, params_of(locals()))
