"""Thumbs up / down on Board AI answers.

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d9e0f1a2b3c4"
down_revision: Union[str, Sequence[str], None] = "c8d9e0f1a2b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ai_chat_message.feedback."""
    with op.batch_alter_table("ai_chat_message") as batch:
        batch.add_column(
            sa.Column("feedback", sa.String(), nullable=False, server_default="{}")
        )


def downgrade() -> None:
    """Drop ai_chat_message.feedback."""
    with op.batch_alter_table("ai_chat_message") as batch:
        batch.drop_column("feedback")
