"""docs_ai: per-project Docs AI settings, jobs, proposals, freshness checks, page flags, chat summaries

Revision ID: a1d0c5a1b2c3
Revises: e8f9a0b1c2d3
Create Date: 2026-10-30 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "a1d0c5a1b2c3"
down_revision: Union[str, Sequence[str], None] = "e8f9a0b1c2d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def _bool(name: str) -> sa.Column:
    return sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.false())


def upgrade() -> None:
    with op.batch_alter_table("docs_page") as b:
        b.add_column(_bool("ai_hidden"))
        b.add_column(_bool("ai_guidance"))
    with op.batch_alter_table("docs_version") as b:
        b.add_column(_bool("with_ai"))
    with op.batch_alter_table("docs_draft") as b:
        b.add_column(sa.Column("ai_source", _S(), nullable=True))
    with op.batch_alter_table("docs_comment") as b:
        b.add_column(sa.Column("ai", _S(), nullable=True))
    with op.batch_alter_table("ai_chat") as b:
        b.add_column(sa.Column("summary", _S(), nullable=False, server_default=""))
        b.add_column(sa.Column("summary_upto", _S(), nullable=True))
        b.add_column(
            sa.Column("compactions", sa.Integer(), nullable=False, server_default="0")
        )

    op.create_table(
        "docs_ai_settings",
        sa.Column("project_id", _S(), nullable=False),
        _bool("enabled"),
        sa.Column("member_id", _S(), nullable=True),
        sa.Column("read_scope", _S(), nullable=False, server_default="except_hidden"),
        sa.Column("picked_pages", _S(), nullable=False, server_default="[]"),
        sa.Column("style_page_id", _S(), nullable=True),
        sa.Column("edits_mode", _S(), nullable=False, server_default="proposal"),
        sa.Column("proposal_days", sa.Integer(), nullable=False, server_default="7"),
        sa.Column(
            "freshness_on", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column(
            "guidance_limit", sa.Integer(), nullable=False, server_default="8000"
        ),
        sa.Column("digest_on", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_by", _S(), nullable=True),
        sa.Column("updated_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("project_id"),
    )

    op.create_table(
        "docs_ai_job",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=True),
        sa.Column("thread_id", _S(), nullable=True),
        sa.Column("comment_id", _S(), nullable=True),
        sa.Column("member_id", _S(), nullable=True),
        sa.Column("kind", _S(), nullable=False),
        sa.Column("state", _S(), nullable=False, server_default="queued"),
        sa.Column("started_by", _S(), nullable=False, server_default="user"),
        sa.Column("instruction", _S(), nullable=False, server_default=""),
        sa.Column("session_id", _S(), nullable=True),
        sa.Column("reads", _S(), nullable=False, server_default="[]"),
        sa.Column("steps", _S(), nullable=False, server_default="[]"),
        sa.Column("result", _S(), nullable=False, server_default="{}"),
        sa.Column("error", _S(), nullable=False, server_default="{}"),
        sa.Column("tokens_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0"),
        _bool("metered"),
        sa.Column("reply_comment_id", _S(), nullable=True),
        sa.Column("queued_at", _S(), nullable=False),
        sa.Column("started_at", _S(), nullable=True),
        sa.Column("ended_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    for col in ("project_id", "page_id", "thread_id", "member_id", "kind", "state"):
        op.create_index(f"ix_docs_ai_job_{col}", "docs_ai_job", [col])

    op.create_table(
        "docs_ai_proposal",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("member_id", _S(), nullable=False),
        sa.Column("run_id", _S(), nullable=True),
        sa.Column("job_id", _S(), nullable=True),
        sa.Column("ticket_id", _S(), nullable=True),
        sa.Column("approval_id", _S(), nullable=True),
        sa.Column("on_behalf_of", _S(), nullable=True),
        sa.Column("base_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", _S(), nullable=False, server_default="waiting"),
        sa.Column("summary", _S(), nullable=False, server_default=""),
        sa.Column("changes", _S(), nullable=False, server_default="[]"),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("expires_at", _S(), nullable=True),
        sa.Column("decided_by", _S(), nullable=True),
        sa.Column("decided_at", _S(), nullable=True),
        sa.Column("decision_note", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    for col in ("project_id", "page_id", "member_id", "status"):
        op.create_index(f"ix_docs_ai_proposal_{col}", "docs_ai_proposal", [col])

    op.create_table(
        "docs_ai_check",
        sa.Column("page_id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("state", _S(), nullable=False, server_default="ok"),
        sa.Column("reasons", _S(), nullable=False, server_default="[]"),
        sa.Column("based_on_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("deps_hash", _S(), nullable=False, server_default=""),
        sa.Column("checked_at", _S(), nullable=False),
        sa.Column("ok_until", _S(), nullable=True),
        sa.Column("ok_hash", _S(), nullable=True),
        sa.Column("dismissed", _S(), nullable=False, server_default="[]"),
        sa.Column("job_id", _S(), nullable=True),
        sa.ForeignKeyConstraint(["page_id"], ["docs_page.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("page_id"),
    )
    op.create_index("ix_docs_ai_check_project_id", "docs_ai_check", ["project_id"])

    op.create_table(
        "docs_ai_health",
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("data", _S(), nullable=False, server_default="{}"),
        sa.Column("checked_at", _S(), nullable=True),
        sa.Column("digest_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("project_id"),
    )


def downgrade() -> None:
    op.drop_table("docs_ai_health")
    op.drop_index("ix_docs_ai_check_project_id", table_name="docs_ai_check")
    op.drop_table("docs_ai_check")
    for col in ("project_id", "page_id", "member_id", "status"):
        op.drop_index(f"ix_docs_ai_proposal_{col}", table_name="docs_ai_proposal")
    op.drop_table("docs_ai_proposal")
    for col in ("project_id", "page_id", "thread_id", "member_id", "kind", "state"):
        op.drop_index(f"ix_docs_ai_job_{col}", table_name="docs_ai_job")
    op.drop_table("docs_ai_job")
    op.drop_table("docs_ai_settings")
    with op.batch_alter_table("ai_chat") as b:
        b.drop_column("compactions")
        b.drop_column("summary_upto")
        b.drop_column("summary")
    with op.batch_alter_table("docs_comment") as b:
        b.drop_column("ai")
    with op.batch_alter_table("docs_draft") as b:
        b.drop_column("ai_source")
    with op.batch_alter_table("docs_version") as b:
        b.drop_column("with_ai")
    with op.batch_alter_table("docs_page") as b:
        b.drop_column("ai_hidden")
        b.drop_column("ai_guidance")
