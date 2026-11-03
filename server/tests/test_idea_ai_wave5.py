"""Idea Space AI, wave 5: "No suggestion: not sure" rows (IAI-1), the action buttons of an Ask answer (IAI-3) and Stop
on a Shape request (IP-16). The model is a fake; nothing reaches a real AI."""

import asyncio

from services import idea_ai
from services.ai import llm
from tests.test_ai import env  # noqa: F401  (fixture)
from tests.test_ai_assist import fake  # noqa: F401  (fixture)
from tests.test_idea_ai import AI, API, _answer, _idea, _on, _setup


async def test_a_not_sure_answer_is_listed_only_when_asked_for(env, fake):
    c, pid = await _setup(env)
    await _on(c, pid, triage_advice=True)
    a = await _idea(c, pid, title="One idea")
    b = await _idea(c, pid, title="Two idea")
    fake.queue += [
        _answer(action="none", reason="Too little to go on"),
        _answer(action="keep", reason="Clear and small", confidence="high"),
    ]
    r = (await c.post(f"{AI}/advice", json={"idea_ids": [a["id"], b["id"]]})).json()
    # the answer of the request is as before: the not-sure idea is in `none`, not in `advice`
    assert r["none"] == [a["id"]]
    assert [x["idea_id"] for x in r["advice"]] == [b["id"]]
    plain = (
        await c.get(f"{AI}/advice", params={"idea_ids": [a["id"], b["id"]]})
    ).json()
    assert [x["action"] for x in plain] == ["keep"]
    full = (
        await c.get(
            f"{AI}/advice",
            params={"idea_ids": [a["id"], b["id"]], "include_none": True},
        )
    ).json()
    by_idea = {x["idea_id"]: x for x in full}
    assert by_idea[a["id"]]["action"] == "none"
    assert by_idea[a["id"]]["reason"] == "Too little to go on"
    assert by_idea[b["id"]]["action"] == "keep"


async def test_a_not_sure_answer_never_replaces_a_real_suggestion(env, fake):
    c, pid = await _setup(env)
    await _on(c, pid, triage_advice=True)
    a = await _idea(c, pid, title="One idea")
    fake.queue += [
        _answer(action="park", reason="Later", confidence="high", park_days=30),
        _answer(action="none"),
    ]
    await c.post(f"{AI}/advice", json={"idea_ids": [a["id"]]})
    await c.post(f"{AI}/advice", json={"idea_ids": [a["id"]]})
    full = (
        await c.get(
            f"{AI}/advice", params={"idea_ids": [a["id"]], "include_none": True}
        )
    ).json()
    assert [x["action"] for x in full] == ["park"]


async def test_the_advice_prompt_asks_for_a_reason_when_not_sure(env, fake):
    c, pid = await _setup(env)
    await _on(c, pid, triage_advice=True)
    a = await _idea(c, pid, title="One idea")
    fake.queue.append(_answer(action="none"))
    await c.post(f"{AI}/advice", json={"idea_ids": [a["id"]]})
    assert '"action": "none", "reason"' in fake.prompts[-1]


async def test_an_ask_answer_offers_actions_for_ideas_it_read(env, fake):
    c, pid = await _setup(env)
    await _on(c, pid)
    idea = await _idea(c, pid, title="Price table for AI cost")
    r = await c.post(
        f"{API}/{idea['id']}/assumption-records",
        json={"text": "The price table can be kept up to date", "impact": "high"},
    )
    assumption = r.json()["assumptions"][0]["id"]
    fake.queue.append(
        f"Test the price table next ({idea['id']}).\n"
        'ACTIONS: [{"kind": "create_test_ticket", "idea_id": "%s", "assumption_id": "%s", '
        '"title": "Test: price table stays current"}, {"kind": "open_idea", "idea_id": "%s"}, '
        '{"kind": "open_idea", "idea_id": "IDEA-999"}, {"kind": "delete_idea", "idea_id": "%s"},'
        ' {"kind": "create_test_ticket", "idea_id": "%s", "assumption_id": "made-up"}]'
        % (idea["id"], assumption, idea["id"], idea["id"], idea["id"])
    )
    out = (
        await c.post(f"{AI}/ask", json={"question": "what to test?", "project_id": pid})
    ).json()
    assert "ACTIONS" not in out["answer"]
    assert out["answer"].startswith("Test the price table next")
    assert out["actions"] == [
        {
            "kind": "create_test_ticket",
            "idea_id": idea["id"],
            "idea_title": "Price table for AI cost",
            "assumption_id": assumption,
            "assumption_text": "The price table can be kept up to date",
            "title": "Test: price table stays current",
        },
        {
            "kind": "open_idea",
            "idea_id": idea["id"],
            "idea_title": "Price table for AI cost",
        },
    ]
    # nothing was created: an action only fills in the create dialog
    tickets = (await c.get(f"/projects/{pid}/tickets")).json()
    assert not any(t["title"].startswith("Test: price table") for t in tickets)
    assert "ACTIONS:" in fake.prompts[-1]


async def test_an_old_style_answer_still_parses_with_no_actions(env, fake):
    c, pid = await _setup(env)
    await _on(c, pid)
    idea = await _idea(c, pid, title="Price table")
    fake.queue.append(f"Look at {idea['id']}.")
    out = (
        await c.post(f"{AI}/ask", json={"question": "what?", "project_id": pid})
    ).json()
    assert out["answer"] == f"Look at {idea['id']}." and out["actions"] == []
    assert idea_ai.split_actions("Plain text") == ("Plain text", [])
    assert idea_ai.split_actions("Text\nACTIONS: [not json") == ("Text", [])


def test_the_actions_line_goes_and_the_words_around_it_stay():
    one = '[{"kind": "open_idea", "idea_id": "IDEA-1"}]'
    # the line in the middle: the text after it is kept
    text, actions = idea_ai.split_actions(f"Before.\nACTIONS: {one}\nAfter, still.")
    assert text == "Before.\n\nAfter, still."
    assert actions == [{"kind": "open_idea", "idea_id": "IDEA-1"}]
    # a list over several lines is one block
    block = '[\n  {"kind": "open_idea",\n   "idea_id": "IDEA-2"}\n]'
    text, actions = idea_ai.split_actions(
        f"Answer.\nACTIONS: {block}\nPS: one more thing"
    )
    assert text == "Answer.\n\nPS: one more thing" and actions[0]["idea_id"] == "IDEA-2"
    # not JSON: only that line is dropped
    assert idea_ai.split_actions("A\nACTIONS: nope\nB") == ("A\n\nB", [])
    # at the end, as the prompt asks
    assert idea_ai.split_actions(f"Done.\nACTIONS: {one}\n") == (
        "Done.",
        [{"kind": "open_idea", "idea_id": "IDEA-1"}],
    )


async def test_a_shape_request_can_be_stopped(env, fake, monkeypatch):
    c, pid = await _setup(env)
    await _on(c, pid)
    idea = await _idea(c, pid, title="Slow one")
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def slow(*_a, **_kw):
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            stopped.set()  # the model call (and its CLI) is cancelled
            raise

    monkeypatch.setattr(llm, "complete", slow)
    req = asyncio.create_task(
        c.post(
            f"{AI}/shape",
            json={
                "idea_id": idea["id"],
                "kind": "problem",
                "request_id": "req-0001-abc",
            },
        )
    )
    await asyncio.wait_for(started.wait(), 5)
    r = await c.post(f"{AI}/shape/req-0001-abc/stop")
    assert r.json() == {"stopped": True}
    res = await asyncio.wait_for(req, 5)
    assert res.status_code == 409 and res.json()["detail"]["code"] == "stopped"
    assert stopped.is_set()
    assert idea_ai.SHAPE_TASKS == {}
    again = await c.post(f"{AI}/shape/req-0001-abc/stop")
    assert again.json() == {"stopped": False}


async def test_a_shape_request_without_an_id_works_as_before(env, fake):
    c, pid = await _setup(env)
    await _on(c, pid)
    idea = await _idea(c, pid, title="Quick one")
    fake.queue.append(_answer(problem="People ask", idea="Show it"))
    r = await c.post(f"{AI}/shape", json={"idea_id": idea["id"], "kind": "problem"})
    assert r.status_code == 200 and r.json()["problem"] == "People ask"
    fake.queue.append(_answer(problem="Again", idea="Yes"))
    r = await c.post(
        f"{AI}/shape",
        json={"idea_id": idea["id"], "kind": "problem", "request_id": "req-0002-abc"},
    )
    assert r.status_code == 200 and r.json()["problem"] == "Again"
    assert idea_ai.SHAPE_TASKS == {}
