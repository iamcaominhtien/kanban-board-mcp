"""Cross-feature rules of Docs AI: what an AI member may create, and cleaning up after a purged page."""

import json

from sqlmodel import select

from models import DocsAiCheck, DocsAiProposal, DocsDraft, DocsPage
from services.ai import guard
from tests.docs_ai_helpers import H, env, fake, page, setup  # noqa: F401


async def test_a_page_an_ai_member_creates_is_never_published(env):
    from kanban_mcp.tools import docs_write
    from tests.test_ai import _ctx

    ctx, pid, an, m, tid = await _ctx(env, template="custom")
    c = env["c"]
    await c.patch(f"/projects/{pid}/docs/ai", json={"enabled": True})
    tokens = guard.enter(ctx)
    try:
        out = await docs_write(
            action="create",
            project_id=pid,
            title="From the AI",
            markdown="## Hi\n\nText",
        )
    finally:
        guard.leave(tokens)
    assert out["version"] == 0 and out["status"] == "draft"
    async with env["maker"]() as s:
        p = await s.get(DocsPage, out["id"])
        assert p.version == 0 and p.created_by == "An Nguyen"
        draft = (await s.exec(select(DocsDraft).where(DocsDraft.page_id == p.id))).one()
        assert draft.author == "An Nguyen"
        assert json.loads(draft.ai_source)["member_id"] == m["id"]
    # other people do not see it as a published page
    tree = (
        await c.get(f"/projects/{pid}/docs/tree", headers={"X-Actor": "user"})
    ).json()
    assert [n for n in tree if n["id"] == out["id"]][0]["version"] == 0


async def test_with_docs_ai_off_an_ai_member_creates_a_published_page_as_before(env):
    from kanban_mcp.tools import docs_write
    from tests.test_ai import _ctx

    ctx, pid, an, m, tid = await _ctx(env, template="custom")
    tokens = guard.enter(ctx)
    try:
        out = await docs_write(
            action="create", project_id=pid, title="Old way", markdown="## Hi"
        )
    finally:
        guard.leave(tokens)
    assert out["version"] == 1


async def test_purging_a_page_removes_its_docs_ai_rows(env):
    c, pid, member = await setup(env)
    p = await page(c, pid, "Auth", "## Rotation\n\nText")
    async with env["maker"]() as s:
        s.add(DocsAiCheck(page_id=p["id"], project_id=pid, state="stale"))
        s.add(
            DocsAiProposal(
                project_id=pid, page_id=p["id"], member_id=member["id"], changes="[]"
            )
        )
        await s.commit()
    assert (await c.delete(f"/docs/pages/{p['id']}", headers=H)).status_code == 200
    assert (
        await c.delete(f"/docs/pages/{p['id']}/purge", headers={"X-Actor": "user"})
    ).status_code == 204
    async with env["maker"]() as s:
        assert (await s.exec(select(DocsAiCheck))).all() == []
        assert (await s.exec(select(DocsAiProposal))).all() == []
