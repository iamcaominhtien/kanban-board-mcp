"""idea_ai_helpers: AI settings, triage advice and weekly digests of the Idea Space; AI mark on assumptions

Revision ID: c9d0e1f2a3b4
Revises: f4a6b8c0d2e4
Create Date: 2026-10-29 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: Union[str, Sequence[str], None] = "f4a6b8c0d2e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.add_column(
        "idea_assumption",
        sa.Column("ai", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "idea_ai_settings",
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "triage_advice", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column(
            "weekly_grooming", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("ask", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("read_docs", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("read_repo", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("daily_cap", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("updated_at", _S(), nullable=False),
        sa.PrimaryKeyConstraint("project_id"),
    )
    op.create_table(
        "idea_advice",
        sa.Column("id", _S(), nullable=False),
        sa.Column("idea_id", _S(), nullable=False),
        sa.Column("action", _S(), nullable=False),
        sa.Column("reason", _S(), nullable=False, server_default=""),
        sa.Column("confidence", _S(), nullable=False, server_default="medium"),
        sa.Column("target_id", _S(), nullable=True),
        sa.Column("archive_reason", _S(), nullable=True),
        sa.Column("park_days", sa.Integer(), nullable=True),
        sa.Column("idea_stamp", _S(), nullable=False, server_default=""),
        sa.Column("member_id", _S(), nullable=True),
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("state", _S(), nullable=False, server_default="open"),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["idea_id"], ["idea_ticket.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_idea_advice_idea_id", "idea_advice", ["idea_id"])
    op.create_table(
        "idea_digest",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False, server_default=""),
        sa.Column("text", _S(), nullable=False, server_default=""),
        sa.Column("items", _S(), nullable=False, server_default="[]"),
        sa.Column("ai", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("member_id", _S(), nullable=True),
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
        sa.Column("ideas_read", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", _S(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_idea_digest_project_id", "idea_digest", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_idea_digest_project_id", "idea_digest")
    op.drop_table("idea_digest")
    op.drop_index("ix_idea_advice_idea_id", "idea_advice")
    op.drop_table("idea_advice")
    op.drop_table("idea_ai_settings")
    with op.batch_alter_table("idea_assumption", schema=None) as batch_op:
        batch_op.drop_column("ai")
