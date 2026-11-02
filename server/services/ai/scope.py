"""AI Team, Flow by scope (design/screens/ai-story-flow.md G): the whole project, one Story (the Story ticket and its
children) or one ticket. A ticket with children is a Story-shaped scope before it is a Story; one level only, a Story
never holds Stories.

The Flow map, the Timeline, Live commentary, While you were away and Health read the same scope from here."""

from dataclasses import dataclass, field

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Story, Ticket

from .store import loads

NOT_IN_STORY = "Not in a Story"


@dataclass
class Scope:
    """What the person is looking at: `ids` are the tickets in it (None: the whole project)."""

    level: str  # project | story | ticket
    story: Ticket | None = None
    story_row: Story | None = None
    ticket: Ticket | None = None
    children: list[Ticket] = field(default_factory=list)
    ids: set[str] | None = None

    def has(self, ticket_id: str | None) -> bool:
        """Whether a ticket is in the scope."""
        return self.ids is None or (ticket_id in self.ids)

    def out(self) -> dict:
        """The scope as the API hands it out: the level and the crumbs above it."""
        return {
            "level": self.level,
            "story": {
                "id": self.story.id,
                "title": self.story.title,
                "state": self.story_row.state if self.story_row else None,
            }
            if self.story
            else None,
            "ticket": {"id": self.ticket.id, "title": self.ticket.title}
            if self.ticket
            else None,
        }


def is_story(t: Ticket | None, rows: dict[str, Story] | set[str]) -> bool:
    """A Story: a ticket of type story, or one that has its Story row."""
    return t is not None and (t.type == "story" or t.id in rows)


def plan_order(row: Story | None, children: list[Ticket]) -> list[Ticket]:
    """The children in the order of the Story's plan, then the ones the plan does not name, oldest first."""
    planned = (
        [
            str(i.get("ticket_id"))
            for i in (loads(row.plan, {}) or {}).get("items") or []
            if isinstance(i, dict) and i.get("ticket_id")
        ]
        if row is not None
        else []
    )
    rank = {tid: n for n, tid in enumerate(planned)}
    return sorted(
        children,
        key=lambda c: (rank.get(c.id, len(rank)), c.created_at or "", c.id),
    )


async def story_rows(session: AsyncSession, project_id: str) -> dict[str, Story]:
    """The project's Story rows by their ticket id."""
    return {
        s.ticket_id: s
        for s in (
            await session.exec(select(Story).where(Story.project_id == project_id))
        ).all()
    }


def story_of(tickets: dict[str, Ticket], rows: dict[str, Story]) -> dict[str, str]:
    """The Story of every ticket that is in one: the Story itself, or its child."""
    out: dict[str, str] = {}
    for t in tickets.values():
        if is_story(t, rows):
            out[t.id] = t.id
        elif t.parent_id and is_story(tickets.get(t.parent_id), rows):
            out[t.id] = t.parent_id
    return out


async def index(
    session: AsyncSession, project_id: str
) -> tuple[dict[str, str], dict[str, str]]:
    """`story_of` and every ticket's title, read with only the columns they need (for a poll)."""
    rows = await story_rows(session, project_id)
    found = (
        await session.exec(
            select(Ticket.id, Ticket.parent_id, Ticket.type, Ticket.title).where(
                Ticket.project_id == project_id
            )
        )
    ).all()
    stories = {tid for tid, _, kind, _ in found if kind == "story" or tid in rows}
    of: dict[str, str] = {}
    for tid, parent, _, _ in found:
        if tid in stories:
            of[tid] = tid
        elif parent in stories:
            of[tid] = parent
    return of, {tid: title for tid, _, _, title in found}


async def resolve(
    session: AsyncSession,
    project_id: str,
    *,
    story: str | None = None,
    ticket: str | None = None,
) -> Scope | None:
    """The scope a request names, or None when the Story or the ticket is not in the project."""

    async def get(tid: str) -> Ticket | None:
        t = await session.get(Ticket, tid)
        return t if t is not None and t.project_id == project_id else None

    s = None
    if story:
        s = await get(story)
        if s is None:
            return None
    if ticket:
        t = await get(ticket)
        if t is None:
            return None
        if s is None and t.parent_id:
            s = await get(t.parent_id)  # its crumb: the Story (or parent) it is in
        row = await session.get(Story, s.id) if s is not None else None
        return Scope("ticket", story=s, story_row=row, ticket=t, ids={t.id})
    if s is not None:
        row = await session.get(Story, s.id)
        kids = list(
            (
                await session.exec(
                    select(Ticket).where(
                        Ticket.parent_id == s.id, Ticket.project_id == project_id
                    )
                )
            ).all()
        )
        return Scope(
            "story",
            story=s,
            story_row=row,
            children=plan_order(row, kids),
            ids={s.id, *(c.id for c in kids)},
        )
    return Scope("project")
