"""One AI member in several projects (design/screens/ai-members.md step 3, ai-safety-cost.md A1 scope): linked copies
share settings and one budget, keep their own working folder, and go away when a project is unticked."""

from models import AiMember, AiRun, Member
from services.ai import budget
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401


async def test_projects_add_sync_budget_and_remove(env):
    c, maker = env["c"], env["maker"]
    pid, _ = await _project(c)
    other = (
        await c.post(
            "/projects",
            json={"name": "Mobile App", "prefix": "MOB", "color": "#2F6FB0"},
        )
    ).json()["id"]
    m = await _runner(c, pid, env["repo"])
    projects = (await c.get(f"/ai/members/{m['id']}")).json()["projects"]
    assert {p["name"]: p["on"] for p in projects} == {
        "Kanban Board": True,
        "Mobile App": False,
    }
    r = await c.put(
        f"/ai/members/{m['id']}/projects", json={"project_ids": [pid, other]}
    )
    assert r.status_code == 200, r.text
    copy = next(p for p in r.json() if p["project_id"] == other)
    assert copy["on"] and not copy["original"]
    copy_id = copy["member_id"]
    # The copy is a real AI member of the other project and can work there
    names = [x["name"] for x in (await c.get(f"/projects/{other}/ai/members")).json()]
    assert names == ["Claude Code · Backend"]
    tid = await _ticket(c, other, title="Fix login")
    assert (
        await c.post(
            f"/tickets/{tid}/ai/assign", json={"member_id": copy_id, "start": "none"}
        )
    ).status_code in (200, 201)
    # Editing either copy keeps the shared settings in step; the working folder stays per project
    await c.patch(
        f"/ai/members/{m['id']}", json={"persona": "Be brief.", "max_parallel": 3}
    )
    await c.patch(f"/ai/members/{copy_id}", json={"working_dir": "/tmp"})
    async with maker() as s:
        a, b = await s.get(AiMember, m["id"]), await s.get(AiMember, copy_id)
    assert b.persona == a.persona == "Be brief." and b.max_parallel == 3
    assert (
        a.working_dir == env["repo"]
        and b.working_dir == "/tmp"
        and b.linked_to == m["id"]
    )
    # Pausing one pauses the agent everywhere
    await c.post(f"/ai/members/{copy_id}/pause", json={})
    async with maker() as s:
        assert (await s.get(AiMember, m["id"])).paused
    await c.post(f"/ai/members/{m['id']}/resume")
    # One budget: spend in either project counts for both
    async with maker() as s:
        s.add(
            AiRun(
                project_id=other,
                ticket_id=tid,
                member_id=copy_id,
                state="finished",
                metered=True,
                cost_usd=1.25,
                started_at=budget.today_start().isoformat(),
            )
        )
        await s.commit()
        assert (
            await budget.spent(
                s, budget.today_start(), member_id=m["id"], whole_group=True
            )
            == 1.25
        )
        assert await budget.spent(s, budget.today_start(), member_id=m["id"]) == 0
    # Unticking the project removes the copy; the original project always stays
    r = await c.put(f"/ai/members/{copy_id}/projects", json={"project_ids": []})
    assert {p["name"]: p["on"] for p in r.json()} == {
        "Kanban Board": True,
        "Mobile App": False,
    }
    async with maker() as s:
        assert (await s.get(Member, copy_id)).kind == "ai_removed"


async def test_name_taken_in_the_other_project(env):
    c = env["c"]
    pid, _ = await _project(c)
    other = (
        await c.post(
            "/projects",
            json={"name": "Mobile App", "prefix": "MOB", "color": "#2F6FB0"},
        )
    ).json()["id"]
    await c.post(f"/projects/{other}/members", json={"name": "Claude Code · Backend"})
    m = await _runner(c, pid, env["repo"])
    r = await c.put(f"/ai/members/{m['id']}/projects", json={"project_ids": [other]})
    assert (
        r.status_code == 422
        and "Mobile App" in r.json()["detail"]
        or "already" in r.json()["detail"]
    )
    assert r.status_code == 422
