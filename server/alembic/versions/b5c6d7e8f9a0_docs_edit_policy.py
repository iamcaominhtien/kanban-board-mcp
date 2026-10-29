"""docs_edit_policy on project; docs_comment_event.page_id nullable (access requests)

Revision ID: b5c6d7e8f9a0
Revises: a4b5c6d7e8f9
Create Date: 2026-10-29 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "b5c6d7e8f9a0"
down_revision: Union[str, Sequence[str], None] = "a4b5c6d7e8f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "project",
        sa.Column(
            "docs_edit_policy",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default="members",
        ),
    )
    with op.batch_alter_table("docs_comment_event") as batch:
        batch.alter_column(
            "page_id", existing_type=sqlmodel.sql.sqltypes.AutoString(), nullable=True
        )


def downgrade() -> None:
    op.execute("DELETE FROM docs_comment_event WHERE page_id IS NULL")
    with op.batch_alter_table("docs_comment_event") as batch:
        batch.alter_column(
            "page_id", existing_type=sqlmodel.sql.sqltypes.AutoString(), nullable=False
        )
    with op.batch_alter_table("project") as batch:
        batch.drop_column("docs_edit_policy")
