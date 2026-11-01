"""canvas_thread.anchor: a comment pin remembers the element it was put on, not only a position

Revision ID: c1d2e3f4a5b7
Revises: b8c9d0e1f2a3
Create Date: 2026-11-01 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "c1d2e3f4a5b7"
down_revision: Union[str, Sequence[str], None] = "b8c9d0e1f2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("canvas_thread") as batch:
        batch.add_column(
            sa.Column("anchor", sqlmodel.sql.sqltypes.AutoString(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("canvas_thread") as batch:
        batch.drop_column("anchor")
