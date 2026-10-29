"""docs: per-user last viewed version (docs_page_seen) and docs_draft.saves

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

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.create_table(
        "docs_page_seen",
        sa.Column("id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("viewer", _S(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("seen_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_docs_page_seen_page_id", "docs_page_seen", ["page_id"])
    op.add_column(
        "docs_draft",
        sa.Column("saves", sa.Integer(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    with op.batch_alter_table("docs_draft") as batch:
        batch.drop_column("saves")
    op.drop_index("ix_docs_page_seen_page_id", table_name="docs_page_seen")
    op.drop_table("docs_page_seen")
