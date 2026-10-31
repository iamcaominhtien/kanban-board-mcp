"""What the Board AI reads for a request: tickets, comments, activity and docs in a scope, within a token budget,
with private docs left out and every piece of source text fenced as untrusted (design/screens/ai-board-assistant.md,
B8, I9–I11)."""

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsDraft, DocsPage, DocsVersion, Member, Project, Ticket

from ..context import STATUS_LABELS
from ..llm import estimate_tokens
from ..secrets import redact
from . import settings as svc_settings

# Token budgets per scope (B8: "~4k", "~20k", "slower · ~5× cost")
BUDGETS = {"ticket": 8000, "doc": 8000, "project": 20000, "all": 60000}
TRUNCATE_AT = 8000  # a single ticket longer than this is cut (I9)
ACTIVITY_DAYS = 14

# Wording that reads like instructions to a model (I10). Flagged and fenced, never obeyed.
_INJECTION = re.compile(
    r"(ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?)"
    r"|disregard (all |any )?(previous|prior|your) (instructions|rules)"
    r"|you are now\b|new instructions:|system prompt|act as (an? )?(admin|system)"
    r"|move (every|all) tickets?\b|delete (every|all) tickets?\b)",
    re.IGNORECASE,
)


@dataclass
class Context:
    """The text sent, and what it was made of."""

    text: str = ""
    tickets: int = 0
    docs: int = 0
    comments: int = 0
    items: list[dict] = field(default_factory=list)
    truncated: dict | None = None
    injections: list[dict] = field(default_factory=list)
    private_skipped: list[dict] = field(default_factory=list)
    steps: list[str] = field(default_factory=list)
    names: dict[str, str] = field(default_factory=dict)  # member id -> name
    # A scope that is not made of tickets and docs (an idea) words its own "Based on …" line
    label: str = ""

    def summary(self) -> dict:
        """Stored on the answer: the context line, "See what was sent" and the state chips."""
        parts = []
        if self.tickets:
            parts.append(f"{self.tickets} ticket{'s' if self.tickets != 1 else ''}")
        if self.comments:
            parts.append(f"{self.comments} comment{'s' if self.comments != 1 else ''}")
        if self.docs:
            parts.append(f"{self.docs} doc{'s' if self.docs != 1 else ''}")
        return {
            "label": self.label
            or "Based on " + (" · ".join(parts) if parts else "no board data"),
            "tickets": self.tickets,
            "docs": self.docs,
            "comments": self.comments,
            "items": self.items[:200],
            "truncated": self.truncated,
            "injections": self.injections,
            "private_skipped": self.private_skipped,
            "tokens": estimate_tokens(self.text),
        }


def looks_like_instructions(text: str) -> str | None:
    """The phrase that looks like an instruction to a model, if any."""
    m = _INJECTION.search(text or "")
    return m.group(0) if m else None


def fence(source: str, text: str) -> str:
    """Source text the model must treat as data."""
    safe = redact(text or "").replace("</untrusted>", "<\\/untrusted>")
    return f'<untrusted source="{source}">\n{safe}\n</untrusted>'


async def doc_text(session: AsyncSession, page: DocsPage) -> str:
    """A page's published Markdown, or its newest draft when it was never published."""
    if page.version:
        v = (
            await session.exec(
                select(DocsVersion).where(
                    DocsVersion.page_id == page.id, DocsVersion.version == page.version
                )
            )
        ).first()
        if v:
            return v.markdown or ""
    d = (
        await session.exec(
            select(DocsDraft)
            .where(DocsDraft.page_id == page.id)
            .order_by(col(DocsDraft.updated_at).desc())
        )
    ).first()
    return d.markdown if d else ""


def _ago(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        then = datetime.fromisoformat(iso)
    except ValueError:
        return ""
    if then.tzinfo is None:
        then = then.replace(tzinfo=UTC)
    days = (datetime.now(UTC) - then).days
    return "today" if days <= 0 else f"{days}d ago"


def _list(value: str | None) -> list:
    try:
        out = json.loads(value or "[]")
    except ValueError:
        return []
    return out if isinstance(out, list) else []


def ticket_line(t: Ticket, names: dict[str, str]) -> str:
    """One line per ticket for project scope (fields are board data, the title is source text)."""
    bits = [
        f"{t.id}",
        f"[{STATUS_LABELS.get(t.status, t.status)}]",
        f"{t.type}/{t.priority}",
        f"assignee: {names.get(t.assignee or '', 'none')}",
    ]
    if t.estimate is not None:
        bits.append(f"estimate {t.estimate:g}")
    if t.due_date:
        bits.append(f"due {t.due_date}")
    if t.parent_id:
        bits.append(f"parent {t.parent_id}")
    blocked = _list(t.blocked_by)
    if blocked:
        bits.append("blocked by " + ", ".join(str(b) for b in blocked))
    if t.pending:
        bits.append("pending")
    bits.append(f"updated {_ago(t.updated_at)}")
    title = redact(t.title).replace("\n", " ")
    return " · ".join(bits) + f" · title: «{title}»"


def recent_activity(t: Ticket, names: dict[str, str], since: datetime) -> list[str]:
    """Field changes of the last days, oldest first ("What changed since Monday?")."""
    out = []
    for e in _list(t.activity_log):
        if not isinstance(e, dict):
            continue
        at = e.get("at") or ""
        try:
            when = datetime.fromisoformat(at)
        except ValueError:
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        if when < since:
            continue
        frm, to = e.get("from"), e.get("to")
        if e.get("field") == "assignee":
            frm, to = names.get(frm or "", frm), names.get(to or "", to)
        who = e.get("actor") or "user"
        out.append(f"{at[:16]} {t.id} {e.get('field')}: {frm} → {to} (by {who})")
    return out


class Builder:
    """Collects context pieces in priority order and stops at the budget."""

    def __init__(self, budget: int):
        """Start empty."""
        self.budget = budget
        self.parts: list[str] = []
        self.used = 0
        self.total = 0
        self.dropped: list[str] = []

    def add(self, text: str, *, required: bool = False, label: str = "") -> bool:
        """Add a piece; returns False (and remembers it) when it no longer fits."""
        n = estimate_tokens(text)
        self.total += n
        if not required and self.used + n > self.budget:
            if label:
                self.dropped.append(label)
            return False
        self.parts.append(text)
        self.used += n
        return True


async def build(
    session: AsyncSession,
    *,
    project_id: str,
    scope: str,
    person: str,
    ticket_id: str | None = None,
    doc_ids: list[str] | None = None,
    include_docs: list[str] | None = None,
    filters: dict | None = None,
    question: str = "",
    send_all: bool = False,
    compact: bool = False,
) -> Context:
    """Read what the Board AI may read for this request. `compact`: a project is sent as counts and the open tickets
    only; an AI that has its own board tools reads the rest (comments, activity, closed tickets) when it needs it."""
    ctx = Context()
    row = await svc_settings.get(session)
    excluded = svc_settings.excluded_docs(row) - set(include_docs or [])
    budget = BUDGETS.get(scope, 20000) * (4 if send_all else 1)
    b = Builder(budget)

    if scope == "all":
        projects = [
            p
            for p in (await session.exec(select(Project))).all()
            if svc_settings.project_shared(row, p.id)
            and (await _belongs(session, p.id, person))
        ]
    else:
        p = await session.get(Project, project_id)
        projects = [p] if p else []
    pids = [p.id for p in projects]
    members = (
        await session.exec(
            select(Member).where(col(Member.project_id).in_(pids or [""]))
        )
    ).all()
    ctx.names = {m.id: m.name for m in members}
    ai_names = {m.name for m in members if m.kind in ("ai", "ai_removed")}

    if scope == "ticket" and ticket_id:
        t = await session.get(Ticket, ticket_id)
        if t is not None:
            await _ticket_full(session, ctx, b, t, ai_names, excluded, send_all)
    elif scope == "doc" and doc_ids:
        pass  # the page itself is added below
    else:
        for p in projects:
            await _project_block(session, ctx, b, p, filters or {}, scope, compact)

    # Docs: the ones picked for this request first, then those the question names, then titles
    pages = (
        await session.exec(
            select(DocsPage).where(
                col(DocsPage.project_id).in_(pids or [""]),
                col(DocsPage.deleted_at).is_(None),
            )
        )
    ).all()
    # Pages hidden from AI (or outside "only picked") are never read, not even when a person includes a private doc
    from services.docs_ai import access as docs_ai_access

    for pid in pids:
        excluded |= await docs_ai_access.denied_page_ids(session, pid)
    wanted = list(doc_ids or [])
    if scope == "ticket" and ticket_id:
        # Linked docs: [[Page]] references in the ticket's description
        t = await session.get(Ticket, ticket_id)
        refs = {
            m.strip().lower()
            for m in re.findall(r"\[\[([^\]|#]+)", (t.description if t else "") or "")
        }
        wanted += [p.id for p in pages if p.title and p.title.lower() in refs]
    low = (question or "").lower()
    for page in pages:
        if page.id not in wanted and page.title and page.title.lower() in low:
            wanted.append(page.id)
    shown = 0
    for page in pages:
        if page.id in excluded:
            if page.id in wanted:
                ctx.private_skipped.append({"id": page.id, "title": page.title})
            continue
        if page.id in wanted:
            text = await doc_text(session, page)
            flagged = looks_like_instructions(text)
            if flagged:
                ctx.injections.append(
                    {
                        "source": f"doc «{page.title}»",
                        "doc_id": page.id,
                        "quote": flagged,
                    }
                )
            piece = (
                f'<doc id="{page.id}" title="{page.title}">\n'
                + fence(f"doc {page.title}", text)
                + "\n</doc>"
            )
            if b.add(piece, required=scope == "doc", label=f"doc {page.title}"):
                ctx.docs += 1
                ctx.items.append({"kind": "doc", "id": page.id, "title": page.title})
                sections = len([ln for ln in text.splitlines() if ln.startswith("#")])
                ctx.steps.append(
                    f"Reading “{page.title}”"
                    + (
                        f" ({sections} section{'s' if sections != 1 else ''})"
                        if sections
                        else ""
                    )
                )
                shown += 1
    titles = [p.title for p in pages if p.id not in excluded]
    if titles and scope != "ticket":
        b.add("Docs in scope (titles): " + "; ".join(titles[:80]), label="doc titles")
    if b.dropped or b.used < b.total:
        ctx.truncated = {
            "sent": b.used,
            "total": b.total,
            "dropped": b.dropped[:20],
            "note": "Oldest comments were left out."
            if scope == "ticket"
            else "Lower-priority items were left out.",
        }
    ctx.text = "\n\n".join(b.parts)
    found = []
    if ctx.docs:
        found.append(f"{ctx.docs} doc{'s' if ctx.docs != 1 else ''}")
    if ctx.tickets:
        found.append(f"{ctx.tickets} ticket{'s' if ctx.tickets != 1 else ''}")
    ctx.steps.insert(
        0, "Found " + " and ".join(found) if found else "Nothing in scope yet"
    )
    return ctx


async def _belongs(session: AsyncSession, project_id: str, person: str) -> bool:
    """All projects means only the projects the person is a member of (or every project for the board user)."""
    if not person or person == "user":
        return True
    row = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.name == person)
        )
    ).first()
    return row is not None


async def _project_block(
    session: AsyncSession,
    ctx: Context,
    b: Builder,
    project: Project,
    filters: dict,
    scope: str,
    compact: bool = False,
) -> None:
    stmt = select(Ticket).where(Ticket.project_id == project.id)
    if filters.get("status"):
        stmt = stmt.where(Ticket.status == filters["status"])
    if filters.get("priority"):
        stmt = stmt.where(Ticket.priority == filters["priority"])
    if filters.get("type"):
        stmt = stmt.where(Ticket.type == filters["type"])
    if filters.get("assignee"):
        stmt = stmt.where(Ticket.assignee == filters["assignee"])
    tickets = list((await session.exec(stmt)).all())
    q = (filters.get("q") or "").strip().lower()
    if q:
        tickets = [
            t
            for t in tickets
            if q in t.title.lower() or q in (t.description or "").lower()
        ]
    # Open work first, then the newest closed tickets
    rank = {
        "in-progress": 0,
        "review": 1,
        "testing": 2,
        "todo": 3,
        "backlog": 4,
        "done": 5,
        "wont_do": 6,
    }
    tickets.sort(
        key=lambda t: (rank.get(t.status, 9), t.updated_at or ""), reverse=False
    )
    open_ = [t for t in tickets if t.status not in ("done", "wont_do")]
    closed = sorted(
        [t for t in tickets if t.status in ("done", "wont_do")],
        key=lambda t: t.updated_at or "",
        reverse=True,
    )
    header = (
        f'<project id="{project.id}" name="{project.name}" prefix="{project.prefix}">'
    )
    b.add(header, required=True)
    if compact:
        by_status = {s: sum(1 for t in tickets if t.status == s) for s in rank}
        b.add(
            "Tickets: "
            + ", ".join(f"{STATUS_LABELS[s]} {n}" for s, n in by_status.items() if n)
            + f" (total {len(tickets)}). The open ones are listed below; read the details, comments and activity of"
            " any ticket, and the closed ones, with your tools.",
            required=True,
        )
    lines = []
    for t in open_ if compact else open_ + closed:
        line = ticket_line(t, ctx.names)
        flagged = looks_like_instructions(t.title)
        if flagged:
            ctx.injections.append(
                {"source": f"title of {t.id}", "ticket_id": t.id, "quote": flagged}
            )
        if not b.add(line, label=t.id):
            continue
        lines.append(t.id)
        ctx.tickets += 1
        ctx.items.append({"kind": "ticket", "id": t.id, "title": t.title})
    since = datetime.now(UTC) - timedelta(days=ACTIVITY_DAYS)
    changes = []
    for t in [] if compact else tickets:
        changes.extend(recent_activity(t, ctx.names, since))
    changes.sort()
    if changes:
        b.add(
            f"Activity of the last {ACTIVITY_DAYS} days (oldest first):\n"
            + "\n".join(changes[-300:]),
            label="activity",
        )
    # Short descriptions of open tickets while there is room
    for t in [] if compact else open_:
        if t.description:
            flagged = looks_like_instructions(t.description)
            if flagged:
                ctx.injections.append(
                    {
                        "source": f"description of {t.id}",
                        "ticket_id": t.id,
                        "quote": flagged,
                    }
                )
            b.add(
                fence(f"description of {t.id}", (t.description or "")[:600]),
                label=f"{t.id} description",
            )
    b.add("</project>", required=True)


async def _ticket_full(
    session: AsyncSession,
    ctx: Context,
    b: Builder,
    t: Ticket,
    ai_names: set[str],
    excluded: set[str],
    send_all: bool,
) -> None:
    lines = [
        f'<ticket id="{t.id}">',
        ticket_line(t, ctx.names),
        "Description:",
        fence(f"description of {t.id}", t.description or "(empty)"),
    ]
    flagged = looks_like_instructions(t.description or "")
    if flagged:
        ctx.injections.append(
            {"source": f"description of {t.id}", "ticket_id": t.id, "quote": flagged}
        )
    acs = _list(t.acceptance_criteria)
    if acs:
        lines.append("Acceptance criteria:")
        for i, ac in enumerate(acs, 1):
            lines.append(
                f"  AC {i} (id {ac.get('id')}): [{'x' if ac.get('done') else ' '}] {ac.get('text', '')}"
            )
    tcs = _list(t.test_cases)
    if tcs:
        lines.append("Test cases:")
        for tc in tcs:
            lines.append(
                f"  {tc.get('code')}: {tc.get('title')} [{tc.get('status')}]"
                + (
                    f" tests AC id {tc.get('criterion_id')}"
                    if tc.get("criterion_id")
                    else ""
                )
            )
    branches = [
        b
        for b in _list(t.branches)
        if isinstance(b, dict) and b.get("name") and not b.get("deleted_at")
    ]
    if branches:
        lines.append("Branches: " + ", ".join(redact(str(b["name"])) for b in branches))
    subs = (await session.exec(select(Ticket).where(Ticket.parent_id == t.id))).all()
    if subs:
        lines.append("Sub-tickets:")
        lines += [
            f"  {s.id} {s.title} ({STATUS_LABELS.get(s.status, s.status)})"
            for s in subs
        ]
    lines.append("</ticket>")
    b.add("\n".join(lines), required=True)
    ctx.tickets += 1
    ctx.items.append({"kind": "ticket", "id": t.id, "title": t.title})
    comments = [
        c for c in _list(t.comments) if isinstance(c, dict) and not c.get("deleted_at")
    ]
    # Newest first so the oldest are the ones left out when the ticket is long (I9)
    kept: list[str] = []
    room = TRUNCATE_AT if not send_all else 10**9
    total = 0
    for c in reversed(comments):
        author = c.get("author") or "user"
        text = c.get("text", "")
        flagged = looks_like_instructions(text)
        if flagged:
            ctx.injections.append(
                {
                    "source": f"comment by {author} on {t.id}",
                    "ticket_id": t.id,
                    "author": author,
                    "quote": flagged,
                }
            )
        piece = fence(
            f"comment by {'AI member ' if author in ai_names else ''}{author} at {(c.get('at') or '')[:16]}",
            text,
        )
        n = estimate_tokens(piece)
        total += n
        if sum(estimate_tokens(k) for k in kept) + n > room:
            b.total += n
            b.dropped.append(f"comment by {author}")
            continue
        kept.append(piece)
    if kept:
        b.add("Comments (newest first):\n" + "\n".join(kept), required=True)
        ctx.comments = len(kept)
    for p in subs:
        ctx.items.append({"kind": "ticket", "id": p.id, "title": p.title})
