"""Canvases through the Docs tools (docs_read canvases / canvas, docs_write canvas_comment / canvas_propose): an agent
reads frames, notes and comments, comments under its own name and *proposes* a changed frame as files; nothing is
changed until a person accepts, and an AI run is checked by the same guard and project scope as the other Docs actions."""

import json
from dataclasses import replace
from pathlib import Path

import pytest

from kanban_mcp import common
from kanban_mcp.tools.docs import docs_read, docs_write
from services import canvas_locks
from services.ai import guard
from tests.ai_helpers import _ctx, _project, _ticket, env  # noqa: F401  (fixture)
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
    tokens = guard.enter(replace(ctx, mode="ask", trigger="autopilot"))
    try:
        with pytest.raises(ValueError, match="Autopilot only reads"):
            await docs_write(action="canvas_propose", **args)
        assert (await docs_read(action="canvas", canvas_id=cv["id"]))["id"] == cv[
            "id"
        ]  # reading is fine
    finally:
        guard.leave(tokens)
    # a project that asks before an AI comments (a comment or a proposal changes nothing until a person accepts)
    await _people(c, pid)
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"permissions": {"comment": "approval"}},
        headers=OWNER,
    )
    assert r.status_code == 200, r.text
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
            await docs_write(action="canvas_comment", canvas_id=cv["id"], body="hi")
    finally:
        guard.leave(tokens)
    assert (await c.get(f"/canvases/{cv['id']}/threads")).json() == []
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"template": "custom", "permissions": {"comment": "allowed"}},
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


def test_the_design_guide_reaches_the_agent_and_the_ai_job():
    from pathlib import Path

    import kanban_mcp
    from services import canvas_design, canvas_proposals

    # Claude Code keeps only the first 10,000 characters of a server's instructions: the guide is not there, the
    # instructions say where to load it, and every Claude Code run gets it whole as the canvas-design skill
    instructions = kanban_mcp.build_instructions(True)
    assert len(instructions) < 10_000
    assert "canvas-design" in instructions and "design_guide" in instructions
    assert canvas_design.GUIDE not in instructions
    from services.ai import board_skills

    skill_md = Path(board_skills.plugin_dir()) / "skills" / "canvas-design" / "SKILL.md"
    assert skill_md.read_text() == canvas_design.SKILL_HEADER + canvas_design.GUIDE
    assert canvas_design.GUIDE in canvas_proposals.RULES
    # the skill file for Claude Code is this same text: one source
    skill = (
        Path(__file__).resolve().parents[2] / ".claude/skills/canvas-design/SKILL.md"
    )
    assert (
        skill.read_text(encoding="utf-8")
        == canvas_design.SKILL_HEADER + canvas_design.GUIDE
    )
    # the process and its checklist are all there
    for needle in (
        "## 0. Context before anything",
        "## 1. Ask once, then decide",
        "## 2. Direction",
        "[YOUR PRICE]",
        "## 4. Tokens",
        "Never emoji as icons",
        "No fake phone chrome",
        "empty (say what to do next)",
        "4.5:1",
        "## 9. Changing an existing design",
        "## 10. Check before you send",
    ):
        assert needle in canvas_design.GUIDE, needle
    # the board's own words about ideas are not in a guide every agent reads
    assert "idea" not in canvas_design.GUIDE.lower()
    # how a design is presented: a document, foundations first, states side by side, restraint for an app
    for needle in (
        "## 7. The canvas is a design document",
        "States side by side",
        "Foundations first, at full depth",
        "Card title / 15 / 600 / lh 1.35",
        "## 2. Direction: character before pixels",
        "**The signature**",
        "**Explore before you build.**",
        "The thumbnail test",
        "A spec per screen",
        "`examples/`",
        # a live run made to open rule-set skills for its palette and type came out a flat, generic design
        "**Other design skills never set the look.**",
        "only for a craft this guide does not teach",
    ):
        assert needle in canvas_design.GUIDE, needle
    # how a design stops looking machine-made travels with the skill as craft.md, in the plugin and the repository
    assert (skill_md.parent / "craft.md").read_text() == canvas_design.CRAFT
    assert (skill.parent / "craft.md").read_text(
        encoding="utf-8"
    ) == canvas_design.CRAFT
    for needle in (
        "## The tells, and what to do instead",
        "## Explore, then build",
        "## Motion and SVG",
        "## The critique pass",
    ):
        assert needle in canvas_design.CRAFT, needle
    assert "idea" not in canvas_design.CRAFT.lower()
    # the exemplar boards the guide points to travel with the skill, in the board's plugin and in the repository
    names = {p.name for p in canvas_design.examples()}
    assert names == {"foundations.html", "foundations.png", "states.html", "states.png"}
    for name in names:
        assert (skill_md.parent / "examples" / name).read_bytes() == (
            canvas_design.EXAMPLES / name
        ).read_bytes()
        assert (skill.parent / "examples" / name).is_file()
    assert (
        "`foundations.png`" in canvas_design.GUIDE
        and "`states.png`" in canvas_design.GUIDE
    )
    # a guide, not an essay
    assert len(canvas_design.GUIDE) < 16_000


async def test_an_agent_lays_out_a_flow_with_notes_arrows_labels_and_fit(env, tmp_path):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Flow")
    root = tmp_path / "flow"
    for folder in ("01-today", "02-new-task"):
        (root / folder).mkdir(parents=True)
        (root / folder / "index.html").write_text(f"<h1>{folder}</h1>")
    (root / "02-new-task" / "frame.json").write_text(
        json.dumps({"size": "phone", "fit": True, "x": 900, "y": 40})
    )
    (root / "canvas.json").write_text(
        json.dumps(
            {
                "notes": [
                    {"id": "why", "text": "Add in 5 seconds", "near": "01-today"},
                    {"text": "Loose note", "x": 5, "y": 7, "color": "green"},
                ],
                "arrows": [
                    {"from": "01-today", "to": "02-new-task", "label": "+ button"},
                    {"from": "why", "to": "today"},
                ],
                "labels": [{"text": "Todo flow", "size": 34}],
            }
        )
    )
    out = await docs_write(
        action="canvas_create",
        owner_kind="ticket",
        owner_id=tid,
        title="Flow",
        path=str(root),
    )
    assert (out["notes"], out["arrows"], out["labels"]) == (2, 2, 1)
    assert [b["name"] for b in out["boards"]] == [
        "today",
        "new-task",
    ]  # "01-" is the order, not the name
    doc = (await c.get(f"/canvases/{out['id']}")).json()["doc"]
    today, new = doc["boards"]
    assert (new["x"], new["y"], new.get("fit")) == (
        900,
        40,
        True,
    ) and "fit" not in today
    why = next(n for n in doc["notes"] if n["text"] == "Add in 5 seconds")
    assert (
        why["x"] == today["x"] and why["y"] == today["y"] + today["h"] + 60
    )  # near the frame, below it
    assert {(a["from"], a["to"], a["label"]) for a in doc["arrows"]} == {
        (today["id"], new["id"], "+ button"),
        (why["id"], today["id"], ""),
    }
    assert doc["labels"][0]["text"] == "Todo flow"
    # a wrong reference is said before anything is made
    (root / "canvas.json").write_text(
        json.dumps({"arrows": [{"from": "today", "to": "nowhere"}]})
    )
    before = await docs_read(action="canvases", project_id=pid)
    with pytest.raises(ValueError, match="'nowhere' is not a frame or a note id"):
        await docs_write(
            action="canvas_create",
            owner_kind="ticket",
            owner_id=tid,
            title="Bad",
            path=str(root),
        )
    assert await docs_read(action="canvases", project_id=pid) == before


async def test_an_agent_lays_out_a_design_document_on_pages(env, tmp_path):
    """Foundations, then components, then screens: frame.json names a page tab, canvas.json titles each page."""
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Water app")
    root = tmp_path / "doc"
    for folder, page in (
        ("01-foundations", "Foundations"),
        ("02-cards", "Components"),
        ("10-today", "Screens · Today"),
        ("11-today-web", "Screens · Today"),
    ):
        (root / folder).mkdir(parents=True)
        (root / folder / "index.html").write_text(f"<h1>{folder}</h1>")
        (root / folder / "frame.json").write_text(
            json.dumps({"page": page, "fit": True})
        )
    (root / "canvas.json").write_text(
        json.dumps(
            {
                "labels": [
                    {"text": "Foundations", "page": "Foundations", "size": 48},
                    {"text": "Today", "page": "Screens · Today", "size": 48},
                ],
                "notes": [{"text": "Rows go left to right", "near": "11-today-web"}],
                "arrows": [{"from": "10-today", "to": "11-today-web"}],
            }
        )
    )
    out = await docs_write(
        action="canvas_create",
        owner_kind="ticket",
        owner_id=tid,
        title="Water app",
        path=str(root),
    )
    assert out["pages"] == ["Foundations", "Components", "Screens · Today"]
    doc = (await c.get(f"/canvases/{out['id']}")).json()["doc"]
    # the new canvas's first page takes the first name: no empty "Page 1" left behind
    assert [p["name"] for p in sorted(doc["pages"], key=lambda p: p["order"])] == out[
        "pages"
    ]
    page_of = {p["name"]: p["id"] for p in doc["pages"]}
    on = {b["name"]: b["page"] for b in doc["boards"]}
    assert on == {
        "foundations": page_of["Foundations"],
        "cards": page_of["Components"],
        "today": page_of["Screens · Today"],
        "today-web": page_of["Screens · Today"],
    }
    # each page is laid out on its own: the first frame of every page starts at the left
    first = {b["page"]: b for b in reversed(doc["boards"])}
    assert all(b["x"] == 0 for b in first.values())
    assert {lb["text"]: lb["page"] for lb in doc["labels"]} == {
        "Foundations": page_of["Foundations"],
        "Today": page_of["Screens · Today"],
    }
    assert (
        doc["notes"][0]["page"]
        == doc["arrows"][0]["page"]
        == page_of["Screens · Today"]
    )
    # adding to the canvas reuses a page of the same name and adds the new one
    more = tmp_path / "more"
    for folder, page in (
        ("20-history", "Screens · History"),
        ("03-banner", "Components"),
    ):
        (more / folder).mkdir(parents=True)
        (more / folder / "index.html").write_text(f"<h1>{folder}</h1>")
        (more / folder / "frame.json").write_text(json.dumps({"page": page}))
    await docs_write(action="canvas_create", canvas_id=out["id"], path=str(more))
    doc = (await c.get(f"/canvases/{out['id']}")).json()["doc"]
    assert len(doc["pages"]) == 4
    on = {b["name"]: b["page"] for b in doc["boards"]}
    assert on["banner"] == page_of["Components"]


async def test_a_comment_pins_to_an_element_and_the_rest_is_kept_clean(env, tmp_path):
    c, pid, tid, cv, b = await _canvas(env)
    # an agent: on the element showing some text, and on a CSS selector
    by_text = await docs_write(
        action="canvas_comment",
        canvas_id=cv["id"],
        board_id=b["id"],
        at="text=Add task",
        body="Make this button bigger",
    )
    by_sel = await docs_write(
        action="canvas_comment",
        canvas_id=cv["id"],
        board_id=b["id"],
        at="form > button.primary",
        body="Contrast is low",
    )
    assert by_text["anchor"] == {"text": "Add task", "ox": 0.5, "oy": 0.5}
    assert by_sel["anchor"]["sel"] == "form > button.primary"
    # no element: the middle of the frame, as before
    plain = await docs_write(
        action="canvas_comment", canvas_id=cv["id"], board_id=b["id"], body="Overall"
    )
    assert plain["anchor"] is None and (plain["x"], plain["y"]) == (0.5, 0.5)
    # `at` names an element of a frame
    with pytest.raises(ValueError, match="needs board_id"):
        await docs_write(
            action="canvas_comment", canvas_id=cv["id"], at="text=Go", body="x"
        )
    # a person's pin keeps where inside the element and the width it was made at
    r = await c.post(
        f"/canvases/{cv['id']}/threads",
        json={
            "body": "Here",
            "board_id": b["id"],
            "x": 0.25,
            "y": 0.4,
            "anchor": {
                "sel": "#go",
                "text": "  Go\n now ",
                "ox": 2,
                "oy": -1,
                "w": 390.4,
            },
        },
    )
    assert r.status_code == 201
    got = (await c.get(f"/canvases/{cv['id']}/threads")).json()
    mine = next(t for t in got if t["comments"][0]["body"] == "Here")
    assert mine["anchor"] == {
        "ox": 1.0,
        "oy": 0.0,
        "sel": "#go",
        "text": "Go now",
        "w": 390,
    }
    assert (mine["x"], mine["y"]) == (0.25, 0.4)
    # nothing usable, or a pin on the plane: no anchor
    for anchor, board in (
        ({"ox": 0.1}, b["id"]),
        ("not a dict", b["id"]),
        ({"sel": "#a"}, None),
    ):
        r = await c.post(
            f"/canvases/{cv['id']}/threads",
            json={
                "body": "x",
                "board_id": board,
                "anchor": anchor if isinstance(anchor, dict) else None,
            },
        )
        assert r.status_code == 201 and r.json()["anchor"] is None


async def test_an_ai_run_cannot_read_or_write_private_places(
    env, tmp_path, monkeypatch
):
    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id_rsa").write_text("PRIVATE")
    monkeypatch.setenv("HOME", str(home))
    cv = (
        await c.post(
            "/canvases",
            json={"owner_kind": "ticket", "owner_id": tid, "title": "By a person"},
        )
    ).json()
    bid = cv["doc"]["boards"][0]["id"]
    work = home / "project" / "frame"
    (work / ".git").mkdir(parents=True)
    (work / "node_modules").mkdir()
    (work / "index.html").write_text("<h1>AI</h1>")
    (work / ".env").write_text("TOKEN=1")
    (work / ".git" / "config").write_text("[core]")
    (work / "node_modules" / "x.js").write_text("1")
    (work / "credentials.json").write_text("{}")
    args = {"canvas_id": cv["id"], "board_id": bid}
    tokens = guard.enter(ctx)
    try:
        # the home folder, and a dot-folder in it, are too wide or private for frames
        for bad in (home, home / ".ssh", home.parent, Path("/")):
            with pytest.raises(ValueError, match="too wide|private"):
                await docs_write(action="canvas_propose", path=str(bad), **args)
        # a folder that is fine: the pages go, the secrets and build folders do not
        out = await docs_write(action="canvas_propose", path=str(work), **args)
        assert set(out["skipped"]) == {
            ".env",
            ".git/config",
            "node_modules/x.js",
            "credentials.json",
        }
        # reading a frame to a folder that is not made yet is checked too
        with pytest.raises(ValueError, match="private"):
            await docs_read(
                action="canvas",
                canvas_id=cv["id"],
                board_id=bid,
                path=str(home / ".config" / "x"),
            )
        ok = await docs_read(
            action="canvas", canvas_id=cv["id"], board_id=bid, path=str(home / "out")
        )
        assert ok["board"]["path"] == str(home / "out")
    finally:
        guard.leave(tokens)
    # safe mode: an AI run writes no files, not even to a fine folder
    r = await c.patch(f"/projects/{pid}/ai/settings", json={"safe_mode": True})
    assert r.status_code == 200, r.text
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="Safe mode"):
            await docs_read(
                action="canvas",
                canvas_id=cv["id"],
                board_id=bid,
                path=str(home / "out2"),
            )
    finally:
        guard.leave(tokens)
    # a person (no run) may name any folder
    ok = await docs_read(
        action="canvas",
        canvas_id=cv["id"],
        board_id=bid,
        path=str(home / ".config" / "y"),
    )
    assert ok["board"]["path"].endswith("y")


async def test_docs_read_design_guide_gives_the_whole_guide():
    from kanban_mcp.operations import design_guide
    from services import canvas_design

    got = await design_guide()
    assert got["guide"] == canvas_design.GUIDE and got["craft"] == canvas_design.CRAFT
    # an agent outside Claude Code finds the exemplar boards on this machine
    assert {p.name for p in Path(got["examples"]).iterdir()} >= {
        "foundations.png",
        "states.png",
    }
