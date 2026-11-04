"""AI v2 teams: making, editing, pausing and removing a team; its roles; the project's AI settings."""

import pytest

from services.ai import roles
from tests.ai_helpers import FAKE, _project, _runner, _ticket, env  # noqa: F401


async def test_a_team_is_made_with_its_pack_and_checked(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"], name="Dev An")
    assert team["name"] == "Dev An"
    assert team["kind"] == "ai"
    assert team["pack_key"] == "standard"
    assert [r["key"] for r in team["roles"]] == ["dev", "reviewer", "qa"]
    assert team["permission_mode"] == "bypass"
    assert team["model"] == "haiku"
    assert team["status"]["code"] in ("idle", "runner_missing", "not_logged_in")
    # the fake CLI answers `auth status` as signed in: the runner is found
    assert team["health"] == "ok", team["health_detail"]
    listed = (await c.get(f"/projects/{pid}/ai/teams")).json()
    assert [t["id"] for t in listed] == [team["id"]]
    # the team is a member of the project too: it can be the assignee and the comment author
    members = (await c.get(f"/projects/{pid}/members")).json()
    assert any(m["id"] == team["id"] and m["kind"] == "ai" for m in members)


async def test_names_are_unique_across_people_and_teams(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"], name="Dev An")
    r = await c.post(
        f"/projects/{pid}/ai/teams",
        json={"name": "dev an", "working_dir": env["repo"], "cli_path": FAKE},
    )
    assert r.status_code == 422
    assert "Dev An 2" in r.json()["detail"] or "already" in r.json()["detail"]
    r = await c.post(
        f"/projects/{pid}/ai/teams",
        json={"name": "An Nguyen", "working_dir": env["repo"], "cli_path": FAKE},
    )
    assert r.status_code == 422
    r = await c.post(f"/projects/{pid}/members", json={"name": "Dev An"})
    assert r.status_code in (409, 422)


async def test_edit_pack_roles_and_settings(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    r = await c.patch(
        f"/ai/teams/{team['id']}",
        json={
            "pack_key": "feature_ui",
            "effort": "high",
            "permission_mode": "auto",
            "config": {
                "roles": [
                    {"key": "qa", "off": True},
                    {"key": "security", "model": "opus"},
                ]
            },
        },
    )
    assert r.status_code == 200, r.text
    out = r.json()
    keys = [x["key"] for x in out["roles"]]
    assert "qa" not in keys and keys[-1] == "security"
    assert next(x for x in out["roles"] if x["key"] == "security")["model"] == "opus"
    assert out["effort"] == "high" and out["permission_mode"] == "auto"
    assert (
        await c.patch(f"/ai/teams/{team['id']}", json={"effort": "extreme"})
    ).status_code == 422
    assert (
        await c.patch(f"/ai/teams/{team['id']}", json={"permission_mode": "ask"})
    ).status_code == 422


async def test_pause_resume_and_remove_unassign_the_tickets(env):
    c = env["c"]
    pid, an = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    r = await c.post(f"/ai/teams/{team['id']}/pause", json={"reason": "lunch"})
    assert r.json()["paused"] is True and r.json()["status"]["code"] == "paused"
    r = await c.post(f"/ai/teams/{team['id']}/resume")
    assert r.json()["paused"] is False
    impact = (await c.get(f"/ai/teams/{team['id']}/removal-impact")).json()
    assert [t["id"] for t in impact["open_tickets"]] == [tid]
    r = await c.post(
        f"/ai/teams/{team['id']}/remove",
        json={"tickets": "reassign", "reassign_to": an},
    )
    assert r.status_code == 200, r.text
    ticket = (await c.get(f"/tickets/{tid}")).json()
    assert ticket["assignee"] == an
    assert (await c.get(f"/projects/{pid}/ai/teams")).json() == []
    removed = (await c.get(f"/projects/{pid}/ai/teams?include_removed=true")).json()
    assert removed[0]["kind"] == "ai_removed"


async def test_settings_pause_all_and_overview(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    s = (await c.get(f"/projects/{pid}/ai/settings")).json()
    assert s["permission_mode"] == "bypass" and s["deny_list"] == []
    r = await c.patch(
        f"/projects/{pid}/ai/settings",
        json={
            "deny_list": ["Bash(git push --force*)", " "],
            "lessons_mode": "review",
            "ops": {"live_messages": False},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["deny_list"] == ["Bash(git push --force*)"]
    assert r.json()["lessons_mode"] == "review"
    assert r.json()["ops"]["live_messages"] is False
    assert (
        await c.patch(f"/projects/{pid}/ai/settings", json={"permission_mode": "yolo"})
    ).status_code == 422
    r = await c.post(f"/projects/{pid}/ai/pause-all", json={"reason": "stop"})
    assert r.json()["paused_all"] is True
    over = (await c.get(f"/projects/{pid}/ai/overview")).json()
    assert over["paused_all"] is True
    assert over["teams"][0]["id"] == team["id"]
    assert over["teams"][0]["status"]["code"] == "paused_all"
    r = await c.post(f"/projects/{pid}/ai/resume-all")
    assert r.json()["paused_all"] is False
    board = (await c.get(f"/projects/{pid}/ai/board")).json()
    assert board == {"tickets": {}}


def test_roles_become_agents_json_and_markdown():
    rs = (
        [roles.role_from_pack(p) for p in roles.catalogue_packs()]
        if hasattr(roles, "catalogue_packs")
        else roles.catalogue()
    )
    assert {r["key"] for r in rs} >= {"dev", "reviewer", "qa", "pm", "designer"}
    agents = roles.agents_json(rs[:3], board_rules="Report on the board.")
    for key, spec in agents.items():
        assert spec["description"] and spec["prompt"].endswith("Report on the board.")
    reviewer = next(r for r in rs if r["key"] == "reviewer")
    assert reviewer["tools"] == [
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "WebFetch",
        "WebSearch",
    ]
    md = roles.agent_markdown(reviewer)
    assert md.startswith("---\nname: reviewer\n") and "tools: Read, Glob" in md
    dev = next(r for r in rs if r["key"] == "dev")
    assert dev["tools"] is None  # writes code: every tool of the run


@pytest.mark.parametrize("pack", list(roles.TEAM_PACKS))
async def test_every_team_pack_resolves_to_known_roles(pack):
    out = await roles.roles_for(None, "p", pack, {})
    assert out and all(r["prompt"] for r in out), pack
