"""What an API-key agent is told before step 1: the system prompt with its ``{{variables}}`` filled in and the context
sources the person switched on (design/screens/ai-provider-config.md, D1 and D5).

The same code builds the real prompt of a run and the preview / dry run of the Configuration tab, so what the
person sees is what the model gets.
"""

import json

from sqlmodel import select

import services.docs as svc_docs
from models import AiMember, Member, Project, Ticket

from . import config_model as cm
from .context import (
    RunContext,
    _fence,
    instruction_block,
    rules_block,
    ticket_block,
)
from .secrets import redact
from .store import ai_names, get_settings

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
    out, seen = [], set()
    for row in rows:
        if row["page_id"] in seen:
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
) -> dict:
    """The system prompt and the first user message, plus the parts for the preview and the token estimates."""
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

    parts: list[str] = []
    if include_context:
        if "ticket" not in used:
            parts.append(ticket_text)
        if comments_text and "comments" not in used:
            parts.append(comments_text)
        if docs and "docs" not in used:
            parts.append("Linked docs:\n" + docs_text)
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
