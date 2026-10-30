"""ai_where_you_work: scoped chats (scope id, chosen member) and a per-project AI switch

Revision ID: a3b4c5d6e7f8
Revises: e8f9a0b1c2d3
Create Date: 2026-10-30 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a3b4c5d6e7f8"
down_revision: Union[str, Sequence[str], None] = "c9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_chat") as batch_op:
        batch_op.add_column(sa.Column("scope_id", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("member_id", sa.String(), nullable=True))
        batch_op.create_index("ix_ai_chat_scope_id", ["scope_id"])
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "ai_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
    # Existing ticket and page chats keep working: their scope id is the id they were already tied to
    op.execute("UPDATE ai_chat SET scope_id = ticket_id WHERE scope = 'ticket'")
    op.execute("UPDATE ai_chat SET scope_id = doc_id WHERE scope = 'doc'")


def downgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.drop_column("ai_enabled")
    with op.batch_alter_table("ai_chat") as batch_op:
        batch_op.drop_index("ix_ai_chat_scope_id")
        batch_op.drop_column("member_id")
        batch_op.drop_column("scope_id")
