"""add_idea_board_fields

Revision ID: f6a7b8c9d0e1
Revises: 1e1bb4aa5fa4
Create Date: 2026-04-22 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, Sequence[str], None] = "1e1bb4aa5fa4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # NOTE: origin_idea_id has a self-referential FK in models.py (FK → ticket.id).
    # SQLite/Alembic batch mode cannot enforce self-referential FK constraints at the
    # DB level due to a CircularDependencyError in column topological sort.
    # The FK is declared in models.py for ORM/documentation; enforcement is at app level.
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.add_column(
            sa.Column(
                "board",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=False,
                server_default="main",
            )
        )
        batch_op.add_column(
            sa.Column(
                "idea_status",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column(
                "idea_emoji",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column(
                "idea_color",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column(
                "origin_idea_id",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=True,
            )
        )

    # Indexes for query performance
    op.create_index("idx_tickets_board", "ticket", ["board"])
    op.create_index("idx_tickets_board_status", "ticket", ["board", "idea_status"])
    op.create_index("idx_tickets_origin_idea", "ticket", ["origin_idea_id"])


def downgrade() -> None:
    op.drop_index("idx_tickets_origin_idea", table_name="ticket")
    op.drop_index("idx_tickets_board_status", table_name="ticket")
    op.drop_index("idx_tickets_board", table_name="ticket")

    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("origin_idea_id")
        batch_op.drop_column("idea_color")
        batch_op.drop_column("idea_emoji")
        batch_op.drop_column("idea_status")
        batch_op.drop_column("board")
