"""Per-project Docs AI settings and who answers (Settings > Docs > AI; design/screens/docs-ai-care.md, F, G).

Docs AI is off for a new project until an admin turns it on (`enabled`, AI-1): `services.projects.create_project`
writes the row. A project made before that change keeps its stored value; one that never stored a row was "on" and
is given `enabled=True` here on first use, so nothing changes for it. The board-wide "Docs AI" feature switch (Settings > AI > Features) stays the master
switch: when it is off, Docs AI is off everywhere.
"""

from typing import Any

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import AiTeam, DocsAiSettings, DocsPage, Member, Project
from services.ai.store import now_iso
from services.assistant import settings as assist_settings
from services.assistant.errors import AssistError

from .errors import DocsAiError


async def get(session: AsyncSession, project_id: str) -> DocsAiSettings:
    """The project's Docs AI settings. A project without a row predates AI-1 (new projects get one when they are
    made, switched off), so its row is created on first use with Docs AI on, as it always was."""
    row = await session.get(DocsAiSettings, project_id)
    if row is None:
        # two runs that start together both get here: the second insert does nothing
        await database.insert_missing(
            session, DocsAiSettings, project_id=project_id, enabled=True
        )
        await session.commit()
        row = await session.get(DocsAiSettings, project_id)
    return row


async def _project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise DocsAiError("not_found", "Project not found.")
    return project


async def master_on(session: AsyncSession) -> bool:
    """The board-wide Docs AI feature switch."""
    return True


async def require_enabled(session: AsyncSession, project_id: str) -> DocsAiSettings:
    """Docs AI is on for the project, or `docs_ai_off` (nothing in Docs shows AI then)."""
    await _project(session, project_id)
    row = await get(session, project_id)
    if not row.enabled or not await master_on(session):
        raise DocsAiError(
            "docs_ai_off",
            "Docs AI is off for this project. An admin can turn it on in Settings › Docs.",
        )
    return row


def _can_answer(profile: AiTeam | None) -> bool:
    if profile is None or profile.paused:
        return False
    if profile.connection == "local":
        return profile.provider == "claude-code"
    return profile.connection == "api_key"


async def answering_member(
    session: AsyncSession, project_id: str
) -> tuple[Member, AiTeam]:
    """The AI team that answers and checks: the one chosen in Settings (`member_id`), else the project's first
    unpaused team, the same one the assistant engine runs the call with. Raises `paused` when the chosen team is
    paused and `no_member` when the project has none."""
    try:
        member, profile = await assist_settings.answering_team(
            session, project_id, "docs"
        )
    except AssistError as exc:
        raise DocsAiError("paused", str(exc)) from exc
    if member is None or profile is None:
        raise DocsAiError(
            "no_member",
            "No AI team can read this space. Pick one in Settings › Docs, or add one in Members.",
        )
    return member, profile


async def candidates(session: AsyncSession, project_id: str) -> list[dict[str, Any]]:
    """AI teams of the project that could answer, for the picker in Settings. The team chosen there stays in the
    list when it is paused (marked `paused`), so the picker shows which one it is."""
    chosen = (await get(session, project_id)).member_id
    members = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    out = []
    for m in members:
        profile = await session.get(AiTeam, m.id)
        paused_choice = profile is not None and profile.paused and m.id == chosen
        if _can_answer(profile) or paused_choice:
            out.append(
                {
                    "id": m.id,
                    "name": m.name,
                    "provider": profile.provider,
                    "connection": profile.connection,
                    "model": profile.model,
                    "paused": bool(profile.paused),
                }
            )
    return out


async def describe(session: AsyncSession, project_id: str) -> dict[str, Any]:
    """Everything the UI needs: the switches, who answers, and the state the Docs UI should show.

    `state` is `off`, `ready` or `no_member`. `master` is the board-wide switch.
    """
    await _project(session, project_id)
    row = await get(session, project_id)
    master = await master_on(session)
    member = None
    problem = None
    try:
        m, profile = await answering_member(session, project_id)
        member = {
            "id": m.id,
            "name": m.name,
            "provider": profile.provider,
            "model": profile.model,
            "metered": profile.connection == "api_key",
        }
        has_member = True
    except DocsAiError as exc:
        has_member = False
        problem = {"code": exc.code, "message": str(exc)}
    state = (
        "off"
        if not (row.enabled and master)
        else "ready"
        if has_member
        else "no_member"
    )
    return {
        "enabled": row.enabled,
        "master": master,
        "state": state,
        "member_id": row.member_id,
        "member": member,
        # why nobody can answer (`paused`: the team chosen in Settings is paused; `no_member`), or None
        "problem": problem,
        "candidates": await candidates(session, project_id),
        "style_page_id": row.style_page_id,
        "freshness_on": row.freshness_on,
        "digest_on": row.digest_on,
    }


async def update(
    session: AsyncSession, project_id: str, data: dict[str, Any], by: str
) -> DocsAiSettings:
    """Change the settings (validated)."""
    await _project(session, project_id)
    row = await get(session, project_id)
    if data.get("enabled") is not None:
        row.enabled = bool(data["enabled"])
    if "member_id" in data:
        mid = data["member_id"]
        if mid:
            profile = await session.get(AiTeam, mid)
            member = await session.get(Member, mid)
            if member is None or member.project_id != project_id or profile is None:
                raise DocsAiError("invalid", "Pick an AI team of this project.")
            if not _can_answer(profile):
                raise DocsAiError(
                    "invalid",
                    f"{member.name} cannot answer here: it needs Claude Code or an API key.",
                )
        row.member_id = mid or None
    if "style_page_id" in data:
        pid = data["style_page_id"]
        if pid:
            page = await session.get(DocsPage, pid)
            if page is None or page.project_id != project_id:
                raise DocsAiError(
                    "invalid", "The style guide page is not in this space."
                )
        row.style_page_id = pid or None
    for key in ("freshness_on", "digest_on"):
        if data.get(key) is not None:
            setattr(row, key, bool(data[key]))
    row.updated_by = by
    row.updated_at = now_iso()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def count_pages(session: AsyncSession, project_id: str) -> int:
    """Live pages of the project."""
    return int(
        (
            await session.exec(
                select(func.count()).where(
                    DocsPage.project_id == project_id,
                    col(DocsPage.deleted_at).is_(None),
                )
            )
        ).one()
        or 0
    )


# kept for callers that only need to know whether an AI member can answer through `llm.complete`
can_answer = _can_answer
