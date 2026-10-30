"""One Claude Code session for each (page, AI member): Ask, a tag in a thread, a suggested edit, a summary and the
chat about the page all continue the same conversation; other members, other pages and calls without a page do
not; a page hidden from AI is never resumed; the prompt names who is asking."""

import pytest
from sqlmodel import select

import database
from models import DocsAiSession
from services.docs_ai import sessions
from tests.docs_ai_helpers import H, env, fake, page, setup  # noqa: F401
from tests.test_ai import _runner
from tests.test_docs_ai_ask import ask, reply
from tests.test_docs_ai_threads import TEXT, _mention, _thread, _wait


@pytest.fixture(autouse=True)
def cli_has_every_session(monkeypatch):
    """The fake CLI writes no session files: pretend the CLI still has any session."""
    monkeypatch.setattr(sessions, "session_exists", lambda _sid: True)


async def _rows(pid):
    async with database.async_session() as s:
        return (
            await s.exec(select(DocsAiSession).where(DocsAiSession.project_id == pid))
        ).all()


async def test_every_kind_of_call_on_a_page_continues_one_session(env, fake):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    # a tag in a thread
    fake.queue.append("Not enforced.\nVERDICT: OUT_OF_DATE")
    t = await _thread(c, p["id"], f"{_mention(m)} still true?")
    await _wait(c, t["ai_delivery"][0]["job_id"])
    # Ask this page
    fake.queue.append(
        reply(answer="Tokens last 30 days.", citations=[], verdict="not_covered")
    )
    await ask(c, pid, "How long do tokens last?", scope="page", page_id=p["id"])
    # a summary
    fake.queue.append("A short summary.")
    r = await c.post(f"/docs/pages/{p['id']}/ai/summary", headers=H)
    assert r.status_code == 202
    await _wait(c, r.json()["id"])
    # a suggested edit
    th = (await c.get(f"/docs/pages/{p['id']}/comments", headers=H)).json()["threads"][
        0
    ]
    fake.queue.append(
        '{"title": "T", "reason": "r", "old": "Rate limits are not enforced yet.", "new": "Rate limits are on."}'
    )
    r = await c.post(
        f"/docs/ai/threads/{t['id']}/suggest-edit",
        json={"comment_id": th["comments"][-1]["id"]},
        headers=H,
    )
    await _wait(c, r.json()["id"])
    used = [x for x in fake.sessions if x is not None]
    assert len(used) == 4
    assert [x.resume for x in used] == [False, True, True, True]
    assert len({x.id for x in used}) == 1
    rows = await _rows(pid)
    assert len(rows) == 1 and rows[0].calls == 4
    assert (
        rows[0].scope == sessions.page_scope(p["id"]) and rows[0].member_id == m["id"]
    )


async def test_the_prompt_names_who_is_asking(env, fake):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    fake.queue.append(reply(answer="x", citations=[], verdict="not_covered"))
    await ask(c, pid, "How long do tokens last?", scope="page", page_id=p["id"])
    assert fake.prompts[-1].startswith("An Nguyen is asking.")


async def test_another_member_and_another_page_have_their_own_session(env, fake):
    c, pid, m = await setup(env)
    other = await _runner(c, pid, env["repo"], name="Dev")
    a = await page(c, pid, "API", TEXT)
    b = await page(c, pid, "Guide", "## Start\n\nTokens last 30 days.\n")
    for page_id, mention in ((a["id"], m), (a["id"], other), (b["id"], m)):
        fake.queue.append("Ok.\nVERDICT: OK")
        t = await _thread(c, page_id, f"{_mention(mention)} hi")
        await _wait(c, t["ai_delivery"][0]["job_id"])
    used = [x for x in fake.sessions if x is not None]
    assert len({x.id for x in used}) == 3 and not any(x.resume for x in used)
    assert len(await _rows(pid)) == 3


async def test_a_question_about_the_whole_space_has_no_page_session(env, fake):
    c, pid, m = await setup(env)
    await page(c, pid, "API", TEXT)
    fake.queue.append(reply(answer="x", citations=[], verdict="answer"))
    await ask(c, pid, "How long do tokens last?")
    assert await _rows(pid) == []


async def test_a_page_hidden_from_ai_is_never_resumed(env, fake):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    fake.queue.append("Ok.\nVERDICT: OK")
    t = await _thread(c, p["id"], f"{_mention(m)} hi")
    await _wait(c, t["ai_delivery"][0]["job_id"])
    assert len(await _rows(pid)) == 1
    await c.patch(f"/docs/pages/{p['id']}/ai", json={"hidden": True}, headers=H)
    from services.docs_ai import engine

    assert await engine._session_scope(None, p["id"]) is None  # noqa: SLF001
    assert await _rows(pid) == []


async def test_a_session_the_cli_lost_is_replaced(env, fake, monkeypatch):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    fake.queue.append("Ok.\nVERDICT: OK")
    t = await _thread(c, p["id"], f"{_mention(m)} hi")
    await _wait(c, t["ai_delivery"][0]["job_id"])
    first = [x for x in fake.sessions if x is not None][0].id
    monkeypatch.setattr(sessions, "session_exists", lambda _sid: False)
    fake.queue.append("Ok.\nVERDICT: OK")
    r = await c.post(
        f"/docs/comments/threads/{t['id']}/replies",
        json={"body": f"again {_mention(m)}"},
        headers=H,
    )
    await _wait(c, r.json()["ai_delivery"][0]["job_id"])
    second = [x for x in fake.sessions if x is not None][-1]
    assert second.resume is False and second.id != first
    assert (await _rows(pid))[0].session_id == second.id


async def test_the_background_freshness_check_does_not_join_the_conversation(env):
    from services.docs_ai import engine

    assert "freshness" in engine.BACKGROUND_KINDS


async def test_the_chat_about_a_page_joins_the_pages_session(env, fake):
    from tests.test_ai_assist import _answer

    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    fake.queue.append("Ok.\nVERDICT: OK")
    t = await _thread(c, p["id"], f"{_mention(m)} hi")
    await _wait(c, t["ai_delivery"][0]["job_id"])
    thread_session = [x for x in fake.sessions if x is not None][-1]
    r = await c.post(
        f"/projects/{pid}/ai/assist/chats",
        json={"scope": "doc", "doc_id": p["id"]},
        headers=H,
    )
    assert r.status_code == 201, r.text
    fake.queue.append("The limits are not enforced.")
    msg = await _answer(c, r.json()["id"], "What about limits?")
    assert msg["state"] == "done", msg
    chat_session = fake.sessions[-1]
    assert chat_session.resume is True and chat_session.id == thread_session.id
    assert fake.prompts[-1].startswith("An Nguyen is asking.")
    assert (await _rows(pid))[0].calls == 2
