"""Proposals: changes an AI member suggests for a page (docs-ai-care B). The base every feature that suggests an edit
builds on (an AI member's `docs_write`, a freshness check, "Suggest an edit" in a thread).

A proposal never touches the published page. Accepting a change puts its text into the reviewer's draft; only a person
publishes. Statuses: waiting, accepted, partial, rejected, expired. A change is `pending`, `accepted` or `rejected`
and is `stale` when the page no longer contains the text it replaces.
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsAiProposal, DocsPage, Member
from services.ai.store import loads

from . import settings as svc_settings
from .errors import DocsAiError

MAX_CHANGES = 30
MAX_TEXT = 20000


def normalize_changes(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Number the changes and give each the fields the review needs: `{n, title, reason, section, old, new, status,
    stale}`. `old` is the exact text on the page to replace ('' for an addition), `new` the text to put there."""
    out = []
    for i, c in enumerate(changes[:MAX_CHANGES], start=1):
        old, new = str(c.get("old") or ""), str(c.get("new") or "")
        if not old and not new:
            continue
        out.append(
            {
                "n": i,
                "title": str(c.get("title") or f"Change {i}")[:160],
                "reason": str(c.get("reason") or "")[:400],
                "section": c.get("section"),
                "old": old[:MAX_TEXT],
                "new": new[:MAX_TEXT],
                "status": "pending",
                "stale": False,
            }
        )
    return out


async def create_proposal(
    session: AsyncSession,
    *,
    project_id: str,
    page_id: str,
    member_id: str,
    base_version: int,
    changes: list[dict[str, Any]],
    summary: str = "",
    job_id: str | None = None,
    run_id: str | None = None,
    ticket_id: str | None = None,
    approval_id: str | None = None,
    on_behalf_of: str | None = None,
) -> DocsAiProposal:
    """Record a proposal (waiting) for a published page. Raises `invalid` when there is nothing to change."""
    page = await session.get(DocsPage, page_id)
    if page is None or page.project_id != project_id or page.deleted_at:
        raise DocsAiError("not_found", "Page not found.")
    member = await session.get(Member, member_id)
    if member is None or member.kind != "ai":
        raise DocsAiError("invalid", "Only an AI member proposes changes.")
    rows = normalize_changes(changes)
    if not rows:
        raise DocsAiError("invalid", "A proposal needs at least one change.")
    settings = await svc_settings.get(session, project_id)
    expires = datetime.now(UTC) + timedelta(days=settings.proposal_days)
    p = DocsAiProposal(
        project_id=project_id,
        page_id=page_id,
        member_id=member_id,
        base_version=base_version,
        summary=summary[:400],
        changes=json.dumps(rows),
        job_id=job_id,
        run_id=run_id,
        ticket_id=ticket_id,
        approval_id=approval_id,
        on_behalf_of=on_behalf_of,
        expires_at=expires.isoformat(),
    )
    session.add(p)
    await session.commit()
    await session.refresh(p)
    return p


def to_dict(p: DocsAiProposal, member_name: str | None = None) -> dict[str, Any]:
    """The proposal as the API shows it."""
    return {
        "id": p.id,
        "project_id": p.project_id,
        "page_id": p.page_id,
        "member_id": p.member_id,
        "member_name": member_name,
        "run_id": p.run_id,
        "job_id": p.job_id,
        "ticket_id": p.ticket_id,
        "approval_id": p.approval_id,
        "on_behalf_of": p.on_behalf_of,
        "base_version": p.base_version,
        "status": p.status,
        "summary": p.summary,
        "changes": loads(p.changes, []),
        "created_at": p.created_at,
        "expires_at": p.expires_at,
        "decided_by": p.decided_by,
        "decided_at": p.decided_at,
        "decision_note": p.decision_note,
    }


async def waiting_page_ids(session: AsyncSession, project_id: str) -> list[str]:
    """Pages with a proposal waiting (the purple dot in the tree)."""
    rows = (
        await session.exec(
            select(DocsAiProposal.page_id).where(
                DocsAiProposal.project_id == project_id, DocsAiProposal.status == "waiting"
            )
        )
    ).all()
    return sorted(set(rows))


async def for_page(
    session: AsyncSession, page_id: str, *, statuses: tuple[str, ...] = ("waiting",)
) -> list[DocsAiProposal]:
    """Proposals of a page, newest first."""
    return list(
        (
            await session.exec(
                select(DocsAiProposal)
                .where(DocsAiProposal.page_id == page_id, col(DocsAiProposal.status).in_(statuses))
                .order_by(col(DocsAiProposal.created_at).desc())
            )
        ).all()
    )


