"""Indexes for the board's most frequent lookups: a project's members, a project's tickets (by status), a ticket's
children and assignee, a docs page's children

Every screen reads members by project (more than 90 queries filter on member.project_id) and the board reads tickets
by project; without an index each one scanned the whole table. Additive and safe to run again.

Revision ID: e8b0d2f4a6c9
Revises: c4e6a8b0d2f1
Create Date: 2026-11-03 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e8b0d2f4a6c9"
down_revision: Union[str, Sequence[str], None] = "c4e6a8b0d2f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEXES = [
    ("ix_member_project_id", "member", ["project_id"]),
    ("ix_ticket_project_status", "ticket", ["project_id", "status"]),
    ("ix_ticket_parent_id", "ticket", ["parent_id"]),
    ("ix_ticket_assignee", "ticket", ["assignee"]),
    ("ix_docs_page_parent_id", "docs_page", ["parent_id"]),
]


def upgrade() -> None:
    have = {
        (t, i["name"])
        for t in {t for _, t, _ in INDEXES}
        for i in sa.inspect(op.get_bind()).get_indexes(t)
    }
    for name, table, columns in INDEXES:
        if (table, name) not in have:
            op.create_index(name, table, columns)


def downgrade() -> None:
    for name, table, _ in reversed(INDEXES):
        op.drop_index(name, table_name=table)
