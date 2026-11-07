"""Board AI on the assistant engine (AI v2 stage 7): the chat is one Claude Code conversation per chat, editors
get a held result to accept, board health keeps insights, and the old draft routes answer 410."""

import asyncio
import json

import pytest

from tests.ai_helpers import _project, _runner, _ticket, env  # noqa: F401


@pytest.fixture(autouse=True)
def _assistant(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "assistant")


async def _board(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    return c, pid


async def _answer(c, message, timeout=15.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        m = (await c.get(f"/ai/assist/messages/{message['id']}")).json()
        if m["state"] not in ("queued", "thinking", "streaming"):
            return m
        assert asyncio.get_running_loop().time() < deadline, m
        await asyncio.sleep(0.05)


async def _draft(c, draft, timeout=15.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        d = (await c.get(f"/ai/assist/drafts/{draft['id']}")).json()
        if d["status"] != "pending":
            return d
        assert asyncio.get_running_loop().time() < deadline, d
        await asyncio.sleep(0.05)


async def test_a_chat_turn_answers_and_resumes_the_conversation(env, monkeypatch):
    c, pid = await _board(env)
    record = env["tmp"] / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(record))
    monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_TEXT", "Two tickets are open.")
    state = (await c.get(f"/projects/{pid}/ai/assist")).json()
    assert state["board_ai"]["state"] == "ready" and state["ticket_count"] == 0
    chat = await c.post(f"/projects/{pid}/ai/assist/chats", json={"scope": "project"})
    assert chat.status_code == 201, chat.text
    cid = chat.json()["id"]
    r = await c.post(f"/ai/assist/chats/{cid}/messages", json={"text": "What is open?"})
    assert r.status_code == 200, r.text
    assert (
        r.json()["user"]["text"] == "What is open?"
        and r.json()["ai"]["state"] == "thinking"
    )
    m = await _answer(c, r.json()["ai"])
    assert (
        m["state"] == "done"
        and m["text"] == "Two tickets are open."
        and m["cost"] == 0.02
        and m["tokens_in"] == 200
    )
    first = json.loads(record.read_text().splitlines()[-1])
    assert (
        "kanban-assistant:board-ask" in first["prompt"]
        and "question: What is open?" in first["prompt"]
    )
    assert (
        "--json-schema" not in first["args"]
        and first["args"][first["args"].index("--name") + 1] == f"chat:{cid}"
    )
    m2 = await _answer(
        c,
        (
            await c.post(
                f"/ai/assist/chats/{cid}/messages", json={"text": "And blocked?"}
            )
        ).json()["ai"],
    )
    assert m2["state"] == "done"
    assert "--resume" in json.loads(record.read_text().splitlines()[-1])["args"]
    detail = (await c.get(f"/ai/assist/chats/{cid}")).json()
    assert [x["role"] for x in detail["messages"]] == ["user", "ai", "user", "ai"]
    assert (
        detail["title"] == "What is open?"
        and detail["cost"] == 0.04
        and detail["drafts"] == []
    )
    listed = (await c.get(f"/projects/{pid}/ai/assist/chats")).json()
    assert listed["count"] == 1 and listed["month_cost"] == 0.04
    fb = await c.post(f"/ai/assist/messages/{m['id']}/feedback", json={"thumb": "up"})
    assert fb.json()["feedback"]["thumb"] == "up"
    again = await c.post(f"/ai/assist/messages/{m['id']}/retry", json={})
    assert (
        again.status_code == 200 and (await _answer(c, again.json()))["state"] == "done"
    )
    assert (await c.delete(f"/ai/assist/chats/{cid}")).status_code == 204
    assert (await c.get(f"/ai/assist/chats/{cid}")).status_code == 404


async def test_a_ticket_chat_answer_is_posted_as_a_comment_and_stop_works(
    env, monkeypatch
):
    c, pid = await _board(env)
    tid = await _ticket(c, pid)
    scope = (await c.get(f"/ai/scopes/ticket/{tid}")).json()
    assert (
        scope["availability"]["code"] == "ok"
        and scope["scope"]["project_id"] == pid
        and scope["chat_id"] is None
    )
    chat = (await c.post(f"/ai/scopes/ticket/{tid}/chat", json={})).json()
    assert chat["scope"] == "ticket" and chat["ticket_id"] == tid
    assert (await c.post(f"/ai/scopes/ticket/{tid}/chat", json={})).json()[
        "id"
    ] == chat["id"]
    assert (await c.post(f"/ai/scopes/ticket/{tid}/chat", json={"fresh": True})).json()[
        "id"
    ] != chat["id"]
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_TEXT", "add() subtracts: fix the operator."
    )
    m = await _answer(
        c,
        (
            await c.post(
                f"/ai/assist/chats/{chat['id']}/messages",
                json={"text": "What is wrong?"},
            )
        ).json()["ai"],
    )
    assert m["state"] == "done"
    posted = await c.post(f"/ai/assist/messages/{m['id']}/post-comment", json={})
    assert posted.status_code == 200, posted.text
    comments = (await c.get(f"/tickets/{tid}")).json()["comments"]
    assert (
        comments[-1]["text"] == "add() subtracts: fix the operator."
        and comments[-1]["id"] == posted.json()["comment_id"]
    )
    monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_WAIT", "20")
    slow = (
        await c.post(
            f"/ai/assist/chats/{chat['id']}/messages", json={"text": "Take your time"}
        )
    ).json()["ai"]
    busy = await c.post(
        f"/ai/assist/chats/{chat['id']}/messages", json={"text": "Again"}
    )
    assert busy.status_code == 409 and busy.json()["code"] == "conflict"
    await asyncio.sleep(0.5)
    assert (await c.post(f"/ai/assist/messages/{slow['id']}/stop")).json()[
        "state"
    ] == "stopped"
    await asyncio.sleep(0.5)
    assert (await c.get(f"/ai/assist/messages/{slow['id']}")).json()[
        "state"
    ] == "stopped"
    assert (
        await c.get(f"/tickets/{tid}/ai/estimate", params={"member_id": "nope"})
    ).status_code == 404


async def test_an_editor_result_is_held_until_accepted(env, monkeypatch):
    c, pid = await _board(env)
    tid = await _ticket(c, pid)
    st = (
        await c.get(
            f"/projects/{pid}/ai/editor/state",
            params={"surface": "ticket_description", "ticket_id": tid},
        )
    ).json()
    assert (
        st["availability"]["code"] == "ok"
        and [a["action"] for a in st["bar"]][0] == "improve"
    )
    body = {
        "surface": "ticket_description",
        "action": "improve",
        "selection": "add is brokn",
        "ticket_id": tid,
    }
    pre = (await c.post(f"/projects/{pid}/ai/editor/preview", json=body)).json()
    assert [p["kind"] for p in pre["pieces"]] == ["instruction", "selection", "ticket"]
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON", json.dumps({"text": "add() is broken."})
    )
    r = await c.post(f"/projects/{pid}/ai/editor/drafts", json=body)
    assert (
        r.status_code == 201
        and r.json()["status"] == "pending"
        and r.json()["kind"] == "editor"
    )
    d = await _draft(c, r.json())
    assert d["status"] == "open" and d["payload"]["result"] == {
        "kind": "replace",
        "cut_short": False,
        "text": "add() is broken.",
    }
    acc = await c.post(f"/ai/editor/drafts/{d['id']}/accept", json={})
    assert acc.status_code == 200 and acc.json()["draft"]["status"] == "applied"
    assert (
        await c.post(f"/ai/editor/drafts/{d['id']}/accept", json={})
    ).status_code == 409
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        json.dumps({"text": "- add(2, 3) returns 5\n- add(-1, 1) returns 0"}),
    )
    crit = await _draft(
        c,
        (
            await c.post(
                f"/projects/{pid}/ai/editor/drafts",
                json={**body, "action": "criteria", "selection": ""},
            )
        ).json(),
    )
    assert crit["payload"]["result"]["items"] == [
        "add(2, 3) returns 5",
        "add(-1, 1) returns 0",
    ]
    out = (
        await c.post(
            f"/ai/editor/drafts/{crit['id']}/accept",
            json={"items": ["add(2, 3) returns 5"]},
        )
    ).json()
    assert out["created"] == ["add(2, 3) returns 5"]
    assert [
        x["text"]
        for x in (await c.get(f"/tickets/{tid}")).json()["acceptance_criteria"]
    ] == ["add(2, 3) returns 5"]
    bad = await c.post(
        f"/projects/{pid}/ai/editor/drafts", json={**body, "selection": ""}
    )
    assert bad.status_code == 422
    third = await _draft(
        c, (await c.post(f"/projects/{pid}/ai/editor/drafts", json=body)).json()
    )
    assert (await c.post(f"/ai/assist/drafts/{third['id']}/discard")).json()[
        "status"
    ] == "discarded"


async def test_board_health_keeps_insights(env, monkeypatch):
    c, pid = await _board(env)
    tid = await _ticket(c, pid)
    insight = {
        "kind": "stuck",
        "ticket_id": tid,
        "title": f"{tid} has not moved for 6 days",
        "detail": "In todo since Monday.",
        "score": 80,
    }
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        json.dumps({"insights": [insight], "summary": "One ticket is stuck."}),
    )
    panel = await c.post(f"/projects/{pid}/ai/assist/health/run")
    assert panel.status_code == 200, panel.text
    p = panel.json()
    assert (
        len(p["needs_action"]) == 1
        and p["unseen"] == 1
        and p["digest"]["text"] == "One ticket is stuck."
    )
    iid = p["needs_action"][0]["id"]
    assert (await c.get(f"/projects/{pid}/ai/assist/chips")).json()[0][
        "ticket_id"
    ] == tid
    again = (await c.post(f"/projects/{pid}/ai/assist/health/run")).json()
    assert [i["id"] for i in again["needs_action"]] == [iid]
    assert (await c.post(f"/projects/{pid}/ai/assist/health/seen")).json() == {
        "ok": True
    }
    assert (await c.get(f"/projects/{pid}/ai/assist/health")).json()["unseen"] == 0
    assert (
        await c.post(f"/ai/assist/insights/{iid}/snooze", json={"hours": 2})
    ).json()["state"] == "snoozed"
    assert (await c.post(f"/ai/assist/insights/{iid}/restore", json={})).json()[
        "state"
    ] == "open"
    assert (await c.post(f"/ai/assist/insights/{iid}/act", json={})).status_code == 410
    monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_JSON", json.dumps({"insights": []}))
    assert (await c.post(f"/projects/{pid}/ai/assist/health/run")).json()[
        "needs_action"
    ] == []


async def test_draft_routes_are_gone_and_lists_are_empty(env):
    c, pid = await _board(env)
    tid = await _ticket(c, pid)
    assert (
        await c.post(
            f"/projects/{pid}/ai/assist/drafts",
            json={"kind": "split", "ticket_id": tid},
        )
    ).status_code == 410
    for action in ("apply", "undo", "request-apply"):
        assert (
            await c.post(f"/ai/assist/drafts/d1/{action}", json={})
        ).status_code == 410
    assert (
        await c.patch("/ai/assist/drafts/d1", json={"payload": {}})
    ).status_code == 410
    assert (await c.get("/ai/assist/drafts/d1")).status_code == 404
    assert (await c.get(f"/tickets/{tid}/ai/assist/drafts")).json() == []
    assert (await c.get(f"/projects/{pid}/ai/assist/drafts")).json() == []
    assert (
        await c.get(f"/projects/{pid}/ai/assist/similar", params={"text": "add"})
    ).json() == []
    assert (
        await c.get(f"/projects/{pid}/ai/assist/assignees", params={"text": "add"})
    ).json() == []
    assert (await c.get(f"/tickets/{tid}/ai/assist/coverage")).json() == {
        "coverage": [],
        "covered": 0,
        "total": 0,
    }
    patched = await c.patch(
        f"/projects/{pid}/ai/assist",
        json={"tone": "concise", "features": {"chat": False}},
    )
    assert patched.status_code == 200 and patched.json()["tone"] == "concise"
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={})).json()
    off = await c.post(f"/ai/assist/chats/{chat['id']}/messages", json={"text": "Hi"})
    assert off.status_code == 409 and off.json()["code"] == "feature_off"


async def test_the_sketch_chat_reads_the_picture_and_offers_ideas(env, monkeypatch):
    c, pid = await _board(env)
    st = (
        await c.get(
            "/ai/sketch/state",
            params={"owner_kind": "ticket", "owner_id": "x", "project_id": pid},
        )
    ).json()
    assert st["availability"]["code"] == "ok" and st["limits"]["max_prompt"] == 2000
    chat = (
        await c.post(
            f"/projects/{pid}/ai/assist/chats",
            json={"scope": "sketch", "scope_id": "sk_1"},
        )
    ).json()
    record = env["tmp"] / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(record))
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        json.dumps({"answer": "A login flow.", "ideas": ["Add an error state"]}),
    )
    r = await c.post(
        f"/ai/sketch/chats/{chat['id']}/messages",
        data={
            "text": "What is this?",
            "width": "800",
            "height": "600",
            "title": "Login",
        },
        files={"image": ("canvas.png", b"\x89PNG\r\n", "image/png")},
    )
    assert r.status_code == 200, r.text
    m = await _answer(c, r.json()["ai"])
    assert m["state"] == "done" and m["text"] == "A login flow.", m
    assert (
        m["draft"]["payload"]["result"]["ideas"] == ["Add an error state"]
        and m["draft"]["status"] == "open"
    )
    sent = json.loads(record.read_text().splitlines()[-1])
    assert (
        "kanban-assistant:sketch-ask" in sent["prompt"]
        and "canvas.png" in sent["prompt"]
        and "--add-dir" in sent["args"]
    )
    run_id = m["context"]["run"]["id"]
    pic = await c.get(f"/ai/sketch/chats/{chat['id']}/files/{run_id}/canvas.png")
    assert pic.status_code == 200 and pic.content.startswith(b"\x89PNG")
    assert (
        await c.get(f"/ai/sketch/chats/{chat['id']}/files/{run_id}/system.md")
    ).status_code == 404
    added = (
        await c.post(f"/ai/sketch/drafts/{m['draft_id']}/idea", json={"index": 0})
    ).json()
    assert added["payload"]["result"]["added"] == [0]
    assert (await c.post(f"/ai/sketch/drafts/{m['draft_id']}/accept")).json()[
        "status"
    ] == "applied"


async def test_a_schedule_dry_run_is_a_plan_from_the_assistant(env, monkeypatch):
    c, pid = await _board(env)
    tid = await _ticket(c, pid)
    team = (await c.get(f"/projects/{pid}/ai/teams")).json()[0]
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        json.dumps({"text": "1) Fix the operator in calc.py."}),
    )
    r = await c.post(
        f"/projects/{pid}/ai/schedules/dry-run",
        json={"ticket_id": tid, "member_id": team["id"]},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "text": "1) Fix the operator in calc.py.",
        "member_name": team["name"],
        "cost": 0.02,
        "metered": False,
    }
    assert (
        await c.post(
            f"/projects/{pid}/ai/schedules/dry-run",
            json={"ticket_id": "nope", "member_id": team["id"]},
        )
    ).status_code in (404, 422)
