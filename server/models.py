import json
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import field_validator
from sqlalchemy import Index
from sqlalchemy import UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


# ---------------------------------------------------------------------------
# Table models
# ---------------------------------------------------------------------------


class Project(SQLModel, table=True):
    """Kanban project (table)."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    name: str
    prefix: str = Field(unique=True)  # e.g. "IAM", uppercase, max 6 chars
    color: str  # hex accent color
    ticket_counter: int = Field(default=0)
    repo_path: Optional[str] = Field(
        default=None
    )  # local git repo used for ticket branches
    worktree_template: Optional[str] = Field(
        default=None
    )  # template for branch worktrees
    worktree_by_default: bool = Field(default=False)
    docs_enabled: bool = Field(
        default=True
    )  # the Docs space can be switched off per project
    docs_edit_policy: str = Field(
        default="members"
    )  # who can edit Docs pages: everyone | members | admins


class WorkspaceSettings(SQLModel, table=True):
    """Singleton row holding the per-ticket workspace folder settings (table)."""

    __tablename__ = "workspace_settings"

    id: int = Field(default=1, primary_key=True)
    enabled: bool = Field(default=True)
    root_path: str = Field(default="~/kanban-workspace")
    default_retention_days: Optional[int] = Field(default=14)


class WorkspaceSettingsUpdate(SQLModel):
    """Partial update of the workspace settings."""

    enabled: Optional[bool] = None
    root_path: Optional[str] = None
    default_retention_days: Optional[int] = None


class IdeaCounter(SQLModel, table=True):
    """Singleton row that numbers idea tickets (table)."""

    __tablename__ = "idea_counter"

    id: int = Field(default=1, primary_key=True)
    counter: int = Field(default=0)


class Member(SQLModel, table=True):
    """Project member who can be assigned tickets or mentioned (table)."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    name: str
    color: str  # hex color for avatar background
    # Docs comment rights: viewer reads, member comments and resolves, admin also deletes any comment.
    role: str = Field(default="member")
    # human | ai. An AI member keeps its connection and limits in AiMember (same id).
    kind: str = Field(default="human")
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class Ticket(SQLModel, table=True):
    """Ticket with its checklists, comments, activity and relations stored as JSON (table)."""

    # A project's board reads its tickets by project, often by status too
    __table_args__ = (Index("ix_ticket_project_status", "project_id", "status"),)

    id: str = Field(primary_key=True)  # e.g. "IAM-1"
    project_id: str = Field(foreign_key="project.id")
    title: str
    description: str = Field(default="")
    type: str = Field(default="task")  # bug|feature|task|chore|story
    status: str = Field(default="backlog")  # backlog|todo|in-progress|done
    priority: str = Field(default="medium")  # low|medium|high|critical
    estimate: Optional[float] = Field(default=None)
    due_date: Optional[str] = Field(default=None)  # ISO date string
    tags: str = Field(default="[]")  # JSON array
    parent_id: Optional[str] = Field(default=None, foreign_key="ticket.id", index=True)
    comments: str = Field(default="[]")  # JSON array
    acceptance_criteria: str = Field(default="[]")  # JSON array
    sub_tasks: str = Field(default="[]")  # JSON: checklist of {id, text, done}
    activity_log: str = Field(default="[]")  # JSON array
    work_log: str = Field(default="[]")  # JSON array
    test_cases: str = Field(default="[]")  # JSON array
    start_date: Optional[str] = Field(default=None)  # ISO date string
    wont_do_reason: Optional[str] = Field(default=None)
    created_by: Optional[str] = Field(default=None, foreign_key="member.id")
    assignee: Optional[str] = Field(default=None, foreign_key="member.id", index=True)
    blocks: str = Field(default="[]")  # JSON array of ticket IDs this ticket blocks
    blocked_by: str = Field(
        default="[]"
    )  # JSON array of ticket IDs blocking this ticket
    block_done_if_acs_incomplete: bool = Field(default=False)
    block_done_if_tcs_incomplete: bool = Field(default=False)
    links: str = Field(default="[]")  # JSON: list of {id, target_id, relation_type}
    branches: str = Field(
        default="[]"
    )  # JSON: list of {id, name, status, branch_from, ...}
    workspace_retention_days: Optional[int] = Field(default=None)
    repo_path: Optional[str] = Field(
        default=None
    )  # overrides Project.repo_path when set
    # Reopen fields
    reopen_count: int = Field(default=0)
    last_reopened_at: Optional[str] = Field(default=None)
    last_reopened_by: Optional[str] = Field(default=None)
    last_reopen_reason: Optional[str] = Field(default=None)
    reopen_history: str = Field(default="[]")
    # Pending fields
    pending: bool = Field(default=False)
    pending_reason_type: Optional[str] = Field(default=None)  # ticket | person | party
    pending_ticket_id: Optional[str] = Field(default=None)
    pending_member_id: Optional[str] = Field(default=None)
    pending_party: Optional[str] = Field(default=None)
    pending_note: Optional[str] = Field(default=None)
    pending_since: Optional[str] = Field(default=None)
    pending_by: Optional[str] = Field(default=None)
    # Idea Space links: the idea this ticket was promoted from, and the assumption it tests.
    from_idea_id: Optional[str] = Field(default=None, index=True)
    tests_assumption_id: Optional[str] = Field(default=None, index=True)
    # A sub-ticket's execution wave pinned by hand (TDP-1); None: computed from Blocked by (services/ticket_waves.py)
    wave_pin: Optional[int] = Field(default=None)
    # The member (a person or an AI) whose review the ticket waits for in Review: the card shows "Review requested —
    # Name" (MainBoard, Review column; issue #269). Set by hand, or by the board from the workflow's reviewer
    review_requested_from: Optional[str] = Field(default=None)
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


IDEA_STATUSES = ("draft", "in_review", "approved", "dropped")
# The Idea Space stages (design: idea-promote-migration.md, "The whole life of an idea").
IDEA_STAGES = (
    "inbox",
    "exploring",
    "ready",
    "building",
    "parked",
    "shipped",
    "archived",
)
IDEA_SOURCES = (
    "manual",
    "selection",
    "doc",
    "comment",
    "ticket",
    "picture",
    "ai",
    "import",
)
ASSUMPTION_IMPACTS = ("low", "medium", "high")
ASSUMPTION_STATUSES = ("untested", "testing", "validated", "disproved")
EVIDENCE_KINDS = (
    "comment",
    "file",
    "link",
    "ticket",
    "sketch",
    "diagram",
    "note",
)
ARCHIVE_REASONS = (
    "already_exists",
    "too_big",
    "not_now",
    "wrong_direction",
    "other",
)
LOG_KINDS = ("note", "research", "interview", "experiment", "finding", "decision")
WORKSPACE_RETENTIONS = ("open_then_30", "30_days", "forever")


class IdeaTicket(SQLModel, table=True):
    """Idea Space ticket (table)."""

    __tablename__ = "idea_ticket"

    id: str = Field(primary_key=True)
    # None = the idea belongs to no project yet.
    project_id: Optional[str] = Field(
        default=None, foreign_key="project.id", index=True
    )
    title: str
    description: str = Field(default="")
    # Legacy status the current Idea board still drives; `stage` is the model that replaces it.
    idea_status: str = Field(default="draft")  # draft|in_review|approved|dropped
    stage: str = Field(default="inbox", index=True)  # see IDEA_STAGES
    park_until: Optional[str] = Field(default=None)  # ISO date, Parked ideas only
    archive_reason: Optional[str] = Field(default=None)
    source: str = Field(default="manual")  # see IDEA_SOURCES
    # JSON {kind, id, label, quote, url, by, why}: where it came from (a Doc, comment, ticket, AI member).
    source_ref: str = Field(default="{}")
    created_by: Optional[str] = Field(default=None)
    owner: Optional[str] = Field(default=None)
    park_note: Optional[str] = Field(default=None)
    archive_note: Optional[str] = Field(default=None)
    stage_changed_at: Optional[str] = Field(default=None)
    # JSON snapshot of the fields the last stage move changed, so that move can be undone.
    prev_state: str = Field(default="{}")
    merged_into_id: Optional[str] = Field(default=None)
    merged_at: Optional[str] = Field(default=None)
    merge_undo: str = Field(
        default="{}"
    )  # JSON snapshot of the target before the merge
    shipped_at: Optional[str] = Field(default=None)
    outcome: Optional[str] = Field(
        default=None
    )  # worked|partly|no, answered after Shipped
    outcome_note: Optional[str] = Field(default=None)
    former_ticket_id: Optional[str] = Field(
        default=None
    )  # the deleted ticket, kept so a restore can relink
    effort_guess: Optional[str] = Field(default=None)
    workspace_retention: str = Field(default="open_then_30")
    body: str = Field(default="")  # the idea page, markdown as for Docs
    details: str = Field(
        default=""
    )  # optional notes (ICE, energy) kept from the old model
    idea_color: str = Field(default="yellow")
    idea_emoji: str = Field(default="💡")
    idea_energy: Optional[str] = Field(default=None)  # seed|concept|hot|big_bet
    tags: str = Field(default="[]")  # JSON list of strings
    problem_statement: Optional[str] = Field(default=None)
    ice_impact: int = Field(default=3)
    ice_effort: int = Field(default=3)
    ice_confidence: int = Field(default=3)
    revisit_date: Optional[str] = Field(default=None)
    last_touched_at: Optional[str] = Field(default=None)
    promoted_to_ticket_id: Optional[str] = Field(default=None)
    promoted_at: Optional[str] = Field(default=None)
    # JSON list of {id, label, at, author}; entries from before the new model have no author.
    activity_trail: str = Field(default="[]")
    microthoughts: str = Field(default="[]")  # JSON list of {id, text, at}
    # Superseded by `assumption_records`; kept only so a conversion can be checked against it.
    assumptions: str = Field(default="[]")
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    assumption_records: list["IdeaAssumption"] = Relationship(
        back_populates="idea",
        sa_relationship_kwargs={
            "lazy": "selectin",
            "order_by": "IdeaAssumption.position",
            "cascade": "all, delete-orphan",
        },
    )
    vote_records: list["IdeaVote"] = Relationship(
        back_populates="idea",
        sa_relationship_kwargs={"lazy": "selectin", "cascade": "all, delete-orphan"},
    )
    comment_records: list["IdeaComment"] = Relationship(
        back_populates="idea",
        sa_relationship_kwargs={
            "lazy": "selectin",
            "order_by": "IdeaComment.created_at",
            "cascade": "all, delete-orphan",
        },
    )
    log_records: list["IdeaLogEntry"] = Relationship(
        back_populates="idea",
        sa_relationship_kwargs={
            "lazy": "selectin",
            "order_by": "IdeaLogEntry.created_at",
            "cascade": "all, delete-orphan",
        },
    )


class IdeaAssumption(SQLModel, table=True):
    """One assumption of an idea, with how much it matters and how well it is tested (table)."""

    __tablename__ = "idea_assumption"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    idea_id: str = Field(foreign_key="idea_ticket.id", index=True)
    position: int = Field(default=0)
    text: str
    impact: str = Field(default="medium")  # see ASSUMPTION_IMPACTS
    status: str = Field(default="untested")  # see ASSUMPTION_STATUSES
    test_ticket_id: Optional[str] = Field(default=None)  # a ticket that tests it
    ai: bool = Field(
        default=False
    )  # added from the AI chat; stays marked until a person edits it
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    idea: Optional[IdeaTicket] = Relationship(back_populates="assumption_records")
    evidence: list["IdeaEvidence"] = Relationship(
        back_populates="assumption",
        sa_relationship_kwargs={
            "lazy": "selectin",
            "order_by": "IdeaEvidence.created_at",
            "cascade": "all, delete-orphan",
        },
    )


class IdeaEvidence(SQLModel, table=True):
    """A link, file or note that supports or disproves an assumption (table)."""

    __tablename__ = "idea_evidence"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    assumption_id: str = Field(foreign_key="idea_assumption.id", index=True)
    kind: str = Field(default="link")  # see EVIDENCE_KINDS
    title: str = Field(default="")
    ref: str = Field(default="")  # URL, attachment id or the note text
    created_by: Optional[str] = Field(default=None)
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    assumption: Optional[IdeaAssumption] = Relationship(back_populates="evidence")


class IdeaComment(SQLModel, table=True):
    """A comment on an idea's page; AI answers carry the `ai` flag and the run they came from (table)."""

    __tablename__ = "idea_comment"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    idea_id: str = Field(foreign_key="idea_ticket.id", index=True)
    author: Optional[str] = Field(default=None)
    body: str = Field(default="")
    ai: bool = Field(default=False)
    run_id: Optional[str] = Field(default=None)
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    edited_at: Optional[str] = Field(default=None)

    idea: Optional[IdeaTicket] = Relationship(back_populates="comment_records")


class IdeaLogEntry(SQLModel, table=True):
    """An entry of an idea's research log: what was found, tried or decided (table)."""

    __tablename__ = "idea_log_entry"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    idea_id: str = Field(foreign_key="idea_ticket.id", index=True)
    kind: str = Field(default="note")  # see LOG_KINDS
    body: str = Field(default="")
    author: Optional[str] = Field(default=None)
    ai: bool = Field(default=False)
    pinned: bool = Field(default=False)
    assumption_id: Optional[str] = Field(default=None)  # the assumption it supports
    attachments: str = Field(default="[]")  # JSON list of {name, url}
    ticket_id: Optional[str] = Field(default=None)  # a related (test) ticket
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    idea: Optional[IdeaTicket] = Relationship(back_populates="log_records")


class IdeaVote(SQLModel, table=True):
    """One person's vote ("I want this") on an idea; a person votes once (table)."""

    __tablename__ = "idea_vote"
    __table_args__ = (
        Index("uq_idea_vote_idea_voter", "idea_id", "voter", unique=True),
    )

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    idea_id: str = Field(foreign_key="idea_ticket.id", index=True)
    voter: str  # member id or user name
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    idea: Optional[IdeaTicket] = Relationship(back_populates="vote_records")


class IdeaAiSettings(SQLModel, table=True):
    """Per-project switches of the optional AI helpers of the Idea Space; all on by default (table).

    `project_id` "" holds the defaults for ideas that belong to no project.
    """

    __tablename__ = "idea_ai_settings"

    project_id: str = Field(default="", primary_key=True)
    enabled: bool = Field(default=True)
    triage_advice: bool = Field(default=True)
    weekly_grooming: bool = Field(default=True)
    ask: bool = Field(default=True)
    read_docs: bool = Field(default=True)
    read_repo: bool = Field(default=True)
    daily_cap: float = Field(default=1.0)  # dollars a day for the Idea Space helpers
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class IdeaAdvice(SQLModel, table=True):
    """What the AI suggests for an Inbox idea: Keep, Park, Merge or Archive, with a reason; it never applies it (table)."""

    __tablename__ = "idea_advice"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    idea_id: str = Field(foreign_key="idea_ticket.id", index=True)
    action: str  # keep | park | merge | archive
    reason: str = Field(default="")
    confidence: str = Field(default="medium")  # high | medium | low
    target_id: Optional[str] = Field(default=None)  # the idea to merge into
    archive_reason: Optional[str] = Field(default=None)
    park_days: Optional[int] = Field(default=None)
    idea_stamp: str = Field(
        default=""
    )  # the idea's updated_at when it was read: later edits make it stale
    member_id: Optional[str] = Field(default=None)
    cost: float = Field(default=0.0)
    state: str = Field(default="open")  # open | accepted | ignored
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class IdeaDigest(SQLModel, table=True):
    """The weekly grooming digest of a project's Idea Space; a digest is not a notification (table)."""

    __tablename__ = "idea_digest"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(default="", index=True)
    text: str = Field(default="")  # markdown
    items: str = Field(default="[]")  # JSON list of {kind, idea_ids, text}
    ai: bool = Field(
        default=False
    )  # the sentence around the findings was written by the AI
    member_id: Optional[str] = Field(default=None)
    cost: float = Field(default=0.0)
    ideas_read: int = Field(default=0)
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class DocsPage(SQLModel, table=True):
    """A page in a project's Docs space (soft-deleted via deleted_at)."""

    __tablename__ = "docs_page"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    parent_id: Optional[str] = Field(
        default=None, foreign_key="docs_page.id", index=True
    )
    position: int = Field(default=0)
    title: str
    slug: str
    status: str = Field(default="draft")  # draft (never published) | published
    version: int = Field(default=0)  # latest published version, 0 = none yet
    created_by: str = Field(default="user")
    updated_by: str = Field(default="user")
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)
    deleted_at: Optional[str] = Field(default=None)
    deleted_by: Optional[str] = Field(default=None)
    deleted_root_id: Optional[str] = Field(default=None)
    # page | canvas: a canvas page opens the Canvas editor instead of the text editor
    kind: str = Field(default="page")


class DocsVersion(SQLModel, table=True):
    """Immutable published version of a Docs page (table)."""

    __tablename__ = "docs_version"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    version: int
    title: str
    markdown: str = Field(default="")
    author: str = Field(default="user")
    note: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    # JSON {diagram id: version} the page used when it was published; restoring the page restores them
    diagram_versions: str = Field(default="{}")
    # The author accepted AI text in this version (History marks it; the page itself is never stamped)
    with_ai: bool = Field(default=False)


class DocsDraft(SQLModel, table=True):
    """Autosaved, per-author working copy of a page."""

    __tablename__ = "docs_draft"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    author: str = Field(default="user")
    title: str
    markdown: str = Field(default="")
    base_version: int = Field(default=0)
    saves: int = Field(default=1)  # autosaves since the draft was started
    updated_at: str = Field(default_factory=_now_iso)
    # "Drafted with AI": JSON {kind, from, member_id, gaps: [], sources: [], accepted: bool}; None for a plain draft
    ai_source: Optional[str] = Field(default=None)


class DocsPageSeen(SQLModel, table=True):
    """The version of a page a person last viewed (drives "since you last viewed")."""

    __tablename__ = "docs_page_seen"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    viewer: str
    version: int = Field(default=0)
    seen_at: str = Field(default_factory=_now_iso)


class DocsLink(SQLModel, table=True):
    """Reference index: one row per [[page]] or ticket key in a published page."""

    __tablename__ = "docs_link"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    source_page_id: str = Field(foreign_key="docs_page.id", index=True)
    source_section: Optional[str] = Field(default=None)
    target_page_id: Optional[str] = Field(default=None, index=True)
    target_title: Optional[str] = Field(default=None)
    target_anchor: Optional[str] = Field(default=None)
    target_ticket_id: Optional[str] = Field(default=None, index=True)
    display_text: Optional[str] = Field(default=None)
    snippet: str = Field(default="")
    # page: written in a published page; manual: a person linked a ticket to a page.
    # (Mentions in a ticket's description or comments are derived on read, not stored.)
    origin: str = Field(default="page")


class DocsAnchorAlias(SQLModel, table=True):
    """A heading that was renamed: ``[[Page#old-slug]]`` keeps resolving to ``new_slug``."""

    __tablename__ = "docs_anchor_aliases"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    old_slug: str
    new_slug: str


class DocsTitleAlias(SQLModel, table=True):
    """A title a page used to have: ``[[Old title]]`` keeps resolving to the page (by id) after a rename."""

    __tablename__ = "docs_title_aliases"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    old_title: str  # lower-cased, trimmed


class DocsCommentThread(SQLModel, table=True):
    """A comment thread on a Docs page: inline (tied to selected text) or page-level."""

    __tablename__ = "docs_comment_thread"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    kind: str = Field(default="inline")  # inline | page
    status: str = Field(default="open")  # open | resolved
    anchor_quote: Optional[str] = Field(default=None)
    anchor_prefix: str = Field(default="")
    anchor_suffix: str = Field(default="")
    anchor_section: Optional[str] = Field(default=None)
    anchor_state: str = Field(default="attached")  # attached | orphaned
    anchor_pos: Optional[int] = Field(
        default=None
    )  # offset of the match in the page text
    created_by: str = Field(default="user")
    created_at: str = Field(default_factory=_now_iso)
    resolved_by: Optional[str] = Field(default=None)
    resolved_at: Optional[str] = Field(default=None)


class DocsComment(SQLModel, table=True):
    """One comment in a thread; the first is the thread's opening comment."""

    __tablename__ = "docs_comment"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    thread_id: str = Field(foreign_key="docs_comment_thread.id", index=True)
    author: str = Field(default="user")
    body: str = Field(default="")
    mentions: str = Field(default="[]")  # JSON list of member ids
    created_at: str = Field(default_factory=_now_iso)
    edited_at: Optional[str] = Field(default=None)
    # Set on an AI member's reply: JSON {member_id, job_id, cost, sources: [], can_suggest: bool}
    ai: Optional[str] = Field(default=None)


class DocsCommentRead(SQLModel, table=True):
    """When a reader last opened a thread (drives the unread dot)."""

    __tablename__ = "docs_comment_read"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    thread_id: str = Field(foreign_key="docs_comment_thread.id", index=True)
    reader: str
    read_at: str = Field(default_factory=_now_iso)


class DocsCommentEvent(SQLModel, table=True):
    """Activity entry for comment events; `recipients` are the people it notifies."""

    __tablename__ = "docs_comment_event"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    page_id: Optional[str] = Field(
        default=None, foreign_key="docs_page.id", index=True
    )  # None for an access request
    thread_id: Optional[str] = Field(default=None)
    comment_id: Optional[str] = Field(default=None)
    kind: str  # comment | reply | resolved | reopened | access_request
    actor: str = Field(default="user")
    mentioned: str = Field(default="[]")  # JSON list of member names
    recipients: str = Field(default="[]")  # JSON list of names to notify
    page_title: str = Field(default="")
    snippet: str = Field(default="")
    created_at: str = Field(default_factory=_now_iso)


# ---------------------------------------------------------------------------
# Docs AI (design/screens/docs-ai.md and docs-ai-care.md; docs/superpowers/specs/2026-10-30-docs-ai-design.md)
# ---------------------------------------------------------------------------


class DocsAiSettings(SQLModel, table=True):
    """Per-project Docs AI settings (Settings > Docs > AI). Docs AI is off by default for a new project; an admin
    turns it on (AI-1). A project made before that change keeps its stored value, and one that never stored a row is
    given `enabled=True` on first use (`services.docs_ai.settings.get`), as it had before."""

    __tablename__ = "docs_ai_settings"

    project_id: str = Field(foreign_key="project.id", primary_key=True)
    enabled: bool = Field(default=False)
    member_id: Optional[str] = Field(
        default=None
    )  # the AI member that answers and checks
    style_page_id: Optional[str] = Field(default=None)
    freshness_on: bool = Field(default=True)
    digest_on: bool = Field(default=True)
    updated_by: Optional[str] = Field(default=None)
    updated_at: str = Field(default_factory=_now_iso)


class DocsAiSession(SQLModel, table=True):
    """The one Claude Code session of an AI member on a Docs page (`scope` is `page:<id>`): every Docs AI call and
    chat about the page by that member continues it."""

    __tablename__ = "docs_ai_session"

    scope: str = Field(primary_key=True)
    member_id: str = Field(primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    session_id: str
    calls: int = Field(default=0)
    updated_at: str = Field(default_factory=_now_iso)


class DocsAiJob(SQLModel, table=True):
    """One Docs AI call (ask, thread reply, check, translate, summary, freshness...). The Docs counterpart of an
    AI run: who asked, which AI answered, which pages it read, what it cost."""

    __tablename__ = "docs_ai_job"

    id: str = Field(
        default_factory=lambda: f"dj_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    page_id: Optional[str] = Field(default=None, index=True)
    thread_id: Optional[str] = Field(default=None, index=True)
    comment_id: Optional[str] = Field(default=None)
    member_id: Optional[str] = Field(default=None, index=True)
    # ask | thread_reply | thread_summary | check | translate | explain | summary | history_summary | publish_note
    # | tickets | write | freshness | tidy | suggest_edit
    kind: str = Field(index=True)
    state: str = Field(
        default="queued", index=True
    )  # queued | running | finished | failed | cancelled
    started_by: str = Field(default="user")
    instruction: str = Field(default="")
    session_id: Optional[str] = Field(
        default=None
    )  # CLI session of a local Claude Code member
    reads: str = Field(
        default="[]"
    )  # JSON [{page_id, title, why}]: pages read (the run's "Read" chips)
    steps: str = Field(default="[]")  # JSON [{at, text}]
    result: str = Field(default="{}")  # JSON, per kind
    error: str = Field(default="{}")  # JSON {code, message}
    tokens_in: int = Field(default=0)
    tokens_out: int = Field(default=0)
    cost_usd: float = Field(default=0.0)
    metered: bool = Field(default=False)
    reply_comment_id: Optional[str] = Field(default=None)
    queued_at: str = Field(default_factory=_now_iso)
    started_at: Optional[str] = Field(default=None)
    ended_at: Optional[str] = Field(default=None)


class DocsAiHealth(SQLModel, table=True):
    """The last Docs health run of a project: missing docs, broken links, overlaps (out-of-date pages are in
    `docs_ai_check`)."""

    __tablename__ = "docs_ai_health"

    project_id: str = Field(foreign_key="project.id", primary_key=True)
    data: str = Field(
        default="{}"
    )  # JSON {missing: [], broken: [], overlaps: [], dismissed: []}
    checked_at: Optional[str] = Field(default=None)
    digest_at: Optional[str] = Field(default=None)


class DocsAiIgnore(SQLModel, table=True):
    """A "Check this page" finding a person chose to ignore for a page (the key is a hash of kind + quote)."""

    __tablename__ = "docs_ai_ignore"

    page_id: str = Field(
        primary_key=True
    )  # no foreign key: a purged page must not be blocked by it
    key: str = Field(primary_key=True)
    by: str = Field(default="user")
    at: str = Field(default_factory=_now_iso)


class Diagram(SQLModel, table=True):
    """A draw.io diagram referenced from markdown as ``[label](diagram:id)``.

    Deleting only unlinks it: the row is kept (``deleted_at``) so it stays in the Recycle Bin.
    """

    __tablename__ = "diagram"

    id: str = Field(
        default_factory=lambda: f"dg_{uuid.uuid4().hex[:8]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    label: str = Field(default="Diagram")
    summary: str = Field(default="")  # short text summary offered next to the image
    item_kind: Optional[str] = Field(default=None)  # ticket | comment | doc
    item_id: Optional[str] = Field(default=None, index=True)
    version: int = Field(default=1)  # latest saved version
    created_by: str = Field(default="user")
    created_at: str = Field(default_factory=_now_iso)
    updated_by: str = Field(default="user")
    updated_at: str = Field(default_factory=_now_iso)
    deleted_at: Optional[str] = Field(default=None)
    deleted_by: Optional[str] = Field(default=None)


class DiagramVersion(SQLModel, table=True):
    """One saved version of a diagram: the editable ``.drawio`` source and its SVG preview."""

    __tablename__ = "diagram_version"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    diagram_id: str = Field(foreign_key="diagram.id", index=True)
    version: int
    source: str = Field(default="")
    svg: str = Field(default="")
    # who drew the preview: editor (draw.io itself, exact) | agent (an SVG the agent supplied) | basic (the server's plain drawing)
    preview_kind: str = Field(default="editor")
    author: str = Field(default="user")
    note: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)


class DiagramSettings(SQLModel, table=True):
    """Singleton row: where the draw.io editor runs (admin setting)."""

    __tablename__ = "diagram_settings"

    id: int = Field(default=1, primary_key=True)
    mode: str = Field(default="self-hosted")  # built-in | self-hosted | public
    url: str = Field(
        default=""
    )  # self-hosted editor address, e.g. http://localhost:8080


class Sketch(SQLModel, table=True):
    """A paint-style drawing: a PNG and an editable source (JSON with layers) kept in the uploads folder.

    The files are ``uploads/sketches/<id>.png`` and ``<id>.sketch.json``; this row holds who owns the
    drawing, its size and a version for the "someone saved in the meantime" check. Deleting only
    unlinks it (``deleted_at``), as for diagrams.
    """

    __tablename__ = "sketch"

    id: str = Field(
        default_factory=lambda: f"sk_{uuid.uuid4().hex[:8]}", primary_key=True
    )
    # Resolved from the owner when the drawing is created; None for an idea that belongs to no project.
    project_id: Optional[str] = Field(
        default=None, foreign_key="project.id", index=True
    )
    owner_kind: str = Field(default="doc")  # idea | ticket | doc | comment
    owner_id: str = Field(default="", index=True)
    title: str = Field(default="Sketch")
    width: int = Field(default=840)
    height: int = Field(default=500)
    layer_count: int = Field(default=1)
    version: int = Field(default=1)  # latest saved version
    png_bytes: int = Field(default=0)
    source_bytes: int = Field(default=0)
    created_by: str = Field(default="user")
    created_at: str = Field(default_factory=_now_iso)
    updated_by: str = Field(default="user")
    updated_at: str = Field(default_factory=_now_iso)
    deleted_at: Optional[str] = Field(default=None)
    deleted_by: Optional[str] = Field(default=None)


class Canvas(SQLModel, table=True):
    """A canvas: boards (HTML pages, images, Sketches, Diagrams), notes, arrows and labels on one large plane.

    The record holds the owner, a revision counter and the latest version number; the plane itself is one file
    (``uploads/canvases/<id>/canvas.json``) and the boards' content are attachment files next to it (see
    docs/specs/canvas.md). Deleting only unlinks (``deleted_at``), as for sketches.
    """

    __tablename__ = "canvas"

    id: str = Field(
        default_factory=lambda: f"cv_{uuid.uuid4().hex[:8]}", primary_key=True
    )
    project_id: Optional[str] = Field(
        default=None, foreign_key="project.id", index=True
    )
    owner_kind: str = Field(
        default="doc"
    )  # idea | ticket | doc | comment | page (its own Docs page)
    owner_id: str = Field(default="", index=True)
    page_id: Optional[str] = Field(
        default=None, index=True
    )  # the Docs page of a canvas that lives in Docs
    title: str = Field(default="Canvas")
    rev: int = Field(
        default=1
    )  # +1 on every save: drives the "someone saved in the meantime" check
    version: int = Field(default=0)  # latest named/checkpoint version (History)
    board_count: int = Field(default=0)
    total_bytes: int = Field(default=0)
    created_by: str = Field(default="user")
    created_at: str = Field(default_factory=_now_iso)
    updated_by: str = Field(default="user")
    updated_at: str = Field(default_factory=_now_iso)
    deleted_at: Optional[str] = Field(default=None)
    deleted_by: Optional[str] = Field(default=None)


class CanvasVersion(SQLModel, table=True):
    """A frozen copy of a canvas file (made on Done, on accepting a proposal, and every 10 minutes in Docs)."""

    __tablename__ = "canvas_version"
    __table_args__ = (
        UniqueConstraint("canvas_id", "version", name="uq_canvas_version"),
    )

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    canvas_id: str = Field(foreign_key="canvas.id", index=True)
    version: int
    name: Optional[str] = Field(default=None)
    reason: str = Field(
        default="done"
    )  # done | proposal | auto | restore | create | named
    author: str = Field(default="user")
    note: Optional[str] = Field(default=None)
    changes: str = Field(
        default="{}"
    )  # JSON {added, removed, changed: [board ids]} against the version before
    summary: str = Field(default="")
    doc: str = Field(default="{}")  # the canvas file as it was
    created_at: str = Field(default_factory=_now_iso)


class CanvasThread(SQLModel, table=True):
    """A comment thread pinned to a board (moves with it) or to a point of the plane."""

    __tablename__ = "canvas_thread"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    canvas_id: str = Field(foreign_key="canvas.id", index=True)
    number: int = Field(default=1)  # pins are numbered in the order they were made
    board_id: Optional[str] = Field(default=None)
    x: float = Field(
        default=0.5
    )  # 0..1 inside the board, or plane units without a board
    y: float = Field(default=0.5)
    page: Optional[str] = Field(default=None)  # page tab of a plane pin
    # JSON {sel, text, ox, oy, w}: the element a pin was put on (CSS selector or visible text), where inside it, and at
    # what frame width; x and y stay as the fallback when the element is not found or the frame is only a picture
    anchor: Optional[str] = Field(default=None)
    status: str = Field(default="open")  # open | resolved
    created_by: str = Field(default="user")
    created_at: str = Field(default_factory=_now_iso)
    resolved_by: Optional[str] = Field(default=None)
    resolved_at: Optional[str] = Field(default=None)


class CanvasComment(SQLModel, table=True):
    """One comment of a canvas thread (same shape as a Docs comment)."""

    __tablename__ = "canvas_comment"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    thread_id: str = Field(foreign_key="canvas_thread.id", index=True)
    author: str = Field(default="user")
    body: str = Field(default="")
    mentions: str = Field(default="[]")
    ai: Optional[str] = Field(default=None)  # JSON {member} on an AI team's comment
    created_at: str = Field(default_factory=_now_iso)
    edited_at: Optional[str] = Field(default=None)


class CanvasProposal(SQLModel, table=True):
    """What an AI member proposes for one or more boards. Nothing changes until a person accepts."""

    __tablename__ = "canvas_proposal"

    id: str = Field(
        default_factory=lambda: f"cp_{uuid.uuid4().hex[:10]}", primary_key=True
    )
    canvas_id: str = Field(foreign_key="canvas.id", index=True)
    author: str = Field(default="AI")
    member_id: Optional[str] = Field(default=None)
    job_id: Optional[str] = Field(default=None)
    request: str = Field(default="")
    note: str = Field(default="")
    status: str = Field(default="open")  # open | accepted | rejected | partly
    # JSON [{board_id, name, base_rev, status: open|accepted|rejected|stale, files: [{path, bytes}], lines}]
    changes: str = Field(default="[]")
    version: Optional[int] = Field(default=None)  # version saved when accepted
    created_at: str = Field(default_factory=_now_iso)
    decided_by: Optional[str] = Field(default=None)
    decided_at: Optional[str] = Field(default=None)


# ---------------------------------------------------------------------------
# AI members, runs, approvals and audit (see design/screens/ai-members.md)
# ---------------------------------------------------------------------------


class AiTeam(SQLModel, table=True):
    """An AI team of the project (AI v2): its lead runs a ticket as one Claude Code session and the roles of its pack
    work as subagents. `id` is the team's Member id (the row that is the assignee, the avatar, the comment author).
    (table)"""

    __tablename__ = "ai_team"

    id: str = Field(foreign_key="member.id", primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    provider: str = Field(default="claude-code")
    connection: str = Field(default="local")
    description: str = Field(default="")
    cli_path: Optional[str] = Field(default=None)
    working_dir: Optional[str] = Field(default=None)
    model: Optional[str] = Field(default=None)
    effort: Optional[str] = Field(default=None)  # low | medium | high | xhigh | max
    persona: str = Field(default="")
    # The pack the team's roles come from (services/ai/packs.py); its roles become the run's subagents
    pack_key: Optional[str] = Field(default=None)
    # JSON: mcp_servers, skills, plugins, hooks, disallowed_tools, roles overrides (services/ai/providers.merged_config)
    config: str = Field(default="{}")
    # bypass | auto: how Claude Code answers permission prompts in this team's runs
    permission_mode: str = Field(default="bypass")
    max_parallel: int = Field(default=2)
    daily_budget: Optional[float] = Field(default=None)
    monthly_cap: Optional[float] = Field(default=None)
    max_runs_per_day: Optional[int] = Field(default=None)
    tokens_per_day: Optional[int] = Field(default=None)
    cap_per_run: Optional[float] = Field(default=None)
    scope: str = Field(
        default="assigned"
    )  # assigned | project: which tickets it may pick up
    paused: bool = Field(default=False)
    paused_at: Optional[str] = Field(default=None)
    paused_reason: Optional[str] = Field(default=None)
    # Last runner check: ok | not_logged_in | runner_missing | rate_limited | unknown
    health: str = Field(default="unknown")
    health_detail: Optional[str] = Field(default=None)
    checked_at: Optional[str] = Field(default=None)
    # The AI account (own login of the CLI) this team runs as; None = the login already on this computer
    account_id: Optional[str] = Field(default=None, index=True)
    mcp_last_used_at: Optional[str] = Field(default=None)
    created_by: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiAccount(SQLModel, table=True):
    """One sign-in of one CLI (claude | codex | opencode | agy), kept in a folder of its own. Several AI members can
    use the same account. The login is kept by the CLI; the board never reads it (table)."""

    __tablename__ = "ai_account"

    id: str = Field(
        default_factory=lambda: f"acct_{uuid.uuid4().hex[:10]}", primary_key=True
    )
    name: str = Field(index=True, unique=True)  # unique per computer
    cli: str  # claude | codex | opencode | agy
    folder: str  # absolute path of the account's own folder
    # signed_in | needs_sign_in | signing_in | cli_missing; "checking" and "not_ready" are shown, not stored
    status: str = Field(default="needs_sign_in")
    status_detail: Optional[str] = Field(default=None)
    email: Optional[str] = Field(default=None)  # only Claude Code reports who
    plan: Optional[str] = Field(default=None)
    method: Optional[str] = Field(
        default=None
    )  # Subscription, ChatGPT login, Google sign-in, ...
    checked_at: Optional[str] = Field(default=None)
    signed_out_at: Optional[str] = Field(
        default=None
    )  # when it was found signed out (one event per account)
    signed_out_how: Optional[str] = Field(default=None)  # run | check
    created_by: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiConfigState(SQLModel, table=True):
    """What the board knows about an AI member's configuration besides the config itself: its version, the files
    last written into the working folder, "I've done this" ticks and the snapshot taken by Reset (table)."""

    __tablename__ = "ai_config_state"

    member_id: str = Field(foreign_key="ai_team.id", primary_key=True)
    version: int = Field(default=1)
    synced_at: Optional[str] = Field(default=None)
    synced_files: int = Field(default=0)
    # JSON [{item, by, at, hash}]: a tick is valid while the hash still matches the item's content
    ticks: str = Field(default="[]")
    # JSON {path: {units: {key: text}, written_at}}: what the board last wrote, the base of the 3-way merge
    files: str = Field(default="{}")
    # JSON {hash, by, at}: the typed "allow hooks" confirmation and the hooks it covers
    hooks_ok: str = Field(default="{}")
    # JSON {config, at, by}: the configuration before the last Reset (undo for 30 days)
    reset_snapshot: Optional[str] = Field(default=None)
    updated_at: str = Field(default_factory=_now_iso)


class AiLibraryItem(SQLModel, table=True):
    """A skill, snippet, MCP server or tool defined once for the board and attached to many AI members (table)."""

    __tablename__ = "ai_library_item"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    type: str  # skill | snippet | mcp_server | tool
    name: str
    description: str = Field(default="")
    content: str = Field(
        default=""
    )  # Markdown (skill, snippet) or JSON text (mcp_server, tool)
    version: int = Field(default=1)
    # JSON [{version, content, description, at, by, note}] of every earlier version, newest last
    history: str = Field(default="[]")
    created_by: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiRun(SQLModel, table=True):
    """One Claude Code session the board started (AI v2): a team's lead on a ticket (`kind` team), an assistant on a
    page or the board (`assistant`), or a schedule's run (`schedule`). Steps are rows of `ai_run_step`. (table)"""

    __tablename__ = "ai_run"

    id: str = Field(
        default_factory=lambda: f"run_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    kind: str = Field(default="team")  # team | assistant | schedule
    ticket_id: Optional[str] = Field(default=None, index=True)
    # An assistant's target: docs:<page id> | board | idea:<id> | sketch:<id>
    target: Optional[str] = Field(default=None, index=True)
    member_id: str = Field(foreign_key="member.id", index=True)  # the team
    number: int = Field(default=1)  # per ticket
    mode: str = Field(default="work")  # work | ask
    # assign | run_button | message (the ticket chat) | ai_message (another AI's note) | docs_threads (comment threads
    # sent from Docs) | ci_red | review_comments | retry | schedule | github | api
    trigger: str = Field(default="assign")
    # How many AI-to-AI hand-offs lie behind this run (0: a person started it). `ai_run message` stops at MAX_DEPTH.
    depth: int = Field(default=0)
    # queued | starting | running | needs_input | finished | failed | cancelled
    state: str = Field(default="queued", index=True)
    started_by: str = Field(default="user")
    instruction: str = Field(default="")
    reply_comment_id: Optional[str] = Field(default=None)
    queued_at: str = Field(default_factory=_now_iso)
    started_at: Optional[str] = Field(default=None)
    ended_at: Optional[str] = Field(default=None)
    last_output_at: Optional[str] = Field(default=None)
    ended_reason: Optional[str] = Field(default=None)
    ended_by: Optional[str] = Field(default=None)
    exit_code: Optional[int] = Field(default=None)
    summary: Optional[str] = Field(default=None)
    # JSON: the lead's final report (--json-schema): status, summary, branch, pr_url, open_items, lessons, asks
    report: str = Field(default="{}")
    question: Optional[str] = Field(
        default=None
    )  # JSON {text, options[], to, asked_at}
    answer: Optional[str] = Field(default=None)
    session_id: Optional[str] = Field(default=None)  # CLI session, for --resume
    session_name: Optional[str] = Field(
        default=None
    )  # --name: IAM-12, docs:<page>, board
    files: str = Field(default="[]")  # JSON list of {path, added, removed, new}
    tokens_in: int = Field(default=0)
    tokens_out: int = Field(default=0)
    tokens_cached: Optional[int] = Field(default=None)
    cost_usd: float = Field(default=0.0)
    metered: bool = Field(default=False)
    context_used: Optional[int] = Field(default=None)
    context_window: Optional[int] = Field(default=None)
    pid: Optional[int] = Field(default=None)
    token_hash: Optional[str] = Field(default=None, index=True)
    model: Optional[str] = Field(default=None)
    effort: Optional[str] = Field(default=None)
    paused: bool = Field(default=False)
    paused_at: Optional[str] = Field(default=None)
    # Why the run ended when it was not its own doing: budget | memory | board_closed | deleted | reassigned
    stop_code: Optional[str] = Field(default=None)
    peak_rss_mb: Optional[float] = Field(default=None)
    last_rss_mb: Optional[float] = Field(default=None)
    restarts: str = Field(default="[]")  # JSON [{at, rss_mb, limit_mb, by, n}]
    diagnosis: Optional[str] = Field(default=None)  # JSON: why the run is in trouble
    retries: str = Field(default="[]")  # JSON [{at, label, n, of}]
    retry_at: Optional[str] = Field(default=None)
    account_id: Optional[str] = Field(default=None, index=True)
    debug_log: Optional[str] = Field(default=None)  # --debug-file of the run
    steps_count: int = Field(default=0)
    waiting_reason: Optional[str] = Field(
        default=None
    )  # why a queued run waits (the scheduler writes it)
    live: bool = Field(
        default=False
    )  # the CLI runs with its input open: a message reaches it now
    details_removed_at: Optional[str] = Field(default=None)


class AiRunStep(SQLModel, table=True):
    """One thing a run (or one of its subagents) did, in order: a tool call, an edit, a command and its output, text,
    a hook event. Append-only; `output` is read only when a person opens the step. (table)"""

    __tablename__ = "ai_run_step"
    __table_args__ = (Index("ix_ai_run_step_run_seq", "run_id", "seq"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: str = Field(index=True)
    seq: int
    at: str = Field(default_factory=_now_iso)
    agent_id: Optional[str] = Field(default=None)  # None = the lead
    # tool | edit | create | read | command | search | skill | subagent | board | text | hook | rate_limited |
    # start | end | error | message
    kind: str
    tool: Optional[str] = Field(default=None)
    title: str = Field(default="")
    detail: str = Field(
        default="{}"
    )  # JSON: path, added, removed, command, exit_code, tests, tool_id ...
    output: Optional[str] = Field(default=None)
    parent_tool_id: Optional[str] = Field(default=None)
    tool_id: Optional[str] = Field(
        default=None, index=True
    )  # the tool call's id, so its result finds the step


class AiRunAgent(SQLModel, table=True):
    """A subagent of a run: the role it plays and when it worked (table)."""

    __tablename__ = "ai_run_agent"

    id: str = Field(
        primary_key=True
    )  # the lead's Agent tool call id (parent_tool_use_id in the stream)
    run_id: str = Field(index=True)
    agent_type: str = Field(default="")
    claude_id: Optional[str] = Field(
        default=None
    )  # Claude Code's own agent id (from the SubagentStart hook)
    started_at: str = Field(default_factory=_now_iso)
    ended_at: Optional[str] = Field(default=None)
    steps_count: int = Field(default=0)
    last_text: Optional[str] = Field(default=None)


class AiSessionHistory(SQLModel, table=True):
    """A closed conversation of an AI team on a ticket: what its lead was asked and did, in a title and a summary, with
    the Claude Code session ids and the runs it spanned. Made when a person starts the team over; read by any AI that
    works on the ticket or on the board (table)."""

    __tablename__ = "ai_session_history"

    id: str = Field(
        default_factory=lambda: f"ses_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(index=True)
    ticket_id: str = Field(index=True)
    member_id: str  # the team
    title: str = Field(default="")
    summary: str = Field(default="")
    session_ids: str = Field(
        default="[]"
    )  # JSON list, oldest first (a compaction or a resume may change the id)
    run_ids: str = Field(default="[]")  # JSON list of run ids, oldest first
    started_at: Optional[str] = Field(default=None)
    ended_at: str = Field(
        default_factory=_now_iso
    )  # the boundary: later runs start a new conversation
    created_by: str = Field(default="")
    summarised_by: str = Field(
        default=""
    )  # the model, or "digest" when no AI could be asked


class AiRunMessage(SQLModel, table=True):
    """A message into or out of a run: a person's note to the running lead, a message from or to another AI
    session (table)."""

    __tablename__ = "ai_run_message"

    id: str = Field(
        default_factory=lambda: f"msg_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    run_id: str = Field(index=True)
    direction: str = Field(default="in")  # in | out
    peer: str = Field(default="")  # a session name, or a person's name
    text: str = Field(default="")
    at: str = Field(default_factory=_now_iso)
    delivered_at: Optional[str] = Field(default=None)


class AiRunCommand(SQLModel, table=True):
    """What the API asks the runner process to do with a run (AI v2 stage 6): start, cancel, message, answer (table)."""

    __tablename__ = "ai_run_command"

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: str = Field(index=True)
    command: str  # start | cancel | message | answer | restart
    payload: str = Field(default="{}")
    created_at: str = Field(default_factory=_now_iso)
    taken_at: Optional[str] = Field(default=None)


class AiProjectKnowledge(SQLModel, table=True):
    """A project's instructions for every AI on it (services/ai/knowledge.py) (table)."""

    __tablename__ = "ai_project_knowledge"

    project_id: str = Field(primary_key=True)
    instructions: str = Field(default="")
    history: str = Field(default="[]")  # JSON [{at, by, text}] of earlier versions
    updated_at: Optional[str] = Field(default=None)
    updated_by: Optional[str] = Field(default=None)


class AiLesson(SQLModel, table=True):
    """One thing the project's AIs learned: proposed by an AI, kept or dropped by a person (table)."""

    __tablename__ = "ai_lesson"

    id: str = Field(
        default_factory=lambda: f"lsn_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(index=True)
    text: str = Field(default="")
    # proposed | kept | dropped | none (a ticket read by the light model with nothing to propose)
    state: str = Field(default="proposed", index=True)
    source_ticket_id: Optional[str] = Field(default=None, index=True)
    source_run_id: Optional[str] = Field(default=None)
    proposed_by: Optional[str] = Field(
        default=None
    )  # model | diagnosis | a person's name
    kept_by: Optional[str] = Field(default=None)
    uses: int = Field(default=0)  # runs whose prompt carried it
    last_used_at: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiMemoryNote(SQLModel, table=True):
    """A note an AI keeps across runs (services/ai/memory.py, issue #274): what works in this repository, the commands,
    where things are, a person's feedback. Kept by a role (every member of the role reads it), by one member (a member
    with no role) or on one ticket (every later run on that ticket reads it). Live at once, shown to people and
    editable; capped per scope (table)."""

    __tablename__ = "ai_memory_note"

    id: str = Field(
        default_factory=lambda: f"mem_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(index=True)
    scope: str = Field(default="role", index=True)  # role | member | ticket
    scope_key: str = Field(
        default="", index=True
    )  # the role key, the member id or the ticket id
    text: str = Field(default="")
    kind: str = Field(default="learned")  # learned | feedback (a person told the AI)
    written_by: Optional[str] = Field(default=None)  # a member's name or a person's
    source_run_id: Optional[str] = Field(default=None)
    source_ticket_id: Optional[str] = Field(default=None)
    uses: int = Field(default=0)  # runs whose prompt carried it
    last_used_at: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiWorktree(SQLModel, table=True):
    """A ticket's git worktree, beside the repository, on its own branch and port (services/ai/worktrees.py) (table).
    The board stores only the mapping; size and uncommitted files are read from git when asked."""

    __tablename__ = "ai_worktree"

    ticket_id: str = Field(primary_key=True)
    project_id: str = Field(index=True)
    repo: str  # the main checkout
    path: str
    branch: str
    base: str = Field(default="main")
    port: Optional[int] = Field(default=None)
    state: str = Field(
        default="active", index=True
    )  # active | conflict | kept | merged | removed
    handover: Optional[str] = Field(
        default=None
    )  # per-ticket override: pr | local | branch
    pr_url: Optional[str] = Field(default=None)
    pr_number: Optional[int] = Field(default=None)
    conflict_files: str = Field(default="[]")
    prepared_at: Optional[str] = Field(default=None)
    prepare_s: Optional[int] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    last_used_at: Optional[str] = Field(default=None)
    merged_at: Optional[str] = Field(default=None)


class AiPlugin(SQLModel, table=True):
    """A plugin installed on a project from a git URL, a marketplace or a folder (services/ai/plugins.py) (table)."""

    __tablename__ = "ai_plugin"

    id: str = Field(
        default_factory=lambda: f"plg_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: Optional[str] = Field(default=None, index=True)
    name: str = Field(index=True)
    source_kind: str = Field(default="git")  # git | marketplace | folder
    source: str
    ref: Optional[str] = Field(
        default=None
    )  # a tag, branch or commit; a commit when pinned
    plugin: Optional[str] = Field(default=None)  # the marketplace entry
    skills_wanted: str = Field(
        default="[]"
    )  # a subset of the entry's skills, when chosen
    commit: Optional[str] = Field(default=None)
    version: Optional[str] = Field(default=None)
    description: Optional[str] = Field(default=None)
    path: Optional[str] = Field(default=None)  # the installed copy
    skills: str = Field(default="[]")
    hooks: int = Field(default=0)
    mcp: int = Field(default=0)
    size_bytes: int = Field(default=0)
    pinned: bool = Field(default=False)
    default_on: bool = Field(default=False)  # the project default
    roles: str = Field(default="[]")  # role pack keys that get it
    members: str = Field(default="{}")  # {member_id: on/off}: a member's own switch
    previous: Optional[str] = Field(
        default=None
    )  # JSON {path, commit, version, skills}: one button puts it back
    installed_by: Optional[str] = Field(default=None)
    installed_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiRolePack(SQLModel, table=True):
    """A project's own role pack, or its edited copy of a ready-made one (services/ai/packs.py) (table)."""

    __tablename__ = "ai_role_pack"

    id: str = Field(
        default_factory=lambda: f"pck_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(index=True)
    key: str = Field(index=True)
    name: str
    version: int = Field(default=1)
    body: str = Field(
        default="{}"
    )  # JSON: persona, model, effort, tools, permissions, writes, hands in, limits
    # JSON list of the pack's roles as subagents (AI v2): [{key, name, description, prompt, model, effort, tools}]
    roles: str = Field(default="[]")
    history: str = Field(default="[]")
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)
    updated_by: Optional[str] = Field(default=None)


class AiRepoScan(SQLModel, table=True):
    """What the repository scan found, what it suggested and how its trial run went (services/ai/repo_scan.py)
    (table)."""

    __tablename__ = "ai_repo_scan"

    id: str = Field(
        default_factory=lambda: f"scn_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(index=True)
    folder: str
    found: str = Field(default="{}")
    suggested: str = Field(default="{}")
    trial: str = Field(default="{}")
    # The AI or the board trying the commands (design/screens/ai-repo-commands.md, C): state, steps, log
    job: str = Field(default="{}")
    # What the AI proposed: commands with where each came from, extra PATH folders, notes
    proposal: str = Field(default="{}")
    applied_at: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)


class Story(SQLModel, table=True):
    """A Story: a ticket of type story that the PM owns from the goal to Done (design/screens/ai-story-flow.md B).
    Its children are the tickets whose parent is the Story; its plan says their order and what waits for what
    (table)."""

    __tablename__ = "story"

    ticket_id: str = Field(primary_key=True, foreign_key="ticket.id")
    project_id: str = Field(index=True)
    state: str = Field(
        default="draft", index=True
    )  # draft | planning | in_progress | review | done | dropped
    approve: str = Field(default="person")  # who approves the plan: person | pm
    budget_tokens: int = Field(default=0)  # 0: no budget
    pm_id: Optional[str] = Field(default=None)
    plan: str = Field(
        default="{}"
    )  # JSON {version, by, at, waiting, approved_by, approved_at, note, items: [{ticket_id, after, covers}], changes}
    paused: bool = Field(default=False)
    review_note: Optional[str] = Field(default=None)
    history: str = Field(default="[]")  # JSON [{at, state, by}]
    meta: str = Field(default="{}")  # JSON: the PM run under way ({run_id, job})
    created_by: Optional[str] = Field(default=None)
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    handed_at: Optional[str] = Field(default=None)
    started_at: Optional[str] = Field(default=None)  # the plan was approved
    closed_at: Optional[str] = Field(default=None)


class AiWatchedPr(SQLModel, table=True):
    """A pull request the board opened, watched with gh while it is open (services/ai/github.py) (table)."""

    __tablename__ = "ai_watched_pr"

    ticket_id: str = Field(primary_key=True)
    project_id: str = Field(index=True)
    number: int
    url: Optional[str] = Field(default=None)
    branch: str
    repo: str
    state: str = Field(default="open")  # open | closed
    ci: Optional[str] = Field(default=None)  # green | red | pending | none
    red: Optional[str] = Field(
        default=None
    )  # JSON {check, url, at, blamed, base, handled_at, run_id}
    seen_comments: str = Field(default="[]")
    pending_comments: str = Field(default="[]")
    checked_at: Optional[str] = Field(default=None)
    last_error: Optional[str] = Field(default=None)


class AiKnowledgeDoc(SQLModel, table=True):
    """A document of the knowledge base: its text, a summary and keywords, in a project's store or the shared one
    (services/ai/kb.py) (table)."""

    __tablename__ = "ai_knowledge_doc"

    id: str = Field(
        default_factory=lambda: f"kb_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: Optional[str] = Field(
        default=None, index=True
    )  # None: the shared store
    store: str = Field(default="project", index=True)  # project | shared
    title: str
    kind: str = Field(default="text")  # text | pdf | image | code | docs_page
    text: str = Field(default="")
    summary: Optional[str] = Field(default=None)
    keywords: str = Field(default="[]")
    answers: str = Field(default="[]")
    described_by: Optional[str] = Field(default=None)  # model | code
    source_name: Optional[str] = Field(default=None)
    upload_url: Optional[str] = Field(default=None)
    private: bool = Field(default=False)
    tokens: int = Field(default=0)
    created_by: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    last_read_at: Optional[str] = Field(default=None)
    deleted_at: Optional[str] = Field(default=None)


class AiAccountState(SQLModel, table=True):
    """The usage window and run limit of one Claude account, or of "local" (members on the person's own login)
    (table). Read from the CLI's `rate_limit_event` (services/ai/quota.py)."""

    __tablename__ = "ai_account_state"

    key: str = Field(primary_key=True)  # AiAccount.id, or "local"
    max_parallel: int = Field(default=2)
    move_urgent: bool = Field(
        default=False
    )  # move High/Urgent work to an account with room, by itself
    five_hour_used: Optional[float] = Field(default=None)  # 0..1
    five_hour_resets_at: Optional[str] = Field(default=None)
    five_hour_status: Optional[str] = Field(default=None)
    seven_day_used: Optional[float] = Field(default=None)
    seven_day_resets_at: Optional[str] = Field(default=None)
    seven_day_status: Optional[str] = Field(default=None)
    held_until: Optional[str] = Field(
        default=None
    )  # every run of the account waits until then
    held_reason: Optional[str] = Field(default=None)
    updated_at: Optional[str] = Field(default=None)


class AiRunTranscript(SQLModel, table=True):
    """The board's own copy of a run's conversation: a compressed file in the data folder (services/ai/transcripts.py)
    (table). The run's summary stays on `AiRun` forever; this file follows the notification retention unless pinned."""

    __tablename__ = "ai_run_transcript"

    run_id: str = Field(primary_key=True)
    project_id: str = Field(index=True)
    member_id: Optional[str] = Field(default=None, index=True)
    path: str
    bytes: int = Field(default=0)
    events: int = Field(default=0)
    pinned: bool = Field(default=False)
    pinned_by: Optional[str] = Field(default=None)
    started_at: str = Field(default_factory=_now_iso)
    ended_at: Optional[str] = Field(default=None, index=True)
    # Set when the retention removed the file; the row stays so the run says "transcript removed after N days"
    deleted_at: Optional[str] = Field(default=None)


class AiSkillUse(SQLModel, table=True):
    """One time a run used a skill (the CLI's `Skill` tool) or a subagent (`Task`/`Agent`), read from its stream (table)."""

    __tablename__ = "ai_skill_use"

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: str = Field(index=True)
    project_id: str = Field(index=True)
    member_id: Optional[str] = Field(default=None, index=True)
    kind: str = Field(default="skill")  # skill | subagent
    name: str = Field(index=True)  # "plugin:skill" or "skill"
    plugin: Optional[str] = Field(default=None, index=True)
    at: str = Field(default_factory=_now_iso)


class AiAudit(SQLModel, table=True):
    """Append-only record of every action an AI member attempted, chained by hash (table)."""

    __tablename__ = "ai_audit"

    id: str = Field(
        default_factory=lambda: f"aud_{uuid.uuid4().hex[:10]}", primary_key=True
    )
    seq: int = Field(default=0, index=True)
    project_id: str = Field(index=True)
    member_id: Optional[str] = Field(default=None, index=True)
    member_name: str = Field(default="")
    on_behalf_of: Optional[str] = Field(default=None)
    run_id: Optional[str] = Field(default=None, index=True)
    action: str  # permission action or a lifecycle event (run_started, kill_switch, …)
    target: Optional[str] = Field(default=None)  # usually a ticket id
    # allowed | approved | needs_approval | denied | blocked | reverted | info
    result: str = Field(default="allowed")
    detail: str = Field(default="{}")  # JSON: request (redacted), reason, before/after
    created_at: str = Field(default_factory=_now_iso)
    reverted_at: Optional[str] = Field(default=None)
    reverted_by: Optional[str] = Field(default=None)
    prev_hash: str = Field(default="")
    hash: str = Field(default="")


class AiTouchMark(SQLModel, table=True):
    """The mark a person gave to one touch of the tab "You stepped in" (needed | avoidable), and the lesson made from
    it. Touches are worked out from runs, messages and the audit log; this small table keeps only what a person added
    to one, under the touch's stable key, so a run or audit clean-up never removes it. (table)"""

    __tablename__ = "ai_touch_mark"

    key: str = Field(
        primary_key=True
    )  # answer:<run> | run:<run> | stop:<run> | msg:<id> | audit:<id> ...
    project_id: str = Field(index=True)
    mark: str = Field(default="needed")  # needed | avoidable
    marked_by: Optional[str] = Field(default=None)
    marked_at: str = Field(default_factory=_now_iso)
    lesson_id: Optional[str] = Field(
        default=None
    )  # the proposed lesson "Make a lesson" created


class AiProjectSettings(SQLModel, table=True):
    """Per-project AI settings (AI v2): the kill switch, board-wide limits, the permission mode of runs, the deny list,
    how lessons are kept, and the v2 operations JSON (services/ai/ops.py) (table)."""

    __tablename__ = "ai_project_settings"

    project_id: str = Field(foreign_key="project.id", primary_key=True)
    paused_all: bool = Field(default=False)
    paused_at: Optional[str] = Field(default=None)
    paused_reason: Optional[str] = Field(default=None)
    board_daily_cap: Optional[float] = Field(default=None)
    board_monthly_budget: Optional[float] = Field(default=None)
    board_tokens_per_day: Optional[int] = Field(default=None)
    board_max_parallel: int = Field(default=4)
    board_runs_per_day: Optional[int] = Field(default=None)
    board_at_cap: str = Field(default="pause")  # pause | stop
    run_memory_limit_mb: int = Field(default=4096)
    audit_retention_days: Optional[int] = Field(default=90)
    run_retention_days: Optional[int] = Field(
        default=None
    )  # not used any more (AI v2); the column stays
    permission_mode: str = Field(
        default="bypass"
    )  # bypass | auto (a team may override)
    deny_list: str = Field(
        default="[]"
    )  # JSON list of tool rules Claude Code refuses, e.g. "Bash(git push --force*)"
    lessons_mode: str = Field(default="auto")  # auto | review
    lessons_max: int = Field(default=40)
    ops: str = Field(
        default="{}"
    )  # JSON: live_messages, per-account concurrency, skills on, ... (services/ai/ops.py)


class NotifyEvent(SQLModel, table=True):
    """The event log: one append-only row per thing that happened, with an increasing id (never reused, even after
    retention deletes old rows). Notification rows are built from it, one per recipient (table)."""

    __tablename__ = "notify_event"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: Optional[str] = Field(
        default=None, index=True
    )  # None: app-wide (an AI account)
    kind: str = Field(index=True)  # services/notifications.py KINDS, or "resolve"
    op: str = Field(default="new")  # new | resolve
    needs: bool = Field(default=False)  # Needs you (may interrupt) or for information
    target_kind: Optional[str] = Field(
        default=None
    )  # run | approval | account | ticket | page | thread | ...
    target_id: Optional[str] = Field(default=None, index=True)
    ticket_id: Optional[str] = Field(default=None)
    page_id: Optional[str] = Field(default=None)
    member_id: Optional[str] = Field(default=None)  # the AI member it is about
    actor: Optional[str] = Field(default=None)  # who caused it
    title: str = Field(default="")
    body: str = Field(default="")
    data: str = Field(default="{}")  # JSON facts
    recipients: str = Field(
        default="[]"
    )  # JSON recipient keys the rows were written for
    created_at: str = Field(default_factory=_now_iso, index=True)


class Notification(SQLModel, table=True):
    """One notification for one recipient (a person's key, or "ai:<member id>"), built from the log. Events of one
    group (same kind and project inside 10 minutes, or the same request) are merged into one row (table)."""

    __tablename__ = "notification"
    __table_args__ = (
        Index("ix_notification_recipient_open", "recipient", "done_at"),
        # the open Needs you rows `reconcile` checks on every publish
        Index("ix_notification_open_needs", "needs", "done_at"),
    )

    id: str = Field(
        default_factory=lambda: f"nt_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    recipient: str = Field(index=True)
    event_id: int = Field(index=True)  # the first event of the row
    last_event_id: int = Field(index=True)  # the newest event merged in
    project_id: Optional[str] = Field(default=None, index=True)
    kind: str = Field(index=True)
    needs: bool = Field(default=False)
    group_key: str = Field(index=True)
    count: int = Field(default=1)
    items: str = Field(
        default="[]"
    )  # JSON [{event_id, title, ticket_id, member_id, at}] of a grouped row
    target_kind: Optional[str] = Field(default=None)
    target_id: Optional[str] = Field(default=None, index=True)
    ticket_id: Optional[str] = Field(default=None)
    page_id: Optional[str] = Field(default=None)
    member_id: Optional[str] = Field(default=None)
    actor: Optional[str] = Field(default=None)
    title: str = Field(default="")
    body: str = Field(default="")
    data: str = Field(default="{}")
    inapp: bool = Field(
        default=True
    )  # False: quiet (not in the panel or the count, still on the page)
    desktop: bool = Field(default=False)
    read_at: Optional[str] = Field(default=None)
    done_at: Optional[str] = Field(default=None)
    done_reason: Optional[str] = Field(default=None)
    done_by: Optional[str] = Field(default=None)
    snoozed_until: Optional[str] = Field(default=None)
    cleared_at: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso, index=True)
    updated_at: str = Field(default_factory=_now_iso, index=True)


class NotifyFollow(SQLModel, table=True):
    """Following and muting, per recipient: a ticket, a Docs page, a Docs space, a project or an event kind (table).
    A Docs space follow (scope "space", scope_id = project id) is what DocsFollow was."""

    __tablename__ = "notify_follow"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    recipient: str = Field(index=True)
    scope: str  # ticket | page | space | project | kind
    scope_id: str = Field(index=True)  # ticket id, page id, project id, or the kind
    project_id: Optional[str] = Field(
        default=None, index=True
    )  # a kind muted in one project only
    level: str = Field(default="follow")  # follow | everything | mentions | mute
    until: Optional[str] = Field(default=None)  # a mute for a while (UTC ISO)
    label: str = Field(default="")  # what the Muted list shows
    created_at: str = Field(default_factory=_now_iso)


class NotifyPrefs(SQLModel, table=True):
    """Settings › Notifications of one recipient (JSON); the row "*" holds the app-wide retention (table)."""

    __tablename__ = "notify_prefs"

    recipient: str = Field(primary_key=True)
    prefs: str = Field(default="{}")
    updated_at: str = Field(default_factory=_now_iso)


class AiAssistSettings(SQLModel, table=True):
    """Board-wide settings of the Board AI assistant: features, language, style, data scope, limits and the
    board-health schedule (design/screens/ai-board-assistant.md, H). One row (id 1)."""

    __tablename__ = "ai_assist_settings"

    id: int = Field(default=1, primary_key=True)
    # JSON {chat, drafting, split, test_cases, health, docs}: bool
    features: str = Field(default="{}")
    language: str = Field(default="English (US)")
    tone: str = Field(default="neutral")  # neutral | friendly | concise
    style_guide: str = Field(default="")
    monthly_cap: Optional[float] = Field(default=20.0)
    per_request_cap: Optional[float] = Field(default=0.25)
    over_cap: str = Field(default="pause")  # pause | warn
    # JSON {project_id: bool}; a project not listed is shared
    data_scope: str = Field(default="{}")
    excluded_docs: str = Field(default="[]")  # JSON list of docs page ids, never sent
    # JSON: schedule and noise controls of board health
    health: str = Field(default="{}")
    paused_until: Optional[str] = Field(default=None)


class AiChat(SQLModel, table=True):
    """One Board AI conversation; private to the person who started it, kept 30 days."""

    __tablename__ = "ai_chat"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    owner: str = Field(index=True)  # person name (X-Actor)
    title: str = Field(default="New chat")
    scope: str = Field(default="project")  # ticket | doc | idea | project | all
    ticket_id: Optional[str] = Field(default=None)
    doc_id: Optional[str] = Field(default=None)
    # The thing the chat is about, for any scope kind (ticket id, page id, idea id…); `scope` is its kind
    scope_id: Optional[str] = Field(default=None, index=True)
    # The AI member that answers; None means the project's Board AI
    member_id: Optional[str] = Field(default=None)
    include_docs: str = Field(
        default="[]"
    )  # private docs its owner included for this chat
    cost: float = Field(default=0.0)
    tokens: int = Field(default=0)
    applied: bool = Field(default=False)
    # Claude Code conversation of a local Board AI: the whole chat is one session, so it is not resent each time
    session_id: Optional[str] = Field(default=None)
    # Rolling summary of the older messages (API-key Board AI has no CLI session): messages created up to
    # `summary_upto` are covered by `summary` and are not sent again
    summary: str = Field(default="")
    summary_upto: Optional[str] = Field(default=None)
    compactions: int = Field(default=0)
    # The last time its owner had this chat open and in front of them (the page tells every ~15 s): a run that ends
    # while it is fresh does not send an "AI finished" notice, the answer is on the screen
    seen_at: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiChatMessage(SQLModel, table=True):
    """A message in a Board AI chat; an answer streams into `text` while `state` is thinking/streaming."""

    __tablename__ = "ai_chat_message"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    chat_id: str = Field(foreign_key="ai_chat.id", index=True)
    role: str  # user | ai
    text: str = Field(default="")
    # queued | thinking | streaming | done | stopped | error | rate_limited | over_budget
    state: str = Field(default="done")
    steps: str = Field(default="[]")
    context: str = Field(
        default="{}"
    )  # what was read: counts, items, truncation, injections
    actions: str = Field(default="[]")  # suggested actions (drafts only)
    draft_id: Optional[str] = Field(default=None)
    error: str = Field(default="{}")
    retry_at: Optional[str] = Field(default=None)
    member_id: Optional[str] = Field(default=None)
    model: Optional[str] = Field(default=None)
    cost: float = Field(default=0.0)
    tokens_in: int = Field(default=0)
    tokens_out: int = Field(default=0)
    metered: bool = Field(default=True)
    # The asker's thumbs up / down with a reason: {thumb, reason, at}
    feedback: str = Field(default="{}")
    created_at: str = Field(default_factory=_now_iso)
    finished_at: Optional[str] = Field(default=None)


class AiUsage(SQLModel, table=True):
    """Metering of the Board AI per feature (chat, drafting, split, test_cases, health, docs)."""

    __tablename__ = "ai_usage"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    feature: str = Field(index=True)
    member_id: Optional[str] = Field(default=None)
    person: Optional[str] = Field(default=None)
    cost: float = Field(default=0.0)
    tokens_in: int = Field(default=0)
    tokens_out: int = Field(default=0)
    metered: bool = Field(default=True)
    created_at: str = Field(default_factory=_now_iso, index=True)


class AiInsight(SQLModel, table=True):
    """A board-health finding: stuck, WIP overload, blocked chain, unassigned, at risk, priority."""

    __tablename__ = "ai_insight"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    kind: str
    key: str = Field(
        index=True
    )  # identity of the finding, so a re-check updates instead of duplicating
    ticket_id: Optional[str] = Field(default=None)
    title: str
    detail: str = Field(default="")
    data: str = Field(default="{}")
    score: float = Field(default=0.0)
    state: str = Field(default="open")  # open | snoozed | dismissed | acted | resolved
    snoozed_until: Optional[str] = Field(default=None)
    seen: bool = Field(default=False)
    draft_id: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiDigest(SQLModel, table=True):
    """The standup summary written at each board-health check."""

    __tablename__ = "ai_digest"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    day: str
    summary: str = Field(default="{}")
    member_id: Optional[str] = Field(default=None)
    cost: float = Field(default=0.0)
    tokens: int = Field(default=0)
    created_at: str = Field(default_factory=_now_iso)


class AiSchedule(SQLModel, table=True):
    """An AI member works on a ticket at a set time, once or on repeat (design/screens/ai-schedules.md)."""

    __tablename__ = "ai_schedule"

    id: str = Field(
        default_factory=lambda: f"sch_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    ticket_id: str = Field(index=True)
    member_id: str = Field(index=True)
    backup_member_id: Optional[str] = Field(default=None)
    created_by: str = Field(
        default="user"
    )  # owns the schedule; runs act on their behalf
    kind: str = Field(default="repeat")  # once | repeat
    run_at: Optional[str] = Field(
        default=None
    )  # once: local "YYYY-MM-DDTHH:MM" in `tz`
    days: str = Field(default="[0,1,2,3,4]")  # repeat: JSON weekday numbers, Monday = 0
    time: str = Field(default="02:00")  # repeat: local HH:MM in `tz`
    tz: str = Field(default="UTC")
    ends: str = Field(default="never")  # never | after | on_date
    ends_after: Optional[int] = Field(default=None)
    ends_on: Optional[str] = Field(default=None)  # YYYY-MM-DD
    window_end: Optional[str] = Field(
        default=None
    )  # HH:MM: a late start is allowed until then
    # JSON {criteria, tests: {on, command, cwd}, summary, branch, ai_checks: [text]}
    checks: str = Field(default="{}")
    # JSON {on, reviewer_id, fix_rounds}
    review: str = Field(default="{}")
    # JSON {stop_after_min, retries, max_cost}
    limits: str = Field(default="{}")
    catch_up: str = Field(default="run")  # run | skip | ask
    catch_up_hours: float = Field(default=2.0)
    notify: str = Field(
        default='["started","needs_input","failed","finished"]'
    )  # JSON events
    notify_people: str = Field(default="[]")  # JSON extra people besides the creator
    instruction: str = Field(default="")
    state: str = Field(default="active", index=True)  # active | paused | ended
    paused_reason: Optional[str] = Field(default=None)
    failures_in_row: int = Field(default=0)
    runs_count: int = Field(default=0)
    next_run_at: Optional[str] = Field(default=None, index=True)  # UTC ISO
    ticket_seen_at: Optional[str] = Field(
        default=None
    )  # ticket updated_at when last saved
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiScheduleRun(SQLModel, table=True):
    """One slot of a schedule: the run(s) it started, how each check turned out and what the reviewer said."""

    __tablename__ = "ai_schedule_run"
    # A slot starts once, even across restarts (G: "starts are guarded")
    __table_args__ = (
        Index("ux_ai_schedule_slot", "schedule_id", "slot_at", unique=True),
    )

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    schedule_id: str = Field(foreign_key="ai_schedule.id", index=True)
    project_id: str = Field(index=True)
    ticket_id: str = Field(index=True)
    slot_at: str  # UTC ISO of the planned start
    # waiting | ask | running | reviewing | fixing | passed | partly | failed | skipped | cancelled
    state: str = Field(default="waiting", index=True)
    catch_up: bool = Field(default=False)
    member_id: Optional[str] = Field(default=None)  # who ran it (the backup when used)
    run_ids: str = Field(default="[]")  # JSON, in order (retries and fix rounds)
    attempts: int = Field(default=0)
    fix_round: int = Field(default=0)
    results: str = Field(
        default="[]"
    )  # JSON [{key, label, kind: machine|ai, ok, detail}]
    review: str = Field(
        default="{}"
    )  # JSON {reviewer_id, verdict, notes, rounds, cost}
    note: Optional[str] = Field(default=None)
    started_at: Optional[str] = Field(default=None)
    ended_at: Optional[str] = Field(default=None)
    duration_s: int = Field(default=0)
    cost_usd: float = Field(default=0.0)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


# ---------------------------------------------------------------------------
# Request / Response schemas (not table=True)
# ---------------------------------------------------------------------------


def _completion_of(ticket: Any) -> dict:
    """completed_at / completed_by of a closed ticket: its latest move into Done or Won't Do."""
    if ticket.status not in ("done", "wont_do"):
        return {"completed_at": None, "completed_by": None}
    for e in reversed(_parse_json_list(ticket.activity_log)):
        if (
            isinstance(e, dict)
            and e.get("field") == "status"
            and e.get("to") == ticket.status
        ):
            return {"completed_at": e.get("at"), "completed_by": e.get("actor")}
    return {"completed_at": None, "completed_by": None}


def _parse_json_list(v: Any) -> list:
    """Parse a JSON string to a list, or pass through if already a list."""
    if isinstance(v, str):
        if not v:
            return []
        parsed = json.loads(v)
        return parsed if isinstance(parsed, list) else []
    return v if v is not None else []


class ActivityEventRead(SQLModel):
    """One activity entry as returned by the activity feed."""

    ticketId: str
    ticketTitle: str
    event_type: str
    at: str
    detail: str | None = None


class ProjectCreate(SQLModel):
    """Payload to create a project."""

    name: str
    prefix: str
    color: str


class ProjectUpdate(SQLModel):
    """Partial update of a project."""

    name: Optional[str] = None
    color: Optional[str] = None
    repo_path: Optional[str] = None  # empty string clears the link
    worktree_template: Optional[str] = None
    worktree_by_default: Optional[bool] = None
    docs_enabled: Optional[bool] = None
    docs_edit_policy: Optional[Literal["everyone", "members", "admins"]] = None


class ProjectRead(SQLModel):
    """Project as returned by the API."""

    id: str
    name: str
    prefix: str
    color: str
    ticket_counter: int
    repo_path: Optional[str] = None
    worktree_template: Optional[str] = None
    worktree_by_default: bool = False
    docs_enabled: bool = True
    docs_edit_policy: str = "members"


class MemberCreate(SQLModel):
    """Payload to add a member to a project."""

    name: str
    color: Optional[str] = None
    role: str = "member"


class MemberRoleUpdate(SQLModel):
    """Payload to change a member's Docs role."""

    role: str


class MemberRead(SQLModel):
    """Member as returned by the API."""

    id: str
    project_id: str
    name: str
    color: str
    role: str = "member"
    kind: str = "human"
    created_at: str


class TicketCreate(SQLModel):
    """Full ticket payload used by the service layer."""

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
    branches: list[Any] = []
    workspace_retention_days: Optional[int] = None
    created_by: Optional[str] = None
    assignee: Optional[str] = None


class TicketCreateBody(SQLModel):
    """Request body to create a ticket in a project."""

    title: str
    description: str = ""
    type: Literal["bug", "feature", "task", "chore", "story"] = "task"
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    status: Literal[
        "backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"
    ] = "backlog"
    estimate: Optional[float] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    tags: list[Any] = []
    parent_id: Optional[str] = None
    assignee: Optional[str] = None


class TicketUpdate(SQLModel):
    """Partial update of a ticket."""

    title: Optional[str] = None
    description: Optional[str] = None
    type: Optional[Literal["bug", "feature", "task", "chore", "story"]] = None
    status: Optional[
        Literal[
            "backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"
        ]
    ] = None
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
    repo_path: Optional[str] = None  # empty/null clears the ticket override
    # a sub-ticket's wave pinned by hand; null: computed from Blocked by again (TDP-1)
    wave_pin: Optional[int] = None
    # who the review is asked of (member id); null clears it
    review_requested_from: Optional[str] = None


class TicketRead(SQLModel):
    """Ticket as returned by the API, with JSON columns parsed."""

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
    sub_tasks: list[Any] = []
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
    branches: list[Any] = []
    workspace_retention_days: Optional[int] = None
    repo_path: Optional[str] = None
    # Reopen fields
    reopen_count: int = 0
    last_reopened_at: Optional[str] = None
    last_reopened_by: Optional[str] = None
    last_reopen_reason: Optional[str] = None
    reopen_history: list[Any] = []
    # Pending fields
    pending: bool = False
    pending_reason_type: Optional[str] = None
    pending_ticket_id: Optional[str] = None
    pending_member_id: Optional[str] = None
    pending_party: Optional[str] = None
    pending_note: Optional[str] = None
    pending_since: Optional[str] = None
    pending_by: Optional[str] = None
    from_idea_id: Optional[str] = None
    tests_assumption_id: Optional[str] = None
    wave_pin: Optional[int] = (
        None  # TDP-1: None means the wave is computed from Blocked by
    )
    review_requested_from: Optional[str] = None
    # When / by whom a Done or Won't Do ticket was closed (derived from the activity log)
    completed_at: Optional[str] = None
    completed_by: Optional[str] = None
    created_at: str
    updated_at: str

    @classmethod
    def from_ticket(cls, ticket: Ticket) -> "TicketRead":
        """Build the read model from a stored ticket."""
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
            comments=[
                c
                for c in _parse_json_list(ticket.comments)
                if not (isinstance(c, dict) and c.get("deleted_at"))
            ],
            acceptance_criteria=_parse_json_list(ticket.acceptance_criteria),
            sub_tasks=_parse_json_list(getattr(ticket, "sub_tasks", "[]")),
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
            branches=_parse_json_list(getattr(ticket, "branches", "[]")),
            workspace_retention_days=getattr(ticket, "workspace_retention_days", None),
            repo_path=getattr(ticket, "repo_path", None),
            reopen_count=getattr(ticket, "reopen_count", 0) or 0,
            last_reopened_at=getattr(ticket, "last_reopened_at", None),
            last_reopened_by=getattr(ticket, "last_reopened_by", None),
            last_reopen_reason=getattr(ticket, "last_reopen_reason", None),
            reopen_history=_parse_json_list(getattr(ticket, "reopen_history", "[]")),
            pending=bool(getattr(ticket, "pending", False)),
            pending_reason_type=getattr(ticket, "pending_reason_type", None),
            pending_ticket_id=getattr(ticket, "pending_ticket_id", None),
            pending_member_id=getattr(ticket, "pending_member_id", None),
            pending_party=getattr(ticket, "pending_party", None),
            pending_note=getattr(ticket, "pending_note", None),
            pending_since=getattr(ticket, "pending_since", None),
            pending_by=getattr(ticket, "pending_by", None),
            from_idea_id=getattr(ticket, "from_idea_id", None),
            tests_assumption_id=getattr(ticket, "tests_assumption_id", None),
            wave_pin=getattr(ticket, "wave_pin", None),
            review_requested_from=getattr(ticket, "review_requested_from", None),
            **_completion_of(ticket),
            created_at=ticket.created_at,
            updated_at=ticket.updated_at,
        )


IDEA_COLORS = ("yellow", "orange", "lime", "pink", "blue", "purple", "teal")


class IdeaTicketCreateBody(SQLModel):
    """Request body to create an idea ticket."""

    project_id: Optional[str] = None  # None: the idea belongs to no project yet
    title: str
    description: str = ""
    idea_color: str = "yellow"
    idea_emoji: str = "💡"
    idea_energy: Optional[Literal["seed", "concept", "hot", "big_bet"]] = None
    tags: list[Any] = Field(default_factory=list)
    problem_statement: Optional[str] = None
    source: Literal[
        "manual", "selection", "doc", "comment", "ticket", "picture", "ai", "import"
    ] = "manual"
    source_ref: Optional[dict[str, Any]] = None

    @field_validator("idea_color")
    @classmethod
    def validate_color(cls, v: str) -> str:
        """Reject an `idea_color` outside the allowed palette.

        Args:
            v: Submitted color.

        Returns:
            The color, unchanged.

        Raises:
            ValueError: If the color is not in the palette.
        """
        if v not in IDEA_COLORS:
            raise ValueError(
                f"idea_color must be one of: {', '.join(sorted(IDEA_COLORS))}"
            )
        return v


class IdeaTicketUpdate(SQLModel):
    """Partial update of an idea ticket."""

    title: Optional[str] = None
    description: Optional[str] = None
    idea_color: Optional[str] = None
    idea_emoji: Optional[str] = None
    idea_energy: Optional[Literal["seed", "concept", "hot", "big_bet"]] = None
    tags: Optional[list[Any]] = None
    problem_statement: Optional[str] = None
    ice_impact: Optional[int] = Field(default=None, ge=1, le=5)
    ice_effort: Optional[int] = Field(default=None, ge=1, le=5)
    ice_confidence: Optional[int] = Field(default=None, ge=1, le=5)
    revisit_date: Optional[str] = None

    @field_validator("idea_color")
    @classmethod
    def validate_color(cls, v: Optional[str]) -> Optional[str]:
        """Reject an `idea_color` outside the allowed palette.

        Args:
            v: Submitted color, or None when not being changed.

        Returns:
            The color, unchanged.

        Raises:
            ValueError: If the color is not in the palette.
        """
        if v is not None and v not in IDEA_COLORS:
            raise ValueError(
                f"idea_color must be one of: {', '.join(sorted(IDEA_COLORS))}"
            )
        return v


def _parse_json_dict(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if value else {}
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def idea_readiness(assumptions: Any) -> dict[str, Any]:
    """How ready an idea is, worked out from its assumptions (design: "F. Readiness").

    Only high-impact assumptions decide it; if none is high-impact, every assumption must be validated.
    An idea with no assumptions is "not_started", never "ready".

    Args:
        assumptions: The idea's assumption records.

    Returns:
        {state: not_started|growing|ready|at_risk, total, validated, testing, untested, disproved,
        high_open (high-impact ones not yet validated), high_disproved, next_id (the assumption to test first)}.
    """
    items = list(assumptions)
    counts = {s: sum(1 for a in items if a.status == s) for s in ASSUMPTION_STATUSES}
    high = [a for a in items if a.impact == "high"]
    deciding = high or items
    high_open = [a for a in high if a.status != "validated"]
    high_disproved = [a for a in high if a.status == "disproved"]
    if not items:
        state = "not_started"
    elif high_disproved:
        state = "at_risk"
    elif all(a.status == "validated" for a in deciding) and not counts["disproved"]:
        state = "ready"
    else:
        state = "growing"
    first = next((a for a in high_open if a.status != "disproved"), None)
    return {
        "state": state,
        "total": len(items),
        **counts,
        "high_open": len(high_open),
        "high_disproved": len(high_disproved),
        "next_id": first.id if first else None,
    }


# What the current Idea board understands of the new assumption statuses.
_LEGACY_ASSUMPTION_STATUS = {"testing": "untested", "disproved": "invalidated"}


def _assumption_view(a: IdeaAssumption) -> dict[str, Any]:
    """An assumption as the API returns it: the old keys, plus the fields of the new model."""
    return {
        "id": a.id,
        "text": a.text,
        "status": _LEGACY_ASSUMPTION_STATUS.get(a.status, a.status),
        "at": a.created_at,
        "state": a.status,
        "impact": a.impact,
        "test_ticket_id": a.test_ticket_id,
        "ai": a.ai,
        "evidence": [
            {
                "id": e.id,
                "kind": e.kind,
                "title": e.title,
                "ref": e.ref,
                "created_by": e.created_by,
                "created_at": e.created_at,
            }
            for e in a.evidence
        ],
    }


class IdeaTicketRead(SQLModel):
    """Idea ticket as returned by the API."""

    id: str
    project_id: Optional[str]
    title: str
    description: str
    idea_status: str
    stage: str
    park_until: Optional[str]
    archive_reason: Optional[str]
    source: str
    body: str
    details: str
    votes: int
    voters: list[str] = Field(default_factory=list)
    source_ref: dict[str, Any] = Field(default_factory=dict)
    created_by: Optional[str] = None
    owner: Optional[str] = None
    park_note: Optional[str] = None
    archive_note: Optional[str] = None
    stage_changed_at: Optional[str] = None
    merged_into_id: Optional[str] = None
    merged_at: Optional[str] = None
    shipped_at: Optional[str] = None
    outcome: Optional[str] = None
    outcome_note: Optional[str] = None
    effort_guess: Optional[str] = None
    workspace_retention: str = "open_then_30"
    former_ticket_id: Optional[str] = None
    comment_count: int = 0
    log_count: int = 0
    evidence_count: int = 0
    readiness: dict[str, Any] = Field(default_factory=dict)
    # The ticket it became, filled in by the API layer: {id, title, status, project_id}.
    ticket: Optional[dict[str, Any]] = None
    # Whether the current actor may move and edit it (viewers can only add, vote and comment); API layer.
    can_edit: bool = True
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
        """Build the read model from a stored idea ticket."""
        return cls(
            id=ticket.id,
            project_id=ticket.project_id,
            title=ticket.title,
            description=ticket.description,
            idea_status=ticket.idea_status,
            stage=ticket.stage,
            park_until=ticket.park_until,
            archive_reason=ticket.archive_reason,
            source=ticket.source,
            body=ticket.body,
            details=ticket.details,
            votes=len(ticket.vote_records),
            voters=[v.voter for v in ticket.vote_records],
            source_ref=_parse_json_dict(ticket.source_ref),
            created_by=ticket.created_by,
            owner=ticket.owner,
            park_note=ticket.park_note,
            archive_note=ticket.archive_note,
            stage_changed_at=ticket.stage_changed_at,
            merged_into_id=ticket.merged_into_id,
            merged_at=ticket.merged_at,
            shipped_at=ticket.shipped_at,
            outcome=ticket.outcome,
            outcome_note=ticket.outcome_note,
            effort_guess=ticket.effort_guess,
            workspace_retention=ticket.workspace_retention,
            former_ticket_id=ticket.former_ticket_id,
            comment_count=len(ticket.comment_records),
            log_count=len(ticket.log_records),
            evidence_count=sum(len(a.evidence) for a in ticket.assumption_records),
            readiness=idea_readiness(ticket.assumption_records),
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
            microthoughts=[
                {"id": c.id, "text": c.body, "at": c.created_at}
                for c in ticket.comment_records
            ],
            assumptions=[_assumption_view(a) for a in ticket.assumption_records],
            created_at=ticket.created_at,
            updated_at=ticket.updated_at,
        )


# Long text is text on every engine (VARCHAR(255) on MySQL otherwise), and MySQL tables are utf8mb4 with exact
# comparison: design/screens/ai-databases.md F, "Long text"
from dbkit.types import portable_text  # noqa: E402

portable_text(SQLModel.metadata)
