"""Repair: create docs_ai_ignore on databases whose docs_ai migration ran before that table was part of it

A pre-release build ran revision a1d0c5a1b2c3 without docs_ai_ignore, and alembic never runs a revision twice, so those
databases have the other Docs AI tables but not this one. Deleting a project ran
``DELETE FROM docs_ai_ignore ...`` and failed with "no such table" (a 500); "Check this page" ignores would fail the same.

Idempotent: a database that already has the table is left alone.

Revision ID: c4e6a8b0d2f1
Revises: d7a9c1e3f5b8
Create Date: 2026-11-03 22:30:00.000000

"""

from typing import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "c4e6a8b0d2f1"
down_revision: str | Sequence[str] | None = "d7a9c1e3f5b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("docs_ai_ignore"):
        return
    op.create_table(
        "docs_ai_ignore",
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("key", _S(), nullable=False),
        sa.Column("by", _S(), nullable=False, server_default="user"),
        sa.Column("at", _S(), nullable=False),
        sa.PrimaryKeyConstraint("page_id", "key"),
    )


def downgrade() -> None:
    # The table belongs to a1d0c5a1b2c3, which drops it on its own downgrade: nothing to undo here.
    pass
