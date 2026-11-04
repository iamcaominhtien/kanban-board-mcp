"""Issue #275: fewer needless stops, the risky things still with a person.

What each role may run, web search, the presets, a refused tool asked once and remembered (ticket, project, role),
remembered board approvals for the project or the role, every refusal saying what to do instead, the list of what
stopped the AIs, and the permissions guide an AI reads."""

import json

import pytest

from models import AiApproval, AiMember, AiRun
from services.ai import (
    approvals,
    cli,
    guard,
    runs,
    safety,
    tool_asks,
    tool_rules,
)
from tests.ai_helpers import _ctx, _runner, _ticket, env  # noqa: F401
from tests.test_ai_safety import OWNER, _ask_assignee, _pending, _people

ADMIN = {"X-Actor": "Ada Admin"}


async def _role(env, member_id: str, role: str) -> None:
    async with env["maker"]() as s:
        p = await s.get(AiMember, member_id)
        cfg = json.loads(p.config or "{}")
        cfg["role"] = role
        p.config = json.dumps(cfg)
        s.add(p)
        await s.commit()


# --------------------------------------------------------------------------- what a role may run, web search


def test_a_dev_installs_and_tests_and_may_search_the_web():
    allowed, denied = runs.cli_tool_rules(
        ["Read"], [], safe=False, domains=["github.com"], role="dev", web_search="roles"
    )
    for rule in (
        "Bash(npm install:*)",
        "Bash(pytest:*)",
        "Bash(git commit:*)",
        "Edit",
        "WebSearch",
    ):
        assert rule in allowed
    assert "WebFetch(domain:github.com)" in allowed and "WebSearch" not in denied
    assert not any(r.startswith("Bash(git push") for r in allowed)


def test_qa_starts_the_app_and_a_designer_serves_its_files_and_uses_the_browser():
    qa, qa_denied = runs.cli_tool_rules(
        [], [], safe=False, domains=[], role="qa", web_search="roles"
    )
    assert {"Bash(npm run dev:*)", "Bash(npx playwright:*)", "mcp__playwright"} <= set(
        qa
    )
    assert "WebSearch" in qa_denied  # QA runs the product, it does not look things up
    ds, _ = runs.cli_tool_rules(
        [], [], safe=False, domains=[], role="designer", web_search="roles"
    )
    assert {"Bash(python3 -m http.server:*)", "mcp__playwright", "WebSearch"} <= set(ds)


def test_web_search_off_or_on_for_every_role_and_safe_mode_keeps_only_reading():
    _, denied = runs.cli_tool_rules(
        [], [], safe=False, domains=[], role="dev", web_search="off"
    )
    assert "WebSearch" in denied
    allowed, _ = runs.cli_tool_rules(
        [], [], safe=False, domains=[], role="reviewer", web_search="on"
    )
    assert "WebSearch" in allowed
    allowed, denied = runs.cli_tool_rules(
        ["Read", "Bash(npm test:*)"],
        [],
        safe=True,
        domains=[],
        role="dev",
        web_search="on",
        granted=["Bash(npm install:*)"],
    )
    assert allowed == ["Read"] and "Bash" in denied and "WebSearch" in denied


def test_a_remembered_rule_is_added_but_never_a_push():
    allowed, _ = runs.cli_tool_rules(
        [],
        [],
        safe=False,
        domains=[],
        granted=["Bash(make deploy:*)", "Bash(git push:*)", "Bash(sudo:*)"],
    )
    assert "Bash(make deploy:*)" in allowed
    assert "Bash(git push:*)" not in allowed and "Bash(sudo:*)" not in allowed


def test_the_old_call_without_a_role_is_unchanged():
    allowed, denied = runs.cli_tool_rules(
        ["Read", "WebSearch"], [], safe=False, domains=["a.dev"]
    )
    assert allowed == ["Read", "WebFetch(domain:a.dev)"] and denied == ["WebSearch"]


@pytest.mark.parametrize(
    ("tool", "data", "rule"),
    [
        ("Bash", {"command": "npm install left-pad"}, "Bash(npm install:*)"),
        ("Bash", {"command": "npm run dev -- --port 5180 &"}, "Bash(npm run dev:*)"),
        (
            "Bash",
            {"command": "python3 -m http.server 8000"},
            "Bash(python3 -m http.server:*)",
        ),
        ("Bash", {"command": "CI=1 pytest -q tests"}, "Bash(pytest:*)"),
        ("Bash", {"command": "uv sync && uv run pytest"}, "Bash(uv sync:*)"),
        ("Bash", {"command": "ls -la"}, "Bash(ls:*)"),
        (
            "WebFetch",
            {"url": "https://docs.python.org/3/library/re.html"},
            "WebFetch(domain:docs.python.org)",
        ),
        ("WebSearch", {"query": "vite port"}, "WebSearch"),
        ("mcp__figma__get_file", {}, "mcp__figma__get_file"),
        ("Bash", {"command": ""}, None),
    ],
)
def test_a_refused_call_becomes_the_narrowest_rule(tool, data, rule):
    assert tool_rules.rule_for(tool, data) == rule


def test_how_risky_a_rule_is():
    assert tool_rules.risk_of_rule("Bash(git push:*)") == "high"
    assert tool_rules.risk_of_rule("Bash(npm install:*)") == "medium"
    assert tool_rules.risk_of_rule("Read") == "low"


def test_presets_decide_bypass():
    assert tool_rules.bypass_for("member", True, "claude-code") is True
    assert tool_rules.bypass_for("never", True, "claude-code") is False
    assert tool_rules.bypass_for("always", False, "claude-code") is True
    assert (
        tool_rules.bypass_for("always", False, "anthropic") is False
    )  # an API agent has no CLI to bypass


def test_the_cli_result_lists_what_it_refused():
    line = json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "result": "Done, but npm install was refused.",
            "usage": {},
            "permission_denials": [
                {
                    "tool_name": "Bash",
                    "tool_use_id": "t1",
                    "tool_input": {"command": "npm install left-pad"},
                }
            ],
        }
    )
    out = cli.parse_stream_line(line, "/tmp")
    assert out["result"]["denials"] == [
        {"tool": "Bash", "input": {"command": "npm install left-pad"}}
    ]


# --------------------------------------------------------------------------- presets


async def test_presets_set_every_switch_and_only_the_owner_opens_more(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _people(c, pid)
    p = (await c.get(f"/projects/{pid}/ai/permissions", headers=OWNER)).json()
    assert (
        p["preset"] == "normal"
        and p["bypass"] == "member"
        and p["web_search"] == "roles"
    )
    assert [x["key"] for x in p["presets"]] == ["careful", "normal", "trusted"]
    assert all(x["line"] for x in p["presets"])
    assert next(r for r in p["roles"] if r["role"] == "dev")["web_search"] is True

    r = await c.put(
        f"/projects/{pid}/ai/permissions", json={"preset": "careful"}, headers=ADMIN
    )
    assert r.status_code == 200, r.text
    assert (
        r.json()["preset"] == "careful"
        and r.json()["docs_ask"] is True
        and r.json()["bypass"] == "never"
    )
    # an admin may make it stricter, not open it wider
    r = await c.put(
        f"/projects/{pid}/ai/permissions", json={"preset": "trusted"}, headers=ADMIN
    )
    assert r.status_code == 403
    r = await c.put(
        f"/projects/{pid}/ai/permissions", json={"preset": "trusted"}, headers=OWNER
    )
    assert (
        r.json()["preset"] == "trusted"
        and r.json()["web_search"] == "on"
        and r.json()["docs_ask"] is False
    )
    r = await c.put(
        f"/projects/{pid}/ai/permissions", json={"web_search": "roles"}, headers=OWNER
    )
    assert r.json()["preset"] == "custom"
    r = await c.put(
        f"/projects/{pid}/ai/permissions", json={"web_search": "maybe"}, headers=OWNER
    )
    assert r.status_code == 422
    r = await c.put(
        f"/projects/{pid}/ai/permissions",
        json={"preset": "normal"},
        headers={"X-Actor": "Hoa Mai"},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------------- ask once, then remember


async def test_a_refused_tool_is_asked_once_and_remembered_for_the_project(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _role(env, m["id"], "designer")
    denial = [{"tool": "Bash", "input": {"command": "npm install left-pad"}}]
    [ask] = await tool_asks.post(
        ctx.run_id, denial + denial
    )  # the same rule twice is one request
    assert ask.action == approvals.USE_TOOL and ask.risk == "medium"
    assert "npm install left-pad" in ask.summary
    [card] = [a for a in await _pending(c, pid) if a["id"] == ask.id]
    assert card["tool_rule"] == "Bash(npm install:*)" and card["scopes"] == [
        "ticket",
        "project",
        "role",
    ]
    # asked again before anyone answered: the same request
    [again] = await tool_asks.post(ctx.run_id, denial)
    assert again.id == ask.id

    r = await c.post(
        f"/ai/approvals/{ask.id}/approve", json={"scope": "project", "go_on": False}
    )
    assert r.status_code == 200, r.text
    assert r.json()["rule"] == "Bash(npm install:*)" and r.json()["scope"] == "project"
    other = await _ticket(c, pid, "Another")
    async with env["maker"]() as s:
        rules = await safety.granted_rules(
            s, project_id=pid, member_id=m["id"], ticket_id=other, role="designer"
        )
    assert rules == ["Bash(npm install:*)"]
    assert await tool_asks.post(ctx.run_id, denial) == []  # nothing to ask any more
    grants = (await c.get(f"/projects/{pid}/ai/grants")).json()
    assert grants[0]["kind"] == "tool" and grants[0]["action"] == "Bash(npm install:*)"


async def test_always_for_the_role_covers_every_member_with_it_and_is_the_owners(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _people(c, pid)
    await _role(env, m["id"], "qa")
    second = await _runner(c, pid, env["repo"], name="QA two")
    await _role(env, second["id"], "qa")
    [ask] = await tool_asks.post(
        ctx.run_id, [{"tool": "Bash", "input": {"command": "docker compose up -d"}}]
    )
    r = await c.post(
        f"/ai/approvals/{ask.id}/approve",
        json={"scope": "role", "go_on": False},
        headers=ADMIN,
    )
    assert r.status_code == 403 and "owner" in r.json()["detail"]
    r = await c.post(
        f"/ai/approvals/{ask.id}/approve",
        json={"scope": "role", "go_on": False},
        headers=OWNER,
    )
    assert r.status_code == 200, r.text
    async with env["maker"]() as s:
        rules = await safety.granted_rules(
            s, project_id=pid, member_id=second["id"], ticket_id=None, role="qa"
        )
        none = await safety.granted_rules(
            s, project_id=pid, member_id=second["id"], ticket_id=None, role="dev"
        )
    assert rules == ["Bash(docker compose:*)"] and none == []


async def test_a_push_is_asked_but_only_for_this_ticket(env):
    ctx, pid, an, m, tid = await _ctx(env)
    [ask] = await tool_asks.post(
        ctx.run_id, [{"tool": "Bash", "input": {"command": "git push origin main"}}]
    )
    assert ask.risk == "high"
    async with env["maker"]() as s:
        assert tool_asks.scopes_for(await s.get(AiApproval, ask.id)) == ["ticket"]


async def test_a_deny_rule_and_safe_mode_are_never_asked_about(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    async with env["maker"]() as s:
        p = await s.get(AiMember, m["id"])
        p.config = json.dumps(
            {**json.loads(p.config or "{}"), "deny_rules": ["Bash(rm:*)"]}
        )
        s.add(p)
        await s.commit()
    assert (
        await tool_asks.post(
            ctx.run_id, [{"tool": "Bash", "input": {"command": "rm build.log"}}]
        )
        == []
    )
    await c.patch(f"/projects/{pid}/ai/settings", json={"safe_mode": True})
    assert (
        await tool_asks.post(
            ctx.run_id, [{"tool": "Bash", "input": {"command": "npm ci"}}]
        )
        == []
    )


async def test_allowed_with_go_on_the_run_goes_on_where_it_stopped(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    [ask] = await tool_asks.post(
        ctx.run_id, [{"tool": "Bash", "input": {"command": "npm ci"}}]
    )
    async with env["maker"]() as s:
        run = await s.get(AiRun, ctx.run_id)
        run.state, run.ended_reason = "finished", "Finished"
        s.add(run)
        await s.commit()
    r = await c.post(f"/ai/approvals/{ask.id}/approve", json={"scope": "ticket"})
    assert r.status_code == 200, r.text
    new = r.json()["continued_run_id"]
    assert new and new != ctx.run_id
    async with env["maker"]() as s:
        nxt = await s.get(AiRun, new)
    assert "allowed `Bash(npm ci:*)`" in nxt.instruction


async def test_a_board_approval_remembered_for_the_project_is_not_asked_again(env):
    from kanban_mcp.tools.tickets import manage_ticket

    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _ask_assignee(env, an, tid, ctx)
    [a] = await _pending(c, pid)
    assert a["scopes"] == ["once", "ticket", "project"]  # no role: this member has none
    r = await c.post(f"/ai/approvals/{a['id']}/approve", json={"scope": "project"})
    assert r.status_code == 200, r.text
    tokens = guard.enter(ctx)
    try:
        out = await manage_ticket(action="update", ticket_id=tid, assignee=m["id"])
    finally:
        guard.leave(tokens)
    assert out["assignee"] == m["id"]
    # high risk is decided each time
    assert (
        await c.post(f"/ai/approvals/{a['id']}/approve", json={"scope": "role"})
    ).status_code == 409


# --------------------------------------------------------------------------- say why


async def test_every_refusal_says_what_to_do_instead_and_what_to_switch_on(env):
    from kanban_mcp.tools.tickets import manage_ticket

    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(
            ValueError, match="status_ceiling.*Instead: Leave the ticket"
        ):
            await manage_ticket(action="update", ticket_id=tid, status="done")
        with pytest.raises(
            ValueError, match="Instead: Say in a comment which ticket should go"
        ):
            await manage_ticket(action="delete", ticket_id=tid)
    finally:
        guard.leave(tokens)
    feed = (await c.get(f"/projects/{pid}/ai/notifications")).json()
    texts = " ".join(
        n["body"] for n in (feed.get("items") if isinstance(feed, dict) else feed)
    )
    assert "Blocked by default on purpose. The owner may" in texts


async def test_handing_a_ticket_over_from_a_run_with_ai_team_is_a_handoff(
    env, monkeypatch
):
    from kanban_mcp.tools.ai_team import ai_team

    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    mate = await _runner(c, pid, env["repo"], name="Tester")
    seen = {}

    async def fake_handoff(ctx_, member, ticket, instruction):
        seen.update(member=member, ticket=ticket, instruction=instruction)
        return {"handed_to": member}

    monkeypatch.setattr(runs, "record_handoff", fake_handoff)
    tokens = guard.enter(ctx)
    try:
        out = await ai_team(
            action="ask",
            intent="work",
            member_id=mate["id"],
            ticket_id=tid,
            text="Test it",
        )
        assert out == {"handed_to": mate["id"]} and seen["ticket"] == tid
        with pytest.raises(ValueError, match="Instead: hand a ticket to a teammate"):
            await ai_team(action="pause", member_id=mate["id"])
    finally:
        guard.leave(tokens)


# --------------------------------------------------------------------------- what stopped the AIs, the guide


async def test_the_list_of_blocks_groups_them_with_the_role_and_a_verdict(env):
    from kanban_mcp.tools.tickets import manage_ticket

    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _role(env, m["id"], "dev")
    tokens = guard.enter(ctx)
    try:
        for _ in range(2):
            with pytest.raises(ValueError):
                await manage_ticket(action="update", ticket_id=tid, status="done")
    finally:
        guard.leave(tokens)
    await tool_asks.post(
        ctx.run_id, [{"tool": "Bash", "input": {"command": "npm install"}}]
    )
    async with env["maker"]() as s:
        run = await s.get(AiRun, ctx.run_id)
        run.steps = json.dumps(
            [
                {
                    "at": "2026-11-02T10:00:00+00:00",
                    "kind": "tool",
                    "text": "WebSearch vite",
                    "tool_id": "w",
                },
                {
                    "at": "2026-11-02T10:00:01+00:00",
                    "kind": "error",
                    "text": "Claude requested permissions to use WebSearch, but you haven't granted it yet.",
                    "tool_id": "w",
                },
                {
                    "at": "2026-11-02T10:00:02+00:00",
                    "kind": "error",
                    "text": "Error executing tool ticket_items: qa/evidence/TC-6.png: no such file in the working folder",
                },
                {
                    "at": "2026-11-02T10:00:03+00:00",
                    "kind": "error",
                    "text": "Error executing tool ai_team: An AI run cannot start AIs or change AI members or runs; a person does.",
                },
                {
                    "at": "2026-11-02T10:00:04+00:00",
                    "kind": "say",
                    "text": "I cannot run the e2e suite here.",
                },
            ]
        )
        s.add(run)
        await s.commit()
    out = (await c.get(f"/projects/{pid}/ai/blocks")).json()
    by = {g["key"]: g for g in out["groups"]}
    ceiling = by["board:change_status:status_ceiling"]
    assert (
        ceiling["count"] == 2
        and ceiling["roles"] == ["dev"]
        and ceiling["verdict"] == "kept"
    )
    assert by["cli:Bash(npm install:*)"]["verdict"] == "fixed"  # a Dev may install now
    assert by["cli:WebSearch"]["verdict"] == "fixed"  # a Dev may search by default
    assert by["cli:WebSearch"]["trying"] == "WebSearch vite"
    assert by["board:proof_path"]["verdict"] == "fixed"
    assert by["board:step:ai_run_only"]["verdict"] == "fixed"
    assert by["said:dev"]["example"].startswith("I cannot run the e2e suite")
    assert (
        out["groups"][0]["key"] == "board:change_status:status_ceiling"
    )  # most frequent first


async def test_the_permissions_guide_says_what_the_calling_ai_may_do(env):
    from kanban_mcp.tools.docs import docs_read

    ctx, pid, an, m, tid = await _ctx(env)
    await _role(env, m["id"], "qa")
    out = await docs_read(action="permissions_guide")
    assert (
        "When your CLI refuses" in out["guide"] and "you" not in out
    )  # a person: the guide only
    tokens = guard.enter(ctx)
    try:
        out = await docs_read(action="permissions_guide")
    finally:
        guard.leave(tokens)
    you = out["you"]
    assert (
        you["role"] == "qa"
        and you["web_search"] is False
        and "Bash(npm run dev:*)" in you["role_tools"]
    )
    assert (
        you["board_actions"]["delete_tickets"] == "blocked"
        and you["status_ceiling"] == "review"
    )


def test_the_board_plugin_carries_the_guide_as_a_skill(tmp_path, monkeypatch):
    import database
    from services.ai import board_skills

    monkeypatch.setattr(database, "get_db_path", lambda: tmp_path / "kanban.db")
    root = board_skills.plugin_dir()
    text = (
        tmp_path / "board-skills" / "skills" / "board-permissions" / "SKILL.md"
    ).read_text()
    assert (
        root and text.startswith("---\nname: board-permissions") and "Instead:" in text
    )


# --------------------------------------------------------------------------- the owner may lift a lock


def test_the_owner_may_set_any_mode_others_only_stricter():
    from services.ai import permissions

    assert permissions.validate_overrides(
        "developer",
        {"delete_tickets": "allowed", "change_assignee": "allowed"},
        owner=True,
    ) == {"delete_tickets": "allowed", "change_assignee": "allowed"}
    with pytest.raises(ValueError, match="only the project owner"):
        permissions.validate_overrides("custom", {"delete_tickets": "allowed"})
    with pytest.raises(ValueError, match="Only the project owner can widen it"):
        permissions.validate_overrides("developer", {"change_assignee": "allowed"})


async def test_an_owner_who_lifts_the_delete_lock_lets_the_ai_delete_and_it_says_who(
    env,
):
    from kanban_mcp.tools.tickets import manage_ticket

    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _people(c, pid)
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"permissions": {"delete_tickets": "allowed"}},
        headers=ADMIN,
    )
    assert r.status_code == 422  # an admin cannot, even to ask the owner
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={
            "permissions": {"delete_tickets": "allowed", "change_assignee": "allowed"}
        },
        headers=OWNER,
    )
    assert r.status_code == 200, r.text
    matrix = {
        x["action"]: x
        for x in (await c.get(f"/ai/members/{m['id']}/permissions")).json()["matrix"]
    }
    for action in ("delete_tickets", "change_assignee"):
        row = matrix[action]
        assert (
            row["mode"] == "allowed"
            and row["owner_enabled"]
            and row["source_by"] == "Owen Lead"
        )
    other = await _ticket(c, pid, "Gone soon")
    await c.patch(f"/tickets/{other}", json={"assignee": m["id"]})
    tokens = guard.enter(ctx)
    try:
        await manage_ticket(action="delete", ticket_id=other)
        await manage_ticket(action="update", ticket_id=tid, assignee=an)
    finally:
        guard.leave(tokens)
    assert (await c.get(f"/tickets/{other}")).status_code == 404
    # back to the template's mode: the lock holds again
    r = await c.patch(f"/ai/members/{m['id']}", json={"permissions": {}}, headers=OWNER)
    matrix = {
        x["action"]: x
        for x in (await c.get(f"/ai/members/{m['id']}/permissions")).json()["matrix"]
    }
    assert (
        matrix["delete_tickets"]["mode"] == "blocked"
        and not matrix["delete_tickets"]["owner_enabled"]
    )
