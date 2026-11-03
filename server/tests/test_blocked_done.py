"""A ticket another one still blocks cannot go to Done (found by the live runs of #269): the API, the quick status
change and MCP all refuse it and name the blocker; a blocker that is Done or Won't do, or a block removed, lets it go."""

import pytest

from kanban_mcp import operations as ops
from tests.test_ai import _project, _ticket, env  # noqa: F401


async def _blocked_pair(c, pid):
    blocker = await _ticket(c, pid, title="Store the goal")
    blocked = await _ticket(c, pid, title="Show the goal")
    r = await c.post(f"/tickets/{blocker}/blocks/{blocked}")
    assert r.status_code == 200, r.text
    return blocker, blocked


async def test_done_is_refused_while_a_blocker_is_open_and_names_it(env):
    c = env["c"]
    pid, _ = await _project(c)
    blocker, blocked = await _blocked_pair(c, pid)
    r = await c.patch(f"/tickets/{blocked}", json={"status": "done"})
    assert r.status_code == 400, r.text
    assert blocker in r.json()["detail"] and "todo" in r.json()["detail"]
    # the quick status change (dragging the card) is refused the same way
    r = await c.patch(f"/tickets/{blocked}/status", json={"status": "done"})
    assert r.status_code in (400, 422), r.text
    assert (await c.get(f"/tickets/{blocked}")).json()["status"] == "todo"
    # over MCP the AI reads the same reason
    with pytest.raises(ValueError, match=blocker):
        await ops.update_ticket(blocked, status="done")
    # other columns are not affected
    r = await c.patch(f"/tickets/{blocked}", json={"status": "review"})
    assert r.status_code == 200, r.text


async def test_done_goes_through_once_the_blocker_is_done_or_the_block_removed(env):
    c = env["c"]
    pid, _ = await _project(c)
    blocker, blocked = await _blocked_pair(c, pid)
    assert (
        await c.patch(f"/tickets/{blocker}", json={"status": "done"})
    ).status_code == 200
    r = await c.patch(f"/tickets/{blocked}", json={"status": "done"})
    assert r.status_code == 200, r.text

    blocker2, blocked2 = await _blocked_pair(c, pid)
    r = await c.delete(f"/tickets/{blocker2}/blocks/{blocked2}")
    assert r.status_code in (200, 204), r.text
    r = await c.patch(f"/tickets/{blocked2}", json={"status": "done"})
    assert r.status_code == 200, r.text


async def test_a_blocker_that_will_not_be_done_does_not_hold_the_ticket(env):
    c = env["c"]
    pid, _ = await _project(c)
    blocker, blocked = await _blocked_pair(c, pid)
    r = await c.patch(
        f"/tickets/{blocker}",
        json={"status": "wont_do", "wont_do_reason": "Not needed after all"},
    )
    assert r.status_code == 200, r.text
    r = await c.patch(f"/tickets/{blocked}", json={"status": "done"})
    assert r.status_code == 200, r.text
