"""The Idea Space's AI helpers on the assistant engine (AI v2 stage 7): status and switches, triage advice, Shape,
Ask, Prepare a ticket and the digest are turns of the Idea assistant with a skill; the ideas are given to it."""

import json

import pytest

from tests.ai_helpers import _project, _runner, env  # noqa: F401

BASE = "/api/idea-ai"


@pytest.fixture(autouse=True)
def _assistant(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "assistant")


async def _ideas(env, monkeypatch, answers: dict):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    a = await c.post(
        "/api/idea-tickets",
        json={
            "project_id": pid,
            "title": "Dark mode",
            "description": "People ask for it.",
        },
    )
    assert a.status_code == 201, a.text
    b = await c.post(
        "/api/idea-tickets", json={"project_id": pid, "title": "Night theme"}
    )
    monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_BY_SKILL", json.dumps(answers))
    return c, pid, a.json()["id"], b.json()["id"]


async def test_status_and_switches(env, monkeypatch):
    c, pid, a, b = await _ideas(env, monkeypatch, {})
    st = (await c.get(f"{BASE}/status", params={"project_id": pid})).json()
    assert (
        st["state"] == "on"
        and st["settings"]["enabled"] is True
        and st["cap"] == 1.0
        and st["limited"] is False
    )
    off = await c.put(
        f"{BASE}/settings", params={"project_id": pid}, json={"enabled": False}
    )
    assert off.status_code == 200 and off.json()["state"] == "off"
    r = await c.post(f"{BASE}/ask", json={"question": "What next?", "project_id": pid})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "off"
    assert (await c.get(f"{BASE}/status")).json()["limited"] is True


async def test_triage_advice(env, monkeypatch):
    c, pid, a, b = await _ideas(env, monkeypatch, {})
    record = env["tmp"] / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(record))
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        json.dumps(
            {
                "action": "merge",
                "reason": "Same as Dark mode.",
                "confidence": "high",
                "target_id": a,
            }
        ),
    )
    r = await c.post(f"{BASE}/advice", json={"idea_ids": [b, "nope"]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert (
        out["errors"]
        == [{"idea_id": "nope", "code": "not_found", "message": "Idea not found"}]
        and out["none"] == []
    )
    adv = out["advice"][0]
    assert (
        adv["action"] == "merge"
        and adv["target_id"] == a
        and adv["target_title"] == "Dark mode"
        and adv["stale"] is False
    )
    prompt = json.loads(record.read_text().splitlines()[-1])["prompt"]
    assert (
        "kanban-assistant:idea-triage" in prompt
        and "Night theme" in prompt
        and "Dark mode" in prompt
    )
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        json.dumps({"action": "none", "reason": "Not sure.", "confidence": "low"}),
    )
    unsure = (await c.post(f"{BASE}/advice", json={"idea_ids": [a]})).json()
    assert unsure["none"] == [a] and unsure["advice"] == []
    listed = (
        await c.get(f"{BASE}/advice", params={"idea_ids": [a, b], "include_none": True})
    ).json()
    assert sorted(x["action"] for x in listed) == ["merge", "none"]
    done = await c.post(f"{BASE}/advice/{adv['id']}/state", json={"state": "accepted"})
    assert done.json() == {"id": adv["id"], "state": "accepted"}
    assert (await c.get(f"{BASE}/advice", params={"idea_ids": [b]})).json() == []


async def test_shape_ask_prepare_and_digest(env, monkeypatch):
    c, pid, a, b = await _ideas(
        env,
        monkeypatch,
        {
            "idea-shape": {
                "assumptions": [
                    {
                        "text": "People work at night",
                        "impact": "high",
                        "cheapest_test": "Ask five users",
                    }
                ]
            },
            "idea-ask": {
                "answer": "Test Dark mode first.",
                "sources": [{"id": "IDEA_A"}],
                "actions": [],
            },
            "idea-prepare-ticket": {
                "title": "Add a dark theme",
                "description": "Do it.",
                "acceptance_criteria": ["Toggle in settings"],
                "sub_tickets": [],
            },
            "idea-digest": {
                "text": "Two ideas, one duplicate.",
                "items": [
                    {
                        "kind": "ready",
                        "idea_ids": ["IDEA_A", "ghost"],
                        "text": "Dark mode is ready.",
                    }
                ],
            },
        },
    )
    shaped = await c.post(f"{BASE}/shape", json={"idea_id": a, "kind": "assumptions"})
    assert shaped.status_code == 200, shaped.text
    s = shaped.json()
    assert (
        s["kind"] == "assumptions"
        and s["ai"] is True
        and s["member"] == "Idea AI"
        and s["assumptions"][0]["impact"] == "high"
    )
    assert (
        await c.post(f"{BASE}/shape", json={"idea_id": a, "kind": "ask"})
    ).status_code == 400
    assert (
        await c.post(f"{BASE}/shape", json={"idea_id": "nope", "kind": "problem"})
    ).status_code == 404
    assert (await c.post(f"{BASE}/shape/req-12345678/stop")).json() == {
        "stopped": False
    }
    asked = await c.post(
        f"{BASE}/ask", json={"question": "What should we test next?", "project_id": pid}
    )
    assert asked.status_code == 200, asked.text
    assert (
        asked.json()["answer"] == "Test Dark mode first."
        and asked.json()["ideas_read"] == 2
        and asked.json()["sources"] == []
    )
    prepared = (await c.post(f"{BASE}/prepare-ticket", json={"idea_id": a})).json()
    assert (
        prepared["title"] == "Add a dark theme"
        and prepared["acceptance_criteria"] == ["Toggle in settings"]
        and prepared["cost"] == 0.02
    )
    assert (await c.get(f"{BASE}/digest", params={"project_id": pid})).json() is None
    d = await c.post(f"{BASE}/digest/run", json={"project_id": pid})
    assert d.status_code == 201, d.text
    assert (
        d.json()["text"] == "Two ideas, one duplicate."
        and d.json()["ideas_read"] == 2
        and d.json()["items"][0]["idea_ids"] == []
    )
    assert (await c.get(f"{BASE}/digest", params={"project_id": pid})).json()[
        "id"
    ] == d.json()["id"]
    assert (await c.get(f"{BASE}/status", params={"project_id": pid})).json()[
        "spent_today"
    ] == 0.08
