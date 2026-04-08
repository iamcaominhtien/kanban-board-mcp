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
    wont_do_reason: Optional[str] = Field(default=None)
    created_by: Optional[str] = Field(default=None, foreign_key="member.id")
    assignee: Optional[str] = Field(default=None, foreign_key="member.id")
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
    tags: list[Any] = []
    parent_id: Optional[str] = None
    created_by: Optional[str] = None


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
    tags: Optional[list[Any]] = None
    parent_id: Optional[str] = None
    wont_do_reason: Optional[str] = None
    assignee: Optional[str] = None


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
            created_at=ticket.created_at,
            updated_at=ticket.updated_at,
        )
