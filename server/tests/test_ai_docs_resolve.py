"""An AI member that resolves a Docs comment thread says what it did first."""

import pytest

from services.ai import guard
from tests.test_ai import _ctx, env  # noqa: F401
from tests.test_docs_comments import DOC, inline, publish


async def test_an_ai_replies_in_a_thread_before_it_resolves_it(env):
    from kanban_mcp.tools.docs import docs_write

    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    page = (await c.post(f"/projects/{pid}/docs/pages", json={"title": "API"})).json()
    await publish(c, page["id"], DOC)
    thread = await inline(c, page)

    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="Reply in this thread first"):
            await docs_write(action="resolve", thread_id=thread["id"])
        await docs_write(
            action="reply", thread_id=thread["id"], body="Fixed in v2: added rotation."
        )
        out = await docs_write(action="resolve", thread_id=thread["id"])
    finally:
        guard.leave(tokens)
    assert out["status"] == "resolved" and out["resolved_by"] == m["name"]
    # a person resolving their own thread is not asked to reply
    other = await inline(c, page, quote="rotation", body="And rotation?")
    r = await c.post(f"/docs/comments/threads/{other['id']}/resolve")
    assert r.status_code == 200
