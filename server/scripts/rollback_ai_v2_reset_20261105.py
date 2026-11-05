"""One-off: undo the schema change of the AI v2 reset migration (a2b4c6d8e0f1) on a PostgreSQL board.

On 2026-11-05 a test of the branch claude/ai-team-architecture-7a1efc started a real MCP server, which ran that
migration on the board named in ~/.kanban-board/config.json. The app on `main` then refuses the database ("made by a
newer version of the app"). This script gives the database the schema of `main` again:

- tables `main` does not know, or knows with other columns, are dropped (only when they are empty);
- the tables of `main` that are missing are created empty;
- alembic_version is set to the head of `main` (f1c3e5a7b9d2).

What the reset removed stays removed: the AI members, their runs and the other AI rows cannot be brought back.

Run it with the code of `main` (its models decide the schema), not this branch:

    cd <main checkout>/server
    KANBAN_CONFIG_DIR=<an empty temp folder> KANBAN_DATABASE_URL=postgresql://user@127.0.0.1:5432/kanban \
        .venv/bin/python <path to this file>            # shows what it would do
        .venv/bin/python <path to this file> --apply    # does it, in one transaction
"""

import asyncio
import os
import sys

from sqlalchemy import inspect, text

MAIN_HEAD = "f1c3e5a7b9d2"
RESET = "a2b4c6d8e0f1"


def _work(sync, apply: bool) -> int:
    from sqlmodel import SQLModel

    import models  # noqa: F401 - registers the tables of this checkout
    from dbkit import changes

    meta = SQLModel.metadata
    insp = inspect(sync)
    rev = sync.execute(text("SELECT version_num FROM alembic_version")).scalar()
    if rev == MAIN_HEAD:
        print(f"Already at {MAIN_HEAD}: nothing to do.")
        return 0
    if rev != RESET:
        print(f"The database is at {rev}, not at {RESET}: this script is not for it.")
        return 2
    own = set(changes.metadata.tables) | {"alembic_version"}
    drop: list[tuple[str, str]] = []
    drop_cols: list[tuple[str, str]] = []
    problems: list[str] = []
    for name in sorted(insp.get_table_names()):
        if name in own:
            continue
        have = {c["name"] for c in insp.get_columns(name)}
        if name not in meta.tables:
            if name.startswith("ai_"):
                drop.append((name, "not a table of main"))
            else:
                problems.append(f"{name}: not a table of main, and not an AI table")
            continue
        want = {c.name for c in meta.tables[name].columns}
        if want - have:
            drop.append((name, f"misses {sorted(want - have)[:6]}…"))
        else:
            drop_cols += [(name, c) for c in sorted(have - want)]
    for name, _ in drop:
        rows = sync.execute(text(f'SELECT count(*) FROM "{name}"')).scalar()
        if rows:
            problems.append(f"{name}: has {rows} rows; it would be lost")
    missing = sorted(
        set(meta.tables) - set(insp.get_table_names())
        | {n for n, _ in drop if n in meta.tables}
    )
    print("Drop (empty) tables:")
    for name, why in drop:
        print(f"  {name}  ({why})")
    print("Drop columns main does not have:")
    for name, col in drop_cols:
        print(f"  {name}.{col}")
    print("Create empty, as on main:")
    print("  " + ", ".join(missing))
    print(f"Set alembic_version: {RESET} -> {MAIN_HEAD}")
    if problems:
        print("STOPPED, nothing changed:")
        for p in problems:
            print("  " + p)
        return 3
    if not apply:
        print("Dry run: nothing changed. Add --apply to do it.")
        return 0
    for name, _ in drop:
        sync.execute(text(f'DROP TABLE "{name}"'))
    for name, col in drop_cols:
        sync.execute(text(f'ALTER TABLE "{name}" DROP COLUMN "{col}"'))
    # as the app makes a server database: links between tables are not enforced by the database
    from dbkit.types import server_metadata

    server_metadata(meta, sync.dialect.name).create_all(sync, checkfirst=True)
    sync.execute(
        text("UPDATE alembic_version SET version_num = :new"), {"new": MAIN_HEAD}
    )
    print("Done.")
    return 0


async def main() -> int:
    """Open the database this checkout resolves (KANBAN_DATABASE_URL) and run in one transaction."""
    sys.path.insert(
        0, os.getcwd()
    )  # the checkout this is run from, not the folder of this file
    import database
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(database.alembic_config()).get_current_head()
    print(
        f"Code: {os.path.dirname(os.path.abspath(database.__file__))} (migration head {head})"
    )
    if head != MAIN_HEAD:
        print(
            f"Run this from a checkout of main (head {MAIN_HEAD}); this one would give the wrong schema."
        )
        return 2
    if database.engine.dialect.name != "postgresql":
        print(
            f"This is for PostgreSQL; the database resolved here is {database.DATABASE_URL}"
        )
        return 2
    print(f"Database: {database.DATABASE_URL}")
    async with database.engine.begin() as conn:
        code = await conn.run_sync(_work, "--apply" in sys.argv)
        if code:
            await conn.rollback()
    await database.engine.dispose()
    return code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
