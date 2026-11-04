"""AI-1: Docs AI is off by default for a new project; a project made before keeps its value (or "on" if it never
stored one)."""

import database
from models import DocsAiSettings
from services.docs_ai import DocsAiError
from services.docs_ai import settings as svc_settings
from tests.docs_ai_helpers import env  # noqa: F401
from tests.ai_helpers import _project


async def test_a_new_project_has_docs_ai_off_until_an_admin_turns_it_on(env):
    c = env["c"]
    pid, _ = await _project(c)
    d = (await c.get(f"/projects/{pid}/docs/ai")).json()
    assert d["enabled"] is False and d["state"] == "off"
    async with database.async_session() as s:
        try:
            await svc_settings.require_enabled(s, pid)
            raise AssertionError("expected docs_ai_off")
        except DocsAiError as exc:
            assert exc.code == "docs_ai_off"
    r = await c.patch(f"/projects/{pid}/docs/ai", json={"enabled": True})
    assert r.status_code == 200 and r.json()["enabled"] is True


async def test_an_older_project_without_a_row_keeps_docs_ai_on(env):
    c = env["c"]
    pid, _ = await _project(c)
    # a project made before AI-1 never stored a row: drop the one creation wrote
    async with database.async_session() as s:
        await s.delete(await s.get(DocsAiSettings, pid))
        await s.commit()
    d = (await c.get(f"/projects/{pid}/docs/ai")).json()
    assert d["enabled"] is True


async def test_an_older_project_keeps_its_stored_value(env):
    c = env["c"]
    pid, _ = await _project(c)
    async with database.async_session() as s:
        row = await s.get(DocsAiSettings, pid)
        row.enabled = True
        s.add(row)
        await s.commit()
    assert (await c.get(f"/projects/{pid}/docs/ai")).json()["enabled"] is True
