"""Workflows on tickets (design/screens/ai-team-process.md E–I; D8–D14, D24), against the fake CLI playing each
role: steps resolve to members, the assignee follows the step, history is never overwritten, the checks run by code,
review sends back, no progress goes to the coordinator, a ruling gets one chance, a person approves at most twice."""

import asyncio
import json

import pytest

from models import AiRun
from services.ai import workflow
from tests.test_ai import FAKE, _project, _ticket, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


async def _team(
    c,
    pid,
    repo,
    roles=("triage", "ba", "dev", "qa", "reviewer", "pm", "designer", "user_tester"),
):
    out = {}
    for role in roles:
        r = await c.post(
            f"/projects/{pid}/ai/packs/{role}/member",
            json={"name": f"{role.title()} AI", "working_dir": repo},
        )
        assert r.status_code == 201, r.text
        m = r.json()
        await c.patch(
            f"/ai/members/{m['id']}", json={"cli_path": FAKE, "model": "haiku"}
        )
        out[role] = m["id"]
    return out


async def _until(c, tid, pred, timeout=60.0):
    from services.ai import runs

    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        view = (await c.get(f"/tickets/{tid}/ai/workflow")).json()
        if view and pred(view):
            return view
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(json.dumps(view, indent=1)[:3000])
        runs.RT.wake.set()
        await asyncio.sleep(0.15)


def _current(view):
    return next(
        (
            s
            for s in view["steps"]
            if s["state"] in ("pending", "active", "waiting", "blocked", "failed")
        ),
        None,
    )


async def test_quick_fix_runs_every_step_and_waits_for_the_person_at_done(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    r = await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    assert r.status_code == 200, r.text
    view = await _until(c, tid, lambda v: _current(v) and _current(v)["key"] == "done")
    steps = {s["key"]: s for s in view["steps"]}
    assert [s["key"] for s in view["steps"]] == [
        "triage",
        "fix",
        "checks",
        "review",
        "done",
    ]
    assert steps["triage"]["member_id"] == team["triage"]
    assert steps["fix"]["member_id"] == team["dev"]
    assert steps["review"]["member_id"] == team["reviewer"]
    assert steps["review"]["outcome"] == "pass"
    assert steps["checks"]["state"] == "done"
    assert steps["done"]["state"] == "waiting"
    ticket = (await c.get(f"/tickets/{tid}")).json()
    assert ticket["status"] == "review"  # the last step is the ticket in Review
    assert ticket["assignee"] == team["reviewer"]  # whoever held it last
    await c.patch(f"/tickets/{tid}", json={"status": "done"})
    await _until(c, tid, lambda v: v["state"] == "done")


async def test_the_reviewer_sends_it_back_and_the_second_attempt_runs_on_opus(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    verdicts = tmp_path / "verdicts.txt"
    verdicts.write_text("CHANGES add a test for an empty list\nPASS\n")
    monkeypatch.setenv("FAKE_CLAUDE_REVIEW_FILE", str(verdicts))
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, lambda v: _current(v) and _current(v)["key"] == "done")
    fixes = [s for s in view["steps"] if s["key"] == "fix"]
    assert [s["attempt"] for s in fixes] == [
        1,
        2,
    ]  # history kept: a new attempt, the first one untouched
    assert "add a test for an empty list" in fixes[1]["note_in"]
    reviews = [s for s in view["steps"] if s["key"] == "review"]
    assert [s["outcome"] for s in reviews] == ["changes", "pass"]
    assert view["rounds"] == {"dev|reviewer": 1}
    async with env["maker"]() as s:
        second = await s.get(AiRun, fixes[1]["run_id"])
    assert second.model_override == "opus"
    assert second.effort_override == "high"


async def test_a_repeated_objection_goes_to_the_coordinator_who_rules(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    verdicts = tmp_path / "verdicts.txt"
    verdicts.write_text(
        "CHANGES the cost field does not belong in the API\nCHANGES the cost field does not belong in the API\n"
    )
    monkeypatch.setenv("FAKE_CLAUDE_REVIEW_FILE", str(verdicts))
    monkeypatch.setenv("FAKE_CLAUDE_RULING", "DEV")
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer", "pm"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(
        c,
        tid,
        lambda v: bool(v["rulings"]) and _current(v) and _current(v)["key"] == "done",
    )
    assert view["rulings"][0]["verdict"] == "dev"
    assert view["rulings"][0]["member_id"] == team["pm"]
    assert view["state"] == "active"
    flags = (await c.get(f"/tickets/{tid}/ai/ticket-flags")).json()
    arb = next(f for f in flags if f["kind"] == "arbitration")
    assert arb["open"] is False


async def test_without_a_coordinator_a_person_rules_and_the_reviewer_wins(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    verdicts = tmp_path / "verdicts.txt"
    verdicts.write_text("CHANGES rename it\nCHANGES rename it\nPASS\n")
    monkeypatch.setenv("FAKE_CLAUDE_REVIEW_FILE", str(verdicts))
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, lambda v: v["state"] == "stopped")
    assert view["stop_reason"] == "no_progress"
    panel = (
        await c.get("/notifications", params={"view": "panel", "tab": "needs"})
    ).json()
    row = next(i for i in panel["items"] if i["kind"] == "arbitration")
    assert [a["id"] for a in row["actions"]][:3] == [
        "arbitration:reviewer",
        "arbitration:dev",
        "arbitration:split",
    ]
    r = await c.post(
        f"/tickets/{tid}/ai/arbitration",
        json={"side": "reviewer", "reason": "Naming matters here."},
    )
    assert r.status_code == 200, r.text
    view = await _until(c, tid, lambda v: _current(v) and _current(v)["key"] == "done")
    fix = [s for s in view["steps"] if s["key"] == "fix"][-1]
    assert "the reviewer is right" in (fix["note_in"] or "")


async def test_failing_checks_send_it_back_to_the_dev_before_any_review(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    await c.patch(
        f"/projects/{pid}/ai/ops",
        json={
            "commands": {"test": "echo 'FAILED tests/test_calc.py::test_sub'; exit 1"}
        },
    )
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(
        c, tid, lambda v: len([s for s in v["steps"] if s["key"] == "fix"]) >= 2
    )
    checks = next(s for s in view["steps"] if s["key"] == "checks" and s["result"])
    assert checks["outcome"] == "failed"
    assert checks["result"]["checks"][0]["ok"] is False
    assert not any(
        s["key"] == "review" and s["member_id"] for s in view["steps"]
    )  # no reviewer was spent
    await c.delete(f"/tickets/{tid}/ai/workflow")


async def test_the_design_waits_for_the_person_who_approves_it(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "feature_ui"})
    view = await _until(
        c, tid, lambda v: _current(v) and _current(v)["key"] == "approve_design"
    )
    assert _current(view)["state"] == "waiting"
    panel = (
        await c.get("/notifications", params={"view": "panel", "tab": "needs"})
    ).json()
    row = next(i for i in panel["items"] if i["kind"] == "workflow_step")
    assert [a["id"] for a in row["actions"]][:2] == [
        "workflow:approve",
        "workflow:send_back",
    ]
    r = await c.post(f"/tickets/{tid}/ai/workflow/decide", json={"approve": True})
    assert r.status_code == 200, r.text
    view = await _until(c, tid, lambda v: _current(v) and _current(v)["key"] == "done")
    assert [s["key"] for s in view["steps"] if s["state"] == "done"] == [
        "triage",
        "shape",
        "design",
        "approve_design",
        "build",
        "checks",
        "try",
        "review",
    ]


async def test_triage_sets_the_depth_and_a_person_overrides_it(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_DEPTH", "deep")
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, lambda v: _current(v) and _current(v)["key"] == "done")
    assert view["review_depth"] == "deep" and view["depth_by"] == "triage"
    review = next(s for s in view["steps"] if s["key"] == "review")
    async with env["maker"]() as s:
        assert (await s.get(AiRun, review["run_id"])).model_override == "opus"
    r = await c.patch(f"/tickets/{tid}/ai/workflow/depth", json={"depth": "light"})
    assert r.json()["depth_by"] == "person"


async def test_a_step_with_no_member_for_its_role_is_blocked_and_flagged(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage",))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(
        c, tid, lambda v: _current(v) and _current(v)["state"] == "blocked"
    )
    assert _current(view)["key"] == "fix"
    flags = (await c.get(f"/tickets/{tid}/ai/ticket-flags")).json()
    assert flags[0]["kind"] == "no_member" and flags[0]["data"]["role"] == "dev"


async def test_templates_are_versioned_and_warn_past_two_stops(env):
    c = env["c"]
    pid, _ = await _project(c)
    listed = (await c.get(f"/projects/{pid}/ai/workflows")).json()
    assert [t["key"] for t in listed] == [
        "quick_fix",
        "standard",
        "feature_ui",
        "research",
    ]
    assert {t["key"]: len(t["steps"]) for t in listed} == {
        "quick_fix": 5,
        "standard": 7,
        "feature_ui": 9,
        "research": 4,
    }
    body = {
        "name": "Careful",
        "steps": [
            {"key": "a", "label": "A", "kind": "person"},
            {"key": "b", "label": "B", "kind": "person"},
            {"key": "c", "label": "Build", "kind": "ai", "role": "dev"},
        ],
    }
    t = (await c.put(f"/projects/{pid}/ai/workflows/careful", json=body)).json()
    assert t["steps"][-1]["key"] == "done"  # the last step always waits for a person
    assert t["person_stops"] == 3 and t["warning"]
    t2 = (await c.put(f"/projects/{pid}/ai/workflows/careful", json=body)).json()
    assert t2["version"] == t["version"] + 1
    bad = await c.put(
        f"/projects/{pid}/ai/workflows/x",
        json={"steps": [{"label": "No role", "kind": "ai"}]},
    )
    assert bad.status_code == 422


async def test_red_then_green_counts_only_a_failure_on_an_assertion(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid)
    member = (
        await c.post(
            f"/projects/{pid}/ai/packs/dev/member",
            json={"name": "Dev", "working_dir": env["repo"]},
        )
    ).json()

    async def add_run(n, steps):
        async with env["maker"]() as s:
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=member["id"],
                    number=n,
                    state="finished",
                    steps=json.dumps(steps),
                    queued_at=f"2026-11-02T0{n}:00:00",
                )
            )
            await s.commit()

    import_error = {
        "kind": "command",
        "text": "Ran pytest -q tests/test_calc.py",
        "tests": {"passed": 0, "failed": 1, "failing": []},
        "output": "ImportError: cannot import name 'add'\n1 failed",
    }
    await add_run(1, [import_error])
    assert (await c.get(f"/tickets/{tid}/ai/tdd")).json()["proven"] is False
    red = {
        "kind": "command",
        "text": "Ran pytest -q tests/test_calc.py",
        "tests": {
            "passed": 3,
            "failed": 1,
            "failing": ["tests/test_calc.py::test_sub"],
        },
        "output": "E   AssertionError: assert -1 == 1\nFAILED tests/test_calc.py::test_sub\n1 failed, 3 passed",
    }
    green = {
        "kind": "command",
        "text": "Ran pytest -q tests/test_calc.py",
        "tests": {"passed": 4, "failed": 0, "failing": []},
        "output": "4 passed",
    }
    await add_run(2, [red])
    await add_run(3, [green])
    got = (await c.get(f"/tickets/{tid}/ai/tdd")).json()
    assert got["proven"] is True
    assert got["red"]["why"] == "failed on an assertion"
    assert got["file"] == "tests/test_calc.py"


async def test_measures_per_template_and_the_board_of_holders(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, lambda v: _current(v) and _current(v)["key"] == "done")
    board = (await c.get(f"/projects/{pid}/ai/workflow-board")).json()
    assert board[0]["step"] == "Done" and board[0]["waits_for_person"] is True
    metrics = (await c.get(f"/projects/{pid}/ai/workflow-metrics")).json()
    qf = next(m for m in metrics if m["template_key"] == "quick_fix")
    assert qf["tickets"] == 1 and qf["passed_first"] == 1.0


async def test_triage_may_pick_another_template_before_the_next_step_starts(
    env, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_WORKFLOW", "research")
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "ba"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, lambda v: _current(v) and _current(v)["key"] == "done")
    assert view["template_key"] == "research"
    assert [s["key"] for s in view["steps"]] == [
        "triage",
        "investigate",
        "write_up",
        "done",
    ]


def test_normalize_adds_the_last_person_step():
    t = workflow.normalize(
        {"steps": [{"key": "x", "label": "X", "kind": "ai", "role": "dev"}]}
    )
    assert [s["kind"] for s in t["steps"]] == ["ai", "person"]
