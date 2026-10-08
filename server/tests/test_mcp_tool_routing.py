"""The 9 MCP tools end to end: every action is reached through `call_tool` (so the published schema is what is
validated), with the parameter checks and fix-it errors the tool descriptions promise."""

import json

import pytest
from mcp.server.fastmcp.exceptions import ToolError
from main import mcp
from kanban_mcp.tools.branches import BRANCH_OPS
from kanban_mcp.tools.docs import DOCS_READ_OPS, DOCS_WRITE_OPS
from kanban_mcp.tools.items import ITEM_OPS
from kanban_mcp.tools.projects import PROJECT_OPS
from kanban_mcp.tools.tickets import TICKET_OPS
from tests.test_mcp_tools import setup_db  # noqa: F401  (autouse fixture: in-memory db)


async def call(tool: str, **args):
    """Call a tool the way a client does and return its payload."""
    out = await mcp.call_tool(tool, args)
    if isinstance(
        out, tuple
    ):  # (content, structured): list results come wrapped as {"result": [...]}
        structured = out[1]
        return structured["result"] if set(structured) == {"result"} else structured
    return json.loads(out[0].text)


async def _project(prefix: str = "FAC") -> dict:
    return await call("manage_project", action="create", name="Facade", prefix=prefix)


async def _ticket(project: dict, **fields) -> dict:
    return await call(
        "manage_ticket",
        action="create",
        project_id=project["id"],
        title=fields.pop("title", "T"),
        **fields,
    )


# --------------------------------------------------------------------------- projects and members


async def test_projects_and_members():
    p = await _project()
    assert p["prefix"] == "FAC"
    assert [x["id"] for x in await call("get_projects")] == [p["id"]]

    updated = await call(
        "manage_project", action="update", project_id=p["id"], name="Renamed"
    )
    assert updated["name"] == "Renamed"

    member = await call(
        "manage_project", action="add_member", project_id=p["id"], name="Bao"
    )
    detail = await call("get_projects", project_id=p["id"])
    assert detail["name"] == "Renamed"
    assert member["id"] in [m["id"] for m in detail["members"]]

    ticket = await _ticket(p, assignee=member["id"])
    assert ticket["assignee"] == member["id"]
    with pytest.raises(ToolError, match="Reassign first"):
        await call(
            "manage_project",
            action="remove_member",
            project_id=p["id"],
            member_id=member["id"],
        )
    await call(
        "manage_ticket",
        action="update",
        ticket_id=ticket["id"],
        clear_fields=["assignee"],
    )
    removed = await call(
        "manage_project",
        action="remove_member",
        project_id=p["id"],
        member_id=member["id"],
    )
    assert removed == {"ok": True}
    after = await call("get_projects", project_id=p["id"])
    assert member["id"] not in [m["id"] for m in after["members"]]


async def test_get_projects_unknown_id_lists_the_real_ones():
    p = await _project()
    with pytest.raises(ToolError, match=p["id"]):
        await call("get_projects", project_id="nope")


# --------------------------------------------------------------------------- tickets


async def test_ticket_lifecycle_and_relations():
    p = await _project()
    a = await _ticket(p, title="a")
    b = await _ticket(p, title="b", priority="high")
    child = await _ticket(p, title="child", parent_id=a["id"])
    assert child["parent_id"] == a["id"] and b["priority"] == "high"

    moved = await call(
        "manage_ticket", action="update", ticket_id=a["id"], status="in-progress"
    )
    assert moved["status"] == "in-progress"
    await call("manage_ticket", action="update", ticket_id=a["id"], estimate=3)
    unset = await call(
        "manage_ticket", action="update", ticket_id=a["id"], clear_fields=["estimate"]
    )
    assert unset["estimate"] is None

    # b cannot proceed until a is done
    blocked = await call(
        "manage_ticket", action="block", ticket_id=b["id"], target_id=a["id"]
    )
    assert blocked["blocker"]["id"] == a["id"] and blocked["blocked"]["id"] == b["id"]
    assert a["id"] in blocked["blocked"]["blocked_by"]
    freed = await call(
        "manage_ticket", action="unblock", ticket_id=b["id"], target_id=a["id"]
    )
    assert freed["blocked"]["blocked_by"] == []

    link = await call(
        "manage_ticket",
        action="link",
        ticket_id=a["id"],
        target_id=b["id"],
        relation_type="relates_to",
    )
    with pytest.raises(ToolError, match="different id on each"):
        await call(
            "manage_ticket", action="unlink", ticket_id=b["id"], link_id=link["id"]
        )
    assert await call(
        "manage_ticket", action="unlink", ticket_id=a["id"], link_id=link["id"]
    ) == {"removed": link["id"]}

    ws = await call("manage_ticket", action="workspace", ticket_id=a["id"])
    assert set(ws) >= {"enabled", "path", "exists"}

    gone = await call("manage_ticket", action="delete", ticket_id=child["id"])
    assert gone == {"deleted": child["id"]}
    with pytest.raises(ToolError, match="not found"):
        await call("get_ticket", ticket_id=child["id"])


async def test_wont_do_needs_a_reason_and_done_guards_are_enforced():
    p = await _project()
    t = await _ticket(p)
    with pytest.raises(ToolError, match="(?i)reason"):
        await call(
            "manage_ticket", action="update", ticket_id=t["id"], status="wont_do"
        )
    done = await call(
        "manage_ticket",
        action="update",
        ticket_id=t["id"],
        status="wont_do",
        wont_do_reason="obsolete",
    )
    assert done["status"] == "wont_do"
    with pytest.raises(ToolError):
        await _ticket(p, status="wont_do")  # not a starting column


async def test_get_ticket_can_return_just_the_comments():
    p = await _project()
    t = await _ticket(p)
    await call(
        "ticket_items",
        ticket_id=t["id"],
        item="comment",
        action="add",
        text="hello",
        author="Claude",
    )
    thread = await call("get_ticket", ticket_id=t["id"], view="comments")
    assert thread["count"] == 1 and thread["comments"][0]["text"] == "hello"
    assert "description" not in thread


# --------------------------------------------------------------------------- ticket_items


async def test_comments_work_log_criteria_sub_tasks_and_test_cases():
    p = await _project()
    t = await _ticket(p)
    i = t["id"]

    after = await call(
        "ticket_items",
        ticket_id=i,
        item="comment",
        action="add",
        text="first",
        author="Claude",
    )
    cid = after["comments"][0]["id"]
    edited = await call(
        "ticket_items",
        ticket_id=i,
        item="comment",
        action="update",
        item_id=cid,
        text="second",
    )
    assert edited["comments"][0]["text"] == "second"
    hidden = await call(
        "ticket_items", ticket_id=i, item="comment", action="delete", item_id=cid
    )
    assert (await call("get_ticket", ticket_id=i, view="comments"))["count"] == 0
    assert "activity_log" not in hidden
    await call(
        "ticket_items", ticket_id=i, item="comment", action="restore", item_id=cid
    )
    assert (await call("get_ticket", ticket_id=i, view="comments"))["count"] == 1

    await call(
        "ticket_items",
        ticket_id=i,
        item="work_log",
        action="add",
        author="Claude",
        role="Developer",
        note="looked at the logs",
        log_kind="root_cause",
        pinned=True,
    )
    log = (await call("get_ticket", ticket_id=i))["work_log"][0]
    assert log["kind"] == "root_cause" and log["pinned"] is True
    resolved = await call(
        "ticket_items",
        ticket_id=i,
        item="work_log",
        action="update",
        item_id=log["id"],
        note="rewritten",
        pinned=False,
    )
    assert resolved["work_log"][0]["note"] == "rewritten"
    await call(
        "ticket_items", ticket_id=i, item="work_log", action="delete", item_id=log["id"]
    )

    with_ac = await call(
        "ticket_items", ticket_id=i, item="criterion", action="add", text="works"
    )
    ac = with_ac["acceptance_criteria"][0]
    assert ac["done"] is False
    toggled = await call(
        "ticket_items", ticket_id=i, item="criterion", action="toggle", item_id=ac["id"]
    )
    assert toggled["acceptance_criteria"][0]["done"] is True
    emptied = await call(
        "ticket_items", ticket_id=i, item="criterion", action="delete", item_id=ac["id"]
    )
    assert emptied["acceptance_criteria"] == []

    with_st = await call(
        "ticket_items", ticket_id=i, item="sub_task", action="add", text="step"
    )
    st = with_st["sub_tasks"][0]
    toggled = await call(
        "ticket_items", ticket_id=i, item="sub_task", action="toggle", item_id=st["id"]
    )
    assert toggled["sub_tasks"][0]["done"] is True
    await call(
        "ticket_items", ticket_id=i, item="sub_task", action="delete", item_id=st["id"]
    )

    await call(
        "ticket_items",
        ticket_id=i,
        item="test_case",
        action="add",
        title="it runs",
        expected_result="ok",
    )
    passed = await call(
        "ticket_items",
        ticket_id=i,
        item="test_case",
        action="update",
        item_id="TC-1",  # by code
        status="pass",
        proof="log.txt",
    )
    assert passed["test_cases"][0]["status"] == "pass"
    left = await call(
        "ticket_items", ticket_id=i, item="test_case", action="delete", item_id="TC-1"
    )
    assert left["test_cases"] == []


async def test_ticket_items_explains_a_wrong_call():
    p = await _project()
    t = await _ticket(p)
    i = t["id"]
    # an action the item does not have: the valid ones are listed
    with pytest.raises(
        ToolError, match="Valid actions for comment: add, update, delete, restore"
    ):
        await call(
            "ticket_items", ticket_id=i, item="comment", action="toggle", item_id="x"
        )
    # a missing parameter is named, with what the action takes
    with pytest.raises(ToolError, match="Missing: author"):
        await call("ticket_items", ticket_id=i, item="comment", action="add", text="hi")
    # a parameter that belongs to another item is refused instead of being silently dropped
    with pytest.raises(ToolError, match="does not use: role"):
        await call(
            "ticket_items",
            ticket_id=i,
            item="comment",
            action="add",
            text="hi",
            author="C",
            role="PM",
        )
    # a stale or unknown sub-item id lists the real ones
    await call("ticket_items", ticket_id=i, item="criterion", action="add", text="ok")
    with pytest.raises(ToolError, match="not found"):
        await call(
            "ticket_items",
            ticket_id=i,
            item="criterion",
            action="toggle",
            item_id="nope",
        )


# --------------------------------------------------------------------------- branches


async def test_branches_by_name():
    p = await _project()
    t = await _ticket(p)
    i = t["id"]
    added = await call("ticket_branches", ticket_id=i, action="add", name="feat/x")
    assert added["branches"][0]["name"] == "feat/x"
    updated = await call(
        "ticket_branches",
        ticket_id=i,
        action="update",
        branch="feat/x",
        pr_url="https://example.com/pr/1",
    )
    assert updated["branches"][0]["pr_url"] == "https://example.com/pr/1"
    renamed = await call(
        "ticket_branches", ticket_id=i, action="update", branch="feat/x", name="feat/y"
    )
    assert renamed["branches"][0]["name"] == "feat/y"
    with pytest.raises(ToolError, match="Missing: branch"):
        await call("ticket_branches", ticket_id=i, action="delete")
    with pytest.raises(ToolError, match="does not use: force"):
        await call("ticket_branches", ticket_id=i, action="add", name="z", force=True)
    gone = await call("ticket_branches", ticket_id=i, action="delete", branch="feat/y")
    assert gone["branches"] == []


async def test_branch_counts_keep_their_schema_constraint():
    p = await _project()
    t = await _ticket(p)
    with pytest.raises(ToolError):
        await call(
            "ticket_branches", ticket_id=t["id"], action="add", name="a", ahead_count=-1
        )


# --------------------------------------------------------------------------- docs


async def test_docs_read_and_write():
    p = await _project()
    pid = p["id"]
    page = await call(
        "docs_write",
        action="create",
        project_id=pid,
        title="Guide",
        markdown="## Intro\nhi",
    )
    assert page["version"] == 1
    child = await call(
        "docs_write",
        action="create",
        project_id=pid,
        title="Child",
        parent_id=page["id"],
    )

    tree = await call("docs_read", action="list", project_id=pid)
    assert {n["title"] for n in tree} == {"Guide", "Child"}
    got = await call("docs_read", action="get", page_id=page["id"])
    assert got["markdown"].startswith("## Intro") and got["version"] == 1

    updated = await call(
        "docs_write",
        action="update",
        page_id=page["id"],
        markdown="## Intro\nchanged",
        base_version=1,
        note="edit",
        title="Guide 2",
    )
    assert updated["version"] == 2 and updated["title"] == "Guide 2"
    with pytest.raises(ToolError, match="docs_read"):  # stale base_version
        await call(
            "docs_write",
            action="update",
            page_id=page["id"],
            markdown="x",
            base_version=1,
        )

    versions = await call("docs_read", action="versions", page_id=page["id"])
    assert [v["version"] for v in versions] == [2, 1]
    old = await call("docs_read", action="version", page_id=page["id"], version=1)
    assert "hi" in old["markdown"]
    diff = await call(
        "docs_read", action="version", page_id=page["id"], version=1, compare_to=2
    )
    assert diff != old
    restored = await call(
        "docs_write", action="restore_version", page_id=page["id"], version=1
    )
    assert restored["version"] == 3

    found = await call("docs_read", action="search", project_id=pid, query="Intro")
    assert found["total"] >= 1
    checked = await call(
        "docs_read",
        action="check_links",
        project_id=pid,
        refs=["[[Guide]]", "[[Nope]]"],
    )
    assert [c["status"] for c in checked] == ["ok", "missing"]

    moved = await call("docs_write", action="move", page_id=child["id"])
    assert moved["parent_id"] is None
    copy = await call(
        "docs_write", action="duplicate", page_id=page["id"], include_children=False
    )
    assert copy["title"].endswith("(copy)")

    t = await _ticket(p)
    await call(
        "manage_ticket", action="link_doc", ticket_id=t["id"], page_id=page["id"]
    )
    await call(
        "manage_ticket", action="unlink_doc", ticket_id=t["id"], page_id=page["id"]
    )

    await call("docs_write", action="delete", page_id=child["id"])
    bin_ = await call("docs_read", action="recycle_bin", project_id=pid)
    assert [b["id"] for b in bin_] == [child["id"]]
    await call("docs_write", action="restore", page_id=child["id"])
    assert await call("docs_read", action="recycle_bin", project_id=pid) == []


async def test_docs_import(tmp_path):
    p = await _project()
    (tmp_path / "a.md").write_text("# A\nbody")
    out = await call(
        "docs_write", action="import", project_id=p["id"], path=str(tmp_path)
    )
    assert len(out["created"]) == 1 and out["failed"] == []


# --------------------------------------------------------------------------- the routing itself


async def test_missing_and_foreign_parameters_name_the_action_and_what_it_takes():
    with pytest.raises(
        ToolError, match=r"manage_project\(action='create'\).*Missing: prefix"
    ):
        await call("manage_project", action="create", name="x")
    with pytest.raises(ToolError, match="does not use: repo_path"):
        await call(
            "manage_project",
            action="add_member",
            project_id="p",
            name="x",
            repo_path="/tmp",
        )
    with pytest.raises(
        ToolError, match="requires project_id, query; optional: scope, limit"
    ):
        await call("docs_read", action="search")


async def test_an_unknown_action_is_rejected_by_the_schema():
    with pytest.raises(ToolError):
        await call("manage_ticket", action="explode", ticket_id="X-1")


async def test_changes_are_attributed_to_the_agent():
    p = await _project()
    t = await _ticket(p)
    await call("manage_ticket", action="update", ticket_id=t["id"], title="renamed")
    log = (await call("get_ticket", ticket_id=t["id"], activity_limit=-1))[
        "activity_log"
    ]
    assert any(e.get("field") == "title" and e.get("actor") for e in log)


def test_every_table_entry_names_real_parameters():
    """A typo in a table would only show when that action is used; check them all once."""
    import inspect

    tables = [
        PROJECT_OPS,
        TICKET_OPS,
        BRANCH_OPS,
        DOCS_READ_OPS,
        DOCS_WRITE_OPS,
        ITEM_OPS,
    ]
    for table in tables:
        for key, op in table.items():
            params = set(inspect.signature(op.impl).parameters)
            for name in op.required + op.optional:
                assert op.rename.get(name, name) in params, (key, name)
