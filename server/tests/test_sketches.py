import json
import struct
import zlib

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app
from services import sketches as svc
from tests.fast_db import fresh_tables

test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session():
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db(tmp_path, monkeypatch):
    # the drawings' files go to a throwaway uploads folder
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    await fresh_tables(test_engine)
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)


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


def png(width: int = 8, height: int = 6, extra: int = 0) -> bytes:
    """A real PNG of one colour; `extra` pads it with an ancillary chunk to reach a size."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + b"\xff\xff\xff\xff" * width for _ in range(height))
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    if extra:
        out += chunk(b"tEXt", b"k\x00" + b"x" * extra)
    out += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return out


def source(width: int = 8, height: int = 6, layers: int = 1, **kw) -> bytes:
    doc = {
        "format": "kanban-sketch",
        "version": 1,
        "width": width,
        "height": height,
        "background": "white",
        "layers": [
            {"id": f"l{i}", "name": f"Layer {i}", "visible": True, "opacity": 1}
            for i in range(layers)
        ],
        **kw,
    }
    return json.dumps(doc).encode()


def files(width=8, height=6, layers=1, **kw):
    return {
        "png": ("drawing.png", png(width, height), "image/png"),
        "source": (
            "drawing.sketch.json",
            source(width, height, layers),
            "application/json",
        ),
        **kw,
    }


async def make(c, pid=None, owner_kind="doc", owner_id="page-1", **kw):
    data = {"owner_kind": owner_kind, "owner_id": owner_id, "title": "Run card"}
    if pid:
        data["project_id"] = pid
    r = await c.post("/sketches", data=data, files=kw.pop("files", None) or files())
    assert r.status_code == 201, r.text
    return r.json()


async def test_create_read_and_files_are_in_the_uploads_folder(c, pid, tmp_path):
    s = await make(c, pid)
    assert s["id"].startswith("sk_") and len(s["id"]) == 11
    assert s["version"] == 1 and s["title"] == "Run card"
    assert (s["width"], s["height"], s["layer_count"]) == (8, 6, 1)
    assert s["owner_kind"] == "doc" and s["project_id"] == pid
    assert s["png_url"] == f"/uploads/sketches/{s['id']}.png"
    # stored like any attachment: inside the uploads folder, so a backup of the data folder carries them
    folder = tmp_path / "uploads" / "sketches"
    assert (folder / f"{s['id']}.png").read_bytes() == png()
    assert json.loads((folder / f"{s['id']}.sketch.json").read_text())["layers"]
    got = await c.get(f"/sketches/{s['id']}/png")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert got.content == png()
    src = await c.get(f"/sketches/{s['id']}/source")
    assert src.json()["format"] == "kanban-sketch"
    # the stored PNG is also served by the generic uploads route, so it works wherever an image does
    up = await c.get(s["png_url"])
    assert up.status_code == 200 and up.headers["content-type"] == "image/png"


async def test_png_answers_304_for_an_unchanged_version(c, pid):
    s = await make(c, pid)
    first = await c.get(f"/sketches/{s['id']}/png")
    again = await c.get(
        f"/sketches/{s['id']}/png", headers={"if-none-match": first.headers["etag"]}
    )
    assert again.status_code == 304


async def test_owner_decides_the_project(c, pid):
    t = await c.post(f"/projects/{pid}/tickets", json={"title": "Bug"})
    tid = t.json()["id"]
    s = await make(c, owner_kind="ticket", owner_id=tid)
    assert s["project_id"] == pid
    listed = (
        await c.get("/sketches", params={"owner_kind": "ticket", "owner_id": tid})
    ).json()
    assert [x["id"] for x in listed] == [s["id"]]
    assert (
        await c.get("/sketches", params={"owner_kind": "doc", "owner_id": tid})
    ).json() == []


async def test_bad_owner_and_missing_project(c):
    r = await c.post(
        "/sketches", data={"owner_kind": "pizza", "owner_id": "x"}, files=files()
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_owner"
    r = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "x", "project_id": "nope"},
        files=files(),
    )
    assert r.status_code == 404


async def test_update_bumps_version_and_replaces_the_files(c, pid, tmp_path):
    s = await make(c, pid)
    r = await c.put(
        f"/sketches/{s['id']}",
        data={"base_version": "1", "title": "Renamed"},
        files=files(16, 12, 2),
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["version"] == 2 and out["title"] == "Renamed"
    assert (out["width"], out["height"], out["layer_count"]) == (16, 12, 2)
    assert (await c.get(f"/sketches/{s['id']}/png")).content == png(16, 12)
    assert not list((tmp_path / "uploads" / "sketches").glob("*.tmp"))


async def test_conflict_when_someone_saved_in_the_meantime(c, pid):
    await c.post(
        f"/projects/{pid}/members",
        json={"name": "Mia", "color": "#123456", "role": "member"},
    )
    s = await make(c, pid)
    # Mia saves version 2 while the first person still holds version 1
    ok = await c.put(
        f"/sketches/{s['id']}",
        data={"base_version": "1"},
        files=files(10, 10),
        headers={"x-actor": "Mia"},
    )
    assert ok.status_code == 200
    r = await c.put(
        f"/sketches/{s['id']}", data={"base_version": "1"}, files=files(20, 20)
    )
    assert r.status_code == 409
    d = r.json()["detail"]
    assert d["code"] == "sketch_conflict"
    assert d["latest_version"] == 2 and d["latest_author"] == "Mia"
    # nothing of the rejected save was written
    assert (await c.get(f"/sketches/{s['id']}/png")).content == png(10, 10)
    # "Replace theirs"
    r = await c.put(
        f"/sketches/{s['id']}",
        data={"base_version": "1", "force": "true"},
        files=files(20, 20),
    )
    assert r.status_code == 200 and r.json()["version"] == 3
    assert (await c.get(f"/sketches/{s['id']}/png")).content == png(20, 20)


async def test_save_as_copy_leaves_the_first_alone(c, pid):
    s = await make(c, pid)
    # an unsaved state of the editor is saved as a copy
    r = await c.post(
        f"/sketches/{s['id']}/copy", data={"title": "Second"}, files=files(30, 20)
    )
    assert r.status_code == 201
    cp = r.json()
    assert cp["id"] != s["id"] and cp["version"] == 1 and cp["title"] == "Second"
    assert cp["owner_id"] == s["owner_id"] and cp["project_id"] == pid
    assert (await c.get(f"/sketches/{s['id']}/png")).content == png()
    assert (await c.get(f"/sketches/{cp['id']}/png")).content == png(30, 20)
    # without files it duplicates the saved one
    r = await c.post(f"/sketches/{s['id']}/copy")
    assert r.status_code == 201 and r.json()["title"] == "Run card copy"
    assert (await c.get(f"/sketches/{r.json()['id']}/png")).content == png()
    listed = (
        await c.get("/sketches", params={"owner_kind": "doc", "owner_id": "page-1"})
    ).json()
    assert len(listed) == 3


async def test_limits_are_enforced_on_the_server(c, pid):
    # canvas over 4096 px
    r = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
        files=files(4097, 10),
    )
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "sketch_too_large"
    assert r.json()["detail"]["limit_px"] == 4096
    # exactly 4096 is fine
    ok = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
        files=files(4096, 1),
    )
    assert ok.status_code == 201
    # a PNG over 10 MB
    big = {
        "png": ("d.png", png(extra=svc.MAX_BYTES), "image/png"),
        "source": ("d.json", source(), "application/json"),
    }
    r = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
        files=big,
    )
    assert r.status_code == 413 and r.json()["detail"]["part"] == "png"
    # a source over 10 MB
    big_source = source(pad="x" * svc.MAX_BYTES)
    r = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
        files={
            "png": ("d.png", png(), "image/png"),
            "source": ("d.json", big_source, "application/json"),
        },
    )
    assert r.status_code == 413 and r.json()["detail"]["part"] == "source"
    # more than 10 layers
    r = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
        files=files(layers=11),
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_many_layers"
    ok = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
        files=files(layers=10),
    )
    assert ok.status_code == 201 and ok.json()["layer_count"] == 10


async def test_malformed_files_are_refused(c, pid):
    data = {"owner_kind": "doc", "owner_id": "p", "project_id": pid}

    async def post(png_bytes, src):
        return await c.post(
            "/sketches",
            data=data,
            files={
                "png": ("d.png", png_bytes, "image/png"),
                "source": ("d.json", src, "application/json"),
            },
        )

    for r in (
        await post(b"not a png at all, just text padded to be long enough", source()),
        await post(png(), b"{nope"),
        await post(png(), b'{"format": "other", "layers": []}'),
        await post(png(), source(version=9)),
        # the size in the source must match the picture
        await post(png(8, 6), source(9, 6)),
    ):
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["code"] == "invalid_sketch"
    # a part that is missing
    r = await c.post(
        "/sketches", data=data, files={"png": ("d.png", png(), "image/png")}
    )
    assert r.status_code == 422


async def test_delete_unlinks_and_restore_brings_it_back(c, pid, tmp_path):
    s = await make(c, pid)
    assert (await c.delete(f"/sketches/{s['id']}")).status_code == 200
    assert (await c.get(f"/sketches/{s['id']}")).status_code == 404
    assert (await c.get(f"/sketches/{s['id']}/png")).status_code == 404
    assert (tmp_path / "uploads" / "sketches" / f"{s['id']}.png").exists()
    listed = (
        await c.get("/sketches", params={"owner_kind": "doc", "owner_id": "page-1"})
    ).json()
    assert listed == []
    back = await c.post(f"/sketches/{s['id']}/restore")
    assert back.status_code == 200 and back.json()["deleted_at"] is None
    assert (await c.get(f"/sketches/{s['id']}/png")).status_code == 200


async def test_viewers_can_look_but_not_edit(c, pid):
    await c.post(
        f"/projects/{pid}/members",
        json={"name": "Vi", "color": "#123456", "role": "viewer"},
    )
    s = await make(c, pid)
    h = {"x-actor": "Vi"}
    r = await c.get(f"/sketches/{s['id']}", headers=h)
    assert r.status_code == 200
    assert r.json()["role"] == "viewer" and r.json()["can_edit"] is False
    assert (await c.get(f"/sketches/{s['id']}/png", headers=h)).status_code == 200
    assert (await c.get(f"/sketches/{s['id']}/source", headers=h)).status_code == 200
    for r in (
        await c.post(
            "/sketches",
            data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
            files=files(),
            headers=h,
        ),
        await c.put(
            f"/sketches/{s['id']}",
            data={"base_version": "1"},
            files=files(),
            headers=h,
        ),
        await c.post(f"/sketches/{s['id']}/copy", headers=h),
        await c.delete(f"/sketches/{s['id']}", headers=h),
    ):
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "read_only"


async def test_members_can_add_and_edit(c, pid):
    await c.post(
        f"/projects/{pid}/members",
        json={"name": "Mia", "color": "#123456", "role": "member"},
    )
    h = {"x-actor": "Mia"}
    r = await c.post(
        "/sketches",
        data={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
        files=files(),
        headers=h,
    )
    assert r.status_code == 201 and r.json()["created_by"] == "Mia"
    assert r.json()["can_edit"] is True


async def test_a_free_idea_uses_the_best_role_anywhere(c, pid):
    # an idea that belongs to no project: the board's own user may draw, a stranger may not
    r = await c.post(
        "/sketches", data={"owner_kind": "idea", "owner_id": "IDEA-9"}, files=files()
    )
    assert r.status_code == 201 and r.json()["project_id"] is None
    r = await c.post(
        "/sketches",
        data={"owner_kind": "idea", "owner_id": "IDEA-9"},
        files=files(),
        headers={"x-actor": "Stranger"},
    )
    assert r.status_code == 403


def test_refs_in_finds_each_sketch_once():
    text = (
        "![A](sketch:sk_0123abcd) and [B](sketch:sk_0123abcd) ![C](sketch:sk_ffffffff)"
    )
    assert svc.refs_in(text) == ["sk_0123abcd", "sk_ffffffff"]
