"""ai_run_report_back

Revision ID: b8c2d4e6f801
Revises: e7f1a2b3c4d5
Create Date: 2026-10-31 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8c2d4e6f801"
down_revision: Union[str, Sequence[str], None] = "e7f1a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(sa.Column("report_back", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.drop_column("report_back")
