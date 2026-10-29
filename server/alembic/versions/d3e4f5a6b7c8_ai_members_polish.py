"""AI members: when a rate-limited agent retries, and a glyph and colour of its own.

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, Sequence[str], None] = "c2d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Until now nobody could pick a glyph or a colour: every member had the default glyph and a colour handed out in
# turn. Give each existing member the look of its provider (what the avatar showed before), so nothing changes
# on screen; from here on the picked glyph and colour are what is drawn everywhere.
LOOKS = {
    "claude-code": ("asterisk", "#2E6F40"),
    "anthropic": ("asterisk", "#B4791E"),
    "antigravity": ("peak", "#2F6FB0"),
    "openai": ("hex", "#6D5DD3"),
    "gemini": ("spark", "#B0446E"),
    "custom": ("braces", "#5B6B60"),
    "mcp-client": ("plug", "#5B6B60"),
}


def upgrade() -> None:
    """Add `retry_at` and set each member's glyph and colour from its provider."""
    with op.batch_alter_table("ai_member") as batch_op:
        batch_op.add_column(sa.Column("retry_at", sa.String(), nullable=True))
    bind = op.get_bind()
    for provider, (glyph, color) in LOOKS.items():
        bind.execute(
            sa.text(
                "UPDATE ai_member SET glyph = :g WHERE provider = :p AND glyph = 'spark'"
            ),
            {"g": glyph, "p": provider},
        )
        bind.execute(
            sa.text(
                "UPDATE member SET color = :c WHERE kind = 'ai' "
                "AND id IN (SELECT id FROM ai_member WHERE provider = :p)"
            ),
            {"c": color, "p": provider},
        )


def downgrade() -> None:
    """Drop `retry_at` (glyphs and colours stay as they are)."""
    with op.batch_alter_table("ai_member") as batch_op:
        batch_op.drop_column("retry_at")
