import json
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from sqlmodel import Field, SQLModel


# ---------------------------------------------------------------------------
# Table models
# ---------------------------------------------------------------------------


class Project(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    name: str
    prefix: str = Field(unique=True)  # e.g. "IAM", uppercase, max 6 chars
    color: str  # hex accent color
    ticket_counter: int = Field(default=0)


class IdeaCounter(SQLModel, table=True):
    __tablename__ = "idea_counter"

    id: int = Field(default=1, primary_key=True)
    counter: int = Field(default=0)


class Member(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id")
    name: str
    color: str  # hex color for avatar background
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class Ticket(SQLModel, table=True):
    id: str = Field(primary_key=True)  # e.g. "IAM-1"
    project_id: str = Field(foreign_key="project.id")
    title: str
    description: str = Field(default="")
    type: str = Field(default="task")  # bug|feature|task|chore
    status: str = Field(default="backlog")  # backlog|todo|in-progress|done
    priority: str = Field(default="medium")  # low|medium|high|critical
    estimate: Optional[float] = Field(default=None)
    due_date: Optional[str] = Field(default=None)  # ISO date string
    tags: str = Field(default="[]")  # JSON array
    parent_id: Optional[str] = Field(default=None, foreign_key="ticket.id")
    comments: str = Field(default="[]")  # JSON array
    acceptance_criteria: str = Field(default="[]")  # JSON array
    activity_log: str = Field(default="[]")  # JSON array
    work_log: str = Field(default="[]")  # JSON array
    test_cases: str = Field(default="[]")  # JSON array
    start_date: Optional[str] = Field(default=None)  # ISO date string
    wont_do_reason: Optional[str] = Field(default=None)
    created_by: Optional[str] = Field(default=None, foreign_key="member.id")
    assignee: Optional[str] = Field(default=None, foreign_key="member.id")
    blocks: str = Field(default="[]")  # JSON array of ticket IDs this ticket blocks
    blocked_by: str = Field(
        default="[]"
    )  # JSON array of ticket IDs blocking this ticket
    block_done_if_acs_incomplete: bool = Field(default=False)
    block_done_if_tcs_incomplete: bool = Field(default=False)
    links: str = Field(default="[]")  # JSON: list of {id, target_id, relation_type}
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


IDEA_STATUSES = ("draft", "in_review", "approved", "dropped")


class IdeaTicket(SQLModel, table=True):
    __tablename__ = "idea_ticket"

    id: str = Field(primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    title: str
    description: str = Field(default="")
    idea_status: str = Field(default="draft")  # draft|in_review|approved|dropped
    idea_color: str = Field(default="yellow")
    idea_emoji: str = Field(default="💡")
    idea_energy: Optional[str] = Field(default=None)  # low|medium|high
    tags: str = Field(default="[]")  # JSON list of strings
    problem_statement: Optional[str] = Field(default=None)
    ice_impact: int = Field(default=3)
    ice_effort: int = Field(default=3)
    ice_confidence: int = Field(default=3)
    revisit_date: Optional[str] = Field(default=None)
    last_touched_at: Optional[str] = Field(default=None)
    promoted_to_ticket_id: Optional[str] = Field(default=None)
    promoted_at: Optional[str] = Field(default=None)
    activity_trail: str = Field(default="[]")  # JSON list of {id, label, at}
    microthoughts: str = Field(default="[]")  # JSON list of {id, text, at}
    assumptions: str = Field(default="[]")  # JSON list of {id, text, status}
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


# ---------------------------------------------------------------------------
# Request / Response schemas (not table=True)
# ---------------------------------------------------------------------------


def _parse_json_list(v: Any) -> list:
    """Parse a JSON string to a list, or pass through if already a list."""
    if isinstance(v, str):
        if not v:
            return []
        parsed = json.loads(v)
        return parsed if isinstance(parsed, list) else []
    return v if v is not None else []


class ActivityEventRead(SQLModel):
    ticketId: str
    ticketTitle: str
    event_type: str
    at: str
    detail: str | None = None


class ProjectCreate(SQLModel):
    name: str
    prefix: str
    color: str


class ProjectUpdate(SQLModel):
    name: Optional[str] = None
    color: Optional[str] = None


class ProjectRead(SQLModel):
    id: str
    name: str
    prefix: str
    color: str
    ticket_counter: int


class MemberCreate(SQLModel):
    name: str
    color: Optional[str] = None


class MemberRead(SQLModel):
    id: str
    project_id: str
    name: str
    color: str
    created_at: str


class TicketCreate(SQLModel):
    id: str
    project_id: str
    title: str
    description: str = ""
    type: str = "task"
    status: str = "backlog"
    priority: str = "medium"
    estimate: Optional[float] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    tags: list[Any] = []
    parent_id: Optional[str] = None
    comments: list[Any] = []
    acceptance_criteria: list[Any] = []
    activity_log: list[Any] = []
    work_log: list[Any] = []
    test_cases: list[Any] = []
    created_by: Optional[str] = None
    assignee: Optional[str] = None


class TicketCreateBody(SQLModel):
    title: str
    description: str = ""
    type: Literal["bug", "feature", "task", "chore"] = "task"
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    status: Literal["backlog", "todo", "in-progress", "done", "wont_do"] = "backlog"
    estimate: Optional[float] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    tags: list[Any] = []
    parent_id: Optional[str] = None
    assignee: Optional[str] = None


class TicketUpdate(SQLModel):
    title: Optional[str] = None
    description: Optional[str] = None
    type: Optional[Literal["bug", "feature", "task", "chore"]] = None
    status: Optional[Literal["backlog", "todo", "in-progress", "done", "wont_do"]] = (
        None
    )
    priority: Optional[Literal["low", "medium", "high", "critical"]] = None
    estimate: Optional[float] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    tags: Optional[list[Any]] = None
    parent_id: Optional[str] = None
    wont_do_reason: Optional[str] = None
    assignee: Optional[str] = None
    block_done_if_acs_incomplete: Optional[bool] = None
    block_done_if_tcs_incomplete: Optional[bool] = None


class TicketRead(SQLModel):
    id: str
    project_id: str
    title: str
    description: str
    type: str
    status: str
    priority: str
    estimate: Optional[float]
    due_date: Optional[str]
    start_date: Optional[str] = None
    tags: list[Any] = []
    parent_id: Optional[str]
    comments: list[Any] = []
    acceptance_criteria: list[Any] = []
    activity_log: list[Any] = []
    work_log: list[Any] = []
    test_cases: list[Any] = []
    wont_do_reason: Optional[str] = None
    created_by: Optional[str] = None
    assignee: Optional[str] = None
    blocks: list[Any] = []
    blocked_by: list[Any] = []
    block_done_if_acs_incomplete: bool = False
    block_done_if_tcs_incomplete: bool = False
    links: list[Any] = []
    created_at: str
    updated_at: str

    @classmethod
    def from_ticket(cls, ticket: Ticket) -> "TicketRead":
        return cls(
            id=ticket.id,
            project_id=ticket.project_id,
            title=ticket.title,
            description=ticket.description,
            type=ticket.type,
            status=ticket.status,
            priority=ticket.priority,
            estimate=ticket.estimate,
            due_date=ticket.due_date,
            start_date=ticket.start_date,
            tags=_parse_json_list(ticket.tags),
            parent_id=ticket.parent_id,
            comments=_parse_json_list(ticket.comments),
            acceptance_criteria=_parse_json_list(ticket.acceptance_criteria),
            activity_log=_parse_json_list(ticket.activity_log),
            work_log=_parse_json_list(ticket.work_log),
            test_cases=_parse_json_list(ticket.test_cases),
            wont_do_reason=ticket.wont_do_reason,
            created_by=ticket.created_by,
            assignee=ticket.assignee,
            blocks=_parse_json_list(ticket.blocks),
            blocked_by=_parse_json_list(ticket.blocked_by),
            block_done_if_acs_incomplete=ticket.block_done_if_acs_incomplete,
            block_done_if_tcs_incomplete=ticket.block_done_if_tcs_incomplete,
            links=_parse_json_list(ticket.links),
            created_at=ticket.created_at,
            updated_at=ticket.updated_at,
        )


IDEA_COLORS = ("yellow", "orange", "lime", "pink", "blue", "purple", "teal")


class IdeaTicketCreateBody(SQLModel):
    project_id: str
    title: str
    description: str = ""
    idea_color: str = "yellow"
    idea_emoji: str = "💡"
    idea_energy: Optional[Literal["low", "medium", "high"]] = None
    tags: list[Any] = Field(default_factory=list)
    problem_statement: Optional[str] = None


class IdeaTicketUpdate(SQLModel):
    title: Optional[str] = None
    description: Optional[str] = None
    idea_color: Optional[str] = None
    idea_emoji: Optional[str] = None
    idea_energy: Optional[Literal["low", "medium", "high"]] = None
    tags: Optional[list[Any]] = None
    problem_statement: Optional[str] = None
    ice_impact: Optional[int] = Field(default=None, ge=1, le=5)
    ice_effort: Optional[int] = Field(default=None, ge=1, le=5)
    ice_confidence: Optional[int] = Field(default=None, ge=1, le=5)
    revisit_date: Optional[str] = None


class IdeaTicketRead(SQLModel):
    id: str
    project_id: str
    title: str
    description: str
    idea_status: str
    idea_color: str
    idea_emoji: str
    idea_energy: Optional[str]
    tags: list[Any] = Field(default_factory=list)
    problem_statement: Optional[str]
    ice_impact: int
    ice_effort: int
    ice_confidence: int
    revisit_date: Optional[str]
    last_touched_at: Optional[str]
    promoted_to_ticket_id: Optional[str]
    promoted_at: Optional[str]
    activity_trail: list[Any] = Field(default_factory=list)
    microthoughts: list[Any] = Field(default_factory=list)
    assumptions: list[Any] = Field(default_factory=list)
    created_at: str
    updated_at: str

    @classmethod
    def from_idea_ticket(cls, ticket: IdeaTicket) -> "IdeaTicketRead":
        return cls(
            id=ticket.id,
            project_id=ticket.project_id,
            title=ticket.title,
            description=ticket.description,
            idea_status=ticket.idea_status,
            idea_color=ticket.idea_color,
            idea_emoji=ticket.idea_emoji,
            idea_energy=ticket.idea_energy,
            tags=_parse_json_list(ticket.tags),
            problem_statement=ticket.problem_statement,
            ice_impact=ticket.ice_impact,
            ice_effort=ticket.ice_effort,
            ice_confidence=ticket.ice_confidence,
            revisit_date=ticket.revisit_date,
            last_touched_at=ticket.last_touched_at,
            promoted_to_ticket_id=ticket.promoted_to_ticket_id,
            promoted_at=ticket.promoted_at,
            activity_trail=_parse_json_list(ticket.activity_trail),
            microthoughts=_parse_json_list(ticket.microthoughts),
            assumptions=_parse_json_list(ticket.assumptions),
            created_at=ticket.created_at,
            updated_at=ticket.updated_at,
        )
