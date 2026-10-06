# ruff: noqa: F811  (pytest fixtures imported from test_docs are redefined as arguments)
import pytest

import mcp_tools
from tests.test_docs import c, mk, pid, publish, setup_db, test_async_session  # noqa: F401,F811


@pytest.fixture(autouse=True)
def _mcp_db(monkeypatch):
    monkeypatch.setattr(mcp_tools, "async_session", test_async_session)


async def test_full_crud_round_trip(c, pid):
    page = await mcp_tools.create_docs_page(pid, "Runbook", "## Steps\n1. go")
    full = await mcp_tools.get_docs_page(page["id"])
    renamed = await mcp_tools.update_docs_page(
        page["id"], "## Steps\n1. stop", full["version"], title="Runbook v2"
    )
    assert renamed["title"] == "Runbook v2" and renamed["version"] == 2

    child = await mcp_tools.create_docs_page(pid, "Child", "x")
    moved = await mcp_tools.move_docs_page(child["id"], parent_id=page["id"])
    assert moved["parent_id"] == page["id"]
    with pytest.raises(ValueError, match="itself"):
        await mcp_tools.move_docs_page(page["id"], parent_id=child["id"])

    dup = await mcp_tools.duplicate_docs_page(page["id"], include_children=True)
    assert dup["status"] == "draft"
    tree = await mcp_tools.list_docs_pages(pid)
    assert len(tree) == 4

    deleted = await mcp_tools.delete_docs_page(dup["id"])
    assert deleted["deleted_pages"] == 2
    bin_ = await mcp_tools.list_docs_recycle_bin(pid)
    assert [e["title"] for e in bin_] == [dup["title"]]
    restored = await mcp_tools.restore_docs_page(dup["id"])
    assert restored["restored_pages"] == 2
    assert await mcp_tools.list_docs_recycle_bin(pid) == []


async def test_versions_diff_restore_and_stale_base(c, pid):
    page = await mcp_tools.create_docs_page(pid, "Spec", "## A\nold")
    await mcp_tools.update_docs_page(page["id"], "## A\nnew", 1, note="edit")
    versions = await mcp_tools.list_docs_versions(page["id"])
    assert [v["version"] for v in versions] == [2, 1]
    assert (await mcp_tools.get_docs_version(page["id"], 1))["markdown"] == "## A\nold"
    diff = await mcp_tools.get_docs_version(page["id"], 1, compare_to=2)
    assert (diff["added"], diff["removed"]) == (1, 1)
    with pytest.raises(ValueError, match="get_docs_page"):
        await mcp_tools.update_docs_page(page["id"], "x", 1)
    back = await mcp_tools.restore_docs_version(page["id"], 1)
    assert back["version"] == 3


async def test_search_resolve_import_and_ticket_links(c, pid, tmp_path):
    t = await c.post(f"/projects/{pid}/tickets", json={"title": "Rate", "type": "task"})
    key = t.json()["id"]
    page = await mcp_tools.create_docs_page(
        pid, "Limits", f"## Policy\nPer-token buckets. {key}"
    )
    found = await mcp_tools.search_docs(pid, "buckets")
    assert [p["title"] for p in found["pages"]] == ["Limits"]
    res = await mcp_tools.resolve_docs_links(
        pid, ["[[Limits#Policy]]", "[[Ghost]]", key]
    )
    assert [r["status"] for r in res] == ["ok", "missing", "ok"]
    with pytest.raises(ValueError):
        await mcp_tools.resolve_docs_links(pid, ["plain words"])

    (tmp_path / "guide").mkdir()
    (tmp_path / "guide" / "intro.md").write_text("# Intro\nSee [[Limits]].")
    (tmp_path / "notes.md").write_text("---\ntitle: Notes\n---\nhello")
    (tmp_path / "skip.txt").write_text("no")
    out = await mcp_tools.import_docs(pid, str(tmp_path))
    assert (
        len(out["created"]) == 3 and not out["failed"]
    )  # guide folder + intro + notes
    (tmp_path / "empty").mkdir()
    with pytest.raises(ValueError, match="No .md"):
        await mcp_tools.import_docs(pid, str(tmp_path / "empty"))

    linked = await mcp_tools.link_ticket_doc(key, page["id"])
    assert linked
    docs = (await c.get(f"/tickets/{key}/docs")).json()
    assert any(d["origin"] == "manual" for d in docs)
    await mcp_tools.unlink_ticket_doc(key, page["id"])
    docs = (await c.get(f"/tickets/{key}/docs")).json()
    assert not any(d["origin"] == "manual" for d in docs)
