"""canvas: boards, notes and comments on one large plane (a peer of Sketch and Diagram)

Revision ID: b8c9d0e1f2a3
Revises: a7c1e3f5b9d2
Create Date: 2026-10-31 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "b8c9d0e1f2a3"
down_revision: Union[str, Sequence[str], None] = "a7c1e3f5b9d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.create_table(
        "canvas",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=True),
        sa.Column("owner_kind", _S(), nullable=False, server_default="doc"),
        sa.Column("owner_id", _S(), nullable=False, server_default=""),
        sa.Column("page_id", _S(), nullable=True),
        sa.Column("title", _S(), nullable=False, server_default="Canvas"),
        sa.Column("rev", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("board_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", _S(), nullable=False),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("updated_by", _S(), nullable=False),
        sa.Column("updated_at", _S(), nullable=False),
        sa.Column("deleted_at", _S(), nullable=True),
        sa.Column("deleted_by", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_canvas_project_id", "canvas", ["project_id"])
    op.create_index("ix_canvas_owner_id", "canvas", ["owner_id"])
    op.create_index("ix_canvas_page_id", "canvas", ["page_id"])
    op.create_table(
        "canvas_version",
        sa.Column("id", _S(), nullable=False),
        sa.Column("canvas_id", _S(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", _S(), nullable=True),
        sa.Column("reason", _S(), nullable=False, server_default="done"),
        sa.Column("author", _S(), nullable=False),
        sa.Column("note", _S(), nullable=True),
        sa.Column("changes", _S(), nullable=False, server_default="{}"),
        sa.Column("summary", _S(), nullable=False, server_default=""),
        sa.Column("doc", _S(), nullable=False, server_default="{}"),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["canvas_id"], ["canvas.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_canvas_version_canvas_id", "canvas_version", ["canvas_id"])
    op.create_table(
        "canvas_thread",
        sa.Column("id", _S(), nullable=False),
        sa.Column("canvas_id", _S(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("board_id", _S(), nullable=True),
        sa.Column("x", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("y", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("page", _S(), nullable=True),
        sa.Column("status", _S(), nullable=False, server_default="open"),
        sa.Column("created_by", _S(), nullable=False),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("resolved_by", _S(), nullable=True),
        sa.Column("resolved_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["canvas_id"], ["canvas.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_canvas_thread_canvas_id", "canvas_thread", ["canvas_id"])
    op.create_table(
        "canvas_comment",
        sa.Column("id", _S(), nullable=False),
        sa.Column("thread_id", _S(), nullable=False),
        sa.Column("author", _S(), nullable=False),
        sa.Column("body", _S(), nullable=False, server_default=""),
        sa.Column("mentions", _S(), nullable=False, server_default="[]"),
        sa.Column("ai", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("edited_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["thread_id"], ["canvas_thread.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_canvas_comment_thread_id", "canvas_comment", ["thread_id"])
    op.create_table(
        "canvas_proposal",
        sa.Column("id", _S(), nullable=False),
        sa.Column("canvas_id", _S(), nullable=False),
        sa.Column("author", _S(), nullable=False),
        sa.Column("member_id", _S(), nullable=True),
        sa.Column("job_id", _S(), nullable=True),
        sa.Column("request", _S(), nullable=False, server_default=""),
        sa.Column("note", _S(), nullable=False, server_default=""),
        sa.Column("status", _S(), nullable=False, server_default="open"),
        sa.Column("changes", _S(), nullable=False, server_default="[]"),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("decided_by", _S(), nullable=True),
        sa.Column("decided_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["canvas_id"], ["canvas.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_canvas_proposal_canvas_id", "canvas_proposal", ["canvas_id"])
    with op.batch_alter_table("docs_page") as batch:
        batch.add_column(sa.Column("kind", _S(), nullable=False, server_default="page"))


def downgrade() -> None:
    with op.batch_alter_table("docs_page") as batch:
        batch.drop_column("kind")
    for table in (
        "canvas_proposal",
        "canvas_comment",
        "canvas_thread",
        "canvas_version",
        "canvas",
    ):
        op.drop_table(table)
