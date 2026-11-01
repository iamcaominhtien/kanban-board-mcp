"""Steps appended to a run at the same time (the CLI output reader and a pause, say) are all kept."""

import asyncio

from models import AiRun
from services.ai import runs
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401
from tests.test_notifications import _run


async def test_steps_appended_at_the_same_time_are_all_kept(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    run_id = await _run(env, pid, m["id"], tid)
    await asyncio.gather(
        *(
            runs._append(run_id, steps=[{"kind": "text", "text": f"line {i}"}])
            for i in range(25)
        )
    )
    async with env["maker"]() as s:
        run = await s.get(AiRun, run_id)
    texts = {step["text"] for step in runs.loads(run.steps, [])}
    assert texts == {f"line {i}" for i in range(25)}
    assert run_id not in runs._append_locks or not runs._append_locks[run_id].locked()
