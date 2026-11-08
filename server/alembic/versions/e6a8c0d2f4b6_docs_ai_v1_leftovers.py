"""Docs AI: drop what v1 left (proposals, read scope, edits mode, hide-from-AI, guidance pages).

KBM-24: `docs_ai_settings` loses `read_scope`, `picked_pages`, `edits_mode`, `proposal_days` and `guidance_limit`;
`docs_page` loses `ai_hidden` and `ai_guidance`. AI v2 edits pages directly (the page's history undoes it), reads what the
person can read, and no run reads guidance pages. A "page proposal" notification (nothing makes them any more) is removed.

Revision ID: e6a8c0d2f4b6
Revises: e2a4c6e8b0d1
Create Date: 2026-11-07
"""

from typing import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "e6a8c0d2f4b6"
down_revision: str | Sequence[str] | None = "e2a4c6e8b0d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_S = sqlmodel.sql.sqltypes.AutoString

SETTINGS_COLUMNS = (
    "read_scope",
    "picked_pages",
    "edits_mode",
    "proposal_days",
    "guidance_limit",
)
PAGE_COLUMNS = ("ai_hidden", "ai_guidance")


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _drop(table: str, names: Sequence[str]) -> None:
    present = [n for n in names if n in _columns(table)]
    if present:
        with op.batch_alter_table(table) as batch:
            for name in present:
                batch.drop_column(name)


def upgrade() -> None:
    """Drop the columns that are still there (a database made from the models never had them)."""
    _drop("docs_ai_settings", SETTINGS_COLUMNS)
    _drop("docs_page", PAGE_COLUMNS)
    op.execute(sa.text("DELETE FROM notification WHERE kind = 'page_proposal'"))


def downgrade() -> None:
    """Add the columns back with their old defaults (the data is not restored)."""
    have = _columns("docs_ai_settings")
    with op.batch_alter_table("docs_ai_settings") as batch:
        if "read_scope" not in have:
            batch.add_column(
                sa.Column(
                    "read_scope", _S(), nullable=False, server_default="except_hidden"
                )
            )
        if "picked_pages" not in have:
            batch.add_column(
                sa.Column("picked_pages", _S(), nullable=False, server_default="[]")
            )
        if "edits_mode" not in have:
            batch.add_column(
                sa.Column("edits_mode", _S(), nullable=False, server_default="direct")
            )
        if "proposal_days" not in have:
            batch.add_column(
                sa.Column(
                    "proposal_days", sa.Integer(), nullable=False, server_default="7"
                )
            )
        if "guidance_limit" not in have:
            batch.add_column(
                sa.Column(
                    "guidance_limit",
                    sa.Integer(),
                    nullable=False,
                    server_default="8000",
                )
            )
    have = _columns("docs_page")
    with op.batch_alter_table("docs_page") as batch:
        for name in PAGE_COLUMNS:
            if name not in have:
                batch.add_column(
                    sa.Column(
                        name, sa.Boolean(), nullable=False, server_default=sa.false()
                    )
                )
