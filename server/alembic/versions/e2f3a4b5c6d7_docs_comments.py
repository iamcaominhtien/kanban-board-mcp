"""docs_comments: comment threads, replies, read marks, activity events, member role

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
Create Date: 2026-10-28 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, Sequence[str], None] = "d1e2f3a4b5c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.add_column(
        "member", sa.Column("role", _S(), nullable=False, server_default="member")
    )
    op.create_table(
        "docs_comment_thread",
        sa.Column("id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("kind", _S(), nullable=False, server_default="inline"),
        sa.Column("status", _S(), nullable=False, server_default="open"),
        sa.Column("anchor_quote", _S(), nullable=True),
        sa.Column("anchor_prefix", _S(), nullable=False, server_default=""),
        sa.Column("anchor_suffix", _S(), nullable=False, server_default=""),
        sa.Column("anchor_section", _S(), nullable=True),
        sa.Column("anchor_state", _S(), nullable=False, server_default="attached"),
        sa.Column("anchor_pos", sa.Integer(), nullable=True),
        sa.Column("created_by", _S(), nullable=False),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("resolved_by", _S(), nullable=True),
        sa.Column("resolved_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_docs_comment_thread_page_id", "docs_comment_thread", ["page_id"]
    )
    op.create_table(
        "docs_comment",
        sa.Column("id", _S(), nullable=False),
        sa.Column("thread_id", _S(), nullable=False),
        sa.Column("author", _S(), nullable=False),
        sa.Column("body", _S(), nullable=False),
        sa.Column("mentions", _S(), nullable=False, server_default="[]"),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("edited_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["thread_id"], ["docs_comment_thread.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_docs_comment_thread_id", "docs_comment", ["thread_id"])
    op.create_table(
        "docs_comment_read",
        sa.Column("id", _S(), nullable=False),
        sa.Column("thread_id", _S(), nullable=False),
        sa.Column("reader", _S(), nullable=False),
        sa.Column("read_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["thread_id"], ["docs_comment_thread.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_docs_comment_read_thread_id", "docs_comment_read", ["thread_id"]
    )
    op.create_table(
        "docs_comment_event",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("thread_id", _S(), nullable=True),
        sa.Column("comment_id", _S(), nullable=True),
        sa.Column("kind", _S(), nullable=False),
        sa.Column("actor", _S(), nullable=False),
        sa.Column("mentioned", _S(), nullable=False, server_default="[]"),
        sa.Column("recipients", _S(), nullable=False, server_default="[]"),
        sa.Column("page_title", _S(), nullable=False, server_default=""),
        sa.Column("snippet", _S(), nullable=False, server_default=""),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_docs_comment_event_project_id", "docs_comment_event", ["project_id"]
    )
    op.create_index("ix_docs_comment_event_page_id", "docs_comment_event", ["page_id"])


def downgrade() -> None:
    op.drop_table("docs_comment_event")
    op.drop_table("docs_comment_read")
    op.drop_table("docs_comment")
    op.drop_table("docs_comment_thread")
    with op.batch_alter_table("member") as batch:
        batch.drop_column("role")
