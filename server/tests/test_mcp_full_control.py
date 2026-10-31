"""Full control over MCP: a switch in Settings (confirmed with an explicit acceptance) that lets an MCP client call any
AI-team endpoint of the board as the person, with the same rights and checks as the app. Never from inside an AI run."""

import pytest

import config
from kanban_mcp.tools.ai_team import ai_team
from services.ai import guard, runs
from tests.test_ai import _ctx, _project, _runner, env  # noqa: F401


async def _switch(c, on: bool, accept: bool = True):
    return await c.post(
        "/settings/mcp-control", json={"enabled": on, "accept_risks": accept}
    )


async def test_it_is_off_until_a_person_accepts_the_risks(env):
    c = env["c"]
    assert (await c.get("/settings/mcp-control")).json() == {"enabled": False}
    refused = await _switch(c, True, accept=False)
    assert refused.status_code == 400 and "risks" in refused.text
    assert (await c.get("/settings/mcp-control")).json() == {"enabled": False}
    assert (await _switch(c, True)).json() == {"enabled": True}
    assert config.get_flag(config.MCP_FULL_CONTROL) is True
    assert (await c.get("/settings/mcp-control")).json() == {"enabled": True}
    # turning it off needs no confirmation
    assert (await _switch(c, False, accept=False)).json() == {"enabled": False}
    assert config.get_flag(config.MCP_FULL_CONTROL) is False


async def test_while_off_the_actions_explain_where_to_turn_it_on(env):
    pid, _ = await _project(env["c"])
    for args in (
        {"action": "endpoints"},
        {"action": "api", "path": f"GET /projects/{pid}/ai/members"},
    ):
        with pytest.raises(ValueError, match="Settings > Integrations"):
            await ai_team(**args)


async def test_the_person_only_actions_work_once_it_is_on(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    await _switch(c, True)
    listed = await ai_team("endpoints")
    assert "POST /ai/approvals/{approval_id}/approve" in "\n".join(listed)
    assert any(r.startswith("POST /projects/{project_id}/ai/pause-all") for r in listed)
    assert all(" /settings" not in r and "/data-path" not in r for r in listed)
    assert all("pause-all" in r for r in await ai_team("endpoints", text="pause-all"))
    got = await ai_team("api", path=f"GET /projects/{pid}/ai/members")
    assert [x["id"] for x in got] == [m["id"]]
    # the kill switch, which no other ai_team action reaches
    await ai_team(
        "api", path=f"POST /projects/{pid}/ai/pause-all", fields={"reason": "x"}
    )
    state = await ai_team("api", path=f"GET /projects/{pid}/ai/overview")
    assert "paused" in str(state).lower()
    # the board's own checks still apply: an error comes back as the app would say it
    with pytest.raises(ValueError, match="Run not found"):
        await ai_team("api", path="POST /ai/runs/nope/cancel", fields={})


async def test_only_ai_team_paths_can_be_called(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _switch(c, True)
    for path in (
        "/projects",
        f"/projects/{pid}",
        "/settings/data-path",
        "/ai/../settings",
        "/tickets/IAM-1/comments",
        "ai/members",
        "http://evil.example/ai/members",
    ):
        with pytest.raises(ValueError, match="AI-team one"):
            await ai_team("api", path=f"GET {path}")
    with pytest.raises(ValueError, match="METHOD"):
        await ai_team("api", path=f"TRACE /projects/{pid}/ai/members")


async def test_the_board_address_runs_use_is_not_overwritten(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _switch(c, True)
    runs.RT.board_url = "http://127.0.0.1:4455"
    await ai_team("api", path=f"GET /projects/{pid}/ai/members")
    assert runs.RT.board_url == "http://127.0.0.1:4455"


async def test_an_ai_run_can_never_use_it(env):
    c = env["c"]
    ctx, pid, _, m, tid = await _ctx(env)
    await _switch(c, True)
    tokens = guard.enter(ctx)
    try:
        for action, args in (
            ("endpoints", {}),
            ("api", {"path": f"POST /ai/members/{m['id']}/resume"}),
        ):
            with pytest.raises(ValueError, match="cannot start AIs or change AI"):
                await ai_team(action, **args)
    finally:
        guard.leave(tokens)
