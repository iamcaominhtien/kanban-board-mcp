"""Scopes of the AI chat: what a chat is about (a ticket, a Docs page, an idea…), what it reads, and where it starts
(design/screens/ai-where-you-work.md, B). The chat panel, the saved conversation, the "Reading" chips and the
cost line are the same for every scope; a scope only supplies the facts that differ.

Built in: `ticket` and `doc`. Another feature adds its own with `register(provider)`, e.g. the idea page registers an
`IdeaScope` whose `kind` is "idea". A provider says:

- `info()`: the project, a title, the "Reading" chips, the starting points and the draft kinds it understands;
- `context()`: the text the model reads (fenced as data) and what it was made of;
- optionally `format_extra`, `validate_change()` and `apply_change()`: extra kinds of draft the chat may propose.
  The board's own kinds (status, priority, comment, acceptance criteria…) work in every scope.

Access, privacy and cost rules are not part of a scope: the chat service applies them to every provider.
"""

import re
from dataclasses import dataclass, field

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsPage, Member, Ticket

from ..store import loads
from . import context as ctxb
from . import settings as svc_settings
from .settings import AssistError

# Board changes a chat may propose in any scope; a provider's own ops are validated by the provider
CORE_OPS = (
    "status",
    "priority",
    "assignee",
    "due_date",
    "estimate",
    "title",
    "comment",
    "add_criteria",
)


@dataclass
class ScopeInfo:
    """What the panel shows about a scope before anyone asks."""

    kind: str
    id: str
    project_id: str
    title: str
    # "Reading" chips: [{"kind": "description", "label": "Description"}, {"kind": "comments", "label": "2 comments"}]
    reading: list[dict] = field(default_factory=list)
    # [{"label": "Summarise this ticket", "request": "...", "draft": False}]
    starting_points: list[dict] = field(default_factory=list)
    placeholder: str = "Ask…"
    # May "Do the work" start a run from this scope? (tickets only)
    work: bool = False
    # Draft kinds the scope can propose beyond the board's own (idea scopes list theirs here)
    draft_kinds: list[str] = field(default_factory=list)

    def describe(self) -> dict:
        """The scope as the API returns it."""
        return {
            "kind": self.kind,
            "id": self.id,
            "project_id": self.project_id,
            "title": self.title,
            "reading": self.reading,
            "starting_points": self.starting_points,
            "placeholder": self.placeholder,
            "work": self.work,
            "draft_kinds": self.draft_kinds,
        }


class ScopeProvider:
    """Base class of a scope; override `kind`, `info` and `context`."""

    kind: str = ""
    # Added to the chat's answer format: the extra ops of `validate_change`
    format_extra: str = ""

    async def info(
        self, session: AsyncSession, scope_id: str, person: str
    ) -> ScopeInfo:
        """The scope's panel data; raises `AssistError("not_found")` for an unknown id."""
        raise NotImplementedError

    async def context(
        self,
        session: AsyncSession,
        *,
        info: ScopeInfo,
        person: str,
        question: str,
        send_all: bool,
        include_docs: list[str],
        doc_ids: list[str],
    ) -> ctxb.Context:
        """What the model reads for a question. Source text must go through `ctxb.fence`."""
        raise NotImplementedError

    def scope_line(self, info: ScopeInfo) -> str:
        """The first line of the prompt."""
        return f"Scope: {info.title}."

    def validate_change(self, raw: dict, info: ScopeInfo) -> dict | None:
        """A change of the scope's own kind as the model wrote it, checked; None to drop it."""
        return None

    async def apply_change(
        self, session: AsyncSession, change: dict, person: str, ai_name: str
    ) -> dict:
        """Apply a change returned by `validate_change`, as the person. Returns what to keep for Undo."""
        raise AssistError("invalid", f"{self.kind} drafts cannot be applied here.")

    async def undo_change(
        self, session: AsyncSession, applied: dict, person: str
    ) -> bool:
        """Take back what `apply_change` returned (it names this provider in `undo_with`); False when a person
        changed the thing since, which is then left as they set it."""
        return False


_REGISTRY: dict[str, ScopeProvider] = {}


def register(provider: ScopeProvider) -> None:
    """Add (or replace) a scope kind."""
    _REGISTRY[provider.kind] = provider


def get(kind: str) -> ScopeProvider | None:
    """The provider of a kind, or None (the board-wide kinds "project" and "all" have none)."""
    return _REGISTRY.get(kind)


def kinds() -> list[str]:
    """Registered scope kinds."""
    return sorted(_REGISTRY)


async def ensure_access(session: AsyncSession, project_id: str, person: str) -> None:
    """A chat about something in a project is for people of that project (the board's own user always)."""
    if not person or person == "user":
        return
    row = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id,
                Member.name == person,
                Member.kind == "human",
            )
        )
    ).first()
    if row is None:
        raise AssistError("forbidden", "You are not a member of this project.")


def _live(items: list) -> list[dict]:
    return [x for x in items if isinstance(x, dict) and not x.get("deleted_at")]


def doc_refs(text: str) -> set[str]:
    """Lower-cased page titles referenced as [[Page]] in a text."""
    return {m.strip().lower() for m in re.findall(r"\[\[([^\]|#]+)", text or "")}


class TicketScope(ScopeProvider):
    """A ticket: its description, comments, criteria, test cases, sub-tickets, linked Docs and branch."""

    kind = "ticket"

    async def _ticket(self, session: AsyncSession, scope_id: str) -> Ticket:
        t = await session.get(Ticket, scope_id)
        if t is None:
            raise AssistError("not_found", "Ticket not found.")
        return t

    async def info(
        self, session: AsyncSession, scope_id: str, person: str
    ) -> ScopeInfo:
        """Reading chips from what the ticket really has."""
        t = await self._ticket(session, scope_id)
        await ensure_access(session, t.project_id, person)
        row = await svc_settings.get(session)
        excluded = svc_settings.excluded_docs(row)
        chips: list[dict] = []
        if (t.description or "").strip():
            chips.append({"kind": "description", "label": "Description"})
        comments = _live(loads(t.comments, []))
        if comments:
            chips.append(
                {
                    "kind": "comments",
                    "label": f"{len(comments)} comment{'s' if len(comments) != 1 else ''}",
                    "count": len(comments),
                }
            )
        acs = loads(t.acceptance_criteria, [])
        if acs:
            chips.append(
                {
                    "kind": "criteria",
                    "label": f"{len(acs)} acceptance criteri{'on' if len(acs) == 1 else 'a'}",
                    "count": len(acs),
                }
            )
        tcs = loads(t.test_cases, [])
        if tcs:
            chips.append(
                {
                    "kind": "test_cases",
                    "label": f"{len(tcs)} test case{'s' if len(tcs) != 1 else ''}",
                    "count": len(tcs),
                }
            )
        subs = (
            await session.exec(select(Ticket.id).where(Ticket.parent_id == t.id))
        ).all()
        if subs:
            chips.append(
                {
                    "kind": "sub_tickets",
                    "label": f"{len(subs)} sub-ticket{'s' if len(subs) != 1 else ''}",
                    "count": len(subs),
                }
            )
        pages = (
            await session.exec(
                select(DocsPage).where(
                    DocsPage.project_id == t.project_id,
                    col(DocsPage.deleted_at).is_(None),
                )
            )
        ).all()
        refs = doc_refs(t.description or "")
        linked = [p for p in pages if p.title and p.title.lower() in refs]
        shared = [p for p in linked if p.id not in excluded]
        if shared:
            chips.append(
                {
                    "kind": "docs",
                    "label": f"{len(shared)} linked Doc{'s' if len(shared) != 1 else ''}",
                    "count": len(shared),
                }
            )
        if len(linked) > len(shared):
            chips.append(
                {
                    "kind": "private_docs",
                    "label": f"{len(linked) - len(shared)} private Doc left out",
                    "skipped": True,
                }
            )
        branches = [
            b
            for b in loads(t.branches, [])
            if isinstance(b, dict) and b.get("name") and not b.get("deleted_at")
        ]
        if branches:
            chips.append({"kind": "branch", "label": f"branch {branches[0]['name']}"})
        return ScopeInfo(
            kind="ticket",
            id=t.id,
            project_id=t.project_id,
            title=f"{t.id} {t.title}",
            reading=chips,
            starting_points=[
                {"label": "Summarise this ticket", "request": "Summarise this ticket."},
                {
                    "label": "What is left to do here?",
                    "request": "What is left to do on this ticket?",
                },
                {
                    "label": "Draft acceptance criteria",
                    "request": "Suggest acceptance criteria for this ticket that are not covered yet.",
                    "draft": True,
                },
                {
                    "label": "Who should review this?",
                    "request": "Who should review this ticket, and why?",
                },
            ],
            placeholder=f"Ask about {t.id}…",
            work=True,
        )

    async def context(
        self,
        session: AsyncSession,
        *,
        info: ScopeInfo,
        person: str,
        question: str,
        send_all: bool,
        include_docs: list[str],
        doc_ids: list[str],
    ) -> ctxb.Context:
        """The ticket in full, newest comments first, through the same builder as the board chat."""
        return await ctxb.build(
            session,
            project_id=info.project_id,
            scope="ticket",
            person=person,
            ticket_id=info.id,
            doc_ids=doc_ids,
            include_docs=include_docs,
            question=question,
            send_all=send_all,
        )

    def scope_line(self, info: ScopeInfo) -> str:
        """Names the ticket."""
        return f"Scope: this ticket ({info.id})."


class DocScope(ScopeProvider):
    """A Docs page and the tickets it links."""

    kind = "doc"

    async def info(
        self, session: AsyncSession, scope_id: str, person: str
    ) -> ScopeInfo:
        """The page itself is the one chip."""
        page = await session.get(DocsPage, scope_id)
        if page is None or page.deleted_at:
            raise AssistError("not_found", "Page not found.")
        await ensure_access(session, page.project_id, person)
        row = await svc_settings.get(session)
        chips = [{"kind": "doc", "label": page.title or "This page"}]
        if page.id in svc_settings.excluded_docs(row):
            chips = [
                {
                    "kind": "private_docs",
                    "label": "Private page left out",
                    "skipped": True,
                }
            ]
        return ScopeInfo(
            kind="doc",
            id=page.id,
            project_id=page.project_id,
            title=page.title or "This page",
            reading=chips,
            starting_points=[
                {"label": "Summarise this page", "request": "Summarise this page."},
                {
                    "label": "What is missing here?",
                    "request": "What is missing or unclear on this page?",
                },
            ],
            placeholder="Ask about this page…",
        )

    async def context(
        self,
        session: AsyncSession,
        *,
        info: ScopeInfo,
        person: str,
        question: str,
        send_all: bool,
        include_docs: list[str],
        doc_ids: list[str],
    ) -> ctxb.Context:
        """The page's text (unless it is private) and the tickets it names."""
        return await ctxb.build(
            session,
            project_id=info.project_id,
            scope="doc",
            person=person,
            doc_ids=[*doc_ids, info.id],
            include_docs=include_docs,
            question=question,
            send_all=send_all,
        )

    def scope_line(self, info: ScopeInfo) -> str:
        """Answer only from the page."""
        return (
            "Scope: this page and its linked tickets. Answer only from the page and cite the section as"
            " Page › # Heading."
        )


register(TicketScope())
register(DocScope())
