"""add_idea_ticket_table

Revision ID: f1a2b3c4d5e6
Revises: 1e1bb4aa5fa4
Create Date: 2026-04-25 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "1e1bb4aa5fa4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "idea_counter",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("counter", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute("INSERT INTO idea_counter (id, counter) VALUES (1, 0)")

    op.create_table(
        "idea_ticket",
        sa.Column("id", sqlmodel.sql.sqltypes.AutoString(), primary_key=True, nullable=False),
        sa.Column("project_id", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("title", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("description", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default=""),
        sa.Column("idea_status", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default="raw"),
        sa.Column("idea_color", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default="#F5C518"),
        sa.Column("idea_emoji", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default="💡"),
        sa.Column("idea_energy", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("tags", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default="[]"),
        sa.Column("problem_statement", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("ice_impact", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("ice_effort", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("ice_confidence", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("revisit_date", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("last_touched_at", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("promoted_to_ticket_id", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("promoted_at", sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column("activity_trail", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default="[]"),
        sa.Column("microthoughts", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default="[]"),
        sa.Column("assumptions", sqlmodel.sql.sqltypes.AutoString(), nullable=False, server_default="[]"),
        sa.Column("created_at", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("updated_at", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
    )
    op.create_index("ix_idea_ticket_project_id", "idea_ticket", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_idea_ticket_project_id", "idea_ticket")
    op.drop_table("idea_ticket")
    op.drop_table("idea_counter")
