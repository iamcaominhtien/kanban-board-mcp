"""Issue #268: every AI works in Docs like a person. Edit a part of a page (with a check that it has not changed),
upload a file to a page and a ticket, the tickets a page links and the pages a ticket links, tickets from a page,
giving a page to an AI member, and the Docs guide in both places."""

import base64

import pytest

from kanban_mcp import common
from kanban_mcp.tools.docs import docs_read, docs_write
from services import docs_edit, docs_guide
from services.ai import board_skills
from tests.ai_helpers import _project, _runner, _ticket, env  # noqa: F401  (fixture)

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="
)

PAGE = """## Overview

The API is REST.

## Endpoints

| Method | Path |
|---|---|
| GET | /tickets |

### Errors

401 when the token is missing.

## Limits

Rate limits are not enforced yet.
"""


@pytest.fixture(autouse=True)
def _mcp(monkeypatch, tmp_path, env):  # noqa: F811
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(common, "async_session", env["maker"])


# ---------------------------------------------------------------------------
# The pure edits
# ---------------------------------------------------------------------------


def test_sections_follow_headings_and_skip_code():
    md = "## A\nx\n```\n## not a heading\n```\n### A1\ny\n## A\nz\n"
    got = [(s.level, s.text, s.slug) for s in docs_edit.sections(md)]
    assert got == [(2, "A", "a"), (3, "A1", "a1"), (2, "A", "a-2")]
    assert docs_edit.section_text(md, "A1") == "### A1\ny"
    with pytest.raises(docs_edit.EditError, match="2 headings.*a, a-2"):
        docs_edit.find_section(md, "A")
    assert docs_edit.section_text(md, "a-2") == "## A\nz"


def test_edit_section_modes():
    out = docs_edit.edit_section(PAGE, "Limits", "Rate limits are 100 per minute.")
    assert "## Limits\n\nRate limits are 100 per minute.\n" in out
    assert "not enforced" not in out and "## Overview\n\nThe API is REST." in out
    # replacing a section takes its sub-sections; a heading of its level renames it
    out = docs_edit.edit_section(PAGE, "endpoints", "## Routes\n\nSee the spec.")
    assert "## Endpoints" not in out and "### Errors" not in out
    assert "## Routes\n\nSee the spec.\n\n## Limits" in out
    out = docs_edit.edit_section(PAGE, "Endpoints", "| POST | /tickets |", "append")
    assert "401 when the token is missing.\n\n| POST | /tickets |\n\n## Limits" in out
    out = docs_edit.edit_section(PAGE, "Overview", "## Auth\n\nTokens.", "after")
    assert "The API is REST.\n\n## Auth\n\nTokens.\n\n## Endpoints" in out
    out = docs_edit.edit_section(PAGE, "Limits", "> [!WARNING]\n> Soon.", "prepend")
    assert "## Limits\n\n> [!WARNING]\n> Soon.\n\nRate limits" in out
    with pytest.raises(docs_edit.EditError, match="not on the page.*'Overview'"):
        docs_edit.edit_section(PAGE, "Billing", "x")


def test_edit_passage_needs_one_exact_match():
    out = docs_edit.edit_passage(PAGE, "not enforced yet", "enforced since v2")
    assert "Rate limits are enforced since v2." in out
    with pytest.raises(docs_edit.EditError, match="not on the page"):
        docs_edit.edit_passage(PAGE, "not  enforced", "x")
    with pytest.raises(docs_edit.EditError, match="2 times"):
        docs_edit.edit_passage(PAGE + "\nThe API is REST.\n", "The API is REST.", "x")
    assert docs_edit.append_page("## A\nx\n", "## B\ny") == "## A\nx\n\n## B\ny\n"


def test_a_section_edit_from_an_old_version_goes_on_only_if_that_section_is_unchanged():
    now = PAGE.replace("The API is REST.", "The API is REST and MCP.")
    # someone changed Overview: an edit of Limits made from the old text still applies
    out = docs_edit.apply(now, {"section": "Limits", "markdown": "100/min."}, PAGE)
    assert "REST and MCP" in out and "100/min." in out
    # but an edit of Overview made from the old text is refused, with the text as it is now
    with pytest.raises(docs_edit.EditError, match=r"(?s)conflict.*REST and MCP"):
        docs_edit.apply(now, {"section": "Overview", "markdown": "x"}, PAGE)


# ---------------------------------------------------------------------------
# Through MCP
# ---------------------------------------------------------------------------


async def _page(pid, title="API", markdown=PAGE):
    return await docs_write(
        action="create", project_id=pid, title=title, markdown=markdown
    )


async def test_edit_one_section_keeps_what_another_person_changed(env):
    pid, _ = await _project(env["c"])
    page = await _page(pid)
    # a person publishes a change to Overview after the agent read v1
    await docs_write(
        action="update",
        page_id=page["id"],
        markdown=PAGE.replace("The API is REST.", "The API is REST and MCP."),
        base_version=1,
    )
    out = await docs_write(
        action="edit",
        page_id=page["id"],
        section="Limits",
        markdown="Rate limits: 100 requests per minute per token.",
        base_version=1,
    )
    assert out["version"] == 3 and out["changed"] == ["section 'Limits'"]
    assert out["now"].startswith("## Limits\n\nRate limits: 100")
    text = (await docs_read(action="get", page_id=page["id"]))["markdown"]
    assert "REST and MCP" in text and "100 requests" in text
    assert (await docs_read(action="versions", page_id=page["id"]))[0][
        "note"
    ] == "Edited section 'Limits'"
    # the same section changed since v1: refused, nothing published
    with pytest.raises(
        ValueError, match=r"(?s)conflict.*REST and MCP.*Nothing was changed"
    ):
        await docs_write(
            action="edit",
            page_id=page["id"],
            section="Overview",
            markdown="x",
            base_version=1,
        )
    part = await docs_read(action="get", page_id=page["id"], section="Endpoints")
    assert (
        part["markdown"].startswith("## Endpoints") and "### Errors" in part["markdown"]
    )
    assert part["version"] == 3 and "referenced_by" not in part


async def test_edit_a_passage_and_several_edits_in_one_version(env):
    pid, _ = await _project(env["c"])
    page = await _page(pid)
    out = await docs_write(
        action="edit",
        page_id=page["id"],
        find="not enforced yet",
        markdown="==enforced since v2==",
    )
    assert out["version"] == 2
    with pytest.raises(ValueError, match="not on the page"):
        await docs_write(
            action="edit", page_id=page["id"], find="not enforced yet", markdown="x"
        )
    out = await docs_write(
        action="edit",
        page_id=page["id"],
        items=[
            {"section": "Overview", "markdown": "REST and MCP."},
            {
                "find": "| GET | /tickets |",
                "markdown": "\n| POST | /tickets |",
                "mode": "after",
            },
            {"markdown": "## Changelog\n\n- v2", "mode": "append"},
        ],
    )
    assert out["version"] == 3 and len(out["changed"]) == 3
    text = (await docs_read(action="get", page_id=page["id"]))["markdown"]
    assert "| GET | /tickets |\n| POST | /tickets |" in text
    assert text.rstrip().endswith("## Changelog\n\n- v2")
    # one bad edit: nothing is published
    with pytest.raises(ValueError, match=r"items\[1\]"):
        await docs_write(
            action="edit",
            page_id=page["id"],
            items=[
                {"section": "Overview", "markdown": "y"},
                {"find": "nope", "markdown": "z"},
            ],
        )
    assert (await docs_read(action="get", page_id=page["id"]))["version"] == 3
    with pytest.raises(ValueError, match="does not use: title"):
        await docs_write(
            action="edit",
            page_id=page["id"],
            section="Overview",
            markdown="x",
            title="T",
        )


async def test_upload_a_picture_to_a_page_and_a_file_to_a_ticket(env, tmp_path):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Login")
    page = await _page(pid)
    shot = tmp_path / "login.png"
    shot.write_bytes(PNG)
    out = await docs_write(
        action="upload", path=str(shot), page_id=page["id"], section="Overview"
    )
    assert out["markdown"].startswith("![login.png](/uploads/login-")
    assert out["type"] == "image/png" and out["page"]["version"] == 2
    stored = tmp_path / "uploads" / out["url"].removeprefix("/uploads/")
    assert stored.read_bytes() == PNG
    text = (await docs_read(action="get", page_id=page["id"]))["markdown"]
    assert f"The API is REST.\n\n{out['markdown']}\n\n## Endpoints" in text
    # bytes from an agent whose files are elsewhere, posted on a ticket
    log = await docs_write(
        action="upload",
        data=base64.b64encode(b"boom").decode(),
        name="trace.log",
        ticket_id=tid,
        body="The failing request",
        author="Claude",
    )
    assert log["markdown"].startswith("[trace.log](/uploads/trace-")
    ticket = (await c.get(f"/tickets/{tid}")).json()
    assert ticket["comments"][-1]["text"] == f"The failing request\n\n{log['markdown']}"
    assert ticket["comments"][-1]["author"] == "Claude"
    # after a passage: its own paragraph
    out = await docs_write(
        action="upload",
        data=base64.b64encode(PNG).decode(),
        name="limits.png",
        page_id=page["id"],
        find="Rate limits are not enforced yet.",
    )
    text = (await docs_read(action="get", page_id=page["id"]))["markdown"]
    assert f"not enforced yet.\n\n{out['markdown']}" in text
    with pytest.raises(ValueError, match="never stored"):
        await docs_write(action="upload", data="eA==", name=".env.json")
    with pytest.raises(ValueError, match="not a type"):
        await docs_write(action="upload", data="eA==", name="tool.exe")
    with pytest.raises(ValueError, match="not valid base64"):
        await docs_write(action="upload", data="%%%", name="a.png")
    with pytest.raises(ValueError, match="give page_id"):
        await docs_write(action="upload", data="eA==", name="a.txt", section="Overview")


async def test_a_page_and_a_ticket_see_each_other(env):
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Rate limiting")
    spec = await _page(pid, "Rate limits spec", f"## Scope\n\nWhat {tid} must do.\n")
    from kanban_mcp.operations.tickets import get_ticket

    ticket = await get_ticket(tid)
    assert [(d["page_id"], d["why"]) for d in ticket["docs"]] == [
        (spec["id"], ["the page mentions this ticket"])
    ]
    page = await docs_read(action="get", page_id=spec["id"])
    assert page["work"]["tickets"][0]["id"] == tid
    assert page["work"]["tickets"][0]["run"] is None and page["work"]["active"] == 0


async def test_tickets_from_a_checklist_on_the_page(env):
    c = env["c"]
    pid, _ = await _project(c)
    page = await _page(
        pid,
        "Meeting notes",
        "## Actions\n\n- [ ] Hoa to write the CSV export spec, due Friday\n- [x] Drop v1\n- [ ] Tuan to check logs\n",
    )
    out = await docs_write(action="tickets", page_id=page["id"])
    titles = [t["title"] for t in out["tickets"]]
    assert titles == ["Hoa to write the CSV export spec", "Tuan to check logs"]
    keys = [t["id"] for t in out["tickets"]]
    text = (await docs_read(action="get", page_id=page["id"]))["markdown"]
    assert f"- [ ] Hoa to write the CSV export spec, due Friday {keys[0]}" in text
    assert f"- [ ] Tuan to check logs {keys[1]}" in text
    assert out["skipped"][0]["reason"] == "ticked"
    ticket = (await c.get(f"/tickets/{keys[0]}")).json()
    assert "[[Meeting notes]]" in ticket["description"]
    again = await docs_write(action="tickets", page_id=page["id"])
    assert again["tickets"] == [] and "No unchecked" in again["message"]


async def test_give_a_page_to_an_ai_member(env):
    c = env["c"]
    pid, _ = await _project(c)
    member = await _runner(c, pid, env["repo"], name="BA")
    page = await _page(pid, "Login spec", "## Goal\n\nSign in with email.\n")
    out = await docs_write(
        action="assign",
        page_id=page["id"],
        member_id=member["id"],
        kind="review",
        body="Check the error cases",
    )
    key = out["ticket"]["id"]
    assert out["ticket"]["title"] == "Review the page “Login spec”"
    assert out["run"] and out["run"]["id"]  # assigning the team started its lead
    ticket = (await c.get(f"/tickets/{key}")).json()
    assert ticket["assignee"] == member["id"]
    assert "Review [[Login spec]]." in ticket["description"]
    assert "> Check the error cases" in ticket["description"]
    work = (await docs_read(action="get", page_id=page["id"]))["work"]
    row = work["tickets"][0]
    assert row["id"] == key and row["run"]["member"] == "BA"
    with pytest.raises(ValueError, match="kind"):
        await docs_write(action="assign", page_id=page["id"], member_id=member["id"])


async def test_the_docs_guide_is_one_text_in_both_places():
    out = await docs_read(action="docs_guide")
    assert out["guide"] == docs_guide.GUIDE
    skills = board_skills._skills()
    assert skills["docs-pages"] == docs_guide.SKILL_HEADER + docs_guide.GUIDE
    assert "docs-pages" in [s["name"] for s in board_skills.catalog()]
    # the guide names the Markdown the editor keeps
    for form in (
        "==",
        "> [!WARNING]",
        "- [ ]",
        "[[Page#Section]]",
        "action='edit'",
        "action='upload'",
    ):
        assert form in docs_guide.GUIDE


async def test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page(env):
    c = env["c"]
    pid, _ = await _project(c)
    member = await _runner(c, pid, env["repo"], name="Writer")
    page = await _page(pid, "Export spec", "## Goal\n\nCSV export.\n")
    r = await c.post(
        f"/docs/pages/{page['id']}/assign",
        json={
            "member_id": member["id"],
            "kind": "write",
            "instruction": "Add the columns",
        },
    )
    assert r.status_code == 201, r.text
    key = r.json()["ticket"]["id"]
    work = (await c.get(f"/docs/pages/{page['id']}/work")).json()
    assert work["tickets"][0]["id"] == key
    assert work["tickets"][0]["run"]["member"] == "Writer"
    bad = await c.post(
        f"/docs/pages/{page['id']}/assign", json={"member_id": "nope", "kind": "write"}
    )
    assert bad.status_code == 422


def test_a_quote_of_highlighted_text_is_found_and_headings_drop_the_marks():
    from services import docs_anchors
    from services.docs_text import heading_anchors

    md = "## The ==key== rule\n\nA person signs in. ==Five failed attempts lock the account.==\n"
    hit = docs_anchors.find_anchor(
        docs_anchors.blocks_of(md), "Five failed attempts lock the account."
    )
    assert hit is not None and hit.exact
    assert heading_anchors(md)[0]["text"] == "The key rule"


def test_every_run_is_told_to_open_the_docs_guide_before_writing_a_page():
    """A live BA run (sonnet) wrote a good spec at the top of the tree: its prompt never named the Docs guide."""
    import json as _json

    from models import AiTeam, AiProjectSettings
    from services import role_skills
    from tests.test_shared_skills_277 import _block

    block = _block(AiTeam(id="m1", provider="claude-code"), AiProjectSettings())
    assert (
        "Before you create or change a Docs page, open `kanban-board:docs-pages`"
        in block
    )
    other = _block(AiTeam(id="m2", provider="gemini"), AiProjectSettings())
    assert "docs_read(action='docs_guide')" in other
    # switched off for the project: not named
    off = AiProjectSettings(
        ops=_json.dumps({"board_skills": [{"skill": "docs-pages", "on": False}]})
    )
    assert "docs-pages" not in _block(AiTeam(id="m3", provider="claude-code"), off)
    ba = role_skills.guide("ba")
    assert "under the page it\nbelongs to" in ba and "`docs-pages` skill" in ba


async def test_an_import_by_an_agent_is_published_and_a_draft_is_never_dropped_by_an_edit(
    env, tmp_path
):
    """RES-1 (2026-11-05): an import left the page as a draft, the agent's next edit published the empty page with one
    line and the imported text was lost. An import is published by default now, and an edit refuses while the caller
    still has an unpublished draft of the page."""
    from services import activity

    c = env["c"]
    pid, _ = await _project(c)
    await _runner(
        c, pid, env["repo"], name="Research team"
    )  # the agent is a member of the project
    note = tmp_path / "RES-1-research.md"
    note.write_text(
        "# Research\n\n## Parsing\n\nTree-sitter for every language.\n\n## Storage\n\nSQLite and FTS5.\n"
    )
    token = activity.set_actor("Research team")
    try:
        out = await docs_write(action="import", project_id=pid, path=str(note))
        assert out["published"] is True and out["created"]
        page_id = out["created"][0]["page_id"]
        page = await docs_read(action="get", page_id=page_id)
        assert page["version"] == 1 and "## Storage" in page["markdown"]
        edited = await docs_write(
            action="edit",
            page_id=page_id,
            find="SQLite and FTS5.",
            markdown="SQLite and FTS5, one file.",
            mode="replace",
        )
        assert edited["version"] == 2

        # publish=false keeps the old behaviour on request, says so, and an edit then refuses instead of losing it
        drafted = await docs_write(
            action="import", project_id=pid, path=str(note), publish=False
        )
        assert drafted["published"] is False and "drafts" in drafted["note"]
        draft_id = drafted["created"][0]["page_id"]
        with pytest.raises(ValueError, match="unpublished draft"):
            await docs_write(
                action="edit",
                page_id=draft_id,
                find="the end",
                markdown="One more line.",
            )
        empty = await docs_read(action="get", page_id=draft_id)
        assert empty["markdown"].strip() == ""
    finally:
        activity.reset_actor(token)
