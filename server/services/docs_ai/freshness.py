"""Keeping pages true (design/screens/docs-ai-care.md, A): compare a page's published text with the tickets it links
to and the pages it links to, and say what no longer matches.

Rules: never guess from the page alone and never flag a page for being old. A page is only looked at by the model when
something it depends on changed after it was published; what it depends on is hashed (`deps_hash`), so a page whose
dependencies did not change costs nothing. Every reason names what was compared, quotes text that really occurs on the
page and names tickets that really exist. "Still correct" hides the banner for 30 days, and the page is flagged again
only when `deps_hash` changes. The AI never edits a page: a suggested edit is one proposal for a person to review.
"""

import asyncio
import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import (
    DocsAiCheck,
    DocsAiJob,
    DocsAiSettings,
    DocsLink,
    DocsPage,
    Project,
    Ticket,
)
from services import activity
from services import docs as svc_docs
from services.ai.assist import settings as assist
from services.ai.context import STATUS_LABELS
from services.ai.store import loads, now_iso, parse_iso

from . import access, engine, jobs, proposals
from . import settings as svc_settings
from .errors import DocsAiError

log = logging.getLogger(__name__)

STILL_CORRECT_DAYS = 30
DAILY_CAP = 20  # model checks per project per day (the scheduler)
MANUAL_CAP = 10  # model checks of one "Run now"
PAUSE_SECONDS = 2.0  # between two scheduled model checks: a low rate
START_HOUR = 6  # the daily check runs after 06:00
DIGEST_WEEKDAY, DIGEST_HOUR = 0, 9  # Monday 09:00
MAX_REASONS = 6
MAX_COMMENTS = 5
LEVELS = ("once", "30d", "never")
_loop_task: asyncio.Task | None = None


class Deferred(Exception):
    """A check needs the model but the daily cap is used up (the page keeps its last result)."""


def _when(iso: str | None) -> datetime | None:
    return parse_iso(iso)


def _clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _ago(at: datetime | None) -> str:
    if at is None:
        return ""
    days = (datetime.now(UTC) - at).days
    return "today" if days <= 0 else f"{days} day{'s' if days != 1 else ''} ago"


# ---------------------------------------------------------------------------
# What a page depends on
# ---------------------------------------------------------------------------


@dataclass
class Facts:
    """What a page depends on: the tickets and pages it links to, and which of them changed after it was published."""

    tickets: list[dict[str, Any]] = field(default_factory=list)
    pages: list[dict[str, Any]] = field(default_factory=list)
    changed: list[str] = field(
        default_factory=list
    )  # refs that changed since the page was published
    hash: str = ""


def _ticket_fact(t: Ticket, published_at: datetime | None) -> dict[str, Any]:
    changed: datetime | None = None
    moved: datetime | None = None
    for e in loads(t.activity_log, []):
        if not isinstance(e, dict) or e.get("field") not in (
            "status",
            "title",
            "description",
            "wont_do_reason",
        ):
            continue
        at = _when(e.get("at"))
        if at is None:
            continue
        changed = max(changed, at) if changed else at
        if e.get("field") == "status" and e.get("to") == t.status:
            moved = max(moved, at) if moved else at
    live = [
        c
        for c in loads(t.comments, [])
        if isinstance(c, dict) and c.get("text") and not c.get("deleted_at")
    ]
    last_comment: datetime | None = None
    for c in live:
        at = _when(c.get("at"))
        if at:
            last_comment = max(last_comment, at) if last_comment else at
            changed = max(changed, at) if changed else at
    recent = [
        {
            "at": c.get("at"),
            "author": c.get("author") or "",
            "text": _clip(str(c["text"]), 400),
        }
        for c in live
        if published_at is None or (_when(c.get("at")) or published_at) > published_at
    ][-MAX_COMMENTS:]
    return {
        "id": t.id,
        "title": t.title,
        "status": t.status,
        "moved_at": moved.isoformat() if moved else None,
        "changed_at": changed.isoformat() if changed else None,
        "description": _clip(t.description or "", 600),
        "comments": recent,
        "comments_total": len(live),
        "last_comment_at": last_comment.isoformat() if last_comment else None,
        "newer": bool(changed and published_at and changed > published_at),
    }


async def _facts(
    session: AsyncSession,
    page: DocsPage,
    published_at: datetime | None,
    readable: set[str],
) -> Facts:
    links = (
        await session.exec(select(DocsLink).where(DocsLink.source_page_id == page.id))
    ).all()
    ticket_ids = sorted({lk.target_ticket_id for lk in links if lk.target_ticket_id})
    page_ids = sorted(
        {
            lk.target_page_id
            for lk in links
            if lk.target_page_id
            and lk.target_page_id != page.id
            and lk.target_page_id in readable
        }
    )
    facts = Facts()
    for tid in ticket_ids:
        t = await session.get(Ticket, tid)
        if t is None or t.project_id != page.project_id:
            continue
        facts.tickets.append(_ticket_fact(t, published_at))
    for pid in page_ids:
        other = await session.get(DocsPage, pid)
        if other is None or other.deleted_at or not other.version:
            continue
        v = await svc_docs._latest_version(session, other)  # noqa: SLF001
        at = _when(v.created_at) if v else None
        facts.pages.append(
            {
                "id": other.id,
                "title": other.title,
                "version": other.version,
                "published_at": at.isoformat() if at else None,
                "newer": bool(at and published_at and at > published_at),
            }
        )
    facts.changed = [t["id"] for t in facts.tickets if t["newer"]] + [
        p["title"] for p in facts.pages if p["newer"]
    ]
    key = {
        "tickets": [
            [
                t["id"],
                t["title"],
                t["status"],
                t["moved_at"],
                t["comments_total"],
                t["last_comment_at"],
                hashlib.sha1((t["description"] or "").encode()).hexdigest()[:8],
            ]
            for t in facts.tickets
        ],
        "pages": [[p["id"], p["title"], p["version"]] for p in facts.pages],
    }
    facts.hash = hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()
    return facts


# ---------------------------------------------------------------------------
# Reasons: parse and verify the model's answer
# ---------------------------------------------------------------------------


def _norm(text: str) -> str:
    text = (
        (text or "")
        .replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
    )
    text = re.sub(
        r"\[\[([^\]|]*)(?:\|([^\]]*))?\]\]", lambda m: m.group(2) or m.group(1), text
    )
    text = re.sub(r"[*_`~>]", "", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def _json_of(text: str) -> Any:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(text[start:])[0]
    except ValueError:
        return None


def compared_label(kind: str, ref: str, facts: Facts) -> str:
    """What a reason compared, in words ("ticket KAN-12 (status, title, recent comments)")."""
    if kind == "ticket":
        return f"ticket {ref} (status, title, recent comments)"
    page = next((p for p in facts.pages if p["title"].lower() == ref.lower()), None)
    return f"page {ref} (newer version{' v' + str(page['version']) if page else ''})"


async def verify_reasons(
    project_id: str, raw: Any, page_text: str, facts: Facts
) -> list[dict[str, Any]]:
    """Keep the reasons whose quote really occurs on the page and whose ticket or page really is a dependency.

    Returns:
        Reasons `{key, kind, ref, text, compared, quote, at}`, at most `MAX_REASONS`.
    """
    items = raw.get("reasons") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    page_norm = _norm(page_text)
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    tickets = {t["id"] for t in facts.tickets}
    for it in items:
        if not isinstance(it, dict):
            continue
        kind = str(it.get("kind") or "").strip()
        ref = str(it.get("ref") or "").strip()
        quote = str(it.get("quote") or "").strip()
        text = _clip(str(it.get("text") or ""), 400)
        if not text or len(_norm(quote)) < 6 or _norm(quote) not in page_norm:
            continue
        if kind == "ticket" and ref not in tickets:
            continue
        if kind == "page":
            hit = next(
                (p for p in facts.pages if p["title"].lower() == ref.lower()), None
            )
            if hit is None:
                continue
            ref = hit["title"]
        if kind not in ("ticket", "page"):
            continue
        checked = await engine.verify_refs(project_id, text)
        if checked.unknown_tickets or checked.unknown_pages:
            continue
        sig = (kind, ref, _norm(quote))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(
            {
                "key": f"{kind}:{ref}",
                "kind": kind,
                "ref": ref,
                "text": checked.text,
                "compared": compared_label(kind, ref, facts),
                "quote": quote[:300],
                "at": now_iso(),
            }
        )
    return out[:MAX_REASONS]


def _prompt(
    page: DocsPage, text: str, version_at: datetime | None, facts: Facts
) -> str:
    parts = [
        f'Page "{page.title}", published as v{page.version}'
        + (f" on {version_at:%Y-%m-%d}." if version_at else "."),
        "Page text:\n" + engine.fenced(f"page {page.title}", _clip(text, 12000)),
        "Tickets this page links to (status and dates are facts from the board):",
    ]
    for t in facts.tickets:
        label = STATUS_LABELS.get(t["status"], t["status"])
        moved = _when(t["moved_at"])
        head = f"{t['id']} · {label}" + (
            f" since {moved:%Y-%m-%d} ({_ago(moved)})" if moved else ""
        )
        body = f"Title: {t['title']}\n"
        if t["description"]:
            body += f"Description: {t['description']}\n"
        for c in t["comments"]:
            body += f"Comment by {c['author']} ({c['at']}): {c['text']}\n"
        parts.append(head + "\n" + engine.fenced(f"ticket {t['id']}", body))
    newer = [p for p in facts.pages if p["newer"]]
    if newer:
        parts.append("Pages this page links to that changed after it was published:")
        for p in newer:
            parts.append(f"{p['title']} · v{p['version']} · {p['published_at']}")
    parts.append(
        "Find statements on the page that the tickets or pages above now contradict or have overtaken. Never flag a "
        "page because it is old. Answer only with JSON: "
        '{"reasons":[{"kind":"ticket","ref":"KAN-12","quote":"text copied exactly from the page",'
        '"text":"One plain sentence: what changed and what the page says."}]}. '
        'Use kind "page" and the page title as ref for a linked page. Use [] when the page still matches.'
    )
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Check a page
# ---------------------------------------------------------------------------


async def _asked_model(
    session: AsyncSession,
    page: DocsPage,
    text: str,
    version_at: datetime | None,
    facts: Facts,
    by: str,
    job_id: str,
) -> list[dict[str, Any]]:
    who = await engine.resolve(page.project_id)
    row = await assist.get(session)
    await jobs.add_step(job_id, "Comparing with " + ", ".join(facts.changed)[:200])
    reads = [{"page_id": page.id, "title": page.title, "why": "checked"}] + [
        {"page_id": p["id"], "title": p["title"], "why": "linked"} for p in facts.pages
    ]
    await jobs.set_reads(job_id, reads)
    for t in facts.tickets:
        blob = " ".join(
            [t["title"], t["description"]] + [c["text"] for c in t["comments"]]
        )
        phrase = engine.injection_in(blob)
        if phrase:
            await jobs.add_step(
                job_id,
                f"{t['id']} contains text that reads like an instruction. It was treated as data, not followed.",
            )
    out = await engine.call(
        page.project_id,
        system=engine.system_prompt(
            who,
            row,
            "You check whether a page still matches the board. Reply with JSON only.",
        ),
        prompt=_prompt(page, text, version_at, facts),
        who=who,
        job_id=job_id,
        person=by,
        max_tokens=1200,
        timeout=120.0,
    )
    raw = _json_of(out.text)
    if raw is None:
        raise DocsAiError(
            "unavailable", "The AI answer could not be read. Nothing was changed."
        )
    return await verify_reasons(page.project_id, raw, text, facts)


async def check_page(
    session: AsyncSession,
    page_id: str,
    by: str,
    *,
    force: bool = False,
    job_id: str | None = None,
    allow_model: bool = True,
) -> DocsAiCheck:
    """Check one page against what it depends on and store the result (one row per page).

    The model is only asked when a ticket or page the page links to changed after the page was published and the
    dependencies differ from the last check (or `force`).

    Raises:
        DocsAiError: hidden from AI, never published, or the model call failed.
        Deferred: the model is needed but `allow_model` is False.
    """
    page = await session.get(DocsPage, page_id)
    if page is None or page.deleted_at:
        raise DocsAiError("not_found", "Page not found.")
    if not await access.ai_can_read(session, page):
        raise DocsAiError("hidden", "This page is hidden from AI.")
    if not page.version:
        raise DocsAiError(
            "invalid", "Publish this page first: AI checks the published text."
        )
    text = await access.published_text(session, page)
    version = await svc_docs._latest_version(session, page)  # noqa: SLF001
    version_at = _when(version.created_at) if version else None
    readable = {p.id for p in await access.readable_pages(session, page.project_id)}
    facts = await _facts(session, page, version_at, readable)
    existing = await session.get(DocsAiCheck, page.id)
    if (
        existing is not None
        and not force
        and existing.deps_hash == facts.hash
        and existing.based_on_version == page.version
    ):
        existing.checked_at = now_iso()
        session.add(existing)
        await session.commit()
        return existing
    row = existing or DocsAiCheck(page_id=page.id, project_id=page.project_id)
    keep = (
        [
            r
            for r in loads(row.reasons, [])
            if isinstance(r, dict) and r.get("kind") == "reported"
        ]
        if existing is not None and existing.based_on_version == page.version
        else []
    )
    found: list[dict[str, Any]] = []
    used_job: str | None = job_id
    if facts.changed:
        if not allow_model:
            raise Deferred()
        own = False
        if used_job is None:
            async with database.async_session() as s2:
                used_job = (
                    await jobs.create(
                        s2,
                        project_id=page.project_id,
                        kind="freshness",
                        started_by=by,
                        page_id=page.id,
                        instruction=f"Check {page.title}"[:200],
                    )
                ).id
            own = True
        try:
            found = await _asked_model(
                session, page, text, version_at, facts, by, used_job
            )
        except DocsAiError as exc:
            if own:
                await jobs.finish(
                    used_job,
                    state="failed",
                    error={"code": exc.code, "message": str(exc)},
                )
            raise
        if own:
            await jobs.finish(
                used_job, state="finished", result={"reasons": len(found)}
            )
    reasons = found + keep
    row.reasons = json.dumps(reasons)
    row.state = "stale" if reasons else "ok"
    row.based_on_version = page.version
    row.deps_hash = facts.hash
    row.checked_at = now_iso()
    row.job_id = used_job
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


# ---------------------------------------------------------------------------
# What a person sees: still correct, dismissals, the banner
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


def hidden_by_still_correct(row: DocsAiCheck, now: datetime | None = None) -> bool:
    """ "Still correct" hides the banner for 30 days, until the dependencies change."""
    until = _when(row.ok_until)
    return bool(until and until > (now or _now()) and row.ok_hash == row.deps_hash)


def _dismissal_active(entry: dict[str, Any], row: DocsAiCheck, now: datetime) -> bool:
    level = entry.get("level")
    if level == "never":
        return True
    if level == "30d":
        until = _when(entry.get("until"))
        return bool(until and until > now)
    return (
        entry.get("hash") == row.deps_hash
    )  # "this time": until what the page depends on changes


def reason_key(r: dict[str, Any]) -> str:
    """The key a dismissal names: `kind:ref` (reasons written by other features may not carry one)."""
    return str(r.get("key") or f"{r.get('kind', '')}:{r.get('ref', '')}")


def visible_reasons(
    row: DocsAiCheck, now: datetime | None = None
) -> list[dict[str, Any]]:
    """The reasons that are not dismissed (a dismissal names a reason key, or a kind for "never"), each with its `key`."""
    now = now or _now()
    entries = [e for e in loads(row.dismissed, []) if isinstance(e, dict)]
    out = []
    for r in loads(row.reasons, []):
        if not isinstance(r, dict):
            continue
        r = {**r, "key": reason_key(r)}
        if any(
            e.get("key") in (r["key"], r.get("kind")) and _dismissal_active(e, row, now)
            for e in entries
        ):
            continue
        out.append(r)
    return out


def is_flagged(row: DocsAiCheck | None, now: datetime | None = None) -> bool:
    """Whether the page counts as possibly out of date for people (banner, Docs health, digest)."""
    if row is None or row.state != "stale" or hidden_by_still_correct(row, now):
        return False
    return bool(visible_reasons(row, now))


def describe(row: DocsAiCheck | None, page: DocsPage) -> dict[str, Any]:
    """The banner data of a page."""
    if row is None:
        return {
            "page_id": page.id,
            "state": "unchecked",
            "stale": False,
            "reasons": [],
            "hidden": 0,
            "checked_at": None,
            "based_on_version": 0,
            "current_version": page.version,
            "ok_until": None,
        }
    reasons = visible_reasons(row)
    return {
        "page_id": page.id,
        "state": row.state,
        "stale": is_flagged(row),
        "reasons": reasons if not hidden_by_still_correct(row) else [],
        "hidden": len(loads(row.reasons, [])) - len(reasons),
        "checked_at": row.checked_at,
        "based_on_version": row.based_on_version,
        "current_version": page.version,
        "ok_until": row.ok_until if hidden_by_still_correct(row) else None,
    }


async def get_check(session: AsyncSession, page_id: str) -> DocsAiCheck | None:
    """The stored check of a page."""
    return await session.get(DocsAiCheck, page_id)


async def still_correct(session: AsyncSession, page_id: str, by: str) -> DocsAiCheck:
    """ "Still correct": hide the banner for 30 days; it comes back only when the dependencies change."""
    row = await session.get(DocsAiCheck, page_id)
    if row is None:
        raise DocsAiError("not_found", "This page has not been checked yet.")
    row.ok_until = (_now() + timedelta(days=STILL_CORRECT_DAYS)).isoformat()
    row.ok_hash = row.deps_hash
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def dismiss(
    session: AsyncSession, page_id: str, key: str, level: str, by: str
) -> DocsAiCheck:
    """Dismiss a reason: `once` (until what the page depends on changes), `30d`, or `never` for this kind of reason
    on this page. Remembered per page."""
    if level not in LEVELS:
        raise DocsAiError("invalid", "Dismiss this time, for 30 days or never.")
    row = await session.get(DocsAiCheck, page_id)
    if row is None:
        raise DocsAiError("not_found", "This page has not been checked yet.")
    key = (key or "").strip()
    if not key:
        raise DocsAiError("invalid", "Which reason?")
    if level == "never":
        key = key.split(":")[0]  # never for this kind of reason
    entries = [
        e
        for e in loads(row.dismissed, [])
        if isinstance(e, dict)
        and e.get("key") != key
        and not (level == "never" and str(e.get("key", "")).startswith(key + ":"))
    ]
    entries.append(
        {
            "key": key,
            "level": level,
            "until": (_now() + timedelta(days=30)).isoformat()
            if level == "30d"
            else None,
            "hash": row.deps_hash,
            "by": by,
        }
    )
    row.dismissed = json.dumps(entries)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


@jobs.handler("freshness")
async def freshness_handler(job: DocsAiJob) -> dict[str, Any]:
    """The on-demand check (the page AI menu's "Check if up to date")."""
    token = activity.set_actor(job.started_by)
    try:
        async with database.async_session() as session:
            row = await check_page(
                session, job.page_id or "", job.started_by, force=False, job_id=job.id
            )
            page = await session.get(DocsPage, row.page_id)
            return {
                "check": describe(row, page) if page else {},
                "reasons": len(visible_reasons(row)),
            }
    finally:
        activity.reset_actor(token)


async def start_check(session: AsyncSession, page_id: str, by: str) -> DocsAiJob:
    """On demand: the page must be readable by AI and the person able to edit it."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    await svc_settings.require_enabled(session, page.project_id)
    if not await access.ai_can_read(session, page):
        raise DocsAiError("hidden", "This page is hidden from AI.")
    if not page.version:
        raise DocsAiError(
            "invalid", "Publish this page first: AI checks the published text."
        )
    await engine.resolve(page.project_id)
    return await jobs.start(
        session,
        project_id=page.project_id,
        kind="freshness",
        started_by=by,
        page_id=page.id,
        instruction=f"Check {page.title}"[:200],
    )


# ---------------------------------------------------------------------------
# Suggested edits: one proposal
# ---------------------------------------------------------------------------


def _suggest_prompt(
    page: DocsPage, text: str, reasons: list[dict[str, Any]], facts: Facts
) -> str:
    parts = [
        f'Page "{page.title}" (v{page.version}):\n'
        + engine.fenced(f"page {page.title}", _clip(text, 12000)),
        "What no longer matches (checked by an earlier step):",
    ]
    for r in reasons:
        parts.append(
            f"- {r['text']} Page text: “{r.get('quote', '')}” ({r['compared']})"
        )
    for t in facts.tickets:
        label = STATUS_LABELS.get(t["status"], t["status"])
        parts.append(
            f"{t['id']} · {label}\n"
            + engine.fenced(
                f"ticket {t['id']}", f"Title: {t['title']}\n{t['description']}"
            )
        )
    parts.append(
        "Propose the smallest edits that make the page true again. Answer only with JSON: "
        '{"summary":"short","changes":[{"title":"short","reason":"Because KAN-12 is Done","section":"heading or null",'
        '"old":"text copied exactly from the page","new":"the replacement text"}]}. '
        "Only use facts above; never invent values, limits or keys. Leave out a change you cannot back."
    )
    return "\n\n".join(parts)


@jobs.handler("freshness_suggest")
async def suggest_handler(job: DocsAiJob) -> dict[str, Any]:
    """Ask for the edits that fix what a check found and record them as ONE proposal (never an edit)."""
    token = activity.set_actor(job.started_by)
    try:
        async with database.async_session() as session:
            page = await session.get(DocsPage, job.page_id or "")
            if page is None or page.deleted_at:
                raise DocsAiError("not_found", "Page not found.")
            if not await access.ai_can_read(session, page):
                raise DocsAiError("hidden", "This page is hidden from AI.")
            row = await session.get(DocsAiCheck, page.id)
            reasons = visible_reasons(row) if row else []
            if not reasons:
                raise DocsAiError(
                    "invalid", "Nothing to suggest: no reasons are open for this page."
                )
            text = await access.published_text(session, page)
            version = await svc_docs._latest_version(session, page)  # noqa: SLF001
            readable = {
                p.id for p in await access.readable_pages(session, page.project_id)
            }
            facts = await _facts(
                session, page, _when(version.created_at) if version else None, readable
            )
            who = await engine.resolve(page.project_id)
            assist_row = await assist.get(session)
            base_version = page.version
            project_id = page.project_id
        await jobs.set_reads(
            job.id,
            [{"page_id": page.id, "title": page.title, "why": "edited"}]
            + [
                {"page_id": p["id"], "title": p["title"], "why": "linked"}
                for p in facts.pages
            ],
        )
        out = await engine.call(
            project_id,
            system=engine.system_prompt(
                who,
                assist_row,
                "You propose edits to a page. They are reviewed by a person. Reply with JSON only.",
            ),
            prompt=_suggest_prompt(page, text, reasons, facts),
            who=who,
            job_id=job.id,
            person=job.started_by,
            max_tokens=2000,
            timeout=180.0,
        )
        raw = _json_of(out.text)
        items = raw.get("changes") if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            raise DocsAiError(
                "unavailable", "The AI answer could not be read. Nothing was changed."
            )
        changes: list[dict[str, Any]] = []
        for it in items[:MAX_REASONS]:
            if not isinstance(it, dict):
                continue
            old, new = str(it.get("old") or ""), str(it.get("new") or "")
            if not old or old not in text or old == new:
                continue  # the change must replace text that is really on the page
            checked = await engine.verify_refs(project_id, new)
            if checked.unknown_tickets or checked.unknown_pages:
                continue
            changes.append(
                {
                    "title": it.get("title"),
                    "reason": it.get("reason"),
                    "section": it.get("section"),
                    "old": old,
                    "new": checked.text,
                }
            )
        if not changes:
            raise DocsAiError(
                "not_covered",
                "The AI found no edit it could back with the page and the tickets.",
            )
        async with database.async_session() as session:
            p = await proposals.create_proposal(
                session,
                project_id=project_id,
                page_id=page.id,
                member_id=who.member.id,
                base_version=base_version,
                changes=changes,
                summary=str(raw.get("summary") if isinstance(raw, dict) else "")
                or "Keep the page true",
                job_id=job.id,
                on_behalf_of=job.started_by,
            )
        return {
            "proposal_id": p.id,
            "changes": len(changes),
            "cost": round(out.cost, 6),
        }
    finally:
        activity.reset_actor(token)


async def start_suggest(session: AsyncSession, page_id: str, by: str) -> DocsAiJob:
    """Start the job that turns the open reasons of a page into one proposal."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    await svc_settings.require_enabled(session, page.project_id)
    if not await access.ai_can_read(session, page):
        raise DocsAiError("hidden", "This page is hidden from AI.")
    row = await session.get(DocsAiCheck, page.id)
    if row is None or not visible_reasons(row):
        raise DocsAiError(
            "invalid", "Nothing to suggest: no reasons are open for this page."
        )
    await engine.resolve(page.project_id)
    return await jobs.start(
        session,
        project_id=page.project_id,
        kind="freshness_suggest",
        started_by=by,
        page_id=page.id,
        instruction=f"Suggest edits for {page.title}"[:200],
    )


# ---------------------------------------------------------------------------
# Daily check, Monday digest
# ---------------------------------------------------------------------------


async def _scheduled_today(session: AsyncSession, project_id: str) -> int:
    since = (_now() - timedelta(hours=24)).isoformat()
    rows = (
        await session.exec(
            select(DocsAiJob.id).where(
                DocsAiJob.project_id == project_id,
                DocsAiJob.kind == "freshness",
                DocsAiJob.started_by == "scheduler",
                col(DocsAiJob.queued_at) >= since,
            )
        )
    ).all()
    return len(rows)


async def run_project(
    project_id: str,
    *,
    by: str = "scheduler",
    cap: int = DAILY_CAP,
    pause: float | None = None,
) -> dict[str, Any]:
    """Check every page of a project whose dependencies changed, at a low rate and within a cap of model calls.

    Returns:
        `{checked, asked, deferred, stopped}`; nothing runs when Docs AI or freshness checks are off.
    """
    pause = PAUSE_SECONDS if pause is None else pause
    out: dict[str, Any] = {"checked": 0, "asked": 0, "deferred": 0, "stopped": None}
    async with database.async_session() as session:
        try:
            cfg = await svc_settings.require_enabled(session, project_id)
        except DocsAiError:
            out["stopped"] = "docs_ai_off"
            return out
        if not cfg.freshness_on:
            out["stopped"] = "freshness_off"
            return out
        pages = await access.readable_pages(session, project_id)
        used = await _scheduled_today(session, project_id) if by == "scheduler" else 0
    for page in pages:
        async with database.async_session() as session:
            before = await session.get(DocsAiCheck, page.id)
            before_job = before.job_id if before else None
            try:
                row = await check_page(
                    session, page.id, by, allow_model=used + out["asked"] < cap
                )
            except Deferred:
                out["deferred"] += 1
                continue
            except DocsAiError as exc:
                if exc.code in (
                    "paused",
                    "over_budget",
                    "no_member",
                    "rate_limited",
                    "unavailable",
                ):
                    out["stopped"] = exc.code
                    break
                continue
            except Exception:  # noqa: BLE001 - one page must not stop the others
                log.exception("Freshness check of %s failed", page.id)
                continue
        out["checked"] += 1
        if row.job_id and row.job_id != before_job:
            out["asked"] += 1
            if pause:
                await asyncio.sleep(pause)
    return out


def _local(now: datetime | None) -> datetime:
    return (now or datetime.now()).astimezone()


async def tick(now: datetime | None = None) -> int:
    """Run the daily check (and the deterministic Docs health) for every project that is due: after 06:00, once a day."""
    from . import health

    local = _local(now)
    if local.hour < START_HOUR:
        return 0
    day = local.date().isoformat()
    async with database.async_session() as session:
        pids = list((await session.exec(select(Project.id))).all())
        todo = []
        for pid in pids:
            cfg = await session.get(DocsAiSettings, pid)
            if (
                cfg is None
                or not cfg.enabled
                or not await svc_settings.master_on(session)
            ):
                continue
            if (await health.data_of(session, pid)).get("freshness_day") == day:
                continue
            todo.append(pid)
    ran = 0
    for pid in todo:
        try:
            await run_project(pid)
            async with database.async_session() as session:
                await health.run(
                    session, pid, "scheduler", check=False, freshness_day=day
                )
            ran += 1
        except Exception:  # noqa: BLE001 - one project must not stop the others
            log.exception("Docs freshness check failed for %s", pid)
    return ran


async def _loop() -> None:
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("Docs freshness tick failed")
        await asyncio.sleep(300)


def start_scheduler() -> None:
    """Start the daily check loop (called from the app lifespan)."""
    global _loop_task  # noqa: PLW0603
    if _loop_task is None or _loop_task.done():
        _loop_task = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    """Stop the loop."""
    global _loop_task  # noqa: PLW0603
    if _loop_task:
        _loop_task.cancel()
        try:
            await _loop_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _loop_task = None


def _last_digest_slot(now: datetime) -> datetime:
    """The most recent Monday 09:00 (local) at or before `now`."""
    local = now.astimezone()
    slot = local.replace(hour=DIGEST_HOUR, minute=0, second=0, microsecond=0)
    slot -= timedelta(days=(local.weekday() - DIGEST_WEEKDAY) % 7)
    if slot > local:
        slot -= timedelta(days=7)
    return slot


async def digest_lines(
    session: AsyncSession, project_id: str, now: datetime | None = None
) -> list[str]:
    """One line per page that may be out of date, once a week after Monday 09:00, for the Board health digest.

    Empty when Docs AI, freshness checks or the digest are off, or when this week's lines were already given out.
    """
    from . import health

    now = (now or datetime.now()).astimezone()
    cfg = await session.get(DocsAiSettings, project_id)
    if cfg is None or not cfg.enabled or not cfg.freshness_on or not cfg.digest_on:
        return []
    if not await svc_settings.master_on(session):
        return []
    slot = _last_digest_slot(now)
    row = await health.row_of(session, project_id)
    last = _when(row.digest_at)
    if last is not None and last.astimezone() >= slot:
        return []
    readable = {p.id: p for p in await access.readable_pages(session, project_id)}
    lines = []
    checks = (
        await session.exec(
            select(DocsAiCheck).where(DocsAiCheck.project_id == project_id)
        )
    ).all()
    for c in checks:
        page = readable.get(c.page_id)
        if page is None or not is_flagged(c, now):
            continue
        first = visible_reasons(c, now)[0]
        lines.append(f"{page.title} may be out of date: {first['text']}")
    row.digest_at = now.isoformat()
    session.add(row)
    await session.commit()
    return sorted(lines)
