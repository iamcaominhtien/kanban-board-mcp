"""The audit trail (services/ai/audit.py: `record`, the only part v2 calls) and the project's settings column
(services/ai/ops.py), through the HTTP routes that write them."""

import json

from sqlmodel import select

import database
from models import AiAudit, AiProjectSettings
from services.ai import ops
from services.ai.audit import record
from tests.ai_helpers import _project, _runner, _ticket, _wait, env  # noqa: F401


async def _entries(project_id=None):
    async with database.async_session() as s:
        stmt = select(AiAudit).order_by(AiAudit.seq)
        if project_id:
            stmt = stmt.where(AiAudit.project_id == project_id)
        return list((await s.exec(stmt)).all())


async def test_entries_are_chained_by_hash_and_numbered(env):  # noqa: F811
    pid, _ = await _project(env["c"])
    a = await record(pid, "x_one", "info", member_name="Team", target="KAN-1")
    b = await record(pid, "x_two", "info", on_behalf_of="An Nguyen")
    assert (a.seq, b.seq) == (1, 2)
    assert a.prev_hash == "" and a.hash
    assert b.prev_hash == a.hash and b.hash != a.hash
    rows = await _entries(pid)
    assert [r.action for r in rows] == ["x_one", "x_two"]
    assert rows[1].on_behalf_of == "An Nguyen" and rows[0].target == "KAN-1"


async def test_concurrent_records_keep_one_unbroken_chain(env):  # noqa: F811
    import asyncio

    pid, _ = await _project(env["c"])
    await asyncio.gather(*(record(pid, f"a{i}", "info") for i in range(8)))
    rows = await _entries(pid)
    assert [r.seq for r in rows] == list(range(1, 9))
    for prev, row in zip(rows, rows[1:]):
        assert row.prev_hash == prev.hash


async def test_secrets_in_the_detail_are_masked_before_saving(env):  # noqa: F811
    pid, _ = await _project(env["c"])
    token = "ghp_" + "a1B2c3D4e5F6g7H8"
    entry = await record(
        pid,
        "x_secret",
        "info",
        detail={"note": f"used {token} here", "api_key": "plain-value", "n": 3},
    )
    assert token not in entry.detail and "plain-value" not in entry.detail
    stored = json.loads(entry.detail)
    assert "gh_" in stored["note"] and stored["n"] == 3 and "••••" in stored["api_key"]


async def test_an_mcp_origin_is_noted_in_the_detail(env):  # noqa: F811
    import services.activity as svc_activity

    pid, _ = await _project(env["c"])
    token = svc_activity._origin.set("mcp")
    try:
        entry = await record(pid, "x_mcp", "info", detail={"a": 1})
        own = await record(pid, "x_own", "info", detail={"via": "kept"})
    finally:
        svc_activity._origin.reset(token)
    assert json.loads(entry.detail) == {"a": 1, "via": "mcp"}
    assert json.loads(own.detail)["via"] == "kept"


async def test_creating_a_team_and_running_it_leave_audit_entries(env):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    assert (await c.post(f"/tickets/{tid}/ai/run", json={})).status_code in (200, 201)
    await _wait(c, tid, ("finished", "failed"), timeout=30)
    rows = await _entries(pid)
    actions = [r.action for r in rows]
    assert actions[0] == "team_created"
    assert rows[0].member_id == team["id"] and rows[0].member_name == team["name"]
    assert "run_queued" in actions
    ended = [r for r in rows if r.action in ("run_finished", "run_failed")]
    assert ended and ended[-1].run_id and ended[-1].target == tid
    assert [r.seq for r in rows] == list(range(1, len(rows) + 1))


# --- ops: the project's settings over the defaults -------------------------------------------------------------


def test_get_reads_the_defaults_for_a_project_that_never_set_any():
    out = ops.get(None)
    assert out["worktrees"]["on"] is False and out["hang_after_min"] == 10
    assert ops.get(AiProjectSettings(project_id="p", ops="not json")) == out
    assert ops.get(AiProjectSettings(project_id="p", ops="[1, 2]")) == out
    out["worktrees"]["on"] = True  # a copy: the defaults are not touched
    assert ops.DEFAULTS["worktrees"]["on"] is False


def test_update_merges_nested_keys_and_ignores_unknown_ones():
    s = AiProjectSettings(project_id="p")
    ops.update(s, {"worktrees": {"on": True, "prepare": "uv sync"}, "bogus": 1})
    full = ops.update(s, {"worktrees": {"base_port": 6000}, "hang_after_min": 3})
    assert full["worktrees"]["on"] is True and full["worktrees"]["prepare"] == "uv sync"
    assert full["worktrees"]["base_port"] == 6000 and full["hang_after_min"] == 3
    assert full["worktrees"]["handover"] == "auto"  # a default under the stored keys
    stored = json.loads(s.ops)
    assert "bogus" not in stored and stored["worktrees"]["base_port"] == 6000
    assert "handover" not in stored["worktrees"]  # only what was set is stored


def test_update_recovers_from_a_corrupt_column():
    s = AiProjectSettings(project_id="p", ops="{broken")
    assert ops.update(s, {"env_path": ["/opt/bin"]})["env_path"] == ["/opt/bin"]
    assert json.loads(s.ops) == {"env_path": ["/opt/bin"]}


async def test_the_settings_route_saves_ops_and_reads_them_back(env):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    r = await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"ops": {"commands": {"test": "pytest -q"}, "nope": True}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ops"] == {"commands": {"test": "pytest -q"}}
    r = await c.patch(
        f"/projects/{pid}/ai/settings", json={"ops": {"commands": {"lint": "ruff"}}}
    )
    got = (await c.get(f"/projects/{pid}/ai/settings")).json()["ops"]
    assert got == {"commands": {"test": "pytest -q", "lint": "ruff"}}
