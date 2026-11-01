"""Deleting a project takes everything in it along: tickets, members, AI members, docs and their versions, chats and
their messages. Another project is left alone."""

from sqlalchemy import text

from models import AiChat, AiChatMessage, DocsPage, DocsVersion
from tests.test_ai import _runner, _ticket, env  # noqa: F401


async def _count(env, sql: str, **params) -> int:
    async with env["maker"]() as s:
        return (await s.execute(text(sql), params)).scalar() or 0


async def _new_project(c, name: str, prefix: str) -> str:
    p = (
        await c.post(
            "/projects", json={"name": name, "prefix": prefix, "color": "#2E6F40"}
        )
    ).json()
    await c.post(f"/projects/{p['id']}/members", json={"name": "An Nguyen"})
    return p["id"]


async def _fill(env, c, name: str, prefix: str):
    """A project with tickets (one a sub-ticket), an AI member, a docs page with a version and a chat with a message."""
    pid = await _new_project(c, name, prefix)
    await _runner(c, pid, env["repo"], name=name)
    parent = await _ticket(c, pid, title=f"{name} parent")
    await _ticket(c, pid, title=f"{name} child", parent_id=parent)
    async with env["maker"]() as s:
        page = DocsPage(project_id=pid, title=f"{name} page", slug=f"{name}-page")
        s.add(page)
        await s.commit()
        s.add(DocsVersion(page_id=page.id, version=1, title="v1"))
        chat = AiChat(project_id=pid, owner="An Nguyen")
        s.add(chat)
        await s.commit()
        s.add(AiChatMessage(chat_id=chat.id, role="user", text="hi"))
        await s.commit()
        return pid, page.id, chat.id


async def test_a_project_goes_with_all_it_holds_and_the_other_stays(env):
    c = env["c"]
    gone, page, chat = await _fill(env, c, "Gone", "GON")
    kept, kept_page, kept_chat = await _fill(env, c, "Kept", "KEP")

    r = await c.delete(f"/projects/{gone}")
    assert r.status_code == 204, r.text

    for table in ("ticket", "member", "ai_member", "docs_page", "ai_chat"):
        assert (
            await _count(
                env, f"SELECT COUNT(*) FROM {table} WHERE project_id = :p", p=gone
            )
            == 0
        ), table
    assert await _count(env, "SELECT COUNT(*) FROM project WHERE id = :p", p=gone) == 0
    assert (
        await _count(
            env, "SELECT COUNT(*) FROM docs_version WHERE page_id = :p", p=page
        )
        == 0
    )
    assert (
        await _count(
            env, "SELECT COUNT(*) FROM ai_chat_message WHERE chat_id = :p", p=chat
        )
        == 0
    )

    # the other project is whole
    assert (
        await _count(env, "SELECT COUNT(*) FROM ticket WHERE project_id = :p", p=kept)
        == 2
    )
    assert (
        await _count(
            env, "SELECT COUNT(*) FROM docs_version WHERE page_id = :p", p=kept_page
        )
        == 1
    )
    assert (
        await _count(
            env, "SELECT COUNT(*) FROM ai_chat_message WHERE chat_id = :p", p=kept_chat
        )
        == 1
    )
    assert (await c.get(f"/projects/{kept}/tickets")).status_code == 200
    assert (await c.delete(f"/projects/{gone}")).status_code == 404
