"""fix_idea_status_and_color_values

Revision ID: 46d50ad33691
Revises: a2b3c4d5e6f7
Create Date: 2026-04-25 21:36:42.376029

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '46d50ad33691'
down_revision: Union[str, Sequence[str], None] = 'a2b3c4d5e6f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Migrate old status names to new names
    op.execute("UPDATE idea_ticket SET idea_status = 'in_review' WHERE idea_status IN ('brewing', 'validated')")
    op.execute("UPDATE idea_ticket SET idea_status = 'draft' WHERE idea_status = 'raw'")
    # Migrate hex colors to named colors
    op.execute(
        "UPDATE idea_ticket SET idea_color = 'yellow'"
        " WHERE idea_color NOT IN ('yellow','orange','lime','pink','blue','purple','teal')"
    )
    # Fix server_default on idea_status column
    with op.batch_alter_table('idea_ticket') as batch_op:
        batch_op.alter_column('idea_status', server_default='draft')


def downgrade() -> None:
    pass  # data migration, no safe downgrade
