"""The team runs itself (D8, D24; services/ai/manager.py), against the fake CLI playing each role: intake takes new
tickets, a blocked step starts again by itself, a ticket stops at its token cap, the Dev step needs test-first
evidence, the board moves a reviewed ticket to Done when the person allows it, a failed step goes to the PM before a
person, and the PM splits a ticket Triage says is several pieces of work."""

import asyncio

import pytest

from models import AiProjectSettings, AiRun, AiTicketStep
from services.ai import autopilot, manager, workflow
from tests.test_ai import FAKE, _project, _ticket, env  # noqa: F401
from tests.test_ai_workflow import _at_done, _current, _team, _until


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


async def _ops(c, pid, **patch):
    r = await c.patch(f"/projects/{pid}/ai/ops", json=patch)
    assert r.status_code == 200, r.text
    return r.json()


async def _settle():
    """Let the background tasks an event started (intake, the manager) run."""
    for _ in range(20):
        await asyncio.sleep(0.05)


async def _wf(c, tid, timeout=20.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        view = (await c.get(f"/tickets/{tid}/ai/workflow")).json()
        if view:
            return view
        await asyncio.sleep(0.1)
    return None


# --------------------------------------------------------------------------- intake


async def test_intake_takes_only_new_unassigned_tickets_in_its_column(env):
    c = env["c"]
    pid, an = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    before = await _ticket(c, pid, title="Was here before")
    out = await _ops(
        c, pid, intake={"on": True, "status": "todo"}, workflow_default="quick_fix"
    )
    assert out["intake"]["since"]  # dated: the backlog that was there is not started
    new = await _ticket(c, pid, title="Fix sub()")
    mine = await _ticket(c, pid, title="Mine", assignee=an)
    elsewhere = await _ticket(c, pid, title="Later", status="backlog")
    view = await _until(c, new, _at_done)
    assert view["template_key"] == "quick_fix"
    await _settle()
    for tid in (before, mine, elsewhere):
        assert (await c.get(f"/tickets/{tid}/ai/workflow")).json() is None
    # moved into the column later: taken then
    await c.patch(f"/tickets/{elsewhere}", json={"status": "todo"})
    assert (await _wf(c, elsewhere))["template_key"] == "quick_fix"


async def test_intake_skips_triage_when_the_project_has_none(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("dev", "reviewer"))
    await _ops(c, pid, intake={"on": True}, workflow_default="quick_fix")
    tid = await _ticket(c, pid)
    view = await _until(c, tid, _at_done)
    triage = next(s for s in view["steps"] if s["key"] == "triage")
    assert triage["state"] == "skipped" and "No Triage" in triage["note"]


async def test_the_chosen_triage_takes_new_tickets(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    other = (
        await c.post(
            f"/projects/{pid}/ai/packs/triage/member",
            json={"name": "Triage Two", "working_dir": env["repo"]},
        )
    ).json()
    await c.patch(f"/ai/members/{other['id']}", json={"cli_path": FAKE})
    await _ops(
        c,
        pid,
        intake={"on": True},
        workflow_default="quick_fix",
        triage_id=other["id"],
    )
    tid = await _ticket(c, pid)
    view = await _until(c, tid, _at_done)
    assert view["steps"][0]["member_id"] == other["id"]


# --------------------------------------------------------------------------- blocked steps


async def test_a_blocked_step_asks_a_person_and_starts_by_itself_once_a_member_comes(
    env,
):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, lambda v: _current(v) and _current(v)["state"] == "blocked")
    needs = (await c.get("/notifications?box=needs")).json()
    rows = needs["items"] if isinstance(needs, dict) else needs
    assert any(
        r["kind"] == "workflow_blocked" and r["ticket_id"] == tid for r in rows
    ), rows
    await _team(c, pid, env["repo"], roles=("dev",))  # adding the member is enough
    view = await _until(c, tid, _at_done)
    assert any(s["key"] == "fix" and s["state"] == "done" for s in view["steps"])
    flags = (await c.get(f"/tickets/{tid}/ai/ticket-flags")).json()
    assert all(not f["open"] for f in flags if f["kind"] == "no_member")


async def test_retry_blocked_leaves_a_stopped_workflow_alone(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage",))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, lambda v: _current(v) and _current(v)["state"] == "blocked")
    await c.delete(f"/tickets/{tid}/ai/workflow")
    assert await workflow.retry_blocked(pid) == 0


# --------------------------------------------------------------------------- the token cap (D11)


async def test_a_ticket_stops_at_its_token_cap_and_goes_on_when_a_person_lets_it(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    await _ops(c, pid, ticket_token_cap=200)  # the fake CLI uses 120 a run
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, lambda v: v["state"] == "stopped")
    assert view["stop_reason"] == "quota_cap"
    assert "cap for one ticket is 200" in view["stop_detail"]
    r = await c.post(f"/tickets/{tid}/ai/workflow/resume")
    assert r.status_code == 200, r.text
    await _until(c, tid, _at_done)
    again = await c.post(f"/tickets/{tid}/ai/workflow/resume")
    assert again.status_code == 409


# --------------------------------------------------------------------------- test first (design I)


async def test_no_test_first_evidence_leaves_the_dev_step_unproven_until_a_person_accepts(
    env,
):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, _at_done)
    fix = next(s for s in view["steps"] if s["key"] == "fix")
    assert fix["outcome"] == "unproven"
    r = await c.post(f"/tickets/{tid}/ai/tdd/accept", json={})
    assert r.status_code == 200, r.text
    fix = next(s for s in r.json()["steps"] if s["key"] == "fix")
    assert fix["outcome"] == "accepted"
    assert (await c.post(f"/tickets/{tid}/ai/tdd/accept", json={})).status_code == 409


async def test_turning_the_rule_off_is_a_project_setting(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, _at_done)
    await c.post(f"/tickets/{tid}/ai/tdd/accept", json={"rule_off": True})
    assert (await c.get(f"/projects/{pid}/ai/ops")).json()["tdd"]["required"] is False
    other = await _ticket(c, pid, title="Another")
    await c.post(f"/tickets/{other}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, other, _at_done)
    assert next(s for s in view["steps"] if s["key"] == "fix")["outcome"] is None


async def test_with_the_manager_on_the_board_sends_it_back_once_for_test_first(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer", "pm"))
    await _ops(c, pid, manager={"on": True})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, _at_done)
    fixes = [s for s in view["steps"] if s["key"] == "fix"]
    assert len(fixes) == 2  # one send-back, never a loop
    assert "test-first" in fixes[1]["note_in"]
    assert fixes[1]["outcome"] == "unproven"


# --------------------------------------------------------------------------- autonomy


async def test_after_review_the_board_moves_a_passed_ticket_to_done(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    await _ops(c, pid, autonomy={"done": "after_review"}, tdd={"required": False})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    # the workflow ends as the ticket reaches Done, a moment before the board marks the last step as its own move
    view = await _until(
        c, tid, lambda v: v["state"] == "done" and v["steps"][-1]["outcome"] == "board"
    )
    done = next(s for s in view["steps"] if s["key"] == "done")
    assert done["outcome"] == "board"
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "done"


async def test_after_review_still_waits_for_a_person_without_test_first_evidence(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    await _ops(c, pid, autonomy={"done": "after_review"})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, _at_done)
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "review"


async def test_after_review_waits_when_the_review_asked_for_changes(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    verdicts = tmp_path / "verdicts.txt"
    verdicts.write_text("CHANGES a\nCHANGES b\nCHANGES c\nCHANGES d\n")
    monkeypatch.setenv("FAKE_CLAUDE_REVIEW_FILE", str(verdicts))
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    await _ops(c, pid, autonomy={"done": "after_review"}, tdd={"required": False})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, lambda v: v["state"] == "stopped" or _at_done(v))
    assert (await c.get(f"/tickets/{tid}")).json()["status"] != "done"


# --------------------------------------------------------------------------- a failed step


def _fail(monkeypatch, tmp_path, times: int):
    left = tmp_path / "fail.txt"
    left.write_text(str(times))
    monkeypatch.setenv("FAKE_CLAUDE_FAIL_FILE", str(left))
    monkeypatch.setenv("FAKE_CLAUDE_FAIL_STEP", "step “Fix”")


async def test_a_failed_step_is_tried_again_then_the_pm_decides(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    _fail(monkeypatch, tmp_path, 2)
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer", "pm"))
    await _ops(c, pid, manager={"on": True}, tdd={"required": False})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, _at_done, timeout=90)
    async with env["maker"]() as s:
        from sqlmodel import select

        rows = (
            await s.exec(
                select(AiTicketStep)
                .where(AiTicketStep.ticket_id == tid, AiTicketStep.key == "fix")
                .order_by(AiTicketStep.seq)
            )
        ).all()
        pm_runs = (
            await s.exec(
                select(AiRun).where(
                    AiRun.ticket_id == tid, AiRun.member_id == team["pm"]
                )
            )
        ).all()
    assert [r.outcome for r in rows][:2] == ["retried", "retried_by_pm"]
    assert rows[-1].state == "done"
    assert "run the tests with -x first" in rows[-1].note_in
    assert [r.trigger for r in pm_runs] == ["manager"]


async def test_the_pm_passes_a_failed_step_to_a_person(env, monkeypatch, tmp_path):
    c = env["c"]
    _fail(monkeypatch, tmp_path, 5)
    monkeypatch.setenv(
        "FAKE_CLAUDE_DECISION", "PERSON the test database needs a password"
    )
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer", "pm"))
    await _ops(c, pid, manager={"on": True})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})

    async def flagged():
        for _ in range(600):
            got = (await c.get(f"/tickets/{tid}/ai/ticket-flags")).json()
            hit = [f for f in got if f["kind"] == "step_blocked" and f["open"]]
            if hit:
                return hit[0]
            await asyncio.sleep(0.1)
        raise AssertionError("never passed to a person")

    flag = await flagged()
    assert flag["data"]["why"] == "failed"


async def test_without_the_manager_a_failed_step_waits_as_before(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    _fail(monkeypatch, tmp_path, 5)
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(
        c, tid, lambda v: _current(v) and _current(v)["state"] == "failed"
    )
    assert len([s for s in view["steps"] if s["key"] == "fix"]) == 1


# --------------------------------------------------------------------------- splitting


async def test_triage_says_split_the_pm_splits_and_the_parent_ends_with_its_pieces(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    gate = tmp_path / "split.gate"
    monkeypatch.setenv("FAKE_CLAUDE_SPLIT", "a login page and an export")
    monkeypatch.setenv("FAKE_CLAUDE_SPLIT_GATE", str(gate))
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer", "pm"))
    await _ops(
        c,
        pid,
        manager={"on": True},
        tdd={"required": False},
        autonomy={"done": "after_review"},
        workflow_default="quick_fix",  # the pieces go on the project's default workflow
    )
    parent = await _ticket(c, pid, title="Login and export")
    await c.post(f"/tickets/{parent}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, parent, lambda v: v["state"] == "stopped")
    # the PM "works": the pieces appear while its run is going, then it ends
    for _ in range(300):
        async with env["maker"]() as s:
            from sqlmodel import select

            going = (
                await s.exec(
                    select(AiRun).where(
                        AiRun.ticket_id == parent,
                        AiRun.member_id == team["pm"],
                        AiRun.state == "running",
                    )
                )
            ).first()
        if going:
            break
        await asyncio.sleep(0.1)
    assert going is not None
    monkeypatch.delenv("FAKE_CLAUDE_SPLIT")  # the pieces are one piece of work each
    kids = [
        await _ticket(c, pid, title=t, parent_id=parent)
        for t in ("Login page", "Export")
    ]
    await _settle()
    # a piece is not taken by intake while its parent is being split
    for k in kids:
        assert (await c.get(f"/tickets/{k}/ai/workflow")).json() is None
    gate.write_text("go")
    view = await _until(c, parent, lambda v: v["split"] == kids)
    assert "Split into" in view["stop_detail"]
    # one after another: the second waits until the first is Done
    first = await _wf(c, kids[0])
    assert first is not None
    if first["state"] != "done":
        assert (await c.get(f"/tickets/{kids[1]}/ai/workflow")).json() is None
    for kid in kids:
        await _until(c, kid, lambda v: v["state"] == "done", timeout=90)
    await _until(c, parent, lambda v: v["state"] == "done", timeout=30)
    assert (await c.get(f"/tickets/{parent}")).json()["status"] == "done"


async def test_a_split_with_no_pieces_goes_on_as_one_ticket(env, monkeypatch, tmp_path):
    c = env["c"]
    gate = tmp_path / "split.gate"
    gate.write_text("go")
    monkeypatch.setenv("FAKE_CLAUDE_SPLIT", "maybe two things")
    monkeypatch.setenv("FAKE_CLAUDE_SPLIT_GATE", str(gate))
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer", "pm"))
    await _ops(c, pid, manager={"on": True}, tdd={"required": False})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    view = await _until(c, tid, _at_done, timeout=60)
    assert "Not split" in (view["depth_note"] or "")


# --------------------------------------------------------------------------- questions go to the PM


async def test_the_manager_makes_the_pm_the_autopilot_delegate_and_off_undoes_it(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("pm",))
    await _ops(c, pid, manager={"on": True, "max_risk": "low"})
    async with env["maker"]() as s:
        cfg = autopilot.config(await s.get(AiProjectSettings, pid))
    assert cfg["enabled"] and cfg["delegate_id"] == team["pm"]
    assert cfg["max_risk"] == "low" and cfg["enabled_by"] == manager.TRIGGER
    await _ops(c, pid, manager={"on": False})
    async with env["maker"]() as s:
        assert not autopilot.config(await s.get(AiProjectSettings, pid))["enabled"]


async def test_a_persons_own_autopilot_is_left_as_it_is(env):
    c = env["c"]
    pid, an = await _project(c)
    await _team(c, pid, env["repo"], roles=("pm",))
    async with env["maker"]() as s:
        row = await s.get(AiProjectSettings, pid)
        if row is None:
            row = AiProjectSettings(project_id=pid)
        row.autopilot = autopilot.dumps(
            {
                **autopilot.DEFAULTS,
                "enabled": True,
                "delegate_id": an,
                "enabled_by": "user",
            }
        )
        s.add(row)
        await s.commit()
    await _ops(c, pid, manager={"on": True})
    async with env["maker"]() as s:
        cfg = autopilot.config(await s.get(AiProjectSettings, pid))
    assert cfg["delegate_id"] == an


def test_the_lines_the_board_reads_may_be_in_the_last_message_of_a_run_that_reported():
    run = AiRun(
        project_id="p",
        ticket_id="KAN-1",
        member_id="m",
        report='{"summary": "Triaged it: a whole product.", "final": "Triaged it.\\nDEPTH: standard\\nSPLIT: a product"}',
        summary="Triaged it: a whole product.",
    )
    text = workflow.run_text(run)
    assert (
        "SPLIT: a product" in text and text.count("Triaged it: a whole product.") == 1
    )


async def test_a_ticket_moves_to_in_progress_when_an_ai_step_starts(env, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "dev", "reviewer"))
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "quick_fix"})
    await _until(c, tid, lambda v: _current(v) and _current(v)["state"] == "active")
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "in-progress"
    await c.delete(f"/tickets/{tid}/ai/workflow")


async def test_a_question_to_an_ai_at_work_on_the_ticket_is_told_what_that_work_is_doing(
    env, monkeypatch
):
    from services.ai import runs as ai_runs

    c = env["c"]
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("dev",))
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        work = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=team["dev"],
            number=1,
            mode="work",
            state="running",
            instruction="Build the search box",
            steps='[{"at": "10:00:00", "kind": "edit", "text": "Edited src/search.js"}]',
            queued_at="2026-11-02T10:00:00",
        )
        ask = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=team["dev"],
            number=2,
            mode="ask",
            state="queued",
        )
        s.add(work)
        s.add(ask)
        await s.commit()
        block = await ai_runs.own_work_note(s, tid, team["dev"], exclude=ask.id)
    assert (
        "run #1" in block
        and "Edited src/search.js" in block
        and "Build the search box" in block
    )


async def test_the_pm_approves_the_design_when_the_person_hands_it_over(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"])
    await _ops(c, pid, autonomy={"approve": "pm"}, tdd={"required": False})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "feature_ui"})
    view = await _until(
        c,
        tid,
        lambda v: any(
            s["key"] == "build" and s["state"] != "pending" for s in v["steps"]
        ),
        timeout=90,
    )
    approval = next(s for s in view["steps"] if s["key"] == "approve_design")
    assert approval["outcome"] == "approved" and "Pm AI" in approval["note"]
    needs = (await c.get("/notifications?box=needs")).json()
    rows = needs["items"] if isinstance(needs, dict) else needs
    assert not [
        r for r in rows if r.get("ticket_id") == tid and r["kind"] == "workflow_step"
    ]
    async with env["maker"]() as s:
        from sqlmodel import select

        pm_runs = (
            await s.exec(
                select(AiRun).where(
                    AiRun.ticket_id == tid, AiRun.member_id == team["pm"]
                )
            )
        ).all()
    assert [r.trigger for r in pm_runs] == ["manager"]
    await c.delete(f"/tickets/{tid}/ai/workflow")


async def test_the_pm_sends_the_design_back_with_what_to_change(env, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_APPROVAL", "CHANGES draw the error state")
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"])
    await _ops(c, pid, autonomy={"approve": "pm"})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "feature_ui"})
    view = await _until(
        c,
        tid,
        lambda v: len([s for s in v["steps"] if s["key"] == "design"]) >= 2,
        timeout=90,
    )
    again = [s for s in view["steps"] if s["key"] == "design"][-1]
    assert "draw the error state" in (again["note_in"] or "")
    await c.delete(f"/tickets/{tid}/ai/workflow")


async def test_testing_with_no_evidence_goes_back_once_then_is_marked(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("triage", "ba", "dev", "qa", "reviewer"))
    await _ops(c, pid, tdd={"required": False})
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "standard"})
    view = await _until(c, tid, _at_done, timeout=90)
    tests = [s for s in view["steps"] if s["key"] == "test"]
    assert len(tests) == 2 and "no evidence" in tests[1]["note_in"]
    assert tests[1]["outcome"] == "no_evidence"
