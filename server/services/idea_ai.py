"""Optional AI help in the Idea Space (design: `design/screens/idea-ai-help.md`).

Seven small helpers, each of which only suggests: triage advice, shaping an idea (problem, assumptions, cheapest
test, effort guess), checking what already exists, asking about ideas, preparing the ticket, and a weekly grooming
digest. The AI never moves, edits, merges, archives or promotes an idea; a person accepts item by item.

The model is the project's Board AI member, so its limits, permissions and cost display apply; Idea Space has a
daily cap of its own on top. Duplicate matching (`services/idea_similarity.py`) needs no model and works with AI
turned off. Everything the model reads is limited to what the question needs and fenced as data.
"""

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    ARCHIVE_REASONS,
    AiUsage,
    IdeaAdvice,
    IdeaAiSettings,
    IdeaDigest,
    IdeaTicket,
    Member,
    Project,
    Ticket,
)
from services import idea_similarity
from services import idea_space as space
from services.ai import audit, budget, llm
from services.ai.assist import context as ctxb
from services.ai.assist import prompts
from services.ai.assist import settings as assist_settings
from services.ai.store import parse_iso

log = logging.getLogger(__name__)
UTC = timezone.utc

DEFAULT_CAP = 1.0
FEATURE_PREFIX = "idea_"
ADVICE_ACTIONS = ("keep", "park", "merge", "archive")
CONFIDENCES = ("high", "medium", "low")
SHAPE_KINDS = ("problem", "assumptions", "tests", "effort", "exists", "ask")
# What a typical answer costs, shown before asking (examples, not measured prices; the real cost is metered).
COST_HINTS = {
    "advice": 0.002,
    "shape": 0.03,
    "exists": 0.02,
    "grooming": 0.05,
    "ask": 0.01,
    "ticket": 0.03,
}


class IdeaAiError(Exception):
    """An AI helper could not run. `code`: off | no_member | unavailable | cap | not_member | failed | no_repo | bad_answer."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        """Keep the machine-readable `code` and any `extra` details for the API to return."""
        super().__init__(message)
        self.code = code
        self.extra = extra


# ── settings and availability ──────────────────────────────────────────────

SETTING_FIELDS = {
    "enabled",
    "triage_advice",
    "weekly_grooming",
    "ask",
    "read_docs",
    "read_repo",
    "daily_cap",
}


async def get_settings(session: AsyncSession, project_id: str | None) -> IdeaAiSettings:
    """The AI settings of a project (ideas with no project use the workspace defaults); all on until switched off."""
    key = project_id or ""
    row = await session.get(IdeaAiSettings, key)
    if row is None:
        row = IdeaAiSettings(project_id=key)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


async def update_settings(
    session: AsyncSession, project_id: str | None, **fields: Any
) -> IdeaAiSettings:
    """Change AI settings; omitted values stay as they are.

    Raises:
        ValueError: If the daily cap is not a positive number or the project does not exist.
    """
    if project_id and await session.get(Project, project_id) is None:
        raise ValueError(f"Project '{project_id}' not found")
    row = await get_settings(session, project_id)
    for name, value in fields.items():
        if name not in SETTING_FIELDS or value is None:
            continue
        if name == "daily_cap" and (not isinstance(value, (int, float)) or value <= 0):
            raise ValueError("The daily cap must be more than $0")
        setattr(row, name, value)
    row.updated_at = datetime.now(UTC).isoformat()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def spent_today(session: AsyncSession, project_id: str | None) -> float:
    """What the Idea Space helpers cost today (all projects when `project_id` is None)."""
    start = budget.today_start().astimezone(UTC).isoformat()
    stmt = select(AiUsage).where(
        AiUsage.feature.startswith(FEATURE_PREFIX), AiUsage.created_at >= start
    )
    if project_id:
        stmt = stmt.where(AiUsage.project_id == project_id)
    return round(sum(u.cost for u in (await session.exec(stmt)).all()), 4)


async def _board_ai(
    session: AsyncSession, project_id: str | None
) -> tuple[str | None, dict]:
    """The Board AI to use: the project's; for an idea with no project the first project that has one ready."""
    if project_id:
        return project_id, await assist_settings.board_ai(session, project_id)
    last: dict = {"state": "not_configured"}
    for project in (await session.exec(select(Project))).all():
        info = await assist_settings.board_ai(session, project.id)
        if info["state"] == "ready":
            return project.id, info
        last = info if info["state"] != "not_configured" else last
    return None, last


async def status(session: AsyncSession, project_id: str | None) -> dict[str, Any]:
    """Whether AI help is available now, for the UI to show or hide its buttons.

    Returns:
        {state: on | off | no_member | unavailable | cap, message, settings, member, spent_today, cap,
        limited (an idea with no project: no repository), hints}
    """
    row = await get_settings(session, project_id)
    out: dict[str, Any] = {
        "state": "on",
        "message": "",
        "settings": {name: getattr(row, name) for name in sorted(SETTING_FIELDS)},
        "member": None,
        "spent_today": await spent_today(session, project_id),
        "cap": row.daily_cap,
        "limited": project_id is None,
        "hints": COST_HINTS,
    }
    if not row.enabled:
        return {**out, "state": "off", "message": "AI help is off for this project."}
    pid, info = await _board_ai(session, project_id)
    if info["state"] == "not_configured":
        return {
            **out,
            "state": "no_member",
            "message": "Choose an AI member to use AI help. Idea Space can use any AI member that can read this project.",
        }
    out["member"] = info["member"].name if info.get("member") else None
    if info["state"] == "unavailable":
        label = (info.get("status") or {}).get("label", "unavailable")
        return {**out, "state": "unavailable", "message": f"{out['member']}: {label}."}
    if out["spent_today"] >= row.daily_cap:
        return {
            **out,
            "state": "cap",
            "message": f"Idea Space used its ${row.daily_cap:.2f} cap. Suggestions already made are still there.",
        }
    return out


async def _guard(
    session: AsyncSession, project_id: str | None, feature: str | None = None
) -> tuple[str, dict, IdeaAiSettings]:
    """Everything that must hold before a helper calls the model; returns (project id the usage is booked on,
    Board AI info, settings)."""
    st = await status(session, project_id)
    if st["state"] != "on":
        raise IdeaAiError(st["state"], st["message"])
    row = await get_settings(session, project_id)
    if feature == "advice" and not row.triage_advice:
        raise IdeaAiError("off", "Triage advice is off for this project.")
    if feature == "ask" and not row.ask:
        raise IdeaAiError("off", "Ask about ideas is off for this project.")
    pid, info = await _board_ai(session, project_id)
    # the board's own cap and switches also apply (monthly cap, project shared with the Board AI)
    await assist_settings.guard_request(session, pid or "", "idea_helpers")
    return pid or "", info, row


async def _call(
    session: AsyncSession,
    project_id: str | None,
    feature: str,
    prompt: str,
    *,
    extra_system: str,
    target: str | None = None,
    person: str | None = None,
    max_tokens: int = 1200,
) -> tuple[llm.Completion, dict]:
    """Ask the Board AI once, meter the call and write it to the audit log."""
    try:
        pid, info, _ = await _guard(
            session, project_id, feature if feature in ("advice", "ask") else None
        )
    except assist_settings.AssistError as exc:
        raise IdeaAiError("unavailable", str(exc)) from exc
    member, profile = info["member"], info["profile"]
    project = await session.get(Project, pid) if pid else None
    row = await assist_settings.get(session)
    system = prompts.system(
        member.name, project.name if project else "your workspace", row, extra_system
    )
    try:
        out = await llm.complete(
            profile,
            system=system,
            prompt=prompt,
            max_tokens=assist_settings.max_tokens_for(row, profile, max_tokens),
            timeout=90,
        )
    except llm.LlmError as exc:
        await audit.record(
            pid,
            f"idea_ai.{feature}",
            "failed",
            member_id=member.id,
            member_name=member.name,
            on_behalf_of=person,
            target=target,
            detail={"error": exc.kind},
        )
        raise IdeaAiError(
            "failed", f"{member.name} could not answer: {exc}. Nothing was changed."
        ) from exc
    await assist_settings.record_usage(
        session, pid, f"{FEATURE_PREFIX}{feature}", member.id, person, out
    )
    await audit.record(
        pid,
        f"idea_ai.{feature}",
        "ok",
        member_id=member.id,
        member_name=member.name,
        on_behalf_of=person,
        target=target,
        detail={
            "cost": out.cost,
            "tokens_in": out.tokens_in,
            "tokens_out": out.tokens_out,
        },
    )
    return out, {
        "member": member.name,
        "member_id": member.id,
        "cost": out.cost,
        "model": out.model,
    }


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_json(text: str) -> dict[str, Any]:
    """The JSON object in a model answer (bare, or inside a fenced block).

    Raises:
        IdeaAiError: With `bad_answer` when there is none.
    """
    candidates = [m.group(1) for m in _FENCE.finditer(text)] + [text]
    for chunk in candidates:
        start, end = chunk.find("{"), chunk.rfind("}")
        if start >= 0 and end > start:
            try:
                value = json.loads(chunk[start : end + 1])
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    raise IdeaAiError(
        "bad_answer",
        "The AI answered in a form the board could not read. Nothing was changed. Try again.",
    )


def _idea_context(idea: IdeaTicket, body_chars: int = 900) -> str:
    """One idea as data for the model."""
    return ctxb.fence(
        f"idea {idea.id}",
        json.dumps(
            {
                "id": idea.id,
                "title": idea.title,
                "stage": idea.stage,
                "tags": json.loads(idea.tags or "[]"),
                "votes": len(idea.vote_records),
                "text": (idea.body or idea.description)[:body_chars],
                "assumptions": [
                    {"id": a.id, "text": a.text, "impact": a.impact, "status": a.status}
                    for a in idea.assumption_records
                ],
            },
            ensure_ascii=False,
        ),
    )


# ── triage advice ──────────────────────────────────────────────────────────

_ADVICE_FORMAT = """Answer with ONE JSON object and nothing else:
{"action": "keep" | "park" | "merge" | "archive" | "none",
 "reason": "one line, plain words",
 "confidence": "high" | "medium" | "low",
 "merge_into": "IDEA-n or null",   (only for merge, one of the similar ideas listed)
 "park_days": number or null,       (only for park)
 "archive_reason": "already_exists" | "too_big" | "not_now" | "wrong_direction" | "other" | null}
If you are not sure, answer {"action": "none"}: saying nothing is better than guessing."""


async def advise(
    session: AsyncSession, idea_id: str, *, person: str | None = None
) -> IdeaAdvice | None:
    """Suggest Keep, Park, Merge or Archive for an Inbox idea. Never applies anything.

    Returns:
        The stored advice, or None when the AI was not sure and said nothing.

    Raises:
        IdeaAiError: When the helper cannot run (off, no member, cap, failed).
    """
    idea = await space.get_or_raise(session, idea_id)
    if idea.stage != "inbox":
        raise IdeaAiError("failed", "Advice is for ideas in the Inbox.")
    similar = await idea_similarity.find_similar(
        session,
        f"{idea.title} {idea.body or idea.description}",
        exclude_idea_id=idea.id,
        project_id=idea.project_id,
        kinds=("idea", "doc"),
        limit=5,
        min_score=0.2,
    )
    lines = [
        f"- {s['kind']} {s['id']} “{s['title']}” ({int(s['score'] * 100)}% similar"
        + (f", {s.get('stage')}" if s.get("stage") else "")
        + ")"
        for s in similar
    ]
    history = []
    for s in similar:
        if s["kind"] == "idea" and s.get("stage") in ("archived", "parked"):
            other = await session.get(IdeaTicket, s["id"])
            if other is not None:
                history.append(
                    f"{other.id} is {other.stage}: {other.archive_note or other.archive_reason or other.park_note or ''}"
                )
    prompt = "\n".join(
        [
            "Advise what to do with this new idea.",
            _idea_context(idea),
            "Similar ideas, tickets and Docs (a local search found them):",
            "\n".join(lines) or "(none)",
            "What happened to similar ideas before:\n"
            + ("\n".join(history) or "(nothing)"),
            _ADVICE_FORMAT,
        ]
    )
    out, meta = await _call(
        session,
        idea.project_id,
        "advice",
        prompt,
        extra_system="You help sort an Inbox of ideas. You only suggest; a person decides.",
        target=idea.id,
        person=person,
        max_tokens=400,
    )
    data = parse_json(out.text)
    action = str(data.get("action", "none")).lower()
    confidence = str(data.get("confidence", "low")).lower()
    reason = str(data.get("reason", "")).strip()[:300]
    if action not in ADVICE_ACTIONS or confidence == "low" or not reason:
        return None
    target = None
    if action == "merge":
        target = str(data.get("merge_into") or "")
        if target not in {s["id"] for s in similar if s["kind"] == "idea"}:
            return None  # a merge target the search did not offer is a guess
    archive_reason = data.get("archive_reason")
    if action == "archive" and archive_reason not in ARCHIVE_REASONS:
        archive_reason = "other"
    park_days = data.get("park_days") if action == "park" else None
    if park_days is not None:
        try:
            park_days = max(1, min(365, int(park_days)))
        except (TypeError, ValueError):
            park_days = 30
    # one open piece of advice per idea
    for old in (
        await session.exec(
            select(IdeaAdvice).where(
                IdeaAdvice.idea_id == idea.id, IdeaAdvice.state == "open"
            )
        )
    ).all():
        old.state = "ignored"
        session.add(old)
    advice = IdeaAdvice(
        idea_id=idea.id,
        action=action,
        reason=reason,
        confidence=confidence if confidence in CONFIDENCES else "medium",
        target_id=target,
        archive_reason=archive_reason if action == "archive" else None,
        park_days=park_days,
        idea_stamp=idea.updated_at,
        member_id=meta["member_id"],
        cost=out.cost,
    )
    session.add(advice)
    await session.commit()
    await session.refresh(advice)
    return advice


async def advice_for(
    session: AsyncSession, idea_ids: list[str]
) -> list[dict[str, Any]]:
    """Open advice for ideas, each marked `stale` when the idea was edited after the AI read it."""
    if not idea_ids:
        return []
    rows = (
        await session.exec(
            select(IdeaAdvice).where(
                IdeaAdvice.idea_id.in_(idea_ids), IdeaAdvice.state == "open"
            )
        )
    ).all()
    out = []
    for a in rows:
        idea = await session.get(IdeaTicket, a.idea_id)
        target = await session.get(IdeaTicket, a.target_id) if a.target_id else None
        out.append(
            {
                "id": a.id,
                "idea_id": a.idea_id,
                "action": a.action,
                "reason": a.reason,
                "confidence": a.confidence,
                "target_id": a.target_id,
                "target_title": target.title if target else None,
                "archive_reason": a.archive_reason,
                "park_days": a.park_days,
                "cost": a.cost,
                "created_at": a.created_at,
                "stale": bool(idea and idea.updated_at != a.idea_stamp),
            }
        )
    return out


async def set_advice_state(
    session: AsyncSession, advice_id: str, state: str
) -> IdeaAdvice:
    """Mark advice accepted (after the person did what it said) or ignored."""
    if state not in ("accepted", "ignored"):
        raise ValueError("state must be accepted or ignored")
    advice = await session.get(IdeaAdvice, advice_id)
    if advice is None:
        raise ValueError(f"Advice '{advice_id}' not found")
    advice.state = state
    session.add(advice)
    await session.commit()
    await session.refresh(advice)
    return advice


# ── shape an idea ──────────────────────────────────────────────────────────

_SHAPE_FORMATS = {
    "problem": 'Answer with ONE JSON object: {"problem": "2-3 sentences", "idea": "1-3 sentences on what to build"}.',
    "assumptions": 'Answer with ONE JSON object: {"assumptions": [{"text": "We believe …", "impact": "low|medium|high", "cheapest_test": "one sentence"}]} with 2 to 5 assumptions that must be true for this idea to work.',
    "tests": 'Answer with ONE JSON object: {"tests": [{"assumption_id": "<id from the list>", "test": "the cheapest test, one or two sentences"}]} for each assumption that is not validated.',
    "effort": 'Answer with ONE JSON object: {"effort": "Small | Medium | Big", "why": "one or two sentences", "files": ["paths you based it on"]}.',
    "exists": 'Answer with ONE JSON object: {"summary": "what already exists or blocks this, in 2-3 sentences", "items": [{"id": "an id from the list", "why": "one line"}]}.',
}


async def _repo_hint(session: AsyncSession, idea: IdeaTicket) -> str:
    """File names of the linked repository that match words of the idea (read only; no contents)."""
    project = await session.get(Project, idea.project_id) if idea.project_id else None
    if project is None or not project.repo_path:
        raise IdeaAiError(
            "no_repo",
            "There is no repository to look at, so no effort guess. Choose a project with a linked repository.",
        )
    from services import git_repo

    try:
        repo = git_repo.open_repo(project.repo_path)
        files = repo.git.ls_files().splitlines()
    except Exception as exc:  # noqa: BLE001 - any git failure means "no repository to read"
        raise IdeaAiError(
            "no_repo", f"The repository could not be read: {type(exc).__name__}."
        ) from exc
    words = set(idea_similarity.words(f"{idea.title} {idea.body}"))
    hits = [
        f
        for f in files
        if words & set(idea_similarity.words(re.sub(r"[/_.\-]", " ", f)))
    ]
    return f"{len(files)} files in the repository; these look related:\n" + "\n".join(
        hits[:25] or ["(no file name matches)"]
    )


async def shape(
    session: AsyncSession,
    idea_id: str,
    kind: str,
    *,
    question: str | None = None,
    person: str | None = None,
) -> dict[str, Any]:
    """Draft help for the idea page: the problem, assumptions, the cheapest tests, an effort guess, what exists,
    or an answer to a question. Returns drafts a person adds item by item; nothing is written here.

    Returns:
        {kind, ai: True, member, cost, ...kind-specific drafts}

    Raises:
        IdeaAiError: When the helper cannot run, or for `effort` when there is no repository.
    """
    if kind not in SHAPE_KINDS:
        raise ValueError(f"kind must be one of: {', '.join(SHAPE_KINDS)}")
    idea = await space.get_or_raise(session, idea_id)
    settings = await get_settings(session, idea.project_id)
    parts = ["Help shape this idea.", _idea_context(idea, 2400)]
    comments = [c.body for c in idea.comment_records][-5:]
    if comments:
        parts.append(
            "Recent comments:\n"
            + ctxb.fence(f"comments on {idea.id}", "\n".join(comments))
        )
    known: dict[str, dict[str, Any]] = {}
    if kind in ("exists", "problem", "assumptions"):
        kinds = ("idea", "ticket") + (("doc",) if settings.read_docs else ())
        found = await idea_similarity.find_similar(
            session,
            f"{idea.title} {idea.body or idea.description}",
            exclude_idea_id=idea.id,
            project_id=idea.project_id,
            kinds=kinds,
            limit=8,
            min_score=0.15,
        )
        known = {f["id"]: f for f in found}
        parts.append(
            "Similar ideas, tickets and Docs (a local search found them):\n"
            + (
                "\n".join(f"- {f['kind']} {f['id']} “{f['title']}”" for f in found)
                or "(none)"
            )
        )
    if kind == "effort":
        if not settings.read_repo:
            raise IdeaAiError(
                "no_repo",
                "Reading the repository is off for this project (Settings → Idea Space).",
            )
        parts.append(await _repo_hint(session, idea))
    if kind == "ask":
        if not (question or "").strip():
            raise ValueError("question cannot be empty")
        parts.append("Question:\n" + ctxb.fence("question", question or ""))
        parts.append("Answer in Markdown, short.")
    else:
        parts.append(_SHAPE_FORMATS[kind])
    out, meta = await _call(
        session,
        idea.project_id,
        "shape",
        "\n\n".join(parts),
        extra_system="You help a person shape an idea. You only draft; every item is added by the person.",
        target=idea.id,
        person=person,
        max_tokens=1500,
    )
    result: dict[str, Any] = {"kind": kind, "ai": True, **meta}
    if kind == "ask":
        result["answer"] = out.text.strip()
        return result
    data = parse_json(out.text)
    if kind == "problem":
        result.update(
            problem=str(data.get("problem", "")).strip(),
            idea=str(data.get("idea", "")).strip(),
        )
    elif kind == "assumptions":
        items = []
        for a in data.get("assumptions") or []:
            text = str((a or {}).get("text", "")).strip()[:500]
            if text:
                impact = (a or {}).get("impact")
                items.append(
                    {
                        "text": text,
                        "impact": impact
                        if impact in ("low", "medium", "high")
                        else "medium",
                        "cheapest_test": str(
                            (a or {}).get("cheapest_test", "")
                        ).strip(),
                    }
                )
        result["assumptions"] = items[:5]
    elif kind == "tests":
        ids = {a.id for a in idea.assumption_records}
        result["tests"] = [
            {
                "assumption_id": t["assumption_id"],
                "test": str(t.get("test", "")).strip(),
            }
            for t in (data.get("tests") or [])
            if isinstance(t, dict)
            and t.get("assumption_id") in ids
            and str(t.get("test", "")).strip()
        ]
    elif kind == "effort":
        result.update(
            effort=str(data.get("effort", "")).strip()[:40],
            why=str(data.get("why", "")).strip(),
            files=[str(f) for f in (data.get("files") or [])][:10],
        )
    elif kind == "exists":
        result["summary"] = str(data.get("summary", "")).strip()
        result["items"] = [
            {**known[i["id"]], "why": str(i.get("why", "")).strip()}
            for i in (data.get("items") or [])
            if isinstance(i, dict) and i.get("id") in known
        ]
        result["found"] = list(known.values())
    return result


async def prepare_ticket(
    session: AsyncSession, idea_id: str, *, person: str | None = None
) -> dict[str, Any]:
    """Draft the ticket text, a split into sub-tickets and acceptance criteria from what the idea learned.

    Returns:
        {title, description, acceptance_criteria [..], sub_tickets [..], ai, member, cost}; the person edits
        everything before Create.
    """
    idea = await space.get_or_raise(session, idea_id)
    validated = [a.text for a in idea.assumption_records if a.status == "validated"]
    prompt = "\n\n".join(
        [
            "Prepare a ticket from this idea.",
            _idea_context(idea, 3000),
            "Already confirmed (validated assumptions):\n"
            + ("\n".join(f"- {t}" for t in validated) or "(none)"),
            'Answer with ONE JSON object: {"title": "short", "description": "Markdown: Problem, then what to build", '
            '"acceptance_criteria": ["testable sentence", ...], "sub_tickets": ["optional split, at most 5 titles"]}.',
        ]
    )
    out, meta = await _call(
        session,
        idea.project_id,
        "ticket",
        prompt,
        extra_system="You prepare ticket drafts. A person edits them before anything is created.",
        target=idea.id,
        person=person,
        max_tokens=1500,
    )
    data = parse_json(out.text)
    return {
        "title": str(data.get("title", "")).strip()[:200],
        "description": str(data.get("description", "")).strip(),
        "acceptance_criteria": [
            str(a).strip()
            for a in (data.get("acceptance_criteria") or [])
            if str(a).strip()
        ][:10],
        "sub_tickets": [
            str(a).strip() for a in (data.get("sub_tickets") or []) if str(a).strip()
        ][:5],
        "ai": True,
        **meta,
    }


# ── ask about ideas ────────────────────────────────────────────────────────

IDEA_REF = re.compile(r"\bIDEA-\d+\b")


async def ask(
    session: AsyncSession,
    question: str,
    *,
    project_id: str | None = None,
    scope: str = "project",
    person: str | None = None,
) -> dict[str, Any]:
    """Answer a question about the ideas in view ("what should we test next?"); only the ideas the question needs
    are sent, and the answer lists the ideas it used.

    Returns:
        {answer, sources [{id, title}], ideas_read, ai, member, cost}
    """
    if not question.strip():
        raise ValueError("question cannot be empty")
    ideas = await space.list_ideas(
        session, project_id=project_id, scope=scope, sort="updated"
    )
    ideas = [i for i in ideas if i.stage != "archived"] or ideas
    ranked = idea_similarity.rank(
        question,
        [
            {
                "id": i.id,
                "text": f"{i.title} {i.title} {i.body} "
                + " ".join(a.text for a in i.assumption_records),
            }
            for i in ideas
        ],
        min_score=0.01,
    )
    wanted = [r["id"] for r in ranked[:12]]
    for (
        i
    ) in ideas:  # recent ones fill the rest, so "what is stale?" still sees something
        if len(wanted) >= 12:
            break
        if i.id not in wanted:
            wanted.append(i.id)
    chosen = [i for i in ideas if i.id in wanted]
    ctx = "\n".join(_idea_context(i, 400) for i in chosen)
    prompt = "\n\n".join(
        [
            f"Answer a question about the ideas of a team ({len(ideas)} ideas; you see the {len(chosen)} most relevant).",
            ctx,
            "Question:\n" + ctxb.fence("question", question),
            "Answer in Markdown, short. Mention ideas by id (IDEA-n) so the board can link them. If the ideas do not say, say you do not know.",
        ]
    )
    out, meta = await _call(
        session,
        project_id,
        "ask",
        prompt,
        extra_system="You answer questions about the team's ideas. You never change anything.",
        person=person,
        max_tokens=900,
    )
    by_id = {i.id: i for i in chosen}
    used = [i for i in dict.fromkeys(IDEA_REF.findall(out.text)) if i in by_id]
    return {
        "answer": out.text.strip(),
        "sources": [{"id": i, "title": by_id[i].title} for i in used],
        "ideas_read": len(chosen),
        "ai": True,
        **meta,
    }


# ── weekly grooming ────────────────────────────────────────────────────────


async def findings(
    session: AsyncSession, project_id: str | None
) -> list[dict[str, Any]]:
    """What the weekly digest points out, worked out locally (no model): stale ideas, ideas that look the same,
    tests with no owner, parked ideas due and ideas waiting in the Inbox."""
    scope = "project" if project_id else "all"
    ideas = await space.list_ideas(session, project_id=project_id, scope=scope)
    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []

    def age(i: IdeaTicket) -> int:
        return (now - parse_iso(i.updated_at)).days if parse_iso(i.updated_at) else 0

    stale = [
        i
        for i in ideas
        if i.stage in ("exploring", "ready") and age(i) >= space.STALE_DAYS
    ]
    if stale:
        out.append(
            {
                "kind": "stale",
                "idea_ids": [i.id for i in stale],
                "text": f"{len(stale)} {'idea is' if len(stale) == 1 else 'ideas are'} stale (no change for {space.STALE_DAYS} days or more): "
                + ", ".join(i.title for i in stale[:6])
                + ".",
            }
        )
    open_ideas = [i for i in ideas if i.stage in ("inbox", "exploring", "ready")]
    pairs = []
    for n, a in enumerate(open_ideas):
        rest = [
            {"id": b.id, "title": b.title, "text": f"{b.title} {b.title} {b.body}"}
            for b in open_ideas[n + 1 :]
        ]
        for hit in idea_similarity.rank(
            f"{a.title} {a.title} {a.body}", rest, min_score=0.5
        )[:1]:
            pairs.append((a, hit))
    if pairs:
        out.append(
            {
                "kind": "merge",
                "idea_ids": [x for a, h in pairs for x in (a.id, h["id"])],
                "text": f"{len(pairs)} {'pair looks' if len(pairs) == 1 else 'pairs look'} the same: "
                + "; ".join(f"{a.title} / {h['title']}" for a, h in pairs[:4])
                + ".",
            }
        )
    owners = []
    for i in ideas:
        for a in i.assumption_records:
            if a.test_ticket_id and a.status in ("untested", "testing"):
                t = await session.get(Ticket, a.test_ticket_id)
                if (
                    t is not None
                    and not t.assignee
                    and t.status not in ("done", "wont_do")
                ):
                    owners.append(t.id)
    if owners:
        out.append(
            {
                "kind": "tests",
                "idea_ids": [],
                "text": f"{len(owners)} {'test has' if len(owners) == 1 else 'tests have'} no owner: {', '.join(owners[:8])}.",
            }
        )
    soon = (now + timedelta(days=7)).date().isoformat()
    due = [
        i
        for i in ideas
        if i.stage == "parked" and i.park_until and i.park_until <= soon
    ]
    if due:
        out.append(
            {
                "kind": "parked",
                "idea_ids": [i.id for i in due],
                "text": f"{len(due)} parked {'idea is' if len(due) == 1 else 'ideas are'} due: "
                + ", ".join(i.title for i in due[:6])
                + ".",
            }
        )
    waiting = [i for i in ideas if i.stage == "inbox" and age(i) >= space.WAITING_DAYS]
    if waiting:
        out.append(
            {
                "kind": "waiting",
                "idea_ids": [i.id for i in waiting],
                "text": f"{len(waiting)} {'idea has' if len(waiting) == 1 else 'ideas have'} waited in the Inbox more than {space.WAITING_DAYS} days.",
            }
        )
    return out


async def groom(
    session: AsyncSession,
    project_id: str | None,
    *,
    person: str | None = "system",
    use_ai: bool = True,
) -> IdeaDigest:
    """Write the weekly digest of the Idea Space and keep it. The findings are local; when AI help is on, the
    Board AI adds one short sentence. A digest is not a notification: nobody is pinged.

    Returns:
        The stored digest.
    """
    items = await findings(session, project_id)
    ideas = await space.list_ideas(
        session, project_id=project_id, scope="project" if project_id else "all"
    )
    when = datetime.now(UTC).strftime("%A %H:%M")
    lines = [f"**Weekly digest** · {when} · read {len(ideas)} ideas", ""]
    lines += [f"- {i['text']}" for i in items] or [
        "- Nothing needs attention this week."
    ]
    ai, cost, member_id = False, 0.0, None
    row = await get_settings(session, project_id)
    if use_ai and items and row.enabled and row.weekly_grooming:
        try:
            out, meta = await _call(
                session,
                project_id,
                "grooming",
                "Write one or two plain sentences that tell the team what to do first this week, from these findings:\n"
                + ctxb.fence("findings", "\n".join(i["text"] for i in items)),
                extra_system="You groom the team's Idea Space. You write a short note; you change nothing.",
                person=person,
                max_tokens=250,
            )
            lines += ["", out.text.strip()]
            ai, cost, member_id = True, out.cost, meta["member_id"]
        except IdeaAiError as exc:
            log.info("Digest without AI: %s", exc)
    digest = IdeaDigest(
        project_id=project_id or "",
        text="\n".join(lines),
        items=json.dumps(items),
        ai=ai,
        member_id=member_id,
        cost=cost,
        ideas_read=len(ideas),
    )
    session.add(digest)
    await session.commit()
    await session.refresh(digest)
    return digest


async def latest_digest(
    session: AsyncSession, project_id: str | None
) -> IdeaDigest | None:
    """The newest digest of a project (or of ideas with no project)."""
    rows = (
        await session.exec(
            select(IdeaDigest).where(IdeaDigest.project_id == (project_id or ""))
        )
    ).all()
    return max(rows, key=lambda d: d.created_at, default=None)


async def run_due_digests(session: AsyncSession, now: datetime | None = None) -> int:
    """Write the weekly digest of every project that has it switched on, on Mondays from 9:00 local time, once a
    week. Called by the hourly loop; returns how many were written."""
    now = now or datetime.now().astimezone()
    if now.weekday() != 0 or now.hour < 9:
        return 0
    written = 0
    for s in (await session.exec(select(IdeaAiSettings))).all():
        if not (s.enabled and s.weekly_grooming):
            continue
        last = await latest_digest(session, s.project_id or None)
        if last and (datetime.now(UTC) - parse_iso(last.created_at)) < timedelta(
            days=6
        ):
            continue
        await groom(session, s.project_id or None)
        written += 1
    return written


async def digest_loop(session_factory) -> None:
    """Check once an hour whether a weekly digest is due, until cancelled."""
    import asyncio

    while True:
        try:
            async with session_factory() as session:
                await run_due_digests(session)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a failed digest must not stop the loop
            log.exception("Idea digest failed")
        await asyncio.sleep(3600)


async def member_names(session: AsyncSession, project_id: str | None) -> list[str]:
    """Names of the project's AI members, for the settings page."""
    if not project_id:
        return []
    rows = await session.exec(
        select(Member).where(Member.project_id == project_id, Member.kind == "ai")
    )
    return [m.name for m in rows.all()]
