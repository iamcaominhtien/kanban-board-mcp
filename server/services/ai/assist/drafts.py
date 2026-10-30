"""Board AI drafts: generated in the background, reviewed by a person, applied as that person with Activity saying
"suggested by <AI>", and undone from the result line (design/screens/ai-board-assistant.md, B2, B10, C, D, E, G, I).

Kinds: changes · ticket · description · split · test_cases · doc_summary · doc_section · doc_links · doc_text · editor ·
editor_doc · sketch.
"""

import asyncio
import difflib
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
import services.activity as act
import services.tickets as svc_tickets
from models import AiDraft, AiMember, DocsPage, Member, Project, Ticket, TicketUpdate

from .. import llm
from ..context import STATUS_LABELS
from ..store import loads, now_iso, parse_iso
from . import context as ctxb
from . import match, prompts, scopes
from . import settings as svc_settings
from .settings import AssistError

log = logging.getLogger(__name__)

FEATURE_OF = {
    "changes": "chat",
    "ticket": "drafting",
    "description": "drafting",
    "assignee": "drafting",
    "split": "split",
    "test_cases": "test_cases",
    "doc_summary": "docs",
    "doc_section": "docs",
    "doc_links": "docs",
    "doc_text": "docs",
    "nudge": "health",
    "editor": "drafting",
    "editor_doc": "docs",
    "sketch": "sketch",
}
TIMEOUT_S = 30.0  # I: "30 s draft timeout"
SPLIT_DAYS = 7
TASKS: dict[str, asyncio.Task] = {}


def describe(d: AiDraft) -> dict:
    """A draft for the API."""
    return {
        "id": d.id,
        "project_id": d.project_id,
        "kind": d.kind,
        "owner": d.owner,
        "member_id": d.member_id,
        "member_name": d.member_name,
        "ticket_id": d.ticket_id,
        "doc_id": d.doc_id,
        "chat_message_id": d.chat_message_id,
        "insight_id": d.insight_id,
        "status": d.status,
        "payload": loads(d.payload, {}),
        "result": loads(d.result, {}),
        "raw": d.raw if d.status in ("open", "failed") else "",
        "cost": d.cost,
        "tokens": d.tokens,
        "created_at": d.created_at,
        "expires_at": d.expires_at,
        "applied_at": d.applied_at,
        "applied_by": d.applied_by,
    }


async def _publish() -> None:
    await board_events.publish(board_events.INVALIDATE)


async def _member_id(session: AsyncSession, project_id: str, person: str) -> str | None:
    row = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.name == person)
        )
    ).first()
    return row.id if row else None


async def role_of(session: AsyncSession, project_id: str, person: str) -> str:
    """viewer | member | admin; the board's own user acts as an admin."""
    if not person or person == "user":
        return "admin"
    row = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id,
                Member.name == person,
                Member.kind == "human",
            )
        )
    ).first()
    return row.role if row else "member"


async def project_lead(session: AsyncSession, project_id: str) -> str | None:
    """The first admin of the project (who a viewer asks to apply a draft)."""
    row = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id,
                Member.kind == "human",
                Member.role == "admin",
            )
        )
    ).first()
    return row.name if row else None


async def _ticket_state(session: AsyncSession, project_id: str) -> tuple[dict, dict]:
    tickets = (
        await session.exec(select(Ticket).where(Ticket.project_id == project_id))
    ).all()
    state = {
        t.id: {
            "status": t.status,
            "priority": t.priority,
            "assignee": t.assignee,
            "due_date": t.due_date,
            "estimate": t.estimate,
            "title": t.title,
            "criteria": [
                a.get("text", "")
                for a in loads(t.acceptance_criteria, [])
                if isinstance(a, dict)
            ],
        }
        for t in tickets
    }
    members = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    names = {m.name.strip().lower(): m.id for m in members if m.kind in ("human", "ai")}
    return state, names


# ---------------------------------------------------------------------------
# Starting and generating
# ---------------------------------------------------------------------------


async def start(
    session: AsyncSession,
    *,
    project_id: str,
    kind: str,
    owner: str,
    ticket_id: str | None = None,
    doc_id: str | None = None,
    data: dict | None = None,
    payload: dict | None = None,
    chat_message_id: str | None = None,
    insight_id: str | None = None,
    member: Member | None = None,
) -> AiDraft:
    """Create a draft. With `payload` it is ready at once (built by the board, e.g. from a chat answer); otherwise the
    Board AI generates it in the background and the UI polls it."""
    if kind not in FEATURE_OF:
        raise AssistError("invalid", f"Unknown draft kind {kind}")
    info = None
    if payload is None:
        info = await svc_settings.guard_request(
            session, project_id, FEATURE_OF[kind], person=owner
        )
        member = info["member"]
    data = dict(data or {})
    base: dict = {}
    if ticket_id:
        t = await session.get(Ticket, ticket_id)
        if t is None or t.project_id != project_id:
            raise AssistError("invalid", "Ticket not found in this project.")
        base[t.id] = t.updated_at
        if kind == "split" and t.parent_id:
            raise AssistError(
                "invalid", "A sub-ticket cannot be split again (one level of nesting)."
            )
        if kind == "test_cases" and not data.get("from_description"):
            if not loads(t.acceptance_criteria, []):
                raise AssistError(
                    "no_criteria",
                    "Add acceptance criteria first. This ticket has none, so there is nothing to tie cases to.",
                )
    if doc_id:
        page = await session.get(DocsPage, doc_id)
        if page is None or page.project_id != project_id:
            raise AssistError("invalid", "Doc not found in this project.")
    if kind == "ticket" and not str(data.get("prompt") or "").strip():
        raise AssistError("invalid", "Write one sentence about the ticket first.")
    d = AiDraft(
        id=str(uuid.uuid4()),
        project_id=project_id,
        kind=kind,
        owner=owner,
        member_id=member.id if member else None,
        member_name=member.name if member else "",
        ticket_id=ticket_id,
        doc_id=doc_id,
        chat_message_id=chat_message_id,
        insight_id=insight_id,
        base=json.dumps(base),
        payload=json.dumps({"input": data, **(payload or {})}),
        status="open" if payload is not None else "pending",
        created_at=now_iso(),
        expires_at=(
            (datetime.now(UTC) + timedelta(days=SPLIT_DAYS)).isoformat()
            if kind in ("split", "changes")
            else None
        ),
    )
    session.add(d)
    await session.commit()
    await session.refresh(d)
    if payload is None:
        _spawn(d.id)
    await _publish()
    return d


def _spawn(draft_id: str, **kw) -> None:
    task = asyncio.create_task(_run(draft_id, **kw))
    TASKS[draft_id] = task
    task.add_done_callback(lambda _t: TASKS.pop(draft_id, None))


async def cancel(session: AsyncSession, draft_id: str) -> AiDraft:
    """Stop a draft that is still being written ("Cancel" on the skeleton)."""
    d = await _get(session, draft_id)
    task = TASKS.get(draft_id)
    if task:
        task.cancel()
    if d.status == "pending":
        d.status = "cancelled"
        session.add(d)
        await session.commit()
        await session.refresh(d)
    await _publish()
    return d


async def regenerate(
    session: AsyncSession,
    draft_id: str,
    *,
    feedback: str | None = None,
    field: str | None = None,
    allow_more: bool = False,
) -> AiDraft:
    """Write the draft again (Regenerate, Ask for changes, Refresh draft, Regenerate field, Continue)."""
    d = await _get(session, draft_id)
    if d.status in ("applied",):
        raise AssistError("invalid", "This draft was already applied.")
    editor_draft = d.kind in ("editor", "editor_doc", "sketch")
    await svc_settings.guard_request(
        session,
        d.project_id,
        FEATURE_OF[d.kind],
        person=d.owner,
        member_id=d.member_id if editor_draft else None,
        require_member=editor_draft,
    )
    payload = loads(d.payload, {})
    inp = dict(payload.get("input") or {})
    if editor_draft:
        inp.pop(
            "continue_from", None
        )  # Try again starts over; Continue is its own action
    if feedback:
        inp["feedback"] = feedback.strip()[:1000]
    if field:
        inp["only_field"] = field
    keep = {"input": inp}
    if field:
        keep.update({k: v for k, v in payload.items() if k != "input"})
    d.payload = json.dumps(keep)
    d.status = "pending"
    if d.ticket_id:
        t = await session.get(Ticket, d.ticket_id)
        if t:
            d.base = json.dumps({t.id: t.updated_at})
    session.add(d)
    await session.commit()
    await session.refresh(d)
    _spawn(d.id, allow_more=allow_more)
    await _publish()
    return d


async def _get(session: AsyncSession, draft_id: str) -> AiDraft:
    d = await session.get(AiDraft, draft_id)
    if d is None:
        raise AssistError("not_found", "Draft not found.")
    if d.expires_at and d.status == "open":
        exp = parse_iso(d.expires_at)
        if exp and exp < datetime.now(UTC):
            d.status = "expired"
            session.add(d)
            await session.commit()
            await session.refresh(d)
    return d


async def _run(draft_id: str, allow_more: bool = False) -> None:
    async with database.async_session() as session:
        d = await session.get(AiDraft, draft_id)
        if d is None:
            return
        profile = await session.get(AiMember, d.member_id) if d.member_id else None
        row = await svc_settings.get(session)
        project = await session.get(Project, d.project_id)
    if profile is None:
        await _fail(draft_id, "not_configured", "Board AI isn't set up.")
        return
    gen = GENERATORS[d.kind]
    try:
        payload, out, raw = await gen(d, profile, row, project, allow_more)
    except asyncio.CancelledError:
        await _fail(draft_id, "cancelled", "Stopped. Nothing was changed.")
        raise
    except llm.LlmError as exc:
        msg = {
            "timeout": f"Timed out after {int(TIMEOUT_S)} s. Your input is kept; nothing was changed.",
        }.get(exc.kind, f"{exc} Nothing was changed and nothing was charged.")
        await _fail(draft_id, exc.kind, msg, retry_after=exc.retry_after)
        return
    except AssistError as exc:
        await _fail(draft_id, exc.code, str(exc))
        return
    except Exception as exc:  # noqa: BLE001 - a draft that fails must say so
        log.exception("Board AI draft %s failed", draft_id)
        await _fail(draft_id, "error", f"Draft didn't come back: {type(exc).__name__}.")
        return
    async with database.async_session() as session:
        d = await session.get(AiDraft, draft_id)
        if d is None or d.status != "pending":
            return
        old = loads(d.payload, {})
        if (
            (old.get("input") or {}).get("only_field")
            and "fields" in old
            and "fields" in payload
        ):
            # Regenerate one field: keep the others as they were
            merged = dict(old["fields"])
            f = old["input"]["only_field"]
            if f in payload["fields"]:
                merged[f] = payload["fields"][f]
            payload["fields"] = merged
        d.payload = json.dumps({"input": old.get("input") or {}, **payload})
        d.raw = raw[:20000]
        d.status = "open"
        if out:
            d.cost = round(d.cost + out.cost, 6)
            d.tokens += out.tokens_in + out.tokens_out
        session.add(d)
        await session.commit()
        if out:
            feature = FEATURE_OF[d.kind]
            if (
                d.kind == "editor_doc"
                and (old.get("input") or {}).get("surface") == "idea"
            ):
                feature = "idea_editor"  # counts toward the Idea Space's own daily cap
            elif d.kind == "sketch":
                from . import sketch_ai

                feature = sketch_ai.usage_feature(old.get("input") or {})
            await svc_settings.record_usage(
                session, d.project_id, feature, d.member_id, d.owner, out
            )
    await _publish()


async def _fail(
    draft_id: str, code: str, message: str, retry_after: float | None = None
) -> None:
    async with database.async_session() as session:
        d = await session.get(AiDraft, draft_id)
        if d is None or d.status != "pending":
            return
        d.status = "cancelled" if code == "cancelled" else "failed"
        res = loads(d.result, {})
        res["error"] = {"code": code, "message": message, "retry_after": retry_after}
        d.result = json.dumps(res)
        session.add(d)
        await session.commit()
    await _publish()


async def _ask_json(
    profile: AiMember,
    row,
    project: Project | None,
    task: str,
    context_text: str,
    *,
    max_tokens: int,
    allow_more: bool,
):
    system = prompts.system(
        profile_name(profile),
        project.name if project else "",
        row,
        "Reply with JSON only, no prose around it.",
    )
    if not allow_more:
        max_tokens = svc_settings.max_tokens_for(row, profile, max_tokens)
    out = await llm.complete(
        profile,
        system=system,
        prompt=f"{context_text}\n\n{task}",
        max_tokens=max_tokens,
        timeout=TIMEOUT_S * (3 if profile.connection == "local" else 1),
    )
    value, complete = prompts.parse_json(out.text)
    if out.stop_reason == "max_tokens":
        complete = False
    return value, complete, out


_NAMES: dict[str, str] = {}


def profile_name(profile: AiMember) -> str:
    """Display name of the Board AI (cached per process; filled in by the callers)."""
    return _NAMES.get(profile.id, "the Board AI")


async def _remember_name(profile: AiMember) -> None:
    async with database.async_session() as session:
        m = await session.get(Member, profile.id)
        if m:
            _NAMES[profile.id] = m.name


def _partial(missing: list[str], row, profile: AiMember) -> dict:
    return {
        "missing": missing,
        "cap": row.per_request_cap,
        "continue_cost": round((row.per_request_cap or 0.25) / 4, 2),
        "metered": profile.connection == "api_key",
    }


# ---------------------------------------------------------------------------
# Generators: (draft, profile, settings row, project, allow_more) -> (payload, completion, raw text)
# ---------------------------------------------------------------------------


async def _gen_ticket(d: AiDraft, profile, row, project, allow_more):
    await _remember_name(profile)
    inp = loads(d.payload, {}).get("input") or {}
    sentence = str(inp.get("prompt") or "").strip()
    async with database.async_session() as session:
        similar = await match.similar(session, d.project_id, sentence)
        tickets = (
            await session.exec(select(Ticket).where(Ticket.project_id == d.project_id))
        ).all()
        members = (
            await session.exec(
                select(Member).where(
                    Member.project_id == d.project_id, Member.kind == "human"
                )
            )
        ).all()
        tags = sorted(
            {t for tk in tickets for t in loads(tk.tags, []) if isinstance(t, str)}
        )
        recent = sorted(tickets, key=lambda t: t.created_at or "", reverse=True)[:12]
        alike_est = [
            f"{s['id']} ({next((t.estimate for t in tickets if t.id == s['id']), None)} pt)"
            for s in similar
        ]
        assignees = await match.suggest_assignee(session, d.project_id, sentence)
    context_text = "\n".join(
        [
            f"Existing labels: {', '.join(tags) or '(none)'}",
            f"People: {', '.join(m.name for m in members) or '(none)'}",
            "Recent titles (style to follow):",
            *[f"- {t.id}: {t.title}" for t in recent],
            "Similar tickets: " + (", ".join(alike_est) or "none"),
            f"Style guide: {row.style_guide or '(none)'}",
            "The person's sentence:",
            ctxb.fence("request", sentence),
        ]
    )
    only = inp.get("only_field")
    feedback = inp.get("feedback")
    task = (
        "Draft a ticket from the sentence. JSON keys: "
        '{"title": "imperative, at most 70 characters", "title_note": "why this title, one short sentence",'
        ' "description": "Markdown with ## Summary and ## Notes", "description_note": "...",'
        ' "type": "bug|feature|task|chore", "priority": "low|medium|high|critical", "labels": ["prefer existing labels"],'
        ' "labels_note": "...", "estimate": 1|2|3|5|8|13|null, "estimate_note": "compare with similar tickets",'
        ' "criteria": ["acceptance criterion", "..."], "criteria_note": "..."}'
        + (
            f"\nOnly the field “{only}” is being redone; still return the whole object."
            if only
            else ""
        )
        + (f"\nThe person asked: {feedback}" if feedback else "")
    )
    value, complete, out = await _ask_json(
        profile,
        row,
        project,
        task,
        context_text,
        max_tokens=1600,
        allow_more=allow_more,
    )
    if not isinstance(value, dict):
        raise AssistError("invalid_output", "Draft didn't come back in a usable form.")
    fields: dict = {}
    errors: dict = {}
    if value.get("title"):
        fields["title"] = {
            "value": " ".join(str(value["title"]).split())[:300],
            "note": value.get("title_note") or "",
        }
    if value.get("description"):
        fields["description"] = {
            "value": str(value["description"]),
            "note": value.get("description_note") or "",
        }
    t = str(value.get("type") or "").lower()
    if t in prompts.TYPES:
        fields["type"] = {"value": t, "note": ""}
    elif t:
        errors["type"] = {
            "message": "Type must be bug, feature, task or chore",
            "raw": value.get("type"),
        }
    p = str(value.get("priority") or "").lower()
    if p in prompts.PRIORITIES:
        fields["priority"] = {"value": p, "note": ""}
    elif p:
        errors["priority"] = {
            "message": "Priority must be low, medium, high or critical",
            "raw": value.get("priority"),
        }
    if isinstance(value.get("labels"), list):
        labels = [
            " ".join(str(x).split())[:40] for x in value["labels"] if str(x).strip()
        ][:8]
        lower = {x.lower(): x for x in tags}
        fields["labels"] = {
            "value": [lower.get(x.lower(), x) for x in labels],
            "new": [x for x in labels if x.lower() not in lower],
            "note": value.get("labels_note") or "",
        }
    if "estimate" in value and value["estimate"] is not None:
        try:
            est = float(value["estimate"])
        except (TypeError, ValueError):
            est = None
        if est in prompts.ESTIMATES:
            fields["estimate"] = {
                "value": est,
                "note": value.get("estimate_note") or "",
            }
        else:
            errors["estimate"] = {
                "message": "Estimate must be 1, 2, 3, 5, 8 or 13",
                "raw": value["estimate"],
            }
    if isinstance(value.get("criteria"), list):
        crit = [str(c).strip()[:500] for c in value["criteria"] if str(c).strip()][:12]
        if crit:
            fields["criteria"] = {
                "value": crit,
                "note": value.get("criteria_note") or "",
            }
    payload = {
        "fields": fields,
        "errors": errors,
        "similar": similar,
        "assignee": assignees[:4],
        "reads": f"Reads {len(tags)} tag{'s' if len(tags) != 1 else ''}, {len(members)} member{'s' if len(members) != 1 else ''}, similar tickets",
        "counts": {"tags": len(tags), "members": len(members), "tickets": len(tickets)},
    }
    if not complete:
        want = [
            "title",
            "description",
            "type",
            "priority",
            "labels",
            "estimate",
            "criteria",
        ]
        payload["partial"] = _partial(
            [f for f in want if f not in fields and f not in errors], row, profile
        )
    return payload, out, out.text


async def _gen_description(d: AiDraft, profile, row, project, allow_more):
    await _remember_name(profile)
    async with database.async_session() as session:
        c = await ctxb.build(
            session,
            project_id=d.project_id,
            scope="ticket",
            person=d.owner,
            ticket_id=d.ticket_id,
        )
        t = await session.get(Ticket, d.ticket_id)
    old = t.description or ""
    inp = loads(d.payload, {}).get("input") or {}
    task = (
        "Improve this ticket's description: clearer, complete, same meaning, Markdown. Use details found in the"
        " comments. Keep lines that are fine unchanged. Do not touch acceptance criteria.\n"
        'JSON: {"description": "the full new text", "notes": ["one short note per change, in order"]}'
        + (f"\nThe person asked: {inp['feedback']}" if inp.get("feedback") else "")
    )
    value, complete, out = await _ask_json(
        profile, row, project, task, c.text, max_tokens=1800, allow_more=allow_more
    )
    if not isinstance(value, dict) or not isinstance(value.get("description"), str):
        raise AssistError("invalid_output", "Draft didn't come back in a usable form.")
    new = value["description"].strip()
    notes = [str(n) for n in value.get("notes") or [] if str(n).strip()]
    segments, hunks = diff_hunks(old, new, notes)
    payload = {
        "old": old,
        "new": new,
        "segments": segments,
        "hunks": hunks,
        "context": c.summary(),
    }
    if not complete:
        payload["partial"] = _partial(["description"], row, profile)
    return payload, out, out.text


def diff_hunks(old: str, new: str, notes: list[str]) -> tuple[list[dict], list[dict]]:
    """Line diff as segments ({keep: [lines]} or {hunk: id}) and hunks (removed, added, note)."""
    a, b = old.splitlines(), new.splitlines()
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    segments, hunks = [], []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            segments.append({"keep": a[i1:i2]})
            continue
        if not any(ln.strip() for ln in a[i1:i2] + b[j1:j2]):
            # Blank lines only: taken as written, not a change to review
            segments.append({"keep": b[j1:j2]})
            continue
        hid = f"h{len(hunks) + 1}"
        hunks.append(
            {
                "id": hid,
                "removed": a[i1:i2],
                "added": b[j1:j2],
                "note": notes[len(hunks)] if len(hunks) < len(notes) else "",
            }
        )
        segments.append({"hunk": hid})
    return segments, hunks


def compose(segments: list[dict], hunks: list[dict], accepted: set[str]) -> str:
    """The description with only the accepted hunks applied."""
    by_id = {h["id"]: h for h in hunks}
    lines: list[str] = []
    for s in segments:
        if "keep" in s:
            lines += s["keep"]
        else:
            h = by_id[s["hunk"]]
            lines += h["added"] if h["id"] in accepted else h["removed"]
    return "\n".join(lines)


async def _gen_split(d: AiDraft, profile, row, project, allow_more):
    await _remember_name(profile)
    async with database.async_session() as session:
        c = await ctxb.build(
            session,
            project_id=d.project_id,
            scope="ticket",
            person=d.owner,
            ticket_id=d.ticket_id,
        )
        t = await session.get(Ticket, d.ticket_id)
    inp = loads(d.payload, {}).get("input") or {}
    task = (
        "Split this ticket into 2 to 7 sub-tickets a person can pick up one by one, in a sensible order. "
        "Titles imperative, at most 70 characters. Estimates in 1, 2, 3, 5, 8 or 13. "
        "blocked_by lists the numbers of earlier sub-tickets that must be done first.\n"
        'JSON: {"items": [{"title": "...", "estimate": 2, "blocked_by": [1], "description": "one or two sentences"}]}'
        + (
            f"\nThe person asked for changes: {inp['feedback']}"
            if inp.get("feedback")
            else ""
        )
        + (f"\nStyle guide: {row.style_guide}" if row.style_guide else "")
    )
    value, complete, out = await _ask_json(
        profile, row, project, task, c.text, max_tokens=1600, allow_more=allow_more
    )
    items_raw = (
        value.get("items")
        if isinstance(value, dict)
        else value
        if isinstance(value, list)
        else None
    )
    if not isinstance(items_raw, list) or not items_raw:
        raise AssistError("invalid_output", "Draft didn't come back in a usable form.")
    items = []
    for i, it in enumerate(items_raw[:7], 1):
        if not isinstance(it, dict) or not str(it.get("title") or "").strip():
            continue
        try:
            est = float(it.get("estimate")) if it.get("estimate") is not None else None
        except (TypeError, ValueError):
            est = None
        items.append(
            {
                "n": i,
                "title": " ".join(str(it["title"]).split())[:300],
                "estimate": est if est in prompts.ESTIMATES else None,
                "estimate_error": None
                if est in prompts.ESTIMATES or est is None
                else "Estimate must be 1, 2, 3, 5, 8 or 13",
                "blocked_by": [],
                "_blocked_raw": it.get("blocked_by") or [],
                "description": str(it.get("description") or "").strip()[:2000],
                "selected": True,
            }
        )
    numbers = {it["n"] for it in items}
    for it in items:
        deps = []
        for x in it.pop("_blocked_raw"):
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if n in numbers and n != it["n"] and n < it["n"]:
                deps.append(n)
        it["blocked_by"] = sorted(set(deps))
    payload = {
        "parent": {"id": t.id, "title": t.title, "estimate": t.estimate},
        "items": items,
        "criteria": len(loads(t.acceptance_criteria, [])),
        "context": c.summary(),
    }
    if not complete:
        payload["partial"] = _partial(["items"], row, profile)
    return payload, out, out.text


def coverage(ticket: Ticket) -> list[dict]:
    """Each acceptance criterion with the test cases linked to it (E2)."""
    acs = loads(ticket.acceptance_criteria, [])
    tcs = loads(ticket.test_cases, [])
    out = []
    for i, ac in enumerate(acs, 1):
        cases = [tc.get("code") for tc in tcs if tc.get("criterion_id") == ac.get("id")]
        out.append(
            {"index": i, "id": ac.get("id"), "text": ac.get("text"), "cases": cases}
        )
    return out


async def _gen_test_cases(d: AiDraft, profile, row, project, allow_more):
    await _remember_name(profile)
    inp = loads(d.payload, {}).get("input") or {}
    async with database.async_session() as session:
        c = await ctxb.build(
            session,
            project_id=d.project_id,
            scope="ticket",
            person=d.owner,
            ticket_id=d.ticket_id,
        )
        t = await session.get(Ticket, d.ticket_id)
    cov = coverage(t)
    uncovered = [x for x in cov if not x["cases"]]
    from_desc = bool(inp.get("from_description")) or not cov
    if from_desc:
        task = (
            "This ticket has no acceptance criteria. Suggest 2 to 4 test cases from the description only.\n"
            'JSON: {"cases": [{"title": "...", "steps": ["..."], "expected": "...", "criterion": null}]}'
        )
    else:
        targets = uncovered or cov
        task = (
            "Suggest test cases for the acceptance criteria that have no test yet: "
            + ", ".join(f"AC {x['index']}" for x in targets)
            + ". One or two cases per criterion. Steps a tester can follow; one expected result.\n"
            'JSON: {"cases": [{"title": "...", "steps": ["..."], "expected": "...", "criterion": <AC number>}]}'
        )
    if inp.get("feedback"):
        task += f"\nThe person asked: {inp['feedback']}"
    value, complete, out = await _ask_json(
        profile, row, project, task, c.text, max_tokens=1600, allow_more=allow_more
    )
    raw_cases = (
        value.get("cases")
        if isinstance(value, dict)
        else value
        if isinstance(value, list)
        else None
    )
    if not isinstance(raw_cases, list):
        raise AssistError("invalid_output", "Draft didn't come back in a usable form.")
    by_index = {x["index"]: x for x in cov}
    cases = []
    for i, cs in enumerate(raw_cases[:8], 1):
        if not isinstance(cs, dict) or not str(cs.get("title") or "").strip():
            continue
        ac = None
        try:
            ac = (
                by_index.get(int(cs.get("criterion")))
                if cs.get("criterion") is not None
                else None
            )
        except (TypeError, ValueError):
            ac = None
        cases.append(
            {
                "n": i,
                "title": " ".join(str(cs["title"]).split())[:300],
                "steps": [
                    str(s).strip() for s in cs.get("steps") or [] if str(s).strip()
                ][:12],
                "expected": str(cs.get("expected") or "").strip()[:2000],
                "criterion_id": ac["id"] if ac else None,
                "criterion_index": ac["index"] if ac else None,
                "selected": True,
            }
        )
    payload = {
        "cases": cases,
        "coverage": cov,
        "covered": len([x for x in cov if x["cases"]]),
        "total": len(cov),
        "uncovered": len(uncovered),
        "from_description": from_desc,
        "existing": [
            {
                "code": tc.get("code"),
                "title": tc.get("title"),
                "criterion_id": tc.get("criterion_id"),
                "assignee": tc.get("assignee"),
            }
            for tc in loads(t.test_cases, [])
        ],
    }
    if not complete:
        payload["partial"] = _partial(["cases"], row, profile)
    return payload, out, out.text


async def _doc_context(session: AsyncSession, d: AiDraft) -> tuple[DocsPage, str]:
    page = await session.get(DocsPage, d.doc_id)
    text = await ctxb.doc_text(session, page)
    return page, text


async def _gen_doc_summary(d: AiDraft, profile, row, project, allow_more):
    await _remember_name(profile)
    async with database.async_session() as session:
        page, text = await _doc_context(session, d)
        inp = loads(d.payload, {}).get("input") or {}
        if inp.get("markdown"):
            text = str(inp["markdown"])
    sections = len([ln for ln in text.splitlines() if ln.startswith("#")])
    task = (
        'Summarise this page in 2 or 3 sentences for its top. JSON: {"summary": "..."}'
    )
    value, complete, out = await _ask_json(
        profile,
        row,
        project,
        task,
        ctxb.fence(f"doc {page.title}", text),
        max_tokens=600,
        allow_more=allow_more,
    )
    if not isinstance(value, dict) or not value.get("summary"):
        raise AssistError("invalid_output", "Draft didn't come back in a usable form.")
    return (
        {
            "text": str(value["summary"]).strip(),
            "sections": sections,
            "title": page.title,
        },
        out,
        out.text,
    )


async def _gen_doc_section(d: AiDraft, profile, row, project, allow_more):
    await _remember_name(profile)
    inp = loads(d.payload, {}).get("input") or {}
    tid = inp.get("ticket_id")
    async with database.async_session() as session:
        page, text = await _doc_context(session, d)
        t = await session.get(Ticket, tid) if tid else None
        if t is None:
            raise AssistError("invalid", "Pick a ticket to write the section from.")
        c = await ctxb.build(
            session,
            project_id=d.project_id,
            scope="ticket",
            person=d.owner,
            ticket_id=t.id,
        )
    task = (
        f"Write a short section for the page “{page.title}” describing what {t.id} delivers, for readers of the docs."
        ' JSON: {"heading": "short heading", "body": "Markdown, 1 to 3 short paragraphs"}'
    )
    value, complete, out = await _ask_json(
        profile, row, project, task, c.text, max_tokens=900, allow_more=allow_more
    )
    if not isinstance(value, dict) or not value.get("body"):
        raise AssistError("invalid_output", "Draft didn't come back in a usable form.")
    return (
        {
            "heading": " ".join(str(value.get("heading") or t.title).split())[:120],
            "text": str(value["body"]).strip(),
            "ticket": {"id": t.id, "title": t.title},
        },
        out,
        out.text,
    )


async def _gen_doc_links(d: AiDraft, profile, row, project, allow_more):
    from services.docs_text import heading_anchors

    await _remember_name(profile)
    inp = loads(d.payload, {}).get("input") or {}
    async with database.async_session() as session:
        page, text = await _doc_context(session, d)
        if inp.get("markdown"):
            text = str(inp["markdown"])
        others = (
            await session.exec(
                select(DocsPage).where(
                    DocsPage.project_id == d.project_id,
                    col(DocsPage.deleted_at).is_(None),
                    DocsPage.id != page.id,
                )
            )
        ).all()
        targets = []
        for o in others:
            heads = [
                h.get("text") for h in heading_anchors(await ctxb.doc_text(session, o))
            ][:12]
            targets.append({"title": o.title, "headings": heads})
        tickets = (
            await session.exec(select(Ticket).where(Ticket.project_id == d.project_id))
        ).all()
    listing = "\n".join(
        f"- doc “{x['title']}” headings: {', '.join(h for h in x['headings'] if h)}"
        for x in targets
    )
    listing += "\n" + "\n".join(f"- ticket {t.id}: {t.title}" for t in tickets[:200])
    task = (
        "Find phrases in the page that should link to another doc (optionally a heading) or a ticket. Use the exact"
        " phrase as written in the page. At most 8.\n"
        'JSON: {"links": [{"phrase": "...", "kind": "doc|ticket", "target": "doc title or ticket id", "anchor": "heading or null"}]}'
    )
    value, complete, out = await _ask_json(
        profile,
        row,
        project,
        task,
        f"Link targets:\n{listing}\n\nPage:\n" + ctxb.fence(f"doc {page.title}", text),
        max_tokens=900,
        allow_more=allow_more,
    )
    raw = value.get("links") if isinstance(value, dict) else None
    titles = {x["title"].lower(): x for x in targets}
    ids = {t.id.lower(): t for t in tickets}
    links = []
    for i, ln in enumerate(raw or [], 1):
        if not isinstance(ln, dict):
            continue
        phrase = str(ln.get("phrase") or "").strip()
        if not phrase or phrase not in text:
            continue
        kind = ln.get("kind")
        target = str(ln.get("target") or "").strip()
        if kind == "doc" and target.lower() in titles:
            tgt = titles[target.lower()]
            anchor = ln.get("anchor") if ln.get("anchor") in tgt["headings"] else None
            ref = f"[[{tgt['title']}{'#' + anchor if anchor else ''}|{phrase}]]"
            links.append(
                {
                    "n": i,
                    "phrase": phrase,
                    "kind": "doc",
                    "target": tgt["title"],
                    "anchor": anchor,
                    "ref": ref,
                }
            )
        elif kind == "ticket" and target.lower() in ids:
            t = ids[target.lower()]
            links.append(
                {
                    "n": i,
                    "phrase": phrase,
                    "kind": "ticket",
                    "target": t.id,
                    "title": t.title,
                    "anchor": None,
                    "ref": t.id if phrase == t.id else f"[[{t.id}|{phrase}]]",
                }
            )
    return {"links": links, "title": page.title}, out, out.text


async def _gen_doc_text(d: AiDraft, profile, row, project, allow_more):
    """Selection toolbar: summarise / rewrite / ask about the selected text."""
    await _remember_name(profile)
    inp = loads(d.payload, {}).get("input") or {}
    action = inp.get("action") or "summarise"
    selected = str(inp.get("text") or "")
    if not selected.strip():
        raise AssistError("invalid", "Select some text first.")
    task = {
        "summarise": 'Summarise the selected text in one or two sentences. JSON: {"text": "..."}',
        "rewrite": 'Rewrite the selected text to be clearer, same meaning, same Markdown. JSON: {"text": "..."}',
        "ask": f'Answer the question about the selected text: {inp.get("question") or ""}. JSON: {{"text": "..."}}',
    }.get(action)
    if task is None:
        raise AssistError("invalid", "Unknown action.")
    value, complete, out = await _ask_json(
        profile,
        row,
        project,
        task,
        ctxb.fence("selected text", selected),
        max_tokens=900,
        allow_more=allow_more,
    )
    if not isinstance(value, dict) or not value.get("text"):
        raise AssistError("invalid_output", "Draft didn't come back in a usable form.")
    return (
        {"text": str(value["text"]).strip(), "action": action, "selected": selected},
        out,
        out.text,
    )


async def _gen_nudge(d: AiDraft, profile, row, project, allow_more):
    """A draft comment for a board-health insight (posted by a person, never by the AI)."""
    await _remember_name(profile)
    inp = loads(d.payload, {}).get("input") or {}
    async with database.async_session() as session:
        t = await session.get(Ticket, d.ticket_id)
        assignee = await session.get(Member, t.assignee) if t and t.assignee else None
    who = f"@{assignee.name} " if assignee else ""
    task = (
        f"Write a short, kind comment on {t.id} for its owner about this: {inp.get('reason')}. Ask what blocks it and"
        f' offer help. Start with “{who.strip() or "Hi"}”. At most 3 sentences. JSON: {{"text": "..."}}'
    )
    value, complete, out = await _ask_json(
        profile,
        row,
        project,
        task,
        ctxb.ticket_line(t, {}),
        max_tokens=300,
        allow_more=allow_more,
    )
    text = (
        str((value or {}).get("text") or "").strip() if isinstance(value, dict) else ""
    )
    if not text:
        text = f"{who}this has been {STATUS_LABELS.get(t.status, t.status)} for a while with no activity. Is something blocking it?"
    return {"changes": [{"op": "comment", "ticket": t.id, "text": text}]}, out, out.text


async def _gen_editor(d: AiDraft, profile, row, project, allow_more):
    """Text help in an editor (the /ai menu, the selection bar); see `editor.py`."""
    from . import editor

    return await editor.generate(d, profile, row, project, allow_more)


async def _gen_sketch(d: AiDraft, profile, row, project, allow_more):
    """Ask, ideas or ops for a sketch; see `sketch_ai.py`."""
    from . import sketch_ai

    return await sketch_ai.generate(d, profile, row, project, allow_more)


GENERATORS = {
    "sketch": _gen_sketch,
    "editor": _gen_editor,
    "editor_doc": _gen_editor,
    "ticket": _gen_ticket,
    "description": _gen_description,
    "split": _gen_split,
    "test_cases": _gen_test_cases,
    "doc_summary": _gen_doc_summary,
    "doc_section": _gen_doc_section,
    "doc_links": _gen_doc_links,
    "doc_text": _gen_doc_text,
    "nudge": _gen_nudge,
}


# ---------------------------------------------------------------------------
# Apply, conflicts, undo
# ---------------------------------------------------------------------------


async def conflicts(session: AsyncSession, d: AiDraft) -> list[dict]:
    """Changes people made to the draft's tickets after it was written (I6)."""
    out = []
    for tid, at in loads(d.base, {}).items():
        t = await session.get(Ticket, tid)
        if t is None:
            out.append(
                {"ticket": tid, "message": f"{tid} was deleted after this draft."}
            )
            continue
        if not at or (t.updated_at or "") <= at:
            continue
        changes = []
        for e in loads(t.activity_log, []):
            if isinstance(e, dict) and (e.get("at") or "") > at:
                changes.append(e)
        last = changes[-1] if changes else None
        if last:
            field = last.get("field")
            to = last.get("to")
            if field == "status":
                to = STATUS_LABELS.get(to, to)
            msg = f"{last.get('actor') or 'Someone'} changed {field} to {to} at {(last.get('at') or '')[11:16]}"
        else:
            msg = f"{tid} was edited after this draft."
        out.append({"ticket": tid, "message": msg, "changes": changes[-5:]})
    return out


async def _check_apply(
    session: AsyncSession, d: AiDraft, person: str, force: bool
) -> None:
    if d.status not in ("open",):
        raise AssistError("invalid", f"This draft is {d.status}.")
    if await role_of(session, d.project_id, person) == "viewer":
        lead = await project_lead(session, d.project_id)
        raise AssistError(
            "viewer",
            f"Ask the project lead{', ' + lead + ',' if lead else ''} to apply this. Copy the draft to share it.",
            lead=lead,
        )
    if not force:
        found = await conflicts(session, d)
        if found:
            raise AssistError("conflict", found[0]["message"], conflicts=found)


async def _finish(
    session: AsyncSession, d: AiDraft, person: str, result: dict
) -> AiDraft:
    d.status = "applied"
    d.applied_at = now_iso()
    d.applied_by = person
    d.result = json.dumps(result)
    session.add(d)
    await session.commit()
    await session.refresh(d)
    if d.insight_id:
        from .health import mark_acted

        await mark_acted(session, d.insight_id)
    await _publish()
    return d


class _As:
    """Run ticket writes as the person, attributed "suggested by <Board AI>"."""

    def __init__(self, person: str, ai_name: str):
        """Remember who acts and who suggested it."""
        self.person, self.ai_name = person, ai_name

    def __enter__(self):
        """Set the attribution."""
        self.t1 = act.set_actor(self.person)
        self.t2 = act.set_suggested(self.ai_name or "Board AI")
        return self

    def __exit__(self, *exc):
        """Restore it."""
        act.reset_suggested(self.t2)
        act.reset_actor(self.t1)


async def apply_changes(
    session: AsyncSession,
    d: AiDraft,
    person: str,
    *,
    selected: list[int] | None = None,
    edits: dict | None = None,
    force: bool = False,
) -> AiDraft:
    """Apply a changes draft (chat actions, board-health acts). Apply is the only write."""
    from .. import runs as ai_runs

    await _check_apply(session, d, person, force)
    payload = loads(d.payload, {})
    changes = payload.get("changes") or []
    picks = set(selected) if selected is not None else set(range(len(changes)))
    applied, errors = [], []
    with _As(person, d.member_name):
        for i, ch in enumerate(changes):
            if i not in picks:
                continue
            tid = ch["ticket"]
            try:
                if ch.get("scope"):
                    provider = scopes.get(ch["scope"])
                    if provider is None:
                        raise ValueError(f"No chat about {ch['scope']} here.")
                    done = await provider.apply_change(
                        session, ch, person, d.member_name
                    )
                    applied.append(
                        {
                            "i": i,
                            "op": ch["op"],
                            "ticket": tid,
                            "undo_with": ch["scope"],
                            **done,
                        }
                    )
                    continue
                if ch["op"] == "add_criteria":
                    raw = (edits or {}).get(str(i))
                    items = (
                        [x.strip() for x in raw.splitlines() if x.strip()]
                        if raw is not None
                        else list(ch["items"])
                    )
                    ids: list[str] = []
                    for text in items:
                        t = await svc_tickets.add_acceptance_criterion(
                            session, tid, text
                        )
                        if t is not None:
                            ids.append(loads(t.acceptance_criteria, [])[-1]["id"])
                    if not ids:
                        raise ValueError("Write at least one criterion.")
                    applied.append(
                        {"i": i, "op": "add_criteria", "ticket": tid, "ids": ids}
                    )
                    continue
                if ch["op"] == "comment":
                    text = (edits or {}).get(str(i)) or ch["text"]
                    t = await svc_tickets.add_comment(
                        session,
                        tid,
                        text,
                        author=person,
                        meta={"suggested_by": d.member_name},
                    )
                    cid = (loads(t.comments, [])[-1] or {}).get("id") if t else None
                    applied.append(
                        {"i": i, "op": "comment", "ticket": tid, "comment_id": cid}
                    )
                    continue
                t = await session.get(Ticket, tid)
                field = ch["op"]
                before = getattr(t, field)
                if field == "assignee":
                    await ai_runs.before_ticket_change(
                        tid, assignee=ch["to"], by=person
                    )
                if field == "status" and ch["to"] == "wont_do":
                    await ai_runs.before_ticket_change(tid, status="wont_do", by=person)
                await svc_tickets.update_ticket(
                    session, tid, TicketUpdate(**{field: ch["to"]})
                )
                applied.append(
                    {
                        "i": i,
                        "op": field,
                        "ticket": tid,
                        "before": before,
                        "after": ch["to"],
                    }
                )
            except ValueError as exc:
                errors.append({"i": i, "ticket": tid, "message": str(exc)})
    if not applied and errors:
        raise AssistError("apply_failed", errors[0]["message"], errors=errors)
    return await _finish(
        session,
        d,
        person,
        {"applied": applied, "errors": errors, "count": len(applied)},
    )


async def apply_description(
    session: AsyncSession,
    d: AiDraft,
    person: str,
    *,
    hunks: list[str] | None,
    force: bool = False,
) -> AiDraft:
    """Replace the description with the accepted hunks (C4); the old text stays in history."""
    await _check_apply(session, d, person, force)
    payload = loads(d.payload, {})
    accepted = (
        set(hunks)
        if hunks is not None
        else {h["id"] for h in payload.get("hunks") or []}
    )
    if not accepted:
        raise AssistError("invalid", "Select at least one change.")
    new = compose(payload.get("segments") or [], payload.get("hunks") or [], accepted)
    t = await session.get(Ticket, d.ticket_id)
    before = t.description
    with _As(person, d.member_name):
        await svc_tickets.update_ticket(
            session, d.ticket_id, TicketUpdate(description=new)
        )
    return await _finish(
        session,
        d,
        person,
        {
            "before": before,
            "after": new,
            "accepted": sorted(accepted),
            "count": len(accepted),
        },
    )


async def apply_split(
    session: AsyncSession,
    d: AiDraft,
    person: str,
    *,
    selected: list[int] | None,
    titles: dict | None,
    update_parent: bool = False,
    force: bool = False,
) -> AiDraft:
    """Create the selected sub-tickets with their blocked-by Relations (D1–D3)."""
    await _check_apply(session, d, person, force)
    payload = loads(d.payload, {})
    items = payload.get("items") or []
    picks = (
        set(selected)
        if selected is not None
        else {it["n"] for it in items if it.get("selected", True)}
    )
    chosen = [it for it in items if it["n"] in picks]
    if not chosen:
        raise AssistError("invalid", "Select at least one sub-ticket.")
    parent = await session.get(Ticket, d.ticket_id)
    creator = await _member_id(session, d.project_id, person)
    created: dict[int, str] = {}
    with _As(person, d.member_name):
        for it in chosen:
            title = " ".join(
                str((titles or {}).get(str(it["n"])) or it["title"]).split()
            )[:300]
            t = await svc_tickets.create_ticket(
                session,
                project_id=d.project_id,
                title=title,
                type=parent.type
                if parent.type in ("bug", "feature", "task", "chore")
                else "task",
                description=it.get("description") or "",
                parent_id=parent.id,
                estimate=it.get("estimate"),
                created_by=creator,
            )
            created[it["n"]] = t.id
        links = []
        for it in chosen:
            for dep in it.get("blocked_by") or []:
                if dep in created:
                    await svc_tickets.link_block(
                        session, created[dep], created[it["n"]]
                    )
                    links.append([created[dep], created[it["n"]]])
        before_est = parent.estimate
        total = sum(it.get("estimate") or 0 for it in chosen)
        if update_parent and total:
            await svc_tickets.update_ticket(
                session, parent.id, TicketUpdate(estimate=total)
            )
    return await _finish(
        session,
        d,
        person,
        {
            "created": [created[it["n"]] for it in chosen],
            "links": links,
            "parent_estimate_before": before_est,
            "parent_estimate_after": total if update_parent and total else before_est,
            "count": len(chosen),
        },
    )


async def apply_test_cases(
    session: AsyncSession,
    d: AiDraft,
    person: str,
    *,
    selected: list[int] | None,
    force: bool = False,
) -> AiDraft:
    """Add the selected cases like "Add test case": Pending, written by the person (E1)."""
    await _check_apply(session, d, person, force=True)  # adding cases never conflicts
    payload = loads(d.payload, {})
    cases = payload.get("cases") or []
    picks = (
        set(selected)
        if selected is not None
        else {c["n"] for c in cases if c.get("selected", True)}
    )
    chosen = [c for c in cases if c["n"] in picks]
    if not chosen:
        raise AssistError("invalid", "Select at least one test case.")
    ids = []
    with _As(person, d.member_name):
        for cs in chosen:
            steps = "\n".join(
                f"{i}. {s}" for i, s in enumerate(cs.get("steps") or [], 1)
            )
            t = await svc_tickets.add_test_case(
                session,
                d.ticket_id,
                title=cs["title"],
                status="pending",
                description=steps or None,
                expected_result=cs.get("expected") or None,
                criterion_id=cs.get("criterion_id"),
                suggested_by=d.member_name,
            )
            ids.append(loads(t.test_cases, [])[-1]["id"])
    return await _finish(session, d, person, {"created": ids, "count": len(ids)})


async def create_ticket(
    session: AsyncSession, d: AiDraft, person: str, fields: dict
) -> AiDraft:
    """ "Create Ticket" with the accepted fields of a ticket draft (C1): rejected fields stay empty."""
    if d.kind != "ticket":
        raise AssistError("invalid", "Not a ticket draft.")
    if d.status != "open":
        raise AssistError("invalid", f"This draft is {d.status}.")
    if await role_of(session, d.project_id, person) == "viewer":
        lead = await project_lead(session, d.project_id)
        raise AssistError(
            "viewer",
            f"Ask the project lead{', ' + lead + ',' if lead else ''} to create this.",
            lead=lead,
        )
    title = " ".join(str(fields.get("title") or "").split())
    if not title:
        raise AssistError("invalid", "A ticket needs a title.")
    creator = await _member_id(session, d.project_id, person)
    est = fields.get("estimate")
    if est is not None and float(est) not in prompts.ESTIMATES:
        raise AssistError("invalid", "Estimate must be 1, 2, 3, 5, 8 or 13")
    with _As(person, d.member_name):
        t = await svc_tickets.create_ticket(
            session,
            project_id=d.project_id,
            title=title,
            type=fields.get("type") or "task",
            priority=fields.get("priority") or "medium",
            status=fields.get("status") or "backlog",
            description=fields.get("description") or "",
            estimate=float(est) if est is not None else None,
            tags=list(fields.get("labels") or []),
            created_by=creator,
            assignee=fields.get("assignee") or None,
            due_date=fields.get("due_date") or None,
        )
        for text in fields.get("criteria") or []:
            if str(text).strip():
                await svc_tickets.add_acceptance_criterion(session, t.id, str(text))
    return await _finish(session, d, person, {"ticket_id": t.id, "count": 1})


async def mark_inserted(
    session: AsyncSession, d: AiDraft, person: str, detail: dict | None = None
) -> AiDraft:
    """Docs drafts are inserted by the editor; the board records that the person used it."""
    if d.status != "open":
        raise AssistError("invalid", f"This draft is {d.status}.")
    return await _finish(session, d, person, {"inserted": True, **(detail or {})})


async def apply(
    session: AsyncSession, draft_id: str, person: str, body: dict
) -> AiDraft:
    """Dispatch Apply / Accept / Create by kind."""
    d = await _get(session, draft_id)
    force = bool(body.get("force"))
    if d.kind in ("changes", "nudge", "assignee"):
        return await apply_changes(
            session,
            d,
            person,
            selected=body.get("selected"),
            edits=body.get("edits"),
            force=force,
        )
    if d.kind == "description":
        return await apply_description(
            session, d, person, hunks=body.get("hunks"), force=force
        )
    if d.kind == "split":
        return await apply_split(
            session,
            d,
            person,
            selected=body.get("selected"),
            titles=body.get("titles"),
            update_parent=bool(body.get("update_parent")),
            force=force,
        )
    if d.kind == "test_cases":
        return await apply_test_cases(session, d, person, selected=body.get("selected"))
    if d.kind == "ticket":
        return await create_ticket(session, d, person, body.get("fields") or {})
    return await mark_inserted(session, d, person, body.get("detail"))


async def discard(session: AsyncSession, draft_id: str) -> AiDraft:
    """Discard (nothing was written)."""
    d = await _get(session, draft_id)
    if d.status in ("applied",):
        raise AssistError("invalid", "Already applied; use Undo.")
    task = TASKS.get(draft_id)
    if task:
        task.cancel()
    d.status = "discarded"
    session.add(d)
    await session.commit()
    await session.refresh(d)
    await _publish()
    return d


async def edit(session: AsyncSession, draft_id: str, payload_patch: dict) -> AiDraft:
    """Edit the draft before applying (comment text, split titles and selection, case selection)."""
    d = await _get(session, draft_id)
    if d.status != "open":
        raise AssistError("invalid", f"This draft is {d.status}.")
    payload = loads(d.payload, {})
    for key in ("changes", "items", "cases", "fields", "text", "heading", "links"):
        if key in payload_patch:
            payload[key] = payload_patch[key]
    d.payload = json.dumps(payload)
    session.add(d)
    await session.commit()
    await session.refresh(d)
    return d


async def undo(session: AsyncSession, draft_id: str, person: str) -> AiDraft:
    """Undo an applied draft (B10, C4, D3). A field a person changed since is left as they set it."""
    d = await _get(session, draft_id)
    if d.status != "applied":
        raise AssistError("invalid", "Only an applied draft can be undone.")
    res = loads(d.result, {})
    undone, skipped = 0, []
    with _As(person, d.member_name):
        if d.kind in ("changes", "nudge", "assignee"):
            for a in reversed(res.get("applied") or []):
                if a["op"] == "add_criteria":
                    for cid in a.get("ids") or []:
                        await svc_tickets.delete_acceptance_criterion(
                            session, a["ticket"], cid
                        )
                        undone += 1
                    continue
                if a.get("undo_with"):
                    provider = scopes.get(a["undo_with"])
                    if provider is not None and await provider.undo_change(
                        session, a, person
                    ):
                        undone += 1
                    else:
                        skipped.append(f"{a['ticket']} {a['op']} was changed since")
                    continue
                if a["op"] == "comment":
                    if a.get("comment_id"):
                        await svc_tickets.delete_comment(
                            session, a["ticket"], a["comment_id"]
                        )
                        undone += 1
                    continue
                t = await session.get(Ticket, a["ticket"])
                if t is None:
                    continue
                if getattr(t, a["op"]) != a["after"]:
                    skipped.append(f"{a['ticket']} {a['op']} was changed since")
                    continue
                try:
                    await svc_tickets.update_ticket(
                        session, t.id, TicketUpdate(**{a["op"]: a["before"]})
                    )
                    undone += 1
                except ValueError as exc:
                    skipped.append(str(exc))
        elif d.kind == "description":
            t = await session.get(Ticket, d.ticket_id)
            if t and t.description == res.get("after"):
                await svc_tickets.update_ticket(
                    session, t.id, TicketUpdate(description=res.get("before") or "")
                )
                undone += 1
            else:
                skipped.append("The description was edited since")
        elif d.kind == "split":
            for tid in res.get("created") or []:
                if await svc_tickets.delete_ticket(session, tid):
                    undone += 1
            parent = await session.get(Ticket, d.ticket_id)
            if (
                parent
                and parent.estimate == res.get("parent_estimate_after")
                and res.get("parent_estimate_before")
                != res.get("parent_estimate_after")
            ):
                await svc_tickets.update_ticket(
                    session,
                    parent.id,
                    TicketUpdate(estimate=res.get("parent_estimate_before")),
                )
        elif d.kind == "test_cases":
            for tc_id in res.get("created") or []:
                await svc_tickets.delete_test_case(session, d.ticket_id, tc_id)
                undone += 1
        elif d.kind == "ticket":
            if res.get("ticket_id") and await svc_tickets.delete_ticket(
                session, res["ticket_id"]
            ):
                undone += 1
    d.status = "undone"
    res["undo"] = {"by": person, "at": now_iso(), "undone": undone, "skipped": skipped}
    d.result = json.dumps(res)
    session.add(d)
    await session.commit()
    await session.refresh(d)
    await _publish()
    return d


async def for_ticket(session: AsyncSession, ticket_id: str) -> list[AiDraft]:
    """Drafts on a ticket, newest first (the AI-created badge, the description diff, split and cases)."""
    return list(
        (
            await session.exec(
                select(AiDraft)
                .where(AiDraft.ticket_id == ticket_id)
                .order_by(col(AiDraft.created_at).desc())
            )
        ).all()
    )


async def request_apply(session: AsyncSession, draft_id: str, person: str) -> dict:
    """A viewer asks the project lead to apply a draft: a comment on the ticket mentions the lead."""
    d = await _get(session, draft_id)
    lead = await project_lead(session, d.project_id)
    tid = d.ticket_id or next(
        (
            c.get("ticket")
            for c in loads(d.payload, {}).get("changes") or []
            if c.get("ticket")
        ),
        None,
    )
    if not tid:
        raise AssistError("invalid", "This draft is not on a ticket; copy it instead.")
    mention = f"@{lead} " if lead else ""
    await svc_tickets.add_comment(
        session,
        tid,
        f"{mention}please apply the Board AI draft I prepared ({d.kind.replace('_', ' ')}): it is waiting in the"
        " Ask AI dock.",
        author=person,
        meta={"draft_id": d.id},
    )
    await _publish()
    return {"lead": lead, "ticket_id": tid}
