"""fix: add blocks and blocked_by columns for existing databases

Revision ID: 9a4b5c6d7e8f
Revises: 8f3a9c2d1e4b
Create Date: 2026-04-11

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9a4b5c6d7e8f"
down_revision: str | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {col["name"] for col in inspector.get_columns("ticket")}

    with op.batch_alter_table("ticket") as batch_op:
        if "blocks" not in existing:
            batch_op.add_column(sa.Column("blocks", sa.String(), nullable=False, server_default="[]"))
        if "blocked_by" not in existing:
            batch_op.add_column(sa.Column("blocked_by", sa.String(), nullable=False, server_default="[]"))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {col["name"] for col in inspector.get_columns("ticket")}

    with op.batch_alter_table("ticket") as batch_op:
        if "blocked_by" in existing:
            batch_op.drop_column("blocked_by")
        if "blocks" in existing:
            batch_op.drop_column("blocks")
