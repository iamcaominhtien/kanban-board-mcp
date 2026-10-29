"""AI provider configuration: per-member config state (version, written files, ticks) and the shared library.

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f5a6b7c8d9e0"
down_revision: Union[str, Sequence[str], None] = "e4f5a6b7c8d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _s(name: str, *args, **kw) -> sa.Column:
    return sa.Column(name, sa.String(), *args, **kw)


def upgrade() -> None:
    """Create the config state and library tables."""
    op.create_table(
        "ai_config_state",
        _s("member_id", sa.ForeignKey("ai_member.id"), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        _s("synced_at", nullable=True),
        sa.Column("synced_files", sa.Integer(), nullable=False, server_default="0"),
        _s("ticks", nullable=False, server_default="[]"),
        _s("files", nullable=False, server_default="{}"),
        _s("hooks_ok", nullable=False, server_default="{}"),
        _s("reset_snapshot", nullable=True),
        _s("updated_at", nullable=False),
    )
    op.create_table(
        "ai_library_item",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("type", nullable=False),
        _s("name", nullable=False),
        _s("description", nullable=False, server_default=""),
        _s("content", nullable=False, server_default=""),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        _s("history", nullable=False, server_default="[]"),
        _s("created_by", nullable=True),
        _s("created_at", nullable=False),
        _s("updated_at", nullable=False),
    )


def downgrade() -> None:
    """Drop them again."""
    op.drop_table("ai_library_item")
    op.drop_table("ai_config_state")
