"""Guards the quality of the MCP tool list: what the AI reads (descriptions, schemas, annotations) and how
the tools behave for the cases the descriptions promise."""

import json

import pytest

import mcp_tools
import services.tickets as svc_tickets
from main import mcp
from models import IDEA_COLORS, IDEA_STATUSES
from tests.test_activity import _ticket, client, setup_db  # noqa: F401  (fixtures)


def _full_mcp():
    """A server with every tool, including the Idea Space ones that are hidden by default."""
    from mcp.server.fastmcp import FastMCP

    full = FastMCP("kanban-test", instructions=mcp_tools.build_instructions(True))
    mcp_tools.register(full, include_ideas=True)
    return full


async def _tools(server=None):
    """The tools of the server (default: the real one with the default switches), or of `server`."""
    return {t.name: t for t in await (server or mcp).list_tools()}


def _enum_of(schema: dict) -> list | None:
    if "enum" in schema:
        return schema["enum"]
    for sub in schema.get("anyOf", []):
        if "enum" in sub:
            return sub["enum"]
    return None


# --------------------------------------------------------------------------- the tool list itself


async def test_every_registered_tool_is_in_the_table_and_vice_versa():
    core = {f.__name__ for f, _ in mcp_tools.CORE_TOOL_TABLE}
    ideas = {f.__name__ for f, _ in mcp_tools.IDEA_TOOL_TABLE}
    assert not core & ideas
    assert set(await _tools(_full_mcp())) == core | ideas
    assert len(mcp_tools.TOOL_TABLE) == len(core | ideas) == 47


async def test_idea_space_tools_are_hidden_by_default_and_can_be_switched_on(monkeypatch):
    from mcp.server.fastmcp import FastMCP

    ideas = {f.__name__ for f, _ in mcp_tools.IDEA_TOOL_TABLE}
    assert len(ideas) == 13
    assert not ideas & set(await _tools())  # the real server: hidden
    assert "IDEA-N" not in (mcp.instructions or "") and "idea" not in (mcp.instructions or "").lower()

    monkeypatch.setenv("KANBAN_MCP_IDEA_TOOLS", "1")
    assert mcp_tools.ideas_enabled()
    server = FastMCP("t", instructions=mcp_tools.build_instructions())
    mcp_tools.register(server)
    assert ideas <= set(await _tools(server))
    assert "IDEA-N" in mcp_tools.build_instructions()

    monkeypatch.setenv("KANBAN_MCP_IDEA_TOOLS", "0")
    assert not mcp_tools.ideas_enabled()


async def test_every_tool_has_annotations_that_match_its_name():
    for name, tool in (await _tools(_full_mcp())).items():
        a = tool.annotations
        assert a is not None, name
        if name.startswith(("list_", "get_")) and name != "get_ticket_workspace_path":
            assert a.readOnlyHint is True, name
        else:
            assert a.readOnlyHint is False, name
        if name.startswith("delete_") or name in {"remove_member", "unlink_tickets"}:
            assert a.destructiveHint is True, name
        else:
            assert a.destructiveHint is not True, name
        assert a.openWorldHint is False, name


async def test_descriptions_are_present_and_free_of_stale_conventions():
    for name, tool in (await _tools(_full_mcp())).items():
        desc = tool.description or ""
        assert len(desc) >= 40, f"{name}: description too short"
        assert "Args:" not in desc, f"{name}: parameter docs belong in the schema"
        assert "or None" not in desc and '{"error"' not in desc, f"{name}: failures are raised, not returned"


async def test_every_parameter_is_described_unless_its_enum_or_flag_explains_itself():
    self_explanatory = {"title", "description", "expected_result", "notes", "idea_emoji"}
    for name, tool in (await _tools(_full_mcp())).items():
        for pname, schema in tool.inputSchema.get("properties", {}).items():
            if schema.get("description"):
                continue
            is_flag = schema.get("type") == "boolean" or any(s.get("type") == "boolean" for s in schema.get("anyOf", []))
            assert _enum_of(schema) or is_flag or pname in self_explanatory, f"{name}.{pname} has no description"


async def test_schemas_carry_no_redundant_titles():
    for name, tool in (await _tools(_full_mcp())).items():
        for pname, schema in tool.inputSchema.get("properties", {}).items():
            assert "title" not in schema, f"{name}.{pname}"
    # ...but a parameter that is itself called "title" survives
    assert "title" in (await _tools())["create_ticket"].inputSchema["properties"]


async def test_the_tool_list_stays_compact():
    def size(tools):
        return sum(len(t.description or "") + len(json.dumps(t.inputSchema, separators=(",", ":"))) for t in tools.values())

    default, full = size(await _tools()), size(await _tools(_full_mcp()))
    assert default < 28_500, f"default tool list is {default} characters (about {default // 4} tokens)"
    assert full < 40_000, f"full tool list is {full} characters (about {full // 4} tokens)"
    assert default < full


async def test_server_instructions_explain_the_ids_and_conventions():
    for text, musts in (
        (mcp.instructions or "", ("IAM-12", "clear_fields", "get_ticket_workspace_path", "AI agent")),
        (mcp_tools.build_instructions(True), ("IAM-12", "IDEA-N", "explicit null", "dropped")),
    ):
        for must in musts:
            assert must in text, must


async def test_schema_enums_match_the_services():
    tools = await _tools(_full_mcp())

    def enum(tool, param):
        return set(_enum_of(tools[tool].inputSchema["properties"][param]))

    assert enum("add_work_log", "kind") == set(svc_tickets.WORK_LOG_KINDS)
    assert enum("add_work_log", "role") == set(svc_tickets.WORK_LOG_ROLES)
    assert enum("link_tickets", "relation_type") == set(svc_tickets.VALID_RELATION_TYPES)
    assert enum("add_branch", "status") == set(svc_tickets.VALID_BRANCH_STATUSES)
    assert enum("update_idea_status", "new_status") == set(IDEA_STATUSES)
    assert enum("create_idea_ticket", "idea_color") == set(IDEA_COLORS)
    assert enum("create_idea_ticket", "idea_energy") == {"seed", "concept", "hot", "big_bet"}
    assert enum("update_ticket", "status") == {"backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"}


async def test_invalid_enum_values_are_rejected_before_any_work():
    from mcp.server.fastmcp.exceptions import ToolError

    with pytest.raises(ToolError):
        await _full_mcp().call_tool("create_idea_ticket", {"project_id": "x", "title": "t", "idea_energy": "low"})
    with pytest.raises(ToolError):
        await mcp.call_tool("list_tickets", {"project_id": "x", "status": "bogus"})


# --------------------------------------------------------------------------- behaviour the descriptions promise


async def test_list_tickets_is_paginated_and_compact(client):
    async with client as c:
        p, first = await _ticket(c, title="first")
        for n in range(4):
            await c.post(f"/projects/{p['id']}/tickets", json={"title": f"t{n}", "description": "long " * 50})
    page = await mcp_tools.list_tickets(p["id"], limit=2)
    assert (page["total"], page["count"], page["offset"], page["has_more"]) == (5, 2, 0, True)
    rest = await mcp_tools.list_tickets(p["id"], limit=2, offset=4)
    assert (rest["count"], rest["has_more"]) == (1, False)
    summary = page["tickets"][0]
    assert {"id", "title", "status", "priority", "blocked_by", "acceptance_criteria", "test_cases"} <= set(summary)
    assert "description" not in summary and "activity_log" not in summary
    full = await mcp_tools.list_tickets(p["id"], detail=True, limit=1)
    assert "description" in full["tickets"][0] and "activity_log" not in full["tickets"][0]


async def test_activity_log_is_opt_in_and_branches_have_no_camel_case_twins(client):
    async with client as c:
        _, t = await _ticket(c)
        await c.patch(f"/tickets/{t['id']}", json={"priority": "high"})
        await c.post(f"/tickets/{t['id']}/branches", json={"name": "feat/a", "branch_from": "main"})
    plain = await mcp_tools.get_ticket(t["id"])
    assert len(plain["activity_log"]) <= mcp_tools.DEFAULT_ACTIVITY_ENTRIES  # recent entries only
    assert len((await mcp_tools.get_ticket(t["id"], activity_limit=-1))["activity_log"]) == plain["activity_total"]
    assert "activity_log" not in await mcp_tools.add_comment(t["id"], "hi", "Claude")
    branch = plain["branches"][0]
    assert "pr_url" in branch and "prUrl" not in branch and "branchFrom" not in branch


async def test_sub_item_errors_list_the_valid_ids(client):
    async with client as c:
        _, t = await _ticket(c)
    created = await mcp_tools.add_comment(t["id"], "hello", "Claude")
    cid = created["comments"][0]["id"]
    with pytest.raises(ValueError) as exc:
        await mcp_tools.delete_comment(t["id"], "wrong-id")  # used to "succeed" silently
    assert cid in str(exc.value) and "get_ticket" in str(exc.value)
    assert len((await mcp_tools.get_ticket(t["id"]))["comments"]) == 1
    with pytest.raises(ValueError, match="not found"):
        await mcp_tools.toggle_acceptance_criterion(t["id"], "nope")


async def test_test_cases_and_branches_can_be_addressed_by_code_and_name(client):
    async with client as c:
        _, t = await _ticket(c)
    i = t["id"]
    await mcp_tools.add_test_case(i, "works")
    updated = await mcp_tools.update_test_case(i, "TC-1", status="pass")  # by code, not UUID
    assert updated["test_cases"][0]["status"] == "pass"
    await mcp_tools.add_branch(i, "feat/x")
    renamed = await mcp_tools.update_branch(i, "feat/x", pr_url="https://example.com/pr/1")  # by name
    assert renamed["branches"][0]["pr_url"] == "https://example.com/pr/1"
    after = await mcp_tools.delete_branch(i, "feat/x")
    assert after["branches"] == []


async def test_failures_are_raised_for_idea_tools_too():
    with pytest.raises(ValueError, match="not found"):
        await mcp_tools.get_idea_ticket("IDEA-999")
    with pytest.raises(ValueError, match="not found"):
        await mcp_tools.update_idea_status("IDEA-999", "in_review")
    with pytest.raises(ValueError, match="not found"):
        await mcp_tools.get_idea_activity_trail("IDEA-999")


async def test_create_ticket_and_update_project_cover_what_the_descriptions_offer(client):
    async with client as c:
        p, _ = await _ticket(c)
    member = (await mcp_tools.add_member(p["id"], "Bao"))
    created = await mcp_tools.create_ticket(p["id"], "with owner", assignee=member["id"], start_date="2026-01-02", due_date="2026-02-01")
    assert created["assignee"] == member["id"] and created["start_date"] == "2026-01-02"
    project = await mcp_tools.update_project(p["id"], name="Renamed")
    assert project["name"] == "Renamed"
    with pytest.raises(ValueError, match="not found"):
        await mcp_tools.update_project("no-such-project", name="x")


async def test_unlink_explains_that_each_side_of_a_link_has_its_own_id(client):
    async with client as c:
        p, a = await _ticket(c)
        b = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "b"})).json()["id"]
    link = await mcp_tools.link_tickets(a["id"], b, "relates_to")
    with pytest.raises(ValueError, match="different id on each"):
        await mcp_tools.unlink_tickets(b, link["id"])  # the other side of the link
    assert await mcp_tools.unlink_tickets(a["id"], link["id"]) == {"removed": link["id"]}


async def test_get_ticket_can_return_only_the_recent_activity(client):
    import asyncio

    async with client as c:
        _, t = await _ticket(c)
        i = t["id"]
        for n in range(5):
            await c.patch(f"/tickets/{i}", json={"title": f"t{n}"})
            await asyncio.sleep(0.01)
    plain = await mcp_tools.get_ticket(i)  # default: the most recent entries
    assert 0 < len(plain["activity_log"]) <= mcp_tools.DEFAULT_ACTIVITY_ENTRIES
    assert plain["activity_total"] >= 6 and plain["activity_log"][-1]["to"] == "t4"

    everything = await mcp_tools.get_ticket(i, activity_limit=-1)
    total = len(everything["activity_log"])
    assert total >= 6 and everything["activity_total"] == total

    latest = await mcp_tools.get_ticket(i, activity_limit=2)
    assert [e["to"] for e in latest["activity_log"]] == ["t3", "t4"]  # the newest two, oldest first
    assert latest["activity_total"] == total

    assert (await mcp_tools.get_ticket(i, activity_limit=0))["activity_log"] == []  # leave it out entirely

    cutoff = everything["activity_log"][-3]["at"]  # entries strictly after the third-from-last
    newer = await mcp_tools.get_ticket(i, activity_since=cutoff)
    assert [e["to"] for e in newer["activity_log"]] == ["t3", "t4"]
    both = await mcp_tools.get_ticket(i, activity_since=everything["activity_log"][0]["at"], activity_limit=1)
    assert [e["to"] for e in both["activity_log"]] == ["t4"]
    assert (await mcp_tools.get_ticket(i, activity_since="2999-01-01"))["activity_log"] == []
    with pytest.raises(ValueError, match="ISO"):
        await mcp_tools.get_ticket(i, activity_since="yesterday")


async def test_activity_limit_is_validated_by_the_schema():
    from mcp.server.fastmcp.exceptions import ToolError

    with pytest.raises(ToolError):
        await mcp.call_tool("get_ticket", {"ticket_id": "X-1", "activity_limit": -1})
    props = (await _tools())["get_ticket"].inputSchema["properties"]
    assert {"activity_limit", "activity_since"} <= set(props) and "include_activity" not in props


async def test_default_activity_is_capped_and_long_texts_are_shortened(client):
    async with client as c:
        _, t = await _ticket(c)
        i = t["id"]
        for n in range(15):
            await c.patch(f"/tickets/{i}", json={"priority": ["low", "high"][n % 2]})
        await c.patch(f"/tickets/{i}", json={"description": "x" * 5000})
    recent = await mcp_tools.get_ticket(i)
    assert len(recent["activity_log"]) == mcp_tools.DEFAULT_ACTIVITY_ENTRIES
    assert recent["activity_total"] > mcp_tools.DEFAULT_ACTIVITY_ENTRIES
    desc = [e for e in recent["activity_log"] if e["field"] == "description"][0]
    assert len(desc["to"]) < 400 and "more chars" in desc["to"]  # shortened by default...
    full = await mcp_tools.get_ticket(i, activity_limit=-1)
    assert len([e for e in full["activity_log"] if e["field"] == "description"][0]["to"]) == 5000  # ...whole with include_activity
    assert len(full["activity_log"]) == full["activity_total"]
    # a negative limit with `since` = everything after that moment, in full
    cutoff = full["activity_log"][-2]["at"]
    tail = await mcp_tools.get_ticket(i, activity_limit=-5, activity_since=cutoff)
    assert tail["activity_log"] == [e for e in full["activity_log"] if e["at"] > cutoff]
