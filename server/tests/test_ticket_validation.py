import pytest

from kanban_mcp import operations as ops
from tests.test_activity import _ticket, client, setup_db  # noqa: F401  (fixtures)


async def _second(c, project_id, title="b", **kw):
    r = await c.post(f"/projects/{project_id}/tickets", json={"title": title, **kw})
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.parametrize(
    "body",
    [
        {"title": ""},
        {"title": "   "},
        {"title": "x" * 301},
        {"due_date": "not-a-date"},
        {"start_date": "2026-13-45"},
        {"start_date": "2026-12-01", "due_date": "2026-01-01"},
        {"estimate": -5},
        {"estimate": 1e12},
        {"tags": [1]},
        {"tags": [{"a": 1}]},
        {"tags": ["x" * 51]},
        {"tags": [f"t{i}" for i in range(31)]},
    ],
)
async def test_bad_ticket_fields_are_rejected(client, body):
    async with client as c:
        _, t = await _ticket(c)
        r = await c.patch(f"/tickets/{t['id']}", json=body)
        assert r.status_code == 400, (body, r.text)
        assert (await c.get(f"/tickets/{t['id']}")).json()["title"] == "t"


async def test_valid_values_are_normalised(client):
    async with client as c:
        _, t = await _ticket(c)
        r = await c.patch(
            f"/tickets/{t['id']}",
            json={
                "title": "  Hello  ",
                "tags": [" a ", "A", "", "b"],
                "due_date": "2026-05-01",
                "start_date": "2026-04-01",
                "estimate": 3.5,
            },
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert (
            j["title"] == "Hello" and j["tags"] == ["a", "b"] and j["estimate"] == 3.5
        )
        # explicit null / empty string clears the date
        r = await c.patch(
            f"/tickets/{t['id']}", json={"due_date": "", "start_date": None}
        )
        assert r.json()["due_date"] is None and r.json()["start_date"] is None


async def test_create_validates_too(client):
    async with client as c:
        p, _ = await _ticket(c)
        for body in (
            {"title": " "},
            {"title": "ok", "due_date": "bad"},
            {"title": "ok", "estimate": -1},
        ):
            r = await c.post(f"/projects/{p['id']}/tickets", json=body)
            assert r.status_code == 400, (body, r.text)


async def test_parent_rules(client):
    async with client as c:
        p, a = await _ticket(c)
        b = await _second(c, p["id"], "b")
        child = await _second(c, p["id"], "child")
        other_p = (
            await c.post(
                "/projects", json={"name": "O", "prefix": "OTH", "color": "#123456"}
            )
        ).json()
        o = await _second(c, other_p["id"], "o")
        assert (
            await c.patch(f"/tickets/{a['id']}", json={"parent_id": a["id"]})
        ).status_code == 400  # self
        assert (
            await c.patch(f"/tickets/{a['id']}", json={"parent_id": "ZZZ-9"})
        ).status_code == 400  # missing
        assert (
            await c.patch(f"/tickets/{a['id']}", json={"parent_id": o})
        ).status_code == 400  # other project
        assert (
            await c.patch(f"/tickets/{child}", json={"parent_id": b})
        ).status_code == 200
        # b is now a child's parent: it can't itself get a parent, and a child can't become a parent
        assert (
            await c.patch(f"/tickets/{b}", json={"parent_id": a["id"]})
        ).status_code == 400
        assert (
            await c.patch(f"/tickets/{a['id']}", json={"parent_id": child})
        ).status_code == 400
        # clearing is fine
        assert (
            await c.patch(f"/tickets/{child}", json={"parent_id": None})
        ).status_code == 200
        r = await c.post(
            f"/projects/{p['id']}/tickets", json={"title": "x", "parent_id": o}
        )
        assert r.status_code == 400


async def test_block_rules(client):
    async with client as c:
        p, a = await _ticket(c)
        b = await _second(c, p["id"])
        d = await _second(c, p["id"], "d")
        other_p = (
            await c.post(
                "/projects", json={"name": "O", "prefix": "OTH", "color": "#123456"}
            )
        ).json()
        o = await _second(c, other_p["id"], "o")
        assert (
            await c.post(f"/tickets/{a['id']}/blocks/{o}")
        ).status_code == 400  # cross-project
        assert (await c.post(f"/tickets/{a['id']}/blocks/{b}")).status_code == 200
        assert (
            await c.post(f"/tickets/{b}/blocks/{a['id']}")
        ).status_code == 400  # direct cycle
        assert (await c.post(f"/tickets/{b}/blocks/{d}")).status_code == 200
        assert (
            await c.post(f"/tickets/{d}/blocks/{a['id']}")
        ).status_code == 400  # transitive cycle


async def test_text_fields_must_not_be_blank(client):
    async with client as c:
        _, t = await _ticket(c)
        i = t["id"]
        assert (
            await c.post(f"/tickets/{i}/comments", json={"text": "  ", "author": "x"})
        ).status_code == 400
        assert (
            await c.post(
                f"/tickets/{i}/comments", json={"text": "y" * 50001, "author": "x"}
            )
        ).status_code == 400
        assert (
            await c.post(f"/tickets/{i}/acceptance-criteria", json={"text": " "})
        ).status_code == 400
        assert (
            await c.post(f"/tickets/{i}/test-cases", json={"title": " "})
        ).status_code == 400
        ok = await c.post(
            f"/tickets/{i}/comments", json={"text": " hi ", "author": "x"}
        )
        assert ok.status_code == 200 and ok.json()["comments"][0]["text"] == "hi"
        cid = ok.json()["comments"][0]["id"]
        assert (
            await c.patch(f"/tickets/{i}/comments/{cid}", json={"text": ""})
        ).status_code == 400
        tc = (await c.post(f"/tickets/{i}/test-cases", json={"title": "tc"})).json()[
            "test_cases"
        ][0]["id"]
        assert (
            await c.patch(f"/tickets/{i}/test-cases/{tc}", json={"title": " "})
        ).status_code == 400


async def test_delete_ticket_leaves_no_dangling_references(client):
    async with client as c:
        p, parent = await _ticket(c)
        child = await _second(c, p["id"], "child", parent_id=parent["id"])
        peer = await _second(c, p["id"], "peer")
        await c.post(f"/tickets/{parent['id']}/blocks/{peer}")
        await c.post(
            f"/tickets/{parent['id']}/links",
            json={"target_id": peer, "relation_type": "relates_to"},
        )
        assert (await c.delete(f"/tickets/{parent['id']}")).status_code == 204
        ch = (await c.get(f"/tickets/{child}")).json()
        assert ch["parent_id"] is None
        pr = (await c.get(f"/tickets/{peer}")).json()
        assert pr["blocked_by"] == []
        assert pr["links"] == []


async def test_mcp_can_set_and_clear_fields(client):
    async with client as c:
        p, t = await _ticket(c)
        m = (
            await c.post(
                f"/projects/{p['id']}/members", json={"name": "Bao", "color": "#2E6F40"}
            )
        ).json()
    i = t["id"]
    r = await ops.update_ticket(
        i,
        assignee=m["id"],
        start_date="2026-01-01",
        due_date="2026-02-01",
        estimate=2,
        block_done_if_acs_incomplete=True,
        block_done_if_tcs_incomplete=True,
    )
    assert r["assignee"] == m["id"] and r["start_date"] == "2026-01-01"
    assert (
        r["block_done_if_acs_incomplete"] is True
        and r["block_done_if_tcs_incomplete"] is True
    )
    r = await ops.update_ticket(i, clear_fields=["assignee", "due_date", "estimate"])
    assert r["assignee"] is None and r["due_date"] is None and r["estimate"] is None
    with pytest.raises(ValueError):
        await ops.update_ticket(i, clear_fields=["title"])
    with pytest.raises(ValueError):
        await ops.update_ticket(i, estimate=1, clear_fields=["estimate"])
    # won't do needs a reason
    with pytest.raises(ValueError):
        await ops.update_ticket_status(i, "wont_do")
    r = await ops.update_ticket_status(i, "wont_do", wont_do_reason="duplicate work")
    assert r["status"] == "wont_do" and r["wont_do_reason"] == "duplicate work"


async def test_mcp_block_link_test_case_and_delete_tools(client):
    async with client as c:
        p, a = await _ticket(c)
        b = await _second(c, p["id"])
        tc = (
            await c.post(f"/tickets/{a['id']}/test-cases", json={"title": "tc"})
        ).json()
    res = await ops.block_ticket(a["id"], b)
    assert b in res["blocker"]["blocks"] and a["id"] in res["blocked"]["blocked_by"]
    with pytest.raises(ValueError):
        await ops.block_ticket(b, a["id"])
    res = await ops.unblock_ticket(a["id"], b)
    assert res["blocker"]["blocks"] == []
    link = await ops.link_tickets(a["id"], b, "relates_to")
    assert link["target_id"] == b
    assert await ops.unlink_tickets(a["id"], link["id"]) == {"removed": link["id"]}
    after = await ops.delete_test_case(a["id"], tc["test_cases"][0]["id"])
    assert after["test_cases"] == []
    assert await ops.delete_ticket(b) == {"deleted": b}
    with pytest.raises(ValueError, match="not found"):
        await ops.delete_ticket(b)
