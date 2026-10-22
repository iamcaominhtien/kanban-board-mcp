"""add_reopen_and_pending_fields

Revision ID: d1e2f3a4b5c6
Revises: c0d1e2f3a4b5
Create Date: 2026-10-21 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "d1e2f3a4b5c6"
down_revision: Union[str, Sequence[str], None] = "c0d1e2f3a4b5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        # Reopen fields
        batch_op.add_column(
            sa.Column("reopen_count", sa.Integer(), nullable=False, server_default="0")
        )
        batch_op.add_column(sa.Column("last_reopened_at", _S(), nullable=True))
        batch_op.add_column(sa.Column("last_reopened_by", _S(), nullable=True))
        batch_op.add_column(sa.Column("last_reopen_reason", _S(), nullable=True))
        batch_op.add_column(
            sa.Column("reopen_history", _S(), nullable=False, server_default="[]")
        )

        # Pending fields
        batch_op.add_column(
            sa.Column(
                "pending", sa.Boolean(), nullable=False, server_default=sa.false()
            )
        )
        batch_op.add_column(sa.Column("pending_reason_type", _S(), nullable=True))
        batch_op.add_column(sa.Column("pending_ticket_id", _S(), nullable=True))
        batch_op.add_column(sa.Column("pending_member_id", _S(), nullable=True))
        batch_op.add_column(sa.Column("pending_party", _S(), nullable=True))
        batch_op.add_column(sa.Column("pending_note", _S(), nullable=True))
        batch_op.add_column(sa.Column("pending_since", _S(), nullable=True))
        batch_op.add_column(sa.Column("pending_by", _S(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("pending_by")
        batch_op.drop_column("pending_since")
        batch_op.drop_column("pending_note")
        batch_op.drop_column("pending_party")
        batch_op.drop_column("pending_member_id")
        batch_op.drop_column("pending_ticket_id")
        batch_op.drop_column("pending_reason_type")
        batch_op.drop_column("pending")

        batch_op.drop_column("reopen_history")
        batch_op.drop_column("last_reopen_reason")
        batch_op.drop_column("last_reopened_by")
        batch_op.drop_column("last_reopened_at")
        batch_op.drop_column("reopen_count")
