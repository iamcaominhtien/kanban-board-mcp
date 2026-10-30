"""idea_space_model: stages, assumption records, evidence, votes; existing ideas converted once

Revision ID: f4a6b8c0d2e4
Revises: b3e5f7a9c1d2
Create Date: 2026-10-29 00:00:00.000000

"""

import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "f4a6b8c0d2e4"
down_revision: Union[str, Sequence[str], None] = "b3e5f7a9c1d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString
logger = logging.getLogger(__name__)

IMPORT_REASON = "Imported from the old Idea Space"
_ASSUMPTION_STATUS = {
    "untested": "untested",
    "validated": "validated",
    "invalidated": "disproved",
}


def _backup_database(conn) -> None:
    """Copy the database next to itself before the ideas are converted (only when there are ideas).

    A failed copy stops the migration: converting without the safety copy is not worth the risk.
    """
    count = conn.execute(sa.text("SELECT COUNT(*) FROM idea_ticket")).scalar() or 0
    if not count:
        return
    file = next(
        (
            row[2]
            for row in conn.exec_driver_sql("PRAGMA database_list")
            if row[1] == "main" and row[2]
        ),
        None,
    )
    if not file:  # an in-memory database has nothing to copy
        return
    source = Path(file)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = source.with_name(f"{source.stem}.before-idea-space-{stamp}.db")
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    logger.info("Backed up %s ideas to %s before converting them", count, target)


def _loads(value) -> list:
    try:
        parsed = json.loads(value) if value else []
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _stage_of(row, trail: list, ticket_status: str | None, has_ticket: bool) -> str:
    """The stage an old idea becomes (design: idea-promote-migration.md, "What happens to existing ideas")."""
    status = row["idea_status"]
    if status == "dropped":
        return "archived"
    if status == "approved":
        if not row["promoted_to_ticket_id"]:
            return "ready"
        if not has_ticket:  # its ticket is gone: the idea is ready to be promoted again
            return "ready"
        if ticket_status == "done":
            return "shipped"
        if ticket_status == "wont_do":
            return "exploring"
        return "building"
    if status == "draft":
        untouched = (
            len(trail) <= 1
            and not _loads(row["microthoughts"])
            and not _loads(row["assumptions"])
        )
        return "inbox" if untouched else "exploring"
    return "exploring"  # in_review, and anything unknown


def _body_of(row) -> str:
    problem = (row["problem_statement"] or "").strip()
    description = (row["description"] or "").strip()
    parts = []
    if problem:
        parts.append(f"## Problem\n\n{problem}")
    if description:
        parts.append(description)
    return "\n\n".join(parts)


def _details_of(row) -> str:
    lines = []
    if row["idea_energy"]:
        lines.append(f"Energy: {row['idea_energy']}")
    scores = (row["ice_impact"], row["ice_effort"], row["ice_confidence"])
    if scores != (3, 3, 3):
        lines.append(
            f"ICE: impact {scores[0]}, effort {scores[1]}, confidence {scores[2]}"
        )
    return "\n".join(lines)


def _convert_ideas(conn) -> None:
    """Convert every existing idea once: stage, page body, details and assumption records."""
    now = datetime.now(timezone.utc).isoformat()
    ideas = conn.execute(sa.text("SELECT * FROM idea_ticket")).mappings().all()
    for row in ideas:
        trail = _loads(row["activity_trail"])
        ticket_status, has_ticket = None, False
        if row["promoted_to_ticket_id"]:
            found = conn.execute(
                sa.text("SELECT status FROM ticket WHERE id = :id"),
                {"id": row["promoted_to_ticket_id"]},
            ).first()
            has_ticket = found is not None
            ticket_status = found[0] if found else None

        stage = _stage_of(row, trail, ticket_status, has_ticket)
        revisit = (row["revisit_date"] or "").strip()
        park_until = None
        if revisit and stage in ("inbox", "exploring", "ready"):
            stage, park_until = "parked", revisit

        promoted_to, promoted_at = row["promoted_to_ticket_id"], row["promoted_at"]
        note = f"Converted to the new Idea Space (stage: {stage})"
        if row["idea_status"] == "approved" and promoted_to and not has_ticket:
            promoted_to, promoted_at = None, None
            note += f"; {row['promoted_to_ticket_id']} no longer exists, the link was cleared"
        elif stage == "exploring" and ticket_status == "wont_do":
            note += f"; {promoted_to} was dropped"
        trail.append(
            {"id": str(uuid.uuid4()), "label": note, "at": now, "author": "system"}
        )

        conn.execute(
            sa.text(
                "UPDATE idea_ticket SET stage = :stage, park_until = :park_until,"
                " archive_reason = :reason, source = 'import', body = :body,"
                " details = :details, promoted_to_ticket_id = :promoted_to,"
                " promoted_at = :promoted_at, activity_trail = :trail,"
                " stage_changed_at = :changed_at WHERE id = :id"
            ),
            {
                "stage": stage,
                "park_until": park_until,
                "reason": IMPORT_REASON if stage == "archived" else None,
                "body": _body_of(row),
                "details": _details_of(row),
                "promoted_to": promoted_to,
                "promoted_at": promoted_at,
                "trail": json.dumps(trail),
                "changed_at": row["updated_at"] or now,
                "id": row["id"],
            },
        )
        if stage in ("building", "shipped") and promoted_to:
            conn.execute(
                sa.text("UPDATE ticket SET from_idea_id = :idea WHERE id = :id"),
                {"idea": row["id"], "id": promoted_to},
            )
        for m in _loads(row["microthoughts"]):
            if not isinstance(m, dict) or not str(m.get("text", "")).strip():
                continue
            conn.execute(
                sa.text(
                    "INSERT INTO idea_comment (id, idea_id, author, body, ai, created_at)"
                    " VALUES (:id, :idea, NULL, :body, 0, :at)"
                ),
                {
                    "id": m.get("id") or str(uuid.uuid4()),
                    "idea": row["id"],
                    "body": str(m["text"]).strip(),
                    "at": m.get("at") or row["created_at"],
                },
            )

        for position, a in enumerate(_loads(row["assumptions"])):
            if not isinstance(a, dict) or not str(a.get("text", "")).strip():
                continue
            stamp = a.get("at") or row["created_at"]
            conn.execute(
                sa.text(
                    "INSERT INTO idea_assumption (id, idea_id, position, text, impact,"
                    " status, test_ticket_id, created_at, updated_at)"
                    " VALUES (:id, :idea, :pos, :text, 'medium', :status, NULL, :at, :at)"
                ),
                {
                    "id": a.get("id") or str(uuid.uuid4()),
                    "idea": row["id"],
                    "pos": position,
                    "text": str(a["text"]).strip(),
                    "status": _ASSUMPTION_STATUS.get(a.get("status"), "untested"),
                    "at": stamp,
                },
            )


def upgrade() -> None:
    conn = op.get_bind()
    _backup_database(conn)

    with op.batch_alter_table("idea_ticket", schema=None) as batch_op:
        batch_op.alter_column("project_id", existing_type=_S(), nullable=True)
        batch_op.add_column(
            sa.Column("stage", _S(), nullable=False, server_default="inbox")
        )
        batch_op.add_column(sa.Column("park_until", _S(), nullable=True))
        batch_op.add_column(sa.Column("archive_reason", _S(), nullable=True))
        batch_op.add_column(
            sa.Column("source", _S(), nullable=False, server_default="manual")
        )
        batch_op.add_column(sa.Column("body", _S(), nullable=False, server_default=""))
        batch_op.add_column(
            sa.Column("details", _S(), nullable=False, server_default="")
        )
        for name in (
            "created_by",
            "owner",
            "park_note",
            "archive_note",
            "stage_changed_at",
            "merged_into_id",
            "merged_at",
            "shipped_at",
            "outcome",
            "outcome_note",
            "former_ticket_id",
            "effort_guess",
        ):
            batch_op.add_column(sa.Column(name, _S(), nullable=True))
        for name in ("source_ref", "prev_state", "merge_undo"):
            batch_op.add_column(
                sa.Column(name, _S(), nullable=False, server_default="{}")
            )
        batch_op.add_column(
            sa.Column(
                "workspace_retention",
                _S(),
                nullable=False,
                server_default="open_then_30",
            )
        )
        batch_op.create_index("ix_idea_ticket_stage", ["stage"])

    op.create_table(
        "idea_assumption",
        sa.Column("id", _S(), nullable=False),
        sa.Column("idea_id", _S(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("text", _S(), nullable=False),
        sa.Column("impact", _S(), nullable=False, server_default="medium"),
        sa.Column("status", _S(), nullable=False, server_default="untested"),
        sa.Column("test_ticket_id", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("updated_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["idea_id"], ["idea_ticket.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_idea_assumption_idea_id", "idea_assumption", ["idea_id"])
    op.create_table(
        "idea_evidence",
        sa.Column("id", _S(), nullable=False),
        sa.Column("assumption_id", _S(), nullable=False),
        sa.Column("kind", _S(), nullable=False, server_default="link"),
        sa.Column("title", _S(), nullable=False, server_default=""),
        sa.Column("ref", _S(), nullable=False, server_default=""),
        sa.Column("created_by", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["assumption_id"], ["idea_assumption.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_idea_evidence_assumption_id", "idea_evidence", ["assumption_id"]
    )
    op.create_table(
        "idea_comment",
        sa.Column("id", _S(), nullable=False),
        sa.Column("idea_id", _S(), nullable=False),
        sa.Column("author", _S(), nullable=True),
        sa.Column("body", _S(), nullable=False, server_default=""),
        sa.Column("ai", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("run_id", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("edited_at", _S(), nullable=True),
        sa.ForeignKeyConstraint(["idea_id"], ["idea_ticket.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_idea_comment_idea_id", "idea_comment", ["idea_id"])
    op.create_table(
        "idea_log_entry",
        sa.Column("id", _S(), nullable=False),
        sa.Column("idea_id", _S(), nullable=False),
        sa.Column("kind", _S(), nullable=False, server_default="note"),
        sa.Column("body", _S(), nullable=False, server_default=""),
        sa.Column("author", _S(), nullable=True),
        sa.Column("ai", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("assumption_id", _S(), nullable=True),
        sa.Column("attachments", _S(), nullable=False, server_default="[]"),
        sa.Column("ticket_id", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["idea_id"], ["idea_ticket.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_idea_log_entry_idea_id", "idea_log_entry", ["idea_id"])
    op.create_table(
        "idea_vote",
        sa.Column("id", _S(), nullable=False),
        sa.Column("idea_id", _S(), nullable=False),
        sa.Column("voter", _S(), nullable=False),
        sa.Column("created_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["idea_id"], ["idea_ticket.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_idea_vote_idea_id", "idea_vote", ["idea_id"])
    op.create_index(
        "uq_idea_vote_idea_voter", "idea_vote", ["idea_id", "voter"], unique=True
    )

    op.add_column("ticket", sa.Column("from_idea_id", _S(), nullable=True))
    op.add_column("ticket", sa.Column("tests_assumption_id", _S(), nullable=True))
    op.create_index("ix_ticket_from_idea_id", "ticket", ["from_idea_id"])
    op.create_index("ix_ticket_tests_assumption_id", "ticket", ["tests_assumption_id"])

    _convert_ideas(conn)


def downgrade() -> None:
    conn = op.get_bind()
    # The old model keeps its assumptions as JSON on the idea; write the records back into it.
    legacy_status = {v: k for k, v in _ASSUMPTION_STATUS.items()}
    by_idea: dict[str, list] = {}
    for a in conn.execute(
        sa.text("SELECT * FROM idea_assumption ORDER BY position")
    ).mappings():
        by_idea.setdefault(a["idea_id"], []).append(
            {
                "id": a["id"],
                "text": a["text"],
                "status": legacy_status.get(a["status"], "untested"),
                "at": a["created_at"],
            }
        )
    for idea_id, items in by_idea.items():
        conn.execute(
            sa.text("UPDATE idea_ticket SET assumptions = :a WHERE id = :id"),
            {"a": json.dumps(items), "id": idea_id},
        )

    op.drop_index("ix_ticket_tests_assumption_id", "ticket")
    op.drop_index("ix_ticket_from_idea_id", "ticket")
    op.drop_column("ticket", "tests_assumption_id")
    op.drop_column("ticket", "from_idea_id")
    op.drop_table("idea_log_entry")
    op.drop_table("idea_comment")
    op.drop_table("idea_vote")
    op.drop_table("idea_evidence")
    op.drop_table("idea_assumption")
    with op.batch_alter_table("idea_ticket", schema=None) as batch_op:
        batch_op.drop_index("ix_idea_ticket_stage")
        for name in (
            "workspace_retention",
            "merge_undo",
            "prev_state",
            "source_ref",
            "effort_guess",
            "former_ticket_id",
            "outcome_note",
            "outcome",
            "shipped_at",
            "merged_at",
            "merged_into_id",
            "stage_changed_at",
            "archive_note",
            "park_note",
            "owner",
            "created_by",
        ):
            batch_op.drop_column(name)
        batch_op.drop_column("details")
        batch_op.drop_column("body")
        batch_op.drop_column("source")
        batch_op.drop_column("archive_reason")
        batch_op.drop_column("park_until")
        batch_op.drop_column("stage")
        # project_id stays nullable: ideas that belong to no project cannot be given one here.
