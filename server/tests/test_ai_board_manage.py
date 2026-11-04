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
        "type": "task",
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


def test_a_new_ticket_takes_a_type_and_a_story_no_parent_or_workflow():
    tickets = {"KAN-1": {"status": "todo"}}
    out, problems = prompts.check_changes(
        [
            {"op": "create", "title": "Crash on save", "type": "Bug"},
            {
                "op": "create",
                "title": "Learn code graphs",
                "type": "story",
                "workflow": "research",
            },
            {"op": "create", "title": "Nested", "type": "story", "parent": "KAN-1"},
            {"op": "create", "title": "Odd", "type": "epic"},
        ],
        tickets,
        {},
    )
    assert [(c["title"], c["type"], c["workflow"]) for c in out] == [
        ("Crash on save", "bug", None),
        ("Learn code graphs", "story", None),  # the PM plans a Story: no workflow
    ]
    assert len(problems) == 2
    assert any("cannot have a parent" in p for p in problems)
    assert any("'epic'" in p for p in problems)


async def test_the_board_ai_makes_a_story_as_a_draft_and_undo_removes_it(env, fake):
    c, pid, an, m = await _setup(env, acts=True)
    fake.queue.append(
        _block(
            {
                "op": "create",
                "title": "Learn code knowledge graphs",
                "type": "story",
                "description": "As a builder, I want to understand the stack, so that I can rebuild it.",
                "criteria": ["Each part of the stack is explained with a source"],
            }
        )
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Make a user story for it")
    assert msg["draft"]["status"] == "applied", msg["draft"]
    sid = msg["draft"]["result"]["applied"][0]["created"]
    ticket = (await c.get(f"/tickets/{sid}")).json()
    assert ticket["type"] == "story" and ticket["status"] == "backlog"
    assert ticket["acceptance_criteria"]
    story = (await c.get(f"/stories/{sid}")).json()
    assert story["state"] == "draft"  # the person hands it to the PM on its page
    r = await c.post(f"/ai/assist/drafts/{msg['draft']['id']}/undo", headers=H)
    assert r.status_code == 200, r.text
    assert (await c.get(f"/tickets/{sid}")).status_code == 404
    assert (await c.get(f"/stories/{sid}")).status_code == 404


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
