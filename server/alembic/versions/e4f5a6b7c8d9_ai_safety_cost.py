"""AI safety and cost: limits, approval rules, grants, notifications and workspace defaults.

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e4f5a6b7c8d9"
down_revision: Union[str, Sequence[str], None] = "d3e4f5a6b7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _s(name: str, *args, **kw) -> sa.Column:
    return sa.Column(name, sa.String(), *args, **kw)


def _i(name: str, **kw) -> sa.Column:
    return sa.Column(name, sa.Integer(), **kw)


def _b(name: str, default: bool = False) -> sa.Column:
    return sa.Column(
        name,
        sa.Boolean(),
        nullable=False,
        server_default=sa.true() if default else sa.false(),
    )


def upgrade() -> None:
    """Add the columns and tables of the safety and cost features."""
    with op.batch_alter_table("ai_member") as b:
        b.add_column(_b("safe_mode"))
        b.add_column(_b("allow_external"))
        b.add_column(_i("tokens_per_day", nullable=True))
        b.add_column(sa.Column("cap_per_run", sa.Float(), nullable=True))
        b.add_column(_s("warn_at", nullable=False, server_default="[80,100]"))
        b.add_column(_s("key_rotated_at", nullable=True))
        b.add_column(_s("mcp_last_used_at", nullable=True))
        b.add_column(_s("token_revoked_at", nullable=True))
        b.add_column(_s("token_revoked_by", nullable=True))
    with op.batch_alter_table("ai_approval") as b:
        b.add_column(_s("before", nullable=False, server_default="{}"))
    with op.batch_alter_table("ai_project_settings") as b:
        b.add_column(
            _i("board_tokens_per_day", nullable=True, server_default="1000000")
        )
        b.add_column(_i("board_max_parallel", nullable=False, server_default="4"))
        b.add_column(_i("board_runs_per_day", nullable=True, server_default="60"))
        b.add_column(_s("board_at_cap", nullable=False, server_default="pause"))
        b.add_column(_s("approval_on_expiry", nullable=False, server_default="skip"))
        b.add_column(
            _s(
                "approvers",
                nullable=False,
                server_default='{"low":"member","medium":"admin","high":"owner"}',
            )
        )
        b.add_column(_s("delegates", nullable=False, server_default="[]"))
        b.add_column(_i("audit_retention_days", nullable=True, server_default="90"))
        b.add_column(_i("loop_cooldown_s", nullable=False, server_default="60"))
        b.add_column(_b("no_repeat_chain", True))
        b.add_column(
            _s(
                "allowed_domains",
                nullable=False,
                server_default='["github.com","developer.mozilla.org"]',
            )
        )
        b.add_column(_s("notify", nullable=False, server_default="{}"))
        b.add_column(_s("digest", nullable=False, server_default="daily"))
        b.add_column(_s("alert_state", nullable=False, server_default="{}"))
        b.add_column(_s("checklist", nullable=False, server_default="{}"))
        b.add_column(_i("key_reminder_days", nullable=False, server_default="90"))
        b.add_column(_i("paused_cancelled", nullable=False, server_default="0"))
        b.add_column(_i("paused_held", nullable=False, server_default="0"))
        b.add_column(_b("paused_tokens_revoked"))
    op.create_table(
        "ai_grant",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("kind", nullable=False),
        _s("member_id", nullable=True, index=True),
        _s("ticket_id", nullable=True, index=True),
        _s("action", nullable=True),
        sa.Column("amount", sa.Float(), nullable=False, server_default="0"),
        _s("day", nullable=True),
        _s("created_by", nullable=False, server_default="user"),
        _s("created_at", nullable=False),
        _s("revoked_at", nullable=True),
        _s("source_approval_id", nullable=True),
    )
    op.create_table(
        "ai_notification",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("event", nullable=False),
        _s("title", nullable=False),
        _s("body", nullable=False, server_default=""),
        _s("ref_kind", nullable=True),
        _s("ref_id", nullable=True),
        _s("member_id", nullable=True),
        _s("people", nullable=False, server_default="[]"),
        _b("urgent", True),
        _b("inapp", True),
        _b("desktop"),
        _b("digest"),
        _s("data", nullable=False, server_default="{}"),
        _s("created_at", nullable=False, index=True),
    )
    op.create_table(
        "ai_workspace_defaults",
        sa.Column("id", sa.Integer(), primary_key=True),
        _s("template", nullable=False, server_default="developer"),
        _s("ceiling", nullable=False, server_default="review"),
        _s("delete_mode", nullable=False, server_default="blocked"),
        sa.Column("daily_budget", sa.Float(), nullable=True, server_default="5"),
        sa.Column("monthly_cap", sa.Float(), nullable=True, server_default="120"),
        _s("updated_by", nullable=True),
        _s("updated_at", nullable=True),
    )


def downgrade() -> None:
    """Remove them again."""
    op.drop_table("ai_workspace_defaults")
    op.drop_table("ai_notification")
    op.drop_table("ai_grant")
    with op.batch_alter_table("ai_project_settings") as b:
        for name in (
            "paused_tokens_revoked",
            "paused_held",
            "paused_cancelled",
            "key_reminder_days",
            "checklist",
            "alert_state",
            "digest",
            "notify",
            "allowed_domains",
            "no_repeat_chain",
            "loop_cooldown_s",
            "audit_retention_days",
            "delegates",
            "approvers",
            "approval_on_expiry",
            "board_at_cap",
            "board_runs_per_day",
            "board_max_parallel",
            "board_tokens_per_day",
        ):
            b.drop_column(name)
    with op.batch_alter_table("ai_approval") as b:
        b.drop_column("before")
    with op.batch_alter_table("ai_member") as b:
        for name in (
            "token_revoked_by",
            "token_revoked_at",
            "mcp_last_used_at",
            "key_rotated_at",
            "warn_at",
            "cap_per_run",
            "tokens_per_day",
            "allow_external",
            "safe_mode",
        ):
            b.drop_column(name)
