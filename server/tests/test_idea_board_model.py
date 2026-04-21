from pathlib import Path
from typing import get_args

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, Table, create_engine, inspect, select
from sqlmodel import SQLModel, Session

from models import BoardType, IdeaColor, IdeaStatus, Project, Ticket


SERVER_DIR = Path(__file__).resolve().parents[1]
ALEMBIC_INI = SERVER_DIR / "alembic.ini"
PRE_IDEA_BOARD_REVISION = "1e1bb4aa5fa4"
IDEA_BOARD_FIELDS = {
    "board",
    "idea_status",
    "idea_emoji",
    "idea_color",
    "origin_idea_id",
}


def _alembic_config(db_path: Path) -> Config:
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{db_path}")
    return config


def _assert_optional(annotation, expected_type) -> None:
    args = set(get_args(annotation))
    assert args == {expected_type, type(None)}


def _legacy_ticket_payload(column_names: set[str]) -> dict[str, object]:
    payload = {
        "id": "IAM-117-LEGACY",
        "project_id": "project-legacy",
        "title": "Legacy ticket",
        "description": "",
        "type": "task",
        "status": "backlog",
        "priority": "medium",
        "tags": "[]",
        "comments": "[]",
        "acceptance_criteria": "[]",
        "activity_log": "[]",
        "work_log": "[]",
        "test_cases": "[]",
        "blocks": "[]",
        "blocked_by": "[]",
        "links": "[]",
        "block_done_if_acs_incomplete": False,
        "block_done_if_tcs_incomplete": False,
        "created_at": "2026-04-22T00:00:00+00:00",
        "updated_at": "2026-04-22T00:00:00+00:00",
    }
    return {key: value for key, value in payload.items() if key in column_names}


def test_idea_board_enums_have_expected_values() -> None:
    assert [member.value for member in BoardType] == ["main", "idea"]
    assert [member.value for member in IdeaStatus] == ["draft", "approved", "dropped"]
    assert [member.value for member in IdeaColor] == [
        "yellow",
        "orange",
        "lime",
        "pink",
        "blue",
        "purple",
        "teal",
    ]


def test_ticket_idea_board_fields_have_expected_types_defaults_and_nullability() -> None:
    assert Ticket.__annotations__["board"] is BoardType
    _assert_optional(Ticket.__annotations__["idea_status"], IdeaStatus)
    _assert_optional(Ticket.__annotations__["idea_emoji"], str)
    _assert_optional(Ticket.__annotations__["idea_color"], IdeaColor)
    _assert_optional(Ticket.__annotations__["origin_idea_id"], str)

    ticket = Ticket(id="IAM-117-1", project_id="project-1", title="Idea board defaults")

    assert ticket.board == BoardType.main
    assert ticket.idea_status is None
    assert ticket.idea_emoji is None
    assert ticket.idea_color is None
    assert ticket.origin_idea_id is None

    assert Ticket.__table__.c.board.nullable is False
    assert Ticket.__table__.c.idea_status.nullable is True
    assert Ticket.__table__.c.idea_emoji.nullable is True
    assert Ticket.__table__.c.idea_color.nullable is True
    assert Ticket.__table__.c.origin_idea_id.nullable is True


def test_ticket_persists_default_board_and_nullable_idea_fields() -> None:
    engine = create_engine("sqlite:///:memory:")
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        project = Project(name="Idea Board", prefix="IAM", color="#123456")
        session.add(project)
        session.commit()
        session.refresh(project)

        ticket = Ticket(
            id="IAM-117-2",
            project_id=project.id,
            title="Persisted defaults",
        )
        session.add(ticket)
        session.commit()
        session.refresh(ticket)

        assert ticket.board == BoardType.main
        assert ticket.idea_status is None
        assert ticket.idea_emoji is None
        assert ticket.idea_color is None
        assert ticket.origin_idea_id is None


def test_migration_upgrade_preserves_existing_tickets_with_board_main(tmp_path: Path) -> None:
    db_path = tmp_path / "idea-board-upgrade.db"
    alembic_cfg = _alembic_config(db_path)

    command.upgrade(alembic_cfg, PRE_IDEA_BOARD_REVISION)

    sync_engine = create_engine(f"sqlite:///{db_path}")
    try:
        with sync_engine.begin() as connection:
            inspector = inspect(connection)
            columns = {column["name"] for column in inspector.get_columns("ticket")}
            reflected_metadata = MetaData()
            project_table = Table("project", reflected_metadata, autoload_with=connection)
            ticket_table = Table("ticket", reflected_metadata, autoload_with=connection)

            connection.execute(
                project_table.insert().values(
                    id="project-legacy",
                    name="Legacy Project",
                    prefix="LEG",
                    color="#654321",
                    ticket_counter=1,
                )
            )
            connection.execute(ticket_table.insert().values(_legacy_ticket_payload(columns)))

        command.upgrade(alembic_cfg, "head")

        with sync_engine.connect() as connection:
            legacy_ticket = connection.execute(
                select(SQLModel.metadata.tables["ticket"]).where(
                    SQLModel.metadata.tables["ticket"].c.id == "IAM-117-LEGACY"
                )
            ).mappings().one()

        assert legacy_ticket["board"] == "main"
        assert legacy_ticket["idea_status"] is None
        assert legacy_ticket["idea_emoji"] is None
        assert legacy_ticket["idea_color"] is None
        assert legacy_ticket["origin_idea_id"] is None
    finally:
        sync_engine.dispose()


def test_migration_downgrade_removes_idea_board_columns(tmp_path: Path) -> None:
    db_path = tmp_path / "idea-board-downgrade.db"
    alembic_cfg = _alembic_config(db_path)

    command.upgrade(alembic_cfg, "head")
    command.downgrade(alembic_cfg, "-1")

    sync_engine = create_engine(f"sqlite:///{db_path}")
    try:
        with sync_engine.connect() as connection:
            column_names = {column["name"] for column in inspect(connection).get_columns("ticket")}

        assert IDEA_BOARD_FIELDS.isdisjoint(column_names)
    finally:
        sync_engine.dispose()