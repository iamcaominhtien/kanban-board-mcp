"""Run history: finding the run you mean, reading what it was given and what it did, exporting it
(design/screens/ai-operations.md, F and G).

Every filter reads `AiRun`; the words in the search box go through the transcript index (``transcripts.search_ids``)
and, where FTS5 is missing, through the run's own summary, instruction and reason.
"""

import json
from datetime import UTC, datetime

from sqlmodel import col, func, select

from models import AiRun, AiRunTranscript, AiSkillUse, Member, Ticket

from . import transcripts
from .store import loads

PAGE = 50


def _duration(run: AiRun) -> int | None:
    try:
        start = datetime.fromisoformat(run.started_at) if run.started_at else None
        end = (
            datetime.fromisoformat(run.ended_at) if run.ended_at else datetime.now(UTC)
        )
    except ValueError:
        return None
    return int((end - start).total_seconds()) if start else None


async def list_runs(
    session,
    *,
    project_id: str | None = None,
    member_id: str | None = None,
    ticket_id: str | None = None,
    state: str | None = None,
    skill: str | None = None,
    since: str | None = None,
    until: str | None = None,
    q: str | None = None,
    pinned: bool | None = None,
    limit: int = PAGE,
    offset: int = 0,
) -> dict:
    """Runs matching the filters, newest first (best match first when `q` is given): {runs, total}."""
    stmt = select(AiRun)
    if project_id:
        stmt = stmt.where(AiRun.project_id == project_id)
    if member_id:
        stmt = stmt.where(AiRun.member_id == member_id)
    if ticket_id:
        stmt = stmt.where(AiRun.ticket_id == ticket_id)
    if state:
        states = [s for s in state.split(",") if s]
        stmt = stmt.where(col(AiRun.state).in_(states))
    if since:
        stmt = stmt.where(col(AiRun.queued_at) >= since)
    if until:
        stmt = stmt.where(col(AiRun.queued_at) <= until)
    if skill:
        used = select(AiSkillUse.run_id).where(AiSkillUse.name == skill)
        stmt = stmt.where(col(AiRun.id).in_(used))
    if pinned:
        kept = select(AiRunTranscript.run_id).where(AiRunTranscript.pinned == True)  # noqa: E712
        stmt = stmt.where(col(AiRun.id).in_(kept))
    order: list[str] | None = None
    if q and q.strip():
        ids = await transcripts.search_ids(session, q, project_id=project_id)
        if ids is None:  # no index: the run's own text
            like = f"%{q.strip()}%"
            stmt = stmt.where(
                col(AiRun.summary).ilike(like)
                | col(AiRun.instruction).ilike(like)
                | col(AiRun.ended_reason).ilike(like)
                | col(AiRun.ticket_id).ilike(like)
            )
        else:
            order = ids
            stmt = stmt.where(col(AiRun.id).in_(ids))
    total = (
        await session.exec(select(func.count()).select_from(stmt.subquery()))
    ).one()
    if order is not None:
        rows = (await session.exec(stmt)).all()
        rank = {rid: i for i, rid in enumerate(order)}
        rows = sorted(rows, key=lambda r: rank.get(r.id, len(rank)))[
            offset : offset + limit
        ]
    else:
        rows = (
            await session.exec(
                stmt.order_by(col(AiRun.queued_at).desc()).offset(offset).limit(limit)
            )
        ).all()
    return {"runs": await rows_out(session, rows, q=q), "total": int(total)}


async def rows_out(session, rows: list[AiRun], q: str | None = None) -> list[dict]:
    """The short form of a run for a list: who, which ticket, how it ended, what it cost, which skills."""
    if not rows:
        return []
    ids = [r.id for r in rows]
    names = {
        m.id: m.name
        for m in (
            await session.exec(
                select(Member).where(col(Member.id).in_({r.member_id for r in rows}))
            )
        ).all()
    }
    tickets = {
        t.id: t
        for t in (
            await session.exec(
                select(Ticket).where(col(Ticket.id).in_({r.ticket_id for r in rows}))
            )
        ).all()
    }
    kept = {
        t.run_id: t
        for t in (
            await session.exec(
                select(AiRunTranscript).where(col(AiRunTranscript.run_id).in_(ids))
            )
        ).all()
    }
    skills: dict[str, list[str]] = {}
    for use in (
        await session.exec(select(AiSkillUse).where(col(AiSkillUse.run_id).in_(ids)))
    ).all():
        names_ = skills.setdefault(use.run_id, [])
        if use.name not in names_:
            names_.append(use.name)
    out = []
    for r in rows:
        t = kept.get(r.id)
        ticket = tickets.get(r.ticket_id)
        item = {
            "id": r.id,
            "number": r.number,
            "project_id": r.project_id,
            "ticket_id": r.ticket_id,
            "ticket_title": ticket.title if ticket else None,
            "member_id": r.member_id,
            "member_name": names.get(r.member_id),
            "mode": r.mode,
            "trigger": r.trigger,
            "state": r.state,
            "model": r.model,
            "queued_at": r.queued_at,
            "started_at": r.started_at,
            "ended_at": r.ended_at,
            "duration_s": _duration(r),
            "cost_usd": r.cost_usd,
            "tokens": (r.tokens_in or 0) + (r.tokens_out or 0),
            "summary": (r.summary or "")[:400] or None,
            "ended_reason": r.ended_reason,
            "files": len(loads(r.files, [])),
            "skills": skills.get(r.id, []),
            "transcript": transcript_info(t),
            "diagnosis": loads(getattr(r, "diagnosis", None), None),
        }
        if q and t and not t.deleted_at:
            item["snippet"] = transcripts.snippet(await transcripts.read(r.id) or [], q)
        out.append(item)
    return out


def transcript_info(t: AiRunTranscript | None) -> dict | None:
    """What the API says about a run's transcript (None: the board kept none for it)."""
    if t is None:
        return None
    return {
        "bytes": t.bytes,
        "events": t.events,
        "pinned": t.pinned,
        "pinned_by": t.pinned_by,
        "ended_at": t.ended_at,
        "removed_at": t.deleted_at,
    }


def timeline(records: list[dict]) -> list[dict]:
    """The transcript as the run detail draws it: one entry per thing the AI said or did, with the tool's input and
    output joined, and the board's own notes in between."""
    out: list[dict] = []
    by_tool: dict[str, dict] = {}
    for rec in records:
        at = rec.get("t")
        kind = rec.get("k")
        if kind == "sent":
            out.append(
                {
                    "at": at,
                    "type": "sent",
                    "system": rec.get("system"),
                    "prompt": rec.get("prompt"),
                    "note": rec.get("note"),
                    "resume": rec.get("resume"),
                    "args": rec.get("args"),
                }
            )
            continue
        if kind == "note":
            out.append(
                {
                    "at": at,
                    "type": "note",
                    "kind": rec.get("kind"),
                    "text": rec.get("text"),
                }
            )
            continue
        if kind == "text":
            out.append({"at": at, "type": "output", "text": rec.get("text")})
            continue
        ev = rec.get("e") or {}
        et = ev.get("type")
        if et == "system" and ev.get("subtype") == "init":
            out.append(
                {
                    "at": at,
                    "type": "init",
                    "model": ev.get("model"),
                    "tools": len(ev.get("tools") or []),
                    "skills": ev.get("skills") or [],
                    "plugins": [
                        p.get("name")
                        for p in ev.get("plugins") or []
                        if isinstance(p, dict)
                    ],
                    "mcp_servers": [
                        {"name": s.get("name"), "status": s.get("status")}
                        for s in ev.get("mcp_servers") or []
                        if isinstance(s, dict)
                    ],
                }
            )
        elif et == "system" and ev.get("subtype") == "compact_boundary":
            meta = ev.get("compact_metadata") or {}
            out.append(
                {
                    "at": at,
                    "type": "compact",
                    "before": meta.get("pre_tokens"),
                    "after": meta.get("post_tokens"),
                }
            )
        elif et == "assistant":
            for block in transcripts.blocks_of(ev):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and (block.get("text") or "").strip():
                    out.append({"at": at, "type": "say", "text": block["text"]})
                elif (
                    block.get("type") == "thinking"
                    and (block.get("thinking") or "").strip()
                ):
                    out.append({"at": at, "type": "think", "text": block["thinking"]})
                elif block.get("type") == "tool_use":
                    entry = {
                        "at": at,
                        "type": "tool",
                        "id": block.get("id"),
                        "name": block.get("name"),
                        "input": block.get("input"),
                        "output": None,
                        "is_error": None,
                        "ended_at": None,
                    }
                    by_tool[block.get("id") or ""] = entry
                    out.append(entry)
        elif et == "user":
            content = transcripts.content_of(ev)
            if isinstance(content, str):
                out.append({"at": at, "type": "message", "text": content})
                continue
            for block in content or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    body = block.get("content")
                    if isinstance(body, list):
                        body = "\n".join(
                            str(c.get("text", "")) for c in body if isinstance(c, dict)
                        )
                    entry = by_tool.get(block.get("tool_use_id") or "")
                    if entry is not None:
                        entry["output"] = body
                        entry["is_error"] = bool(block.get("is_error"))
                        entry["ended_at"] = at
                    else:
                        out.append({"at": at, "type": "output", "text": body})
                elif block.get("type") == "text" and ev.get("isReplay"):
                    out.append({"at": at, "type": "message", "text": block.get("text")})
        elif et == "result":
            out.append(
                {
                    "at": at,
                    "type": "result",
                    "is_error": bool(ev.get("is_error")),
                    "text": ev.get("result"),
                    "cost_usd": ev.get("total_cost_usd"),
                    "turns": ev.get("num_turns"),
                    "api_error": ev.get("api_error"),
                }
            )
        elif et == "rate_limit_event":
            info = ev.get("rate_limit_info") or {}
            out.append(
                {
                    "at": at,
                    "type": "quota",
                    "status": info.get("status"),
                    "windows": info.get("unifiedWindows"),
                }
            )
    return out


def _fence(text: str) -> str:
    ticks = "```"
    while ticks in (text or ""):
        ticks += "`"
    return f"{ticks}\n{text}\n{ticks}"


def to_markdown(run: dict, entries: list[dict]) -> str:
    """A run as one Markdown document: what it was given, then everything it did."""
    lines = [
        f"# Run #{run.get('number')} on {run.get('ticket_id')}: {run.get('ticket_title') or ''}".rstrip(
            ": "
        ),
        "",
        f"- AI: {run.get('member_name') or run.get('member_id')}",
        f"- State: {run.get('state')}"
        + (f" ({run['ended_reason']})" if run.get("ended_reason") else ""),
        f"- Started: {run.get('started_at') or '—'}  Ended: {run.get('ended_at') or '—'}",
        f"- Model: {run.get('model') or '—'}  Cost: ${float(run.get('cost_usd') or 0):.4f}",
    ]
    if run.get("skills"):
        lines.append(f"- Skills used: {', '.join(run['skills'])}")
    if run.get("summary"):
        lines += ["", "## Summary", "", run["summary"]]
    lines += ["", "## Transcript", ""]
    for e in entries:
        kind = e["type"]
        if kind == "sent":
            lines += ["### What the board sent", ""]
            if e.get("note"):
                lines += [f"Note: {e['note']}", ""]
            lines += [
                "System prompt:",
                "",
                _fence(e.get("system") or ""),
                "",
                "Prompt:",
                "",
                _fence(e.get("prompt") or ""),
                "",
            ]
        elif kind == "say":
            lines += [f"**AI:** {e['text']}", ""]
        elif kind == "think":
            continue
        elif kind == "tool":
            lines += [
                f"**Tool {e['name']}**",
                "",
                _fence(json.dumps(e.get("input"), indent=2, ensure_ascii=False)),
            ]
            if e.get("output") is not None:
                lines += [
                    "",
                    "Result" + (" (error)" if e.get("is_error") else "") + ":",
                    "",
                    _fence(str(e["output"])[:20000]),
                ]
            lines.append("")
        elif kind == "note":
            lines += [f"_Board: {e.get('text')}_", ""]
        elif kind == "message":
            lines += [f"**Person:** {e.get('text')}", ""]
        elif kind == "result":
            lines += [
                f"_Turn ended{' with an error' if e.get('is_error') else ''}: {e.get('text') or ''}_",
                "",
            ]
    return "\n".join(lines)


async def skill_usage(
    session, project_id: str | None = None, since: str | None = None
) -> list[dict]:
    """How often each skill and subagent was really used: [{name, kind, plugin, uses, runs, members, last}]."""
    stmt = select(AiSkillUse)
    if project_id:
        stmt = stmt.where(AiSkillUse.project_id == project_id)
    if since:
        stmt = stmt.where(col(AiSkillUse.at) >= since)
    agg: dict[str, dict] = {}
    for use in (await session.exec(stmt)).all():
        row = agg.setdefault(
            use.name,
            {
                "name": use.name,
                "kind": use.kind,
                "plugin": use.plugin,
                "uses": 0,
                "runs": set(),
                "members": set(),
                "last": None,
            },
        )
        row["uses"] += 1
        row["runs"].add(use.run_id)
        if use.member_id:
            row["members"].add(use.member_id)
        row["last"] = max(row["last"] or "", use.at)
    return sorted(
        (
            {**r, "runs": len(r["runs"]), "members": sorted(r["members"])}
            for r in agg.values()
        ),
        key=lambda r: -r["uses"],
    )
