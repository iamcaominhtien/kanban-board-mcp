"""The paused state: what Pause all AI saves for the banner and for Resume, a second Resume, what each AI has
waiting, and the paused time apart from the others (design/screens/ai-paused.md)."""

from datetime import UTC, datetime

from services.ai import pause_log
from tests.test_ai import (  # noqa: F401
    _project,
    _runner,
    _ticket,
    _wait,
    env,
)


async def test_pause_saves_what_it_chose_and_resume_reports_a_second_resume(
    env, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    await c.patch(f"/projects/{pid}/ai/settings", json={"safe_mode": True})
    r = await c.post(
        f"/projects/{pid}/ai/pause-all",
        json={"reason": "Odd edits", "cancel_running": False},
    )
    assert r.status_code == 200
    board = (await c.get(f"/projects/{pid}/ai/board")).json()["settings"]
    assert board["paused_all"] is True
    assert board["paused_let_finish"] is True
    assert board["paused_safe_before"] is True
    assert board["paused_finishing"] == 0
    assert board["my_role"] in ("owner", "admin")

    info = (await c.get(f"/projects/{pid}/ai/resume-info")).json()
    assert info["safe_before"] is True
    assert [x["member_id"] for x in info["members"]] == [m["id"]]
    assert info["members"][0]["held"] == []

    body = {"reviewed": True, "safe_mode": False}
    assert (
        await c.post(f"/projects/{pid}/ai/resume-all", json=body)
    ).status_code == 200
    again = await c.post(f"/projects/{pid}/ai/resume-all", json=body)
    assert again.status_code == 409
    detail = again.json()["detail"]
    assert detail["code"] == "already_resumed"
    assert detail["message"] == "AI was already resumed."
    assert detail["at"]


async def test_resume_info_says_what_each_ai_has_waiting(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    t1, t2 = await _ticket(c, pid, "A"), await _ticket(c, pid, "B")
    await c.post(
        f"/tickets/{t1}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, t1, ("running",))
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": m["id"], "start": "queue"}
    )
    await c.post(f"/projects/{pid}/ai/pause-all", json={})
    await _wait(c, t1, ("cancelled",))
    info = (await c.get(f"/projects/{pid}/ai/resume-info")).json()
    row = info["members"][0]
    assert row["held"] == [t2]
    assert [x["ticket_id"] for x in row["cancelled"]] == [t1]
    assert info["held_order"] == [{"ticket_id": t2, "member_id": m["id"]}]
    # the team card names the stopped run too
    team = (await c.get(f"/projects/{pid}/ai/team/now")).json()
    card = next(x for x in team["members"] if x["id"] == m["id"])
    assert card["state"] == "paused"
    assert card["pause"]["project"] is True
    assert card["pause"]["cancelled"]["ticket_id"] == t1
    flow = (await c.get(f"/projects/{pid}/ai/team/flow")).json()
    assert flow["paused_all"] is True
    node = next(n for n in flow["nodes"] if n["id"] == m["id"])
    assert node["pause_tag"] == "paused" and node["held"] == 1


async def test_pause_intervals_come_from_the_audit_log(env):
    c = env["c"]
    pid, _an = await _project(c)
    await _runner(c, pid, env["repo"])
    await c.post(f"/projects/{pid}/ai/pause-all", json={"reason": "first"})
    await c.post(
        f"/projects/{pid}/ai/resume-all", json={"reviewed": True, "safe_mode": False}
    )
    await c.post(f"/projects/{pid}/ai/pause-all", json={"reason": "second"})
    async with env["maker"]() as s:
        rows = await pause_log.intervals(s, pid)
    assert [p["reason"] for p in rows] == ["first", "second"]
    assert rows[0]["to"] is not None and rows[1]["to"] is None
    start = datetime(2000, 1, 1, tzinfo=UTC)
    secs = pause_log.overlap_s(rows, start, datetime.now(UTC))
    assert secs >= 0
