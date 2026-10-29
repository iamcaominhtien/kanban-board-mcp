# ruff: noqa: F811  (pytest fixtures imported from test_docs are redefined as arguments)
import base64
import json
import os
import shutil
import sys
import textwrap

import pytest

from services import diagram_export as ex
from tests.test_diagram_mcp import _call, drawio
from tests.test_docs import c, pid, setup_db, test_async_session  # noqa: F401,F811
from kanban_mcp import common

EXACT = '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><text>drawn by the editor</text></svg>'


@pytest.fixture(autouse=True)
def _mcp_db(monkeypatch):
    monkeypatch.setattr(common, "async_session", test_async_session)


# --- small pieces ----------------------------------------------------------------------------


def test_switches(monkeypatch):
    monkeypatch.delenv(ex.SWITCH_ENV, raising=False)
    assert ex.enabled("self-hosted") and not ex.enabled("public")
    monkeypatch.setenv(ex.SWITCH_ENV, "off")
    assert not ex.enabled("self-hosted") and not ex.enabled("public")
    monkeypatch.setenv(ex.SWITCH_ENV, "public")
    assert ex.enabled("public")


def test_decodes_the_editor_answer():
    assert (
        ex._decode(
            "data:image/svg+xml;base64," + base64.b64encode(EXACT.encode()).decode()
        )
        == EXACT
    )
    assert ex._decode("data:image/svg+xml," + "%3Csvg%2F%3E") == "<svg/>"


def test_only_the_editors_origin_may_load():
    editor = "http://localhost:8080"
    assert ex._same_origin("http://localhost:8080/js/app.js", editor)
    assert ex._same_origin("data:image/png;base64,AA", editor)
    for other in (
        "https://clear.diagrams.net/",
        "http://localhost:9090/",
        "http://localhost.evil.com/",
    ):
        assert not ex._same_origin(other, editor)


def test_export_command_is_a_json_list_of_strings(monkeypatch):
    monkeypatch.setenv(ex.EXPORT_CMD_ENV, '["/opt/Kanban Board"]')
    assert ex._command() == ["/opt/Kanban Board"]
    for bad in ("", "not json", '"a string"', "[]", "[1, 2]", '{"a": 1}'):
        monkeypatch.setenv(ex.EXPORT_CMD_ENV, bad)
        assert ex._command() is None, bad


def test_chrome_path_can_be_given(monkeypatch, tmp_path):
    fake = tmp_path / "chrome"
    fake.write_text("")
    monkeypatch.setenv(ex.CHROME_ENV, str(fake))
    assert ex.find_chrome() == str(fake)
    monkeypatch.setenv(ex.CHROME_ENV, str(tmp_path / "missing"))
    assert ex.find_chrome() is None


# --- the desktop command contract -------------------------------------------------------------


def _fake_app(tmp_path, body: str) -> list[str]:
    script = tmp_path / "fake_app.py"
    script.write_text(textwrap.dedent(body))
    return [sys.executable, str(script)]


async def test_runs_the_desktop_command_and_reads_its_svg(monkeypatch, tmp_path):
    cmd = _fake_app(
        tmp_path,
        f"""
        import sys
        a = sys.argv
        assert a[1] == "--export-svg" and a[4] == "--editor-url" and a[5] == "http://editor:8080", a
        assert "<mxfile" in open(a[2]).read()
        open(a[3], "w").write({EXACT!r})
        """,
    )
    monkeypatch.setenv(ex.EXPORT_CMD_ENV, json.dumps(cmd))
    assert await ex.export_svg(drawio("A"), "http://editor:8080/") == EXACT


async def test_a_failing_command_falls_back_quietly(monkeypatch, tmp_path):
    monkeypatch.setenv(
        ex.EXPORT_CMD_ENV, json.dumps(_fake_app(tmp_path, "import sys; sys.exit(3)"))
    )
    assert await ex.export_svg(drawio("A"), "http://editor:8080") is None
    monkeypatch.setenv(ex.EXPORT_CMD_ENV, json.dumps(["/no/such/program"]))
    assert await ex.export_svg(drawio("A"), "http://editor:8080") is None


async def test_without_a_command_or_browser_nothing_is_exported(monkeypatch):
    monkeypatch.delenv(ex.EXPORT_CMD_ENV, raising=False)
    monkeypatch.setenv(ex.CHROME_ENV, "/no/such/chrome")
    assert await ex.export_svg(drawio("A"), "http://editor:8080") is None


# --- what the agent is told and what is stored ------------------------------------------------


async def _create(pid, tmp_path, **extra):
    f = tmp_path / "a.drawio"
    f.write_text(drawio("A", "B"), encoding="utf-8")
    return await _call(
        "docs_write",
        action="diagram_create",
        project_id=pid,
        title="Flow",
        path=str(f),
        **extra,
    )


async def test_the_editors_picture_is_stored_and_reported(
    c, pid, tmp_path, monkeypatch
):
    monkeypatch.delenv(ex.SWITCH_ENV, raising=False)
    seen = {}

    async def fake(source, editor_url, **_):
        seen["editor"] = editor_url
        return EXACT

    monkeypatch.setattr(ex, "export_svg", fake)
    made = await _create(pid, tmp_path)
    assert (
        made["preview"].startswith("exact")
        and seen["editor"] == "http://localhost:8080"
    )
    assert "drawn by the editor" in (await c.get(f"/diagrams/{made['id']}/svg")).text
    assert (await c.get(f"/diagrams/{made['id']}")).json()["preview_kind"] == "editor"


async def test_falls_back_to_the_plain_picture_and_says_so(
    c, pid, tmp_path, monkeypatch
):
    monkeypatch.delenv(ex.SWITCH_ENV, raising=False)

    async def nothing(source, editor_url, **_):
        return None

    monkeypatch.setattr(ex, "export_svg", nothing)
    made = await _create(pid, tmp_path)
    assert made["preview"].startswith("plain")
    assert (await c.get(f"/diagrams/{made['id']}")).json()["preview_kind"] == "basic"


async def test_the_agents_own_svg_wins_and_no_browser_is_started(
    c, pid, tmp_path, monkeypatch
):
    monkeypatch.delenv(ex.SWITCH_ENV, raising=False)

    async def boom(*a, **k):
        raise AssertionError("the export must not run when the agent gave an SVG")

    monkeypatch.setattr(ex, "export_svg", boom)
    svg = tmp_path / "a.svg"
    svg.write_text(EXACT, encoding="utf-8")
    made = await _create(pid, tmp_path, svg_path=str(svg))
    assert made["preview"] == "your SVG"
    assert (await c.get(f"/diagrams/{made['id']}")).json()["preview_kind"] == "agent"


async def test_the_public_editor_never_gets_a_drawing_unasked(
    c, pid, tmp_path, monkeypatch
):
    monkeypatch.delenv(ex.SWITCH_ENV, raising=False)
    called = []

    async def spy(source, editor_url, **_):
        called.append(editor_url)
        return EXACT

    monkeypatch.setattr(ex, "export_svg", spy)
    await c.put("/diagrams/settings", json={"mode": "public"})
    assert (await _create(pid, tmp_path))["preview"].startswith(
        "plain"
    ) and called == []
    monkeypatch.setenv(ex.SWITCH_ENV, "public")  # the admin opted in
    assert (await _create(pid, tmp_path))["preview"].startswith("exact")
    assert called == ["https://embed.diagrams.net"]


async def test_saving_a_new_version_redraws_and_restoring_keeps_the_kind(
    c, pid, tmp_path, monkeypatch
):
    monkeypatch.delenv(ex.SWITCH_ENV, raising=False)
    monkeypatch.setattr(ex, "export_svg", lambda s, e, **_: _async(EXACT))
    made = await _create(pid, tmp_path)
    f = tmp_path / "a.drawio"
    f.write_text(drawio("A", "B", "C"), encoding="utf-8")
    saved = await _call(
        "docs_write",
        action="diagram_save",
        diagram_id=made["id"],
        path=str(f),
        base_version=1,
    )
    assert saved["version"] == 2 and saved["preview"].startswith("exact")
    await c.post(
        f"/diagrams/{made['id']}/restore"
    )  # unlink + restore must not touch the picture
    assert "drawn by the editor" in (await c.get(f"/diagrams/{made['id']}/svg")).text


async def _async(value):
    return value


# --- the real thing, when a draw.io editor and a browser are at hand ---------------------------


@pytest.mark.skipif(
    not (
        os.environ.get("KANBAN_TEST_DRAWIO_URL")
        and (os.environ.get(ex.CHROME_ENV) or shutil.which("chromium"))
    ),
    reason="needs KANBAN_TEST_DRAWIO_URL (a running draw.io webapp) and a Chrome/Chromium",
)
async def test_a_real_editor_draws_the_picture(monkeypatch):
    monkeypatch.delenv(ex.EXPORT_CMD_ENV, raising=False)
    monkeypatch.delenv(ex.SWITCH_ENV, raising=False)
    svg = await ex.export_svg(
        drawio("Client", "Gateway", "Service"), os.environ["KANBAN_TEST_DRAWIO_URL"]
    )
    assert svg and svg.lstrip().startswith("<svg") and "Gateway" in svg
