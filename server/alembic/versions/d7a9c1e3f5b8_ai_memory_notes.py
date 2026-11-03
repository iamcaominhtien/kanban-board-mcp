"""Issue #274: notes an AI keeps across runs (per role, member or ticket), and what memory a run's prompt carried

Additive: a new table, and a nullable column on ai_run that every existing run starts with empty.

Revision ID: d7a9c1e3f5b8
Revises: d8a0c2e4f6b8
Create Date: 2026-11-03 10:00:00.000000

"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7a9c1e3f5b8"
down_revision: str | Sequence[str] | None = "d8a0c2e4f6b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_memory_note",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("scope_key", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("written_by", sa.String(), nullable=True),
        sa.Column("source_run_id", sa.String(), nullable=True),
        sa.Column("source_ticket_id", sa.String(), nullable=True),
        sa.Column("uses", sa.Integer(), nullable=False),
        sa.Column("last_used_at", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("project_id", "scope", "scope_key"):
        op.create_index(
            f"ix_ai_memory_note_{column}", "ai_memory_note", [column], unique=False
        )
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(sa.Column("memory_used", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.drop_column("memory_used")
    for column in ("project_id", "scope", "scope_key"):
        op.drop_index(f"ix_ai_memory_note_{column}", table_name="ai_memory_note")
    op.drop_table("ai_memory_note")
