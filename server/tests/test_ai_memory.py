"""AI memory (issue #274): a run keeps its own notes (its role's, and on its ticket), they reach the next run, a run
records which lessons and notes its prompt carried, an outside agent reads the memory and proposes a lesson over MCP,
and stale memory is flagged for a person."""

import json

import pytest

from models import AiLesson, AiMember, AiRun, Member
from services import shared_skills
from services.ai import board_skills, guard, knowledge, memory
from services.ai.context import RunContext
from tests.test_ai import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _system_of(record) -> str:
    last = [json.loads(x) for x in record.read_text().splitlines()][-1]
    return last[last.index("--append-system-prompt") + 1]


async def _dev(c, pid, repo, name="Dev An"):
    m = await _runner(c, pid, repo, name=name)
    r = await c.patch(f"/ai/members/{m['id']}", json={"config": {"role": "dev"}})
    assert r.status_code == 200, r.text
    return m


async def _as_run(env, member_id: str, ticket_id: str, run_id: str = "run_test"):
    async with env["maker"]() as s:
        member = await s.get(Member, member_id)
        project_id = member.project_id
    return RunContext(
        run_id=run_id,
        member_id=member_id,
        member_name=member.name,
        project_id=project_id,
        ticket_id=ticket_id,
        on_behalf_of="An Nguyen",
        mode="work",
    )


async def test_a_note_one_run_keeps_reaches_the_next_run_of_its_role_on_another_ticket(
    env, monkeypatch, tmp_path
):
    """Done when (#274): what one run learned on one ticket changes what the next run gets on another."""
    from kanban_mcp.tools.knowledge import knowledge as tool

    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    dev = await _dev(c, pid, env["repo"])
    first = await _ticket(c, pid, title="First")
    second = await _ticket(c, pid, title="Second")

    tokens = guard.enter(await _as_run(env, dev["id"], first))
    try:
        kept = await tool(
            action="remember",
            text="Run the UI tests with npm test -- --run: plain npm test watches and never ends.",
        )
        on_ticket = await tool(
            action="remember",
            scope="ticket",
            text="Tried the cache fix first: it broke login. Start from the CSV export.",
        )
        feedback = await tool(
            action="remember",
            kind="feedback",
            text="An wants every comment in Vietnamese.",
        )
    finally:
        guard.leave(tokens)
    assert kept["result"] == "added" and kept["note"]["scope"] == "role"
    assert kept["note"]["scope_key"] == "dev"
    assert on_ticket["note"]["scope_key"] == first
    assert feedback["note"]["kind"] == "feedback"

    await c.post(
        f"/tickets/{second}/ai/assign", json={"member_id": dev["id"], "start": "now"}
    )
    run = await _wait(c, second, ("finished",))
    system = _system_of(record)
    assert "npm test -- --run" in system
    assert "(a person said) An wants every comment in Vietnamese." in system
    # the first ticket's note stays on the first ticket
    assert "cache fix" not in system
    used = run["memory_used"]
    assert {n["id"] for n in used["notes"]} == {
        kept["note"]["id"],
        feedback["note"]["id"],
    }

    # a second Dev reads the same role notes; a run on the first ticket reads its ticket note
    other = await _dev(c, pid, env["repo"], name="Dev Binh")
    await c.post(
        f"/tickets/{first}/ai/assign", json={"member_id": other["id"], "start": "now"}
    )
    run = await _wait(c, first, ("finished",))
    system = _system_of(record)
    assert "cache fix" in system and "npm test -- --run" in system
    assert len(run["memory_used"]["notes"]) == 3

    page = (await c.get(f"/projects/{pid}/ai/knowledge")).json()
    labels = {n["id"]: n["scope_label"] for n in page["notes"]}
    assert labels[kept["note"]["id"]] == "Dev"
    assert labels[on_ticket["note"]["id"]].startswith(first)


async def test_kept_lessons_used_by_a_run_are_recorded_on_it_and_in_the_history(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(tmp_path / "args.jsonl"))
    pid, _ = await _project(c)
    lesson = (
        await c.post(
            f"/projects/{pid}/ai/lessons",
            json={"text": "Start the dev server in the background."},
        )
    ).json()
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("finished",))
    assert run["memory_used"]["lessons"] == [
        {"id": lesson["id"], "text": "Start the dev server in the background."}
    ]
    hist = (await c.get("/ai/history", params={"project_id": pid})).json()
    rows = hist["runs"] if isinstance(hist, dict) else hist
    assert rows[0]["memory_used"]["lessons"][0]["id"] == lesson["id"]


async def test_an_api_key_member_gets_the_project_memory_too(env):
    """It never did: the API-key prompt was built without the instructions or lessons."""
    from services.ai import api_prompt
    from services.ai.providers import merged_config

    c = env["c"]
    pid, _ = await _project(c)
    await c.put(
        f"/projects/{pid}/ai/knowledge/instructions",
        json={"instructions": "Answer in Vietnamese."},
    )
    await c.post(
        f"/projects/{pid}/ai/lessons", json={"text": "The CSV export quotes commas."}
    )
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    ctx = await _as_run(env, m["id"], tid)
    async with env["maker"]() as s:
        profile = await s.get(AiMember, m["id"])
        member = await s.get(Member, m["id"])
        from models import Project, Ticket

        out = await api_prompt.compose(
            s,
            profile,
            member,
            await s.get(Ticket, tid),
            await s.get(Project, pid),
            merged_config({}),
            ctx=ctx,
            instruction="Look at it",
            include_context=True,
        )
    assert "Answer in Vietnamese." in out["system"]
    assert "The CSV export quotes commas." in out["system"]


async def test_an_outside_agent_reads_the_memory_proposes_a_lesson_and_leaves_a_ticket_note(
    env,
):
    from kanban_mcp.tools.knowledge import knowledge as tool

    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid)
    await c.put(
        f"/projects/{pid}/ai/knowledge/instructions",
        json={"instructions": "Tests: uv run pytest."},
    )
    proposed = await tool(
        action="remember",
        project_id=pid,
        text="Migrations need uv run alembic revision --autogenerate.",
    )
    assert proposed["lesson"]["state"] == "proposed"
    note = await tool(
        action="remember",
        project_id=pid,
        scope="ticket",
        ticket_id=tid,
        text="The bug only shows with two tabs open.",
    )
    assert note["note"]["scope"] == "ticket"
    with pytest.raises(ValueError, match="Role notes are kept by a board run"):
        await tool(action="remember", project_id=pid, scope="role", text="x")
    mem = await tool(action="memory", project_id=pid)
    assert mem["instructions"] == "Tests: uv run pytest."
    assert mem["lessons"][0]["state"] == "proposed"
    assert mem["notes"][0]["text"] == "The bug only shows with two tabs open."
    # a proposal is counted where a person sees it, and tells the owners
    page = (await c.get(f"/projects/{pid}/ai/knowledge")).json()
    assert page["proposals"] == 1
    gone = await tool(action="forget", project_id=pid, note_id=note["note"]["id"])
    assert gone["forgot"] == note["note"]["id"]


async def test_notes_are_capped_deduplicated_replaced_and_editable_by_a_person(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        first, what = await memory.write(s, pid, "ticket", tid, "One", by="Dev An")
        assert what == "added"
        _same, what = await memory.write(s, pid, "ticket", tid, "one", by="Dev An")
        assert what == "unchanged"
        for i in range(memory.MAX_NOTES["ticket"] - 1):
            await memory.write(s, pid, "ticket", tid, f"Fact {i}", by="Dev An")
        with pytest.raises(ValueError, match="memory is full"):
            await memory.write(s, pid, "ticket", tid, "One too many", by="Dev An")
        row, what = await memory.write(
            s, pid, "ticket", tid, "One, corrected", by="Dev An", note_id=first.id
        )
        assert what == "updated" and row.text == "One, corrected"
    r = await c.patch(f"/ai/notes/{first.id}", json={"text": "Edited by An"})
    assert r.status_code == 200 and r.json()["written_by"]
    assert (await c.delete(f"/ai/notes/{first.id}")).status_code == 204
    r = await c.post(
        f"/projects/{pid}/ai/notes",
        json={
            "text": "Use the colour tokens.",
            "scope": "role",
            "scope_key": "designer",
        },
    )
    assert r.status_code == 201 and r.json()["kind"] == "feedback"


async def test_notes_switched_off_keep_them_out_of_the_prompt_and_refuse_a_write(env):
    from kanban_mcp.tools.knowledge import knowledge as tool

    c = env["c"]
    pid, _ = await _project(c)
    dev = await _dev(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        await memory.write(s, pid, "role", "dev", "A Dev note.", by="Dev An")
    r = await c.patch(f"/projects/{pid}/ai/ops", json={"ai_notes": False})
    assert r.status_code == 200, r.text
    tokens = guard.enter(await _as_run(env, dev["id"], tid))
    try:
        with pytest.raises(ValueError, match="switched off"):
            await tool(action="remember", text="Something")
    finally:
        guard.leave(tokens)
    async with env["maker"]() as s:
        run = AiRun(project_id=pid, ticket_id=tid, member_id=dev["id"])
        s.add(run)
        await s.commit()
        profile = await s.get(AiMember, dev["id"])
        text = await knowledge.for_run(s, run, profile)
    assert "A Dev note." not in text


async def test_stale_memory_is_flagged_for_a_person(env, tmp_path):
    c = env["c"]
    pid, _ = await _project(c)
    repo = tmp_path / "repo"
    (repo / "server").mkdir(parents=True)
    (repo / "server" / "models.py").write_text("")
    await _runner(c, pid, str(repo))
    gone = (
        await c.post(
            f"/projects/{pid}/ai/lessons",
            json={
                "text": "Settings live in server/old_config.py, not in server/models.py."
            },
        )
    ).json()
    fine = (
        await c.post(
            f"/projects/{pid}/ai/lessons",
            json={"text": "The models are in server/models.py."},
        )
    ).json()
    async with env["maker"]() as s:
        old, _ = await memory.write(
            s,
            pid,
            "role",
            "dev",
            "Always run the dev server with npm run dev in the foreground.",
            by="Dev An",
        )
        new, _ = await memory.write(
            s,
            pid,
            "role",
            "dev",
            "Never run the dev server with npm run dev in the foreground.",
            by="Dev Binh",
        )
        # make the order certain
        old.created_at, new.created_at = "2026-01-01T00:00:00", "2026-02-01T00:00:00"
        s.add(old)
        s.add(new)
        await s.commit()
    flags: dict = {}
    for f in (await c.get(f"/projects/{pid}/ai/knowledge")).json()["flags"]:
        flags.setdefault(f["id"], []).append(f)
    assert flags[gone["id"]][0]["kind"] == "missing_path"
    assert flags[gone["id"]][0]["paths"] == ["server/old_config.py"]
    assert fine["id"] not in flags
    assert flags[old.id][0]["kind"] == "newer"
    assert "contradict" in flags[old.id][0]["text"]
    assert new.id not in flags


def test_paths_in_finds_files_and_folders_not_urls():
    assert memory.paths_in(
        "Edit `ui/src/App.tsx` and server/models.py; see https://x.io/a/b.py and docs/."
    ) == ["ui/src/App.tsx", "server/models.py", "docs"]


def test_the_keeping_memory_skill_is_shared_by_every_role_and_served_to_outside_agents():
    names = [n for n, _d, _b in shared_skills.SKILLS]
    assert "keeping-memory" in names
    assert "keeping-memory" in board_skills.enabled_for({}, "mem_x", role="qa")
    assert "keeping-memory" in board_skills.enabled_for({}, "mem_x", role=None)
    assert board_skills._skills()["keeping-memory"].endswith(
        shared_skills.guides()["keeping-memory"]
    )
    assert any("knowledge(action='remember'" in r for r in shared_skills.CORE_RULES)


async def test_a_lesson_proposed_by_a_diagnosis_tells_a_person(env, monkeypatch):
    from services import notifications as centre

    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        run = AiRun(project_id=pid, ticket_id=tid, member_id=m["id"])
        s.add(run)
        await s.commit()
        run_id = run.id
    sent = []

    async def emit(kind, **kw):
        sent.append((kind, kw.get("title")))

    monkeypatch.setattr(centre, "emit", emit)
    row = await knowledge.propose_from_diagnosis(
        run_id, "Run the dev server in the background."
    )
    assert isinstance(row, AiLesson) and row.state == "proposed"
    assert sent and sent[0][0] == "lesson"


# --- kept without the AI's initiative (the live check: two sonnet runs kept nothing by themselves) ---


async def test_a_reports_learned_is_kept_as_notes_and_shown_as_steps(env):
    from services.ai import runs

    c = env["c"]
    pid, _ = await _project(c)
    dev = await _dev(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        run = AiRun(project_id=pid, ticket_id=tid, member_id=dev["id"])
        s.add(run)
        await s.commit()
        run_id = run.id
    ctx = await _as_run(env, dev["id"], tid, run_id=run_id)
    out = await runs.record_report(
        ctx,
        "Fixed it.",
        [],
        None,
        [
            {
                "text": "Run the tests with ./test.sh --once; python3 -m unittest is refused."
            },
            {"text": "An wants reports in Vietnamese.", "kind": "feedback"},
            {"text": "The header row is still to do.", "scope": "ticket"},
            "A plain string is a note too.",
        ],
    )
    assert out["remembered"] == 4
    async with env["maker"]() as s:
        kept = await memory.notes(s, pid)
        row = await s.get(AiRun, run_id)
    by_scope = {(n.scope, n.scope_key, n.kind) for n in kept}
    assert ("role", "dev", "learned") in by_scope
    assert ("role", "dev", "feedback") in by_scope
    assert ("ticket", tid, "learned") in by_scope
    steps = json.loads(row.steps)
    assert sum(1 for x in steps if x.get("kind") == "memory") == 4
    assert len(json.loads(row.report)["learned"]["kept"]) == 4
    # nothing learned: nothing kept, no noise in the answer
    assert "remembered" not in await runs.record_report(ctx, "Again.", [], None, [])


async def test_when_a_run_kept_nothing_a_light_model_keeps_notes_for_its_role(
    env, monkeypatch
):
    from services.ai import transcripts

    c = env["c"]
    pid, an = await _project(c)
    dev = await _dev(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/comments",
        json={
            "author": "An Nguyen",
            "text": "Từ giờ hãy viết báo cáo bằng tiếng Việt nhé.",
        },
    )
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid, ticket_id=tid, member_id=dev["id"], state="finished"
        )
        s.add(run)
        await s.commit()
        run_id = run.id
    seen = {}

    async def fake_read(rid):
        return [{"k": "note", "text": "Ran python3 -m unittest: refused"}]

    async def fake_model(prompt, profile, account):
        seen["prompt"] = prompt
        return json.dumps(
            {
                "notes": [
                    {
                        "text": "Run the tests with ./test.sh --once; python3 -m unittest is refused here."
                    },
                    {
                        "text": "An wants reports written in Vietnamese.",
                        "kind": "feedback",
                    },
                ]
            }
        )

    monkeypatch.setattr(transcripts, "read", fake_read)
    monkeypatch.setattr(knowledge, "_ask_light_model", fake_model)
    kept = await memory.extract_from_run(run_id)
    assert [(n.scope, n.scope_key, n.kind) for n in kept] == [
        ("role", "dev", "learned"),
        ("role", "dev", "feedback"),
    ]
    assert kept[0].written_by == "the board, from Dev An's run"
    # the model was given the person's comment and the run
    assert "tiếng Việt" in seen["prompt"] and "python3 -m unittest" in seen["prompt"]
    # once per run
    assert await memory.extract_from_run(run_id) == []


@pytest.mark.memory_extraction
async def test_a_run_that_ends_starts_the_light_model_in_the_background(
    env, monkeypatch
):
    """The wiring the other tests leave out (conftest turns it off for every unmarked test): a run's end calls the
    extraction for that run."""
    import asyncio

    c = env["c"]
    pid, _ = await _project(c)
    dev = await _dev(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    seen: list[str] = []

    async def fake_extract(run_id):
        seen.append(run_id)
        return []

    monkeypatch.setattr(memory, "extract_from_run", fake_extract)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": dev["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("finished", "failed"))
    for _ in range(50):
        if seen:
            break
        await asyncio.sleep(0.05)
    assert seen == [run["id"]]


async def test_the_light_model_adds_what_a_run_missed_and_sees_what_it_kept(
    env, monkeypatch
):
    """The live check: Dev An kept a command in its report and not the person's request for Vietnamese."""
    from services.ai import runs, transcripts

    c = env["c"]
    pid, _ = await _project(c)
    dev = await _dev(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        run = AiRun(project_id=pid, ticket_id=tid, member_id=dev["id"], state="running")
        s.add(run)
        await s.commit()
        run_id = run.id
    ctx = await _as_run(env, dev["id"], tid, run_id=run_id)
    await runs.record_report(
        ctx, "Done.", [], None, [{"text": "Tests use unittest here."}]
    )
    async with env["maker"]() as s:
        row = await s.get(AiRun, run_id)
        row.state = "finished"
        s.add(row)
        await s.commit()
    seen = {}

    async def fake_read(rid):
        return [{"k": "note", "text": "done"}]

    async def fake_model(prompt, profile, account):
        seen["prompt"] = prompt
        return '{"notes": [{"text": "An wants reports in Vietnamese.", "kind": "feedback"}]}'

    monkeypatch.setattr(transcripts, "read", fake_read)
    monkeypatch.setattr(knowledge, "_ask_light_model", fake_model)
    kept = await memory.extract_from_run(run_id)
    assert [n.kind for n in kept] == ["feedback"]
    assert "Tests use unittest here." in seen["prompt"]


async def test_no_light_model_notes_when_notes_are_off_or_the_run_did_not_end(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    dev = await _dev(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    called = []

    async def fake_model(*a):
        called.append(1)
        return "{}"

    monkeypatch.setattr(knowledge, "_ask_light_model", fake_model)
    async with env["maker"]() as s:
        waiting = AiRun(
            project_id=pid, ticket_id=tid, member_id=dev["id"], state="needs_input"
        )
        s.add(waiting)
        await s.commit()
        waiting_id = waiting.id
    assert await memory.extract_from_run(waiting_id) == []
    await c.patch(f"/projects/{pid}/ai/ops", json={"ai_notes": False})
    async with env["maker"]() as s:
        done = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=dev["id"],
            state="finished",
            number=2,
        )
        s.add(done)
        await s.commit()
        done_id = done.id
    assert await memory.extract_from_run(done_id) == []
    assert called == []


def test_parse_notes_keeps_at_most_three_clean_notes():
    text = 'x {"notes": [{"text": " a  b "}, {"text": ""}, {"text": "c", "kind": "feedback"}, {"text": "d"}, {"text": "e"}]} y'
    assert memory.parse_notes(text) == [
        {"text": "a b", "kind": "learned"},
        {"text": "c", "kind": "feedback"},
    ]
    assert memory.parse_notes("no json") == []
