"""Docs v2: rename preview + link rewrite, heading aliases, delete preview, docs_enabled,
ticket <-> docs origins, recycle bin, notifications and request ids."""

import json

import pytest

import events as board_events
from tests.test_docs import c, mk, pid, publish, setup_db  # noqa: F401  (fixtures)


async def _ticket(c, pid, **kw):
    r = await c.post(
        f"/projects/{pid}/tickets", json={"title": "T", "type": "task", **kw}
    )
    assert r.status_code == 201, r.text
    return r.json()


# --- page detail stats -------------------------------------------------------


async def test_page_detail_has_stats(c, pid):
    target = await publish(c, await mk(c, pid, "Spec"), "## A\none two three four")
    await publish(c, await mk(c, pid, "Src"), "See [[Spec]] and again [[Spec#A]].")
    t = await _ticket(c, pid, description="read [[Spec]]")
    detail = (await c.get(f"/docs/pages/{target['id']}")).json()
    assert detail["stats"] == {"words": 6, "linked_tickets": 1, "inbound_links": 1}
    assert detail["created_at"] and detail["created_by"]
    await c.post(f"/tickets/{t['id']}/docs", json={"page_id": target["id"]})
    again = (await c.get(f"/docs/pages/{target['id']}")).json()
    assert again["stats"]["linked_tickets"] == 1  # same ticket, still one


# --- rename preview + rewrite ------------------------------------------------


async def test_rename_preview_counts_links_in_published_text_and_drafts(c, pid):
    target = await publish(c, await mk(c, pid, "Old name"), "## Intro\nx")
    a = await publish(
        c,
        await mk(c, pid, "A"),
        "[[Old name]] and [[old name#Intro]] and [[Old name|label]]",
    )
    b = await mk(c, pid, "B")  # draft only
    await c.put(f"/docs/pages/{b['id']}/draft", json={"markdown": "just [[Old name]]"})
    await publish(c, await mk(c, pid, "C"), "unrelated [[Other]]")
    prev = (
        await c.get(
            f"/docs/pages/{target['id']}/rename-preview", params={"title": "New"}
        )
    ).json()
    assert prev["total"] == 4
    assert {(p["title"], p["count"]) for p in prev["affected_pages"]} == {
        ("A", 3),
        ("B", 1),
    }
    assert prev["affected_pages"][0]["page_id"] == a["id"]
    same = (
        await c.get(
            f"/docs/pages/{target['id']}/rename-preview", params={"title": "Old name"}
        )
    ).json()
    assert same == {"affected_pages": [], "total": 0}
    bad = await c.get(
        f"/docs/pages/{target['id']}/rename-preview", params={"title": " "}
    )
    assert bad.status_code == 422


async def test_rename_with_rewrite_updates_links_drafts_and_versions(c, pid):
    target = await publish(c, await mk(c, pid, "Old name"), "## Intro\nx")
    a = await publish(
        c,
        await mk(c, pid, "A"),
        "[[Old name]], [[Old name#Intro]], [[old name|the label]], `[[Old name]]` in code\n"
        "```\n[[Old name]]\n```\n[[Other]]",
    )
    b = await mk(c, pid, "B")
    await c.put(
        f"/docs/pages/{b['id']}/draft", json={"markdown": "draft [[Old name|shown]]"}
    )
    r = await c.patch(
        f"/docs/pages/{target['id']}", json={"title": "New name", "rewrite_links": True}
    )
    assert r.status_code == 200
    body = r.json()
    assert (
        body["title"] == "New name"
        and body["rewritten"] == 4
        and body["rewritten_pages"] == 2
    )
    page_a = (await c.get(f"/docs/pages/{a['id']}")).json()
    assert page_a["version"] == 2
    assert page_a["markdown"].splitlines()[0] == (
        "[[New name]], [[New name#Intro]], [[New name|the label]], `[[Old name]]` in code"
    )
    assert "```\n[[Old name]]\n```" in page_a["markdown"]  # code untouched
    assert page_a["markdown"].endswith("[[Other]]")
    versions = (await c.get(f"/docs/pages/{a['id']}/versions")).json()
    assert versions[0]["note"] == 'Link to "New name" updated'
    page_b = (await c.get(f"/docs/pages/{b['id']}")).json()
    assert page_b["draft"]["markdown"] == "draft [[New name|shown]]"
    # the link index follows: the backlink still points at the renamed page
    bl = (await c.get(f"/docs/pages/{target['id']}/backlinks")).json()
    assert [p["page_id"] for p in bl["pages"]] == [a["id"]]


async def test_rename_without_rewrite_leaves_links_alone(c, pid):
    target = await publish(c, await mk(c, pid, "Old"), "## S\nx")
    a = await publish(c, await mk(c, pid, "A"), "[[Old]]")
    r = await c.patch(f"/docs/pages/{target['id']}", json={"title": "New"})
    assert r.json()["rewritten"] == 0
    assert (await c.get(f"/docs/pages/{a['id']}")).json()["version"] == 1


async def test_rewrite_keeps_drafts_publishable_and_skips_ambiguous_titles(c, pid):
    target = await publish(c, await mk(c, pid, "Old"), "x")
    a = await publish(c, await mk(c, pid, "A"), "[[Old]]")
    await c.put(
        f"/docs/pages/{a['id']}/draft",
        json={"markdown": "[[Old]] plus edits", "base_version": 1},
    )
    await c.patch(
        f"/docs/pages/{target['id']}", json={"title": "New", "rewrite_links": True}
    )
    detail = (await c.get(f"/docs/pages/{a['id']}")).json()
    assert detail["version"] == 2 and detail["draft"]["base_version"] == 2
    ok = await c.post(f"/docs/pages/{a['id']}/publish", json={"base_version": 2})
    assert ok.status_code == 200 and "[[New]] plus edits" in ok.json()["markdown"]

    # a second page titled "Same" at the top: [[Same]] resolves to it, so renaming the nested one rewrites nothing
    top = await publish(c, await mk(c, pid, "Same"), "x")
    nested = await publish(c, await mk(c, pid, "Same", parent_id=top["id"]), "x")
    await publish(c, await mk(c, pid, "Linker"), "[[Same]]")
    prev = (
        await c.get(
            f"/docs/pages/{nested['id']}/rename-preview", params={"title": "Else"}
        )
    ).json()
    assert prev["total"] == 0


async def test_rewrite_rejects_titles_that_cannot_be_links(c, pid):
    target = await publish(c, await mk(c, pid, "Old"), "x")
    r = await c.patch(
        f"/docs/pages/{target['id']}", json={"title": "C# tips", "rewrite_links": True}
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "title_not_linkable"
    ok = await c.patch(f"/docs/pages/{target['id']}", json={"title": "C# tips"})
    assert ok.status_code == 200 and ok.json()["title"] == "C# tips"


# --- heading rename aliases --------------------------------------------------


async def test_heading_rename_keeps_old_anchor_links_working(c, pid):
    target = await publish(
        c, await mk(c, pid, "Guide"), "## Intro\na\n## Setup\nb\n## Usage\nc"
    )
    refs = [{"kind": "page", "title": "Guide", "anchor": "Setup"}]
    r = lambda: c.post(f"/projects/{pid}/docs/resolve", json={"refs": refs})  # noqa: E731
    assert (await r()).json()[0]["status"] == "ok"
    await publish(c, target, "## Intro\na\n## Installation\nb\n## Usage\nc")
    res = (await r()).json()[0]
    assert (
        res["status"] == "ok"
        and res["anchor"] == "installation"
        and res["anchor_renamed"] is True
    )
    assert res["section"] == "Installation"
    # chained rename keeps the first alias alive
    await publish(c, target, "## Intro\na\n## Getting started\nb\n## Usage\nc")
    res = (await r()).json()[0]
    assert res["status"] == "ok" and res["anchor"] == "getting-started"
    # removing the heading entirely (no replacement) breaks it
    await publish(c, target, "## Intro\na\n## Usage\nc")
    assert (await r()).json()[0]["status"] == "section_missing"


async def test_alias_does_not_apply_when_heading_count_changes_or_slug_is_reused(
    c, pid
):
    target = await publish(c, await mk(c, pid, "Guide"), "## One\na\n## Two\nb")
    await publish(
        c, target, "## One\na\n## Two\nb\n## Three\nc"
    )  # pure addition: no alias
    refs = [{"kind": "page", "title": "Guide", "anchor": "Gone"}]
    assert (await c.post(f"/projects/{pid}/docs/resolve", json={"refs": refs})).json()[
        0
    ]["status"] == "section_missing"
    await publish(c, target, "## One\na\n## Zwei\nb\n## Three\nc")
    refs = [{"kind": "page", "title": "Guide", "anchor": "Two"}]
    assert (await c.post(f"/projects/{pid}/docs/resolve", json={"refs": refs})).json()[
        0
    ]["anchor"] == "zwei"
    # re-creating the old heading makes it a real heading again (the alias is dropped)
    await publish(c, target, "## One\na\n## Two\nb\n## Zwei\nz\n## Three\nc")
    res = (await c.post(f"/projects/{pid}/docs/resolve", json={"refs": refs})).json()[0]
    assert res["anchor"] == "two" and "anchor_renamed" not in res


# --- delete preview ----------------------------------------------------------


async def test_delete_preview_lists_subtree_and_linking_pages(c, pid):
    root = await publish(c, await mk(c, pid, "Root"), "x")
    kid = await publish(c, await mk(c, pid, "Kid", parent_id=root["id"]), "x")
    await publish(c, await mk(c, pid, "Linker"), "[[Root]] and [[Kid]]")
    await publish(c, await mk(c, pid, "Linker 2"), "[[Kid#Nope]]")
    await publish(
        c, await mk(c, pid, "Inside", parent_id=root["id"]), "[[Root]]"
    )  # inside the subtree: not counted
    prev = (await c.get(f"/docs/pages/{root['id']}/delete-preview")).json()
    roles = {(p["title"], p["role"]) for p in prev["pages"]}
    assert roles == {("Root", "this"), ("Kid", "child"), ("Inside", "child")}
    assert prev["pages"][0]["role"] == "this" and prev["linking_pages"] == 2
    leaf = (await c.get(f"/docs/pages/{kid['id']}/delete-preview")).json()
    assert (
        leaf["pages"] == [{"id": kid["id"], "title": "Kid", "role": "this"}]
        and leaf["linking_pages"] == 2
    )


# --- docs_enabled ------------------------------------------------------------


async def test_docs_disabled_project_answers_403_everywhere(c, pid):
    page = await publish(c, await mk(c, pid, "P"), "x")
    t = await _ticket(c, pid)
    r = await c.patch(f"/projects/{pid}", json={"docs_enabled": False})
    assert r.status_code == 200 and r.json()["docs_enabled"] is False
    assert any(p["docs_enabled"] is False for p in (await c.get("/projects")).json())
    calls = [
        c.get(f"/projects/{pid}/docs/tree"),
        c.post(f"/projects/{pid}/docs/pages", json={"title": "n"}),
        c.get(f"/docs/pages/{page['id']}"),
        c.get(f"/docs/pages/{page['id']}/versions"),
        c.get(f"/docs/pages/{page['id']}/backlinks"),
        c.get(f"/projects/{pid}/docs/recycle-bin"),
        c.delete(f"/projects/{pid}/docs/recycle-bin"),
        c.get(f"/projects/{pid}/docs/search", params={"q": "x"}),
        c.get(f"/projects/{pid}/docs/similar", params={"slug": "x"}),
        c.get(f"/docs/pages/{page['id']}/rename-preview", params={"title": "q"}),
        c.get(f"/docs/pages/{page['id']}/delete-preview"),
        c.post(
            f"/projects/{pid}/docs/import",
            files=[("files", ("a.md", b"x"))],
            data={"dry_run": "true"},
        ),
        c.post(f"/tickets/{t['id']}/docs", json={"page_id": page["id"]}),
    ]
    for call in calls:
        resp = await call
        assert resp.status_code == 403, resp.request.url
        assert resp.json()["detail"]["code"] == "docs_disabled"
    assert (
        await c.get(f"/tickets/{t['id']}/docs")
    ).json() == []  # the ticket modal just shows nothing
    await c.patch(f"/projects/{pid}", json={"docs_enabled": True})
    assert (await c.get(f"/projects/{pid}/docs/tree")).status_code == 200


async def test_new_projects_have_docs_enabled(c, pid):
    assert (await c.get("/projects")).json()[0]["docs_enabled"] is True


# --- ticket <-> docs ---------------------------------------------------------


async def test_ticket_docs_origins_description_comment_manual_and_page(c, pid):
    spec = await publish(c, await mk(c, pid, "Spec"), "## Design\nx")
    other = await publish(c, await mk(c, pid, "Other"), "x")
    manual = await publish(c, await mk(c, pid, "Manual page"), "x")
    t = await _ticket(
        c, pid, description="Intro. See [[Spec#Design]] for the plan. Thanks."
    )
    key = t["id"]
    await c.post(
        f"/tickets/{key}/comments",
        json={"text": "also check [[Other]]", "author": "me"},
    )
    await publish(c, await mk(c, pid, "Mentions"), f"## Notes\nTracked in {key}.")
    r = await c.post(f"/tickets/{key}/docs", json={"page_id": manual["id"]})
    assert r.status_code == 201 and r.json()["origin"] == "manual"
    again = await c.post(f"/tickets/{key}/docs", json={"page_id": manual["id"]})
    assert again.status_code == 201  # idempotent
    rows = (await c.get(f"/tickets/{key}/docs")).json()
    assert [(d["title"], d["origin"]) for d in rows] == [
        ("Spec", "description"),
        ("Other", "comment"),
        ("Manual page", "manual"),
        ("Mentions", "page"),
    ]
    spec_row = rows[0]
    assert (
        spec_row["section"] == "Design"
        and spec_row["snippet"] == "See Spec for the plan."
    )
    assert (
        spec_row["page_id"] == spec["id"]
        and spec_row["path"] == []
        and spec_row["version"] == 1
    )
    assert rows[3]["section"] == "notes" and "Tracked in" in rows[3]["snippet"]
    assert set(rows[0]) == {
        "page_id",
        "project_id",
        "title",
        "path",
        "section",
        "snippet",
        "origin",
        "version",
    }

    # manual links can be removed; derived ones cannot
    gone = await c.delete(f"/tickets/{key}/docs/{manual['id']}")
    assert gone.json() == {"removed": 1}
    assert await c.delete(f"/tickets/{key}/docs/{other['id']}") is not None
    rows = (await c.get(f"/tickets/{key}/docs")).json()
    assert "manual" not in [d["origin"] for d in rows] and "comment" in [
        d["origin"] for d in rows
    ]


async def test_description_edit_refreshes_the_ticket_doc_links_and_backlinks(c, pid):
    spec = await publish(c, await mk(c, pid, "Spec"), "x")
    t = await _ticket(c, pid, description="nothing")
    assert (await c.get(f"/tickets/{t['id']}/docs")).json() == []
    await c.patch(f"/tickets/{t['id']}", json={"description": "now [[Spec]]"})
    assert [d["origin"] for d in (await c.get(f"/tickets/{t['id']}/docs")).json()] == [
        "description"
    ]
    bl = (await c.get(f"/docs/pages/{spec['id']}/backlinks")).json()
    assert [(x["ticket_id"], x["origin"]) for x in bl["tickets"]] == [
        (t["id"], "description")
    ]
    assert bl["tickets"][0]["context"] == "now Spec"
    await c.patch(f"/tickets/{t['id']}", json={"description": "gone"})
    assert (await c.get(f"/tickets/{t['id']}/docs")).json() == []
    assert (await c.get(f"/docs/pages/{spec['id']}/backlinks")).json()["tickets"] == []


async def test_manual_link_errors(c, pid):
    page = await mk(c, pid, "P")
    t = await _ticket(c, pid)
    assert (
        await c.post("/tickets/NOPE-1/docs", json={"page_id": page["id"]})
    ).status_code == 404
    assert (
        await c.post(f"/tickets/{t['id']}/docs", json={"page_id": "nope"})
    ).status_code == 404
    other = (
        await c.post(
            "/projects", json={"name": "Other", "prefix": "OTH", "color": "#00f"}
        )
    ).json()
    foreign = await mk(c, other["id"], "Foreign")
    r = await c.post(f"/tickets/{t['id']}/docs", json={"page_id": foreign["id"]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_project"
    await c.delete(f"/docs/pages/{page['id']}")
    assert (
        await c.post(f"/tickets/{t['id']}/docs", json={"page_id": page["id"]})
    ).status_code == 410
    assert (await c.delete("/tickets/NOPE-1/docs/x")).status_code == 404


async def test_backlinks_rows_carry_origin_and_sentence_context(c, pid):
    target = await publish(c, await mk(c, pid, "Target"), "## A\nx")
    await publish(
        c,
        await mk(c, pid, "Source"),
        "## Plan\nFirst sentence here. We rely on [[Target#A]] for limits. Last one.",
    )
    manual = await _ticket(c, pid)
    await c.post(f"/tickets/{manual['id']}/docs", json={"page_id": target["id"]})
    bl = (await c.get(f"/docs/pages/{target['id']}/backlinks")).json()
    row = bl["pages"][0]
    assert row["origin"] == "page" and row["context"] == "We rely on Target for limits."
    assert row["title"] == "Source" and row["in"] == "plan" and "snippet" in row
    assert [(x["ticket_id"], x["origin"]) for x in bl["tickets"]] == [
        (manual["id"], "manual")
    ]


# --- recycle bin -------------------------------------------------------------


async def test_recycle_bin_parent_flags_and_empty_bin(c, pid):
    parent = await mk(c, pid, "Parent")
    child = await mk(c, pid, "Child", parent_id=parent["id"])
    solo = await mk(c, pid, "Solo")
    await c.delete(f"/docs/pages/{child['id']}")
    bin_ = (await c.get(f"/projects/{pid}/docs/recycle-bin")).json()
    assert (bin_[0]["parent_title"], bin_[0]["parent_deleted"]) == ("Parent", False)
    await c.delete(f"/docs/pages/{parent['id']}")
    await c.delete(f"/docs/pages/{solo['id']}")
    bin_ = {
        e["title"]: e for e in (await c.get(f"/projects/{pid}/docs/recycle-bin")).json()
    }
    assert (
        bin_["Child"]["parent_deleted"] is True
        and bin_["Child"]["parent_title"] == "Parent"
    )
    assert (
        bin_["Solo"]["parent_title"] is None and bin_["Solo"]["parent_deleted"] is False
    )
    assert bin_["Parent"]["page_count"] == 1
    live = await mk(c, pid, "Live")
    r = await c.delete(f"/projects/{pid}/docs/recycle-bin")
    assert r.status_code == 200 and r.json() == {"purged": 3}
    assert (await c.get(f"/projects/{pid}/docs/recycle-bin")).json() == []
    assert (await c.get(f"/docs/pages/{parent['id']}")).status_code == 404
    assert (
        await c.get(f"/docs/pages/{live['id']}")
    ).status_code == 200  # live pages are untouched
    assert (await c.delete(f"/projects/{pid}/docs/recycle-bin")).json() == {"purged": 0}


async def test_restoring_a_child_of_a_deleted_parent_returns_at_top_level(c, pid):
    parent = await mk(c, pid, "Parent")
    child = await mk(c, pid, "Child", parent_id=parent["id"])
    await c.delete(f"/docs/pages/{child['id']}")
    await c.delete(f"/docs/pages/{parent['id']}")
    r = await c.post(f"/docs/pages/{child['id']}/restore")
    assert r.json()["moved_to_top_level"] is True


# --- notifications and request ids ------------------------------------------


@pytest.fixture
def sse():
    q = board_events.subscribe()
    yield q
    board_events.unsubscribe(q)


def _drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


async def test_notification_event_only_when_notify_is_true(c, pid, sse):
    page = await mk(c, pid, "Notify me")
    await c.put(f"/docs/pages/{page['id']}/draft", json={"markdown": "a"})
    _drain(sse)
    await c.post(
        f"/docs/pages/{page['id']}/publish", json={"base_version": 0, "note": "silent"}
    )
    events = _drain(sse)
    assert events == ["invalidate"]  # no JSON event without notify

    await c.put(f"/docs/pages/{page['id']}/draft", json={"markdown": "b"})
    await c.post(
        f"/docs/pages/{page['id']}/publish",
        json={"base_version": 1, "note": "loud", "notify": True},
    )
    events = _drain(sse)
    assert events[0] == "invalidate"
    payload = json.loads(events[1])
    assert payload == {
        "type": "docs_published",
        "project_id": pid,
        "page_id": page["id"],
        "title": "Notify me",
        "version": 2,
        "author": "user",
        "note": "loud",
    }
    assert len(events) == 2

    # restoring a version only notifies when asked
    await c.post(f"/docs/pages/{page['id']}/versions/1/restore", json={})
    assert all(not e.startswith("{") for e in _drain(sse))
    await c.post(f"/docs/pages/{page['id']}/versions/1/restore", json={"notify": True})
    ev = [json.loads(e) for e in _drain(sse) if e.startswith("{")]
    assert (
        len(ev) == 1 and ev[0]["version"] == 4 and ev[0]["note"] == "Restored from v1"
    )


async def test_errors_carry_a_request_id_header_and_detail(c, pid):
    r = await c.get("/docs/pages/nope")
    assert r.status_code == 404
    rid = r.headers["x-request-id"]
    assert rid and r.json()["detail"] == {
        "code": "page_not_found",
        "message": "Page not found",
        "request_id": rid,
    }
    echoed = await c.get("/docs/pages/nope", headers={"x-request-id": "abc-123"})
    assert (
        echoed.headers["x-request-id"] == "abc-123"
        and echoed.json()["detail"]["request_id"] == "abc-123"
    )
    page = await mk(c, pid, "P")
    conflict = await c.post(
        f"/docs/pages/{page['id']}/publish", json={"base_version": 5}
    )
    assert conflict.status_code == 409
    d = conflict.json()["detail"]
    assert (
        d["code"] == "conflict" and d["request_id"] == conflict.headers["x-request-id"]
    )
    assert d["latest_version"] == 0  # extras survive
    ok = await c.get(f"/projects/{pid}/docs/tree")
    assert "x-request-id" not in ok.headers
