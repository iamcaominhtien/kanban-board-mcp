"""Wave 5 of the design audit, ideas and board: activity that says which assumption it is about (IP-8, IW-4), what
the caller sorted this week (ICT-9) and the lane counts (AL-1)."""

import json
from datetime import UTC, datetime, timedelta

import httpx
from httpx import ASGITransport

from main import app
from models import IdeaTicket, Ticket
from services import idea_space as space
from tests.test_idea_space_api import API, _assumption, _stage
from tests.test_idea_tickets import (  # noqa: F401  (fixtures)
    _create_idea,
    _create_project,
    setup_db,
    test_async_session,
)

MIA = {"X-Actor": "Mia"}


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _assumption_entries(idea: dict) -> list[dict]:
    return [e for e in idea["activity_trail"] if e.get("kind") == "assumption"]


async def _set_trail(idea_id: str, change) -> None:
    async with test_async_session() as s:
        row = await s.get(IdeaTicket, idea_id)
        row.activity_trail = json.dumps(change(json.loads(row.activity_trail or "[]")))
        s.add(row)
        await s.commit()


# --- IP-8 / IW-4 -------------------------------------------------------------------------------------------------


async def test_assumption_entries_name_their_assumption_and_its_change():
    async with _client() as c:
        p = await _create_project(c)
        idea = await _create_idea(c, p["id"])
        a = await _assumption(c, idea["id"], text="They pay for it")
        url = f"{API}/{idea['id']}/assumption-records/{a['id']}"
        r = await c.patch(url, json={"status": "testing"})
        assert r.status_code == 200, r.text
        r = await c.patch(url, json={"text": "They pay for it monthly"})
        assert r.status_code == 200, r.text
        r = await c.delete(f"/api/idea-tickets/{idea['id']}/assumptions/{a['id']}")
        assert r.status_code in (200, 204), r.text
        full = (await c.get(f"{API}/{idea['id']}")).json()
    entries = _assumption_entries(full)
    added, marked = entries[0], entries[1]
    assert added["label"] == "Assumption added"
    assert added["meta"] == {
        "assumption": a["id"],
        "assumption_text": "They pay for it",
    }
    assert marked["label"] == "Assumption marked as testing"
    assert marked["meta"]["assumption"] == a["id"]
    assert (marked["meta"]["from"], marked["meta"]["to"]) == ("untested", "testing")
    edited = next(e for e in entries if e["label"] == "Assumption edited")
    assert edited["meta"]["assumption_text"] == "They pay for it monthly"
    deleted = next(e for e in entries if e["label"] == "Assumption deleted")
    assert deleted["meta"]["assumption"] == a["id"]


async def test_old_assumption_entries_stay_as_they_were():
    async with _client() as c:
        p = await _create_project(c)
        idea = await _create_idea(c, p["id"])
    old = {
        "id": "e1",
        "label": "Assumption marked as validated",
        "at": "2026-01-01T00:00:00+00:00",
        "kind": "assumption",
    }
    await _set_trail(idea["id"], lambda _t: [old])
    async with _client() as c:
        items = (await c.get(f"{API}/{idea['id']}/activity")).json()["items"]
    assert items == [old]


# --- ICT-9 -------------------------------------------------------------------------------------------------------


async def test_sorted_this_week_counts_each_decision_of_the_caller():
    async with _client() as c:
        p = await _create_project(c)
        pid = p["id"]
        await c.post(f"/projects/{pid}/members", json={"name": "Mia", "role": "member"})
        ideas = [await _create_idea(c, pid, title=f"Idea {n}") for n in range(6)]
        target = await _create_idea(c, pid, title="Target")
        await _stage(c, target["id"], "exploring")

        async def stage(idea, **body):
            r = await c.post(f"{API}/{idea['id']}/stage", json=body, headers=MIA)
            assert r.status_code == 200, r.text

        await stage(ideas[0], to="exploring")
        await stage(ideas[1], to="exploring")
        await stage(
            ideas[2],
            to="parked",
            park_until=(datetime.now(UTC) + timedelta(days=30)).date().isoformat(),
        )
        await stage(ideas[3], to="archived", archive_reason="already_exists")
        r = await c.post(
            f"{API}/{ideas[4]['id']}/merge", json={"into_id": target["id"]}, headers=MIA
        )
        assert r.status_code == 200, r.text
        # undone: not counted
        await stage(ideas[5], to="exploring")
        assert (
            await c.post(f"{API}/{ideas[5]['id']}/undo", headers=MIA)
        ).status_code == 200
        week = f"{API}/sorted-this-week"
        mine = (await c.get(week, params={"project_id": pid}, headers=MIA)).json()
        board_user = (await c.get(week, params={"project_id": pid})).json()
        everywhere = (await c.get(week, params={"scope": "all"}, headers=MIA)).json()
    assert mine == {
        "total": 5,
        "kept": 2,
        "parked": 1,
        "merged": 1,
        "archived": 1,
        "days": 7,
    }
    # the board's own user moved only the target out of the Inbox: one kept
    assert board_user["total"] == 1 and board_user["kept"] == 1
    assert everywhere["total"] == 5


async def test_a_sort_older_than_a_week_is_not_counted():
    async with _client() as c:
        p = await _create_project(c)
        idea = await _create_idea(c, p["id"])
        await _stage(c, idea["id"], "exploring")
    old = (datetime.now(UTC) - timedelta(days=8)).isoformat()
    await _set_trail(idea["id"], lambda t: [{**e, "at": old} for e in t])
    async with _client() as c:
        out = (
            await c.get(f"{API}/sorted-this-week", params={"project_id": p["id"]})
        ).json()
    assert out["total"] == 0
    assert space.SORTED_DAYS == 7


# --- AL-1 --------------------------------------------------------------------------------------------------------


async def test_lane_counts_are_the_lane_badges():
    async with _client() as c:
        p = await _create_project(c)
        pid = p["id"]
        ids = []
        for status in ("todo", "todo", "in-progress", "done", "wont_do"):
            r = await c.post(
                f"/projects/{pid}/tickets", json={"title": "T", "status": status}
            )
            assert r.status_code == 201, r.text
            ids.append(r.json()["id"])
    # a pending ticket is not in the lane's count (the badge leaves it out)
    async with test_async_session() as s:
        row = await s.get(Ticket, ids[0])
        row.pending = True
        s.add(row)
        await s.commit()
    async with _client() as c:
        lanes = (await c.get(f"/projects/{pid}/tickets/counts")).json()["lanes"]
        empty = (await c.get("/projects/nope/tickets/counts")).json()
    assert {x["status"]: x["count"] for x in lanes} == {
        "todo": 1,
        "in-progress": 1,
        "done": 1,
    }
    assert empty == {"lanes": []}
