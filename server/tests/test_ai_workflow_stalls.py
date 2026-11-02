"""Workflows that must never stall, skip what they must not, or overrule a person (D11–D14, D24): a retried step
carries the workflow on, the Checks fail where a person sees them and come back after a restart, Checks and a person
never count as a dispute, a ruling never skips the Checks or the review, a step sent back or skipped stops its run,
two callers never start the same step, and what waited for a person closes when the ticket is Done or taken off.

The steps are driven by calling the workflow's own entry points on rows set up by hand, so each case is exact."""

import asyncio
import json
import sys
from types import SimpleNamespace

import pytest

from sqlmodel import col, select

from models import (
    AiMember,
    AiRun,
    AiTicketFlag,
    AiTicketStep,
    AiTicketWorkflow,
    Notification,
    Ticket,
)
from services.ai import flags, runs, workflow
from tests.test_ai import _project, _ticket, env  # noqa: F401
from tests.test_ai_workflow import _team


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


@pytest.fixture
def moved(monkeypatch):
    """Record every advance instead of starting real runs."""
    calls: list[str] = []

    async def fake_advance(ticket_id):
        calls.append(ticket_id)

    monkeypatch.setattr(workflow, "advance", fake_advance)
    return calls


async def _attached(env, template="quick_fix", roles=("triage", "dev", "reviewer")):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=roles)
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        ticket = await s.get(Ticket, tid)
        await workflow.attach(s, ticket, template, by="An Nguyen", start=False)
    return pid, tid, team


async def _rows(env, tid) -> dict[str, AiTicketStep]:
    """The latest row of each step key."""
    async with env["maker"]() as s:
        return {r.key: r for r in await workflow.steps_of(s, tid)}


async def _set(env, model, key, **fields):
    async with env["maker"]() as s:
        row = await s.get(model, key)
        for k, v in fields.items():
            setattr(row, k, v)
        s.add(row)
        await s.commit()


async def _run(env, pid, tid, member_id, **fields) -> str:
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=member_id,
            mode="work",
            **fields,
        )
        s.add(run)
        await s.commit()
        return run.id


# --------------------------------------------------------------------------- finding 1: nothing stalls for good


async def test_a_retried_step_carries_the_workflow_on_after_a_board_fault(env, moved):
    pid, tid, team = await _attached(env)
    rows = await _rows(env, tid)
    first = await _run(
        env, pid, tid, team["triage"], state="failed", trigger="workflow", number=1
    )
    await _set(env, AiTicketStep, rows["triage"].id, state="failed", run_id=first)
    await _set(env, AiTicketWorkflow, tid, state="stopped", stop_reason="board_fault")
    async with env["maker"]() as s:
        await flags.open_flag(s, tid, pid, "board_fault", {"step": "Triage"})
    retry = await _run(
        env,
        pid,
        tid,
        team["triage"],
        state="finished",
        trigger="retry",
        number=2,
        started_by="An Nguyen",
        instruction="You are doing the step “Triage” of the workflow “Quick fix” on it.",
        summary="Sorted it.",
    )
    await workflow.on_run_ended(retry)
    rows = await _rows(env, tid)
    assert rows["triage"].state == "done" and rows["triage"].run_id == retry
    async with env["maker"]() as s:
        assert (await s.get(AiTicketWorkflow, tid)).state == "active"
        assert not await flags.is_open(s, tid, "board_fault")
    assert moved == [tid]


async def test_the_checks_fail_visibly_when_they_cannot_run(env, moved, monkeypatch):
    pid, tid, _ = await _attached(env)
    rows = await _rows(env, tid)
    await _set(env, AiTicketStep, rows["checks"].id, state="active")

    async def broken(ticket_id):
        raise RuntimeError("the disk is full")

    monkeypatch.setattr(workflow, "tdd_evidence", broken)
    await workflow._run_checks(tid, rows["checks"].id)
    checks = (await _rows(env, tid))["checks"]
    assert checks.state == "failed"
    assert "could not run" in checks.note and "disk is full" in checks.note


async def test_checks_survive_output_that_is_not_utf8(env, moved):
    """On Windows a test command can print bytes the console code page cannot decode (a cp1252 reader thread
    used to die on 0x90 and the step failed with "unsupported operand ... NoneType"): the check still ends with
    its real result and its output."""
    pid, tid, team = await _attached(env)
    script = "import sys; sys.stdout.buffer.write(bytes([0x90, 0xff]) + b' boom'); sys.exit(1)"
    await env["c"].patch(
        f"/projects/{pid}/ai/ops",
        json={"commands": {"test": f'"{sys.executable}" -c "{script}"'}},
    )
    rows = await _rows(env, tid)
    await _set(env, AiTicketStep, rows["triage"].id, member_id=team["dev"])
    await _set(env, AiTicketStep, rows["checks"].id, state="active")
    await workflow._run_checks(tid, rows["checks"].id)
    async with env["maker"]() as s:
        checks = await s.get(AiTicketStep, rows["checks"].id)
    assert checks.state == "done" and checks.outcome == "failed"
    assert "boom" in checks.note


async def test_checks_a_restart_cut_off_run_again(env, monkeypatch):
    pid, tid, _ = await _attached(env)
    rows = await _rows(env, tid)
    await _set(env, AiTicketStep, rows["checks"].id, state="active")
    started = []

    async def fake_checks(ticket_id, step_id):
        started.append((ticket_id, step_id))

    monkeypatch.setattr(workflow, "_run_checks", fake_checks)
    assert await workflow.recover() == 1
    await asyncio.sleep(0)
    assert started == [(tid, rows["checks"].id)]


# --------------------------------------------------------------------------- finding 6: no folder, no pass


async def test_check_commands_with_no_folder_to_run_in_do_not_pass(env, moved):
    pid, tid, _ = await _attached(env)
    await env["c"].patch(f"/projects/{pid}/ai/ops", json={"commands": {"test": "true"}})
    rows = await _rows(env, tid)
    await _set(env, AiTicketStep, rows["checks"].id, state="active")
    await workflow._run_checks(
        tid, rows["checks"].id
    )  # nobody worked on it yet: no folder
    checks = (await _rows(env, tid))["checks"]
    assert checks.state == "blocked"
    assert "no folder" in checks.note
    assert moved == []  # the review does not start


# --------------------------------------------------------------------------- findings 2, 3: who can be in a dispute


async def test_checks_and_a_person_never_send_it_to_the_coordinator(
    env, moved, monkeypatch
):
    pid, tid, _ = await _attached(env)
    arbitrations = []

    async def fake_arbitration(ticket_id, *, why):
        arbitrations.append(why)

    monkeypatch.setattr(workflow, "start_arbitration", fake_arbitration)
    for note in (
        "test failed: tests/test_calc.py::test_add assert 1 == 2",
        "test failed: tests/test_calc.py::test_sub assert 3 == 4",
    ):
        await workflow.send_back(
            tid, to_role="dev", note=note, by="Checks", from_role="checks"
        )
    for _ in range(2):
        await workflow.send_back(
            tid,
            to_role="dev",
            note="Change this first",
            by="An Nguyen",
            from_role="person",
        )
    async with env["maker"]() as s:
        assert (await s.get(AiTicketWorkflow, tid)).state == "active"
    assert arbitrations == []
    # two AIs repeating themselves still stop
    for _ in range(2):
        await workflow.send_back(
            tid,
            to_role="dev",
            note="the cost field does not belong in the API",
            by="Reviewer",
            from_role="reviewer",
        )
    assert len(arbitrations) == 1


async def test_a_ruling_for_the_dev_never_skips_the_checks_or_the_review(env, moved):
    pid, tid, _ = await _attached(env)
    rows = await _rows(env, tid)
    await _set(env, AiTicketStep, rows["triage"].id, state="done")
    await _set(env, AiTicketStep, rows["fix"].id, state="blocked")
    await _set(env, AiTicketWorkflow, tid, state="stopped", stop_reason="no_progress")
    await workflow.apply_ruling(tid, "dev", by="An Nguyen", reason="It is fine.")
    rows = await _rows(env, tid)
    assert rows["fix"].state == "skipped"
    assert rows["checks"].state == "pending"
    assert rows["review"].state == "pending"
    assert "developer is right" in rows["review"].note_in


# --------------------------------------------------------------------------- finding 7: stopped runs, one advance


async def test_sending_back_or_skipping_an_active_step_stops_its_run(
    env, moved, monkeypatch
):
    pid, tid, team = await _attached(env)
    cancelled = []

    async def fake_cancel(run_id, **kw):
        cancelled.append(run_id)

    monkeypatch.setattr(runs, "cancel", fake_cancel)
    rows = await _rows(env, tid)
    review_run = await _run(
        env, pid, tid, team["reviewer"], state="finished", trigger="workflow"
    )
    await _set(
        env,
        AiTicketStep,
        rows["review"].id,
        state="active",
        run_id=review_run,
        member_id=team["reviewer"],
    )
    await workflow.send_back(
        tid, to_role="dev", note="Do it again", by="An Nguyen", from_role="person"
    )
    assert cancelled == [review_run]
    async with env["maker"]() as s:
        assert (await s.get(AiTicketStep, rows["review"].id)).state == "superseded"
    moved.clear()
    await workflow.on_run_ended(review_run)  # its end moves nothing
    async with env["maker"]() as s:
        assert (await s.get(AiTicketStep, rows["review"].id)).state == "superseded"
    assert moved == []
    fix = (await _rows(env, tid))["fix"]
    fix_run = await _run(
        env, pid, tid, team["dev"], state="running", trigger="workflow"
    )
    await _set(env, AiTicketStep, fix.id, state="active", run_id=fix_run)
    await workflow.skip_step(tid, by="An Nguyen", step_id=fix.id)
    assert cancelled == [review_run, fix_run]


async def test_two_callers_never_both_start_the_same_step(env, monkeypatch):
    pid, tid, team = await _attached(env)
    started = []

    async def slow_create_run(session, **kw):
        started.append(kw["member_id"])
        await asyncio.sleep(0.05)
        return SimpleNamespace(id=f"run_fake_{len(started)}")

    monkeypatch.setattr(runs, "create_run", slow_create_run)
    await asyncio.gather(workflow.advance(tid), workflow.advance(tid))
    assert started == [team["triage"]]


# --------------------------------------------------------------------------- finding 8: Triage on a re-attached workflow


async def test_triage_switching_templates_on_a_reattached_workflow_keeps_its_steps(
    env, moved
):
    pid, tid, team = await _attached(env, roles=("triage", "dev", "reviewer", "ba"))
    async with env["maker"]() as s:
        await workflow.detach(s, tid, by="An Nguyen")
        await workflow.attach(
            s, await s.get(Ticket, tid), "quick_fix", by="An Nguyen", start=False
        )
    triage = (await _rows(env, tid))["triage"]
    run_id = await _run(
        env,
        pid,
        tid,
        team["triage"],
        state="finished",
        trigger="workflow",
        summary="Sorted it.\nDEPTH: light\nWORKFLOW: research",
    )
    await _set(env, AiTicketStep, triage.id, state="active", run_id=run_id)
    await workflow.on_run_ended(run_id)
    async with env["maker"]() as s:
        view = await workflow.view(s, tid)
    assert view["template_key"] == "research"
    assert [r["key"] for r in view["steps"]] == [
        "triage",
        "investigate",
        "write_up",
        "done",
    ]
    assert view["state"] == "active"


# --------------------------------------------------------------------------- finding 9: Needs you closes


async def test_done_closes_the_arbitration_that_waited_for_a_person(env, moved):
    pid, tid, _ = await _attached(env)
    async with env["maker"]() as s:
        await flags.open_flag(s, tid, pid, "arbitration", {"why": "no progress"})
    await workflow.on_ticket_done(tid)
    async with env["maker"]() as s:
        assert not await flags.is_open(s, tid, "arbitration")


async def test_detach_closes_the_step_that_waited_for_a_person(env, moved):
    c = env["c"]
    pid2, tid2, _ = await _attached(
        env, template="feature_ui", roles=("triage", "ba", "designer")
    )
    rows = await _rows(env, tid2)
    await _set(env, AiTicketStep, rows["approve_design"].id, state="waiting")
    async with env["maker"]() as s:
        await workflow._tell_person(
            s,
            await s.get(Ticket, tid2),
            await s.get(AiTicketStep, rows["approve_design"].id),
        )
    panel = (
        await c.get("/notifications", params={"view": "panel", "tab": "needs"})
    ).json()
    assert any(i["kind"] == "workflow_step" for i in panel["items"])
    async with env["maker"]() as s:
        await workflow.detach(s, tid2, by="An Nguyen")
    async with env["maker"]() as s:
        open_rows = (
            await s.exec(
                select(Notification).where(
                    Notification.kind == "workflow_step",
                    col(Notification.done_at).is_(None),
                )
            )
        ).all()
    assert open_rows == []


# --------------------------------------------------------------------------- finding 10: the coordinator


async def test_a_paused_or_involved_pm_is_not_the_coordinator(env):
    pid, tid, team = await _attached(env, roles=("triage", "dev", "reviewer", "pm"))
    async with env["maker"]() as s:
        assert (await workflow.coordinator(s, pid)).id == team["pm"]
        assert await workflow.coordinator(s, pid, {team["pm"]}) is None
    await _set(env, AiMember, team["pm"], paused=True)
    async with env["maker"]() as s:
        assert await workflow.coordinator(s, pid) is None


async def test_a_coordinator_that_cannot_start_hands_it_to_a_person(env, monkeypatch):
    c = env["c"]
    pid, tid, team = await _attached(env, roles=("triage", "dev", "reviewer", "pm"))

    async def no_slot(session, **kw):
        raise runs.RunError("The account has no room.")

    monkeypatch.setattr(runs, "create_run", no_slot)
    assert await workflow.start_arbitration(tid, why="Going round.") is None
    async with env["maker"]() as s:
        flag = await flags.current(s, tid, "arbitration")
    assert isinstance(flag, AiTicketFlag)
    assert json.loads(flag.data)["with"] == "person"
    panel = (
        await c.get("/notifications", params={"view": "panel", "tab": "needs"})
    ).json()
    row = next(i for i in panel["items"] if i["kind"] == "arbitration")
    assert "could not start" in row["title"]
