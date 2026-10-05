"""add_idea_ticket_promoted_unique

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-04-25 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("idea_ticket", schema=None) as batch_op:
        batch_op.create_unique_constraint(
            "uq_idea_ticket_promoted_to_ticket_id", ["promoted_to_ticket_id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("idea_ticket", schema=None) as batch_op:
        batch_op.drop_constraint(
            "uq_idea_ticket_promoted_to_ticket_id", type_="unique"
        )
