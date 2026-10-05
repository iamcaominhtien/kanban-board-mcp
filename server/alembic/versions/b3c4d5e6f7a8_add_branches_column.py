"""add_branches_column

Revision ID: b3c4d5e6f7a8
Revises: 46d50ad33691
Create Date: 2026-10-03 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "b3c4d5e6f7a8"
down_revision: Union[str, Sequence[str], None] = "46d50ad33691"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.add_column(
            sa.Column(
                "branches",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=False,
                server_default="[]",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("branches")
