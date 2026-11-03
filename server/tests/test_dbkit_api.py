"""The Settings routes of the move (design D, E): test, check, copy, a stop the AI helps with, apply and resume,
verify, switch and back. The source is the test run's own database; the target is a SQLite file, so this runs
everywhere (the engines themselves are covered by test_dbkit_move.py)."""

import asyncio

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

import database
from dbkit import assist, jobs, move
from main import app


@pytest.fixture
async def client():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest.fixture(autouse=True)
async def _no_move_left():
    yield
    if jobs._job is not None and jobs._job.mover is not None:
        await jobs._job.mover.close()
    jobs._job = None
    (database.get_data_dir() / jobs.STATE_FILE).unlink(missing_ok=True)


async def _wait(client, *states, timeout=60):
    for _ in range(int(timeout / 0.1)):
        job = (await client.get("/database/move")).json()
        if job["state"] in states and job["ai"]["state"] != "asking":
            return job
        await asyncio.sleep(0.1)
    raise AssertionError(f"still {job['state']}")


async def test_the_card_says_what_the_board_uses(client):
    r = await client.get("/database")
    body = r.json()
    assert r.status_code == 200
    assert body["engine"] == "sqlite" and body["reachable"] and body["tables"] >= 80
    assert body["locked"] is False and "password" not in str(body["settings"])


async def test_testing_a_database_that_is_not_there(client):
    r = await client.post(
        "/database/test",
        json={
            "engine": "postgresql",
            "host": "127.0.0.1",
            "port": 1,
            "name": "x",
            "user": "u",
            "password": "p",
        },
    )
    body = r.json()
    assert body["ok"] is False
    assert (
        body["findings"][0]["level"] == "error"
        and "Cannot reach" in body["findings"][0]["title"]
    )


async def test_redis_is_refused_with_the_reason(client):
    r = await client.post("/database/test", json={"url": "redis://localhost:6379/0"})
    assert r.status_code == 422 and "relational" in r.json()["detail"]


async def test_copy_stops_the_ai_proposes_the_board_applies_and_checks(
    client, tmp_path, monkeypatch
):
    target = tmp_path / "moved.db"
    original_create = move.Mover._create_target

    async def create_with_a_limit(self):
        await original_create(self)
        async with (
            self.dst.begin() as conn
        ):  # a column the target is too small for, as VARCHAR(255) on MySQL
            await conn.execute(
                text(
                    "CREATE TRIGGER too_small BEFORE INSERT ON project WHEN 1 "
                    "BEGIN SELECT RAISE(ABORT, 'Data too long for column ''name'' at row 1'); END"
                )
            )

    monkeypatch.setattr(move.Mover, "_create_target", create_with_a_limit)

    class Profile:
        connection = "local"

    async def pick():
        return Profile(), "Claude"

    shown = {}

    async def fake_complete(profile, *, system, prompt, **kw):
        from services.ai.llm import Completion

        shown["prompt"] = prompt
        return Completion(
            text='{"cause": "The target column is too small.", '
            '"statements": ["DROP TABLE ticket", "ALTER TABLE project RENAME TO x"], '
            '"affects": "project.name", "other_columns": [], "confidence": "high", "answer": ""}',
            metered=False,
        )

    monkeypatch.setattr(assist, "pick_member", pick)
    monkeypatch.setattr("services.ai.llm.complete", fake_complete)

    made = await client.post(
        "/projects", json={"name": "Move me", "prefix": "MOV", "color": "#2E6F40"}
    )
    assert made.status_code == 201
    body = {"engine": "sqlite", "path": str(target)}
    check = await client.post("/database/move/check", json=body)
    assert check.status_code == 200, check.text
    plan = check.json()["plan"]
    assert plan["rows"] > 0 and plan["tables_count"] >= 80

    r = await client.post("/database/move/start", json={"mode": "copy"})
    assert r.status_code == 200
    job = await _wait(client, "stopped", "verified", "failed")
    assert job["state"] == "stopped", job["error"]
    stop = job["stop"]
    assert (
        stop["table"] == "project" and stop["column"] == "name" and stop["value_length"]
    )

    await client.post("/database/move/ask", json={})
    job = await _wait(client, "stopped")
    proposal = job["ai"]["proposal"]
    assert proposal["member"] == "Claude"
    assert proposal["applicable"] is False and "Only ALTER TABLE" in proposal["refused"]
    assert proposal["cause"] == "The target column is too small."
    # the AI is shown names, types, counts and the error, never a value of the row
    assert (
        '"table": "project"' in shown["prompt"]
        and "value_length_chars" in shown["prompt"]
    )

    refused = await client.post(
        "/database/move/apply", json={"statements": ["DROP TRIGGER too_small"]}
    )
    assert refused.status_code == 422

    # Edit it myself: an ALTER TABLE the board accepts runs on the target, and the copy resumes (and stops again here,
    # because the stand-in limit is still there)
    applied = await client.post(
        "/database/move/apply",
        json={"statements": ["ALTER TABLE project ADD COLUMN extra TEXT;"]},
    )
    assert applied.status_code == 200
    job = await _wait(client, "stopped", "verified", "failed")
    assert (
        job["applied"] == ["ALTER TABLE project ADD COLUMN extra TEXT"]
        and job["state"] == "stopped"
    )

    # what a person would do: the fix the board can run is an ALTER TABLE; the trigger stands in for a too-small
    # column, so drop it directly and resume without a change
    eng = move.targets.make_engine(move.targets.Target("sqlite", path=str(target)))
    async with eng.begin() as conn:
        await conn.execute(text("DROP TRIGGER too_small"))
    await eng.dispose()
    await client.post("/database/move/resume", json={})
    job = await _wait(client, "verified", "verified_with_differences", "failed")
    assert job["state"] == "verified", job["verify"]
    assert all(c["ok"] for c in job["verify"]["checks"])

    await client.delete(f"/projects/{made.json()['id']}")
    keep = await client.delete("/database/move")
    assert (
        keep.status_code == 200 and (await client.get("/database/move")).json() is None
    )


async def test_a_target_with_tables_must_be_confirmed_by_name(client, tmp_path):
    target = tmp_path / "busy.db"
    eng = move.targets.make_engine(move.targets.Target("sqlite", path=str(target)))
    async with eng.begin() as conn:
        await conn.execute(text("CREATE TABLE notes (x)"))
    await eng.dispose()
    check = (
        await client.post(
            "/database/move/check", json={"engine": "sqlite", "path": str(target)}
        )
    ).json()
    assert check["report"]["state"] == "foreign"
    wrong = await client.post(
        "/database/move/start",
        json={"mode": "copy", "empty_first": True, "confirm": "nope"},
    )
    assert wrong.status_code == 422
    ok = await client.post(
        "/database/move/start",
        json={"mode": "empty", "empty_first": True, "confirm": "busy.db"},
    )
    assert ok.status_code == 200
    job = await _wait(client, "verified", "failed")
    assert job["state"] == "verified" and job["verify"]["empty"]


async def test_command_for_the_script(client):
    body = (
        await client.get("/database/command", params={"target": "postgresql://k@h/db"})
    ).json()
    assert (
        "--dry-run" in body["dry_run"]
        and "--verify" in body["run"]
        and body["password_env"] == "KANBAN_DB_PASSWORD"
    )
