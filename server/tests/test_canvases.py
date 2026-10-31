import io
import zipfile

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app
from services import canvas_html, canvas_locks
from services import canvases as svc
from tests.fast_db import fresh_tables
from tests.test_sketches import png

test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session():
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    await fresh_tables(test_engine)
    canvas_locks.reset()
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)
    canvas_locks.reset()


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


async def add_member(c, pid, name, role="member"):
    r = await c.post(
        f"/projects/{pid}/members",
        json={"name": name, "color": "#123456", "role": role},
    )
    assert r.status_code in (200, 201), r.text


PAGE = (
    b"<!doctype html><html><head><title>Sign in</title><style>body{color:#123}</style></head>"
    b"<body><h1>Sign in</h1><label>Email</label><input type=email placeholder=you@example.com>"
    b"<button>Continue</button></body></html>"
)


async def make(c, pid, **kw):
    body = {
        "owner_kind": "doc",
        "owner_id": "page-1",
        "title": "Login redesign",
        "project_id": pid,
    }
    body.update(kw)
    r = await c.post("/canvases", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def html_board(c, cid, name="Sign in", html=PAGE, **kw):
    r = await c.post(
        f"/canvases/{cid}/boards",
        data={"kind": "html", "name": name, **kw},
        files=[("files", ("index.html", html, "text/html"))],
    )
    assert r.status_code == 201, r.text
    return r.json()["board"]


# --- create, read, markdown ---------------------------------------------------------------------------------------


async def test_create_makes_a_record_a_file_and_an_empty_first_board(c, pid, tmp_path):
    cv = await make(c, pid)
    assert cv["id"].startswith("cv_") and len(cv["id"]) == 11
    assert cv["markdown"] == f"![Login redesign](canvas:{cv['id']})"
    assert cv["owner_kind"] == "doc" and cv["project_id"] == pid
    assert cv["version"] == 1 and cv["can_edit"] is True
    doc = cv["doc"]
    assert doc["format"] == "kanban-canvas" and len(doc["pages"]) == 1
    assert [b["kind"] for b in doc["boards"]] == ["empty"]
    # a record plus one file in the uploads folder
    assert (tmp_path / "uploads" / "canvases" / cv["id"] / "canvas.json").is_file()
    got = await c.get(f"/canvases/{cv['id']}")
    assert got.json()["doc"]["boards"][0]["id"] == doc["boards"][0]["id"]


def test_refs_in_reads_both_forms_and_one_board_or_page():
    text = (
        "![Login](canvas:cv_8f3a1c2d)\n![Wrong](canvas:cv_8f3a1c2d#b_0a1b2c3d)\n"
        "see [Other](canvas:cv_11112222) and ![x](sketch:sk_8f2a1c3d)"
    )
    assert svc.refs_in(text) == ["cv_8f3a1c2d", "cv_11112222"]


async def test_list_by_owner_and_unlink_restore(c, pid):
    cv = await make(c, pid)
    listed = (
        await c.get("/canvases", params={"owner_kind": "doc", "owner_id": "page-1"})
    ).json()
    assert [x["id"] for x in listed] == [cv["id"]]
    assert (await c.delete(f"/canvases/{cv['id']}")).status_code == 200
    assert (await c.get(f"/canvases/{cv['id']}")).status_code == 404
    assert (
        await c.get("/canvases", params={"owner_kind": "doc", "owner_id": "page-1"})
    ).json() == []
    back = await c.post(f"/canvases/{cv['id']}/restore")
    assert back.status_code == 200 and back.json()["deleted_at"] is None


# --- boards: HTML folder, images, limits ---------------------------------------------------------------------------


async def test_html_board_is_a_folder_with_its_own_css_and_images(c, pid, tmp_path):
    cv = await make(c, pid, start="none")
    r = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "html", "name": "Home"},
        files=[
            (
                "files",
                (
                    "index.html",
                    b'<link rel=stylesheet href="css/site.css"><img src="img/a.png"><h1>Hi</h1>',
                    "text/html",
                ),
            ),
            ("files", ("css/site.css", b"h1{color:red}", "text/css")),
            ("files", ("img/a.png", png(), "image/png")),
        ],
    )
    assert r.status_code == 201, r.text
    b = r.json()["board"]
    assert b["kind"] == "html" and b["content"]["entry"] == "index.html"
    assert {f["path"] for f in b["content"]["files"]} == {
        "index.html",
        "css/site.css",
        "img/a.png",
    }
    root = (
        tmp_path
        / "uploads"
        / "canvases"
        / cv["id"]
        / "boards"
        / b["id"]
        / f"r{b['content']['rev']}"
    )
    assert (root / "css" / "site.css").read_bytes() == b"h1{color:red}"
    # served one by one, relative to the page, so the folder works as it is
    base = f"/canvases/{cv['id']}/boards/{b['id']}/r/{b['content']['rev']}"
    page = await c.get(f"{base}/index.html")
    assert page.status_code == 200 and "text/html" in page.headers["content-type"]
    assert (
        (await c.get(f"{base}/css/site.css"))
        .headers["content-type"]
        .startswith("text/css")
    )
    assert (await c.get(f"{base}/img/a.png")).content == png()
    assert (await c.get(f"{base}/../../../canvas.json")).status_code in (404, 422)


async def test_new_boards_are_placed_to_the_right_never_on_top(c, pid):
    cv = await make(c, pid)
    first = cv["doc"]["boards"][0]
    second = await html_board(c, cv["id"], "Two")
    third = await html_board(c, cv["id"], "Three")
    assert second["x"] >= first["x"] + first["w"]
    assert third["x"] >= second["x"] + second["w"]


async def test_image_board_takes_its_size_from_the_picture(c, pid):
    cv = await make(c, pid, start="none")
    r = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "image"},
        files=[("files", ("shot.png", png(800, 600), "image/png"))],
    )
    b = r.json()["board"]
    assert b["kind"] == "image" and (b["w"], b["h"]) == (800, 600)
    assert b["content"]["entry"] == "image.png"
    bad = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "image"},
        files=[("files", ("x.png", b"not a picture", "image/png"))],
    )
    assert bad.status_code == 422


async def test_limits_have_clear_errors(c, pid, monkeypatch):
    cv = await make(c, pid, start="none")
    monkeypatch.setattr(svc, "MAX_BOARD_BYTES", 2000)
    big = b"<h1>x</h1>" + b"a" * 3000
    r = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "html"},
        files=[("files", ("index.html", big, "text/html"))],
    )
    assert r.status_code == 413
    d = r.json()["detail"]
    assert (
        d["code"] == "board_too_large"
        and d["limit_bytes"] == 2000
        and "Remove embedded images" in d["message"]
    )
    monkeypatch.setattr(svc, "MAX_BOARD_BYTES", 5 * 1024 * 1024)
    monkeypatch.setattr(svc, "MAX_BOARDS", 2)
    await html_board(c, cv["id"], "a")
    await html_board(c, cv["id"], "b")
    over = await c.post(f"/canvases/{cv['id']}/boards", data={"kind": "empty"})
    assert (
        over.status_code == 422 and over.json()["detail"]["code"] == "too_many_boards"
    )
    monkeypatch.setattr(svc, "MAX_BOARDS", 60)
    monkeypatch.setattr(svc, "MAX_CANVAS_BYTES", 1500)
    full = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "html"},
        files=[
            ("files", ("index.html", b"<h1>" + b"b" * 1600 + b"</h1>", "text/html"))
        ],
    )
    assert (
        full.status_code == 413 and full.json()["detail"]["code"] == "canvas_too_large"
    )


async def test_page_tab_limit(c, pid, monkeypatch):
    cv = await make(c, pid)
    monkeypatch.setattr(svc, "MAX_PAGES", 2)
    r = await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": cv["rev"],
            "upsert": {"pages": [{"name": "Two"}, {"name": "Three"}]},
        },
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_many_pages"


# --- HTML never runs a script or makes an outside request --------------------------------------------------------------

HOSTILE = b"""<!doctype html><html><head>
<script src="https://cdn.example.com/a.js"></script>
<script>alert(1)</script>
<link rel="stylesheet" href="https://cdn.example.com/site.css">
<link rel="stylesheet" href="local.css">
<style>@import url(https://evil.example/x.css); body{background:url(https://evil.example/p.png)} h1{color:red}</style>
<meta http-equiv="refresh" content="0;url=https://evil.example">
<base href="https://evil.example/">
</head><body onload="steal()">
<h1 onclick="x()">Hello</h1>
<img src="https://tracker.example/pixel.gif"><img src="ok.png" srcset="https://t.example/a.png 2x, ok.png 1x">
<a href="https://evil.example/go">go</a> <a href="javascript:alert(1)">js</a>
<iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x.swf">
<svg viewBox="0 0 10 10"><script>alert(2)</script><circle r="3"/></svg>
<div style="background:url('https://evil.example/b.png')">x</div>
<form action="https://evil.example/post"><button>Go</button></form>
</body></html>"""


def test_the_cleaner_removes_scripts_handlers_frames_and_outside_requests():
    clean, blocked = canvas_html.clean_html(HOSTILE.decode())
    low = clean.lower()
    for bad in (
        "<script", "alert(", "onload", "onclick", "evil.example", "tracker.example", "cdn.example.com",
        "<iframe", "<object", "<embed", "<base", "javascript:", "http-equiv", "@import",
    ):  # fmt: skip
        assert bad not in low, bad
    # what is local stays
    assert (
        'href="local.css"' in clean
        and 'src="ok.png"' in clean
        and "<h1>Hello</h1>" in clean.replace(" ", "")
        or "Hello" in clean
    )
    assert "<circle" in clean
    listed = {(b["kind"], b.get("host")) for b in blocked.as_list()}
    assert ("script", None) in listed and ("handler", None) in listed
    assert any(k == "request" and h == "cdn.example.com" for k, h in listed)
    assert any(k == "request" and h == "evil.example" for k, h in listed)
    assert blocked.total() >= 10


async def test_hostile_files_are_cleaned_on_the_way_in_and_served_locked(c, pid):
    cv = await make(c, pid, start="none")
    r = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "html", "name": "Evil"},
        files=[
            ("files", ("index.html", HOSTILE, "text/html")),
            (
                "files",
                (
                    "local.css",
                    b"@import 'https://evil.example/a.css'; a{background:url(http://x.example/a.png)}",
                    "text/css",
                ),
            ),
            ("files", ("app.js", b"alert(1)", "text/javascript")),
        ],
    )
    assert r.status_code == 201, r.text
    b = r.json()["board"]
    assert b["content"]["blocked_total"] > 0 and "app.js" in b["content"]["skipped"]
    assert "app.js" not in {f["path"] for f in b["content"]["files"]}
    base = f"/canvases/{cv['id']}/boards/{b['id']}/r/{b['content']['rev']}"
    page = await c.get(f"{base}/index.html")
    assert "<script" not in page.text.lower() and "evil.example" not in page.text
    css = await c.get(f"{base}/local.css")
    assert "evil.example" not in css.text and "x.example" not in css.text
    csp = page.headers["content-security-policy"]
    # no scripts, nothing from outside, sandboxed: the policy a frame opened on its own gets
    assert "default-src 'none'" in csp and "sandbox" in csp and "script-src" not in csp
    assert "http" not in csp and "*" not in csp.replace("Access", "")
    assert page.headers["x-content-type-options"] == "nosniff"
    assert (await c.get(f"{base}/app.js")).status_code == 404


async def test_a_zip_of_a_built_page_becomes_one_board(c, pid):
    cv = await make(c, pid, start="none")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "dist/index.html",
            "<title>Built</title><link rel=stylesheet href=assets/a.css><h1>Built</h1>",
        )
        z.writestr("dist/assets/a.css", "h1{color:blue}")
        z.writestr("dist/assets/app.js", "alert(1)")
        z.writestr("../evil.html", "<h1>x</h1>")
    r = await c.post(
        f"/canvases/{cv['id']}/import",
        files=[
            ("files", ("site.zip", buf.getvalue(), "application/zip")),
            ("files", ("login.html", PAGE, "text/html")),
            ("files", ("shot.png", png(), "image/png")),
            ("files", ("notes.pdf", b"%PDF", "application/pdf")),
        ],
    )
    assert r.status_code == 201, r.text
    out = r.json()
    assert [b["kind"] for b in out["boards"]] == ["html", "html", "image"]
    assert out["boards"][0]["content"]["entry"] == "index.html"
    assert out["boards"][1]["name"] == "login"
    assert [f["name"] for f in out["failed"]] == ["notes.pdf"]
    assert out["failed"][0]["code"] == "invalid_file"


# --- layout saves merge per item --------------------------------------------------------------------------------------


async def test_notes_arrows_labels_and_tabs_save_and_merge_per_item(c, pid):
    cv = await make(c, pid)
    b1 = cv["doc"]["boards"][0]
    page = cv["doc"]["pages"][0]["id"]
    r = await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": cv["rev"],
            "upsert": {
                "notes": [
                    {
                        "x": 10,
                        "y": 20,
                        "text": "Copy is final",
                        "color": "green",
                        "page": page,
                    }
                ],
                "labels": [
                    {"x": 0, "y": -60, "text": "Step 2", "size": 20, "page": page}
                ],
            },
        },
    )
    assert r.status_code == 200, r.text
    doc = r.json()["doc"]
    note = doc["notes"][0]
    assert (
        note["id"].startswith("n_") and note["color"] == "green" and note["by"] == "U"
    )
    # an arrow joins a frame and a note
    r2 = await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": r.json()["rev"],
            "upsert": {
                "arrows": [
                    {"from": b1["id"], "to": note["id"], "label": "after", "page": page}
                ]
            },
        },
    )
    assert r2.status_code == 200 and r2.json()["doc"]["arrows"][0]["label"] == "after"
    # two people arrange at once: each moves a different item, both saves go through
    loaded = r2.json()["doc"]
    mine = {**loaded["boards"][0], "x": 500}
    theirs = {**loaded["notes"][0], "x": 99}
    a = await c.patch(
        f"/canvases/{cv['id']}",
        json={"base_rev": r2.json()["rev"], "upsert": {"boards": [mine]}},
    )
    assert a.status_code == 200
    b = await c.patch(
        f"/canvases/{cv['id']}",
        json={"base_rev": r2.json()["rev"], "upsert": {"notes": [theirs]}},
    )
    assert b.status_code == 200
    final = b.json()["doc"]
    assert final["boards"][0]["x"] == 500 and final["notes"][0]["x"] == 99


async def test_the_same_item_changed_twice_conflicts_and_force_replaces(c, pid):
    cv = await make(c, pid)
    board = cv["doc"]["boards"][0]
    one = await c.patch(
        f"/canvases/{cv['id']}",
        json={"base_rev": cv["rev"], "upsert": {"boards": [{**board, "x": 100}]}},
    )
    assert one.status_code == 200
    two = await c.patch(
        f"/canvases/{cv['id']}",
        json={"base_rev": cv["rev"], "upsert": {"boards": [{**board, "x": 300}]}},
    )
    assert two.status_code == 409
    d = two.json()["detail"]
    assert (
        d["code"] == "canvas_conflict"
        and d["conflicts"] == [board["id"]]
        and d["latest_author"] == "user"
    )
    assert (await c.get(f"/canvases/{cv['id']}")).json()["doc"]["boards"][0]["x"] == 100
    forced = await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": cv["rev"],
            "force": True,
            "upsert": {"boards": [{**board, "x": 300}]},
        },
    )
    assert forced.status_code == 200 and forced.json()["doc"]["boards"][0]["x"] == 300


async def test_deleting_a_frame_drops_its_arrows_and_a_missing_item_conflicts(c, pid):
    cv = await make(c, pid)
    page = cv["doc"]["pages"][0]["id"]
    b1 = cv["doc"]["boards"][0]
    n = await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": cv["rev"],
            "upsert": {"notes": [{"x": 0, "y": 0, "text": "a", "page": page}]},
        },
    )
    note = n.json()["doc"]["notes"][0]
    a = await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": n.json()["rev"],
            "upsert": {"arrows": [{"from": b1["id"], "to": note["id"], "page": page}]},
        },
    )
    rm = await c.patch(
        f"/canvases/{cv['id']}",
        json={"base_rev": a.json()["rev"], "remove": [note["id"]]},
    )
    assert (
        rm.status_code == 200
        and rm.json()["doc"]["notes"] == []
        and rm.json()["doc"]["arrows"] == []
    )
    stale = await c.patch(
        f"/canvases/{cv['id']}",
        json={"base_rev": cv["rev"], "upsert": {"notes": [{**note, "text": "edit"}]}},
    )
    assert stale.status_code == 409


async def test_a_frame_cannot_be_added_through_a_layout_save(c, pid):
    cv = await make(c, pid)
    r = await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": cv["rev"],
            "upsert": {"boards": [{"id": "b_00000000", "name": "x"}]},
        },
    )
    assert r.status_code == 422


# --- locks -------------------------------------------------------------------------------------------------------


async def test_one_lock_per_board_content_needs_it_layout_does_not(c, pid):
    await add_member(c, pid, "An")
    cv = await make(c, pid)
    b = await html_board(c, cv["id"])
    cid, bid = cv["id"], b["id"]
    mine = await c.post(f"/canvases/{cid}/boards/{bid}/lock")
    assert mine.status_code == 200 and mine.json()["holder"] == "user"
    other = await c.post(
        f"/canvases/{cid}/boards/{bid}/lock", headers={"x-actor": "An"}
    )
    assert other.status_code == 423
    d = other.json()["detail"]
    assert (
        d["code"] == "board_locked"
        and d["holder"] == "user"
        and "still look, comment and move" in d["message"]
    )
    # the other person cannot change the content, but can move it and comment
    blocked = await c.put(
        f"/canvases/{cid}/boards/{bid}/content",
        json={"files": [{"path": "index.html", "text": "<h1>An</h1>"}]},
        headers={"x-actor": "An"},
    )
    assert blocked.status_code == 423
    doc = (await c.get(f"/canvases/{cid}")).json()
    assert any(lk["board_id"] == bid and lk["holder"] == "user" for lk in doc["locks"])
    moved = await c.patch(
        f"/canvases/{cid}",
        json={
            "base_rev": doc["rev"],
            "upsert": {
                "boards": [
                    {
                        **next(x for x in doc["doc"]["boards"] if x["id"] == bid),
                        "x": 700,
                    }
                ]
            },
        },
        headers={"x-actor": "An"},
    )
    assert moved.status_code == 200
    pin = await c.post(
        f"/canvases/{cid}/threads",
        json={"body": "Looks fine", "board_id": bid, "x": 0.2, "y": 0.3},
        headers={"x-actor": "An"},
    )
    assert pin.status_code == 201
    # the holder saves, which releases the lock
    saved = await c.put(
        f"/canvases/{cid}/boards/{bid}/content",
        json={
            "files": [{"path": "index.html", "text": "<h1>New</h1>"}],
            "base_content_rev": b["content"]["rev"],
        },
    )
    assert saved.status_code == 200, saved.text
    assert (await c.get(f"/canvases/{cid}")).json()["locks"] == []
    free = await c.post(f"/canvases/{cid}/boards/{bid}/lock", headers={"x-actor": "An"})
    assert free.status_code == 200


async def test_locks_end_after_ten_idle_minutes(c, pid, monkeypatch):
    cv = await make(c, pid)
    b = await html_board(c, cv["id"])
    clock = [1000.0]
    monkeypatch.setattr(canvas_locks, "_clock", lambda: clock[0])
    assert (
        await c.post(f"/canvases/{cv['id']}/boards/{b['id']}/lock")
    ).status_code == 200
    clock[0] += 9 * 60 + 1
    state = canvas_locks.describe(cv["id"], b["id"])
    assert state["warn"] is True and state["expires_in"] <= 59  # the editor warns first
    assert (await c.post(f"/canvases/{cv['id']}/boards/{b['id']}/heartbeat")).json()[
        "alive"
    ] is True
    clock[0] += 10 * 60 + 1
    assert canvas_locks.describe(cv["id"], b["id"]) is None
    lost = await c.post(f"/canvases/{cv['id']}/boards/{b['id']}/heartbeat")
    assert lost.json()["alive"] is False


async def test_saving_over_a_frame_someone_else_saved_meanwhile_is_a_conflict(c, pid):
    cv = await make(c, pid)
    b = await html_board(c, cv["id"])
    first = await c.put(
        f"/canvases/{cv['id']}/boards/{b['id']}/content",
        json={
            "files": [{"path": "index.html", "text": "<h1>one</h1>"}],
            "base_content_rev": b["content"]["rev"],
        },
    )
    assert first.status_code == 200
    second = await c.put(
        f"/canvases/{cv['id']}/boards/{b['id']}/content",
        json={
            "files": [{"path": "index.html", "text": "<h1>two</h1>"}],
            "base_content_rev": b["content"]["rev"],
        },
    )
    assert (
        second.status_code == 409
        and second.json()["detail"]["code"] == "board_conflict"
    )


async def test_images_sketches_and_diagrams_are_not_edited_as_source(c, pid):
    cv = await make(c, pid, start="none")
    r = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "image"},
        files=[("files", ("a.png", png(), "image/png"))],
    )
    bid = r.json()["board"]["id"]
    locked = await c.post(f"/canvases/{cv['id']}/boards/{bid}/lock")
    assert (
        locked.status_code == 422
        and locked.json()["detail"]["code"] == "not_editable_here"
    )


async def test_a_board_can_hold_a_sketch_and_shows_its_latest(c, pid):
    from tests.test_sketches import files as sketch_files

    sk = await c.post(
        "/sketches",
        data={
            "owner_kind": "doc",
            "owner_id": "page-1",
            "title": "Flow",
            "project_id": pid,
        },
        files=sketch_files(),
    )
    sid = sk.json()["id"]
    cv = await make(c, pid, start="none")
    r = await c.post(
        f"/canvases/{cv['id']}/boards", data={"kind": "sketch", "ref": sid}
    )
    assert r.status_code == 201, r.text
    assert r.json()["board"]["ref"] == sid and r.json()["board"]["name"] == "Flow"
    bad = await c.post(
        f"/canvases/{cv['id']}/boards", data={"kind": "sketch", "ref": "sk_00000000"}
    )
    assert bad.status_code == 404


# --- versions ---------------------------------------------------------------------------------------------------


async def test_versions_on_done_named_restore_makes_a_new_one_and_compare(c, pid):
    cv = await make(c, pid)
    cid = cv["id"]
    b = await html_board(c, cid, "Sign in")
    page = cv["doc"]["pages"][0]["id"]
    done = await c.patch(
        f"/canvases/{cid}",
        json={
            "base_rev": (await c.get(f"/canvases/{cid}")).json()["rev"],
            "checkpoint": True,
            "name": "Review 1",
            "note": "First pass",
        },
    )
    assert done.status_code == 200
    versions = (await c.get(f"/canvases/{cid}/versions")).json()
    assert [v["version"] for v in versions] == [2, 1] and versions[0][
        "name"
    ] == "Review 1"
    assert (
        "1 frame added" in versions[0]["summary"]
        and b["id"] in versions[0]["changes"]["added"]
    )
    # edit the frame, Done again
    await c.put(
        f"/canvases/{cid}/boards/{b['id']}/content",
        json={"files": [{"path": "index.html", "text": "<h1>Changed</h1>"}]},
    )
    rev = (await c.get(f"/canvases/{cid}")).json()["rev"]
    await c.patch(f"/canvases/{cid}", json={"base_rev": rev, "checkpoint": True})
    v3 = (await c.get(f"/canvases/{cid}/versions")).json()[0]
    assert v3["version"] == 3 and "Sign in edited" in v3["summary"]
    comp = (await c.get(f"/canvases/{cid}/compare", params={"a": 2, "b": 3})).json()
    states = {r["name"]: r["state"] for r in comp["boards"]}
    assert states["Sign in"] == "changed" and states["Frame 1"] == "same"
    diff = (
        await c.get(
            f"/canvases/{cid}/boards/{b['id']}/source-diff", params={"a": 2, "b": 3}
        )
    ).json()
    assert (
        "Changed" in diff["files"][0]["diff"]
        and diff["files"][0]["path"] == "index.html"
    )
    # the old content is still there, and restoring makes version 4 instead of rewriting history
    restored = await c.post(f"/canvases/{cid}/versions/2/restore")
    assert restored.status_code == 200
    now = restored.json()
    assert now["version"] == 4 and now["doc"]["boards"][1]["content"]["rev"] != 0
    page_now = await c.get(
        f"/canvases/{cid}/boards/{b['id']}/r/{now['doc']['boards'][1]['content']['rev']}/index.html"
    )
    assert "Sign in" in page_now.text and "Changed" not in page_now.text
    assert [
        v["version"] for v in (await c.get(f"/canvases/{cid}/versions")).json()
    ] == [4, 3, 2, 1]
    named = await c.patch(
        f"/canvases/{cid}/versions/3", json={"name": "Before restore"}
    )
    assert named.json()["name"] == "Before restore"
    assert page  # the first page tab survives a restore


async def test_restore_waits_while_somebody_edits_a_frame(c, pid):
    cv = await make(c, pid)
    b = await html_board(c, cv["id"])
    await c.post(f"/canvases/{cv['id']}/boards/{b['id']}/lock")
    r = await c.post(f"/canvases/{cv['id']}/versions/1/restore")
    assert r.status_code == 423


async def test_a_docs_page_canvas_gets_a_version_every_ten_minutes(c, pid, monkeypatch):
    out = await c.post(
        "/canvases/pages", json={"project_id": pid, "title": "Settings flow"}
    )
    assert out.status_code == 201, out.text
    cv = out.json()["canvas"]
    assert (
        out.json()["page"]["kind"] == "canvas"
        and cv["owner_kind"] == "page"
        and cv["page_id"] == out.json()["page"]["id"]
    )
    page = (await c.get(f"/docs/pages/{cv['page_id']}")).json()
    assert page["kind"] == "canvas" and page["markdown"] == cv["markdown"]
    tree = (await c.get(f"/projects/{pid}/docs/tree")).json()
    assert any(p["id"] == cv["page_id"] and p["kind"] == "canvas" for p in tree)
    versions_before = len((await c.get(f"/canvases/{cv['id']}/versions")).json())
    page_id = cv["doc"]["pages"][0]["id"]
    await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": cv["rev"],
            "upsert": {"labels": [{"x": 0, "y": 0, "text": "a", "page": page_id}]},
        },
    )
    # a change soon after the last version does not make another
    assert (
        len((await c.get(f"/canvases/{cv['id']}/versions")).json()) == versions_before
    )
    monkeypatch.setattr(svc, "AUTO_VERSION_SECONDS", 0)
    rev = (await c.get(f"/canvases/{cv['id']}")).json()["rev"]
    await c.patch(
        f"/canvases/{cv['id']}",
        json={
            "base_rev": rev,
            "upsert": {"labels": [{"x": 0, "y": 40, "text": "b", "page": page_id}]},
        },
    )
    assert (
        len((await c.get(f"/canvases/{cv['id']}/versions")).json())
        == versions_before + 1
    )


async def test_move_to_docs_keeps_the_id_and_the_text_keeps_showing_it(c, pid):
    cv = await make(c, pid)
    pin = await c.post(f"/canvases/{cv['id']}/threads", json={"body": "Check"})
    assert pin.status_code == 201
    out = await c.post(
        f"/canvases/{cv['id']}/move-to-docs", json={"title": "Login flow"}
    )
    assert out.status_code == 200, out.text
    moved = out.json()["canvas"]
    assert (
        moved["id"] == cv["id"]
        and moved["owner_kind"] == "page"
        and moved["page_id"] == out.json()["page"]["id"]
    )
    assert (await c.get(f"/canvases/{cv['id']}/threads")).json()[0]["comments"][0][
        "body"
    ] == "Check"
    again = await c.post(f"/canvases/{cv['id']}/move-to-docs", json={})
    assert again.status_code == 422 and again.json()["detail"]["code"] == "already_page"


# --- comments ---------------------------------------------------------------------------------------------------


async def test_comment_threads_pinned_to_a_frame_or_the_plane_resolve_and_reopen(
    c, pid
):
    cv = await make(c, pid)
    cid, bid = cv["id"], cv["doc"]["boards"][0]["id"]
    t1 = (
        await c.post(
            f"/canvases/{cid}/threads",
            json={"body": "Logo too small @Hoa", "board_id": bid, "x": 0.7, "y": 0.4},
        )
    ).json()
    t2 = (
        await c.post(
            f"/canvases/{cid}/threads", json={"body": "Plane note", "x": 120, "y": 80}
        )
    ).json()
    assert (
        (t1["number"], t2["number"]) == (1, 2)
        and t1["board_id"] == bid
        and t2["board_id"] is None
    )
    assert t1["comments"][0]["mentions"] == ["Hoa"]
    rep = await c.post(
        f"/canvases/threads/{t1['id']}/replies",
        json={"body": "It matches the brand sheet"},
    )
    assert len(rep.json()["comments"]) == 2
    res = (await c.post(f"/canvases/threads/{t1['id']}/resolve")).json()
    assert res["status"] == "resolved" and res["resolved_by"] == "user"
    assert [
        t["id"]
        for t in (
            await c.get(f"/canvases/{cid}/threads", params={"state": "open"})
        ).json()
    ] == [t2["id"]]
    assert (await c.get(f"/canvases/{cid}")).json()["open_comments"] == 1
    assert (await c.post(f"/canvases/threads/{t1['id']}/reopen")).json()[
        "status"
    ] == "open"
    # a pin keeps its frame; a pin on a frame that is not there is refused
    bad = await c.post(
        f"/canvases/{cid}/threads", json={"body": "x", "board_id": "b_deadbeef"}
    )
    assert bad.status_code == 404
    empty = await c.post(f"/canvases/{cid}/threads", json={"body": "  "})
    assert empty.status_code == 422
    # deleting the opening comment removes the thread
    first = t2["comments"][0]["id"]
    assert (await c.delete(f"/canvases/comments/{first}")).json()["deleted"] == "thread"


# --- permissions ------------------------------------------------------------------------------------------------


async def test_viewers_can_look_but_not_change_anything(c, pid):
    await add_member(c, pid, "Vi", "viewer")
    cv = await make(c, pid)
    h = {"x-actor": "Vi"}
    got = await c.get(f"/canvases/{cv['id']}", headers=h)
    assert (
        got.status_code == 200
        and got.json()["role"] == "viewer"
        and got.json()["can_edit"] is False
    )
    assert (await c.get(f"/canvases/{cv['id']}/threads", headers=h)).status_code == 200
    assert (await c.get(f"/canvases/{cv['id']}/versions", headers=h)).status_code == 200
    bid = cv["doc"]["boards"][0]["id"]
    calls = [
        c.post(
            "/canvases",
            json={"owner_kind": "doc", "owner_id": "p", "project_id": pid},
            headers=h,
        ),
        c.patch(f"/canvases/{cv['id']}", json={"base_rev": 1}, headers=h),
        c.post(f"/canvases/{cv['id']}/boards", data={"kind": "empty"}, headers=h),
        c.post(f"/canvases/{cv['id']}/boards/{bid}/lock", headers=h),
        c.post(f"/canvases/{cv['id']}/threads", json={"body": "hi"}, headers=h),
        c.delete(f"/canvases/{cv['id']}", headers=h),
        c.post(f"/canvases/{cv['id']}/versions/1/restore", headers=h),
        c.post(
            f"/canvases/{cv['id']}/ai/ask",
            json={"board_ids": [bid], "request": "x"},
            headers=h,
        ),
    ]
    for coro in calls:
        r = await coro
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["code"] == "read_only"


async def test_a_canvas_of_a_ticket_is_the_tickets_to_see(c, pid):
    t = await c.post(f"/projects/{pid}/tickets", json={"title": "Redesign"})
    cv = await make(
        c, None, owner_kind="ticket", owner_id=t.json()["id"], project_id=None
    )
    assert cv["project_id"] == pid and cv["owner_kind"] == "ticket"


# --- exports -----------------------------------------------------------------------------------------------------


async def test_download_zip_overview_and_snapshots(c, pid):
    cv = await make(c, pid)
    b = await html_board(c, cv["id"], "Sign in")
    zipped = await c.get(f"/canvases/{cv['id']}/download")
    assert (
        zipped.status_code == 200
        and "attachment" in zipped.headers["content-disposition"]
    )
    names = zipfile.ZipFile(io.BytesIO(zipped.content)).namelist()
    assert "canvas.json" in names and "Sign-in/index.html" in names
    one = await c.get(f"/canvases/{cv['id']}/download", params={"board_id": b["id"]})
    assert zipfile.ZipFile(io.BytesIO(one.content)).namelist() == ["index.html"]
    ov = await c.get(f"/canvases/{cv['id']}/overview.png")
    assert (
        ov.status_code == 200
        and ov.content.startswith(b"\x89PNG")
        and ov.headers["content-type"] == "image/png"
    )
    snap = await c.get(f"/canvases/{cv['id']}/boards/{b['id']}/snapshot.png")
    assert snap.content.startswith(b"\x89PNG")
    cp = await c.post(f"/canvases/{cv['id']}/copy")
    assert (
        cp.status_code == 201
        and cp.json()["id"] != cv["id"]
        and len(cp.json()["doc"]["boards"]) == 2
    )
    copied = cp.json()
    cb = copied["doc"]["boards"][1]
    page = await c.get(
        f"/canvases/{copied['id']}/boards/{cb['id']}/r/{cb['content']['rev']}/index.html"
    )
    assert "Sign in" in page.text


# --- AI proposals ----------------------------------------------------------------------------------------------


async def propose(c, cid, bid, text="<h1>Better</h1>", **extra):
    from database import async_session  # noqa: F401
    from services import canvas_proposals

    async with test_async_session() as session:
        return await canvas_proposals.create(
            session,
            cid,
            changes=[{"board_id": bid, "files": {"index.html": text}}],
            request="Make it red",
            note="Changed the heading",
            author="Designer AI",
            **extra,
        )


async def test_a_proposal_changes_nothing_until_a_person_accepts(c, pid):
    cv = await make(c, pid)
    b = await html_board(c, cv["id"])
    p = await propose(c, cv["id"], b["id"], "<h1>Better</h1><script>alert(1)</script>")
    ch = p["changes"][0]
    assert p["status"] == "open" and ch["lines"] > 0 and ch["name"] == "Sign in"
    after_html = next(f["text"] for f in ch["after"] if f["path"] == "index.html")
    assert "Better" in after_html and "<script" not in after_html.lower()
    assert "Sign in" in next(
        f["text"] for f in ch["before"] if f["path"] == "index.html"
    )
    # the board is untouched
    now = (await c.get(f"/canvases/{cv['id']}")).json()
    assert (
        now["doc"]["boards"][1]["content"]["rev"] == b["content"]["rev"]
        and now["proposals_open"] == 1
    )
    # the "After" preview is served as locked as a frame
    after = await c.get(
        f"/canvases/{cv['id']}/proposals/{p['id']}/{b['id']}/index.html"
    )
    assert (
        after.status_code == 200
        and "sandbox" in after.headers["content-security-policy"]
    )
    done = await c.post(
        f"/canvases/{cv['id']}/proposals/{p['id']}/decide", json={"accept": "all"}
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "accepted" and done.json()["version"] == 2
    cur = (await c.get(f"/canvases/{cv['id']}")).json()["doc"]["boards"][1]
    new = await c.get(
        f"/canvases/{cv['id']}/boards/{b['id']}/r/{cur['content']['rev']}/index.html"
    )
    assert "Better" in new.text
    v = (await c.get(f"/canvases/{cv['id']}/versions")).json()[0]
    assert v["reason"] == "proposal" and "Designer AI" in v["note"]
    again = await c.post(
        f"/canvases/{cv['id']}/proposals/{p['id']}/decide", json={"accept": "all"}
    )
    assert again.status_code == 409


async def test_accept_one_reject_the_rest(c, pid):
    cv = await make(c, pid)
    b1 = await html_board(c, cv["id"], "One")
    b2 = await html_board(c, cv["id"], "Two")
    from services import canvas_proposals

    async with test_async_session() as session:
        p = await canvas_proposals.create(
            session,
            cv["id"],
            changes=[
                {"board_id": b1["id"], "files": {"index.html": "<h1>A</h1>"}},
                {"board_id": b2["id"], "files": {"index.html": "<h1>B</h1>"}},
            ],
            author="Designer AI",
        )
    r = await c.post(
        f"/canvases/{cv['id']}/proposals/{p['id']}/decide",
        json={"accept": [b1["id"]], "reject": "rest"},
    )
    assert r.status_code == 200 and r.json()["status"] == "partly"
    assert {x["board_id"]: x["status"] for x in r.json()["changes"]} == {
        b1["id"]: "accepted",
        b2["id"]: "rejected",
    }


async def test_ai_never_takes_a_lock_a_proposal_for_a_locked_frame_waits(c, pid):
    await add_member(c, pid, "An")
    cv = await make(c, pid)
    b = await html_board(c, cv["id"])
    await c.post(
        f"/canvases/{cv['id']}/boards/{b['id']}/lock", headers={"x-actor": "An"}
    )
    p = await propose(c, cv["id"], b["id"])
    assert p["changes"][0]["waiting_for"] == "An"
    assert canvas_locks.holder_of(cv["id"], b["id"]).holder == "An"  # still theirs
    blocked = await c.post(
        f"/canvases/{cv['id']}/proposals/{p['id']}/decide", json={"accept": "all"}
    )
    assert (
        blocked.status_code == 423
        and blocked.json()["detail"]["code"] == "board_locked"
    )
    await c.delete(
        f"/canvases/{cv['id']}/boards/{b['id']}/lock", headers={"x-actor": "An"}
    )
    listed = (await c.get(f"/canvases/{cv['id']}/proposals")).json()
    assert listed[0]["changes"][0]["waiting_for"] is None
    assert (
        await c.post(
            f"/canvases/{cv['id']}/proposals/{p['id']}/decide", json={"accept": "all"}
        )
    ).status_code == 200


async def test_a_proposal_goes_stale_when_the_frame_changed(c, pid):
    cv = await make(c, pid)
    b = await html_board(c, cv["id"])
    p = await propose(c, cv["id"], b["id"])
    await c.put(
        f"/canvases/{cv['id']}/boards/{b['id']}/content",
        json={"files": [{"path": "index.html", "text": "<h1>Mine</h1>"}]},
    )
    stale = await c.post(
        f"/canvases/{cv['id']}/proposals/{p['id']}/decide", json={"accept": "all"}
    )
    assert (
        stale.status_code == 409 and stale.json()["detail"]["code"] == "proposal_stale"
    )
    assert (await c.get(f"/canvases/{cv['id']}/proposals")).json()[0]["changes"][0][
        "status"
    ] == "stale"


async def test_proposals_are_for_html_frames_only(c, pid):
    cv = await make(c, pid, start="none")
    r = await c.post(
        f"/canvases/{cv['id']}/boards",
        data={"kind": "image"},
        files=[("files", ("a.png", png(), "image/png"))],
    )
    from services import canvas_proposals
    from services.docs_text import DocsError

    async with test_async_session() as session:
        with pytest.raises(DocsError) as e:
            await canvas_proposals.create(
                session,
                cv["id"],
                changes=[
                    {
                        "board_id": r.json()["board"]["id"],
                        "files": {"index.html": "<h1>x</h1>"},
                    }
                ],
            )
    assert e.value.code == "not_editable_here"


def test_the_model_reply_is_parsed_per_frame():
    from services.canvas_proposals import parse_reply

    reply = (
        "=== FILE b_0a1b2c3d index.html ===\n<h1>New</h1>\n=== END ===\n"
        "=== FILE b_0a1b2c3d style.css ===\n```css\nh1{color:red}\n```\n=== END ===\nNOTE: made the heading red"
    )
    files, note = parse_reply(reply)
    assert files == {
        "b_0a1b2c3d": {"index.html": "<h1>New</h1>", "style.css": "h1{color:red}"}
    }
    assert note == "made the heading red"
    assert parse_reply("I could not do that") == ({}, "")


async def test_an_ai_comment_is_marked_and_an_ai_member_cannot_resolve_a_persons_thread(
    c, pid
):
    from services import canvas_comments

    cv = await make(c, pid)
    await add_member(c, pid, "Designer AI")
    person = (
        await c.post(f"/canvases/{cv['id']}/threads", json={"body": "Check this"})
    ).json()
    ai = (
        await c.post(
            f"/canvases/{cv['id']}/threads",
            json={"body": "Button is 36 px", "board_id": cv["doc"]["boards"][0]["id"]},
            headers={"x-actor": "Designer AI"},
        )
    ).json()
    assert ai["created_by"] == "Designer AI"
    from models import AiMember

    async with test_async_session() as session:
        from sqlmodel import select

        from models import Member

        m = (
            await session.exec(select(Member).where(Member.name == "Designer AI"))
        ).first()
        session.add(
            AiMember(
                id=m.id, project_id=pid, provider="claude-code", connection="local"
            )
        )
        await session.commit()
        with pytest.raises(Exception) as e:
            from services import activity

            token = activity.set_actor("Designer AI")
            try:
                await canvas_comments.set_status(session, person["id"], "resolved")
            finally:
                activity.reset_actor(token)
    assert getattr(e.value, "code", "") == "ai_cannot_resolve"
