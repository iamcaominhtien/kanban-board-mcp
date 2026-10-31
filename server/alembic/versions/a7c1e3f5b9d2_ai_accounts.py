"""AI accounts: several logins of the same AI CLI, and the account an AI member runs as.

Revision ID: a7c1e3f5b9d2
Revises: c3d9a1b7e5f2
Create Date: 2026-10-31
"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "a7c1e3f5b9d2"
down_revision: Union[str, Sequence[str], None] = "c3d9a1b7e5f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    """Create ai_account and add ai_member.account_id (null = the login already on this computer)."""
    op.create_table(
        "ai_account",
        sa.Column("id", _S(), nullable=False),
        sa.Column("name", _S(), nullable=False),
        sa.Column("cli", _S(), nullable=False),
        sa.Column("folder", _S(), nullable=False),
        sa.Column("status", _S(), nullable=False, server_default="needs_sign_in"),
        sa.Column("status_detail", _S(), nullable=True),
        sa.Column("email", _S(), nullable=True),
        sa.Column("plan", _S(), nullable=True),
        sa.Column("method", _S(), nullable=True),
        sa.Column("checked_at", _S(), nullable=True),
        sa.Column("signed_out_at", _S(), nullable=True),
        sa.Column("signed_out_how", _S(), nullable=True),
        sa.Column("created_by", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("updated_at", _S(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_account_name", "ai_account", ["name"], unique=True)
    with op.batch_alter_table("ai_member") as batch_op:
        batch_op.add_column(sa.Column("account_id", sa.String(), nullable=True))
        batch_op.create_index("ix_ai_member_account_id", ["account_id"])


def downgrade() -> None:
    """Drop both again."""
    with op.batch_alter_table("ai_member") as batch_op:
        batch_op.drop_index("ix_ai_member_account_id")
        batch_op.drop_column("account_id")
    op.drop_index("ix_ai_account_name", table_name="ai_account")
    op.drop_table("ai_account")
