"""What an AI team is told about a ticket before a run, with untrusted text fenced.

Trust comes from who wrote the text, never from its wording: project members are trusted, other AI members are
data only, anything else (agent tools, imports) is untrusted. AI v2 has no permission layer: fencing lowers the
risk, and the run's short deny list and its own worktree limit what a fooled model can do.
"""

import json
from dataclasses import dataclass

from .injection import trust_of
from .secrets import redact

STATUS_LABELS = {
    "backlog": "Backlog",
    "todo": "To Do",
    "in-progress": "In Progress",
    "review": "Review",
    "testing": "Testing",
    "done": "Done",
    "wont_do": "Won't Do",
    "none": "None",
}


@dataclass
class RunContext:
    """Who is acting while a run's tool calls are handled."""

    run_id: str
    member_id: str
    member_name: str
    project_id: str
    ticket_id: str
    on_behalf_of: str
    mode: str  # work | ask
    trigger: str = ""
    # A Board AI chat answer that acts by risk tier (D23): its board tools only read, and its changes go through the
    # chat's actions block, where the board applies them by tier with one Undo
    acts_by_tier: bool = False

    def activity(self) -> dict:
        """Attribution stored on activity entries."""
        return {
            "member_id": self.member_id,
            "on_behalf_of": self.on_behalf_of,
            "run_id": self.run_id,
        }


def _fence(source: str, text: str) -> str:
    safe = (text or "").replace("</untrusted>", "<\\/untrusted>")
    return f'<untrusted source="{source}">\n{safe}\n</untrusted>'


def ticket_block(
    ticket,
    ai_names: set[str],
    *,
    comments: bool = True,
    criteria: bool = True,
    comment_limit: int = 20,
    sub_tickets: list | None = None,
    humans: set[str] | None = None,
    allow_external: bool = False,
) -> str:
    """The ticket as the agent sees it: fields trusted, AI-written and unknown-author text fenced. With `humans`
    given, a comment by anyone who is not a project member is untrusted: it is fenced and shown only when the
    agent allows external sources."""
    lines = [
        f'<ticket id="{ticket.id}" trusted>',
        f"Title: {ticket.title}",
        f"Type: {ticket.type} · Priority: {ticket.priority} · Status: {STATUS_LABELS.get(ticket.status, ticket.status)}",
    ]
    if ticket.estimate is not None:
        lines.append(f"Estimate: {ticket.estimate}")
    lines.append("Description:")
    lines.append(redact(ticket.description or "(empty)"))
    if criteria:
        acs = json.loads(ticket.acceptance_criteria or "[]")
        if acs:
            lines.append("Acceptance criteria:")
            for i, ac in enumerate(acs, 1):
                lines.append(
                    f"  {i}. [{'x' if ac.get('done') else ' '}] {ac.get('text', '')}"
                )
    if sub_tickets:
        lines.append("Sub-tickets:")
        for sub in sub_tickets:
            lines.append(
                f"  - {sub.id} {sub.title} ({STATUS_LABELS.get(sub.status, sub.status)})"
            )
    lines.append("</ticket>")
    if comments:
        items = [
            c for c in json.loads(ticket.comments or "[]") if not c.get("deleted_at")
        ]
        items = items[-comment_limit:]
        if items:
            lines.append("Recent comments (oldest first):")
            held_back = 0
            for c in items:
                author = c.get("author") or "user"
                text = redact(c.get("text", ""))
                trust = (
                    trust_of(author, humans, ai_names)
                    if humans is not None
                    else ("data_only" if author in ai_names else "trusted")
                )
                if author in ai_names:
                    lines.append(_fence(f"comment · AI member {author}", text))
                elif author == "agent":
                    lines.append(_fence("comment · external agent", text))
                elif trust == "untrusted":
                    if allow_external:
                        lines.append(_fence(f"comment · guest {author}", text))
                    else:
                        held_back += 1
                else:
                    who = "board user" if author == "user" else author
                    lines.append(f"- {who} ({c.get('at', '')[:16]}): {text}")
            if held_back:
                lines.append(
                    f"({held_back} comment(s) from outside the project are not shown to you: this AI member does not "
                    "read external sources.)"
                )
    return "\n".join(lines)


def comments_for_reader(
    raw: list[dict],
    ai_names: set[str],
    humans: set[str] | None,
    allow_external: bool,
) -> tuple[list[dict], int]:
    """The comments of a ticket as an AI may read them through a tool (`get_ticket`): deleted ones left out, secrets
    redacted, text by other AI members, agents and outsiders fenced as data, outsiders' comments held back unless the
    member reads external sources. Returns (comments, how many were held back). The prompt's `ticket_block` applies
    the same rules to the comments it prints."""
    out: list[dict] = []
    held_back = 0
    for c in raw:
        if not isinstance(c, dict) or c.get("deleted_at"):
            continue
        author = c.get("author") or "user"
        text = redact(c.get("text") or "")
        if humans is not None and author not in ai_names and author != "agent":
            outsider = trust_of(author, humans, ai_names) == "untrusted"
        else:
            outsider = False
        if author in ai_names:
            text = _fence(f"comment · AI member {author}", text)
        elif author == "agent":
            text = _fence("comment · external agent", text)
        elif outsider:
            if not allow_external:
                held_back += 1
                continue
            text = _fence(f"comment · guest {author}", text)
        out.append({**c, "text": text})
    return out, held_back


def instruction_block(
    ctx: RunContext, instruction: str, person_trusted: bool = True
) -> str:
    """The request that started the run."""
    if not instruction.strip():
        if ctx.mode == "ask":
            return "Answer the latest question in the comments."
        return f"{ctx.on_behalf_of} assigned {ctx.ticket_id} to you. Do the work it describes."
    if person_trusted:
        return f'<instruction from="{ctx.on_behalf_of}" trusted>\n{redact(instruction)}\n</instruction>'
    return _fence("AI member mention", redact(instruction))
