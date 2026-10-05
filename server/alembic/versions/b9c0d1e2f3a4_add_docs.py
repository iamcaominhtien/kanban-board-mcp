"""add_docs

Revision ID: b9c0d1e2f3a4
Revises: a8b9c0d1e2f3
Create Date: 2026-10-05 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "b9c0d1e2f3a4"
down_revision: Union[str, Sequence[str], None] = "a8b9c0d1e2f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    op.create_table(
        "docs_page",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("parent_id", _S(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("title", _S(), nullable=False),
        sa.Column("slug", _S(), nullable=False),
        sa.Column("status", _S(), nullable=False, server_default="draft"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", _S(), nullable=False, server_default="user"),
        sa.Column("updated_by", _S(), nullable=False, server_default="user"),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("updated_at", _S(), nullable=False),
        sa.Column("deleted_at", _S(), nullable=True),
        sa.Column("deleted_by", _S(), nullable=True),
        sa.Column("deleted_root_id", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_docs_page_project_id", "docs_page", ["project_id"])

    op.create_table(
        "docs_version",
        sa.Column("id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title", _S(), nullable=False),
        sa.Column("markdown", _S(), nullable=False, server_default=""),
        sa.Column("author", _S(), nullable=False, server_default="user"),
        sa.Column("note", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_docs_version_page_id", "docs_version", ["page_id"])

    op.create_table(
        "docs_draft",
        sa.Column("id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("author", _S(), nullable=False, server_default="user"),
        sa.Column("title", _S(), nullable=False),
        sa.Column("markdown", _S(), nullable=False, server_default=""),
        sa.Column("base_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_docs_draft_page_id", "docs_draft", ["page_id"])

    op.create_table(
        "docs_link",
        sa.Column("id", _S(), nullable=False),
        sa.Column("source_page_id", _S(), nullable=False),
        sa.Column("source_section", _S(), nullable=True),
        sa.Column("target_page_id", _S(), nullable=True),
        sa.Column("target_title", _S(), nullable=True),
        sa.Column("target_anchor", _S(), nullable=True),
        sa.Column("target_ticket_id", _S(), nullable=True),
        sa.Column("display_text", _S(), nullable=True),
        sa.Column("snippet", _S(), nullable=False, server_default=""),
        sa.ForeignKeyConstraint(["source_page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_docs_link_source_page_id", "docs_link", ["source_page_id"])
    op.create_index("ix_docs_link_target_page_id", "docs_link", ["target_page_id"])
    op.create_index("ix_docs_link_target_ticket_id", "docs_link", ["target_ticket_id"])


def downgrade() -> None:
    op.drop_table("docs_link")
    op.drop_table("docs_draft")
    op.drop_table("docs_version")
    op.drop_table("docs_page")
