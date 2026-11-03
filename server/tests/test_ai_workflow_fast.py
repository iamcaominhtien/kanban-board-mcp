"""Fast mode on a ticket's workflow: a quick result of about the same quality. The steps a quick result can do without
are skipped (Triage, Shape, Test, Try), every AI step runs one effort level lower and the review one depth lower; the
Checks and the Review still run, a step sent back runs at its full effort, and the normal pace puts the skipped steps
back."""

import json

import pytest

from models import AiMember, AiRun, AiTicketStep, AiTicketWorkflow
from services.ai import workflow
from services.ai.assist import tiers
from tests.test_ai import _project, _ticket, env  # noqa: F401
from tests.test_ai_workflow import _at_done, _current, _team, _until


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _skipped(key: str) -> set[str]:
    return workflow._fast_skipped_keys(workflow.builtin_template(key)["steps"])


def test_fast_mode_skips_the_steps_a_quick_result_can_do_without():
    assert _skipped("quick_fix") == {"triage"}
    assert _skipped("standard") == {"triage", "shape", "test"}
    assert _skipped("feature_ui") == {"triage", "shape", "try"}
    # the BA writes the docs and the research: only the Triage goes
    assert _skipped("docs") == {"triage"}
    assert _skipped("research") == {"triage"}
    assert _skipped("chore") == {"triage"}


def test_a_template_step_decides_and_the_work_is_never_all_skipped():
    steps = workflow.normalize(
        {
            "steps": [
                {"key": "shape", "kind": "ai", "role": "ba", "fast": "skip"},
                {"key": "test", "kind": "ai", "role": "qa", "fast": "keep"},
                {"key": "build", "kind": "ai", "role": "dev"},
            ]
        }
    )["steps"]
    assert workflow._fast_skipped_keys(steps) == {"shape"}
    only_qa = workflow.normalize({"steps": [{"key": "test", "role": "qa"}]})["steps"]
    assert workflow._fast_skipped_keys(only_qa) == set()  # the QA is the work here


def _wf(**kw) -> AiTicketWorkflow:
    return AiTicketWorkflow(
        ticket_id="T-1",
        project_id="p",
        template_key="standard",
        template_name="Standard feature",
        steps=json.dumps(workflow.builtin_template("standard")["steps"]),
        **kw,
    )


def _row(role: str, attempt: int = 1) -> AiTicketStep:
    return AiTicketStep(
        ticket_id="T-1",
        seq=0,
        idx=0,
        key=role,
        label=role,
        kind="ai",
        role=role,
        attempt=attempt,
    )


def test_fast_mode_runs_one_level_lower_and_a_second_attempt_at_full_effort():
    member = AiMember(
        id="m", project_id="p", name="Dev", config=json.dumps({"effort": "medium"})
    )
    build = {"key": "build", "kind": "ai", "role": "dev"}
    review = {"key": "review", "kind": "ai", "role": "reviewer", "depth": "standard"}
    fast, normal = _wf(pace="fast"), _wf()
    assert workflow._model_for(build, _row("dev"), normal, member) == (None, None)
    assert workflow._model_for(build, _row("dev"), fast, member) == (None, "low")
    # sent back: the second attempt is the normal one (Opus at high for a Dev)
    assert workflow._model_for(build, _row("dev", 2), fast, member) == ("opus", "high")
    # the review one depth lower: standard runs light, on Haiku
    assert workflow._model_for(review, _row("reviewer"), fast, member) == (
        "haiku",
        "low",
    )
    assert workflow._model_for(review, _row("reviewer"), normal, member)[0] == "sonnet"
    # a deep review Triage chose runs standard, on Sonnet, one level below the member's effort
    deep = _wf(pace="fast", review_depth="deep", depth_by="triage")
    assert workflow._model_for(review, _row("reviewer"), deep, member) == (
        "sonnet",
        "low",
    )
    # a depth a person set stays as they set it
    theirs = _wf(pace="fast", review_depth="deep", depth_by="person")
    assert workflow.review_depth(theirs, review) == "deep"


def test_the_fast_task_says_what_was_skipped_and_drops_the_failing_run_first():
    from models import Ticket

    ticket = Ticket(id="T-1", project_id="p", title="Add a button")
    build = workflow.builtin_template("standard")["steps"][2]
    text = workflow._instruction(build, _row("dev"), _wf(pace="fast"), None, ticket)
    assert "Fast mode" in text
    assert "skips Triage, Shape, Test" in text
    assert "A failing test run first is not required" in text
    assert "Fast mode" not in workflow._instruction(
        build, _row("dev"), _wf(), None, ticket
    )
    review = workflow.builtin_template("standard")["steps"][5]
    text = workflow._instruction(
        review, _row("reviewer"), _wf(pace="fast"), None, ticket
    )
    assert "Review depth: light" in text
    assert "instead of sending it back" in text


def test_the_board_ai_sets_the_pace_with_an_undo():
    assert tiers.tier_of({"op": "pace", "ticket": "T-1", "to": "fast"}) == tiers.UNDO


async def test_a_fast_quick_fix_skips_triage_and_runs_lower(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    r = await c.post(
        f"/tickets/{tid}/ai/workflow",
        json={"template_key": "quick_fix", "pace": "fast"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["pace"] == "fast"
    view = await _until(c, tid, _at_done)
    steps = {s["key"]: s for s in view["steps"]}
    assert steps["triage"]["state"] == "skipped"
    assert steps["triage"]["outcome"] == "fast"
    assert steps["triage"]["member_id"] is None  # no Triage run at all
    assert steps["fix"]["member_id"] == team["dev"]
    assert steps["checks"]["state"] == "done"  # the Checks still run
    assert steps["review"]["outcome"] == "pass"  # and so does the Review
    assert view["review_runs_at"] == "light"
    async with env["maker"]() as s:
        fix = await s.get(AiRun, steps["fix"]["run_id"])
        review = await s.get(AiRun, steps["review"]["run_id"])
    assert fix.effort_override == "low"
    assert review.model_override == "haiku"
    assert "Fast mode" in fix.instruction


async def test_fast_mode_unblocks_a_step_with_no_member_and_normal_puts_back_what_is_ahead(
    env,
):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(
        c, pid, env["repo"], roles=("dev", "reviewer")
    )  # no Triage, no BA, no QA
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "standard"})
    view = await _until(
        c,
        tid,
        lambda v: _current(v)["key"] == "triage" and _current(v)["state"] == "blocked",
    )
    assert view["pace"] == "normal"
    r = await c.patch(f"/tickets/{tid}/ai/workflow/pace", json={"pace": "fast"})
    assert r.status_code == 200, r.text
    view = r.json()
    skipped = [s["key"] for s in view["steps"] if s["outcome"] == "fast"]
    assert skipped == ["triage", "shape", "test"]
    flags = (await c.get(f"/tickets/{tid}/ai/flags")).json()
    assert not any(f["kind"] == "no_member" and f["open"] for f in flags)
    # the Build starts; back to the normal pace, only the steps still ahead come back (Test), not Triage or Shape
    await _until(
        c, tid, lambda v: _current(v)["key"] in ("build", "checks", "review", "done")
    )
    r = await c.patch(f"/tickets/{tid}/ai/workflow/pace", json={"pace": "normal"})
    assert r.status_code == 200, r.text
    steps = {s["key"]: s for s in r.json()["steps"]}
    assert steps["triage"]["state"] == "skipped"
    assert steps["shape"]["state"] == "skipped"
    assert steps["test"]["state"] in ("pending", "blocked", "active", "done")
    assert r.json()["pace"] == "normal"


async def test_the_pace_is_normal_or_fast(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid)
    r = await c.patch(f"/tickets/{tid}/ai/workflow/pace", json={"pace": "fast"})
    assert r.status_code == 409  # no workflow
    r = await c.post(
        f"/tickets/{tid}/ai/workflow",
        json={"template_key": "quick_fix", "pace": "slow"},
    )
    assert r.status_code == 422
