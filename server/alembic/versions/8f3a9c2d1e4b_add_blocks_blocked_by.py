"""add_blocks_blocked_by

Revision ID: 8f3a9c2d1e4b
Revises: 551353060a20
Create Date: 2026-04-07 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "8f3a9c2d1e4b"
down_revision: Union[str, Sequence[str], None] = "551353060a20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.add_column(
            sa.Column("blocks", sa.String(), nullable=False, server_default="[]")
        )
        batch_op.add_column(
            sa.Column("blocked_by", sa.String(), nullable=False, server_default="[]")
        )


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("blocked_by")
        batch_op.drop_column("blocks")
