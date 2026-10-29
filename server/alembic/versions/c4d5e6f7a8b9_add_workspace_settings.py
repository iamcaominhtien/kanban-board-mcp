"""add_workspace_settings

Revision ID: c4d5e6f7a8b9
Revises: b3c4d5e6f7a8
Create Date: 2026-10-03 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, Sequence[str], None] = "b3c4d5e6f7a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create workspace_settings table
    op.create_table(
        "workspace_settings",
        sa.Column("id", sa.Integer(), nullable=False, primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "root_path",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default="~/kanban-workspace",
        ),
        sa.Column(
            "default_retention_days", sa.Integer(), nullable=True, server_default="14"
        ),
    )

    # Add workspace_retention_days to ticket
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.add_column(
            sa.Column(
                "workspace_retention_days",
                sa.Integer(),
                nullable=True,
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("workspace_retention_days")
    op.drop_table("workspace_settings")
