from typing import Optional

from sqlmodel import Field, SQLModel


class Project(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    prefix: str
    color: str


class Ticket(SQLModel, table=True):
    id: str = Field(primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    title: str
    description: str = ""
    type: str = "task"
    status: str = "backlog"
    priority: str = "medium"
    tags: str = "[]"  # JSON-encoded list[str]
    due_date: Optional[str] = None
    created_at: str
    updated_at: str
    comments: str = "[]"  # JSON-encoded list[Comment]
    acceptance_criteria: str = "[]"  # JSON-encoded list[AcceptanceCriterion]
    estimate: Optional[int] = None
    activity_log: str = "[]"  # JSON-encoded list[ActivityEntry]
    work_log: str = "[]"  # JSON-encoded list[WorkLogEntry]
    test_cases: str = "[]"  # JSON-encoded list[TestCase]
    parent_id: Optional[str] = None
