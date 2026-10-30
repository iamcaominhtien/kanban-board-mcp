"""Docs health (design/screens/docs-ai-care.md, A3): one list for the whole space of pages that may no longer match
the board. Nothing here changes a page.

Out of date comes from the freshness checks. Missing docs (Done tickets no page links), Broken links (`[[links]]` and
sections that do not resolve) and Overlaps (pages with strongly similar titles or text) are found by rules on the
space's own data, with no model. Only pages an AI may read are included: a hidden page never appears. Dismissals
(this time, 30 days, never) are remembered per item in `docs_ai_health.data.dismissed`.
"""

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from rapidfuzz import fuzz
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsAiCheck, DocsAiHealth, DocsLink, DocsPage, Ticket
from services import docs as svc_docs
from services.ai.store import loads, now_iso, parse_iso

from . import access, freshness
from . import settings as svc_settings
from .errors import DocsAiError

KINDS = ("out_of_date", "missing", "broken", "overlaps")
MISSING_DAYS = 30  # Done tickets of the last 30 days
MAX_PAIR_PAGES = 200
TITLE_SIMILARITY = 92
TEXT_SIMILARITY = 0.6
MIN_WORDS = 40
_DIRECT = (
    "page",
    "manual",
    "description",
    "acceptance_criterion",
    "test_case",
    "debug_note",
)


async def row_of(session: AsyncSession, project_id: str) -> DocsAiHealth:
    """The project's health row, created on first use."""
    row = await session.get(DocsAiHealth, project_id)
    if row is None:
        row = DocsAiHealth(project_id=project_id)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


async def data_of(session: AsyncSession, project_id: str) -> dict[str, Any]:
    """The stored findings of the last run."""
    data = loads((await row_of(session, project_id)).data, {})
    return data if isinstance(data, dict) else {}


def _when(iso: str | None) -> datetime | None:
    return parse_iso(iso)


def _closed_at(t: Ticket) -> datetime | None:
    for e in reversed(loads(t.activity_log, [])):
        if (
            isinstance(e, dict)
            and e.get("field") == "status"
            and e.get("to") == t.status
        ):
            return _when(e.get("at"))
    return _when(t.updated_at)


def _ago_note(at: datetime | None) -> str:
    if at is None:
        return "Done"
    days = (datetime.now(UTC) - at).days
    return (
        "Done today" if days <= 0 else f"Done {days} day{'s' if days != 1 else ''} ago"
    )


async def _missing(
    session: AsyncSession, project_id: str, readable: set[str]
) -> list[dict[str, Any]]:
    since = datetime.now(UTC) - timedelta(days=MISSING_DAYS)
    tickets = (
        await session.exec(
            select(Ticket).where(
                Ticket.project_id == project_id, Ticket.status == "done"
            )
        )
    ).all()
    out = []
    for t in tickets:
        done_at = _closed_at(t)
        if t.parent_id or (done_at and done_at < since):
            continue
        rows = [
            r
            for r in await svc_docs.docs_for_ticket(session, t.id)
            if r["page_id"] in readable
        ]
        if any(r["origin"] in _DIRECT for r in rows):
            continue
        note = "Mentioned only in a comment." if rows else "No page links to it."
        out.append(
            {
                "ticket_id": t.id,
                "title": t.title,
                "done_at": done_at.isoformat() if done_at else None,
                "note": f"{_ago_note(done_at)}. {note}",
            }
        )
    out.sort(key=lambda r: r["done_at"] or "", reverse=True)
    return out


async def _broken(
    session: AsyncSession, project_id: str, pages: list[DocsPage]
) -> list[dict[str, Any]]:
    ids = [p.id for p in pages]
    if not ids:
        return []
    by_id = {p.id: p for p in pages}
    links = (
        await session.exec(
            select(DocsLink).where(
                DocsLink.source_page_id.in_(ids),  # type: ignore[attr-defined]
                DocsLink.target_title.is_not(None),  # type: ignore[union-attr]
            )
        )
    ).all()
    if not links:
        return []
    refs = [
        {"kind": "page", "title": lk.target_title, "anchor": lk.target_anchor}
        for lk in links
    ]
    results = await svc_docs.resolve_refs(session, project_id, refs)
    out, seen = [], set()
    for lk, res in zip(links, results):
        if res.get("status") not in ("missing", "in_bin", "section_missing"):
            continue
        ref = (
            f"[[{lk.target_title}{'#' + lk.target_anchor if lk.target_anchor else ''}]]"
        )
        if (lk.source_page_id, ref) in seen:
            continue
        seen.add((lk.source_page_id, ref))
        out.append(
            {
                "page_id": lk.source_page_id,
                "title": by_id[lk.source_page_id].title,
                "ref": ref,
                "status": res["status"],
            }
        )
    return out


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", re.sub(r"```.*?```", " ", text, flags=re.S).lower())


def _shingles(words: list[str], n: int = 4) -> set[str]:
    return {" ".join(words[i : i + n]) for i in range(max(0, len(words) - n + 1))}


async def _overlaps(
    session: AsyncSession, pages: list[DocsPage]
) -> list[dict[str, Any]]:
    pages = pages[:MAX_PAIR_PAGES]
    shingles: dict[str, set[str]] = {}
    for p in pages:
        w = _words(await access.published_text(session, p))
        if len(w) >= MIN_WORDS:
            shingles[p.id] = _shingles(w)
    out = []
    for i, a in enumerate(pages):
        for b in pages[i + 1 :]:
            why = ""
            if (
                fuzz.token_sort_ratio(a.title.casefold(), b.title.casefold())
                >= TITLE_SIMILARITY
            ):
                why = f"The titles “{a.title}” and “{b.title}” are almost the same."
            sa, sb = shingles.get(a.id), shingles.get(b.id)
            if sa and sb:
                sim = len(sa & sb) / max(1, len(sa | sb))
                if sim >= TEXT_SIMILARITY:
                    why = (
                        why + " " if why else ""
                    ) + f"{round(sim * 100)}% of the text is the same."
            if why:
                out.append(
                    {
                        "pages": [
                            {"page_id": a.id, "title": a.title},
                            {"page_id": b.id, "title": b.title},
                        ],
                        "why": why,
                    }
                )
    return out


async def run(
    session: AsyncSession,
    project_id: str,
    by: str,
    *,
    check: bool = True,
    freshness_day: str | None = None,
    cap: int = freshness.MANUAL_CAP,
) -> dict[str, Any]:
    """Recompute Missing docs, Broken links and Overlaps (no model), and, with `check`, run the freshness checks of
    pages whose dependencies changed (at most `cap` model calls). Returns what `get` returns."""
    await svc_settings.require_enabled(session, project_id)
    asked = {"checked": 0, "asked": 0, "deferred": 0, "stopped": None}
    if check:
        asked = await freshness.run_project(project_id, by=by, cap=cap, pause=0)
        session.expire_all()
    pages = await access.readable_pages(session, project_id)
    readable = {p.id for p in pages}
    row = await row_of(session, project_id)
    data = loads(row.data, {})
    data = data if isinstance(data, dict) else {}
    data.update(
        {
            "missing": await _missing(session, project_id, readable),
            "broken": await _broken(session, project_id, pages),
            "overlaps": await _overlaps(session, pages),
        }
    )
    if freshness_day:
        data["freshness_day"] = freshness_day
    row.data = json.dumps(data)
    row.checked_at = now_iso()
    session.add(row)
    await session.commit()
    out = await get(session, project_id, compute_missing=False)
    out["checks"] = asked
    return out


def _item_id(kind: str, item: dict[str, Any]) -> str:
    if kind == "missing":
        return str(item["ticket_id"])
    if kind == "broken":
        return f"{item['page_id']}|{item['ref']}"
    if kind == "overlaps":
        return ",".join(sorted(p["page_id"] for p in item["pages"]))
    return str(item["page_id"])


def _dismissed(
    entries: list[dict[str, Any]], kind: str, item_id: str, run_at: str | None
) -> bool:
    now = datetime.now(UTC)
    for e in entries:
        if e.get("kind") != kind or e.get("id") != item_id:
            continue
        level = e.get("level")
        if level == "never":
            return True
        if level == "30d":
            until = _when(e.get("until"))
            if until and until > now:
                return True
        elif e.get("run") == run_at:  # "this time": until the next run
            return True
    return False


async def _out_of_date(
    session: AsyncSession, project_id: str, pages: dict[str, DocsPage]
) -> list[dict[str, Any]]:
    checks = (
        await session.exec(
            select(DocsAiCheck).where(DocsAiCheck.project_id == project_id)
        )
    ).all()
    out = []
    for c in checks:
        page = pages.get(c.page_id)
        if page is None or not freshness.is_flagged(c):
            continue
        parent = pages.get(page.parent_id or "")
        v = await svc_docs._latest_version(session, page)  # noqa: SLF001
        out.append(
            {
                "page_id": page.id,
                "title": page.title,
                "parent": parent.title if parent else None,
                "reasons": freshness.visible_reasons(c),
                "edited_at": v.created_at if v else page.updated_at,
                "checked_at": c.checked_at,
            }
        )
    out.sort(key=lambda r: r["title"].lower())
    return out


async def get(
    session: AsyncSession, project_id: str, *, compute_missing: bool = True
) -> dict[str, Any]:
    """The Docs health lists with dismissed items and pages hidden from AI left out, and the counts.

    The first call of a project runs the deterministic part once (`compute_missing`)."""
    cfg = await svc_settings.require_enabled(session, project_id)
    row = await row_of(session, project_id)
    if compute_missing and not row.checked_at:
        return await run(session, project_id, "system", check=False)
    data = await data_of(session, project_id)
    pages = {p.id: p for p in await access.readable_pages(session, project_id)}
    entries = [e for e in data.get("dismissed", []) if isinstance(e, dict)]
    run_at = row.checked_at

    def keep(kind: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for it in items:
            if kind == "broken" and it["page_id"] not in pages:
                continue
            if kind == "overlaps" and any(
                p["page_id"] not in pages for p in it["pages"]
            ):
                continue
            if not _dismissed(entries, kind, _item_id(kind, it), run_at):
                out.append(it)
        return out

    out_of_date = [
        it
        for it in await _out_of_date(session, project_id, pages)
        if not _dismissed(entries, "out_of_date", it["page_id"], run_at)
    ]
    missing = keep("missing", data.get("missing", []))
    broken = keep("broken", data.get("broken", []))
    overlaps = keep("overlaps", data.get("overlaps", []))
    counts = {
        "out_of_date": len(out_of_date),
        "missing": len(missing),
        "broken": len(broken),
        "overlaps": len(overlaps),
    }
    counts["total"] = sum(counts.values())
    return {
        "checked_at": row.checked_at,
        "digest": {
            "on": cfg.digest_on,
            "schedule": "Monday 09:00",
            "last_sent": row.digest_at,
        },
        "out_of_date": out_of_date,
        "missing": missing,
        "broken": broken,
        "overlaps": overlaps,
        "counts": counts,
    }


async def count(session: AsyncSession, project_id: str) -> int:
    """The number beside "Docs health" in the tree (cheap: no model, nothing recomputed after the first run)."""
    return int((await get(session, project_id))["counts"]["total"])


async def dismiss(
    session: AsyncSession, project_id: str, kind: str, item_id: str, level: str, by: str
) -> dict[str, Any]:
    """Dismiss one item of a list: this time (until the next run), 30 days, or never."""
    if kind not in KINDS:
        raise DocsAiError("invalid", "Unknown kind of finding.")
    if level not in freshness.LEVELS:
        raise DocsAiError("invalid", "Dismiss this time, for 30 days or never.")
    await svc_settings.require_enabled(session, project_id)
    row = await row_of(session, project_id)
    data = loads(row.data, {})
    data = data if isinstance(data, dict) else {}
    entries = [
        e
        for e in data.get("dismissed", [])
        if isinstance(e, dict)
        and not (e.get("kind") == kind and e.get("id") == item_id)
    ]
    entries.append(
        {
            "kind": kind,
            "id": item_id,
            "level": level,
            "until": (datetime.now(UTC) + timedelta(days=30)).isoformat()
            if level == "30d"
            else None,
            "run": row.checked_at,
            "by": by,
        }
    )
    data["dismissed"] = entries
    row.data = json.dumps(data)
    session.add(row)
    await session.commit()
    return await get(session, project_id, compute_missing=False)
