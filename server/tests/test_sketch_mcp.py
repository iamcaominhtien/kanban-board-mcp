"""Sketches through the Docs tools (docs_read sketches / sketch, docs_write sketch_create / sketch_save): an agent
works on a sketch as files, a stale base_version is refused, the limits are explained, and an AI run is checked by the
same guard and project scope as the diagram tools."""

import json
from dataclasses import replace

import pytest

from kanban_mcp import common
from kanban_mcp.tools.docs import docs_read, docs_write
from services.ai import guard
from tests.test_ai import _ctx, _project, _ticket, env  # noqa: F401  (fixture)
from tests.test_ai_safety import OWNER, _people
from tests.test_sketch_ai import png


@pytest.fixture(autouse=True)
def _mcp(monkeypatch, tmp_path, env):  # noqa: F811
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(common, "async_session", env["maker"])


def src(width=8, height=6, layers=2, **kw):
    doc = {
        "format": "kanban-sketch",
        "version": 1,
        "width": width,
        "height": height,
        "background": "white",
        "layers": [
            {
                "id": f"l{i}",
                "name": f"Layer {i}",
                "kind": "layer",
                "png": None,
                "texts": [],
            }
            for i in range(layers)
        ],
        **kw,
    }
    return json.dumps(doc)


def write(tmp_path, name, data):
    p = tmp_path / name
    p.write_bytes(data if isinstance(data, bytes) else data.encode())
    return str(p)


async def _setup(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Design the login page")
    return c, pid, tid


async def test_an_agent_creates_exports_edits_and_saves_a_sketch_as_files(
    env, tmp_path
):
    c, pid, tid = await _setup(env)
    p, s = write(tmp_path, "a.png", png()), write(tmp_path, "a.sketch.json", src())
    made = await docs_write(
        action="sketch_create",
        owner_kind="ticket",
        owner_id=tid,
        title="Login idea",
        path=p,
        source_path=s,
    )
    sid = made["id"]
    assert made["markdown"] == f"![Login idea](sketch:{sid})" and made["version"] == 1
    listed = await docs_read(action="sketches", project_id=pid)
    assert [(x["id"], x["owner_id"], x["layers"]) for x in listed] == [(sid, tid, 2)]

    # take it back to a folder, change the source like an agent would, save it
    got = await docs_read(
        action="sketch", sketch_id=sid, path=str(tmp_path / "work") + "/"
    )
    assert got["png_path"].endswith("Login-idea.png") and got["version"] == 1
    assert got["source_path"].endswith("Login-idea.sketch.json")
    doc = json.loads((tmp_path / "work" / "Login-idea.sketch.json").read_text())
    doc["layers"][1]["texts"].append(
        {"id": "t1", "x": 1, "y": 1, "text": "hi", "size": 20, "color": "#000000"}
    )
    (tmp_path / "work" / "Login-idea.sketch.json").write_text(json.dumps(doc))
    saved = await docs_write(
        action="sketch_save",
        sketch_id=sid,
        path=got["png_path"],
        source_path=got["source_path"],
        base_version=1,
    )
    assert saved["version"] == 2
    api = (await c.get(f"/sketches/{sid}")).json()
    assert api["version"] == 2 and api["updated_by"] == "agent"
    assert "hi" in (await c.get(f"/sketches/{sid}/source")).text

    # a .png path names the picture; the source lands next to it
    got = await docs_read(
        action="sketch", sketch_id=sid, path=str(tmp_path / "out" / "mine.png")
    )
    assert got["png_path"].endswith("mine.png") and got["source_path"].endswith(
        "mine.sketch.json"
    )
    assert (tmp_path / "out" / "mine.sketch.json").exists()


async def test_a_stale_base_version_is_refused_with_a_way_forward(env, tmp_path):
    c, pid, tid = await _setup(env)
    p = write(tmp_path, "a.png", png())
    sid = (
        await docs_write(
            action="sketch_create", owner_kind="ticket", owner_id=tid, title="A", path=p
        )
    )["id"]
    await docs_write(action="sketch_save", sketch_id=sid, path=p, base_version=1)
    with pytest.raises(Exception, match="Export the sketch again"):
        await docs_write(action="sketch_save", sketch_id=sid, path=p, base_version=1)
    assert (await c.get(f"/sketches/{sid}")).json()["version"] == 2


async def test_a_picture_alone_becomes_one_picture_layer(env, tmp_path):
    c, pid, tid = await _setup(env)
    p = write(tmp_path, "a.png", png())
    sid = (
        await docs_write(
            action="sketch_create",
            owner_kind="ticket",
            owner_id=tid,
            title="Flat",
            path=p,
        )
    )["id"]
    doc = (await c.get(f"/sketches/{sid}/source")).json()
    assert [layer["kind"] for layer in doc["layers"]] == ["paper", "picture"]
    assert doc["layers"][1]["png"].startswith("data:image/png;base64,iVBOR")
    assert (doc["width"], doc["height"]) == (8, 6)


async def test_a_sketch_can_belong_to_a_docs_page(env, tmp_path):
    c, pid, tid = await _setup(env)
    page = (
        await c.post(
            f"/projects/{pid}/docs/pages", json={"title": "Plan", "markdown": "x"}
        )
    ).json()["id"]
    p = write(tmp_path, "a.png", png())
    made = await docs_write(
        action="sketch_create", owner_kind="doc", owner_id=page, title="On page", path=p
    )
    assert (await c.get(f"/sketches/{made['id']}")).json()["project_id"] == pid


async def test_bad_calls_say_what_is_wrong_and_the_limits(env, tmp_path):
    c, pid, tid = await _setup(env)
    p = write(tmp_path, "a.png", png())
    base = {
        "action": "sketch_create",
        "owner_kind": "ticket",
        "owner_id": tid,
        "title": "x",
    }
    with pytest.raises(Exception, match="absolute path"):
        await docs_write(**base, path="rel/a.png")
    with pytest.raises(Exception, match="not a file"):
        await docs_write(**base, path=str(tmp_path / "missing.png"))
    with pytest.raises(Exception, match="not a PNG"):
        await docs_write(**base, path=write(tmp_path, "b.png", b"nope" * 20))
    with pytest.raises(Exception, match="No ticket"):
        await docs_write(**{**base, "owner_id": "KAN-999"}, path=p)
    with pytest.raises(Exception, match="size in the source does not match"):
        await docs_write(
            **base, path=p, source_path=write(tmp_path, "s.json", src(width=9))
        )
    with pytest.raises(Exception, match="1 to 10 layers"):
        await docs_write(
            **base, path=p, source_path=write(tmp_path, "s.json", src(layers=11))
        )
    with pytest.raises(Exception, match="wrong format"):
        await docs_write(
            **base,
            path=p,
            source_path=write(tmp_path, "s.json", json.dumps({"layers": []})),
        )
    with pytest.raises(Exception, match="4096"):
        await docs_write(**base, path=write(tmp_path, "w.png", png(5000, 2)))
    with pytest.raises(Exception, match="10 MB|too large"):
        big = write(tmp_path, "big.json", " " * (10 * 1024 * 1024 + 1))
        await docs_write(**base, path=p, source_path=big)
    with pytest.raises(Exception, match="requires"):
        await docs_write(action="sketch_save", sketch_id="sk_00000000")
    with pytest.raises(Exception, match="not found"):
        await docs_read(
            action="sketch", sketch_id="sk_00000000", path=str(tmp_path / "o") + "/"
        )
    assert await docs_read(action="sketches", project_id=pid) == []


async def test_an_ai_run_goes_through_the_guard_and_its_own_project(env, tmp_path):
    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]
    p = write(tmp_path, "a.png", png())
    args = {"owner_kind": "ticket", "owner_id": tid, "title": "By the AI", "path": p}
    # an ask run only reads and answers
    tokens = guard.enter(replace(ctx, mode="ask"))
    try:
        with pytest.raises(ValueError, match="Ask runs only read"):
            await docs_write(action="sketch_create", **args)
        assert (
            await docs_read(action="sketches", project_id=pid) == []
        )  # reading is fine
    finally:
        guard.leave(tokens)
    # a work run with the default rights ("edit docs" needs a person's approval) is parked, nothing is written
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
            await docs_write(action="sketch_create", **args)
    finally:
        guard.leave(tokens)
    assert (
        await c.get("/sketches", params={"owner_kind": "ticket", "owner_id": tid})
    ).json() == []
    approvals = (await c.get(f"/projects/{pid}/ai/approvals")).json()
    assert any(a["action"] == "edit_docs" for a in approvals)
    # blocked stays blocked (only the owner changes rights)
    await _people(c, pid)
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"permissions": {"edit_docs": "blocked"}},
        headers=OWNER,
    )
    assert r.status_code == 200, r.text
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="BLOCKED"):
            await docs_write(action="sketch_create", **args)
    finally:
        guard.leave(tokens)
    # allowed: the AI writes, as the AI member, in its own project
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"template": "custom", "permissions": {"edit_docs": "allowed"}},
        headers=OWNER,
    )
    assert r.status_code == 200, r.text
    tokens = guard.enter(ctx)
    try:
        made = await docs_write(action="sketch_create", **args)
    finally:
        guard.leave(tokens)
    api = (await c.get(f"/sketches/{made['id']}")).json()
    assert api["created_by"] == m["name"] and api["project_id"] == pid
    # another project's sketch is out of reach for the run
    pid2 = (
        await c.post(
            "/projects", json={"name": "Other", "prefix": "OTH", "color": "#123456"}
        )
    ).json()["id"]
    other = await _ticket(c, pid2, "Elsewhere")
    sid = (
        await docs_write(
            action="sketch_create",
            owner_kind="ticket",
            owner_id=other,
            title="Theirs",
            path=p,
        )
    )["id"]
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="another project"):
            await docs_write(
                action="sketch_save", sketch_id=sid, path=p, base_version=1
            )
        with pytest.raises(ValueError, match="another project"):
            await docs_read(
                action="sketch", sketch_id=sid, path=str(tmp_path / "x") + "/"
            )
        with pytest.raises(ValueError, match="another project"):
            await docs_write(action="sketch_create", **{**args, "owner_id": other})
    finally:
        guard.leave(tokens)
    assert (await c.get(f"/sketches/{sid}")).json()["version"] == 1
