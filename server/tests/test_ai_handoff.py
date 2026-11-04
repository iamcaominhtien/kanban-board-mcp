"""An AI member hands a ticket to a teammate AI (`ai_run` handoff): the teammate is assigned and gets a work run that
starts on its own, so a project manager AI can run a lifecycle. An @mention in a comment only asks a question."""

import json
from dataclasses import replace

import pytest
from sqlmodel import select

from kanban_mcp.tools.ai_run import ai_run
from models import AiMember, AiRun
from services.ai import guard, runs
from tests.ai_helpers import (  # noqa: F401
    _ctx,
    _runner,
    _ticket,
    env,
)


async def _runs(env, ticket_id):
    async with env["maker"]() as s:
        return (await s.exec(select(AiRun).where(AiRun.ticket_id == ticket_id))).all()


async def _made_by(ctx, pid, title):
    from kanban_mcp.tools.tickets import manage_ticket

    tokens = guard.enter(ctx)
    try:
        return (await manage_ticket(action="create", project_id=pid, title=title))["id"]
    finally:
        guard.leave(tokens)


async def _handoff(ctx, **args):
    tokens = guard.enter(ctx)
    try:
        return await ai_run("handoff", **args)
    finally:
        guard.leave(tokens)


async def test_a_teammate_is_assigned_and_queued_for_work_with_the_instruction(env):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    other = await _made_by(ctx, pid, "Write the brief")
    out = await _handoff(
        ctx, member="ba bao", ticket=other, instruction="Write the page."
    )
    assert out["ok"] and out["member"] == "BA Bao" and out["ticket"] == other
    (run,) = [r for r in await _runs(env, other)]
    assert (run.member_id, run.mode, run.trigger) == (bao["id"], "work", "handoff")
    assert run.started_by == "An Nguyen" and "Write the page." in run.instruction
    assert (await c.get(f"/tickets/{other}")).json()["assignee"] == bao["id"]


async def test_handing_over_this_tickets_own_work_waits_for_this_run(env):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    out = await _handoff(ctx, member=bao["id"], instruction="Take over.")
    assert out["ticket"] == own and "after you finish" in out["note"]
    queued = [r for r in await _runs(env, own) if r.member_id == bao["id"]]
    assert len(queued) == 1 and queued[0].state in ("queued", "waiting")


async def test_it_refuses_self_unknown_names_ask_runs_and_other_projects(env):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    await _runner(c, pid, env["repo"], name="BA Bao")
    with pytest.raises(ValueError, match="yourself"):
        await _handoff(ctx, member=pm["id"])
    with pytest.raises(ValueError, match="Teammates: .*BA Bao"):
        await _handoff(ctx, member="Nobody")
    other_project = (
        await c.post(
            "/projects", json={"name": "Other", "prefix": "OTH", "color": "#2E6F40"}
        )
    ).json()["id"]
    foreign = await _ticket(c, other_project, "elsewhere")
    with pytest.raises(ValueError, match="not found in this project"):
        await _handoff(ctx, member="BA Bao", ticket=foreign)


async def test_autopilot_cannot_hand_work_over(env):
    ask_ctx, pid, _, _, _ = await _ctx(env, mode="ask")
    await _runner(env["c"], pid, env["repo"], name="BA Bao")
    with pytest.raises(ValueError, match="Autopilot cannot hand work over"):
        await _handoff(replace(ask_ctx, trigger="autopilot"), member="BA Bao")


async def test_a_member_who_may_not_assign_cannot_hand_over(env):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="read_only")
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    other = await _ticket(c, pid, "Write the brief")
    with pytest.raises(ValueError):
        await _handoff(ctx, member=bao["id"], ticket=other)
    assert not await _runs(env, other)


async def test_nothing_is_handed_over_while_ai_is_paused(env):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    other = await _made_by(ctx, pid, "Write the brief")
    await c.post(f"/projects/{pid}/ai/pause-all", json={})
    with pytest.raises(ValueError, match="paused"):
        await _handoff(ctx, member=bao["id"], ticket=other)


async def test_the_run_is_told_its_project_id_and_its_teammates(env):

    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    await _runner(c, pid, env["repo"], name="BA Bao")
    async with env["maker"]() as s:
        from services.ai import runs
        from models import AiRun

        run = await s.get(AiRun, ctx.run_id)
        prompt, _, _ = await runs._build_prompt(
            s, run, *(await _profile(s, pm["id"])), resume_note=None
        )
    assert f"project_id` to the tools that ask for one): {pid}" in prompt
    # a member made without a role pack has no role beside its name (one made from a pack: test_role_skills_273)
    assert "Teammate AIs (exact name, then role): BA Bao." in prompt
    assert (
        pm["name"]
        not in prompt.split("Teammate AIs (exact name, then role):")[1].split("\n")[0]
    )


async def _profile(s, member_id):
    from services.ai.store import get_profile

    member, profile = await get_profile(s, member_id)
    return profile, member


async def test_a_reviewer_may_comment_on_a_doc_but_not_edit_it(env):
    from kanban_mcp.tools.docs import docs_write

    c = env["c"]
    ctx, pid, _, rin, own = await _ctx(env, template="reviewer")
    page = (
        await c.post(
            f"/projects/{pid}/docs/pages",
            json={"title": "Brief", "markdown": "## Goals\nSimple."},
        )
    ).json()
    tokens = guard.enter(ctx)
    try:
        thread = await docs_write(
            action="comment",
            page_id=page["id"],
            body="Define simple.",
        )
        assert thread
        with pytest.raises(ValueError, match="Edit docs"):
            await docs_write(
                action="update",
                page_id=page["id"],
                markdown="## Goals\nx",
                base_version=1,
            )
    finally:
        guard.leave(tokens)


# --------------------------------------------------------------------------- plain mentions, hand back, report back


async def test_an_ai_comment_wakes_a_teammate_by_a_plain_at_name(env):
    from services.ai import mentions

    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    await _runner(c, pid, env["repo"], name="BA Bao")
    await _runner(c, pid, env["repo"], name="BA Bao Long")
    text = (
        "@BA Bao Long please check, mail a@BA Bao is not a mention, and @Nobody neither"
    )
    await mentions.from_ai_comment(ctx, own, {"id": "c1", "text": text})
    woken = {r.member_id: r for r in await _runs(env, own) if r.trigger == "mention"}
    names = {
        m["name"]: m["id"] for m in (await c.get(f"/projects/{pid}/ai/members")).json()
    }
    assert set(woken) == {names["BA Bao Long"]}
    assert woken[names["BA Bao Long"]].mode == "ask"


async def test_handing_back_up_the_chain_needs_no_assign_permission(env):
    from services.ai import runs
    from services.ai.context import RunContext

    c = env["c"]
    ctx, pid, _, rin, own = await _ctx(env, template="reviewer")
    pm = await _runner(c, pid, env["repo"], name="PM Mai", template="custom")
    await _runner(c, pid, env["repo"], name="BA Bao")
    # Rin was handed this ticket by PM Mai: PM is up the chain, BA Bao is not
    up = RunContext(**{**ctx.__dict__, "chain": [pm["id"]]})
    out = await _handoff(up, member="PM Mai", instruction="Reviewed, over to you.")
    assert out["ok"] and (await c.get(f"/tickets/{own}")).json()["assignee"] == pm["id"]
    assert runs  # imported for the module under test


async def test_handing_to_a_teammate_needs_no_approval_but_safe_mode_and_read_only_still_stop_it(
    env,
):
    c = env["c"]
    # a developer or reviewer hands work to a teammate that is not up the chain: it is how a team works
    ctx, pid, _, rin, own = await _ctx(env, template="reviewer")
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    out = await _handoff(ctx, member=bao["id"], instruction="Over to you.")
    assert (
        out["ok"] and (await c.get(f"/tickets/{own}")).json()["assignee"] == bao["id"]
    )
    assert (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
        is not None
    )
    pending = (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
    ).json()
    assert pending == []
    # a member in Safe mode changes nothing, so it hands nothing over
    async with env["maker"]() as s:
        prof = await s.get(AiMember, rin["id"])
        prof.safe_mode = True
        s.add(prof)
        await s.commit()
    with pytest.raises(ValueError):
        await _handoff(ctx, member=bao["id"], instruction="Again.")


async def test_the_delegator_is_woken_when_the_delegated_work_ends(env, monkeypatch):
    import asyncio

    from services.ai import runs

    monkeypatch.setattr(runs, "WAKE_RETRY_S", 0.05)

    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    bao = await _runner(c, pid, env["repo"], name="BA Bao", template="custom")
    rin = await _runner(c, pid, env["repo"], name="Reviewer Rin", template="custom")
    child = await _made_by(ctx, pid, "Write the brief")
    await _handoff(ctx, member="BA Bao", ticket=child, instruction="Write it.")
    (bao_run,) = [r for r in await _runs(env, child)]
    assert json.loads(bao_run.report_back) == {"member_id": pm["id"], "ticket_id": own}
    # Bao passes the same ticket to Rin: the duty to report moves with the baton
    from services.ai.context import RunContext

    bao_ctx = RunContext(
        run_id=bao_run.id,
        member_id=bao["id"],
        member_name="BA Bao",
        project_id=pid,
        ticket_id=child,
        on_behalf_of="An Nguyen",
        mode="work",
        chain=[pm["id"]],
    )
    await _handoff(bao_ctx, member="Reviewer Rin", instruction="Review it.")
    await runs._end(bao_run.id, "finished", None)
    assert not [r for r in await _runs(env, own) if r.trigger == "report_back"]
    rin_run = next(r for r in await _runs(env, child) if r.member_id == rin["id"])
    assert json.loads(rin_run.report_back)["member_id"] == pm["id"]
    await runs._end(rin_run.id, "finished", None)
    # the delegator is still busy on its own ticket: the wake is queued behind that run, and so is not lost
    await asyncio.sleep(0.2)
    (waiting,) = [r for r in await _runs(env, own) if r.trigger == "report_back"]
    assert waiting.state == "queued" and waiting.behind_run_id == ctx.run_id
    await runs._end(ctx.run_id, "finished", None)
    for _ in range(60):
        woken = [r for r in await _runs(env, own) if r.trigger == "report_back"]
        if woken:
            break
        await asyncio.sleep(0.05)
    (wake,) = woken
    assert wake.member_id == pm["id"] and wake.mode == "work"
    assert (
        "Reviewer Rin finished the work you handed over on " + child in wake.instruction
    )


async def test_an_ended_work_run_writes_itself_into_the_ticket_work_log(env):
    from services.ai import runs

    c = env["c"]
    ctx, pid, _, dev, own = await _ctx(env, template="custom")
    async with env["maker"]() as s:
        run = await s.get(AiRun, ctx.run_id)
        run.started_at = "2026-10-31T10:00:00+00:00"
        run.files = json.dumps(
            [{"path": "src/todo.js", "added": 12, "removed": 2, "new": False}]
        )
        run.steps = json.dumps(
            [
                {"kind": "command", "text": "Ran node --test"},
                {"kind": "board", "text": "board.docs_write.update(x)"},
            ]
        )
        run.report = json.dumps(
            {"summary": "Added the todo module.", "tests": {"passed": 3, "failed": 0}}
        )
        s.add(run)
        await s.commit()
    await runs._end(ctx.run_id, "finished", None)
    log = (await c.get(f"/tickets/{own}")).json()["work_log"]
    assert len(log) == 1
    entry = log[0]
    assert (
        entry["author"] == dev["name"]
        and entry["kind"] == "fix_attempt"
        and entry["role"] == "Other"
    )
    for part in (
        "**Run #1** finished",
        "Added the todo module.",
        "`src/todo.js` (+12 −2)",
        "Ran node --test",
        "board.docs_write.update(x)",
        "3 passed, 0 failed",
    ):
        assert part in entry["note"]


async def test_a_failed_work_run_is_logged_as_blocked(env):
    from services.ai import runs

    c = env["c"]
    ctx, pid, _, dev, own = await _ctx(env, template="custom")
    await runs._end(ctx.run_id, "failed", "The CLI crashed.")
    log = (await c.get(f"/tickets/{own}")).json()["work_log"]
    assert [e["kind"] for e in log] == ["blocked"] and "The CLI crashed." in log[0][
        "note"
    ]


async def test_an_ask_run_is_not_logged(env):
    from services.ai import runs

    c = env["c"]
    ctx, _, _, _, own = await _ctx(env, mode="ask")
    await runs._end(ctx.run_id, "finished", None)
    assert (await c.get(f"/tickets/{own}")).json()["work_log"] == []


async def _assign_by_edit(ctx, ticket_id, member_id):
    from kanban_mcp.tools.tickets import manage_ticket

    tokens = guard.enter(ctx)
    try:
        return await manage_ticket(
            action="update", ticket_id=ticket_id, assignee=member_id
        )
    finally:
        guard.leave(tokens)


async def test_giving_a_ticket_to_an_ai_by_editing_it_starts_that_ai(env):
    # a handoff written as "change the assignee" left the ticket waiting on an AI nobody started
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    rin = await _runner(c, pid, env["repo"], name="Reviewer Rin")
    other = await _made_by(ctx, pid, "Review the brief")
    await _assign_by_edit(ctx, other, rin["id"])
    (run,) = await _runs(env, other)
    assert (run.member_id, run.mode, run.trigger) == (rin["id"], "work", "handoff")
    assert "assigned" in run.instruction
    # the same edit again does not queue a second run for someone who is already on it
    await _assign_by_edit(ctx, other, rin["id"])
    assert len(await _runs(env, other)) == 1


async def test_a_person_assigning_in_the_board_starts_nothing_here(env):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    rin = await _runner(c, pid, env["repo"], name="Reviewer Rin")
    other = await _made_by(ctx, pid, "Review the brief")
    from kanban_mcp.tools.tickets import manage_ticket

    await manage_ticket(action="update", ticket_id=other, assignee=rin["id"])
    assert await _runs(env, other) == []


async def test_giving_a_ticket_to_a_paused_ai_queues_its_run_for_when_it_is_resumed(
    env,
):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    rin = await _runner(c, pid, env["repo"], name="Reviewer Rin")
    async with env["maker"]() as s:
        profile = await s.get(AiMember, rin["id"])
        profile.paused = True
        s.add(profile)
        await s.commit()
    other = await _made_by(ctx, pid, "Review the brief")
    await _assign_by_edit(ctx, other, rin["id"])
    (run,) = await _runs(env, other)
    assert run.member_id == rin["id"] and run.state == "queued"


async def test_a_handoff_that_cannot_be_queued_does_not_leave_the_ticket_assigned(
    env, monkeypatch
):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    other = await _made_by(ctx, pid, "Write the brief")

    async def refuse(*args, **kwargs):
        raise runs.RunError("BA Bao already has an AI waiting behind its holder")

    monkeypatch.setattr(runs, "create_run", refuse)
    with pytest.raises(ValueError, match="already has an AI waiting"):
        await _handoff(ctx, member="BA Bao", ticket=other, instruction="Write it.")
    assert (await c.get(f"/tickets/{other}")).json()["assignee"] != bao["id"]


async def test_an_assignee_edit_that_starts_nothing_says_so_on_the_ticket(
    env, monkeypatch
):
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    rin = await _runner(c, pid, env["repo"], name="Reviewer Rin")
    other = await _made_by(ctx, pid, "Review the brief")

    async def refuse(*args, **kwargs):
        raise runs.RunError("Reviewer Rin has too many runs today")

    monkeypatch.setattr(runs, "create_run", refuse)
    await _assign_by_edit(ctx, other, rin["id"])
    comments = (await c.get(f"/tickets/{other}")).json()["comments"]
    assert any("no run was started" in x["text"] for x in comments)


async def test_several_teammates_ending_tell_the_busy_delegator_once_with_every_report(
    env, monkeypatch
):
    import asyncio

    monkeypatch.setattr(runs, "WAKE_RETRY_S", 0.05)
    c = env["c"]
    ctx, pid, _, pm, own = await _ctx(env, template="custom")
    members = [
        await _runner(c, pid, env["repo"], name=n, template="custom")
        for n in ("Dev A", "Dev B", "Dev C")
    ]
    tickets = [await _made_by(ctx, pid, f"Piece {i}") for i in range(3)]
    for who, ticket in zip(members, tickets):
        await _handoff(ctx, member=who["name"], ticket=ticket, instruction="Do it.")
    # all three finish while the PM is still working on its own ticket
    for ticket in tickets:
        (r,) = await _runs(env, ticket)
        await runs._end(r.id, "finished", None)
    await asyncio.sleep(0.3)
    (waiting,) = [r for r in await _runs(env, own) if r.trigger == "report_back"]
    for who in ("Dev A", "Dev B", "Dev C"):
        assert f"{who} finished the work you handed over" in waiting.instruction
