"""History and publishing helpers (design/screens/docs-ai-care.md, D): a plain-language summary of a range of
versions, a suggested change note for the draft being published and a digest of what changed since a person last
viewed. They read only what an AI may read (a page hidden from AI is never summarised) and change nothing.
"""

import re
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import DocsDraft, DocsPage, DocsPageSeen, DocsVersion
from services import activity
from services import docs as svc_docs
from services.ai.assist import settings as assist
from services.ai.store import loads

from . import access, engine, jobs
from . import settings as svc_settings
from .errors import DocsAiError

MAX_DIFF_CHARS = 6000
MAX_DIGEST_PAGES = 8
NEW_PAGE_DAYS = 14


def _diff_text(old: str, new: str, limit: int = MAX_DIFF_CHARS) -> str:
    """The changed lines as `+ added` / `- removed` (a few lines of context are not needed to name a change)."""
    d = svc_docs.diff_markdown(old, new)
    lines = [
        ("+ " if r["type"] == "add" else "- ") + r["text"]
        for r in d["rows"]
        if r["type"] != "same" and r["text"].strip()
    ]
    text = "\n".join(lines)
    return text if len(text) <= limit else text[:limit] + "\n…"


async def _versions(session: AsyncSession, page_id: str) -> list[DocsVersion]:
    return list(
        (
            await session.exec(
                select(DocsVersion)
                .where(DocsVersion.page_id == page_id)
                .order_by(col(DocsVersion.version))
            )
        ).all()
    )


async def _require_readable(session: AsyncSession, page: DocsPage) -> None:
    if not await access.ai_can_read(session, page):
        raise DocsAiError(
            "hidden", "This page is hidden from AI, so it cannot be summarised."
        )


async def _system(project_id: str, extra: str) -> tuple[engine.Resolved, str]:
    who = await engine.resolve(project_id)
    async with database.async_session() as session:
        row = await assist.get(session)
    return who, engine.system_prompt(who, row, extra)


# ---------------------------------------------------------------------------
# What changed since version N
# ---------------------------------------------------------------------------


async def start_history_summary(
    session: AsyncSession, page_id: str, from_version: int, to_version: int, person: str
) -> Any:
    """Start a `history_summary` job for the versions after `from_version` up to `to_version`."""
    page = await svc_docs.get_page(session, page_id)
    await svc_settings.require_enabled(session, page.project_id)
    await _require_readable(session, page)
    if from_version < 0 or to_version <= from_version or to_version > page.version:
        raise DocsAiError(
            "invalid", "Pick two versions of this page, the earlier one first."
        )
    await engine.resolve(page.project_id)
    return await jobs.start(
        session,
        project_id=page.project_id,
        page_id=page.id,
        kind="history_summary",
        started_by=person,
        instruction=f"What changed since v{from_version}"[:200],
        result={"params": {"from_version": from_version, "to_version": to_version}},
    )


@jobs.handler("history_summary")
async def history_summary_handler(job: Any) -> dict[str, Any]:
    """ "Added the rate limit table, … 3 edits by 2 people": the AI names the changes; the counts are exact."""
    params = loads(job.result, {}).get("params") or {}
    await jobs.update(job.id, result={})
    a, b = int(params["from_version"]), int(params["to_version"])
    async with database.async_session() as session:
        page = await session.get(DocsPage, job.page_id)
        if page is None:
            raise DocsAiError("not_found", "Page not found.")
        await _require_readable(session, page)
        versions = await _versions(session, page.id)
        base = next((v for v in versions if v.version == a), None)
        span = [v for v in versions if a < v.version <= b]
        if not span:
            raise DocsAiError("not_found", "Those versions do not exist.")
        chunks, prev = [], base.markdown if base else ""
        for v in span:
            chunks.append(
                f"v{v.version} by {v.author}"
                + (f" (note: {v.note})" if v.note else "")
                + ":\n"
                + _diff_text(prev, v.markdown, MAX_DIFF_CHARS // max(1, len(span)))
            )
            prev = v.markdown
        title = page.title
    edits = len(span)
    people = len({v.author for v in span})
    await jobs.add_step(
        job.id, f"Comparing {edits} version{'s' if edits != 1 else ''} of {title}"
    )
    who, system = await _system(
        job.project_id,
        "Summarise what changed in a page between versions, in one or two plain sentences, as a list of what was "
        "added, explained, changed or removed. No preamble and no counts: the counts are added for you.",
    )
    out = await engine.call(
        job.project_id,
        system=system,
        prompt=f"Page “{title}”. Changes after v{a}, oldest first (+ added, - removed):\n\n"
        + engine.fenced(f"history of {title}", "\n\n".join(chunks)),
        who=who,
        job_id=job.id,
        person=job.started_by,
        max_tokens=400,
        timeout=90.0,
    )
    text = " ".join(out.text.split())
    checked = await engine.verify_refs(job.project_id, text)
    return {
        "summary": checked.text,
        "edits": edits,
        "people": people,
        "from_version": a,
        "to_version": b,
        "line": f"{checked.text} {edits} edit{'s' if edits != 1 else ''} by {people} {'people' if people != 1 else 'person'}.",
        "cost": round(out.cost, 6),
    }


# ---------------------------------------------------------------------------
# A suggested change note for Publish
# ---------------------------------------------------------------------------


async def start_publish_note(
    session: AsyncSession, page_id: str, markdown: str | None, person: str
) -> Any:
    """Start a `publish_note` job: a change note from the draft (or `markdown`) against the published page."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    await svc_settings.require_enabled(session, page.project_id)
    await _require_readable(session, page)
    draft = (
        await session.exec(
            select(DocsDraft).where(
                DocsDraft.page_id == page.id,
                DocsDraft.author == activity.current_actor(),
            )
        )
    ).first()
    new = markdown if markdown is not None else (draft.markdown if draft else None)
    if new is None:
        raise DocsAiError("invalid", "There is no draft to write a note for.")
    await engine.resolve(page.project_id)
    return await jobs.start(
        session,
        project_id=page.project_id,
        page_id=page.id,
        kind="publish_note",
        started_by=person,
        instruction="Suggest a change note",
        result={"params": {"markdown": new}},
    )


@jobs.handler("publish_note")
async def publish_note_handler(job: Any) -> dict[str, Any]:
    """A one-line change note from the draft-vs-published diff (the person edits it or writes their own)."""
    params = loads(job.result, {}).get("params") or {}
    await jobs.update(job.id, result={})
    new = str(params.get("markdown") or "")
    async with database.async_session() as session:
        page = await session.get(DocsPage, job.page_id)
        if page is None:
            raise DocsAiError("not_found", "Page not found.")
        await _require_readable(session, page)
        old = await access.published_text(session, page)
        title = page.title
    if old.strip() == new.strip():
        return {"note": "", "changed": False, "cost": 0}
    diff = _diff_text(old, new)
    await jobs.add_step(job.id, f"Comparing your draft with the published {title}")
    who, system = await _system(
        job.project_id,
        "Write a change note for a page: one short sentence (at most 120 characters) saying what changed, in the "
        "past tense or as a plain statement. Keep ticket keys exactly as they appear. Reply with the note only.",
    )
    out = await engine.call(
        job.project_id,
        system=system,
        prompt=f"Page “{title}”. Changes in the draft (+ added, - removed):\n\n"
        + engine.fenced(f"draft changes of {title}", diff),
        who=who,
        job_id=job.id,
        person=job.started_by,
        max_tokens=120,
        timeout=60.0,
    )
    note = " ".join(out.text.split()).strip().strip('"“”')[:200]
    checked = await engine.verify_refs(job.project_id, note)
    return {"note": checked.text, "changed": True, "cost": round(out.cost, 6)}


# ---------------------------------------------------------------------------
# Changes since you last viewed
# ---------------------------------------------------------------------------


def _how(item: dict[str, Any]) -> str:
    if item["kind"] == "new":
        return "new page"
    return "changed since v" + str(item["from_version"])


async def changed_since_viewed(
    session: AsyncSession, project_id: str, person: str
) -> list[dict[str, Any]]:
    """Pages published since `person` last viewed them (a page never viewed counts only when it is new)."""
    from datetime import UTC, datetime, timedelta

    cutoff = (datetime.now(UTC) - timedelta(days=NEW_PAGE_DAYS)).isoformat()
    seen = {
        s.page_id: s.version
        for s in (
            await session.exec(
                select(DocsPageSeen).where(DocsPageSeen.viewer == person)
            )
        ).all()
    }
    pages = (
        await session.exec(
            select(DocsPage).where(
                DocsPage.project_id == project_id,
                col(DocsPage.deleted_at).is_(None),
                DocsPage.version > 0,
            )
        )
    ).all()
    out = []
    for p in pages:
        if p.updated_by == person and p.id in seen and seen[p.id] >= p.version:
            continue
        if p.id in seen:
            if p.version > seen[p.id]:
                out.append({"page": p, "from": seen[p.id], "kind": "changed"})
        elif p.created_at >= cutoff and p.created_by != person:
            out.append({"page": p, "from": 0, "kind": "new"})
    out.sort(key=lambda r: r["page"].updated_at, reverse=True)
    return out[:MAX_DIGEST_PAGES]


async def start_since_viewed(
    session: AsyncSession, project_id: str, person: str
) -> Any:
    """Start a `since_viewed` job: one line per page changed since the caller last viewed it."""
    await svc_docs._project(session, project_id)  # noqa: SLF001 - readers only
    await svc_settings.require_enabled(session, project_id)
    await engine.resolve(project_id)
    return await jobs.start(
        session,
        project_id=project_id,
        kind="since_viewed",
        started_by=person,
        instruction="Changes since you last viewed",
    )


@jobs.handler("since_viewed")
async def since_viewed_handler(job: Any) -> dict[str, Any]:
    """Summary only ("open a page to see the diff"); pages hidden from AI are listed without a summary."""
    person = job.started_by
    async with database.async_session() as session:
        rows = await changed_since_viewed(session, job.project_id, person)
        hidden = await access.hidden_page_ids(session, job.project_id)
        items: list[dict[str, Any]] = []
        for r in rows:
            page: DocsPage = r["page"]
            item: dict[str, Any] = {
                "page_id": page.id,
                "title": page.title,
                "kind": r["kind"],
                "from_version": r["from"],
                "to_version": page.version,
                "line": None,
                "hidden": page.id in hidden,
            }
            if not item["hidden"]:
                versions = await _versions(session, page.id)
                base = next((v for v in versions if v.version == r["from"]), None)
                latest = next((v for v in versions if v.version == page.version), None)
                if latest is not None:
                    item["diff"] = _diff_text(
                        base.markdown if base else "", latest.markdown, 1500
                    )
            items.append(item)
    askable = [i for i in items if not i["hidden"] and i.get("diff") is not None]
    cost = 0.0
    if askable:
        await jobs.add_step(
            job.id,
            f"Reading {len(askable)} changed page{'s' if len(askable) != 1 else ''}",
        )
        who, system = await _system(
            job.project_id,
            "For each page, write one short line saying what changed (or, for a new page, what it is about). "
            "Reply with exactly one line per page, in the form `Title: what changed`, in the order given. No preamble.",
        )
        body = "\n\n".join(
            f"Page “{i['title']}” ({_how(i)}):\n"
            + engine.fenced(f"changes of {i['title']}", i["diff"])
            for i in askable
        )
        out = await engine.call(
            job.project_id,
            system=system,
            prompt=body,
            who=who,
            job_id=job.id,
            person=person,
            max_tokens=600,
            timeout=90.0,
        )
        cost = round(out.cost, 6)
        text = (await engine.verify_refs(job.project_id, out.text)).text
        for line in text.splitlines():
            m = re.match(r"^\W*(.+?):\s+(.+)$", line.strip())
            if not m:
                continue
            for i in askable:
                if (
                    i["line"] is None
                    and m.group(1).strip("*“” ").lower() == i["title"].lower()
                ):
                    i["line"] = m.group(2).strip()
                    break
    for i in items:
        i.pop("diff", None)
    return {"pages": items, "count": len(items), "cost": cost}
