"""What an API-key agent is told before step 1: the system prompt with its ``{{variables}}`` filled in and the context
sources the person switched on (design/screens/ai-provider-config.md, D1 and D5).

The same code builds the real prompt of a run and the preview / dry run of the Configuration tab, so what the
person sees is what the model gets.
"""

import json

from sqlmodel import col, select

import services.docs as svc_docs
from models import AiMember, AiRun, Member, Project, Ticket

from . import config_model as cm
from .context import (
    RunContext,
    _fence,
    activity_block,
    instruction_block,
    rules_block,
    ticket_block,
)
from .secrets import redact
from .store import ai_names, get_settings

# "Activity since your last run": how many of the agent's own earlier runs and of other members' runs it is told
# about, and the most it may cost in tokens (the oldest runs are dropped first)
OWN_RUNS = 3
OTHER_RUNS = 10
ACTIVITY_TOKENS = 1500
# What an agent that stopped to ask a question is reminded of when it resumes (the newest steps win)
EARLIER_WORK_TOKENS = 2500

FORMAT_RULES = {
    "short": "Reply format: short. Verdict first, then at most 5 lines.",
    "detailed": "Reply format: detailed. Verdict first, then the reasoning, evidence and next steps, in Markdown.",
    "plain": "Reply format: plain text, no Markdown, no tables, no code fences.",
}


async def linked_docs(session, ticket: Ticket, config: dict) -> list[dict]:
    """The docs tied to the ticket (mentioned, linked by hand, or mentioning it), cut to the limits of the config:
    [{page_id, title, text, tokens, cut}]."""
    ctx = config["context"]
    limit = int(ctx.get("doc_limit") or 0)
    if limit <= 0:
        return []
    try:
        rows = await svc_docs.docs_for_ticket(session, ticket.id)
    except Exception:  # noqa: BLE001 - docs are optional context
        return []
    from services.docs_ai import access as docs_ai_access

    denied = await docs_ai_access.hidden_page_ids(session, ticket.project_id)
    out, seen = [], set()
    for row in rows:
        if row["page_id"] in seen or row["page_id"] in denied:
            continue
        seen.add(row["page_id"])
        try:
            page = await svc_docs.page_detail(session, row["page_id"])
        except Exception:  # noqa: BLE001
            continue
        text = redact(page.get("markdown") or "")
        cap = int(ctx.get("doc_tokens") or 4000) * 4
        cut = len(text) > cap
        out.append(
            {
                "page_id": row["page_id"],
                "title": page.get("title") or row["title"],
                "text": text[:cap] + ("\n[…cut]" if cut else ""),
                "tokens": cm.estimate_tokens(text[:cap]),
                "cut": cut,
            }
        )
        if len(out) >= limit:
            break
    return out


def docs_block(docs: list[dict]) -> str:
    """The linked docs as untrusted, fenced text."""
    if not docs:
        return "(no linked docs)"
    return "\n\n".join(_fence(f"doc · {d['title']}", d["text"]) for d in docs)


async def activity_for(
    session, ticket_id: str, member: Member, run: AiRun | None = None
) -> str:
    """The board's record of this ticket for an API agent, whose chat starts empty on every run: its own earlier
    runs here and the other members' runs since its last one (so a PM can answer "what has Dev done?"). Same
    fenced `<activity>` block the Claude Code path gets, cut to `ACTIVITY_TOKENS` (oldest runs first). Without
    `run` (the preview) it is the state right now."""
    own_stmt = select(AiRun).where(
        AiRun.ticket_id == ticket_id, AiRun.member_id == member.id
    )
    if run is not None:
        own_stmt = own_stmt.where(AiRun.id != run.id, AiRun.queued_at < run.queued_at)
    own = list(
        (
            await session.exec(
                own_stmt.order_by(col(AiRun.queued_at).desc()).limit(OWN_RUNS)
            )
        ).all()
    )
    other_stmt = select(AiRun).where(
        AiRun.ticket_id == ticket_id, AiRun.member_id != member.id
    )
    if run is not None:
        other_stmt = other_stmt.where(AiRun.id != run.id)
    if own:
        other_stmt = other_stmt.where(AiRun.queued_at > own[0].queued_at)
    others = list(
        (
            await session.exec(
                other_stmt.order_by(col(AiRun.queued_at).desc()).limit(OTHER_RUNS)
            )
        ).all()
    )
    rows = sorted([*own, *others], key=lambda r: r.queued_at)
    if not rows:
        return ""
    names = {
        m.id: m.name
        for m in (
            await session.exec(
                select(Member).where(col(Member.id).in_({r.member_id for r in rows}))
            )
        ).all()
    }
    names[member.id] = f"{member.name} (you)"
    since = own[0].queued_at if own else None
    while rows:
        block = activity_block(rows, names, since=since)
        if cm.estimate_tokens(block) <= ACTIVITY_TOKENS or len(rows) == 1:
            return block
        rows = rows[1:]
    return ""


def earlier_work(steps: list[dict], cap_tokens: int = EARLIER_WORK_TOKENS) -> str:
    """What the agent already did in this run, from its recorded steps (the tool calls with their results and the
    latest compaction summary), for a run that resumes after a question: its chat starts empty again, so without
    this the work done before the question would be lost. The newest steps are kept within `cap_tokens`; the
    results are board data and are fenced."""
    lines: list[str] = []
    summary = ""
    for st in steps:
        io = st.get("io") if isinstance(st.get("io"), dict) else None
        if st.get("kind") == "compact" and st.get("summary"):
            summary = str(st["summary"])
            lines = []  # everything before it is inside the summary
        elif io:
            lines.append(
                f"- {io.get('name', 'tool')}({io.get('in', '')}) -> {io.get('out', '')}"
            )
        elif st.get("kind") == "model" and st.get("said"):
            lines.append(f"- you said: {st['said']}")
    if not lines and not summary:
        return ""
    budget_chars = cap_tokens * 4
    kept: list[str] = []
    for line in reversed(lines):
        if sum(len(x) + 1 for x in kept) + len(line) > budget_chars:
            break
        kept.append(line)
    kept.reverse()
    cut = len(lines) - len(kept)
    parts = []
    if summary:
        parts.append("Summary of your earlier work in this run:\n" + summary)
    if kept:
        parts.append(
            (f"({cut} older tool call(s) left out.)\n" if cut else "") + "\n".join(kept)
        )
    body = "\n\n".join(parts)
    return (
        "Your own earlier work in this same run, before you asked the question (recorded by the board; "
        "it already happened, do not repeat it):\n"
        + _fence("your earlier tool calls", body)
    )


async def compose(
    session,
    profile: AiMember,
    member: Member,
    ticket: Ticket,
    project: Project | None,
    config: dict,
    *,
    ctx: RunContext,
    instruction: str = "",
    include_context: bool = True,
    trusted_instruction: bool = True,
    run: AiRun | None = None,
) -> dict:
    """The system prompt and the first user message, plus the parts for the preview and the token estimates.
    With `run`, the activity block is relative to that run; without it (preview, dry run) to now."""
    settings = await get_settings(session, ticket.project_id)
    names = await ai_names(session, ticket.project_id)
    cctx = config["context"]
    limit = int(cctx.get("comment_limit") or 20)
    subs = (
        (await session.exec(select(Ticket).where(Ticket.parent_id == ticket.id))).all()
        if cctx.get("sub_tickets")
        else None
    )
    humans = {
        m.name
        for m in (
            await session.exec(
                select(Member).where(
                    Member.project_id == ticket.project_id, Member.kind == "human"
                )
            )
        ).all()
    }
    full = ticket_block(
        ticket,
        names,
        comments=bool(cctx.get("comments", True)),
        criteria=cctx.get("criteria", True),
        comment_limit=limit,
        sub_tickets=subs,
        humans=humans,
        allow_external=profile.allow_external,
    )
    # The comments come last in the block; they can be placed on their own with {{comments}}
    marker = "Recent comments (oldest first):"
    ticket_text, _, rest = full.partition("\n" + marker)
    comments_text = marker + rest if rest else ""
    docs = await linked_docs(session, ticket, config) if cctx.get("linked_docs") else []
    docs_text = docs_block(docs)

    raw = cm.expand_includes(
        config.get("instructions") or "", config.get("snippets") or []
    )
    used = cm.used_variables(raw)
    values = {
        "ticket": ticket_text,
        "project": project.name if project else "",
        "comments": comments_text or "(no comments)",
        "docs": docs_text,
    }
    system = rules_block(
        ctx,
        profile,
        settings,
        project_name=project.name if project else "",
        ticket_status=ticket.status,
    )
    if profile.persona.strip():
        system += f"\n\nRole / persona (set by the project's people):\n{profile.persona.strip()}"
    rendered = cm.render_prompt(raw, values).strip()
    if rendered:
        system += f"\n\nProject instructions:\n{rendered}"
    fmt = FORMAT_RULES.get((config.get("output") or {}).get("comment_format"), "")
    if fmt:
        system += f"\n\n{fmt}"

    activity = (
        await activity_for(session, ticket.id, member, run) if include_context else ""
    )
    parts: list[str] = []
    if include_context:
        if "ticket" not in used:
            parts.append(ticket_text)
        if comments_text and "comments" not in used:
            parts.append(comments_text)
        if docs and "docs" not in used:
            parts.append("Linked docs:\n" + docs_text)
        if activity:
            parts.append(activity)
    else:
        parts.append(f'<ticket id="{ticket.id}" trusted>Title: {ticket.title}</ticket>')
    parts.append(
        instruction_block(ctx, instruction, person_trusted=trusted_instruction)
    )
    user = "\n\n".join(parts)
    return {
        "system": system,
        "user": user,
        "used": sorted(used),
        "sources": {
            "ticket": cm.estimate_tokens(ticket_text),
            "docs": sum(d["tokens"] for d in docs),
            "activity": cm.estimate_tokens(activity),
            "comments": cm.estimate_tokens(comments_text),
            "sub_tickets": cm.estimate_tokens(
                "\n".join(f"- {t.id} {t.title} ({t.status})" for t in subs or [])
            ),
        },
        "docs": [
            {
                "page_id": d["page_id"],
                "title": d["title"],
                "tokens": d["tokens"],
                "cut": d["cut"],
            }
            for d in docs
        ],
        "prompt_tokens": cm.estimate_tokens(rendered),
    }


async def build(
    session,
    run,
    profile: AiMember,
    member: Member,
    config: dict,
    *,
    resume_note: str | None,
):
    """(system, user message, config) of a real run (called from runs._build_prompt)."""
    from . import runs

    ticket = await session.get(Ticket, run.ticket_id)
    project = await session.get(Project, run.project_id)
    ctx = await runs._ctx_for(session, run)
    names = await ai_names(session, run.project_id)
    started_by_ai = run.started_by in names or bool(json.loads(run.chain or "[]"))
    out = await compose(
        session,
        profile,
        member,
        ticket,
        project,
        config,
        ctx=ctx,
        instruction=run.instruction,
        include_context=run.include_context,
        trusted_instruction=not started_by_ai,
        run=run,
    )
    if resume_note:
        return out["system"], resume_note, config
    return out["system"], out["user"], config


async def preview(
    session, profile: AiMember, member: Member, config: dict, ticket_id: str, by: str
) -> dict:
    """The prompt as a run on `ticket_id` would send it, with the draft configuration."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None or ticket.project_id != profile.project_id:
        raise ValueError("Pick a ticket of this project.")
    project = await session.get(Project, ticket.project_id)
    ctx = RunContext(
        run_id="preview",
        member_id=member.id,
        member_name=member.name,
        project_id=ticket.project_id,
        ticket_id=ticket.id,
        on_behalf_of=by,
        mode="work",
    )
    out = await compose(session, profile, member, ticket, project, config, ctx=ctx)
    out["system_tokens"] = cm.estimate_tokens(out["system"])
    out["user_tokens"] = cm.estimate_tokens(out["user"])
    out["ticket_id"] = ticket.id
    return out
