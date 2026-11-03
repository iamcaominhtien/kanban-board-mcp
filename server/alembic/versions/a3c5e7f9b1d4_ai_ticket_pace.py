"""Fast mode: a ticket's workflow keeps its pace (fast, or empty for the normal pace)

Additive: a nullable column on ai_ticket_workflow that every existing workflow starts with empty (the normal pace).

Revision ID: a3c5e7f9b1d4
Revises: d7a9c1e3f5b8
Create Date: 2026-11-03 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a3c5e7f9b1d4"
down_revision: Union[str, Sequence[str], None] = "d7a9c1e3f5b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_ticket_workflow") as batch:
        batch.add_column(sa.Column("pace", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ai_ticket_workflow") as batch:
        batch.drop_column("pace")
