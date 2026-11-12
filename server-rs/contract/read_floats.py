"""What the Python server reads from the float columns of `ai_run`, for the test of `kb_db::float`
(`crates/kb-db/tests/common`: the rows are stored through the Rust entities, read back through them, and read here
through the SQLAlchemy model of the Python server on the same database).

Run from `server/` with the database of the test in `KANBAN_DATABASE_URL` (or `KANBAN_DB_PATH` for SQLite) and a
`KANBAN_CONFIG_DIR` of its own:

    .venv/bin/python ../server-rs/contract/read_floats.py <run id>...

Prints one JSON object: `rows` (run id to `[cost_usd, peak_rss_mb, last_rss_mb]`), and `sum`, `avg`, `max`, `min` of
`cost_usd` over those rows as the database computed them.
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.getcwd())

from sqlalchemy import func  # noqa: E402
from sqlmodel import col, select  # noqa: E402

import database  # noqa: E402
from models import AiRun  # noqa: E402


async def main(ids: list[str]) -> None:
    async with database.async_session() as session:
        rows = (await session.exec(select(AiRun).where(col(AiRun.id).in_(ids)))).all()
        out = {"rows": {r.id: [r.cost_usd, r.peak_rss_mb, r.last_rss_mb] for r in rows}}
        for name, fn in (("sum", func.sum), ("avg", func.avg), ("max", func.max), ("min", func.min)):
            out[name] = (await session.exec(select(fn(AiRun.cost_usd)).where(col(AiRun.id).in_(ids)))).one()
    await database.engine.dispose()
    print(json.dumps(out))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
