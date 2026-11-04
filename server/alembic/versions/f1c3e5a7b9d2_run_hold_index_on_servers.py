"""The ticket hold index holds only active work runs on PostgreSQL and MySQL too

`ux_ai_run_ticket_hold` was made on PostgreSQL and MySQL without its WHERE (only SQLite's was declared), so it held
every run ever made: a ticket that had one AI run could never get a second ("already held by another AI run").
PostgreSQL gets the partial index SQLite has; MySQL, which has no partial index, a plain one (create_run checks the
hold itself). Nothing changes on SQLite.

Revision ID: f1c3e5a7b9d2
Revises: e8b0d2f4a6c9
Create Date: 2026-11-04 09:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f1c3e5a7b9d2"
down_revision: Union[str, Sequence[str], None] = "e8b0d2f4a6c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NAME = "ux_ai_run_ticket_hold"
WHERE = (
    "mode = 'work' AND behind_run_id IS NULL "
    "AND state IN ('queued', 'starting', 'running', 'needs_input')"
)


def upgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        return
    if NAME in {i["name"] for i in sa.inspect(op.get_bind()).get_indexes("ai_run")}:
        op.drop_index(NAME, table_name="ai_run")
    if dialect == "postgresql":
        op.create_index(
            NAME,
            "ai_run",
            ["ticket_id"],
            unique=True,
            postgresql_where=sa.text(WHERE),
        )
    else:
        op.create_index(NAME, "ai_run", ["ticket_id"])


def downgrade() -> None:
    pass  # the index it replaces held every run ever made: there is nothing to go back to
