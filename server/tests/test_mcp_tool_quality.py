"""Guards the quality of the MCP tool list: what the AI reads (descriptions, schemas, annotations) and how
the tools behave for the cases the descriptions promise."""

import json

import pytest

import mcp_tools
import services.tickets as svc_tickets
from main import mcp
from models import IDEA_COLORS, IDEA_STATUSES
from tests.test_activity import _ticket, client, setup_db  # noqa: F401  (fixtures)


async def _tools():
    return {t.name: t for t in await mcp.list_tools()}


def _enum_of(schema: dict) -> list | None:
    if "enum" in schema:
        return schema["enum"]
    for sub in schema.get("anyOf", []):
        if "enum" in sub:
            return sub["enum"]
    return None


# --------------------------------------------------------------------------- the tool list itself


async def test_every_registered_tool_is_in_the_table_and_vice_versa():
    tools = await _tools()
    assert set(tools) == {f.__name__ for f, _ in mcp_tools.TOOL_TABLE}
    assert len(mcp_tools.TOOL_TABLE) == len({f.__name__ for f, _ in mcp_tools.TOOL_TABLE})


async def test_every_tool_has_annotations_that_match_its_name():
    for name, tool in (await _tools()).items():
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
    for name, tool in (await _tools()).items():
        desc = tool.description or ""
        assert len(desc) >= 40, f"{name}: description too short"
        assert "Args:" not in desc, f"{name}: parameter docs belong in the schema"
        assert "or None" not in desc and '{"error"' not in desc, f"{name}: failures are raised, not returned"


async def test_every_parameter_is_described_unless_its_enum_or_flag_explains_itself():
    self_explanatory = {"title", "description", "expected_result", "notes", "idea_emoji"}
    for name, tool in (await _tools()).items():
        for pname, schema in tool.inputSchema.get("properties", {}).items():
            if schema.get("description"):
                continue
            is_flag = schema.get("type") == "boolean" or any(s.get("type") == "boolean" for s in schema.get("anyOf", []))
            assert _enum_of(schema) or is_flag or pname in self_explanatory, f"{name}.{pname} has no description"


async def test_schemas_carry_no_redundant_titles():
    for name, tool in (await _tools()).items():
        for pname, schema in tool.inputSchema.get("properties", {}).items():
            assert "title" not in schema, f"{name}.{pname}"
    # ...but a parameter that is itself called "title" survives
    assert "title" in (await _tools())["create_ticket"].inputSchema["properties"]


async def test_the_tool_list_stays_compact():
    tools = await _tools()
    size = sum(len(t.description or "") + len(json.dumps(t.inputSchema, separators=(",", ":"))) for t in tools.values())
    assert size < 40_000, f"tool list is {size} characters (about {size // 4} tokens): trim descriptions or schemas"


async def test_server_instructions_explain_the_ids_and_conventions():
    text = mcp.instructions or ""
    for must in ("IAM-12", "IDEA-N", "clear_fields", "get_ticket_workspace_path", "AI agent"):
        assert must in text


async def test_schema_enums_match_the_services():
    tools = await _tools()

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
        await mcp.call_tool("create_idea_ticket", {"project_id": "x", "title": "t", "idea_energy": "low"})
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
    assert "activity_log" not in plain
    assert "activity_log" in await mcp_tools.get_ticket(t["id"], include_activity=True)
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
