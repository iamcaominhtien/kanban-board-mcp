"""Every AI read endpoint answers without a server error, on a project with a member, a finished run, a schedule
and audit entries, and with ids that do not exist (404, never 500). A crash in one of these hid Ask AI on Windows."""

import re
import uuid
from datetime import UTC, datetime, timedelta

from main import app
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401

_PARAMS = {"name": "Reviewer", "q": "login", "title": "Login fails", "text": "login"}


def _ai_get_routes() -> list[str]:
    return sorted(
        r.path
        for r in app.routes
        if "GET" in getattr(r, "methods", set())
        and ("/ai" in r.path or "assist" in r.path)
    )


async def _seed(c, env) -> dict:
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("finished", "failed"))
    run_at = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    sched = (
        await c.post(
            f"/projects/{pid}/ai/schedules",
            json={
                "ticket_id": tid,
                "member_id": m["id"],
                "kind": "once",
                "run_at": run_at,
                "tz": "Asia/Ho_Chi_Minh",
            },
        )
    ).json()
    # Board AI chosen, so the assistant endpoints go past "not configured"
    r = await c.patch(f"/projects/{pid}/ai/settings", json={"board_ai_id": m["id"]})
    assert r.status_code == 200, r.text
    audit = (await c.get(f"/projects/{pid}/ai/audit")).json()
    entries = audit.get("entries") or []
    return {
        "project_id": pid,
        "member_id": m["id"],
        "ticket_id": tid,
        "run_id": run["id"],
        "schedule_id": sched.get("id"),
        "entry_id": entries[0]["id"] if entries else None,
    }


async def test_every_ai_read_endpoint_answers_without_a_server_error(env):
    c = env["c"]
    ids = await _seed(c, env)
    assert all(ids.values()), ids
    crashed = []
    for path in _ai_get_routes():
        for missing in (False, True):
            url = re.sub(
                r"\{(\w+)\}",
                lambda m: (
                    str(uuid.uuid4())
                    if missing or not ids.get(m.group(1))
                    else ids[m.group(1)]
                ),
                path,
            )
            r = await c.get(url, params=_PARAMS)
            if r.status_code >= 500:
                crashed.append(f"{r.status_code} {url}")
    assert crashed == []
