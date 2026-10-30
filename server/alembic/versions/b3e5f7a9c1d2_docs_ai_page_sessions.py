"""docs_ai_session: one Claude Code session for each (Docs page, AI member)

Revision ID: b3e5f7a9c1d2
Revises: a1d0c5a1b2c3
Create Date: 2026-10-30 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "b3e5f7a9c1d2"
down_revision: Union[str, Sequence[str], None] = "a1d0c5a1b2c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.create_table(
        "docs_ai_session",
        sa.Column("scope", _S(), nullable=False),
        sa.Column("member_id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("session_id", _S(), nullable=False),
        sa.Column("calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("scope", "member_id"),
    )
    op.create_index("ix_docs_ai_session_project_id", "docs_ai_session", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_docs_ai_session_project_id", table_name="docs_ai_session")
    op.drop_table("docs_ai_session")
