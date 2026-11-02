"""The Board AI manages the team for the person (D20, D24): it creates the pieces of a split ticket, messages the AI
working on a ticket, and hands long coordination to the PM, each by tier and with its Undo."""

import json

import pytest

from services.ai.assist import prompts, tiers
from tests.test_ai import FAKE, _project, _ticket, _wait, env  # noqa: F401
from tests.test_ai_assist import H, _answer, _setup, fake  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _block(*changes) -> str:
    return (
        "Done.\n\n```kanban-actions\n"
        + json.dumps({"changes": list(changes)})
        + "\n```"
    )


def test_new_tickets_are_checked_and_count_toward_a_bulk_action():
    tickets = {"KAN-1": {"status": "todo"}}
    out, problems = prompts.check_changes(
        [
            {
                "op": "create",
                "title": "  Login   page ",
                "parent": "kan-1",
                "criteria": ["a", ""],
            },
            {"op": "create", "title": ""},
            {"op": "create", "title": "Orphan", "parent": "KAN-9"},
            {"op": "message", "ticket": "KAN-1", "text": ""},
            {"op": "delegate", "ticket": "KAN-1", "text": "Split and run it"},
        ],
        tickets,
        {},
    )
    assert out[0] == {
        "op": "create",
        "title": "Login page",
        "description": "",
        "parent": "KAN-1",
        "criteria": ["a"],
        "workflow": None,
    }
    assert out[1] == {"op": "delegate", "ticket": "KAN-1", "text": "Split and run it"}
    assert len(problems) == 3
    four = [{"op": "create", "title": f"Piece {i}"} for i in range(4)]
    assert tiers.decide(four)["act"] is False
    assert tiers.decide(four[:3])["act"] is True
    assert tiers.tier_of({"op": "message", "ticket": "KAN-1"}) == tiers.FREE


async def test_the_board_ai_splits_a_ticket_and_undo_deletes_the_untouched_pieces(
    env, fake
):
    c, pid, an, m = await _setup(env, acts=True)
    parent = await _ticket(c, pid, title="Login and export", status="todo")
    fake.queue.append(
        _block(
            {
                "op": "create",
                "title": "Login page",
                "parent": parent,
                "criteria": ["A person signs in with a password"],
            },
            {"op": "create", "title": "Export", "parent": parent},
        )
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Split it in two")
    assert msg["draft"]["status"] == "applied", msg["draft"]
    tickets = (await c.get(f"/projects/{pid}/tickets")).json()
    kids = [t for t in tickets if t.get("parent_id") == parent]
    assert sorted(t["title"] for t in kids) == ["Export", "Login page"]
    login = next(t for t in kids if t["title"] == "Login page")
    assert (await c.get(f"/tickets/{login['id']}")).json()["acceptance_criteria"]
    r = await c.post(f"/ai/assist/drafts/{msg['draft']['id']}/undo", headers=H)
    assert r.status_code == 200, r.text
    left = (await c.get(f"/projects/{pid}/tickets")).json()
    assert not [t for t in left if t.get("parent_id") == parent]


async def test_the_board_ai_messages_the_ai_working_on_a_ticket(env, fake, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    c, pid, an, m = await _setup(env, acts=True)
    tid = await _ticket(c, pid, title="Fix it", status="todo")
    r = await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    assert r.status_code == 200, r.text
    await _wait(c, tid, ("running",))
    fake.queue.append(
        _block({"op": "message", "ticket": tid, "text": "Use the new API"})
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Tell it to use the new API")
    assert msg["draft"]["status"] == "applied", msg["draft"]
    run = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
    detail = (await c.get(f"/ai/runs/{run['id']}")).json()
    assert any("Use the new API" in (s.get("text") or "") for s in detail["steps"])
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


async def test_delegate_starts_the_pm_on_the_ticket(env, fake):
    c, pid, an, m = await _setup(env, acts=True)
    pm = (
        await c.post(
            f"/projects/{pid}/ai/packs/pm/member",
            json={"name": "PM", "working_dir": env["repo"]},
        )
    ).json()
    await c.patch(f"/ai/members/{pm['id']}", json={"cli_path": FAKE, "model": "haiku"})
    tid = await _ticket(c, pid, title="The export epic", status="todo")
    fake.queue.append(
        _block({"op": "delegate", "ticket": tid, "text": "Run this one to the end"})
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Have the PM run it")
    assert msg["draft"]["status"] == "applied", msg["draft"]
    runs_ = (await c.get(f"/tickets/{tid}/ai/runs")).json()
    assert runs_[0]["member_id"] == pm["id"]
    assert "Run this one to the end" in (runs_[0].get("instruction") or "")
