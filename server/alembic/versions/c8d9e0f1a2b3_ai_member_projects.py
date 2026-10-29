"""One AI member in several projects: a copy links to the original.

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, Sequence[str], None] = "b7c8d9e0f1a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ai_member.linked_to."""
    with op.batch_alter_table("ai_member") as batch:
        batch.add_column(sa.Column("linked_to", sa.String(), nullable=True))
        batch.create_index("ix_ai_member_linked_to", ["linked_to"])


def downgrade() -> None:
    """Drop ai_member.linked_to."""
    with op.batch_alter_table("ai_member") as batch:
        batch.drop_index("ix_ai_member_linked_to")
        batch.drop_column("linked_to")
