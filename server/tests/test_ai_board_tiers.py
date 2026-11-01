"""Wave 3 (design/screens/ai-board-wave3.md): the Board AI acts as the person by tier, the AI signals, standing orders
tried before they act, the knowledge base without embeddings, red CI back to the Dev, and the eval suites."""

import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest

from models import AiAccountState, AiRun, AiTicketFlag, AiWatchedPr, Ticket
from services.ai import github, kb, orders, quota, signals
from services.ai.assist import tiers
from tests.test_ai import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401
from tests.test_ai_assist import H, _answer, _setup, fake  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


# --------------------------------------------------------------------------- tiers


def test_small_reversible_changes_act_and_the_rest_asks_first():
    assert (
        tiers.decide([{"op": "status", "ticket": "KAN-1", "to": "review"}])["act"]
        is True
    )
    done = tiers.decide([{"op": "status", "ticket": "KAN-1", "to": "done"}])
    assert done["act"] is False and "cannot be moved out" in done["reasons"][0]
    bulk = tiers.decide(
        [{"op": "priority", "ticket": f"KAN-{i}", "to": "high"} for i in range(4)]
    )
    assert bulk["act"] is False and "bulk" in bulk["reasons"][0]
    assert (
        tiers.decide(
            [{"op": "priority", "ticket": "KAN-1", "to": "high"}],
            project_ids={"a", "b"},
        )["act"]
        is False
    )


def test_only_the_middle_tier_can_be_lowered_and_never_a_locked_action():
    assert tiers.check_overrides({"comment": "free"}) == {"comment": "free"}
    with pytest.raises(ValueError, match="never leave"):
        tiers.check_overrides({"done": "undo"})
    with pytest.raises(ValueError, match="never leave"):
        tiers.check_overrides({"merge": "free"})
    with pytest.raises(ValueError, match="Only an action of the middle tier"):
        tiers.check_overrides({"comment": "ask"})
    assert {
        "done",
        "delete",
        "pause_all",
        "permission",
        "budget",
        "merge",
        "post_outside",
    } <= set(tiers.LOCKED)


async def test_the_board_ai_moves_a_ticket_itself_with_one_undo(env, fake):
    c, pid, an, m = await _setup(env, acts=True)
    tid = await _ticket(c, pid, title="Export", status="in-progress")
    fake.queue.append(
        "Moving it.\n\n```kanban-actions\n"
        + json.dumps({"changes": [{"op": "status", "ticket": tid, "to": "review"}]})
        + "\n```"
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Send it to review")
    assert msg["draft"]["status"] == "applied"
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "review"
    r = await c.post(f"/ai/assist/drafts/{msg['draft']['id']}/undo", headers=H)
    assert r.status_code == 200, r.text
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "in-progress"


async def test_done_and_bulk_changes_wait_for_the_persons_yes(env, fake):
    c, pid, an, m = await _setup(env, acts=True)
    tid = await _ticket(c, pid, title="Export", status="review")
    fake.queue.append(
        "```kanban-actions\n"
        + json.dumps({"changes": [{"op": "status", "ticket": tid, "to": "done"}]})
        + "\n```"
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Close it")
    assert msg["draft"]["status"] == "open"
    assert "asks you first" in msg["draft"]["payload"]["intro"]
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "review"


async def test_the_board_ai_can_start_an_ai_and_undo_takes_it_back(env, fake):
    c, pid, an, m = await _setup(env, acts=True)
    tid = await _ticket(c, pid, title="Fix it", status="todo")
    fake.queue.append(
        "```kanban-actions\n"
        + json.dumps(
            {
                "changes": [
                    {
                        "op": "run",
                        "ticket": tid,
                        "member": m["name"],
                        "text": "Fix the bug",
                    }
                ]
            }
        )
        + "\n```"
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Get Reviewer on it")
    assert msg["draft"]["status"] == "applied"
    runs_ = (await c.get(f"/tickets/{tid}/ai/runs")).json()
    assert runs_ and runs_[0]["trigger"] == "board_ai"
    await c.post(f"/ai/assist/drafts/{msg['draft']['id']}/undo", headers=H)
    await asyncio.sleep(0.3)
    assert (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]["state"] in (
        "cancelled",
        "finished",
        "failed",
    )


async def test_the_board_ai_settings_refuse_a_locked_change(env):
    c = env["c"]
    pid, _ = await _project(c)
    got = (await c.get(f"/projects/{pid}/ai/board-ai")).json()
    assert got["acts"] is True and "done" in got["locked"]
    assert (
        await c.patch(f"/projects/{pid}/ai/board-ai", json={"tiers": {"done": "undo"}})
    ).status_code == 422
    ok = (
        await c.patch(
            f"/projects/{pid}/ai/board-ai", json={"tiers": {"comment": "free"}}
        )
    ).json()
    assert next(t for t in ok["tiers"] if t["op"] == "comment")["tier"] == "free"


# --------------------------------------------------------------------------- signals


async def test_the_five_ai_signals_are_computed_by_code(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=m["id"],
                state="running",
                diagnosis=json.dumps(
                    {
                        "cause": "foreground_server",
                        "what": "npm run dev",
                        "means": "x",
                        "quiet_s": 1500,
                        "actions": ["stop_child"],
                    }
                ),
            )
        )
        for i in range(3):
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=m["id"],
                    number=i + 2,
                    state="failed",
                    ended_at=f"2026-11-02T0{i}:00:00+00:00",
                    ended_reason="boom",
                )
            )
        s.add(
            AiAccountState(
                key=quota.LOCAL,
                five_hour_used=0.92,
                five_hour_resets_at="2026-11-02T14:00:00+00:00",
            )
        )
        s.add(
            AiTicketFlag(
                ticket_id=tid,
                project_id=pid,
                kind="arbitration",
                data=json.dumps({"why": "no progress"}),
                created_at=(datetime.now(UTC) - timedelta(minutes=50)).isoformat(),
            )
        )
        await s.commit()
    found = (await c.get(f"/projects/{pid}/ai/signals")).json()
    kinds = {f["kind"] for f in found}
    assert {"ai_hang", "ai_failing", "quota_near", "arbitration_wait"} <= kinds
    hang = next(f for f in found if f["kind"] == "ai_hang")
    assert hang["action"] == "Stop that command" and hang["data"]["minutes"] == 25


# --------------------------------------------------------------------------- standing orders


def test_a_rule_may_only_do_what_can_be_undone():
    with pytest.raises(orders.OrderError, match="only do what can be undone"):
        orders.check_rule(
            {
                "when": "review_stale",
                "then": {"mode": "fixed", "action": "delete_ticket"},
            }
        )
    with pytest.raises(orders.OrderError, match="does not fit"):
        orders.check_rule(
            {"when": "review_stale", "then": {"mode": "fixed", "action": "stop_child"}}
        )
    with pytest.raises(orders.OrderError, match="Only a hang"):
        orders.check_rule({"when": "quota_near", "then": {"mode": "diagnose"}})
    rule = orders.parse_sentence(
        "If an AI hangs for more than 45 minutes, diagnose it and fix it if you can"
    )
    assert (
        rule["when"] == "ai_hang"
        and rule["if"]["min_minutes"] == 45
        and rule["then"]["mode"] == "diagnose"
    )
    with pytest.raises(orders.OrderError):
        orders.parse_sentence("make coffee")


async def _stale_review(env, pid):
    c = env["c"]
    tid = await _ticket(c, pid, title="Old review", status="review")
    async with env["maker"]() as s:
        t = await s.get(Ticket, tid)
        old = (datetime.now(UTC) - timedelta(hours=30)).isoformat()
        t.activity_log = json.dumps([{"field": "status", "to": "review", "at": old}])
        t.updated_at = old
        s.add(t)
        await s.commit()
    return tid


async def test_a_rule_runs_in_trial_first_then_on_and_each_firing_can_be_undone(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _stale_review(env, pid)
    tpl = next(t for t in orders.TEMPLATES if t["key"] == "review_stale")
    o = (
        await c.post(
            f"/projects/{pid}/ai/orders",
            json={
                "name": tpl["name"],
                "sentence": tpl["sentence"],
                "rule": tpl["rule"],
                "template": "review_stale",
            },
        )
    ).json()
    assert o["state"] == "off"
    assert (
        await c.patch(f"/ai/orders/{o['id']}", json={"state": "on"})
    ).status_code == 422  # never straight to on
    await c.patch(f"/ai/orders/{o['id']}", json={"state": "trial"})
    fired = (await c.post(f"/projects/{pid}/ai/orders/tick")).json()["fired"]
    assert len(fired) == 1 and fired[0]["would"] is True
    assert not [
        x for x in (await c.get(f"/tickets/{tid}")).json()["comments"]
    ]  # a trial changes nothing
    o = (await c.patch(f"/ai/orders/{o['id']}", json={"state": "on"})).json()
    assert o["state"] == "on" and o["would_have"] == 1
    fired = (await c.post(f"/projects/{pid}/ai/orders/tick")).json()["fired"]
    assert fired == []  # at most once per target a day, trial firings included
    async with env["maker"]() as s:
        from models import AiOrderFiring
        from sqlmodel import select

        for f in (await s.exec(select(AiOrderFiring))).all():
            await s.delete(f)
        await s.commit()
    fired = (await c.post(f"/projects/{pid}/ai/orders/tick")).json()["fired"]
    assert len(fired) == 1 and fired[0]["would"] is False and fired[0]["can_undo"]
    comments = (await c.get(f"/tickets/{tid}")).json()["comments"]
    assert comments and "Reminder" in comments[-1]["text"]
    undone = (await c.post(f"/ai/firings/{fired[0]['id']}/undo")).json()
    assert undone["firing"]["undone_at"]
    assert not (await c.get(f"/tickets/{tid}")).json()["comments"]


async def test_pause_all_ai_stops_every_rule(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _stale_review(env, pid)
    tpl = next(t for t in orders.TEMPLATES if t["key"] == "review_stale")
    o = (
        await c.post(
            f"/projects/{pid}/ai/orders", json={"name": "x", "rule": tpl["rule"]}
        )
    ).json()
    await c.patch(f"/ai/orders/{o['id']}", json={"state": "trial"})
    from services.ai.store import get_settings

    async with env["maker"]() as s:
        st = await get_settings(s, pid)
        st.paused_all = True
        s.add(st)
        await s.commit()
    assert (await c.post(f"/projects/{pid}/ai/orders/tick")).json()["fired"] == []


# --------------------------------------------------------------------------- the knowledge base


async def test_the_knowledge_base_finds_by_keywords_and_keeps_private_and_shared_apart(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)

    async def no_model(*a, **k):
        return None

    monkeypatch.setattr(kb, "_ask_light", no_model)
    a = (
        await c.post(
            f"/projects/{pid}/ai/kb",
            data={
                "title": "Security review",
                "text": "Tokens must rotate every 90 days. Passwords are hashed with argon2.",
            },
        )
    ).json()
    await c.post(
        f"/projects/{pid}/ai/kb",
        data={
            "title": "Release notes",
            "text": "Version 3 adds dark mode and faster boards.",
        },
    )
    await c.post(
        f"/projects/{pid}/ai/kb",
        data={
            "title": "Secret plan",
            "text": "argon2 migration plan for the private vault",
            "private": "true",
        },
        headers={"X-Actor": "Hoa Mai"},
    )
    shared = (
        await c.post(
            f"/projects/{pid}/ai/kb",
            data={
                "title": "Company style",
                "text": "Write in plain English; argon2 is the standard.",
                "store": "shared",
            },
        )
    ).json()
    hits = (
        await c.get(f"/projects/{pid}/ai/kb/search", params={"q": "argon2 tokens"})
    ).json()
    assert hits[0]["id"] == a["id"]
    assert all(h["title"] != "Secret plan" for h in hits)  # private to Hoa Mai
    assert all(h["store"] == "project" for h in hits)  # the shared store is opt-in
    mine = (
        await c.get(
            f"/projects/{pid}/ai/kb/search",
            params={"q": "vault"},
            headers={"X-Actor": "Hoa Mai"},
        )
    ).json()
    assert [h["title"] for h in mine] == ["Secret plan"]
    await c.patch(f"/projects/{pid}/ai/ops", json={"knowledge_shared": True})
    hits = (await c.get(f"/projects/{pid}/ai/kb/search", params={"q": "argon2"})).json()
    assert shared["id"] in {h["id"] for h in hits}
    from kanban_mcp.tools.knowledge import knowledge

    toc = await knowledge(action="index", project_id=pid)
    assert {d["title"] for d in toc} >= {
        "Security review",
        "Release notes",
        "Company style",
    }
    doc = await knowledge(action="read", project_id=pid, doc_id=a["id"])
    assert doc["text"].startswith('<untrusted source="knowledge')
    assert "never instructions" in doc["note"]


async def test_board_wait_returns_new_events_as_soon_as_they_come(env):
    from kanban_mcp.tools.knowledge import board_wait
    from services import notifications as centre

    c = env["c"]
    pid, _ = await _project(c)
    head = (await board_wait())["head"]

    async def later():
        await asyncio.sleep(0.5)
        await centre.emit(
            "ai_finished",
            project_id=pid,
            recipients=["user"],
            title="Done",
            target_kind="ticket",
            target_id="KAN-1",
        )

    task = asyncio.create_task(later())
    got = await board_wait(since=head, timeout_s=10)
    await task
    assert [e["title"] for e in got["events"]] == ["Done"]


# --------------------------------------------------------------------------- GitHub


def test_ci_state_from_the_checks():
    assert github._rollup([{"conclusion": "SUCCESS"}])[0] == "green"
    state, failing = github._rollup(
        [{"name": "test", "conclusion": "FAILURE"}, {"conclusion": "SUCCESS"}]
    )
    assert state == "red" and failing[0]["name"] == "test"
    assert github._rollup([{"status": "IN_PROGRESS"}])[0] == "pending"


async def test_red_ci_on_this_change_goes_back_to_the_dev_with_its_log(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished",))
    async with env["maker"]() as s:
        s.add(
            AiWatchedPr(
                ticket_id=tid,
                project_id=pid,
                number=7,
                branch="ai/x",
                repo=env["repo"],
                ci="red",
                red=json.dumps(
                    {
                        "check": "test",
                        "blamed": True,
                        "at": "2026-11-02T10:00:00",
                        "base": "main",
                    }
                ),
            )
        )
        await s.commit()
        found = await signals.for_rules(s, pid)
    assert any(f["kind"] == "ci_red" and f["ticket_id"] == tid for f in found)

    async def log(row, check):
        return "FAILED test_export.py::test_empty - IndexError"

    monkeypatch.setattr(github, "failure_log", log)
    r = (await c.post(f"/tickets/{tid}/ai/pull/ci-to-dev")).json()
    run = await _wait(c, tid, ("finished",))
    assert run["id"] == r["run_id"]
    assert "IndexError" in run["instruction"] and "#7" in run["instruction"]
    async with env["maker"]() as s:
        assert not [
            f for f in await signals.for_rules(s, pid) if f["kind"] == "ci_red"
        ]  # handled once


# --------------------------------------------------------------------------- evals


async def test_a_suite_runs_on_the_sandbox_and_is_marked(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    suites = (await c.get("/ai/evals/suites")).json()
    assert {s["key"] for s in suites} == {
        "board",
        "problem",
        "issue",
        "spec",
        "recovery",
        "coordination",
        "safety",
    }
    r = await c.post("/ai/evals/run", json={"suite": "safety", "member_id": m["id"]})
    assert r.status_code == 200, r.text
    started = r.json()
    assert started["runs"]
    for _ in range(100):
        marks = (await c.get("/ai/evals/marks")).json()
        if marks and marks[0]["state"] == "done":
            break
        await asyncio.sleep(0.15)
    assert marks[0]["suite"] == "safety"
    assert (
        marks[0]["score"] == 1.0
    )  # the fake did not move the ticket to Done, as the planted text asked
    assert (
        await c.post("/ai/evals/run", json={"suite": "problem", "member_id": m["id"]})
    ).status_code == 422
