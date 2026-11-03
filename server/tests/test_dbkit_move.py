"""Moving a board between databases (design/screens/ai-databases.md D, E): check, copy, verify, stop and resume.

SQLite to SQLite always runs. With KANBAN_TEST_PG_URL and KANBAN_TEST_MYSQL_URL (empty databases the tests may drop
and recreate tables in; CI's "Databases" job sets them) the round trip SQLite → PostgreSQL → MySQL → SQLite runs too,
compared row by row.
"""

import os

import pytest
from sqlalchemy import select, text
from sqlmodel import SQLModel

import models  # noqa: F401
from dbkit import move, targets
from dbkit.move import CopyStopped, Mover, MoveError
from tests.db_seed import seed

PG = os.environ.get("KANBAN_TEST_PG_URL", "")
MY = os.environ.get("KANBAN_TEST_MYSQL_URL", "")


async def _board(tmp_path) -> targets.Target:
    """A SQLite board at the newest migration with some data."""
    src = targets.Target("sqlite", path=str(tmp_path / "source.db"))
    empty = targets.Target("sqlite", path=str(tmp_path / "unused.db"))
    m = Mover(empty, src)
    await m.prepare_target()  # migrations, as the app makes a new file
    await m.close()
    engine = targets.make_engine(src)
    await seed(engine)
    await engine.dispose()
    return src


async def _wipe(target: targets.Target) -> None:
    m = Mover(targets.Target("sqlite", path="/nonexistent/x.db"), target)
    await m.empty_target()
    await m.close()


async def _rows(target: targets.Target) -> dict[str, list]:
    engine = targets.make_engine(target)
    out = {}
    async with engine.connect() as conn:
        for t in SQLModel.metadata.sorted_tables:
            pk = list(t.primary_key.columns)
            rows = (await conn.execute(select(t).order_by(*pk))).all()
            out[t.name] = [tuple(r) for r in rows]
    await engine.dispose()
    return out


async def _move(source, target, **kw) -> dict:
    async with Mover(source, target) as m:
        plan = await m.plan()
        assert plan.rows > 0
        await m.prepare_target(**kw)
        await m.copy()
        result = await m.verify()
    return result


async def test_sqlite_to_sqlite_copies_and_proves_it(tmp_path):
    src = await _board(tmp_path)
    dst = targets.Target("sqlite", path=str(tmp_path / "copy.db"))
    result = await _move(src, dst)
    assert result["ok"], result["checks"]
    keys = [c["key"] for c in result["checks"]]
    assert keys == ["counts", "content", "links", "counters", "search"]
    assert await _rows(src) == await _rows(dst)
    # the copy's docs search works (the index was copied)
    engine = targets.make_engine(dst)
    async with engine.connect() as conn:
        hits = (
            await conn.execute(
                text("SELECT COUNT(*) FROM docs_fts WHERE docs_fts MATCH 'PostgreSQL'")
            )
        ).scalar()
    await engine.dispose()
    assert hits >= 1


async def test_a_target_that_is_not_empty_is_refused_then_emptied(tmp_path):
    src = await _board(tmp_path)
    dst = targets.Target("sqlite", path=str(tmp_path / "copy.db"))
    await _move(src, dst)
    with pytest.raises(MoveError) as err:
        async with Mover(src, dst) as m:
            await m.prepare_target()
    assert err.value.code == "target_not_empty"
    result = await _move(src, dst, empty_first=True)
    assert result["ok"]


async def test_source_and_target_must_differ(tmp_path):
    t = targets.Target("sqlite", path=str(tmp_path / "a.db"))
    with pytest.raises(MoveError):
        Mover(t, t)


async def test_a_stop_names_the_table_row_and_column_and_resume_finishes(
    tmp_path, monkeypatch
):
    src = await _board(tmp_path)
    dst = targets.Target("sqlite", path=str(tmp_path / "copy.db"))
    async with Mover(src, dst) as m:
        await m.plan()
        await m.prepare_target()
        # a CHECK on the target that one source row breaks, as a too-short column would on MySQL
        async with m.dst.begin() as conn:
            await conn.execute(
                text(
                    "CREATE TRIGGER no_long BEFORE INSERT ON idea_ticket WHEN length(NEW.body) > 255 "
                    "BEGIN SELECT RAISE(ABORT, 'Data too long for column ''body'' at row 1'); END"
                )
            )
        with pytest.raises(CopyStopped) as stopped:
            await m.copy()
        stop = stopped.value.stop
        assert stop.table == "idea_ticket"
        assert stop.column == "body"
        assert stop.row == 1 and stop.value_length > 255
        assert "Data too long" in stop.error
        # tables before it are complete, the one it stopped in is empty (resume re-reads it from the start)
        done = [s.name for s in m.tables if s.state == "done"]
        assert "project" in done and "idea_ticket" not in done
        async with m.dst.begin() as conn:
            assert (
                await conn.execute(text("SELECT COUNT(*) FROM idea_ticket"))
            ).scalar() == 0
            await conn.execute(text("DROP TRIGGER no_long"))  # the fix
        await m.copy(start_at="idea_ticket")
        result = await m.verify()
    assert result["ok"], result["checks"]
    assert await _rows(src) == await _rows(dst)


async def test_text_in_a_number_column_is_converted():
    from sqlalchemy import Column, Integer, MetaData, String, Table

    t = Table("x", MetaData(), Column("n", Integer), Column("s", String))
    assert move._coercer(t.c.n)("12") == 12
    assert move._coercer(t.c.s)(12) == "12"
    assert move._coercer(t.c.s)(None) is None


def test_errors_never_carry_the_row():
    class Orig(Exception):
        sqlstate = "23502"

    exc = Orig(
        'null value in column "title" of relation "ticket" violates not-null constraint\n'
        "DETAIL:  Failing row contains (KB-1, secret text)."
    )
    message, code = move.clean_error(exc)
    assert "secret" not in message and code == "23502"
    assert move._error_column(message) == "title"


@pytest.mark.skipif(
    not (PG and MY), reason="needs KANBAN_TEST_PG_URL and KANBAN_TEST_MYSQL_URL"
)
async def test_round_trip_sqlite_postgres_mysql_sqlite(tmp_path):
    src = await _board(tmp_path)
    pg = targets.from_url(PG)
    my = targets.from_url(MY)
    back = targets.Target("sqlite", path=str(tmp_path / "back.db"))
    await _wipe(pg)
    await _wipe(my)
    for a, b in ((src, pg), (pg, my), (my, back)):
        result = await _move(a, b)
        assert result["ok"], (a.engine, b.engine, result["checks"])
    assert await _rows(src) == await _rows(back)
    await _wipe(pg)
    await _wipe(my)
