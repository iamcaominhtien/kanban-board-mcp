"""docs_title_aliases: old page titles keep resolving after a rename

Revision ID: b5c6d7e8f9a0
Revises: a4b5c6d7e8f9
Create Date: 2026-10-29 01:00:00.000000

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
    op.create_table(
        "docs_title_aliases",
        sa.Column("id", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("page_id", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("old_title", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_docs_title_aliases_page_id", "docs_title_aliases", ["page_id"])


def downgrade() -> None:
    op.drop_table("docs_title_aliases")
