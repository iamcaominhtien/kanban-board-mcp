"""AI memory (issue #274): a run keeps its own notes (its role's, and on its ticket), they reach the next run, a run
records which lessons and notes its prompt carried, an outside agent reads the memory and proposes a lesson over MCP,
and stale memory is flagged for a person."""

import json

import pytest

from models import Member
from services import shared_skills
from services.ai import board_skills, memory
from services.ai.context import RunContext
from tests.ai_helpers import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401


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
