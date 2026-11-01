"""notifications: the event log, rows per recipient, follow and mute, prefs; the 09:00 AI safety digest goes

Revision ID: a1b2c3d4e5f7
Revises: fd73ce3d5800
Create Date: 2026-11-01 12:00:00.000000

"""

import json
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f7"
down_revision: str | Sequence[str] | None = "fd73ce3d5800"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The eight AI safety events and their family (services/notifications.py SAFETY_KINDS)
_SAFETY_KIND = {
    "approval_requested": "approval",
    "auto_trip": "auto_trip",
    "budget": "budget",
    "blocked": "blocked",
    "offline": "offline",
    "question": "question",
    "run_restarted": "run_restarted",
    "run_stopped_memory": "run_stopped_memory",
}


def upgrade() -> None:
    op.create_table(
        "notify_event",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("op", sa.String(), nullable=False, server_default="new"),
        sa.Column("needs", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("target_kind", sa.String(), nullable=True),
        sa.Column("target_id", sa.String(), nullable=True),
        sa.Column("ticket_id", sa.String(), nullable=True),
        sa.Column("page_id", sa.String(), nullable=True),
        sa.Column("member_id", sa.String(), nullable=True),
        sa.Column("actor", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("body", sa.String(), nullable=False, server_default=""),
        sa.Column("data", sa.String(), nullable=False, server_default="{}"),
        sa.Column("recipients", sa.String(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.String(), nullable=False),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_notify_event_project_id", "notify_event", ["project_id"])
    op.create_index("ix_notify_event_kind", "notify_event", ["kind"])
    op.create_index("ix_notify_event_target_id", "notify_event", ["target_id"])
    op.create_index("ix_notify_event_created_at", "notify_event", ["created_at"])

    op.create_table(
        "notification",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("recipient", sa.String(), nullable=False),
        sa.Column("event_id", sa.Integer(), nullable=False),
        sa.Column("last_event_id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("needs", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("group_key", sa.String(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("items", sa.String(), nullable=False, server_default="[]"),
        sa.Column("target_kind", sa.String(), nullable=True),
        sa.Column("target_id", sa.String(), nullable=True),
        sa.Column("ticket_id", sa.String(), nullable=True),
        sa.Column("page_id", sa.String(), nullable=True),
        sa.Column("member_id", sa.String(), nullable=True),
        sa.Column("actor", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("body", sa.String(), nullable=False, server_default=""),
        sa.Column("data", sa.String(), nullable=False, server_default="{}"),
        sa.Column("inapp", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("desktop", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("read_at", sa.String(), nullable=True),
        sa.Column("done_at", sa.String(), nullable=True),
        sa.Column("done_reason", sa.String(), nullable=True),
        sa.Column("done_by", sa.String(), nullable=True),
        sa.Column("snoozed_until", sa.String(), nullable=True),
        sa.Column("cleared_at", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    for col in (
        "recipient",
        "event_id",
        "last_event_id",
        "project_id",
        "kind",
        "group_key",
        "target_id",
        "created_at",
        "updated_at",
    ):
        op.create_index(f"ix_notification_{col}", "notification", [col])
    op.create_index(
        "ix_notification_recipient_open", "notification", ["recipient", "done_at"]
    )

    op.create_table(
        "notify_follow",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("recipient", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("scope_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=True),
        sa.Column("level", sa.String(), nullable=False, server_default="follow"),
        sa.Column("until", sa.String(), nullable=True),
        sa.Column("label", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.create_index("ix_notify_follow_recipient", "notify_follow", ["recipient"])
    op.create_index("ix_notify_follow_scope_id", "notify_follow", ["scope_id"])
    op.create_index("ix_notify_follow_project_id", "notify_follow", ["project_id"])

    op.create_table(
        "notify_prefs",
        sa.Column("recipient", sa.String(), primary_key=True),
        sa.Column("prefs", sa.String(), nullable=False, server_default="{}"),
        sa.Column("updated_at", sa.String(), nullable=False),
    )

    bind = op.get_bind()
    _move_docs_follows(bind)
    _carry_safety_desktop_prefs(bind)
    with op.batch_alter_table("ai_notification") as batch_op:
        batch_op.drop_column("digest")
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.drop_column("digest")
        batch_op.drop_column("notify")


def _move_docs_follows(bind) -> None:
    """DocsFollow becomes one case of following: a Docs space (scope "space", scope_id = the project)."""
    insp = sa.inspect(bind)
    if not insp.has_table("docs_follow"):
        return
    rows = bind.execute(
        sa.text("SELECT project_id, follower, created_at FROM docs_follow")
    ).fetchall()
    for project_id, follower, created_at in rows:
        key = (follower or "user").strip().lower() or "user"
        if key == "you":
            key = "user"
        bind.execute(
            sa.text(
                "INSERT INTO notify_follow (id, recipient, scope, scope_id, project_id, level, label, created_at) "
                "VALUES (:id, :r, 'space', :p, :p, 'follow', 'Docs space', :at)"
            ),
            {"id": str(uuid.uuid4()), "r": key, "p": project_id, "at": created_at},
        )
    op.drop_index("ix_docs_follow_project_id", table_name="docs_follow")
    op.drop_table("docs_follow")


def _safety_desktop_choices(raw: str | None) -> dict[str, bool]:
    """The explicit desktop choices of one project's notify prefs, by safety family ({} when unreadable)."""
    try:
        prefs = json.loads(raw or "{}")
    except ValueError:
        return {}
    return {
        _SAFETY_KIND[event]: bool(v["desktop"])
        for event, v in (prefs or {}).items()
        if isinstance(v, dict) and "desktop" in v and event in _SAFETY_KIND
    }


def _carry_safety_desktop_prefs(bind) -> None:
    """Safety notifications held for the 09:00 digest are no longer held: they are ordinary rows now. The per-project
    switches move to the app-wide settings; an explicit desktop choice of the board's own user is carried over."""
    carried: dict[str, dict] = {}
    for (raw,) in bind.execute(sa.text("SELECT notify FROM ai_project_settings")):
        for family, desktop in _safety_desktop_choices(raw).items():
            carried.setdefault(family, {})["desktop"] = desktop
    if carried:
        bind.execute(
            sa.text(
                "INSERT INTO notify_prefs (recipient, prefs, updated_at) VALUES ('user', :p, datetime('now'))"
            ),
            {"p": json.dumps({"events": carried})},
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.add_column(
            sa.Column("notify", sa.String(), nullable=False, server_default="{}")
        )
        batch_op.add_column(
            sa.Column("digest", sa.String(), nullable=False, server_default="daily")
        )
    with op.batch_alter_table("ai_notification") as batch_op:
        batch_op.add_column(
            sa.Column("digest", sa.Boolean(), nullable=False, server_default="0")
        )
    op.create_table(
        "docs_follow",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project_id", sa.String(), sa.ForeignKey("project.id"), nullable=False
        ),
        sa.Column("follower", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.create_index("ix_docs_follow_project_id", "docs_follow", ["project_id"])
    bind = op.get_bind()
    for r, p, at in bind.execute(
        sa.text(
            "SELECT recipient, scope_id, created_at FROM notify_follow WHERE scope = 'space'"
        )
    ):
        bind.execute(
            sa.text(
                "INSERT INTO docs_follow (id, project_id, follower, created_at) VALUES (:id, :p, :f, :at)"
            ),
            {"id": str(uuid.uuid4()), "p": p, "f": r, "at": at},
        )
    op.drop_table("notify_prefs")
    op.drop_table("notify_follow")
    op.drop_table("notification")
    op.drop_table("notify_event")
