import json
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import field_validator
from sqlalchemy import Index, text
from sqlmodel import Field, SQLModel


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
    project_id: str = Field(foreign_key="project.id")
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
    sub_tasks: str = Field(default="[]")  # JSON: checklist of {id, text, done}
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
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


IDEA_STATUSES = ("draft", "in_review", "approved", "dropped")


class IdeaTicket(SQLModel, table=True):
    """Idea Space ticket (table)."""

    __tablename__ = "idea_ticket"

    id: str = Field(primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    title: str
    description: str = Field(default="")
    idea_status: str = Field(default="draft")  # draft|in_review|approved|dropped
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
    activity_trail: str = Field(default="[]")  # JSON list of {id, label, at}
    microthoughts: str = Field(default="[]")  # JSON list of {id, text, at}
    assumptions: str = Field(default="[]")  # JSON list of {id, text, status}
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class DocsPage(SQLModel, table=True):
    """A page in a project's Docs space (soft-deleted via deleted_at)."""

    __tablename__ = "docs_page"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    parent_id: Optional[str] = Field(default=None, foreign_key="docs_page.id")
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


class DocsDraft(SQLModel, table=True):
    """Autosaved, per-author working copy of a page."""

    __tablename__ = "docs_draft"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    author: str = Field(default="user")
    title: str
    markdown: str = Field(default="")
    base_version: int = Field(default=0)
    updated_at: str = Field(default_factory=_now_iso)


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
    page_id: str = Field(foreign_key="docs_page.id", index=True)
    thread_id: Optional[str] = Field(default=None)
    comment_id: Optional[str] = Field(default=None)
    kind: str  # comment | reply | resolved | reopened
    actor: str = Field(default="user")
    mentioned: str = Field(default="[]")  # JSON list of member names
    recipients: str = Field(default="[]")  # JSON list of names to notify
    page_title: str = Field(default="")
    snippet: str = Field(default="")
    created_at: str = Field(default_factory=_now_iso)


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
    mode: str = Field(default="self-hosted")  # self-hosted | public
    url: str = Field(
        default=""
    )  # self-hosted editor address, e.g. http://localhost:8080


# ---------------------------------------------------------------------------
# AI members, runs, approvals and audit (see design/screens/ai-members.md)
# ---------------------------------------------------------------------------


class AiMember(SQLModel, table=True):
    """Connection, identity, limits and permissions of an AI member; `id` is its Member id (table)."""

    __tablename__ = "ai_member"

    id: str = Field(foreign_key="member.id", primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    # claude-code | antigravity (local runner) · anthropic | openai | gemini | custom (API key) · mcp-client (inbox)
    # A copy of an AI member in another project points to the original (services/ai/multiproject.py)
    linked_to: Optional[str] = Field(default=None, index=True)
    provider: str
    connection: str  # local | api_key | inbox
    description: str = Field(default="")
    glyph: str = Field(default="spark")
    cli_path: Optional[str] = Field(default=None)
    working_dir: Optional[str] = Field(default=None)
    base_url: Optional[str] = Field(default=None)
    model: Optional[str] = Field(default=None)
    key_enc: Optional[str] = Field(default=None)  # encrypted API key, never returned
    key_last4: Optional[str] = Field(default=None)
    persona: str = Field(default="")
    max_parallel: int = Field(default=2)
    daily_budget: Optional[float] = Field(default=5.0)  # USD, API-key members
    monthly_cap: Optional[float] = Field(default=None)
    max_runs_per_day: Optional[int] = Field(default=20)  # local runners
    template: str = Field(
        default="developer"
    )  # developer | reviewer | read_only | custom
    ceiling: str = Field(default="review")  # highest status it may move a ticket to
    permissions: str = Field(
        default="{}"
    )  # JSON {action: mode}, only stricter than the template
    scope: str = Field(default="assigned")  # assigned | project
    config: str = Field(default="{}")  # JSON: instructions, MCP servers, rules, limits
    paused: bool = Field(default=False)
    paused_at: Optional[str] = Field(default=None)
    paused_reason: Optional[str] = Field(default=None)
    # Last connection check: ok | key_invalid | not_logged_in | runner_missing | rate_limited | model_retired | unknown
    health: str = Field(default="unknown")
    health_detail: Optional[str] = Field(default=None)
    checked_at: Optional[str] = Field(default=None)
    cli_version: Optional[str] = Field(default=None)
    account: Optional[str] = Field(default=None)
    last_call_at: Optional[str] = Field(default=None)
    retry_at: Optional[str] = Field(
        default=None
    )  # while rate-limited: when queued runs try again
    remove_after_run: bool = Field(default=False)
    # Safety and cost (design/screens/ai-safety-cost.md, C, D5, F3, F6)
    safe_mode: bool = Field(default=False)  # this agent alone is read and comment only
    allow_external: bool = Field(
        default=False
    )  # may read untrusted (guest / imported) text, fenced
    tokens_per_day: Optional[int] = Field(default=None)  # API-key members
    cap_per_run: Optional[float] = Field(default=None)  # USD per run, API-key members
    warn_at: str = Field(
        default="[80,100]"
    )  # JSON budget percentages that raise an alert
    key_rotated_at: Optional[str] = Field(default=None)
    mcp_last_used_at: Optional[str] = Field(
        default=None
    )  # last call with one of its run tokens
    token_revoked_at: Optional[str] = Field(default=None)
    token_revoked_by: Optional[str] = Field(default=None)
    created_by: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class AiConfigState(SQLModel, table=True):
    """What the board knows about an AI member's configuration besides the config itself: its version, the files
    last written into the working folder, "I've done this" ticks and the snapshot taken by Reset (table)."""

    __tablename__ = "ai_config_state"

    member_id: str = Field(foreign_key="ai_member.id", primary_key=True)
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
    """One run of an AI member on a ticket: a piece of work (`work`) or an answer (`ask`) (table)."""

    __tablename__ = "ai_run"
    # One agent holds a ticket at a time: at most one active work run per ticket (also under concurrent requests)
    __table_args__ = (
        Index(
            "ux_ai_run_ticket_hold",
            "ticket_id",
            unique=True,
            sqlite_where=text(
                "mode = 'work' AND behind_run_id IS NULL "
                "AND state IN ('queued', 'starting', 'running', 'needs_input')"
            ),
        ),
    )

    id: str = Field(
        default_factory=lambda: f"run_{uuid.uuid4().hex[:12]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    ticket_id: str = Field(index=True)
    member_id: str = Field(foreign_key="member.id", index=True)
    number: int = Field(default=1)  # per ticket
    mode: str = Field(default="work")  # work | ask
    # assign | mention | ask | retry | run_button | request_changes | answer
    trigger: str = Field(default="assign")
    # queued | starting | running | needs_input | finished | failed | cancelled | timed_out
    state: str = Field(default="queued", index=True)
    started_by: str = Field(
        default="user"
    )  # person who caused it (the run acts on their behalf)
    instruction: str = Field(default="")
    source_comment_id: Optional[str] = Field(default=None)
    reply_comment_id: Optional[str] = Field(default=None)
    include_context: bool = Field(default=True)
    chain: str = Field(
        default="[]"
    )  # JSON list of member ids that woke each other (@mention hops)
    queued_at: str = Field(default_factory=_now_iso)
    started_at: Optional[str] = Field(default=None)
    ended_at: Optional[str] = Field(default=None)
    last_output_at: Optional[str] = Field(default=None)
    ended_reason: Optional[str] = Field(default=None)
    ended_by: Optional[str] = Field(default=None)
    exit_code: Optional[int] = Field(default=None)
    summary: Optional[str] = Field(default=None)
    # JSON the agent reported: {summary, criteria: [{text, met, evidence}], tests}
    report: str = Field(default="{}")
    question: Optional[str] = Field(
        default=None
    )  # JSON {text, options[], to, asked_at}
    answer: Optional[str] = Field(default=None)
    session_id: Optional[str] = Field(default=None)  # CLI session, for --resume
    steps: str = Field(default="[]")  # JSON list of {at, kind, text, detail?}
    files: str = Field(default="[]")  # JSON list of {path, added, removed, new}
    tokens_in: int = Field(default=0)
    tokens_out: int = Field(default=0)
    cost_usd: float = Field(default=0.0)
    metered: bool = Field(default=False)
    status_before: Optional[str] = Field(default=None)
    status_changes: str = Field(default="[]")  # JSON list of {from, to, at}
    pid: Optional[int] = Field(default=None)
    token_hash: Optional[str] = Field(
        default=None, index=True
    )  # MCP bearer token of this run
    model: Optional[str] = Field(default=None)
    # Pause after the current step (a person's action); the run stays `running`
    paused: bool = Field(default=False)
    paused_at: Optional[str] = Field(default=None)
    # A second AI waiting for the holder of the ticket: the id of the run it waits behind (`queued` meanwhile)
    behind_run_id: Optional[str] = Field(default=None)
    # "Queue" on assign: wait until the member has no run going (not just a free slot)
    queue_after_current: bool = Field(default=False)
    # "Raise the limit": minutes this run may take, instead of the member's own limit
    limit_min: Optional[int] = Field(default=None)
    # An answer comment that this run's reply replaces once it is posted ("Edit and re-run" → Replace it)
    replaces_comment_id: Optional[str] = Field(default=None)
    # JSON {rating: up|down, reasons[], by, at} given to an answer
    feedback: Optional[str] = Field(default=None)
    # Why the run ended when it was not the run's own doing: budget | archive | deleted | takeover | reassigned
    stop_code: Optional[str] = Field(default=None)
    # The status the AI tried to move the ticket to and was not allowed to (the "blocked move" toast)
    blocked_move: Optional[str] = Field(default=None)
    # JSON [{at, by, field, step}]: edits a person made to the ticket while this run was working on it
    context_notes: str = Field(default="[]")


AI_ACTIVE_STATES = ("queued", "starting", "running", "needs_input")


class AiApproval(SQLModel, table=True):
    """An action an AI member asked to take that waits for a person (table)."""

    __tablename__ = "ai_approval"

    id: str = Field(
        default_factory=lambda: f"apr_{uuid.uuid4().hex[:10]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    member_id: str = Field(foreign_key="member.id", index=True)
    run_id: Optional[str] = Field(default=None)
    ticket_id: Optional[str] = Field(default=None, index=True)
    action: str  # permission action, e.g. change_assignee
    summary: str = Field(default="")
    payload: str = Field(default="{}")  # JSON {tool, action, params}
    reason: Optional[str] = Field(default=None)  # the AI's own words
    risk: str = Field(default="medium")  # low | medium | high
    status: str = Field(
        default="pending"
    )  # pending | approved | denied | expired | failed | run_ended
    on_behalf_of: Optional[str] = Field(default=None)
    before: str = Field(
        default="{}"
    )  # JSON of the fields the request changes, as they were when it was asked
    requested_at: str = Field(default_factory=_now_iso)
    expires_at: Optional[str] = Field(default=None)
    decided_by: Optional[str] = Field(default=None)
    decided_at: Optional[str] = Field(default=None)
    decision_note: Optional[str] = Field(default=None)


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


class AiProjectSettings(SQLModel, table=True):
    """Per-project AI settings: Board AI, kill switch, safe mode and board-wide limits (table)."""

    __tablename__ = "ai_project_settings"

    project_id: str = Field(foreign_key="project.id", primary_key=True)
    board_ai_id: Optional[str] = Field(default=None)
    paused_all: bool = Field(default=False)
    paused_at: Optional[str] = Field(default=None)
    paused_by: Optional[str] = Field(default=None)
    paused_reason: Optional[str] = Field(default=None)
    safe_mode: bool = Field(default=False)
    board_daily_cap: Optional[float] = Field(default=15.0)
    board_monthly_budget: Optional[float] = Field(default=200.0)
    max_chain_depth: int = Field(default=3)
    runs_per_ticket_per_day: int = Field(default=6)
    approval_expiry_hours: int = Field(default=24)
    # Safety and cost (design/screens/ai-safety-cost.md, B5, C4, D, E3, F6, G, H1)
    board_tokens_per_day: Optional[int] = Field(default=1_000_000)
    board_max_parallel: int = Field(default=4)
    board_runs_per_day: Optional[int] = Field(default=60)
    board_at_cap: str = Field(default="pause")  # pause | stop | ask
    approval_on_expiry: str = Field(default="skip")  # skip | stop
    # JSON risk -> least role that may decide it (the assigner may always decide low and medium)
    approvers: str = Field(default='{"low":"member","medium":"admin","high":"owner"}')
    delegates: str = Field(default="[]")  # JSON [{from, to, until}]
    audit_retention_days: Optional[int] = Field(
        default=90
    )  # None keeps entries forever
    loop_cooldown_s: int = Field(default=60)
    no_repeat_chain: bool = Field(default=True)
    allowed_domains: str = Field(default='["github.com","developer.mozilla.org"]')
    notify: str = Field(default="{}")  # JSON event -> {inapp, desktop}
    digest: str = Field(default="daily")  # off | daily | weekdays
    alert_state: str = Field(
        default="{}"
    )  # JSON "member:percent" -> day of the last alert
    checklist: str = Field(
        default="{}"
    )  # JSON {dismissed, ticked: []} of the first-time checklist
    key_reminder_days: int = Field(default=90)
    auto_trip: str = Field(
        default="{}"
    )  # JSON rule -> {on, count, minutes, factor} (D6)
    paused_cancelled: int = Field(default=0)
    paused_held: int = Field(default=0)
    paused_tokens_revoked: bool = Field(default=False)


class AiGrant(SQLModel, table=True):
    """A standing decision by a person: remember an approval for a ticket, raise a cap for a day, or allow more
    runs on a ticket (table)."""

    __tablename__ = "ai_grant"

    id: str = Field(
        default_factory=lambda: f"grt_{uuid.uuid4().hex[:10]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    kind: str  # approval | cap_raise | extra_runs
    member_id: Optional[str] = Field(default=None, index=True)
    ticket_id: Optional[str] = Field(default=None, index=True)
    action: Optional[str] = Field(
        default=None
    )  # permission action of an `approval` grant
    amount: float = Field(default=0.0)  # USD of a cap raise, runs of extra_runs
    day: Optional[str] = Field(
        default=None
    )  # local YYYY-MM-DD a cap raise or extra runs apply to
    created_by: str = Field(default="user")
    created_at: str = Field(default_factory=_now_iso)
    revoked_at: Optional[str] = Field(default=None)
    source_approval_id: Optional[str] = Field(default=None)


class AiNotification(SQLModel, table=True):
    """An AI safety notification for the in-app toast and the desktop notification (table)."""

    __tablename__ = "ai_notification"

    id: str = Field(
        default_factory=lambda: f"ntf_{uuid.uuid4().hex[:10]}", primary_key=True
    )
    project_id: str = Field(foreign_key="project.id", index=True)
    event: str  # approval_requested | auto_trip | budget | blocked | offline
    title: str
    body: str = Field(default="")
    ref_kind: Optional[str] = Field(default=None)  # approval | member | ticket | audit
    ref_id: Optional[str] = Field(default=None)
    member_id: Optional[str] = Field(default=None)
    people: str = Field(default="[]")  # JSON names who see it besides owners and admins
    urgent: bool = Field(default=True)
    inapp: bool = Field(default=True)
    desktop: bool = Field(default=False)
    digest: bool = Field(default=False)  # held for the daily digest
    data: str = Field(default="{}")  # JSON extras, e.g. the percent of a budget alert
    created_at: str = Field(default_factory=_now_iso, index=True)


class AiWorkspaceDefaults(SQLModel, table=True):
    """Start values for every new AI member, one row for the whole workspace (table)."""

    __tablename__ = "ai_workspace_defaults"

    id: int = Field(default=1, primary_key=True)
    template: str = Field(default="developer")
    ceiling: str = Field(default="review")
    delete_mode: str = Field(default="blocked")  # blocked | approval
    daily_budget: Optional[float] = Field(default=5.0)
    monthly_cap: Optional[float] = Field(default=120.0)
    updated_by: Optional[str] = Field(default=None)
    updated_at: Optional[str] = Field(default=None)


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
    scope: str = Field(default="project")  # ticket | project | all
    ticket_id: Optional[str] = Field(default=None)
    doc_id: Optional[str] = Field(default=None)
    include_docs: str = Field(
        default="[]"
    )  # private docs its owner included for this chat
    cost: float = Field(default=0.0)
    tokens: int = Field(default=0)
    applied: bool = Field(default=False)
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


class AiDraft(SQLModel, table=True):
    """Something the Board AI proposed. Nothing is written until a person accepts it; `result` keeps what
    accepting changed so it can be undone."""

    __tablename__ = "ai_draft"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    # changes | ticket | description | split | test_cases | doc_summary | doc_section | doc_links | assignee
    kind: str
    owner: str
    member_id: Optional[str] = Field(default=None)
    member_name: str = Field(default="")
    ticket_id: Optional[str] = Field(default=None, index=True)
    doc_id: Optional[str] = Field(default=None)
    chat_message_id: Optional[str] = Field(default=None)
    insight_id: Optional[str] = Field(default=None)
    base: str = Field(
        default="{}"
    )  # {ticket_id: updated_at} when drafted, for the conflict check
    payload: str = Field(default="{}")
    raw: str = Field(default="")
    status: str = Field(default="open")  # open | applied | discarded | expired | undone
    result: str = Field(default="{}")
    cost: float = Field(default=0.0)
    tokens: int = Field(default=0)
    created_at: str = Field(default_factory=_now_iso)
    expires_at: Optional[str] = Field(default=None)
    applied_at: Optional[str] = Field(default=None)
    applied_by: Optional[str] = Field(default=None)


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
    type: Literal["bug", "feature", "task", "chore"] = "task"
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
    type: Optional[Literal["bug", "feature", "task", "chore"]] = None
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
            **_completion_of(ticket),
            created_at=ticket.created_at,
            updated_at=ticket.updated_at,
        )


IDEA_COLORS = ("yellow", "orange", "lime", "pink", "blue", "purple", "teal")


class IdeaTicketCreateBody(SQLModel):
    """Request body to create an idea ticket."""

    project_id: str
    title: str
    description: str = ""
    idea_color: str = "yellow"
    idea_emoji: str = "💡"
    idea_energy: Optional[Literal["seed", "concept", "hot", "big_bet"]] = None
    tags: list[Any] = Field(default_factory=list)
    problem_statement: Optional[str] = None

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


class IdeaTicketRead(SQLModel):
    """Idea ticket as returned by the API."""

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
        """Build the read model from a stored idea ticket."""
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
