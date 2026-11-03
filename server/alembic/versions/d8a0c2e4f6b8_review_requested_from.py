"""ticket.review_requested_from: whose review a ticket in Review waits for (issue #269, MainBoard Review column)

Nullable and empty for every existing ticket: a card shows "Review requested — Name" only once it is set.

Revision ID: d8a0c2e4f6b8
Revises: c6f8a0b2d4e6
Create Date: 2026-11-03 01:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d8a0c2e4f6b8"
down_revision: Union[str, Sequence[str], None] = "c6f8a0b2d4e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.add_column(
            sa.Column("review_requested_from", sa.String(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("review_requested_from")
