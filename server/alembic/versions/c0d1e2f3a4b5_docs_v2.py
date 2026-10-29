"""docs_v2: docs_enabled, link origin, heading aliases, full-text index

Revision ID: c0d1e2f3a4b5
Revises: b9c0d1e2f3a4
Create Date: 2026-10-06 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "c0d1e2f3a4b5"
down_revision: Union[str, Sequence[str], None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.add_column(
        "project",
        sa.Column(
            "docs_enabled", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
    )
    op.add_column(
        "docs_link",
        sa.Column("origin", _S(), nullable=False, server_default="page"),
    )
    op.create_table(
        "docs_anchor_aliases",
        sa.Column("id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("old_slug", _S(), nullable=False),
        sa.Column("new_slug", _S(), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_docs_anchor_aliases_page_id", "docs_anchor_aliases", ["page_id"]
    )

    # Full-text index. SQLite builds without FTS5 skip it: search falls back to LIKE matching.
    from services import docs_search

    conn = op.get_bind()
    if docs_search.create_fts_sync(conn):
        docs_search.backfill_sync(conn)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS docs_fts")
    op.drop_table("docs_anchor_aliases")
    with op.batch_alter_table("docs_link") as batch:
        batch.drop_column("origin")
    with op.batch_alter_table("project") as batch:
        batch.drop_column("docs_enabled")
