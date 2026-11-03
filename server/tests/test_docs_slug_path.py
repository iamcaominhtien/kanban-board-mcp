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


async def test_the_slug_path_walks_only_the_ancestors_and_matches_the_whole_tree(
    c, pid, monkeypatch
):
    """`slug_path` gives what the whole-space `_slug_paths` gives (unique paths only), without loading every page."""
    from models import DocsPage
    from services import docs
    from tests.test_docs import test_async_session

    a = await mk(c, pid, "Guides")
    a2 = await mk(
        c, pid, "Guides"
    )  # two "guides": everything under them is shared by id
    under = await mk(c, pid, "Setup", parent_id=a["id"])
    under2 = await mk(c, pid, "Setup", parent_id=a2["id"])
    ref = await mk(c, pid, "Reference")
    api = await mk(c, pid, "API", parent_id=ref["id"])
    leaf = await mk(c, pid, "Errors", parent_id=api["id"])
    gone = await mk(c, pid, "Old")
    orphan = await mk(c, pid, "Orphan", parent_id=gone["id"])
    loose = await mk(
        c, pid, "Orphan"
    )  # same path as the orphan once its parent is deleted
    for n in range(30):
        await mk(c, pid, f"Other {n}", parent_id=ref["id"])
    async with test_async_session() as s:
        # only the parent is deleted (an old row): its child reads as top level
        row = await s.get(DocsPage, gone["id"])
        row.deleted_at = "2000-01-01T00:00:00+00:00"
        s.add(row)
        await s.commit()

    async with test_async_session() as s:
        pages = await docs._all_pages(s, pid)
        whole = docs._slug_paths(pages)
        unique = {k: v for k, v in whole.items() if list(whole.values()).count(v) == 1}
        for p in pages:
            assert await docs.slug_path(s, p) == unique.get(p.id), p.title

    # a page view does not load the whole space for it
    async def no_whole_space(*_a, **_k):
        raise AssertionError("slug_path loaded every page")

    monkeypatch.setattr(docs, "_all_pages", no_whole_space)
    assert (await c.get(f"/docs/pages/{leaf['id']}")).json()[
        "slug_path"
    ] == "reference/api/errors"
    for pg in (under, under2, a, a2, orphan, loose):
        assert (await c.get(f"/docs/pages/{pg['id']}")).json()["slug_path"] is None
