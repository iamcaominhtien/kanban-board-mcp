import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app
from services import docs as svc

test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session():
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db():
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
async def c():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


@pytest.fixture
async def pid(c):
    r = await c.post(
        "/projects", json={"name": "Kanban", "prefix": "KAN", "color": "#0a0"}
    )
    return r.json()["id"]


async def mk(c, pid, title, **kw):
    r = await c.post(f"/projects/{pid}/docs/pages", json={"title": title, **kw})
    assert r.status_code == 201, r.text
    return r.json()


async def publish(c, page, markdown, note=None):
    await c.put(f"/docs/pages/{page['id']}/draft", json={"markdown": markdown})
    cur = (await c.get(f"/docs/pages/{page['id']}")).json()
    r = await c.post(
        f"/docs/pages/{page['id']}/publish",
        json={"base_version": cur["version"], "note": note},
    )
    assert r.status_code == 200, r.text
    return r.json()


# --- pure helpers ---------------------------------------------------------


def test_slugify_and_duplicate_anchors():
    assert svc.slugify("Example request!") == "example-request"
    md = "## Overview\n\n```\n## not a heading\n```\n\n## Overview\n\n### `Code` bit"
    assert [h["slug"] for h in svc.heading_anchors(md)] == [
        "overview",
        "overview-2",
        "code-bit",
    ]


def test_parse_references_skips_code_and_tracks_sections():
    md = (
        "## Intro\nSee [[Data model#Fields|the fields]] and KAN-12.\n"
        "`[[Ignored]] KAN-99`\n```\n[[Fenced]] KAN-98\n```\n## Next\n[[Auth]]"
    )
    refs = svc.parse_references(md)
    assert [
        (r["kind"], r.get("title") or r.get("key"), r["section"]) for r in refs
    ] == [
        ("page", "Data model", "intro"),
        ("ticket", "KAN-12", "intro"),
        ("page", "Auth", "next"),
    ]
    assert refs[0]["anchor"] == "Fields" and refs[0]["display"] == "the fields"


def test_diff_markdown_counts_and_word_level():
    d = svc.diff_markdown("## A\none two\nkeep", "## A\none three\nkeep\nnew")
    assert (d["added"], d["removed"]) == (2, 1)
    changed = [
        t
        for r in d["rows"]
        if r["type"] == "add" and r.get("words")
        for t in r["words"]
        if t["changed"]
    ]
    assert [t["text"] for t in changed] == ["three"]
    assert d["sections"][0]["heading"] == "A"


# --- tree ------------------------------------------------------------------


async def test_create_from_template_is_draft_with_unique_slug(c, pid):
    a = await mk(c, pid, "API", template="requirements")
    assert a["status"] == "draft" and a["version"] == 0 and a["markdown"] == ""
    assert "## Summary" in a["draft"]["markdown"]
    b = await mk(c, pid, "API")
    assert (a["slug"], b["slug"]) == ("api", "api-2")


async def test_title_required_and_bad_template(c, pid):
    assert (
        await c.post(f"/projects/{pid}/docs/pages", json={"title": "  "})
    ).status_code == 422
    r = await c.post(
        f"/projects/{pid}/docs/pages", json={"title": "x", "template": "nope"}
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_template"


async def test_tree_ordering_and_move_rules(c, pid):
    a, b, d = await mk(c, pid, "A"), await mk(c, pid, "B"), await mk(c, pid, "D")
    child = await mk(c, pid, "Child", parent_id=a["id"])
    r = await c.post(
        f"/docs/pages/{d['id']}/move", json={"parent_id": None, "before_id": a["id"]}
    )
    assert r.status_code == 200
    tree = (await c.get(f"/projects/{pid}/docs/tree")).json()
    top = [n["title"] for n in tree if n["parent_id"] is None]
    assert top == ["D", "A", "B"]
    # nest B under A after Child
    await c.post(
        f"/docs/pages/{b['id']}/move",
        json={"parent_id": a["id"], "after_id": child["id"]},
    )
    tree = (await c.get(f"/projects/{pid}/docs/tree")).json()
    assert [n["title"] for n in tree if n["parent_id"] == a["id"]] == ["Child", "B"]
    # cycle
    r = await c.post(f"/docs/pages/{a['id']}/move", json={"parent_id": child["id"]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "cycle"
    r = await c.post(f"/docs/pages/{a['id']}/move", json={"parent_id": a["id"]})
    assert r.status_code == 409


async def test_rename_keeps_slug(c, pid):
    a = await mk(c, pid, "Old name")
    r = await c.patch(f"/docs/pages/{a['id']}", json={"title": "New name"})
    assert r.json()["title"] == "New name" and r.json()["slug"] == "old-name"


async def test_duplicate_with_children(c, pid):
    a = await mk(c, pid, "A", markdown="## Hi")
    await mk(c, pid, "Kid", parent_id=a["id"])
    r = await c.post(
        f"/docs/pages/{a['id']}/duplicate", json={"include_children": True}
    )
    copy = r.json()
    assert copy["title"] == "A (copy)" and copy["status"] == "draft"
    tree = (await c.get(f"/projects/{pid}/docs/tree")).json()
    assert [n["title"] for n in tree if n["parent_id"] == copy["id"]] == ["Kid"]
    assert len(tree) == 4


# --- draft / publish / versions -------------------------------------------


async def test_draft_publish_version_flow(c, pid):
    p = await mk(c, pid, "API")
    p = await publish(c, p, "## One\nfirst", note="first cut")
    assert (p["version"], p["status"], p["has_unpublished_changes"]) == (
        1,
        "published",
        False,
    )
    assert p["draft"] is None and p["markdown"].startswith("## One")
    await c.put(f"/docs/pages/{p['id']}/draft", json={"markdown": "## One\nsecond"})
    cur = (await c.get(f"/docs/pages/{p['id']}")).json()
    assert cur["has_unpublished_changes"] and cur["markdown"].endswith("first")
    p = await publish(c, p, "## One\nsecond")
    assert p["version"] == 2
    versions = (await c.get(f"/docs/pages/{p['id']}/versions")).json()
    assert [v["version"] for v in versions] == [2, 1] and versions[1][
        "note"
    ] == "first cut"


async def test_publish_conflict_returns_409(c, pid):
    p = await publish(c, await mk(c, pid, "API"), "v1")
    await publish(c, p, "v2")
    r = await c.post(
        f"/docs/pages/{p['id']}/publish", json={"base_version": 1, "markdown": "mine"}
    )
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "conflict" and detail["latest_version"] == 2


async def test_publish_without_draft_is_422_and_discard(c, pid):
    p = await publish(c, await mk(c, pid, "API"), "v1")
    r = await c.post(f"/docs/pages/{p['id']}/publish", json={"base_version": 1})
    assert r.status_code == 422
    await c.put(f"/docs/pages/{p['id']}/draft", json={"markdown": "edit"})
    r = await c.delete(f"/docs/pages/{p['id']}/draft")
    assert r.json()["draft"] is None and r.json()["markdown"] == "v1"


async def test_restore_adds_new_version_and_diff(c, pid):
    p = await publish(c, await mk(c, pid, "API"), "## A\nold")
    await publish(c, p, "## A\nnew")
    r = await c.post(f"/docs/pages/{p['id']}/versions/1/restore", json={})
    body = r.json()
    assert body["version"] == 3 and body["markdown"] == "## A\nold"
    versions = (await c.get(f"/docs/pages/{p['id']}/versions")).json()
    assert versions[0]["note"] == "Restored from v1"
    d = (await c.get(f"/docs/pages/{p['id']}/versions/1/diff/2")).json()
    assert (d["added"], d["removed"]) == (1, 1)
    assert (await c.get(f"/docs/pages/{p['id']}/versions/9")).status_code == 404


# --- delete / recycle bin --------------------------------------------------


async def test_delete_restore_subtree_and_orphan_child(c, pid):
    a = await mk(c, pid, "A")
    kid = await mk(c, pid, "Kid", parent_id=a["id"])
    r = await c.delete(f"/docs/pages/{a['id']}")
    assert r.json()["deleted_pages"] == 2
    assert (await c.get(f"/projects/{pid}/docs/tree")).json() == []
    assert (await c.get(f"/docs/pages/{a['id']}")).status_code == 410
    bin_ = (await c.get(f"/projects/{pid}/docs/recycle-bin")).json()
    assert len(bin_) == 1 and bin_[0]["page_count"] == 2 and bin_[0]["title"] == "A"
    # restoring only the child while its parent stays deleted lands at top level
    r = await c.post(f"/docs/pages/{kid['id']}/restore")
    assert r.json()["moved_to_top_level"] is True
    tree = (await c.get(f"/projects/{pid}/docs/tree")).json()
    assert [(n["title"], n["parent_id"]) for n in tree] == [("Kid", None)]
    r = await c.post(f"/docs/pages/{a['id']}/restore")
    assert r.json()["restored_pages"] == 1


async def test_restore_whole_subtree(c, pid):
    a = await mk(c, pid, "A")
    await mk(c, pid, "Kid", parent_id=a["id"])
    await c.delete(f"/docs/pages/{a['id']}")
    r = await c.post(f"/docs/pages/{a['id']}/restore")
    assert r.json()["restored_pages"] == 2 and not r.json()["moved_to_top_level"]
    assert len((await c.get(f"/projects/{pid}/docs/tree")).json()) == 2


async def test_purge_only_from_bin(c, pid):
    a = await mk(c, pid, "A")
    assert (await c.delete(f"/docs/pages/{a['id']}/purge")).status_code == 409
    await c.delete(f"/docs/pages/{a['id']}")
    assert (await c.delete(f"/docs/pages/{a['id']}/purge")).status_code == 204
    assert (await c.get(f"/docs/pages/{a['id']}")).status_code == 404


async def test_purge_expired_after_30_days(c, pid):
    a = await mk(c, pid, "A")
    await c.delete(f"/docs/pages/{a['id']}")
    async with test_async_session() as s:
        from models import DocsPage

        page = await s.get(DocsPage, a["id"])
        page.deleted_at = "2000-01-01T00:00:00+00:00"
        s.add(page)
        await s.commit()
    assert (await c.get(f"/projects/{pid}/docs/recycle-bin")).json() == []
    assert (await c.get(f"/docs/pages/{a['id']}")).status_code == 404


# --- references ------------------------------------------------------------


async def test_references_backlinks_and_resolve(c, pid):
    t = await c.post(
        f"/projects/{pid}/tickets", json={"title": "Rate limiting", "type": "task"}
    )
    key = t.json()["id"]
    target = await publish(c, await mk(c, pid, "Data model"), "## Fields\nx")
    src = await publish(
        c,
        await mk(c, pid, "API"),
        f"## Overview\nSee [[Data model#Fields]], [[Data model#Nope]], [[Ghost]] and {key}.",
    )
    bl = (await c.get(f"/docs/pages/{target['id']}/backlinks")).json()
    assert [p["title"] for p in bl["pages"]] == ["API"] and bl["pages"][0][
        "in"
    ] == "overview"
    refs = [
        {"kind": "page", "title": "data model", "anchor": "Fields"},
        {"kind": "page", "title": "Data model", "anchor": "Nope"},
        {"kind": "page", "title": "Ghost"},
        {"kind": "ticket", "key": key},
        {"kind": "ticket", "key": "KAN-999"},
    ]
    res = (await c.post(f"/projects/{pid}/docs/resolve", json={"refs": refs})).json()
    assert [r["status"] for r in res] == [
        "ok",
        "section_missing",
        "missing",
        "ok",
        "missing",
    ]
    assert res[0]["page_id"] == target["id"] and res[3]["title"] == "Rate limiting"
    linked = (await c.get(f"/tickets/{key}/docs")).json()
    assert [d["page_id"] for d in linked] == [src["id"]]


async def test_resolve_in_bin_and_ambiguous_prefers_shallowest(c, pid):
    parent = await mk(c, pid, "Parent")
    await mk(c, pid, "Auth", parent_id=parent["id"])
    top = await mk(c, pid, "Auth")
    gone = await mk(c, pid, "Gone")
    await c.delete(f"/docs/pages/{gone['id']}")
    res = (
        await c.post(
            f"/projects/{pid}/docs/resolve",
            json={
                "refs": [
                    {"kind": "page", "title": "Auth"},
                    {"kind": "page", "title": "Gone"},
                    {"kind": "page", "title": "Parent/Auth"},
                ]
            },
        )
    ).json()
    assert res[0]["page_id"] == top["id"] and res[0]["status"] == "ok"
    assert res[1]["status"] == "in_bin"
    assert res[2]["path"] == "Parent/Auth"


async def test_ticket_description_backlink(c, pid):
    target = await publish(c, await mk(c, pid, "Spec"), "## A")
    await c.post(
        f"/projects/{pid}/tickets",
        json={"title": "T", "type": "task", "description": "see [[Spec]]"},
    )
    bl = (await c.get(f"/docs/pages/{target['id']}/backlinks")).json()
    assert [t["title"] for t in bl["tickets"]] == ["T"]


async def test_by_slug_and_templates(c, pid):
    a = await mk(c, pid, "Rate limits")
    r = await c.get(f"/projects/{pid}/docs/by-slug/rate-limits")
    assert r.json()["id"] == a["id"]
    assert (await c.get(f"/projects/{pid}/docs/by-slug/nope")).status_code == 404
    tpls = (await c.get("/docs/templates")).json()
    assert {t["id"] for t in tpls} == {
        "blank",
        "requirements",
        "meeting-notes",
        "decision-log",
        "technical-design",
    }


# --- MCP tools -------------------------------------------------------------


async def test_mcp_docs_tools_round_trip_and_conflict(c, pid, monkeypatch):
    import mcp_tools
    from database import async_session as real_session

    monkeypatch.setattr(mcp_tools, "async_session", test_async_session)
    created = await mcp_tools.create_docs_page(pid, "Runbook", "## Steps\n1. go")
    assert created["version"] == 1 and created["status"] == "published"
    page = await mcp_tools.get_docs_page(created["id"])
    assert (
        page["markdown"].startswith("## Steps")
        and page["headings"][0]["slug"] == "steps"
    )
    updated = await mcp_tools.update_docs_page(
        created["id"], "## Steps\n1. stop", page["version"], note="tweak"
    )
    assert updated["version"] == 2
    with pytest.raises(ValueError, match="get_docs_page"):
        await mcp_tools.update_docs_page(created["id"], "stale", 1)
    draft_only = await mcp_tools.update_docs_page(
        created["id"], "wip", 2, publish=False
    )
    assert draft_only["published"] is False and draft_only["version"] == 2
    tree = await mcp_tools.list_docs_pages(pid)
    assert [(t["title"], t["version"]) for t in tree] == [("Runbook", 2)]
    assert real_session is not None


async def test_forward_reference_resolves_when_target_is_published_later(c, pid):
    src = await publish(c, await mk(c, pid, "Overview"), "See [[API#Endpoints]].")
    target = await mk(c, pid, "API")
    assert (await c.get(f"/docs/pages/{target['id']}/backlinks")).json()["pages"] == []
    await publish(c, target, "## Endpoints\nx")
    bl = (await c.get(f"/docs/pages/{target['id']}/backlinks")).json()
    assert [p["page_id"] for p in bl["pages"]] == [src["id"]]
    # renaming the target away breaks the link; renaming back repairs it
    await c.patch(f"/docs/pages/{target['id']}", json={"title": "Reference"})
    assert (await c.get(f"/docs/pages/{target['id']}/backlinks")).json()["pages"] == []
    await c.patch(f"/docs/pages/{target['id']}", json={"title": "API"})
    assert (
        len((await c.get(f"/docs/pages/{target['id']}/backlinks")).json()["pages"]) == 1
    )
