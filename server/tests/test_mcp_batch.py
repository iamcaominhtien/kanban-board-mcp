"""Many calls in one: `items` on ticket_items and docs_write runs them in order, each as a call of its own."""

import pytest

from kanban_mcp.tools.docs import docs_write
from kanban_mcp.tools.items import ticket_items
from tests.ai_helpers import _ctx, env  # noqa: F401
from tests.test_docs_comments import DOC, inline, publish


async def _page_with_threads(c, pid, n=3):
    page = (await c.post(f"/projects/{pid}/docs/pages", json={"title": "API"})).json()
    await publish(c, page["id"], DOC)
    quotes = ["bearer token", "rotation", "Every route"]
    return page, [await inline(c, page, quote=q) for q in quotes[:n]]


async def test_test_cases_are_added_in_order_and_a_bad_one_does_not_stop_the_rest(env):
    c = env["c"]
    _, pid, an, m, tid = await _ctx(env)
    out = await ticket_items(
        ticket_id=tid,
        item="test_case",
        action="add",
        items=[
            {"title": "First"},
            {"status": "pass"},  # no title
            {"title": "Third", "status": "pass", "proof": "log"},
        ],
    )
    assert (out["done"], out["failed"]) == (2, 1)
    assert [r["ok"] for r in out["results"]] == [True, False, True]
    assert "title" in out["results"][1]["error"]
    # the ticket comes back once, with both test cases in order
    titles = [t["title"] for t in out["ticket"]["test_cases"]]
    assert titles == ["First", "Third"]
    got = (await c.get(f"/tickets/{tid}")).json()
    assert [t["title"] for t in got["test_cases"]] == ["First", "Third"]


async def test_comments_replies_and_resolves_in_one_call_each(env):
    c = env["c"]
    _, pid, an, m, tid = await _ctx(env)
    page, threads = await _page_with_threads(c, pid, 2)
    made = await docs_write(
        action="comment",
        page_id=page["id"],
        items=[
            {"body": "One", "quote": "Every route"},
            {"body": "Two", "quote": "rotation"},
            {"body": "Three", "quote": "not in the page"},
        ],
    )
    assert (made["done"], made["failed"]) == (2, 1)
    assert "not in the published page" in made["results"][2]["error"]
    ids = [t["id"] for t in threads]
    replied = await docs_write(
        action="reply",
        items=[{"thread_id": i, "body": "Fixed in v2"} for i in ids],
    )
    assert replied["done"] == 2
    resolved = await docs_write(action="resolve", items=[{"thread_id": i} for i in ids])
    assert resolved["done"] == 2
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"]
    status = {t["id"]: t["status"] for t in listed}
    assert all(status[i] == "resolved" for i in ids)


async def test_only_light_actions_take_items_and_a_batch_has_a_size_limit(env):
    _, pid, an, m, tid = await _ctx(env)
    with pytest.raises(ValueError, match="items only works with"):
        await docs_write(action="delete", page_id="x", items=[{}])
    with pytest.raises(ValueError, match="at most 25"):
        await ticket_items(
            ticket_id=tid,
            item="test_case",
            action="add",
            items=[{"title": f"T{i}"} for i in range(26)],
        )
    with pytest.raises(ValueError, match="non-empty list"):
        await ticket_items(ticket_id=tid, item="test_case", action="add", items=[])
    # without items nothing changes
    one = await ticket_items(
        ticket_id=tid, item="test_case", action="add", title="Solo"
    )
    assert [t["title"] for t in one["test_cases"]] == ["Solo"]
