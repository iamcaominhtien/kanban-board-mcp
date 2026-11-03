"""The Board AI sets up the AI team (after #273): members from role packs, roles, plugins, the board's skills, MCP
servers, hooks and skills. With the owner's switch on it does them by itself and keeps an Undo; off, they ask first."""

import json

import pytest

from models import AiAudit, AiMember
from services.ai.assist import prompts, team_config, tiers
from tests.test_ai import _ticket, env  # noqa: F401
from tests.test_ai_assist import H, _answer, _setup, fake  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _block(*changes) -> str:
    return (
        "Set up.\n\n```kanban-actions\n"
        + json.dumps({"changes": list(changes)})
        + "\n```"
    )


def test_team_changes_ask_first_unless_the_switch_is_on_and_are_never_a_bulk_action_then():
    six = [{"op": "ai_from_pack", "pack": "dev", "name": f"Dev {i}"} for i in range(6)]
    off = tiers.decide(six)
    assert off["act"] is False and off["tier"] == tiers.ASK
    on = tiers.decide(six, manages_team=True)
    assert on["act"] is True and on["tier"] == tiers.UNDO
    # the switch does not touch anything else: Done and deleting stay locked
    assert (
        tiers.decide(
            [{"op": "status", "ticket": "K-1", "to": "done"}], manages_team=True
        )["act"]
        is False
    )
    # a team change has no tier of its own to override; the switch decides
    with pytest.raises(ValueError, match="manages the AI team"):
        tiers.check_overrides({"mcp_add": "free"})
    rows = {r["op"]: r for r in tiers.table(None, True)}
    assert rows["hook_add"]["tier"] == tiers.UNDO and rows["hook_add"]["team"] is True
    assert {r["op"]: r for r in tiers.table(None, False)}["hook_add"][
        "tier"
    ] == tiers.ASK


def test_a_change_that_runs_a_command_says_what_it_runs():
    members = {"dev": "m_dev"}
    out, problems = prompts.check_changes(
        [
            {
                "op": "mcp_add",
                "member": "dev",
                "server": {
                    "name": "notes",
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "notes-mcp"],
                },
            },
            {
                "op": "hook_add",
                "member": "Dev",
                "event": "PostToolUse",
                "matcher": "Edit",
                "command": "ruff format .",
            },
            {"op": "hook_add", "member": "Dev", "event": "Whenever", "command": "x"},
            {"op": "ai_role", "member": "Nobody", "role": "qa"},
            {"op": "ai_from_pack", "pack": "QA", "name": "  QA  Quyen "},
        ],
        {},
        members,
    )
    assert out[0]["runs"] == "npx -y notes-mcp" and out[0]["label"].endswith(
        "runs npx -y notes-mcp"
    )
    assert out[1]["label"] == "Add a PostToolUse (Edit) hook to Dev: runs ruff format ."
    # a catalogue server says what it runs too
    cat, _ = prompts.check_changes(
        [{"op": "mcp_add", "member": "dev", "key": "playwright"}], {}, members
    )
    assert (
        cat[0]["label"]
        == "Add the MCP server playwright to dev: runs npx -y @playwright/mcp@latest --isolated"
    )
    assert out[2] == {
        "op": "ai_from_pack",
        "ticket": None,
        "pack": "qa",
        "name": "QA Quyen",
        "model": None,
        "plays": None,
        "label": "New AI “QA Quyen” from the qa role pack",
    }
    assert len(problems) == 2 and "unknown AI member" in problems[1]


async def _switch(c, pid, on=True):
    r = await c.patch(f"/projects/{pid}/ai/board-ai", json={"manages_team": on})
    assert r.status_code == 200, r.text
    return r.json()


async def test_only_the_owner_turns_the_switch_on(env):
    c, pid, _an, _m = await _setup(env, acts=True)
    # a member who is not the owner (the header names a person; the first admin is the owner)
    await c.post(f"/projects/{pid}/members", json={"name": "Binh"})
    r = await c.patch(
        f"/projects/{pid}/ai/ops",
        json={"board_ai": {"manages_team": True}},
        headers={"X-Actor": "Binh"},
    )
    assert r.status_code == 403
    got = await _switch(c, pid)
    assert got["manages_team"] is True
    assert {r["op"]: r for r in got["tiers"]}["ai_from_pack"]["tier"] == "undo"


async def test_the_board_ai_builds_a_team_by_itself_and_undo_takes_it_back(env, fake):
    c, pid, _an, m = await _setup(env, acts=True)
    await c.patch(f"/projects/{pid}", json={"repo_path": str(env["repo"])})
    await _switch(c, pid)
    fake.queue.append(
        _block(
            {"op": "ai_from_pack", "pack": "qa", "name": "QA Quyen", "model": "sonnet"},
            {"op": "mcp_add", "member": "Reviewer", "key": "playwright"},
            {
                "op": "hook_add",
                "member": "Reviewer",
                "event": "Stop",
                "matcher": "",
                "command": "echo done",
            },
            {
                "op": "skill_add",
                "member": "Reviewer",
                "name": "Our review rules",
                "description": "How this team reviews. Use before every review.",
                "content": "# Review\n- Block on a missing test.",
            },
            {"op": "board_skill", "skill": "slides", "on": False},
            {
                "op": "ai_edit",
                "member": "Reviewer",
                "effort": "high",
                "description": "Reviews every PR",
            },
        )
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Set up a QA and give the Reviewer a browser")
    draft = msg["draft"]
    assert draft["status"] == "applied", draft
    applied = draft["result"]["applied"]
    assert len(applied) == 6 and all(a.get("label") for a in applied)

    members = (await c.get(f"/projects/{pid}/ai/members")).json()
    qa = next(x for x in members if x["name"] == "QA Quyen")
    assert (qa.get("config") or {}).get("role") == "qa"
    reviewer = (await c.get(f"/ai/members/{m['id']}")).json()
    cfg = reviewer["config"]
    assert "playwright" in [s["name"] for s in cfg["mcp_servers"]]
    assert [h["command"] for h in cfg["hooks"]] == ["echo done"]
    assert [s["name"] for s in cfg["skills"]] == ["our-review-rules"]
    assert cfg["effort"] == "high" and reviewer["description"] == "Reviews every PR"
    ops = (await c.get(f"/projects/{pid}/ai/ops")).json()
    assert {"skill": "slides", "on": False, "members_on": [], "members_off": []} in ops[
        "board_skills"
    ]

    # what ran a command is in the audit log, as a warning, with the command
    async with env["maker"]() as s:
        from sqlmodel import select

        rows = (
            await s.exec(select(AiAudit).where(AiAudit.action == "board_ai_team"))
        ).all()
    hook = next(r for r in rows if json.loads(r.detail or "{}").get("op") == "hook_add")
    assert hook.result == "warning" and json.loads(hook.detail)["runs"] == "echo done"
    assert len(rows) == 6

    r = await c.post(f"/ai/assist/drafts/{draft['id']}/undo", headers=H)
    assert r.status_code == 200, r.text
    names = [
        x["name"]
        for x in (await c.get(f"/projects/{pid}/ai/members")).json()
        if not x.get("removed")
    ]
    assert "QA Quyen" not in names
    cfg = (await c.get(f"/ai/members/{m['id']}")).json()["config"]
    assert not cfg.get("mcp_servers") and not cfg.get("hooks") and not cfg.get("skills")
    assert (await c.get(f"/projects/{pid}/ai/ops")).json()["board_skills"] == []


async def test_with_the_switch_off_a_team_change_waits_for_the_person(env, fake):
    c, pid, _an, m = await _setup(env, acts=True)
    await _ticket(c, pid, title="Anything")
    fake.queue.append(
        _block({"op": "ai_role", "member": "Reviewer", "role": "reviewer"})
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "Make it the reviewer")
    draft = msg["draft"]
    assert draft["status"] == "open" and draft["payload"]["asks_first"]
    async with env["maker"]() as s:
        assert "role" not in json.loads((await s.get(AiMember, m["id"])).config or "{}")
    r = await c.post(f"/ai/assist/drafts/{draft['id']}/apply", json={}, headers=H)
    assert r.status_code == 200, r.text
    async with env["maker"]() as s:
        assert json.loads((await s.get(AiMember, m["id"])).config)["role"] == "reviewer"


async def test_the_board_ai_reads_the_team_and_what_it_could_add(env):
    c, pid, _an, m = await _setup(env, acts=True)
    async with env["maker"]() as s:
        text = await team_config.context_block(s, pid)
    assert "<ai-team>" in text and "Reviewer · role no role" in text
    assert "playwright [mcp]" in text and "role-dev [dev]" in text
    assert "wait for the person to press Apply" in text
    assert (
        "ai_from_pack" in team_config.FORMAT
        and "runs a command on this machine" in team_config.FORMAT
    )


async def test_an_unknown_pack_or_catalogue_key_says_what_exists(env):
    c, pid, _an, m = await _setup(env, acts=True)
    async with env["maker"]() as s:
        with pytest.raises(team_config.TeamError, match="Packs: triage, pm"):
            await team_config.apply(
                s, {"op": "ai_from_pack", "pack": "astronaut", "name": "X"}, "user", pid
            )
        with pytest.raises(team_config.TeamError, match="MCP servers: .*playwright"):
            await team_config.apply(
                s,
                {
                    "op": "mcp_add",
                    "member": m["id"],
                    "member_name": "Reviewer",
                    "key": "nope",
                },
                "user",
                pid,
            )
