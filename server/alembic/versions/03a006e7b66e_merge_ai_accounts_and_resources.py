"""merge ai accounts and resources

Revision ID: 03a006e7b66e
Revises: a7c1e3f5b9d2, b8d0f2a4c678
Create Date: 2026-11-01 00:48:52.250543

"""

from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "03a006e7b66e"
down_revision: Union[str, Sequence[str], None] = ("a7c1e3f5b9d2", "b8d0f2a4c678")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
