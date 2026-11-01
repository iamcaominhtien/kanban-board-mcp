"""Canvases through the Docs tools (docs_read canvases / canvas, docs_write canvas_comment / canvas_propose): an agent
reads frames, notes and comments, comments under its own name and *proposes* a changed frame as files; nothing is
changed until a person accepts, and an AI run is checked by the same guard and project scope as the other Docs actions."""

import json
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
        "<title>Sign in</title><h1>Sign in</h1><button class=big>Go</button><script>go()</script>"
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
        and "<script>go()</script>" in listed[0]["changes"][0]["after"][0]["text"]
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


async def test_ai_cannot_read_a_hidden_canvas_page_or_reply_into_another_canvas(
    env, tmp_path
):
    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]
    made = (
        await c.post(
            "/canvases/pages", json={"project_id": pid, "title": "Secret flow"}
        )
    ).json()
    cv, page_id = made["canvas"], made["page"]["id"]
    other = (
        await c.post(
            "/canvases",
            json={"owner_kind": "ticket", "owner_id": tid, "title": "Open one"},
        )
    ).json()
    thread = (
        await c.post(f"/canvases/{other['id']}/threads", json={"body": "hello"})
    ).json()
    await _people(c, pid)
    await c.patch(
        f"/ai/members/{m['id']}",
        json={"template": "custom", "permissions": {"edit_docs": "allowed"}},
        headers=OWNER,
    )
    tokens = guard.enter(ctx)
    try:
        assert {
            x["id"] for x in await docs_read(action="canvases", project_id=pid)
        } >= {cv["id"], other["id"]}
        # a reply into a thread of another canvas is refused
        with pytest.raises(ValueError, match="another canvas"):
            await docs_write(
                action="canvas_comment",
                canvas_id=cv["id"],
                thread_id=thread["id"],
                body="x",
            )
    finally:
        guard.leave(tokens)
    async with env["maker"]() as s:
        from models import DocsPage

        row = await s.get(DocsPage, page_id)
        row.ai_hidden = True
        s.add(row)
        await s.commit()
    tokens = guard.enter(ctx)
    try:
        assert cv["id"] not in {
            x["id"] for x in await docs_read(action="canvases", project_id=pid)
        }
        with pytest.raises(ValueError, match="hidden from AI"):
            await docs_read(action="canvas", canvas_id=cv["id"])
        with pytest.raises(ValueError, match="hidden from AI"):
            await docs_write(action="canvas_comment", canvas_id=cv["id"], body="x")
    finally:
        guard.leave(tokens)
    # a person's own agent (no AI run) still reads it
    assert (await docs_read(action="canvas", canvas_id=cv["id"]))["id"] == cv["id"]


async def test_an_agent_creates_a_canvas_of_frames_and_adds_more(env, tmp_path):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Todo app design")
    root = tmp_path / "todo"
    for name, size in (
        ("Today", "phone"),
        ("Add task", [390, 700]),
        ("Tablet", "tablet"),
    ):
        d = root / name
        d.mkdir(parents=True)
        (d / "index.html").write_text(
            f"<title>{name}</title><h1>{name}</h1><script>document.title='ran'</script>"
            '<button onclick="go()">Go</button>'
        )
        (d / "frame.json").write_text(
            json.dumps({"name": f"Todo: {name}", "size": size})
        )
    out = await docs_write(
        action="canvas_create",
        owner_kind="ticket",
        owner_id=tid,
        title="Todo app",
        path=str(root),
    )
    assert out["markdown"] == f"![Todo app](canvas:{out['id']})"
    names = {b["name"]: (b["w"], b["h"]) for b in out["boards"]}
    assert names == {
        "Todo: Add task": (390, 700),
        "Todo: Today": (390, 844),
        "Todo: Tablet": (820, 1180),
    }
    # the files are kept as written: the script and the handler are still there
    got = await docs_read(
        action="canvas", canvas_id=out["id"], board_id=out["boards"][0]["id"]
    )
    text = got["board"]["files"][0]["text"]
    assert "<script>" in text and 'onclick="go()"' in text
    assert "frame.json" not in {f["path"] for f in got["board"]["files"]}
    # more frames into the same canvas, from loose pages at the top of a folder
    extra = tmp_path / "extra"
    extra.mkdir()
    (extra / "index.html").write_text("<h1>Done</h1>")
    more = await docs_write(
        action="canvas_create", canvas_id=out["id"], title="Done", path=str(extra)
    )
    assert more["id"] == out["id"] and [b["name"] for b in more["boards"]] == ["Done"]
    doc = (await c.get(f"/canvases/{out['id']}")).json()
    assert len(doc["doc"]["boards"]) == 4


async def test_canvas_create_says_what_is_missing_before_it_makes_anything(
    env, tmp_path
):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Todo app design")
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="owner_kind and owner_id"):
        await docs_write(action="canvas_create", path=str(empty))
    with pytest.raises(ValueError, match="no HTML page"):
        await docs_write(
            action="canvas_create", owner_kind="ticket", owner_id=tid, path=str(empty)
        )
    with pytest.raises(ValueError, match="absolute folder"):
        await docs_write(
            action="canvas_create", owner_kind="ticket", owner_id=tid, path="rel"
        )
    # one bad frame stops the whole call: no half-made canvas
    bad = tmp_path / "bad"
    (bad / "a").mkdir(parents=True)
    (bad / "a" / "index.html").write_text("<h1>ok</h1>")
    (bad / "b").mkdir()
    (bad / "b" / "index.html").write_text("<h1>x</h1>")
    (bad / "b" / "frame.json").write_text("{nope")
    with pytest.raises(ValueError, match="not valid JSON"):
        await docs_write(
            action="canvas_create", owner_kind="ticket", owner_id=tid, path=str(bad)
        )
    listed = await docs_read(action="canvases", project_id=pid)
    assert listed == []


def test_the_design_brief_reaches_the_agent_and_the_ai_job():
    import kanban_mcp
    from services import canvas_design, canvas_proposals

    assert canvas_design.SHORT in kanban_mcp.build_instructions()
    assert canvas_design.BRIEF in canvas_proposals.RULES
    # the process and its checklist are all there
    for needle in (
        "Context first",
        "Direction:",
        "Tokens first",
        "never emoji",
        "empty (say what to do next)",
        "4.5:1",
        "squint",
        "[YOUR PRICE]",
        "A small change stays small",
        "no fake phone status bar",
    ):
        assert needle in canvas_design.BRIEF
    assert "never lorem ipsum" in canvas_design.BRIEF
    assert "no lorem ipsum" in canvas_design.SHORT
    # it is a brief, not an essay
    assert len(canvas_design.SHORT) < 2000 and len(canvas_design.BRIEF) < 5200
