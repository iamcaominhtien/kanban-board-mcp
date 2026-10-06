# ruff: noqa: F811
"""Ticket text refs (AC / test case / debug note origins), comment edit-delete-undo,
mentions and the doc_ref activity entries."""

import json

import events as board_events
from tests.test_docs import c, mk, pid, publish, setup_db  # noqa: F401  (fixtures)


async def _ticket(c, pid, **kw):
    r = await c.post(f"/projects/{pid}/tickets", json={"title": "T", "type": "task", **kw})
    assert r.status_code == 201, r.text
    return r.json()


async def test_linked_docs_cover_ac_test_case_and_debug_note(c, pid):
    await publish(c, await mk(c, pid, "Spec"), "## Auth\nrules")
    t = await _ticket(c, pid, description="see [[Spec#Auth]]")
    key = t["id"]
    await c.post(f"/tickets/{key}/acceptance-criteria", json={"text": "follows [[Spec]]"})
    r = await c.post(
        f"/tickets/{key}/test-cases",
        json={"title": "tc", "expected_result": "matches [[Spec#Auth]]"},
    )
    assert r.status_code in (200, 201), r.text
    await c.post(
        f"/tickets/{key}/work-log",
        json={"author": "bao", "role": "Developer", "note": "root cause in [[Spec]]", "kind": "root_cause"},
    )
    rows = (await c.get(f"/tickets/{key}/docs")).json()
    origins = {(d["origin"], d["detail"]) for d in rows}
    assert ("description", "") in origins
    assert ("acceptance_criterion", "") in origins
    assert ("test_case", "TC-1") in origins
    assert ("debug_note", "") in origins
    page_id = rows[0]["page_id"]
    back = (await c.get(f"/docs/pages/{page_id}/backlinks")).json()
    assert {(b["origin"], b["detail"]) for b in back["tickets"]} >= {("test_case", "TC-1"), ("debug_note", "")}


async def test_comment_edit_delete_restore_and_mentions(c, pid):
    t = await _ticket(c, pid)
    key = t["id"]
    mem = (await c.post(f"/projects/{pid}/members", json={"name": "Linh Pham", "color": "#2E6F40"})).json()
    posted = (
        await c.post(
            f"/tickets/{key}/comments",
            json={"text": f"look @[Linh Pham](member:{mem['id']})", "author": "user"},
        )
    ).json()
    cm = posted["comments"][0]
    assert cm["edited_at"] is None and cm["mentions"] == [mem["id"]]
    assert {n["name"] for n in cm["notified"]} == {"Admin", "Linh Pham"}  # reporter + mention

    edited = (await c.patch(f"/tickets/{key}/comments/{cm['id']}", json={"text": "changed"})).json()
    assert edited["comments"][0]["edited_at"] and edited["comments"][0]["mentions"] == []

    gone = (await c.delete(f"/tickets/{key}/comments/{cm['id']}")).json()
    assert gone["comments"] == []
    assert (await c.get(f"/tickets/{key}")).json()["comments"] == []
    undone = (await c.post(f"/tickets/{key}/comments/{cm['id']}/restore")).json()
    assert [x["id"] for x in undone["comments"]] == [cm["id"]]
    assert (await c.post(f"/tickets/{key}/comments/{cm['id']}/restore")).status_code == 404


async def test_deleted_comment_mentions_do_not_link_docs(c, pid):
    page = await publish(c, await mk(c, pid, "Spec"), "x")
    t = await _ticket(c, pid)
    cid = (await c.post(f"/tickets/{t['id']}/comments", json={"text": "see [[Spec]]"})).json()["comments"][0]["id"]
    assert [d["origin"] for d in (await c.get(f"/tickets/{t['id']}/docs")).json()] == ["comment"]
    await c.delete(f"/tickets/{t['id']}/comments/{cid}")
    assert (await c.get(f"/tickets/{t['id']}/docs")).json() == []
    assert page["id"]


async def test_comment_activity_carries_comment_id_and_event_is_published(c, pid, monkeypatch):
    sent: list[str] = []

    async def fake_publish(msg: str = "invalidate") -> None:
        sent.append(msg)

    monkeypatch.setattr(board_events, "publish", fake_publish)
    t = await _ticket(c, pid)
    mem = (await c.post(f"/projects/{pid}/members", json={"name": "Hoa Mai", "color": "#2E6F40"})).json()
    posted = (
        await c.post(
            f"/tickets/{t['id']}/comments",
            json={"text": f"cc @[Hoa Mai](member:{mem['id']})", "author": "user"},
        )
    ).json()
    cid = posted["comments"][0]["id"]
    log = [e for e in posted["activity_log"] if e["field"] == "comment"]
    assert log and log[0]["ref"] == cid
    events = [json.loads(m) for m in sent if m.startswith("{")]
    assert events and events[0]["type"] == "comment_added" and events[0]["comment_id"] == cid
    assert {n["name"] for n in events[0]["notified"]} == {"Admin", "Hoa Mai"}


async def test_description_edit_logs_doc_ref_added_and_removed(c, pid):
    await publish(c, await mk(c, pid, "Spec"), "## Auth\nx")
    t = await _ticket(c, pid, description="Follow [[Old rules]].")
    r = await c.patch(
        f"/tickets/{t['id']}",
        json={"description": "Follow [[Spec#Auth]] and [[Spec]]."},
    )
    assert r.status_code == 200, r.text
    log = r.json()["activity_log"]
    added = [e["to"] for e in log if e["field"] == "doc_ref_added"]
    removed = [e["from"] for e in log if e["field"] == "doc_ref_removed"]
    assert added == ["Spec#Auth", "Spec"] and removed == ["Old rules"]
    assert all(e["ref"] == "description" for e in log if e["field"].startswith("doc_ref"))
