"""AI team manager: a workflow keeps what the board decided along the way (the quota allowance after a person let it
go on, a test-first send-back, a split) in one JSON column.

Revision ID: c5d7e9f1a3b6
Revises: b3e1c9d7a5f2
Create Date: 2026-11-02 06:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5d7e9f1a3b6"
down_revision: str | Sequence[str] | None = "b3e1c9d7a5f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    have = {
        c["name"] for c in sa.inspect(op.get_bind()).get_columns("ai_ticket_workflow")
    }
    if "meta" not in have:
        with op.batch_alter_table("ai_ticket_workflow") as batch:
            batch.add_column(
                sa.Column("meta", sa.String(), nullable=False, server_default="{}")
            )


def downgrade() -> None:
    with op.batch_alter_table("ai_ticket_workflow") as batch:
        batch.drop_column("meta")
