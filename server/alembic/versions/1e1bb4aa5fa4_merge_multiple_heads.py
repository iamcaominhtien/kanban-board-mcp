"""merge_multiple_heads

Revision ID: 1e1bb4aa5fa4
Revises: a1b2c3d4e5f6, e5f6a7b8c9d0
Create Date: 2026-04-17 21:29:37.141115

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1e1bb4aa5fa4'
down_revision: Union[str, Sequence[str], None] = ('a1b2c3d4e5f6', 'e5f6a7b8c9d0')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
