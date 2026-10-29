"""diagram_version.preview_kind: who drew a diagram's SVG preview (editor, agent or basic)

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
Create Date: 2026-10-29 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "a4b5c6d7e8f9"
down_revision: Union[str, Sequence[str], None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "diagram_version",
        sa.Column(
            "preview_kind",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default="editor",
        ),
    )


def downgrade() -> None:
    with op.batch_alter_table("diagram_version") as batch:
        batch.drop_column("preview_kind")
