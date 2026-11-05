"""Docs AI on the assistant engine (AI v2): each feature is a job whose handler runs one turn with a skill.

The job kinds and their results keep the shapes the Docs UI reads (`docs_ai_job.result`). What needs no model
(ignoring a finding, creating the reviewed ticket drafts, markers in a draft) is plain code here.
"""

import hashlib
import json
import re
import uuid
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import AiChat, AiChatMessage, DocsAiIgnore, DocsAiJob, DocsPage, Project
from services import docs as svc_docs
from services import tickets as svc_tickets
from services.ai.store import loads, now_iso
from services.docs_ai import DocsAiError, jobs
from services.docs_ai import settings as svc_settings

from . import engine, sessions
from . import settings as svc_assist
from .errors import AssistError

MAX_QUESTION = 1000
SCOPES = ("space", "page", "all")
_MARKER = re.compile(r"\[Needs input[^\]]*\]")
_UNDO: dict[str, dict[str, Any]] = {}


async def ready_or_raise(project_id: str) -> None:
    """Docs AI can answer now, or `no_member` (the UI's "nobody can answer" state)."""
    info = await engine.ready(project_id)
    if info["state"] != "ready":
        raise DocsAiError("no_member", info["message"])


async def _turn(
    job: DocsAiJob, skill: str, inputs: dict[str, Any], *, name: str | None = None, **kw
) -> engine.Turn:
    """One turn for a job: its cost goes on the job; a failed turn fails the job with the reason."""
    try:
        out = await engine.turn(
            job.project_id,
            name=name
            or (
                sessions.page_name(job.page_id)
                if job.page_id
                else sessions.board_name(job.project_id)
            ),
            skill=skill,
            inputs=inputs,
            by=job.started_by,
            feature="docs",
            **kw,
        )
    except AssistError as exc:
        raise DocsAiError(
            "no_member" if exc.code == "not_configured" else exc.code, str(exc)
        ) from exc
    await jobs.account(job.id, out)
    await jobs.update(job.id, session_id=out.session_id)
    if out.state == "cancelled":
        raise DocsAiError("cancelled", "Stopped.")
    if out.state != "finished":
        raise DocsAiError("unavailable", out.error or "The assistant could not finish.")
    return out


def _input(job: DocsAiJob) -> dict[str, Any]:
    data = loads(job.result, {})
    return data.get("input") or data.get("params") or {}


def _cost(out: engine.Turn) -> dict[str, Any]:
    return {"cost": round(out.cost, 4), "metered": False}


async def _page(page_id: str | None) -> DocsPage | None:
    if not page_id:
        return None
    async with database.async_session() as session:
        return await session.get(DocsPage, page_id)


def finding_id(kind: str, quote: str) -> str:
    """A finding's id (also the key "Ignore" stores): the same kind and quote on a page is the same finding."""
    return hashlib.sha1(f"{kind}\0{quote}".encode()).hexdigest()[:10]


# ---------------------------------------------------------------------------
# A page: summary, explain, translate, check, fix, diagram, freshness
# ---------------------------------------------------------------------------


@jobs.handler("summary")
async def summary_job(job: DocsAiJob) -> dict[str, Any]:
    """A short summary of the page."""
    out = await _turn(
        job,
        "docs-summarise",
        {"page_id": job.page_id, "markdown": _input(job).get("markdown")},
    )
    page = await _page(job.page_id)
    data = out.data()
    return {
        "text": data.get("text") or out.text,
        "title": data.get("title") or (page.title if page else ""),
        **_cost(out),
    }


@jobs.handler("explain")
async def explain_job(job: DocsAiJob) -> dict[str, Any]:
    """Explain a selection of the page."""
    inp = _input(job)
    out = await _turn(
        job,
        "docs-explain",
        {
            "page_id": job.page_id,
            "selection": inp.get("selection"),
            "section": inp.get("section"),
        },
    )
    page = await _page(job.page_id)
    return {
        "text": out.data().get("text") or out.text,
        "from": page.title if page else "",
        "section": inp.get("section"),
        **_cost(out),
    }


@jobs.handler("translate")
async def translate_job(job: DocsAiJob) -> dict[str, Any]:
    """The page (or a section) translated, as a view."""
    inp = _input(job)
    out = await _turn(
        job,
        "docs-translate",
        {
            "page_id": job.page_id,
            "language": inp.get("language"),
            "section": inp.get("section"),
        },
    )
    data = out.data()
    return {
        "markdown": data.get("markdown") or out.text,
        "language": data.get("language") or inp.get("language"),
        "kept_original_blocks": 0,
        **_cost(out),
    }


async def ignored_keys(session: AsyncSession, page_id: str) -> set[str]:
    """The findings people chose to hide on a page."""
    rows = (
        await session.exec(select(DocsAiIgnore).where(DocsAiIgnore.page_id == page_id))
    ).all()
    return {r.key for r in rows}


async def ignore(session: AsyncSession, page_id: str, key: str, by: str) -> None:
    """Hide a finding on a page: later checks skip it."""
    key = (key or "").strip()
    if not key:
        raise DocsAiError("invalid", "Which finding?")
    if await session.get(DocsAiIgnore, (page_id, key)) is None:
        session.add(DocsAiIgnore(page_id=page_id, key=key, by=by, at=now_iso()))
        await session.commit()


@jobs.handler("check")
async def check_job(job: DocsAiJob) -> dict[str, Any]:
    """Check a page against the style guide page; hidden findings are left out."""
    async with database.async_session() as session:
        settings = await svc_settings.get(session, job.project_id)
        skip = await ignored_keys(session, job.page_id)
    out = await _turn(
        job,
        "docs-check",
        {
            "page_id": job.page_id,
            "markdown": _input(job).get("markdown"),
            "style_page_id": settings.style_page_id,
        },
    )
    findings, ignored = [], 0
    for item in out.data().get("findings") or []:
        if (
            not isinstance(item, dict)
            or not item.get("quote")
            or not item.get("message")
        ):
            continue
        kind = str(item.get("kind") or "unclear")
        fid = finding_id(kind, str(item["quote"]))
        if fid in skip:
            ignored += 1
            continue
        findings.append(
            {
                "id": fid,
                "kind": kind,
                "quote": str(item["quote"])[:400],
                "section": item.get("section"),
                "message": str(item["message"])[:600],
                "suggestion": item.get("suggestion"),
            }
        )
    return {
        "findings": findings,
        "ignored": ignored,
        "style_page": settings.style_page_id,
        **_cost(out),
    }


async def find_finding(
    session: AsyncSession,
    project_id: str,
    page_id: str,
    finding_id_: str,
    job_id: str | None,
) -> dict:
    """A finding of the latest check of the page (or of `job_id`)."""
    stmt = select(DocsAiJob).where(
        DocsAiJob.page_id == page_id,
        DocsAiJob.kind == "check",
        DocsAiJob.state == "finished",
    )
    if job_id:
        stmt = stmt.where(DocsAiJob.id == job_id)
    for row in (
        await session.exec(stmt.order_by(col(DocsAiJob.queued_at).desc()).limit(5))
    ).all():
        for f in loads(row.result, {}).get("findings") or []:
            if f.get("id") == finding_id_:
                return f
    raise DocsAiError("not_found", "That finding is gone. Check the page again.")


@jobs.handler("check_fix")
async def check_fix_job(job: DocsAiJob) -> dict[str, Any]:
    """The replacement text for one finding."""
    inp = _input(job)
    out = await _turn(
        job,
        "docs-fix",
        {
            "page_id": job.page_id,
            "finding": inp.get("finding"),
            "markdown": inp.get("markdown"),
        },
    )
    data = out.data()
    if not data.get("old") or data.get("new") is None:
        raise DocsAiError("invalid_output", "The assistant did not give a usable fix.")
    return {"old": data["old"], "new": data["new"], **_cost(out)}


@jobs.handler("diagram")
async def diagram_job(job: DocsAiJob) -> dict[str, Any]:
    """Draw (or change) a draw.io diagram for the page."""
    inp = _input(job)
    out = await _turn(
        job,
        "docs-diagram",
        {
            "page_id": job.page_id,
            **{
                k: inp.get(k)
                for k in ("selection", "request", "diagram_id", "label", "markdown")
            },
        },
    )
    data = out.data()
    if not data.get("diagram_id"):
        raise DocsAiError("invalid_output", "The assistant did not make a diagram.")
    return {
        "diagram_id": data["diagram_id"],
        "label": data.get("label") or inp.get("label") or "Diagram",
        "markdown": data.get("markdown")
        or f"[{data.get('label') or 'Diagram'}](diagram:{data['diagram_id']})",
        "changed": bool(data.get("changed", True)),
        "version": None,
        **_cost(out),
    }


@jobs.handler("freshness")
async def freshness_job(job: DocsAiJob) -> dict[str, Any]:
    """Whether the page still matches the tickets and the code it talks about."""
    out = await _turn(job, "docs-freshness", {"page_id": job.page_id})
    data = out.data()
    reasons = [
        {
            "key": finding_id("stale", str(r.get("quote") or r.get("why") or i)),
            "quote": r.get("quote"),
            "source": r.get("source"),
            "text": r.get("why") or "",
        }
        for i, r in enumerate(data.get("reasons") or [])
        if isinstance(r, dict)
    ]
    return {
        "state": "stale" if (data.get("state") == "stale" and reasons) else "ok",
        "reasons": reasons,
        **_cost(out),
    }


async def freshness_of(session: AsyncSession, page: DocsPage) -> dict[str, Any]:
    """The page's freshness as its banner reads it: the latest finished check."""
    row = (
        await session.exec(
            select(DocsAiJob)
            .where(
                DocsAiJob.page_id == page.id,
                DocsAiJob.kind == "freshness",
                DocsAiJob.state == "finished",
            )
            .order_by(col(DocsAiJob.queued_at).desc())
            .limit(1)
        )
    ).first()
    result = loads(row.result, {}) if row else {}
    dismissed = set(result.get("dismissed") or [])
    reasons = [r for r in result.get("reasons") or [] if r.get("key") not in dismissed]
    still = bool(result.get("still_correct"))
    state = "unchecked" if row is None else ("stale" if reasons and not still else "ok")
    return {
        "page_id": page.id,
        "state": state,
        "stale": state == "stale",
        "reasons": reasons,
        "hidden": len(dismissed),
        "checked_at": row.ended_at if row else None,
        "based_on_version": page.version,
        "current_version": page.version,
        "ok_until": None,
    }


async def freshness_mark(
    session: AsyncSession,
    page: DocsPage,
    *,
    still_correct: bool = False,
    dismiss: str | None = None,
) -> dict[str, Any]:
    """Mark the latest freshness check: still correct, or hide one reason."""
    row = (
        await session.exec(
            select(DocsAiJob)
            .where(
                DocsAiJob.page_id == page.id,
                DocsAiJob.kind == "freshness",
                DocsAiJob.state == "finished",
            )
            .order_by(col(DocsAiJob.queued_at).desc())
            .limit(1)
        )
    ).first()
    if row is not None:
        result = loads(row.result, {})
        if still_correct:
            result["still_correct"] = True
        if dismiss:
            result["dismissed"] = sorted({*(result.get("dismissed") or []), dismiss})
        row.result = json.dumps(result)
        session.add(row)
        await session.commit()
    return await freshness_of(session, page)


# ---------------------------------------------------------------------------
# Ask the docs
# ---------------------------------------------------------------------------


@jobs.handler("ask")
async def ask_job(job: DocsAiJob) -> dict[str, Any]:
    """Answer a question from the docs, with the pages it used."""
    params = loads(job.result, {})
    scope = params.get("scope") or "space"
    out = await _turn(
        job,
        "docs-ask",
        {
            "project_id": job.project_id,
            "question": params.get("question") or job.instruction,
            "scope": scope,
            "page_id": params.get("page_id"),
        },
        name=sessions.page_name(job.page_id)
        if (scope == "page" and job.page_id)
        else f"docs-ask:{job.project_id}",
    )
    data = out.data()
    citations = [
        {
            "n": i + 1,
            "page_id": c.get("page_id"),
            "title": c.get("title") or "",
            "section": c.get("section"),
        }
        for i, c in enumerate(data.get("citations") or [])
        if isinstance(c, dict)
    ]
    verdict = (
        data.get("verdict")
        if data.get("verdict") in ("answered", "not_covered", "conflict")
        else "answered"
    )
    return {
        "answer": data.get("answer") or out.text,
        "verdict": verdict,
        "citations": citations,
        "closest": [],
        "conflicts": [],
        "pages_read": int(data.get("pages_read") or len(citations)),
        "pages_cited": len({c["page_id"] for c in citations if c.get("page_id")}),
        "index_updated_at": None,
        "too_long": None,
        "asked_model": True,
        **_cost(out),
    }


async def open_as_chat(session: AsyncSession, job_id: str, by: str) -> str:
    """A Board AI chat holding a finished question and its answer."""
    job = await jobs.get(session, job_id)
    result = loads(job.result, {})
    chat = AiChat(
        id=str(uuid.uuid4()),
        project_id=job.project_id,
        owner=by,
        title=(result.get("question") or job.instruction or "Ask the docs")[:80],
        scope="doc" if job.page_id else "project",
        scope_id=job.page_id,
        doc_id=job.page_id,
        created_at=now_iso(),
        updated_at=now_iso(),
    )
    session.add(chat)
    session.add(
        AiChatMessage(
            id=str(uuid.uuid4()),
            chat_id=chat.id,
            role="user",
            text=result.get("question") or job.instruction,
            state="done",
            created_at=now_iso(),
            finished_at=now_iso(),
        )
    )
    session.add(
        AiChatMessage(
            id=str(uuid.uuid4()),
            chat_id=chat.id,
            role="ai",
            text=result.get("answer") or "",
            state="done",
            created_at=now_iso(),
            finished_at=now_iso(),
        )
    )
    await session.commit()
    return chat.id


async def feedback(
    session: AsyncSession, job_id: str, by: str, rating: str, reason: str
) -> dict[str, Any]:
    """Keep the asker's thumbs up or down on an answer."""
    if rating not in ("up", "down"):
        raise DocsAiError("invalid", "Thumbs up or down.")
    job = await jobs.get(session, job_id)
    result = loads(job.result, {})
    result["feedback"] = {
        "rating": rating,
        "reason": (reason or "")[:500],
        "by": by,
        "at": now_iso(),
    }
    job.result = json.dumps(result)
    session.add(job)
    await session.commit()
    return jobs.to_dict(job)


# ---------------------------------------------------------------------------
# Write a page, history helpers
# ---------------------------------------------------------------------------


def normalize_write(params: dict[str, Any]) -> dict[str, Any]:
    """Check the Write dialog's values; returns them with defaults filled in."""
    source = params.get("source") or {}
    kind = source.get("kind")
    if kind not in ("ticket", "idea", "notes", "prompt"):
        raise DocsAiError("invalid", "Write from a ticket, an idea, notes or a prompt.")
    if kind in ("notes", "prompt") and not (source.get("text") or "").strip():
        raise DocsAiError("invalid", "Paste the notes or write what the page is about.")
    if kind == "ticket" and not source.get("ticket_id"):
        raise DocsAiError("invalid", "Pick a ticket.")
    if kind == "idea" and not source.get("idea_id"):
        raise DocsAiError("invalid", "Pick an idea.")
    return {
        "source": {k: source.get(k) for k in ("kind", "ticket_id", "idea_id", "text")},
        "page_kind": params.get("page_kind") or "notes",
        "include": params.get("include")
        or {"comments": True, "linked_pages": True, "code_changes": False},
        "title": (params.get("title") or "").strip() or None,
        "parent_id": params.get("parent_id"),
    }


async def write_preview(
    session: AsyncSession, project_id: str, params: dict[str, Any]
) -> dict[str, Any]:
    """ "What will be sent": the assistant reads through the board's tools, so this lists the sources it starts from."""
    p = normalize_write(params)
    src = p["source"]
    items = [
        {
            "kind": src["kind"],
            "label": src.get("ticket_id") or src.get("idea_id") or "Your text",
        }
    ]
    if p["include"].get("linked_pages"):
        items.append(
            {
                "kind": "pages",
                "label": "Pages it links and two or three pages of this space, for the voice",
            }
        )
    if p["include"].get("comments") and src["kind"] == "ticket":
        items.append({"kind": "comments", "label": "The ticket's comments"})
    return {"items": items, "tokens": None, "cost": None, "left_out": []}


async def start_write(
    session: AsyncSession, project_id: str, params: dict[str, Any], by: str
) -> DocsAiJob:
    """Start writing a page from the picked sources (a `write` job)."""
    await svc_settings.require_enabled(session, project_id)
    p = normalize_write(params)
    await ready_or_raise(project_id)
    return await jobs.start(
        session,
        project_id=project_id,
        kind="write",
        started_by=by,
        instruction=f"Write a {p['page_kind']} from {p['source']['kind']}"[:200],
        result={"params": p},
    )


@jobs.handler("write")
async def write_job(job: DocsAiJob) -> dict[str, Any]:
    """Write the page: the assistant creates it as a draft and names what is missing."""
    p = _input(job)
    out = await _turn(
        job,
        "docs-write",
        {"project_id": job.project_id, **p},
        name=f"docs-write:{job.id}",
    )
    data = out.data()
    if not data.get("page_id"):
        raise DocsAiError("invalid_output", "The assistant did not create the page.")
    await jobs.update(job.id, page_id=data["page_id"])
    return {
        "page_id": data["page_id"],
        "title": data.get("title"),
        "gaps": data.get("gaps") or [],
        "sources": [p.get("source")],
        **_cost(out),
    }


async def markers_of(session: AsyncSession, page_id: str) -> dict[str, Any]:
    """The Needs input markers still in the page's text."""
    detail = await svc_docs.page_detail(session, page_id)
    text = (
        (detail.get("draft") or {}).get("markdown")
        if isinstance(detail.get("draft"), dict)
        else None
    )
    text = text or detail.get("markdown") or ""
    found = _MARKER.findall(text)
    return {"markers": found, "count": len(found)}


@jobs.handler("history_summary")
async def history_summary_job(job: DocsAiJob) -> dict[str, Any]:
    """What changed between two versions of the page."""
    inp = _input(job)
    out = await _turn(
        job, "docs-history", {"task": "history_summary", "page_id": job.page_id, **inp}
    )
    return {"summary": out.data().get("summary") or out.text, **inp, **_cost(out)}


@jobs.handler("publish_note")
async def publish_note_job(job: DocsAiJob) -> dict[str, Any]:
    """A change note for the draft about to be published."""
    out = await _turn(
        job,
        "docs-history",
        {
            "task": "publish_note",
            "page_id": job.page_id,
            "markdown": _input(job).get("markdown"),
        },
    )
    return {"note": (out.data().get("note") or out.text).strip()[:200], **_cost(out)}


@jobs.handler("since_viewed")
async def since_viewed_job(job: DocsAiJob) -> dict[str, Any]:
    """What changed in the space since the person last looked, one line per page."""
    out = await _turn(
        job,
        "docs-history",
        {"task": "since_viewed", "project_id": job.project_id},
        name=f"docs-ask:{job.project_id}",
    )
    return {"lines": out.data().get("lines") or [], **_cost(out)}


# ---------------------------------------------------------------------------
# From a page to tickets
# ---------------------------------------------------------------------------


@jobs.handler("tickets_draft")
async def tickets_draft_job(job: DocsAiJob) -> dict[str, Any]:
    """Ticket drafts from the open items of a page; nothing is created."""
    out = await _turn(
        job,
        "docs-tickets",
        {"page_id": job.page_id, "selection": _input(job).get("selection")},
    )
    data = out.data()
    drafts = [
        {
            "title": str(d.get("title") or "")[:200],
            "text": d.get("text") or "",
            "type": d.get("type") or "task",
            "line": d.get("line"),
        }
        for d in data.get("drafts") or []
        if isinstance(d, dict) and d.get("title")
    ]
    return {"drafts": drafts, "skipped": data.get("skipped") or [], **_cost(out)}


async def create_tickets(
    session: AsyncSession,
    page_id: str,
    by: str,
    drafts: list[dict[str, Any]],
    *,
    link: bool = True,
) -> dict[str, Any]:
    """Create the reviewed drafts as tickets and link them to the page. No model."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    made = []
    for d in drafts:
        title = (d.get("title") or "").strip()
        if not title:
            continue
        project_id = d.get("project_id") or page.project_id
        if await session.get(Project, project_id) is None:
            raise DocsAiError("invalid", "That project does not exist.")
        ticket = await svc_tickets.create_ticket(
            session,
            project_id,
            title,
            type=d.get("type") or "task",
            status=d.get("column") or "backlog",
            description=d.get("text") or "",
            due_date=d.get("due_date"),
            assignee=d.get("assignee_id"),
            created_by=by,
        )
        made.append({"id": ticket.id, "title": ticket.title, "project_id": project_id})
        if link:
            try:
                await svc_docs.link_ticket_doc(session, ticket.id, page.id)
            except Exception:  # noqa: BLE001 - a link that fails does not undo the ticket
                pass
    token = uuid.uuid4().hex
    _UNDO[token] = {"tickets": [t["id"] for t in made], "by": by}
    return {
        "tickets": made,
        "undo_token": token,
        "replaced": False,
        "linked": bool(link and made),
    }


async def undo_tickets(session: AsyncSession, token: str, by: str) -> dict[str, Any]:
    """Delete the tickets a creation made."""
    entry = _UNDO.pop(token, None)
    if entry is None:
        raise DocsAiError("not_found", "Nothing to undo: that creation is too old.")
    removed = []
    for tid in entry["tickets"]:
        if await svc_tickets.delete_ticket(session, tid):
            removed.append(tid)
    return {"removed": removed, "restored_text": False}


# ---------------------------------------------------------------------------
# Comment threads
# ---------------------------------------------------------------------------


async def _thread_inputs(thread_id: str) -> tuple[DocsPage, dict[str, Any]]:
    from services import docs_comments

    async with database.async_session() as session:
        thread = await docs_comments.get_thread(session, thread_id)
        page = await session.get(DocsPage, thread["page_id"])
    comments = [
        {"author": c.get("author"), "body": c.get("body")}
        for c in thread.get("comments") or []
    ]
    return page, {
        "page_id": page.id,
        "thread_id": thread_id,
        "quote": thread.get("anchor_quote")
        or (thread.get("anchor") or {}).get("quote"),
        "comments": comments,
    }


@jobs.handler("thread_summary")
async def thread_summary_job(job: DocsAiJob) -> dict[str, Any]:
    """The summary of a long comment thread."""
    _page_row, inputs = await _thread_inputs(job.thread_id)
    out = await _turn(
        job,
        "docs-thread",
        {"task": "summary", **inputs},
        schema={
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
        },
    )
    return {
        "summary": out.data().get("summary") or out.data().get("reply") or out.text,
        **_cost(out),
    }


@jobs.handler("thread_reply")
async def thread_reply_job(job: DocsAiJob) -> dict[str, Any]:
    """An @mention of the AI in a thread: the assistant answers in the thread."""
    from services import activity, docs_comments

    _page_row, inputs = await _thread_inputs(job.thread_id)
    out = await _turn(job, "docs-thread", {"task": "reply", **inputs})
    data = out.data()
    reply = (data.get("reply") or out.text or "").strip()
    comment_id = None
    if reply and not data.get("posted"):
        async with database.async_session() as session:
            team, _profile = await svc_assist.first_team(session, job.project_id)
        token = activity.set_actor(team.name if team else activity.AGENT_ACTOR)
        try:
            async with database.async_session() as session:
                thread = await docs_comments.add_reply(
                    session,
                    job.thread_id,
                    reply,
                    ai={"job_id": job.id, "member": "Docs AI"},
                )
                comment_id = (thread.get("comments") or [{}])[-1].get("id")
        finally:
            activity.reset_actor(token)
    if comment_id:
        await jobs.update(job.id, reply_comment_id=comment_id)
    return {"reply": reply, "posted": True, **_cost(out)}


async def start_thread_job(
    session: AsyncSession, thread_id: str, kind: str, by: str, instruction: str = ""
) -> DocsAiJob:
    """Start an assistant job on a comment thread."""
    from services import docs_comments

    thread = await docs_comments.get_thread(session, thread_id)
    page = await svc_docs.get_page(session, thread["page_id"])
    await svc_settings.require_enabled(session, page.project_id)
    await ready_or_raise(page.project_id)
    return await jobs.start(
        session,
        project_id=page.project_id,
        kind=kind,
        started_by=by,
        page_id=page.id,
        thread_id=thread_id,
        instruction=instruction[:300],
    )


# ---------------------------------------------------------------------------
# @mentions of an AI member in a thread, and what the comments list shows of the assistant
# ---------------------------------------------------------------------------

THREAD_KINDS = ("thread_reply", "thread_summary")


async def docs_ai_on(session: AsyncSession, project_id: str) -> bool:
    """Whether Docs AI is on for the project."""
    try:
        await svc_settings.require_enabled(session, project_id)
    except DocsAiError:
        return False
    return True


async def member_rows(
    session: AsyncSession, project_id: str, members: list, docs_ai: bool
) -> list[dict[str, Any]]:
    """Members for the comments payload; AI members carry `ai` (their status for the @ picker) while Docs AI is on."""
    from models import AiTeam

    rows = []
    for m in members:
        row = {
            "id": m.id,
            "name": m.name,
            "color": m.color,
            "role": m.role,
            "kind": m.kind or "human",
        }
        if m.kind == "ai" and docs_ai:
            team = await session.get(AiTeam, m.id)
            status = (
                "unavailable"
                if team is None
                else ("paused" if team.paused else "ready")
            )
            row["ai"] = {
                "status": status,
                "usable": status == "ready",
                "note": {"paused": "Paused", "unavailable": "Not set up"}.get(
                    status, ""
                ),
                "provider": "claude-code",
            }
        rows.append(row)
    return rows


async def annotate(
    session: AsyncSession, page: DocsPage, threads: list[dict[str, Any]]
) -> bool:
    """Add `ai_jobs` (assistant work going on in the thread) and `ai_summary` (the latest summary) to serialized
    threads. Returns whether Docs AI is on."""
    for t in threads:
        t["ai_jobs"] = []
        t["ai_summary"] = None
    if not await docs_ai_on(session, page.project_id):
        return False
    if not threads:
        return True
    rows = (
        await session.exec(
            select(DocsAiJob)
            .where(
                col(DocsAiJob.thread_id).in_([t["id"] for t in threads]),
                col(DocsAiJob.kind).in_(list(THREAD_KINDS)),
            )
            .order_by(col(DocsAiJob.queued_at))
        )
    ).all()
    by_id = {t["id"]: t for t in threads}
    for j in rows:
        t = by_id.get(j.thread_id or "")
        if t is None:
            continue
        if j.state in jobs.ACTIVE:
            steps = loads(j.steps, [])
            t["ai_jobs"].append(
                {
                    "id": j.id,
                    "kind": j.kind,
                    "state": j.state,
                    "member_id": j.member_id,
                    "member_name": "Docs AI",
                    "step": steps[-1]["text"] if steps else None,
                }
            )
        elif j.kind == "thread_summary" and j.state == "finished":
            res = loads(j.result, {})
            if res.get("summary"):
                t["ai_summary"] = {
                    "text": res["summary"],
                    "count": res.get("count", 0),
                    "cost": round(j.cost_usd, 6),
                    "job_id": j.id,
                    "member_name": "Docs AI",
                    "at": j.ended_at,
                }
    return True


async def deliver(
    session: AsyncSession, *, thread: dict[str, Any], by: str, intent: str = "ask"
) -> list[dict[str, Any]]:
    """The AI members mentioned in the comment just saved: the page's assistant answers in the thread (one
    `thread_reply` job). A comment an AI wrote is never delivered (no loops).

    Returns:
        `[{member_id, result: "job"|"notified"|"not_delivered", job_id?, reason?}]`; empty without an AI mention.
    """
    from services import docs_access

    comment = (thread.get("comments") or [{}])[-1]
    if not comment or comment.get("ai"):
        return []
    page = await session.get(DocsPage, thread["page_id"])
    if page is None:
        return []
    members = await docs_access.members_of(session, page.project_id)
    ai_ids = {m.id for m in members if m.kind == "ai"}
    if (comment.get("author") or "").casefold() in {
        m.name.casefold() for m in members if m.kind == "ai"
    }:
        return []
    mentioned = [
        m["id"] for m in comment.get("mentions") or [] if m.get("id") in ai_ids
    ]
    if not mentioned:
        return []
    if not await docs_ai_on(session, page.project_id):
        return [
            {
                "member_id": m,
                "result": "not_delivered",
                "reason": "Docs AI is off: the mention only notifies.",
            }
            for m in mentioned
        ]
    if intent == "notify":
        return [{"member_id": m, "result": "notified"} for m in mentioned]
    info = await engine.ready(page.project_id)
    if info["state"] != "ready":
        return [
            {"member_id": m, "result": "not_delivered", "reason": info["message"]}
            for m in mentioned
        ]
    job = await jobs.start(
        session,
        project_id=page.project_id,
        kind="thread_reply",
        started_by=by,
        page_id=page.id,
        thread_id=thread["id"],
        comment_id=comment.get("id"),
        member_id=mentioned[0],
        instruction=(comment.get("body") or "")[:300],
    )
    return [{"member_id": mentioned[0], "result": "job", "job_id": job.id}] + [
        {"member_id": m, "result": "notified"} for m in mentioned[1:]
    ]
