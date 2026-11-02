"""A remembered answer can cover every AI member with a role (issue #275: "always for this role")

Revision ID: e1f3a5c7b9d2
Revises: d8e0f2a4b6c8
Create Date: 2026-11-02 12:00:00.000000

"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1f3a5c7b9d2"
down_revision: str | Sequence[str] | None = "d8e0f2a4b6c8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("ai_grant") as batch:
        batch.add_column(sa.Column("role", sa.String(), nullable=True))
    op.create_index("ix_ai_grant_role", "ai_grant", ["role"])


def downgrade() -> None:
    op.drop_index("ix_ai_grant_role", table_name="ai_grant")
    with op.batch_alter_table("ai_grant") as batch:
        batch.drop_column("role")
