import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app
from services import diagrams as svc

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


SOURCE = (
    '<mxfile><diagram name="Page-1"><mxGraphModel><root>'
    '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    '<mxCell id="2" value="Client" vertex="1" parent="1"/>'
    '<mxCell id="3" value="API &lt;b&gt;gateway&lt;/b&gt;" vertex="1" parent="1"/>'
    '<mxCell id="4" value="yes" edge="1" parent="1" source="2" target="3"/>'
    "</root></mxGraphModel></diagram></mxfile>"
)
EMPTY = (
    "<mxfile><diagram><mxGraphModel><root>"
    '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    "</root></mxGraphModel></diagram></mxfile>"
)
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'


def body(**kw):
    return {"label": "Auth flow", "source": SOURCE, "svg": SVG, **kw}


async def make(c, pid, **kw):
    r = await c.post(f"/projects/{pid}/diagrams", json=body(**kw))
    assert r.status_code == 201, r.text
    return r.json()


async def test_create_read_and_files(c, pid):
    d = await make(c, pid, summary="Gateway then service")
    assert d["id"].startswith("dg_") and len(d["id"]) == 11
    assert d["version"] == 1 and d["label"] == "Auth flow" and d["empty"] is False
    got = (await c.get(f"/diagrams/{d['id']}?source=true")).json()
    assert got["source"] == SOURCE
    assert "source" not in (await c.get(f"/diagrams/{d['id']}")).json()
    assert got["summary"] == "Gateway then service"
    assert got["suggested_summary"] == "Contains: Client, API gateway, yes."
    svg = await c.get(f"/diagrams/{d['id']}/svg")
    assert svg.headers["content-type"].startswith("image/svg+xml")
    assert "sandbox" in svg.headers["content-security-policy"]
    assert "<rect" in svg.text
    dl = await c.get(f"/diagrams/{d['id']}/download?format=drawio")
    assert dl.text == SOURCE
    assert 'filename="Auth-flow.drawio"' in dl.headers["content-disposition"]
    dl = await c.get(f"/diagrams/{d['id']}/download?format=svg")
    assert 'filename="Auth-flow.svg"' in dl.headers["content-disposition"]


async def test_empty_diagram_is_flagged(c, pid):
    d = await make(c, pid, source=EMPTY)
    assert d["empty"] is True


async def test_compressed_diagram_is_read(c, pid):
    import base64
    import urllib.parse
    import zlib

    inner = (
        '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
        '<mxCell id="2" value="Packed" vertex="1" parent="1"/></root></mxGraphModel>'
    )
    co = zlib.compressobj(wbits=-15)
    data = co.compress(urllib.parse.quote(inner).encode()) + co.flush()
    packed = f"<mxfile><diagram>{base64.b64encode(data).decode()}</diagram></mxfile>"
    d = await make(c, pid, source=packed)
    assert d["empty"] is False
    assert (await c.get(f"/diagrams/{d['id']}")).json()["suggested_summary"] == (
        "Contains: Packed."
    )


async def test_invalid_files_are_rejected(c, pid):
    for bad in ("not xml", "<html/>", '<!DOCTYPE x [<!ENTITY a "b">]><mxfile/>'):
        r = await c.post(f"/projects/{pid}/diagrams", json=body(source=bad))
        assert r.status_code == 422, bad
        assert r.json()["detail"]["code"] == "invalid_diagram"
    r = await c.post(f"/projects/{pid}/diagrams", json=body(svg="<div/>"))
    assert r.status_code == 422
    r = await c.post(f"/projects/{pid}/diagrams", json=body(item_kind="nope"))
    assert r.status_code == 422
    r = await c.post("/projects/missing/diagrams", json=body())
    assert r.status_code == 404


async def test_size_limit_has_a_clear_error(c, pid):
    big = SOURCE.replace("Client", "x" * (svc.MAX_BYTES + 10))
    r = await c.post(f"/projects/{pid}/diagrams", json=body(source=big))
    assert r.status_code == 413
    detail = r.json()["detail"]
    assert detail["code"] == "diagram_too_large"
    assert "The limit is 2 MB" in detail["message"]
    assert detail["limit_bytes"] == svc.MAX_BYTES


async def test_svg_is_sanitized(c, pid):
    dirty = (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()">'
        '<script>alert(1)</script><a xlink:href="javascript:alert(1)"><rect onclick="y()" width="1"/></a>'
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject></svg>'
    )
    d = await make(c, pid, svg=dirty)
    out = (await c.get(f"/diagrams/{d['id']}/svg")).text
    assert "script" not in out and "onload" not in out and "onclick" not in out
    assert "javascript" not in out
    assert "label" in out and "<rect" in out


async def test_update_creates_versions_and_detects_conflicts(c, pid):
    d = await make(c, pid)
    r = await c.put(
        f"/diagrams/{d['id']}",
        json={"base_version": 1, "source": EMPTY, "svg": SVG, "label": "Auth v2"},
    )
    assert r.status_code == 200 and r.json()["version"] == 2
    assert r.json()["label"] == "Auth v2"
    stale = await c.put(
        f"/diagrams/{d['id']}",
        json={"base_version": 1, "source": SOURCE, "svg": SVG},
    )
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["code"] == "diagram_conflict"
    assert detail["latest_version"] == 2 and detail["latest_author"] == "user"
    versions = (await c.get(f"/diagrams/{d['id']}/versions")).json()
    assert [v["version"] for v in versions] == [2, 1]
    old = (await c.get(f"/diagrams/{d['id']}?version=1&source=true")).json()
    assert old["source"] == SOURCE and old["shown_version"] == 1
    assert (await c.get(f"/diagrams/{d['id']}?version=9")).status_code == 404


async def test_delete_only_unlinks_and_can_be_restored(c, pid):
    d = await make(c, pid)
    assert (await c.delete(f"/diagrams/{d['id']}")).status_code == 200
    r = await c.get(f"/diagrams/{d['id']}")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "diagram_not_found"
    assert (await c.get(f"/projects/{pid}/diagrams")).json() == []
    bin_ = (await c.get(f"/projects/{pid}/diagrams?deleted=true")).json()
    assert [x["id"] for x in bin_] == [d["id"]]
    back = await c.post(f"/diagrams/{d['id']}/restore")
    assert back.status_code == 200 and back.json()["deleted_at"] is None
    assert (await c.get(f"/diagrams/{d['id']}")).status_code == 200


async def test_viewers_can_look_and_download_but_not_edit(c, pid):
    await c.post(
        f"/projects/{pid}/members",
        json={"name": "Vi", "color": "#123456", "role": "viewer"},
    )
    d = await make(c, pid)
    h = {"x-actor": "Vi"}
    r = await c.get(f"/diagrams/{d['id']}", headers=h)
    assert r.status_code == 200
    assert r.json()["role"] == "viewer" and r.json()["can_edit"] is False
    assert (await c.get(f"/diagrams/{d['id']}/download", headers=h)).status_code == 200
    assert (await c.get(f"/diagrams/{d['id']}/svg", headers=h)).status_code == 200
    for r in (
        await c.post(f"/projects/{pid}/diagrams", json=body(), headers=h),
        await c.put(
            f"/diagrams/{d['id']}",
            json={"base_version": 1, "source": SOURCE, "svg": SVG},
            headers=h,
        ),
        await c.delete(f"/diagrams/{d['id']}", headers=h),
    ):
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "read_only"


async def test_members_can_add_and_edit(c, pid):
    await c.post(
        f"/projects/{pid}/members",
        json={"name": "Mia", "color": "#123456", "role": "member"},
    )
    h = {"x-actor": "Mia"}
    r = await c.post(f"/projects/{pid}/diagrams", json=body(), headers=h)
    assert r.status_code == 201 and r.json()["created_by"] == "Mia"
    r = await c.put(
        f"/diagrams/{r.json()['id']}",
        json={"base_version": 1, "source": SOURCE, "svg": SVG},
        headers=h,
    )
    assert r.status_code == 200 and r.json()["updated_by"] == "Mia"


async def test_editor_setting_defaults_and_admin_only(c, pid):
    s = (await c.get("/diagrams/settings")).json()
    assert s["mode"] == "self-hosted"
    assert s["effective_url"] == "http://localhost:8080"
    assert s["sends_drawings_to_third_party"] is False
    r = await c.put(
        "/diagrams/settings", json={"mode": "self-hosted", "url": "https://draw.corp/"}
    )
    assert r.json()["effective_url"] == "https://draw.corp"
    r = await c.put("/diagrams/settings", json={"mode": "public"})
    assert r.json()["effective_url"] == "https://embed.diagrams.net"
    assert r.json()["sends_drawings_to_third_party"] is True
    assert (
        await c.put("/diagrams/settings", json={"mode": "other"})
    ).status_code == 422
    assert (
        await c.put(
            "/diagrams/settings", json={"mode": "self-hosted", "url": "javascript:x"}
        )
    ).status_code == 422
    await c.post(
        f"/projects/{pid}/members",
        json={"name": "Mia", "color": "#123456", "role": "member"},
    )
    r = await c.put(
        "/diagrams/settings", json={"mode": "public"}, headers={"x-actor": "Mia"}
    )
    assert r.status_code == 403 and r.json()["detail"]["code"] == "admin_only"


async def _publish(c, page_id, markdown, base):
    r = await c.post(
        f"/docs/pages/{page_id}/publish",
        json={"base_version": base, "markdown": markdown},
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_docs_versions_pin_diagrams_and_restore_brings_them_back(c, pid):
    page = (await c.post(f"/projects/{pid}/docs/pages", json={"title": "API"})).json()
    d = await make(c, pid)
    ref = f"[Auth flow](diagram:{d['id']})"
    await _publish(c, page["id"], f"# API\n\n{ref}\n", page["version"])
    v1 = (await c.get(f"/docs/pages/{page['id']}/versions/1")).json()
    assert v1["diagram_versions"] == {d["id"]: 1}

    await c.put(
        f"/diagrams/{d['id']}",
        json={"base_version": 1, "source": EMPTY, "svg": SVG, "label": "Auth v2"},
    )
    await _publish(c, page["id"], f"# API\n\nchanged\n\n{ref}\n", 1)
    v2 = (await c.get(f"/docs/pages/{page['id']}/versions/2")).json()
    assert v2["diagram_versions"] == {d["id"]: 2}
    # an older version still shows the diagram version it used
    assert (await c.get(f"/diagrams/{d['id']}?version=1&source=true")).json()[
        "source"
    ] == SOURCE

    # unlinking the diagram, then restoring page v1, links it again at version 1's content
    await c.delete(f"/diagrams/{d['id']}")
    r = await c.post(f"/docs/pages/{page['id']}/versions/1/restore", json={})
    assert r.status_code == 200, r.text
    now = (await c.get(f"/diagrams/{d['id']}?source=true")).json()
    assert now["source"] == SOURCE and now["version"] == 3
    v3 = (await c.get(f"/docs/pages/{page['id']}/versions/3")).json()
    assert v3["diagram_versions"] == {d["id"]: 3}


async def test_refs_in_finds_each_diagram_once():
    md = "[a](diagram:dg_0123abcd) ![b](diagram:dg_0123abcd) [c](diagram:dg_deadbeef) (diagram:zz)"
    assert svc.refs_in(md) == ["dg_0123abcd", "dg_deadbeef"]
