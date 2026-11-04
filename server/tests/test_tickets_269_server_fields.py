"""Issue #269, the design rows that needed data from the server: whose review a ticket in Review waits for, a test
case's files beside its Expected result and Notes and who started or decided it, and a doc reference added or removed
anywhere on a ticket (a comment, a test case, Linked docs) written in its Activity."""

from kanban_mcp import operations as ops
from tests.ai_helpers import _project, _runner, _ticket, env  # noqa: F401

AN = {"X-Actor": "An Nguyen"}


async def _fields(c, tid):
    return (await c.get(f"/tickets/{tid}")).json()


# --- 5. Review requested ----------------------------------------------------------------------------------------


async def test_a_person_names_whose_review_a_ticket_waits_for(env):
    c = env["c"]
    pid, an = await _project(c)
    ha = (await c.post(f"/projects/{pid}/members", json={"name": "Ha My"})).json()
    tid = await _ticket(c, pid)
    r = await c.patch(
        f"/tickets/{tid}",
        json={"status": "review", "review_requested_from": ha["id"]},
        headers=AN,
    )
    assert r.status_code == 200, r.text
    t = await _fields(c, tid)
    assert t["review_requested_from"] == ha["id"]
    assert any(e["field"] == "review_requested_from" for e in t["activity_log"])
    # someone outside the project is refused
    other = (
        await c.post(
            "/projects", json={"name": "O", "prefix": "OTH", "color": "#123456"}
        )
    ).json()
    stranger = (
        await c.post(f"/projects/{other['id']}/members", json={"name": "X"})
    ).json()
    r = await c.patch(f"/tickets/{tid}", json={"review_requested_from": stranger["id"]})
    assert r.status_code in (400, 422)
    # an AI clears it over MCP like any other field
    out = await ops.update_ticket(tid, clear_fields=["review_requested_from"])
    assert out["review_requested_from"] is None


async def test_entering_review_asks_the_reviewer_the_ticket_already_has(env):
    c = env["c"]
    pid, _ = await _project(c)
    rin = await _runner(c, pid, env["repo"], name="Reviewer Rin")
    tid = await _ticket(c, pid)
    r = await c.put(f"/tickets/{tid}/ai/reviewer", json={"member_id": rin["id"]})
    assert r.status_code == 200, r.text
    await c.patch(f"/tickets/{tid}", json={"status": "in-progress"})
    assert (await _fields(c, tid))["review_requested_from"] is None
    await c.patch(f"/tickets/{tid}", json={"status": "review"})
    assert (await _fields(c, tid))["review_requested_from"] == rin["id"]
    # a person's own choice is never replaced
    ha = (await c.post(f"/projects/{pid}/members", json={"name": "Ha My"})).json()
    await c.patch(f"/tickets/{tid}", json={"status": "in-progress"})
    await c.patch(f"/tickets/{tid}", json={"review_requested_from": ha["id"]})
    await c.patch(f"/tickets/{tid}", json={"status": "review"})
    assert (await _fields(c, tid))["review_requested_from"] == ha["id"]


# --- 6. Test case files and who -----------------------------------------------------------------------------------


async def test_a_test_case_keeps_files_by_field_and_who_ran_and_decided_it(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid)
    t = (
        await c.post(
            f"/tickets/{tid}/test-cases",
            json={"title": "Drop moves the card"},
            headers=AN,
        )
    ).json()
    tc = t["test_cases"][0]
    shot = {
        "id": "f1",
        "name": "expected.png",
        "url": "/uploads/expected.png",
        "size": 10,
    }
    rec = {"id": "f2", "name": "ghost.mov", "url": "/uploads/ghost.mov", "size": 20}
    t = (
        await c.patch(
            f"/tickets/{tid}/test-cases/{tc['id']}",
            json={"status": "running", "expected_files": [shot]},
            headers={"X-Actor": "Ha My"},
        )
    ).json()
    tc = t["test_cases"][0]
    assert tc["expected_files"] == [shot] and tc["notes_files"] == []
    assert tc["started_by"] == "Ha My" and tc["started_at"]
    t = (
        await c.patch(
            f"/tickets/{tid}/test-cases/{tc['id']}",
            json={"status": "fail", "notes_files": [rec]},
            headers={"X-Actor": "Tuan Vo"},
        )
    ).json()
    tc = t["test_cases"][0]
    assert tc["status_by"] == "Tuan Vo" and tc["status_at"]
    assert tc["notes_files"] == [rec] and tc["expected_files"] == [shot]
    # the person who started it stays the one who started it
    assert tc["started_by"] == "Ha My"


# --- 7. Doc references in Activity --------------------------------------------------------------------------------


async def _page(c, pid, title):
    r = await c.post(
        f"/projects/{pid}/docs/pages",
        json={"title": title, "markdown": "## Endpoints\n"},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


def _refs(t):
    return [
        (e["field"], e.get("from"), e.get("to"), e.get("ref"))
        for e in t["activity_log"]
        if e["field"] in ("doc_ref_added", "doc_ref_removed")
    ]


async def test_doc_references_in_comments_test_cases_and_linked_docs_reach_activity(
    env,
):
    c = env["c"]
    pid, _ = await _project(c)
    page = await _page(c, pid, "API")
    tid = await _ticket(c, pid)
    # a comment
    t = (
        await c.post(
            f"/tickets/{tid}/comments",
            json={"text": "See [[API#Endpoints]]", "author": "An Nguyen"},
        )
    ).json()
    assert ("doc_ref_added", None, "API#Endpoints", "a comment") in _refs(t)
    comment = t["comments"][-1]
    t = (
        await c.patch(
            f"/tickets/{tid}/comments/{comment['id']}", json={"text": "No link now"}
        )
    ).json()
    assert ("doc_ref_removed", "API#Endpoints", None, "a comment") in _refs(t)
    # a test case
    t = (
        await c.post(
            f"/tickets/{tid}/test-cases",
            json={"title": "List", "expected_result": "As in [[API]]"},
        )
    ).json()
    assert ("doc_ref_added", None, "API", "test case TC-1") in _refs(t)
    # Linked docs, by hand
    assert (
        await c.post(f"/tickets/{tid}/docs", json={"page_id": page["id"]})
    ).status_code in (200, 201)
    t = await _fields(c, tid)
    assert ("doc_ref_added", None, "API", "Linked docs") in _refs(t)
    r = await c.delete(f"/tickets/{tid}/docs/{page['id']}")
    assert r.status_code in (200, 204), r.text
    t = await _fields(c, tid)
    assert ("doc_ref_removed", "API", None, "Linked docs") in _refs(t)
