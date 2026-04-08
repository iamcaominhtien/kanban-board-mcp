"""add_blocks_blocked_by

Revision ID: a1b2c3d4e5f6
Revises: 551353060a20
Create Date: 2026-04-07 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "551353060a20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # columns already exist in DB; this migration is a stub to restore chain
    pass


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("blocked_by")
        batch_op.drop_column("blocks")
