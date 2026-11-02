"""AC-4: a Docs page has a slug path from its tree path (`architecture/api`) for a share link. It follows renames;
the path from before a rename keeps opening the page; `?docs=<uuid>` links are unchanged (the page id still works)."""

from tests.test_docs import c, mk, pid, setup_db  # noqa: F401  (fixtures)


async def test_a_page_has_a_slug_path_from_its_tree_path(c, pid):
    arch = await mk(c, pid, "Architecture")
    api = await mk(c, pid, "API", parent_id=arch["id"])
    d = (await c.get(f"/docs/pages/{api['id']}")).json()
    assert d["slug_path"] == "architecture/api"
    r = await c.get(
        f"/projects/{pid}/docs/by-path", params={"path": "architecture/api"}
    )
    assert r.status_code == 200 and r.json()["id"] == api["id"]
    # the page id keeps working, as before
    assert (await c.get(f"/docs/pages/{api['id']}")).status_code == 200


async def test_a_rename_changes_the_path_and_the_old_one_still_opens_the_page(c, pid):
    arch = await mk(c, pid, "Architecture")
    api = await mk(c, pid, "API", parent_id=arch["id"])
    await c.patch(f"/docs/pages/{arch['id']}", json={"title": "Design"})
    await c.patch(f"/docs/pages/{api['id']}", json={"title": "REST API"})
    d = (await c.get(f"/docs/pages/{api['id']}")).json()
    assert d["slug_path"] == "design/rest-api"
    assert d["slug"] == "api", "the slug it got when made stays (Markdown links use it)"
    for old in (
        "architecture/api",
        "design/api",
        "architecture/rest-api",
        "design/rest-api",
    ):
        r = await c.get(f"/projects/{pid}/docs/by-path", params={"path": old})
        assert r.status_code == 200 and r.json()["id"] == api["id"], old


async def test_a_moved_page_still_opens_by_its_old_path(c, pid):
    a = await mk(c, pid, "Guides")
    b = await mk(c, pid, "Reference")
    page = await mk(c, pid, "Setup", parent_id=a["id"])
    r = await c.post(f"/docs/pages/{page['id']}/move", json={"parent_id": b["id"]})
    assert r.status_code == 200, r.text
    r = await c.get(f"/projects/{pid}/docs/by-path", params={"path": "guides/setup"})
    assert r.status_code == 200 and r.json()["id"] == page["id"]


async def test_two_pages_with_the_same_path_share_by_id_and_unknown_paths_are_404(
    c, pid
):
    a = await mk(c, pid, "Notes")
    b = await mk(c, pid, "Notes")
    da = (await c.get(f"/docs/pages/{a['id']}")).json()
    db = (await c.get(f"/docs/pages/{b['id']}")).json()
    assert da["slug_path"] is None and db["slug_path"] is None
    # each still opens by the slug it was made with
    r = await c.get(f"/projects/{pid}/docs/by-path", params={"path": db["slug"]})
    assert r.status_code == 200 and r.json()["id"] == b["id"]
    r = await c.get(f"/projects/{pid}/docs/by-path", params={"path": "nothing/here"})
    assert r.status_code == 404
