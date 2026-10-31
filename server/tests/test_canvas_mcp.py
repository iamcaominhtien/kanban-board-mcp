"""Canvases through the Docs tools (docs_read canvases / canvas, docs_write canvas_comment / canvas_propose): an agent
reads frames, notes and comments, comments under its own name and *proposes* a changed frame as files; nothing is
changed until a person accepts, and an AI run is checked by the same guard and project scope as the other Docs actions."""

from dataclasses import replace

import pytest

from kanban_mcp import common
from kanban_mcp.tools.docs import docs_read, docs_write
from services import canvas_locks
from services.ai import guard
from tests.test_ai import _ctx, _project, _ticket, env  # noqa: F401  (fixture)
from tests.test_ai_safety import OWNER, _people

PAGE = b"<title>Sign in</title><h1>Sign in</h1><button>Go</button>"


@pytest.fixture(autouse=True)
def _mcp(monkeypatch, tmp_path, env):  # noqa: F811
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(common, "async_session", env["maker"])
    canvas_locks.reset()


async def _canvas(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Redesign sign-in")
    cv = (
        await c.post(
            "/canvases",
            json={"owner_kind": "ticket", "owner_id": tid, "title": "Login redesign"},
        )
    ).json()
    b = (
        await c.post(
            f"/canvases/{cv['id']}/boards",
            data={"kind": "html", "name": "Sign in"},
            files=[("files", ("index.html", PAGE, "text/html"))],
        )
    ).json()["board"]
    return c, pid, tid, cv, b


async def test_an_agent_reads_a_canvas_and_a_frame_as_files(env, tmp_path):
    c, pid, tid, cv, b = await _canvas(env)
    await c.post(
        f"/canvases/{cv['id']}/threads",
        json={"body": "Logo too small?", "board_id": b["id"]},
    )
    listed = await docs_read(action="canvases", project_id=pid)
    assert [(x["id"], x["boards"], x["markdown"]) for x in listed] == [
        (cv["id"], 2, f"![Login redesign](canvas:{cv['id']})")
    ]
    got = await docs_read(action="canvas", canvas_id=cv["id"])
    assert [x["name"] for x in got["boards"]] == ["Frame 1", "Sign in"]
    assert got["comments"][0]["comments"][0]["body"] == "Logo too small?"
    assert (
        got["boards"][1]["entry"] == "index.html"
        and got["boards"][1]["locked_by"] is None
    )
    # the source of one frame, inline
    one = await docs_read(action="canvas", canvas_id=cv["id"], board_id=b["id"])
    assert "Sign in" in one["board"]["files"][0]["text"]
    # or as files in a folder
    out = await docs_read(
        action="canvas",
        canvas_id=cv["id"],
        board_id=b["id"],
        path=str(tmp_path / "work"),
    )
    assert (tmp_path / "work" / "index.html").read_bytes() == PAGE and out["board"][
        "written"
    ]


async def test_an_agent_comments_and_proposes_but_never_changes_a_frame(env, tmp_path):
    c, pid, tid, cv, b = await _canvas(env)
    t = await docs_write(
        action="canvas_comment",
        canvas_id=cv["id"],
        board_id=b["id"],
        body="Button is 36 px",
    )
    assert t["comments"][0]["author"] == "agent" and t["board_id"] == b["id"]
    rep = await docs_write(
        action="canvas_comment",
        canvas_id=cv["id"],
        thread_id=t["id"],
        body="Want me to fix it?",
    )
    assert len(rep["comments"]) == 2
    work = tmp_path / "work"
    work.mkdir()
    (work / "index.html").write_text(
        "<title>Sign in</title><h1>Sign in</h1><button class=big>Go</button><script>alert(1)</script>"
    )
    out = await docs_write(
        action="canvas_propose",
        canvas_id=cv["id"],
        board_id=b["id"],
        path=str(work),
        note="Bigger button",
    )
    assert (
        out["status"] == "open"
        and out["boards"] == ["Sign in"]
        and out["lines_changed"] > 0
    )
    # nothing changed
    doc = (await c.get(f"/canvases/{cv['id']}")).json()
    assert doc["doc"]["boards"][1]["content"]["rev"] == b["content"]["rev"]
    listed = (await c.get(f"/canvases/{cv['id']}/proposals")).json()
    assert (
        listed[0]["note"] == "Bigger button"
        and "<script" not in listed[0]["changes"][0]["after"][0]["text"].lower()
    )
    # a person accepts
    assert (
        await c.post(
            f"/canvases/{cv['id']}/proposals/{out['id']}/decide", json={"accept": "all"}
        )
    ).status_code == 200
    # a frame a person is editing is not touched: the proposal waits
    await c.post(f"/canvases/{cv['id']}/boards/{b['id']}/lock")
    (work / "index.html").write_text("<h1>Again</h1>")
    waiting = await docs_write(
        action="canvas_propose", canvas_id=cv["id"], board_id=b["id"], path=str(work)
    )
    assert waiting["waiting_for"] == "user"
    assert canvas_locks.holder_of(cv["id"], b["id"]).holder == "user"


async def test_bad_calls_say_what_is_wrong(env, tmp_path):
    c, pid, tid, cv, b = await _canvas(env)
    with pytest.raises(Exception, match="absolute folder"):
        await docs_write(
            action="canvas_propose", canvas_id=cv["id"], board_id=b["id"], path="rel"
        )
    with pytest.raises(Exception, match="requires"):
        await docs_write(action="canvas_propose", canvas_id=cv["id"])
    with pytest.raises(Exception, match="not found"):
        await docs_read(action="canvas", canvas_id="cv_00000000")
    empty = tmp_path / "e"
    empty.mkdir()
    with pytest.raises(Exception, match="does not change any frame"):
        await docs_write(
            action="canvas_propose",
            canvas_id=cv["id"],
            board_id=b["id"],
            path=str(empty),
        )
    img = (
        await c.post(
            f"/canvases/{cv['id']}/boards",
            data={"kind": "empty", "name": "x"},
        )
    ).json()["board"]
    (empty / "index.html").write_text("<h1>x</h1>")
    ok = await docs_write(
        action="canvas_propose", canvas_id=cv["id"], board_id=img["id"], path=str(empty)
    )
    assert ok["status"] == "open"


async def test_an_ai_run_goes_through_the_guard_and_its_own_project(env, tmp_path):
    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]
    cv = (
        await c.post(
            "/canvases",
            json={"owner_kind": "ticket", "owner_id": tid, "title": "By a person"},
        )
    ).json()
    bid = cv["doc"]["boards"][0]["id"]
    work = tmp_path / "w"
    work.mkdir()
    (work / "index.html").write_text("<h1>AI</h1>")
    args = {"canvas_id": cv["id"], "board_id": bid, "path": str(work)}
    tokens = guard.enter(replace(ctx, mode="ask"))
    try:
        with pytest.raises(ValueError, match="Ask runs only read"):
            await docs_write(action="canvas_propose", **args)
        assert (await docs_read(action="canvas", canvas_id=cv["id"]))["id"] == cv[
            "id"
        ]  # reading is fine
    finally:
        guard.leave(tokens)
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
            await docs_write(action="canvas_comment", canvas_id=cv["id"], body="hi")
    finally:
        guard.leave(tokens)
    assert (await c.get(f"/canvases/{cv['id']}/threads")).json() == []
    await _people(c, pid)
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"template": "custom", "permissions": {"edit_docs": "allowed"}},
        headers=OWNER,
    )
    assert r.status_code == 200, r.text
    tokens = guard.enter(ctx)
    try:
        t = await docs_write(
            action="canvas_comment",
            canvas_id=cv["id"],
            board_id=bid,
            body="Two different heights",
        )
        assert (
            t["created_by"] == m["name"]
            and t["comments"][0]["is_ai"]
            and t["comments"][0]["ai"]["can_propose"]
        )
        prop = await docs_write(action="canvas_propose", **args, note="Same height")
        assert prop["status"] == "open"
    finally:
        guard.leave(tokens)
    # the proposal is by the AI member, and the frame is still the person's
    p = (await c.get(f"/canvases/{cv['id']}/proposals")).json()[0]
    assert p["author"] == m["name"] and p["member_id"] == m["id"]
    # another project's canvas is out of reach for the run
    pid2 = (
        await c.post(
            "/projects", json={"name": "Other", "prefix": "OTH", "color": "#123456"}
        )
    ).json()["id"]
    other_t = await _ticket(c, pid2, "Elsewhere")
    other = (
        await c.post(
            "/canvases",
            json={"owner_kind": "ticket", "owner_id": other_t, "title": "Theirs"},
        )
    ).json()
    tokens = guard.enter(ctx)
    try:
        for call in (
            docs_read(action="canvas", canvas_id=other["id"]),
            docs_write(action="canvas_comment", canvas_id=other["id"], body="x"),
            docs_write(
                action="canvas_propose",
                canvas_id=other["id"],
                board_id=other["doc"]["boards"][0]["id"],
                path=str(work),
            ),
        ):
            with pytest.raises(ValueError, match="another project"):
                await call
    finally:
        guard.leave(tokens)
