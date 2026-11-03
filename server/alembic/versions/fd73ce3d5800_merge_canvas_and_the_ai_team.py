"""merge canvas and the AI team

Revision ID: fd73ce3d5800
Revises: 03a006e7b66e, c1d2e3f4a5b7
Create Date: 2026-11-01 10:19:50.396749

"""

from typing import Sequence


# revision identifiers, used by Alembic.
revision: str = "fd73ce3d5800"
down_revision: str | Sequence[str] | None = ("03a006e7b66e", "c1d2e3f4a5b7")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
