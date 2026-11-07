"""AI v2: when the owner of a ticket chat last had it open.

The chat page tells the board every ~15 s while it is open and in front of the person. A run a chat message started
that ends in that time does not send an "AI finished" notice: the answer is already on the screen.

Revision ID: d5f7b9c1e3a4
Revises: c4e6a8b0d2f3
Create Date: 2026-11-07
"""

from typing import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "d5f7b9c1e3a4"
down_revision: str | Sequence[str] | None = "c4e6a8b0d2f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    """Add the column unless a database made from the models already has it."""
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("ai_chat")}
    if "seen_at" not in cols:
        with op.batch_alter_table("ai_chat") as batch:
            batch.add_column(sa.Column("seen_at", _S(), nullable=True))


def downgrade() -> None:
    """Drop the column."""
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("ai_chat")}
    if "seen_at" in cols:
        with op.batch_alter_table("ai_chat") as batch:
            batch.drop_column("seen_at")
