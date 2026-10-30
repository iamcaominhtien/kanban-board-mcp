"""Proposals: changes an AI member suggests for a page (docs-ai-care B). The base every feature that suggests an edit
builds on (an AI member's `docs_write`, a freshness check, "Suggest an edit" in a thread).

A proposal never touches the published page. Accepting a change puts its text into the reviewer's draft; only a person
publishes. Statuses: waiting, accepted, partial, rejected, expired. A change is `pending`, `accepted` or `rejected`
and is `stale` when the page no longer contains the text it replaces ("Needs a new look": it cannot be accepted).

An AI member never decides a proposal (its own or another's): only people who can edit the page do, on the page or
in Approvals. Every state change is written to the AI audit log.
"""

import asyncio
import difflib
import json
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from models import (
    AiApproval,
    AiMember,
    DocsAiProposal,
    DocsDraft,
    DocsPage,
    DocsVersion,
    Member,
    Project,
)
from services import activity, docs_access
from services.ai.store import loads, now_iso, parse_iso

from . import settings as svc_settings
from .errors import DocsAiError

log = logging.getLogger(__name__)

MAX_CHANGES = 30
MAX_TEXT = 20000
DECIDED = ("accepted", "partial", "rejected", "expired")
# A tool call of an AI run that this module turns into a proposal (or a private draft) when Docs AI is on
PROPOSAL_ACTIONS = ("update", "restore_version")
# Never done by an AI member while Docs AI is on: a person deletes pages and resolves threads
REFUSED_ACTIONS = {
    "delete": "With Docs AI on, AI members do not delete pages. Ask a person to delete it.",
    "resolve": "AI members never resolve a thread; a person resolves it.",
}
APPROVAL_TOOL = "docs_proposal"
EXPIRY_EVERY_S = 600


# ---------------------------------------------------------------------------
# Text: blocks, diff and applying a change
# ---------------------------------------------------------------------------


def blocks_of(markdown: str) -> list[str]:
    """Split Markdown into blocks separated by blank lines (a fenced code block stays one block)."""
    out: list[str] = []
    cur: list[str] = []
    fence = False
    for line in (markdown or "").replace("\r\n", "\n").split("\n"):
        if line.strip().startswith("```"):
            fence = not fence
        if not fence and not line.strip():
            if cur:
                out.append("\n".join(cur).strip("\n"))
                cur = []
            continue
        cur.append(line)
    if cur:
        out.append("\n".join(cur).strip("\n"))
    return [b for b in out if b.strip()]


def _pattern(old: str) -> re.Pattern[str]:
    """`old` as a pattern where the blank lines between blocks may be any number of blank lines."""
    parts = [re.escape(b) for b in re.split(r"\n[ \t]*\n", old)]
    return re.compile(r"\n[ \t]*\n(?:[ \t]*\n)*".join(parts))


def occurrences(text: str, old: str) -> int:
    """How often the text a change replaces is in `text`."""
    if not old:
        return 1
    return len(_pattern(old).findall(text or ""))


def apply_change(text: str, change: dict[str, Any]) -> str | None:
    """`text` with the change applied (the first occurrence of `old` replaced by `new`), or None when `old` is not in
    it any more (the change is stale). An addition with no `old` is appended."""
    old, new = change.get("old") or "", change.get("new") or ""
    if not old:
        return (text.rstrip() + "\n\n" + new).strip() + "\n" if text.strip() else new
    m = _pattern(old).search(text or "")
    if m is None:
        return None
    out = text[: m.start()] + new + text[m.end() :]
    return re.sub(r"\n{3,}", "\n\n", out)


def _heading(block: str) -> str | None:
    first = block.split("\n", 1)[0].strip()
    if first.startswith("#"):
        return first.lstrip("#").strip() or None
    return None


def _section_at(blocks: list[str], i: int) -> str | None:
    for b in reversed(blocks[: i + 1]):
        h = _heading(b)
        if h:
            return h
    return None


def _short(text: str, n: int = 48) -> str:
    line = next((x for x in text.split("\n") if x.strip()), "")
    line = re.sub(r"^[#>*\-\s\d.|]+|[*_`|]", "", line).strip()
    return line if len(line) <= n else line[: n - 1].rstrip() + "…"


def text_changes(
    old_md: str, new_md: str, *, reason: str = "", current: str | None = None
) -> list[dict[str, Any]]:
    """Block-level changes that turn `old_md` (the text the AI read) into `new_md`: `[{title, reason, section, old,
    new}]`. `old` is made long enough to be found once in `current` (the page now; default `old_md`)."""
    a, b = blocks_of(old_md), blocks_of(new_md)
    target = old_md if current is None else current
    out: list[dict[str, Any]] = []
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    ops: list[tuple[str, int, int, int, int]] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "replace" and i2 - i1 == j2 - j1 > 1:
            # block for block: one change per block, so each can be accepted on its own
            ops += [
                ("replace", i1 + k, i1 + k + 1, j1 + k, j1 + k + 1)
                for k in range(i2 - i1)
            ]
        else:
            ops.append((tag, i1, i2, j1, j2))
    for tag, i1, i2, j1, j2 in ops:
        if tag == "equal":
            continue
        added = "\n\n".join(b[j1:j2])
        removed = "\n\n".join(a[i1:i2])
        if tag == "replace":
            old, new, title = removed, added, f"Rewrite “{_short(removed)}”"
        elif tag == "delete":
            old, new, title = removed, "", f"Remove “{_short(removed)}”"
        elif i1 > 0:
            old, new, title = (
                a[i1 - 1],
                a[i1 - 1] + "\n\n" + added,
                f"Add “{_short(added)}”",
            )
        elif a:
            old, new, title = a[0], added + "\n\n" + a[0], f"Add “{_short(added)}”"
        else:
            old, new, title = "", added, f"Add “{_short(added)}”"
        # make `old` unique on the page by taking in the blocks before it
        k = i1 - (1 if tag == "insert" and i1 > 0 else 0)
        while old and occurrences(target, old) > 1 and k > 0:
            k -= 1
            old, new = a[k] + "\n\n" + old, a[k] + "\n\n" + new
        out.append(
            {
                "title": title,
                "reason": reason,
                "section": _section_at(a, max(i1 - 1, 0) if tag == "insert" else i1),
                "old": old,
                "new": new,
            }
        )
    return out


def normalize_changes(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Number the changes and give each the fields the review needs: `{n, kind, title, reason, section, old, new,
    status, stale}`. `old` is the exact text on the page to replace ('' for an addition), `new` the text to put
    there. `kind` is `text` or `title` (a new page title)."""
    out = []
    for c in changes[:MAX_CHANGES]:
        old, new = str(c.get("old") or ""), str(c.get("new") or "")
        if not old and not new or old == new:
            continue
        i = len(out) + 1
        out.append(
            {
                "n": i,
                "kind": "title" if c.get("kind") == "title" else "text",
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


def _applies(text: str, title: str, c: dict[str, Any]) -> bool:
    if c.get("kind") == "title":
        return title == c["old"]
    return apply_change(text, c) is not None


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


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
    from services.ai import audit

    await audit.record(
        project_id,
        "edit_docs",
        "proposed",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=on_behalf_of,
        run_id=run_id,
        target=page_id,
        detail={
            "proposal_id": p.id,
            "page": page.title,
            "changes": len(rows),
            "base_version": base_version,
            "ticket_id": ticket_id,
            "job_id": job_id,
        },
    )
    await board_events.publish(board_events.INVALIDATE)
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
    await expire_due(session, project_id)
    rows = (
        await session.exec(
            select(DocsAiProposal.page_id).where(
                DocsAiProposal.project_id == project_id,
                DocsAiProposal.status == "waiting",
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
                .where(
                    DocsAiProposal.page_id == page_id,
                    col(DocsAiProposal.status).in_(statuses),
                )
                .order_by(col(DocsAiProposal.created_at).desc())
            )
        ).all()
    )


async def _get(session: AsyncSession, proposal_id: str) -> DocsAiProposal:
    p = await session.get(DocsAiProposal, proposal_id)
    if p is None:
        raise DocsAiError("not_found", "That proposal does not exist.")
    return p


async def _published(session: AsyncSession, page: DocsPage) -> str:
    if not page.version:
        return ""
    v = (
        await session.exec(
            select(DocsVersion).where(
                DocsVersion.page_id == page.id, DocsVersion.version == page.version
            )
        )
    ).first()
    return v.markdown if v else ""


async def version_text(
    session: AsyncSession, page: DocsPage, version: int | None
) -> str | None:
    """The Markdown of one published version of a page (None when it does not exist)."""
    if not version:
        return None
    v = (
        await session.exec(
            select(DocsVersion).where(
                DocsVersion.page_id == page.id, DocsVersion.version == version
            )
        )
    ).first()
    return v.markdown if v else None


# ---------------------------------------------------------------------------
# Who decides
# ---------------------------------------------------------------------------


async def _ai_names(session: AsyncSession, project_id: str) -> set[str]:
    rows = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    return {m.name.casefold() for m in rows}


async def forbid_ai(session: AsyncSession, project_id: str, by: str | None) -> None:
    """An AI member never decides a proposal or an approval: not inside an AI run, not as the agent, not under an AI
    member's name (so it cannot approve its own proposal)."""
    from services.ai import guard

    if guard.current() is not None or by == activity.AGENT_ACTOR:
        raise DocsAiError(
            "forbidden", "AI members cannot decide proposals. A person reviews them."
        )
    if by and by.casefold() in await _ai_names(session, project_id):
        raise DocsAiError(
            "forbidden", "An AI member cannot decide a proposal, including its own."
        )


async def can_edit_page(session: AsyncSession, project_id: str, person: str) -> bool:
    """Whether `person` may edit pages of the project (the people who decide proposals)."""
    if person == activity.HUMAN_ACTOR:
        return True
    project = await session.get(Project, project_id)
    if project is None:
        return False
    members = await docs_access.members_of(session, project_id)
    if not docs_access.has_access(members, person):
        return False
    if person.casefold() in await _ai_names(session, project_id):
        return False
    return docs_access.can_edit(
        docs_access.role_in(members, person), project.docs_edit_policy or "members"
    )


async def _require_reviewer(session: AsyncSession, p: DocsAiProposal, by: str) -> None:
    await forbid_ai(session, p.project_id, by)
    if not await can_edit_page(session, p.project_id, by):
        raise DocsAiError(
            "viewer", "Only people who can edit this page decide its proposals."
        )


# ---------------------------------------------------------------------------
# Reading: stale changes, expiry and the view the page shows
# ---------------------------------------------------------------------------


async def refresh(session: AsyncSession, p: DocsAiProposal) -> DocsAiProposal:
    """Expire the proposal when its time is up, and mark pending changes whose text is no longer on the page."""
    if p.status == "waiting":
        exp = parse_iso(p.expires_at)
        if exp and exp < datetime.now(UTC):
            await _close(
                session, p, "expired", by="board", note="No decision before it expired"
            )
            return p
        page = await session.get(DocsPage, p.page_id)
        if page is None:
            return p
        text = await _published(session, page)
        changes = loads(p.changes, [])
        dirty = False
        for c in changes:
            if c["status"] != "pending":
                continue
            stale = not _applies(text, page.title, c)
            if stale != c.get("stale"):
                c["stale"] = stale
                dirty = True
        if dirty:
            p.changes = json.dumps(changes)
            session.add(p)
            await session.commit()
            await session.refresh(p)
    return p


async def expire_due(session: AsyncSession, project_id: str | None = None) -> int:
    """Mark waiting proposals past their time (and their approvals) expired. Nothing on the page changes."""
    stmt = select(DocsAiProposal).where(DocsAiProposal.status == "waiting")
    if project_id:
        stmt = stmt.where(DocsAiProposal.project_id == project_id)
    now = datetime.now(UTC)
    n = 0
    for p in (await session.exec(stmt)).all():
        exp = parse_iso(p.expires_at)
        if exp and exp < now:
            await _close(
                session, p, "expired", by="board", note="No decision before it expired"
            )
            n += 1
    return n


async def _member_label(
    session: AsyncSession, member_id: str
) -> tuple[str, str | None]:
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    name = member.name if member else "AI member"
    provider = None
    if profile is not None:
        provider = {
            "claude-code": "Claude Code",
            "anthropic": "Claude API",
            "openai": "OpenAI",
            "gemini": "Gemini",
            "google": "Gemini",
        }.get(profile.provider, profile.provider)
    return name, provider


async def view(
    session: AsyncSession, p: DocsAiProposal, *, actor: str | None = None
) -> dict[str, Any]:
    """The proposal with what the banner and the review panel show: who, for which ticket, on whose behalf, when it
    expires, whether the page changed since and how many changes still apply."""
    p = await refresh(session, p)
    page = await session.get(DocsPage, p.page_id)
    name, provider = await _member_label(session, p.member_id)
    d = to_dict(p, name)
    changes = d["changes"]
    exp = parse_iso(p.expires_at)
    days = None
    if exp and p.status == "waiting":
        days = max(
            0,
            (exp - datetime.now(UTC)).days
            + (1 if (exp - datetime.now(UTC)).seconds else 0),
        )
    d.update(
        {
            "member_provider": provider,
            "page_title": page.title if page else "",
            "page_version": page.version if page else 0,
            "changed_since": bool(page and page.version != p.base_version),
            "still_apply": sum(1 for c in changes if not c.get("stale")),
            "pending": sum(
                1 for c in changes if c["status"] == "pending" and not c.get("stale")
            ),
            "expires_in_days": days,
            "can_decide": bool(
                actor
                and p.status == "waiting"
                and await can_edit_page(session, p.project_id, actor)
                and actor.casefold() not in await _ai_names(session, p.project_id)
            ),
        }
    )
    return d


async def list_for_page(
    session: AsyncSession, page_id: str, *, actor: str
) -> list[dict[str, Any]]:
    """Waiting proposals of a page and the ones decided in the last 30 days, newest first."""
    page = await session.get(DocsPage, page_id)
    if page is None:
        raise DocsAiError("not_found", "Page not found.")
    await expire_due(session, page.project_id)
    since = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    rows = (
        await session.exec(
            select(DocsAiProposal)
            .where(DocsAiProposal.page_id == page_id)
            .order_by(col(DocsAiProposal.created_at).desc())
            .limit(50)
        )
    ).all()
    keep = [
        r
        for r in rows
        if r.status == "waiting" or (r.decided_at or r.created_at) >= since
    ]
    return [await view(session, r, actor=actor) for r in keep]


# ---------------------------------------------------------------------------
# Deciding
# ---------------------------------------------------------------------------


def _status_of(changes: list[dict[str, Any]]) -> str:
    if any(c["status"] == "pending" and not c.get("stale") for c in changes):
        return "waiting"
    accepted = sum(c["status"] == "accepted" for c in changes)
    if accepted == 0:
        return "rejected"
    return "accepted" if accepted == len(changes) else "partial"


async def _reviewer_draft(
    session: AsyncSession, page: DocsPage, reviewer: str
) -> DocsDraft:
    """The reviewer's draft of the page, started from the published text when there is none."""
    draft = (
        await session.exec(
            select(DocsDraft).where(
                DocsDraft.page_id == page.id, DocsDraft.author == reviewer
            )
        )
    ).first()
    if draft is None:
        draft = DocsDraft(
            page_id=page.id,
            author=reviewer,
            title=page.title,
            markdown=await _published(session, page),
            base_version=page.version,
            saves=0,
        )
    return draft


def _mark_ai(draft: DocsDraft, p: DocsAiProposal) -> None:
    src = loads(draft.ai_source, None)
    if not isinstance(src, dict):
        src = {
            "kind": "proposal",
            "from": "proposal",
            "member_id": p.member_id,
            "gaps": [],
            "sources": [],
        }
    ids = list(dict.fromkeys([*src.get("proposals", []), p.id]))
    src.update({"proposals": ids, "accepted": True})
    draft.ai_source = json.dumps(src)


async def _accept_into_draft(
    session: AsyncSession,
    p: DocsAiProposal,
    page: DocsPage,
    by: str,
    which: list[dict[str, Any]],
) -> tuple[list[int], list[int]]:
    """Apply changes to the reviewer's draft: (accepted numbers, stale numbers). The caller commits."""
    draft = await _reviewer_draft(session, page, by)
    text, title = draft.markdown, draft.title
    ok: list[int] = []
    stale: list[int] = []
    for c in which:
        if c.get("kind") == "title":
            if title != c["old"] and title != page.title:
                stale.append(c["n"])
                continue
            title = c["new"]
            ok.append(c["n"])
            continue
        out = apply_change(text, c)
        if out is None:
            stale.append(c["n"])
            continue
        text = out
        ok.append(c["n"])
    if ok:
        draft.markdown = text
        draft.title = title
        draft.saves += 1
        draft.updated_at = now_iso()
        _mark_ai(draft, p)
        session.add(draft)
    return ok, stale


async def _close(
    session: AsyncSession, p: DocsAiProposal, status: str, *, by: str, note: str | None
) -> None:
    """Set the final status, close the matching approval and write the audit entry."""
    p.status = status
    p.decided_by = by
    p.decided_at = now_iso()
    if note is not None:
        p.decision_note = (note or "").strip()[:500] or None
    session.add(p)
    if p.approval_id:
        a = await session.get(AiApproval, p.approval_id)
        if a is not None and a.status == "pending":
            a.status = {
                "accepted": "approved",
                "partial": "approved",
                "rejected": "denied",
            }.get(status, "expired")
            a.decided_by = by
            a.decided_at = now_iso()
            a.decision_note = p.decision_note or (
                "No decision before it expired" if status == "expired" else None
            )
            session.add(a)
    await session.commit()
    await session.refresh(p)
    await _audit(p, status, by, {"note": p.decision_note})
    if status in ("rejected", "partial") and p.ticket_id:
        await _tell_ticket(p, by)
    await board_events.publish(board_events.INVALIDATE)


async def _audit(
    p: DocsAiProposal, result: str, by: str, extra: dict[str, Any] | None = None
) -> None:
    from services.ai import audit

    async with database.async_session() as session:
        member = await session.get(Member, p.member_id)
    await audit.record(
        p.project_id,
        "edit_docs",
        result,
        member_id=p.member_id,
        member_name=member.name if member else "",
        on_behalf_of=p.on_behalf_of,
        run_id=p.run_id,
        target=p.page_id,
        detail={"proposal_id": p.id, "by": by, **(extra or {})},
    )


async def _tell_ticket(p: DocsAiProposal, by: str) -> None:
    """The AI member sees a rejection and its reason: a comment on the ticket it worked on."""
    import services.tickets as svc_tickets

    async with database.async_session() as session:
        member = await session.get(Member, p.member_id)
        page = await session.get(DocsPage, p.page_id)
        changes = loads(p.changes, [])
        rejected = [c for c in changes if c["status"] != "accepted"]
        what = (
            "the proposal"
            if p.status == "rejected"
            else f"{len(rejected)} of {len(changes)} changes"
        )
        text = (
            f"{by if by != 'user' else 'A person'} rejected {what} {member.name if member else 'the AI member'} made "
            f"for the page “{page.title if page else ''}”"
            + (f": {p.decision_note}" if p.decision_note else ".")
        )
        try:
            await svc_tickets.add_comment(
                session, p.ticket_id, text, author=by, meta={"docs_proposal": p.id}
            )
        except (
            ValueError,
            LookupError,
        ):  # the ticket is gone: the audit entry still says it
            log.info("ticket %s for proposal %s is gone", p.ticket_id, p.id)


async def _decide(
    session: AsyncSession,
    proposal_id: str,
    *,
    by: str,
    accept: bool,
    numbers: list[int] | None,
    note: str | None = None,
) -> DocsAiProposal:
    p = await _get(session, proposal_id)
    await _require_reviewer(session, p, by)
    p = await refresh(session, p)
    if p.status != "waiting":
        raise DocsAiError("conflict", f"This proposal is already {p.status}.")
    page = await session.get(DocsPage, p.page_id)
    if page is None or page.deleted_at:
        raise DocsAiError("not_found", "The page is gone.")
    changes = loads(p.changes, [])
    by_n = {c["n"]: c for c in changes}
    if numbers is not None:
        missing = [n for n in numbers if n not in by_n]
        if missing:
            raise DocsAiError(
                "not_found", f"Change {missing[0]} is not in this proposal."
            )
    picked = [
        by_n[n]
        for n in (numbers if numbers is not None else by_n)
        if by_n[n]["status"] == "pending"
    ]
    if numbers is not None and not picked:
        raise DocsAiError("conflict", "That change was already decided.")
    stamp = {"decided_by": by, "decided_at": now_iso()}
    if accept:
        if numbers is not None and any(c.get("stale") for c in picked):
            raise DocsAiError(
                "stale",
                "Needs a new look: the page no longer has the text this change replaces, so it cannot be accepted.",
            )
        ok, stale = await _accept_into_draft(
            session, p, page, by, [c for c in picked if not c.get("stale")]
        )
        if numbers is not None and stale:
            by_n[stale[0]]["stale"] = True
            p.changes = json.dumps(changes)
            session.add(p)
            await session.commit()
            raise DocsAiError(
                "stale",
                "Needs a new look: your draft no longer has the text this change replaces.",
            )
        for n in ok:
            by_n[n].update({"status": "accepted", **stamp})
        for n in stale:
            by_n[n]["stale"] = True
        if not ok:
            p.changes = json.dumps(changes)
            session.add(p)
            await session.commit()
            raise DocsAiError(
                "stale",
                "Needs a new look: none of these changes match the page any more. Reject them instead.",
            )
    else:
        for c in picked:
            c.update({"status": "rejected", **stamp})
            if note:
                c["note"] = note.strip()[:300]
    p.changes = json.dumps(changes)
    session.add(p)
    await session.commit()
    await session.refresh(p)
    for c in picked:
        if c["status"] in ("accepted", "rejected"):
            await _audit(
                p, f"change_{c['status']}", by, {"change": c["n"], "title": c["title"]}
            )
    status = _status_of(changes)
    if status != "waiting":
        await _close(session, p, status, by=by, note=note)
    else:
        await board_events.publish(board_events.INVALIDATE)
    return p


async def decide_change(
    session: AsyncSession,
    proposal_id: str,
    n: int,
    *,
    by: str,
    accept: bool,
    note: str | None = None,
) -> DocsAiProposal:
    """Accept one change (its text goes into `by`'s draft of the page) or reject it."""
    return await _decide(
        session, proposal_id, by=by, accept=accept, numbers=[n], note=note
    )


async def decide_all(
    session: AsyncSession,
    proposal_id: str,
    *,
    by: str,
    accept: bool,
    note: str | None = None,
) -> DocsAiProposal:
    """Accept every change that still applies (stale ones stay out) or reject every pending change."""
    return await _decide(
        session, proposal_id, by=by, accept=accept, numbers=None, note=note
    )


async def edit_change(
    session: AsyncSession, proposal_id: str, n: int, *, by: str, new: str
) -> DocsAiProposal:
    """Change the text a change puts on the page before accepting it."""
    p = await _get(session, proposal_id)
    await _require_reviewer(session, p, by)
    p = await refresh(session, p)
    if p.status != "waiting":
        raise DocsAiError("conflict", f"This proposal is already {p.status}.")
    changes = loads(p.changes, [])
    c = next((x for x in changes if x["n"] == n), None)
    if c is None:
        raise DocsAiError("not_found", f"Change {n} is not in this proposal.")
    if c["status"] != "pending":
        raise DocsAiError("conflict", "That change was already decided.")
    if len(new) > MAX_TEXT:
        raise DocsAiError("invalid", "That text is too long.")
    c["original_new"] = c.get("original_new", c["new"])
    c["new"] = new
    c["edited_by"] = by
    p.changes = json.dumps(changes)
    session.add(p)
    await session.commit()
    await session.refresh(p)
    await _audit(p, "change_edited", by, {"change": n})
    await board_events.publish(board_events.INVALIDATE)
    return p


async def decide_from_approval(
    approval_id: str, *, by: str, approve: bool, note: str | None
) -> None:
    """Approve (accept every change that applies into `by`'s draft) or deny (reject the proposal) from Approvals."""
    async with database.async_session() as session:
        a = await session.get(AiApproval, approval_id)
        if a is None:
            raise DocsAiError("not_found", "Approval not found.")
        proposal_id = (loads(a.payload, {}) or {}).get("proposal_id")
        if not proposal_id:
            raise DocsAiError("not_found", "This approval has no proposal.")
        await decide_all(session, proposal_id, by=by, accept=approve, note=note)


# ---------------------------------------------------------------------------
# An AI run's docs_write while Docs AI is on (called by services.ai.guard)
# ---------------------------------------------------------------------------


async def _docs_ai_on(session: AsyncSession, project_id: str) -> bool:
    row = await svc_settings.get(session, project_id)
    return bool(row.enabled and await svc_settings.master_on(session))


async def intercept(ctx, action: str, params: dict[str, Any]) -> dict[str, Any] | None:
    """Turn an AI run's page edit into a proposal (or a private draft) when Docs AI is on for the page's project.

    Returns the tool result for the AI, or None when the call goes on as before (Docs AI off, another action, an
    unknown page). Raises `AiActionError` when the edit is refused (Ask run, blocked, hidden page, approvals full).
    """
    from services.ai import guard
    from services.ai.permissions import BLOCKED, effective
    from services.ai.store import get_profile

    from . import access

    if action not in PROPOSAL_ACTIONS and action not in REFUSED_ACTIONS:
        return None
    async with database.async_session() as session:
        page = None
        if params.get("page_id"):
            page = await session.get(DocsPage, params["page_id"])
        elif params.get("thread_id"):
            from models import DocsCommentThread

            t = await session.get(DocsCommentThread, params["thread_id"])
            page = await session.get(DocsPage, t.page_id) if t else None
        if page is None or page.deleted_at:
            return None
        if not await _docs_ai_on(session, page.project_id):
            return None
        detail = {
            "tool": "docs_write",
            "op": action,
            "request": {k: v for k, v in params.items() if k != "markdown"},
        }
        if action in REFUSED_ACTIONS:
            raise await guard._refuse(
                ctx, "edit_docs", page.id, detail, REFUSED_ACTIONS[action]
            )
        if ctx.mode == "ask":
            raise await guard._refuse(
                ctx,
                "edit_docs",
                page.id,
                detail,
                "Ask runs only read and answer. Nothing was changed.",
            )
        _, profile = await get_profile(session, ctx.member_id)
        settings = await guard._settings_for(session, ctx)
        if profile is None:
            raise await guard._refuse(
                ctx, "edit_docs", page.id, detail, "This AI member was removed."
            )
        decision = effective(profile, "edit_docs", settings)
        if decision.mode == BLOCKED:
            raise await guard._refuse(
                ctx, "edit_docs", page.id, detail, decision.reason
            )
        if not await access.ai_can_read(session, page):
            raise await guard._refuse(
                ctx,
                "edit_docs",
                page.id,
                detail,
                "This page is hidden from AI, so AI members cannot change it.",
            )
        current = await _published(session, page)
        if action == "restore_version":
            target = await version_text(session, page, params.get("version"))
            if target is None:
                raise guard.AiActionError(
                    f"Version {params.get('version')} of this page does not exist."
                )
            read_text, base = current, page.version
            new_text, new_title = target, None
            note = params.get("note") or f"Restore v{params.get('version')}"
        else:
            base = params.get("base_version")
            read = await version_text(session, page, base) if base else None
            read_text = read if read is not None else current
            base = base if read is not None else page.version
            new_text = params.get("markdown") or ""
            new_title = params.get("title")
            note = params.get("note") or ""
        reason = (
            note.strip()
            or f"{ctx.member_name} proposed this while working on {ctx.ticket_id}."
        )
        if ctx.ticket_id and ctx.ticket_id not in reason:
            reason = f"{reason} (for {ctx.ticket_id})"
        changes = text_changes(read_text, new_text, reason=reason, current=current)
        if new_title and new_title.strip() and new_title.strip() != page.title:
            changes.append(
                {
                    "kind": "title",
                    "title": "Rename the page",
                    "reason": reason,
                    "old": page.title,
                    "new": new_title.strip(),
                }
            )
        if not normalize_changes(changes):
            return {
                "id": page.id,
                "title": page.title,
                "version": page.version,
                "published": False,
                "message": "Your text is the same as the published page; there is nothing to propose.",
            }
        mode = (await svc_settings.get(session, page.project_id)).edits_mode
        if mode == "draft":
            return await _to_draft(session, ctx, page, changes, current)
        return await _to_proposal(session, ctx, page, changes, base, note, settings)


async def _to_draft(
    session: AsyncSession, ctx, page: DocsPage, changes: list[dict], current: str
) -> dict[str, Any]:
    """ "Draft only": the edit becomes the private draft of the person the run acts for. Never published."""
    from services.ai import audit

    who = ctx.on_behalf_of or activity.HUMAN_ACTOR
    draft = await _reviewer_draft(session, page, who)
    text, title = draft.markdown, draft.title
    skipped = 0
    for c in normalize_changes(changes):
        if c["kind"] == "title":
            title = c["new"]
            continue
        out = apply_change(text, c)
        if out is None:
            skipped += 1
            continue
        text = out
    draft.markdown, draft.title = text, title
    draft.saves += 1
    draft.updated_at = now_iso()
    draft.ai_source = json.dumps(
        {
            "kind": "edit",
            "from": "run",
            "member_id": ctx.member_id,
            "run_id": ctx.run_id,
            "ticket_id": ctx.ticket_id,
            "gaps": [],
            "sources": [],
            "skipped": skipped,
        }
    )
    session.add(draft)
    await session.commit()
    await audit.record(
        page.project_id,
        "edit_docs",
        "drafted",
        member_id=ctx.member_id,
        member_name=ctx.member_name,
        on_behalf_of=ctx.on_behalf_of,
        run_id=ctx.run_id,
        target=page.id,
        detail={"page": page.title, "draft_of": who, "skipped": skipped},
    )
    await board_events.publish(board_events.INVALIDATE)
    return {
        "id": page.id,
        "title": page.title,
        "version": page.version,
        "published": False,
        "draft_for": who,
        "message": (
            f"DRAFTED: your edit was saved as a private draft for {who}. Nothing was published; {who} reviews and "
            "publishes it."
            + (
                f" {skipped} change(s) no longer matched the page and were left out."
                if skipped
                else ""
            )
            + " Do not retry it; continue with the rest of the work."
        ),
    }


async def _to_proposal(
    session: AsyncSession,
    ctx,
    page: DocsPage,
    changes: list[dict],
    base: int,
    note: str,
    settings,
) -> dict[str, Any]:
    """ "Proposal to review": a proposal on the page, a row in Approvals and one notification."""
    from services.ai import guard, safety

    pending = (
        await session.exec(
            select(AiApproval).where(
                AiApproval.member_id == ctx.member_id, AiApproval.status == "pending"
            )
        )
    ).all()
    if len(pending) >= guard.MAX_PENDING_PER_AGENT:
        raise await guard._refuse(
            ctx,
            "edit_docs",
            page.id,
            {"tool": "docs_write", "op": "update"},
            f"Approvals full: {len(pending)} requests of this AI member already wait for a person. Nothing was changed.",
            code="approvals_full",
        )
    p = await create_proposal(
        session,
        project_id=page.project_id,
        page_id=page.id,
        member_id=ctx.member_id,
        base_version=base,
        changes=changes,
        summary=note,
        run_id=ctx.run_id or None,
        ticket_id=ctx.ticket_id or None,
        on_behalf_of=ctx.on_behalf_of,
    )
    rows = loads(p.changes, [])
    section = next((c.get("section") for c in rows if c.get("section")), None)
    approval = AiApproval(
        project_id=page.project_id,
        member_id=ctx.member_id,
        run_id=ctx.run_id or None,
        ticket_id=ctx.ticket_id or None,
        action="edit_docs",
        summary=f"Edit doc · {page.title}" + (f" › # {section}" if section else ""),
        payload=json.dumps(
            {
                "tool": APPROVAL_TOOL,
                "action": "review",
                "params": {
                    "page_id": page.id,
                    "page_title": page.title,
                    "proposal_id": p.id,
                    "changes": len(rows),
                },
                "proposal_id": p.id,
            }
        ),
        reason=note or None,
        risk="medium",
        on_behalf_of=ctx.on_behalf_of,
        expires_at=p.expires_at,
    )
    session.add(approval)
    await session.commit()
    await session.refresh(approval)
    p.approval_id = approval.id
    session.add(p)
    await session.commit()
    n = len(rows)
    plural = "change" if n == 1 else "changes"
    await safety.notify(
        page.project_id,
        "approval_requested",
        f"{ctx.member_name} proposed {n} {plural} to {page.title}",
        (f"For {ctx.ticket_id} · " if ctx.ticket_id else "")
        + f"on behalf of {ctx.on_behalf_of}. Nothing changes until a person accepts it.",
        ref_kind="approval",
        ref_id=approval.id,
        member_id=ctx.member_id,
        people=[ctx.on_behalf_of, *[d["to"] for d in safety.delegates_of(settings)]],
        data={"proposal_id": p.id, "page_id": page.id},
    )
    await board_events.publish(board_events.INVALIDATE)
    return {
        "id": page.id,
        "title": page.title,
        "version": page.version,
        "published": False,
        "proposal_id": p.id,
        "status": "waiting",
        "changes": n,
        "message": (
            f"PROPOSED: {n} {plural} to “{page.title}” wait for review by a person; nothing was changed on the page. "
            "A person accepts them into their draft and publishes. Do not retry it; continue with the rest of the work."
        ),
    }


async def notes_for_read(ctx, page_id: str) -> list[dict[str, Any]]:
    """What happened to this AI member's recent proposals for a page (rejections with their reason): shown to the
    AI in its next `docs_read(get)`."""
    since = (datetime.now(UTC) - timedelta(days=14)).isoformat()
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(DocsAiProposal)
                .where(
                    DocsAiProposal.page_id == page_id,
                    DocsAiProposal.member_id == ctx.member_id,
                    col(DocsAiProposal.status).in_(list(DECIDED)),
                )
                .order_by(col(DocsAiProposal.created_at).desc())
                .limit(5)
            )
        ).all()
    return [
        {
            "proposal_id": p.id,
            "status": p.status,
            "decided_by": p.decided_by,
            "reason": p.decision_note,
            "changes": [
                {"n": c["n"], "title": c["title"], "status": c["status"]}
                for c in loads(p.changes, [])
            ],
        }
        for p in rows
        if (p.decided_at or "") >= since
    ]


# ---------------------------------------------------------------------------
# The expiry loop (started from the app lifespan)
# ---------------------------------------------------------------------------

_task: asyncio.Task | None = None


async def _loop() -> None:
    while True:
        try:
            async with database.async_session() as session:
                await expire_due(session)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the loop must survive a bad row
            log.exception("Docs AI proposal expiry failed")
        await asyncio.sleep(EXPIRY_EVERY_S)


def start_scheduler() -> None:
    """Start the loop that expires proposals nobody decided in time."""
    global _task  # noqa: PLW0603
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    """Stop the expiry loop."""
    global _task  # noqa: PLW0603
    if _task:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _task = None
