"""Build the demo board of the databases demo: a SQLite file with ~30,000 rows and one legacy notification whose group
key is too long for MySQL's indexed VARCHAR(255) (the copy to MariaDB stops there and the AI helps).

Run from server/: uv run python ../docs/demo/databases/seed_demo_board.py /path/to/data/kanban.db"""
import asyncio, os, sys, random, uuid, json
path = sys.argv[1]
os.environ["KANBAN_DB_PATH"] = path
sys.path.insert(0, ".")
from datetime import datetime, timedelta, timezone
from sqlalchemy import insert
from dbkit import targets
from dbkit.move import Mover
from models import Notification
from tests.db_seed import seed

async def main():
    src = targets.Target("sqlite", path=path)
    m = Mover(targets.Target("sqlite", path="/nonexistent/u.db"), src); await m.prepare_target(); await m.close()
    e = targets.make_engine(src)
    out = await seed(e, projects_n=3, tickets_n=150)
    random.seed(7)
    now = datetime(2026, 11, 2, tzinfo=timezone.utc)
    rows = []
    kinds = ["mention", "assigned", "status", "comment", "ai_done", "review"]
    for i in range(30000):
        t = (now - timedelta(minutes=i * 3)).isoformat()
        tid = random.choice(out["tickets"])
        k = random.choice(kinds)
        rows.append(dict(id=str(uuid.uuid4()), recipient="user", event_id=i + 1, last_event_id=i + 1,
                         project_id=random.choice(out["projects"]), kind=k, needs=False,
                         group_key=f"{k}:{tid}", count=1, items="[]", target_kind="ticket", target_id=tid,
                         ticket_id=tid, title=f"{k.replace('_', ' ').title()} on {tid}", body="",
                         data="{}", inapp=True, desktop=False, created_at=t, updated_at=t))
    # imported from an older board: a thread key that holds a whole docs path
    long_key = "docs-thread:" + "/".join(f"architecture-decision-record-{n:03d}-storage-and-sync" for n in range(9))
    rows[17000]["group_key"] = long_key
    async with e.begin() as c:
        for i in range(0, len(rows), 2000):
            await c.execute(insert(Notification.__table__), rows[i:i + 2000])
    await e.dispose()
    print("group_key length", len(long_key))

asyncio.run(main())
