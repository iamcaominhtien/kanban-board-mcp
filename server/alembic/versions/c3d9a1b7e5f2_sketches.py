"""sketches: paint-style drawings (a PNG and an editable source kept in the uploads folder)

Revision ID: c3d9a1b7e5f2
Revises: d7e8f9a0b1c2
Create Date: 2026-10-29 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "c3d9a1b7e5f2"
down_revision: Union[str, Sequence[str], None] = "a3b4c5d6e7f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.create_table(
        "sketch",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=True),
        sa.Column("owner_kind", _S(), nullable=False, server_default="doc"),
        sa.Column("owner_id", _S(), nullable=False, server_default=""),
        sa.Column("title", _S(), nullable=False, server_default="Sketch"),
        sa.Column("width", sa.Integer(), nullable=False, server_default="840"),
        sa.Column("height", sa.Integer(), nullable=False, server_default="500"),
        sa.Column("layer_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("png_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", _S(), nullable=False),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("updated_by", _S(), nullable=False),
        sa.Column("updated_at", _S(), nullable=False),
        sa.Column("deleted_at", _S(), nullable=True),
        sa.Column("deleted_by", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sketch_project_id", "sketch", ["project_id"])
    op.create_index("ix_sketch_owner_id", "sketch", ["owner_id"])


def downgrade() -> None:
    op.drop_index("ix_sketch_owner_id", table_name="sketch")
    op.drop_index("ix_sketch_project_id", table_name="sketch")
    op.drop_table("sketch")
