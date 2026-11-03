"""Fast mode: a ticket keeps its pace (set without running anything), and its workflow a copy of it

Additive: a new table (no row is the normal pace), and a nullable column on ai_ticket_workflow that every existing
workflow starts with empty (the normal pace).

Revision ID: a3c5e7f9b1d4
Revises: d7a9c1e3f5b8
Create Date: 2026-11-03 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a3c5e7f9b1d4"
down_revision: Union[str, Sequence[str], None] = "d7a9c1e3f5b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_ticket_workflow") as batch:
        batch.add_column(sa.Column("pace", sa.String(), nullable=True))
    op.create_table(
        "ai_ticket_pace",
        sa.Column("ticket_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("pace", sa.String(), nullable=False),
        sa.Column("set_by", sa.String(), nullable=True),
        sa.Column("set_at", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("ticket_id"),
    )
    op.create_index(
        "ix_ai_ticket_pace_project_id", "ai_ticket_pace", ["project_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_ai_ticket_pace_project_id", table_name="ai_ticket_pace")
    op.drop_table("ai_ticket_pace")
    with op.batch_alter_table("ai_ticket_workflow") as batch:
        batch.drop_column("pace")
