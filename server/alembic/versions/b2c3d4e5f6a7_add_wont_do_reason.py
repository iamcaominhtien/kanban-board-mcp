"""add_wont_do_reason

Revision ID: b2c3d4e5f6a7
Revises: 551353060a20
Create Date: 2026-04-08 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.add_column(
            sa.Column("wont_do_reason", sqlmodel.sql.sqltypes.AutoString(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("wont_do_reason")
