"""feat: add block_done_if_acs_incomplete and block_done_if_tcs_incomplete to ticket

Revision ID: a1b2c3d4e5f6
Revises: 9a4b5c6d7e8f
Create Date: 2026-04-16

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "9a4b5c6d7e8f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {col["name"] for col in inspector.get_columns("ticket")}

    with op.batch_alter_table("ticket") as batch_op:
        if "block_done_if_acs_incomplete" not in existing:
            batch_op.add_column(
                sa.Column(
                    "block_done_if_acs_incomplete",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.false(),
                )
            )
        if "block_done_if_tcs_incomplete" not in existing:
            batch_op.add_column(
                sa.Column(
                    "block_done_if_tcs_incomplete",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.false(),
                )
            )


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("block_done_if_tcs_incomplete")
        batch_op.drop_column("block_done_if_acs_incomplete")
