"""AI team v2 repair: run the AI team v2 upgrade again, which adds only what is missing. A database migrated by an
early build of e6611f7871e7 is stamped at that revision but lacks the tables and columns added to it later.

Revision ID: b3e1c9d7a5f2
Revises: e6611f7871e7
Create Date: 2026-11-02 02:30:00.000000

"""

import importlib.util
from collections.abc import Sequence
from pathlib import Path

revision: str = "b3e1c9d7a5f2"
down_revision: str | Sequence[str] | None = "e6611f7871e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    spec = importlib.util.spec_from_file_location(
        "ai_team_v2", Path(__file__).with_name("e6611f7871e7_ai_team_v2.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.upgrade()


def downgrade() -> None:
    pass  # the tables and columns belong to e6611f7871e7, whose downgrade removes them
