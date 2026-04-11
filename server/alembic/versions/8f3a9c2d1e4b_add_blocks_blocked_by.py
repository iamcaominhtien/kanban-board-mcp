"""add_blocks_blocked_by

Revision ID: 8f3a9c2d1e4b
Revises: 551353060a20
Create Date: 2026-04-07 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "8f3a9c2d1e4b"
down_revision: Union[str, Sequence[str], None] = "551353060a20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass  # columns added by 9a4b5c6d7e8f


def downgrade() -> None:
    pass
