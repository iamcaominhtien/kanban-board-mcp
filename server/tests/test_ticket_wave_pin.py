"""TDP-1: a sub-ticket's execution wave can be pinned by hand. Without a pin the wave is computed from Blocked by, as
before; with one, the sub-ticket order, the Story's start order and the MCP tools use the pin."""

import json

import pytest

from kanban_mcp import operations as ops
from models import Story, Ticket
from services import stories, ticket_waves
from services.ai import manager
from tests.ai_helpers import _project, _ticket, env  # noqa: F401


def _t(tid, blocked_by=(), pin=None, status="todo"):
    return Ticket(
        id=tid,
        project_id="p",
        title=tid,
        status=status,
        blocked_by=json.dumps(list(blocked_by)),
        wave_pin=pin,
    )


def test_without_a_pin_the_wave_comes_from_blocked_by():
    a, b, c = _t("A"), _t("B", ["A"]), _t("C", ["B"])
    assert ticket_waves.waves([a, b, c]) == {"A": 1, "B": 2, "C": 3}
    # a blocker outside the siblings does not count; a loop stops
    assert ticket_waves.waves([_t("X", ["Z"])]) == {"X": 1}
    loop = ticket_waves.waves([_t("L", ["M"]), _t("M", ["L"])])
    assert set(loop.values()) <= {1, 2, 3}


def test_a_pin_is_used_as_it_is_and_the_tickets_it_blocks_count_from_it():
    a, b, c = _t("A"), _t("B", ["A"], pin=4), _t("C", ["B"])
    assert ticket_waves.waves([a, b, c]) == {"A": 1, "B": 4, "C": 5}
    early = _t("E", ["A"], pin=1)
    assert ticket_waves.waves([a, early]) == {"A": 1, "E": 1}


def test_a_pinned_ticket_waits_for_the_earlier_waves_only():
    a, b = _t("A"), _t("B", ["A"], pin=1)
    # pinned to wave 1: starts even though A (Blocked by) is open
    assert ticket_waves.pinned_ready(b, [a, b], closed=set())
    late = _t("L", pin=2)
    assert not ticket_waves.pinned_ready(late, [a, late], closed=set())
    assert ticket_waves.pinned_ready(late, [a, late], closed={"A"})


def test_a_pin_is_a_whole_number_in_range_or_null():
    assert ticket_waves.clean_pin(None) is None
    assert ticket_waves.clean_pin(3) == 3
    for bad in (0, 100, True, "2", 1.5):
        with pytest.raises(ValueError):
            ticket_waves.clean_pin(bad)


async def test_the_api_sets_and_clears_the_pin(env):
    c = env["c"]
    pid, _ = await _project(c)
    parent = await _ticket(c, pid, title="Parent")
    kid = (
        await c.post(
            f"/projects/{pid}/tickets", json={"title": "Kid", "parent_id": parent}
        )
    ).json()["id"]
    assert (await c.get(f"/tickets/{kid}")).json()["wave_pin"] is None
    r = await c.patch(f"/tickets/{kid}", json={"wave_pin": 2})
    assert r.status_code == 200 and r.json()["wave_pin"] == 2
    bad = await c.patch(f"/tickets/{kid}", json={"wave_pin": 0})
    assert bad.status_code in (400, 422), bad.text
    r = await c.patch(f"/tickets/{kid}", json={"wave_pin": None})
    assert r.status_code == 200 and r.json()["wave_pin"] is None


async def test_the_mcp_tools_show_and_set_the_pin(env):
    c = env["c"]
    pid, _ = await _project(c)
    parent = await _ticket(c, pid, title="Parent")
    kid = (
        await c.post(
            f"/projects/{pid}/tickets", json={"title": "Kid", "parent_id": parent}
        )
    ).json()["id"]
    out = await ops.update_ticket(kid, wave_pin=3)
    assert out["wave_pin"] == 3
    listed = await ops.list_tickets(pid, parent_id=parent)
    rows = listed["tickets"] if isinstance(listed, dict) else listed
    assert [t["wave_pin"] for t in rows if t["id"] == kid] == [3]
    out = await ops.update_ticket(kid, clear_fields=["wave_pin"])
    assert out["wave_pin"] is None


async def _story_with(env, pid, kids):
    """A Story in progress whose plan is the kids in order, each `after` its Blocked by."""
    async with env["maker"]() as s:
        sid = "KAN-900"
        s.add(Ticket(id=sid, project_id=pid, title="Story", type="story"))
        for k in kids:
            k.project_id = pid
            k.parent_id = sid
            s.add(k)
        s.add(
            Story(
                ticket_id=sid,
                project_id=pid,
                state="in_progress",
                plan=json.dumps(
                    {
                        "items": [
                            {
                                "ticket_id": k.id,
                                "after": json.loads(k.blocked_by),
                                "covers": [],
                            }
                            for k in kids
                        ]
                    }
                ),
            )
        )
        await s.commit()
    return sid


async def _started(env, monkeypatch, sid):
    """The children `stories.drive` starts (the manager is not run: only what it is asked to take is recorded)."""
    taken: list[str] = []

    def take(tid, **_kw):
        taken.append(tid)
        return tid

    monkeypatch.setattr(manager, "take", take)
    monkeypatch.setattr(manager, "later", lambda _x: None)
    async with env["maker"]() as s:
        await stories.drive(s, sid)
    return taken


@pytest.mark.parametrize(
    ("pin_b", "expected"),
    [(None, ["KAN-901"]), (1, ["KAN-901", "KAN-902"])],
)
async def test_the_story_starts_by_blocked_by_unless_a_wave_is_pinned(
    env, monkeypatch, pin_b, expected
):
    c = env["c"]
    pid, _ = await _project(c)
    a = _t("KAN-901")
    b = _t("KAN-902", ["KAN-901"], pin=pin_b)
    sid = await _story_with(env, pid, [a, b])
    assert await _started(env, monkeypatch, sid) == expected


async def test_a_story_ticket_pinned_later_waits_for_the_earlier_wave(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    a = _t("KAN-901")
    b = _t("KAN-902", pin=2)  # no Blocked by, but pinned after wave 1
    sid = await _story_with(env, pid, [a, b])
    assert await _started(env, monkeypatch, sid) == ["KAN-901"]
