"""diagrams: draw.io diagrams, their versions, the editor setting and the page-version pins

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
Create Date: 2026-10-28 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, Sequence[str], None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.add_column(
        "docs_version",
        sa.Column("diagram_versions", _S(), nullable=False, server_default="{}"),
    )
    op.create_table(
        "diagram",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("label", _S(), nullable=False, server_default="Diagram"),
        sa.Column("summary", _S(), nullable=False, server_default=""),
        sa.Column("item_kind", _S(), nullable=True),
        sa.Column("item_id", _S(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", _S(), nullable=False),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("updated_by", _S(), nullable=False),
        sa.Column("updated_at", _S(), nullable=False),
        sa.Column("deleted_at", _S(), nullable=True),
        sa.Column("deleted_by", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_diagram_project_id", "diagram", ["project_id"])
    op.create_index("ix_diagram_item_id", "diagram", ["item_id"])
    op.create_table(
        "diagram_version",
        sa.Column("id", _S(), nullable=False),
        sa.Column("diagram_id", _S(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("source", _S(), nullable=False, server_default=""),
        sa.Column("svg", _S(), nullable=False, server_default=""),
        sa.Column("author", _S(), nullable=False),
        sa.Column("note", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["diagram_id"], ["diagram.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_diagram_version_diagram_id", "diagram_version", ["diagram_id"])
    op.create_table(
        "diagram_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("mode", _S(), nullable=False, server_default="self-hosted"),
        sa.Column("url", _S(), nullable=False, server_default=""),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("diagram_settings")
    op.drop_index("ix_diagram_version_diagram_id", table_name="diagram_version")
    op.drop_table("diagram_version")
    op.drop_index("ix_diagram_item_id", table_name="diagram")
    op.drop_index("ix_diagram_project_id", table_name="diagram")
    op.drop_table("diagram")
    with op.batch_alter_table("docs_version") as batch:
        batch.drop_column("diagram_versions")
