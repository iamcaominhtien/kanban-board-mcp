"""One AI member in several projects ("Projects it can work in", design/screens/ai-members.md step 3 and
design/screens/ai-safety-cost.md A1 scope). A board member belongs to one project, so the AI member gets a linked
copy in each other project: same name, look, connection, key, persona, configuration, permissions and limits, kept
in step from whichever copy is edited. Each copy keeps its own working folder (a project's repository) and its own
runs. Budgets count the spend of the whole group.
"""

import uuid

from sqlmodel import col, or_, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, Member, Project

from .store import active_runs, now_iso

# Shared by every copy; working_dir, tokens, usage stamps and removal state stay per project
SHARED = (
    "provider",
    "connection",
    "description",
    "glyph",
    "cli_path",
    "base_url",
    "model",
    "key_enc",
    "key_last4",
    "key_rotated_at",
    "persona",
    "max_parallel",
    "daily_budget",
    "monthly_cap",
    "max_runs_per_day",
    "template",
    "ceiling",
    "permissions",
    "scope",
    "config",
    "paused",
    "paused_at",
    "paused_reason",
    "safe_mode",
    "allow_external",
    "tokens_per_day",
    "cap_per_run",
    "warn_at",
    "cli_version",
    "account",
)


class ProjectsError(ValueError):
    """The projects of an AI member cannot change; the message says why."""


def primary_id(profile: AiMember) -> str:
    """The id every copy links to."""
    return getattr(profile, "linked_to", None) or profile.id


async def group(session: AsyncSession, member_id: str) -> list[AiMember]:
    """The AI member and its live copies, the original first."""
    profile = await session.get(AiMember, member_id)
    if profile is None:
        return []
    root = primary_id(profile)
    rows = (
        await session.exec(
            select(AiMember).where(or_(AiMember.id == root, AiMember.linked_to == root))
        )
    ).all()
    live = []
    for r in rows:
        m = await session.get(Member, r.id)
        if m is not None and m.kind == "ai":
            live.append(r)
    return sorted(live, key=lambda r: r.id != root)


async def group_ids(session: AsyncSession, member_id: str) -> list[str]:
    """Ids of the AI member and its copies (for budgets counted across projects)."""
    ids = [r.id for r in await group(session, member_id)]
    return ids or [member_id]


async def projects_of(session: AsyncSession, member_id: str) -> list[dict]:
    """Every project of the board with whether this AI member works there (and as which member id)."""
    mine = {r.project_id: r for r in await group(session, member_id)}
    root = next(iter(mine.values()), None)
    projects = (await session.exec(select(Project).order_by(col(Project.name)))).all()
    return [
        {
            "project_id": p.id,
            "name": p.name,
            "on": p.id in mine,
            "member_id": mine[p.id].id if p.id in mine else None,
            "original": bool(
                root and p.id in mine and mine[p.id].id == primary_id(root)
            ),
        }
        for p in projects
    ]


async def sync(session: AsyncSession, member_id: str) -> int:
    """Copy the shared settings of `member_id` to the rest of its group; returns how many copies changed."""
    from . import members as svc_members

    source = await session.get(AiMember, member_id)
    if source is None:
        return 0
    member = await session.get(Member, member_id)
    n = 0
    for other in await group(session, member_id):
        if other.id == member_id:
            continue
        changed = False
        for field in SHARED:
            if hasattr(source, field) and getattr(other, field) != getattr(
                source, field
            ):
                setattr(other, field, getattr(source, field))
                changed = True
        om = await session.get(Member, other.id)
        if (
            member is not None
            and om is not None
            and (om.name != member.name or om.color != member.color)
        ):
            name_ok = (
                await svc_members.check_name(
                    session, om.project_id, member.name, exclude_id=om.id
                )
            )["ok"]
            if name_ok:
                om.name = member.name
            om.color = member.color
            session.add(om)
            changed = True
        if changed:
            other.updated_at = now_iso()
            session.add(other)
            n += 1
    if n:
        await session.commit()
    return n


async def set_projects(
    session: AsyncSession, member_id: str, project_ids: list[str], *, by: str
) -> list[dict]:
    """Make the AI member work in exactly these projects: add a linked copy where it is missing, remove the copies
    of projects left out (after their run). Its original project always stays."""
    from . import members as svc_members

    rows = await group(session, member_id)
    if not rows:
        raise ProjectsError("AI member not found.")
    root = rows[0]
    wanted = set(project_ids) | {root.project_id}
    have = {r.project_id: r for r in rows}
    root_member = await session.get(Member, root.id)
    for pid in wanted - set(have):
        if await session.get(Project, pid) is None:
            raise ProjectsError("Project not found.")
        verdict = await svc_members.check_name(session, pid, root_member.name)
        if not verdict["ok"]:
            raise ProjectsError(verdict["message"])
    for pid in sorted(wanted - set(have)):
        copy_member = Member(
            id=str(uuid.uuid4()),
            project_id=pid,
            name=root_member.name,
            color=root_member.color,
            role="member",
            kind="ai",
        )
        session.add(copy_member)
        await session.flush()
        fields = {f: getattr(root, f) for f in SHARED if hasattr(root, f)}
        session.add(
            AiMember(
                id=copy_member.id,
                project_id=pid,
                linked_to=root.id,
                working_dir=root.working_dir,
                health=root.health,
                created_by=by,
                **fields,
            )
        )
    await session.commit()
    for pid, row in have.items():
        if pid in wanted or row.id == root.id:
            continue
        if await active_runs(session, member_id=row.id):
            row.remove_after_run = True
            session.add(row)
            await session.commit()
        else:
            await svc_members.finalize_removal(session, row.id, by=by)
    return await projects_of(session, member_id)
