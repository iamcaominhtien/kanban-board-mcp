"""Per-project Docs AI settings and who answers (Settings > Docs > AI; design/screens/docs-ai-care.md, F, G).

Docs AI is on until an admin turns it off (`enabled`). The board-wide "Docs AI" feature switch (Settings > AI > Features) stays the master
switch: when it is off, Docs AI is off everywhere.
"""

import json
from typing import Any

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, DocsAiSettings, DocsPage, Member, Project
from services.ai.assist import settings as assist
from services.ai.store import loads, now_iso

from .errors import DocsAiError

READ_SCOPES = ("all", "except_hidden", "picked")
EDIT_MODES = ("direct", "proposal", "draft")
GUIDANCE_LIMIT_RANGE = (1000, 32000)


async def get(session: AsyncSession, project_id: str) -> DocsAiSettings:
    """The project's Docs AI settings, created with defaults (on) on first use."""
    row = await session.get(DocsAiSettings, project_id)
    if row is None:
        row = DocsAiSettings(project_id=project_id)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


def picked(row: DocsAiSettings) -> list[str]:
    """Page ids of "only picked"."""
    return [str(x) for x in loads(row.picked_pages, [])]


async def _project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise DocsAiError("not_found", "Project not found.")
    return project


async def master_on(session: AsyncSession) -> bool:
    """The board-wide Docs AI feature switch."""
    return assist.features(await assist.get(session)).get("docs", True)


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


def _can_answer(profile: AiMember | None) -> bool:
    if profile is None or profile.paused:
        return False
    if profile.connection == "local":
        return profile.provider == "claude-code"
    return profile.connection == "api_key"


async def answering_member(
    session: AsyncSession, project_id: str
) -> tuple[Member, AiMember]:
    """The AI member that answers and checks: the one chosen in Settings, else the Board AI, else any AI member that
    can answer. Raises `no_member` when there is none."""
    row = await get(session, project_id)
    candidates: list[str] = []
    if row.member_id:
        candidates.append(row.member_id)
    info = await assist.board_ai(session, project_id, fallback=True)
    if info["member"] is not None:
        candidates.append(info["member"].id)
    paused = None
    for mid in dict.fromkeys(candidates):
        member = await session.get(Member, mid)
        profile = await session.get(AiMember, mid)
        if member and member.project_id == project_id and _can_answer(profile):
            return member, profile
        if member and profile and profile.paused and paused is None:
            paused = member.name
    if paused:
        raise DocsAiError(
            "paused",
            f"{paused} is paused. Resume it in Members, or pick another AI member.",
        )
    raise DocsAiError(
        "no_member",
        "No AI member can read this space. Pick an AI member in Settings › Docs, or add one in Members.",
    )


async def candidates(session: AsyncSession, project_id: str) -> list[dict[str, Any]]:
    """AI members of the project that could answer, for the picker in Settings."""
    members = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    out = []
    for m in members:
        profile = await session.get(AiMember, m.id)
        if _can_answer(profile):
            out.append(
                {
                    "id": m.id,
                    "name": m.name,
                    "provider": profile.provider,
                    "connection": profile.connection,
                    "model": profile.model,
                }
            )
    return out


async def describe(session: AsyncSession, project_id: str) -> dict[str, Any]:
    """Everything the UI needs: the switches, who answers, and the state the Docs UI should show.

    `state`: `off` | `no_member` | `over_budget` is decided per request; here it is `off` or `ready` or
    `no_member`. `master` is the board-wide switch.
    """
    await _project(session, project_id)
    row = await get(session, project_id)
    master = await master_on(session)
    member = None
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
    except DocsAiError:
        has_member = False
    pages = (
        await session.exec(
            select(DocsPage).where(
                DocsPage.project_id == project_id, col(DocsPage.deleted_at).is_(None)
            )
        )
    ).all()
    guidance = [p for p in pages if p.ai_guidance]
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
        "candidates": await candidates(session, project_id),
        "read_scope": row.read_scope,
        "picked_pages": picked(row),
        "style_page_id": row.style_page_id,
        "edits_mode": row.edits_mode,
        "proposal_days": row.proposal_days,
        "freshness_on": row.freshness_on,
        "guidance_limit": row.guidance_limit,
        "digest_on": row.digest_on,
        "guidance_pages": [{"id": p.id, "title": p.title} for p in guidance],
        "hidden_pages": [{"id": p.id, "title": p.title} for p in pages if p.ai_hidden],
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
            profile = await session.get(AiMember, mid)
            member = await session.get(Member, mid)
            if member is None or member.project_id != project_id or profile is None:
                raise DocsAiError("invalid", "Pick an AI member of this project.")
            if not _can_answer(profile):
                raise DocsAiError(
                    "invalid",
                    f"{member.name} cannot answer here: it needs Claude Code or an API key.",
                )
        row.member_id = mid or None
    if data.get("read_scope") is not None:
        if data["read_scope"] not in READ_SCOPES:
            raise DocsAiError(
                "invalid", "What AI may read: all, except hidden or only picked."
            )
        row.read_scope = data["read_scope"]
    if data.get("picked_pages") is not None:
        ids = [str(x) for x in data["picked_pages"]]
        found = {
            p.id
            for p in (
                await session.exec(
                    select(DocsPage).where(
                        DocsPage.project_id == project_id,
                        col(DocsPage.id).in_(ids or [""]),
                    )
                )
            ).all()
        }
        row.picked_pages = json.dumps([i for i in ids if i in found])
    if "style_page_id" in data:
        pid = data["style_page_id"]
        if pid:
            page = await session.get(DocsPage, pid)
            if page is None or page.project_id != project_id:
                raise DocsAiError(
                    "invalid", "The style guide page is not in this space."
                )
        row.style_page_id = pid or None
    if data.get("edits_mode") is not None:
        if data["edits_mode"] not in EDIT_MODES:
            raise DocsAiError(
                "invalid", "Edits by AI members: made directly, a proposal to review, or a draft only."
            )
        row.edits_mode = data["edits_mode"]
    if data.get("proposal_days") is not None:
        days = int(data["proposal_days"])
        if not 1 <= days <= 60:
            raise DocsAiError("invalid", "Proposals expire after 1 to 60 days.")
        row.proposal_days = days
    if data.get("guidance_limit") is not None:
        lo, hi = GUIDANCE_LIMIT_RANGE
        limit = int(data["guidance_limit"])
        if not lo <= limit <= hi:
            raise DocsAiError("invalid", f"Guidance limit: {lo} to {hi} tokens.")
        row.guidance_limit = limit
    for key in ("freshness_on", "digest_on"):
        if data.get(key) is not None:
            setattr(row, key, bool(data[key]))
    row.updated_by = by
    row.updated_at = now_iso()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def set_page_flags(
    session: AsyncSession,
    page_id: str,
    *,
    hidden: bool | None = None,
    guidance: bool | None = None,
) -> DocsPage:
    """Hide a page from AI and/or mark it as AI guidance. A hidden page cannot be guidance (it is never read)."""
    page = await session.get(DocsPage, page_id)
    if page is None or page.deleted_at:
        raise DocsAiError("not_found", "Page not found.")
    if hidden is not None:
        page.ai_hidden = bool(hidden)
    if guidance is not None:
        page.ai_guidance = bool(guidance)
    if page.ai_hidden and page.ai_guidance:
        if guidance:
            raise DocsAiError(
                "invalid", "A page hidden from AI cannot be used as AI guidance."
            )
        page.ai_guidance = False
    session.add(page)
    await session.commit()
    await session.refresh(page)
    return page


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
