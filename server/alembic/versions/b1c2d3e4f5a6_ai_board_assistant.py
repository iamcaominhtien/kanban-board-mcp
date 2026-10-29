"""Board AI assistant: settings, chats, drafts, usage, insights and digests.

Revision ID: b1c2d3e4f5a6
Revises: a9b8c7d6e5f4
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, Sequence[str], None] = "a9b8c7d6e5f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _s(name: str, *args, **kw) -> sa.Column:
    return sa.Column(name, sa.String(), *args, **kw)


def upgrade() -> None:
    """Create the Board AI tables."""
    op.create_table(
        "ai_assist_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        _s("features", nullable=False, server_default="{}"),
        _s("language", nullable=False, server_default="English (US)"),
        _s("tone", nullable=False, server_default="neutral"),
        _s("style_guide", nullable=False, server_default=""),
        sa.Column("monthly_cap", sa.Float(), nullable=True),
        sa.Column("per_request_cap", sa.Float(), nullable=True),
        _s("over_cap", nullable=False, server_default="pause"),
        _s("data_scope", nullable=False, server_default="{}"),
        _s("excluded_docs", nullable=False, server_default="[]"),
        _s("health", nullable=False, server_default="{}"),
        _s("paused_until", nullable=True),
    )
    op.create_table(
        "ai_chat",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("owner", nullable=False, index=True),
        _s("title", nullable=False, server_default="New chat"),
        _s("scope", nullable=False, server_default="project"),
        _s("ticket_id", nullable=True),
        _s("doc_id", nullable=True),
        _s("include_docs", nullable=False, server_default="[]"),
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("applied", sa.Boolean(), nullable=False, server_default=sa.false()),
        _s("created_at", nullable=False),
        _s("updated_at", nullable=False),
    )
    op.create_table(
        "ai_chat_message",
        _s("id", primary_key=True),
        _s("chat_id", sa.ForeignKey("ai_chat.id"), nullable=False, index=True),
        _s("role", nullable=False),
        _s("text", nullable=False, server_default=""),
        _s("state", nullable=False, server_default="done"),
        _s("steps", nullable=False, server_default="[]"),
        _s("context", nullable=False, server_default="{}"),
        _s("actions", nullable=False, server_default="[]"),
        _s("draft_id", nullable=True),
        _s("error", nullable=False, server_default="{}"),
        _s("retry_at", nullable=True),
        _s("member_id", nullable=True),
        _s("model", nullable=True),
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tokens_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("metered", sa.Boolean(), nullable=False, server_default=sa.true()),
        _s("created_at", nullable=False),
        _s("finished_at", nullable=True),
    )
    op.create_table(
        "ai_draft",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("kind", nullable=False),
        _s("owner", nullable=False),
        _s("member_id", nullable=True),
        _s("member_name", nullable=False, server_default=""),
        _s("ticket_id", nullable=True, index=True),
        _s("doc_id", nullable=True),
        _s("chat_message_id", nullable=True),
        _s("insight_id", nullable=True),
        _s("base", nullable=False, server_default="{}"),
        _s("payload", nullable=False, server_default="{}"),
        _s("raw", nullable=False, server_default=""),
        _s("status", nullable=False, server_default="open"),
        _s("result", nullable=False, server_default="{}"),
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tokens", sa.Integer(), nullable=False, server_default="0"),
        _s("created_at", nullable=False),
        _s("expires_at", nullable=True),
        _s("applied_at", nullable=True),
        _s("applied_by", nullable=True),
    )
    op.create_table(
        "ai_usage",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("feature", nullable=False, index=True),
        _s("member_id", nullable=True),
        _s("person", nullable=True),
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tokens_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("metered", sa.Boolean(), nullable=False, server_default=sa.true()),
        _s("created_at", nullable=False, index=True),
    )
    op.create_table(
        "ai_insight",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("kind", nullable=False),
        _s("key", nullable=False, index=True),
        _s("ticket_id", nullable=True),
        _s("title", nullable=False),
        _s("detail", nullable=False, server_default=""),
        _s("data", nullable=False, server_default="{}"),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        _s("state", nullable=False, server_default="open"),
        _s("snoozed_until", nullable=True),
        sa.Column("seen", sa.Boolean(), nullable=False, server_default=sa.false()),
        _s("draft_id", nullable=True),
        _s("created_at", nullable=False),
        _s("updated_at", nullable=False),
    )
    op.create_table(
        "ai_digest",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("day", nullable=False),
        _s("summary", nullable=False, server_default="{}"),
        _s("member_id", nullable=True),
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tokens", sa.Integer(), nullable=False, server_default="0"),
        _s("created_at", nullable=False),
    )


def downgrade() -> None:
    """Drop the Board AI tables."""
    for name in (
        "ai_digest",
        "ai_insight",
        "ai_usage",
        "ai_draft",
        "ai_chat_message",
        "ai_chat",
        "ai_assist_settings",
    ):
        op.drop_table(name)
