"""Shared fixtures for the Docs AI tests: a project with an AI member that answers through a fake model, Docs AI
switched on, and published pages. Import `env`, `fake` and the helpers; see test_docs_ai_foundation.py."""

import pytest

from services.ai import llm
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401
from tests.test_ai_assist import FakeLLM

H = {"X-Actor": "An Nguyen"}

__all__ = ["H", "env", "fake", "setup", "page", "_ticket"]


@pytest.fixture
def fake(monkeypatch):
    """A fake model: `fake.queue` holds the next answers (text, callable(prompt) or an exception);
    `fake.prompts` records what was sent."""
    f = FakeLLM()
    monkeypatch.setattr(llm, "complete", f)
    return f


async def setup(env, *, enabled=True, name="Reviewer"):
    """A project with an admin human (An Nguyen) and an AI member that answers. Returns (client, project_id, member)."""
    c = env["c"]
    pid, _an = await _project(c)
    member = await _runner(c, pid, env["repo"], name=name)
    if enabled:
        r = await c.patch(
            f"/projects/{pid}/docs/ai", json={"enabled": True, "member_id": member["id"]}
        )
        assert r.status_code == 200, r.text
    return c, pid, member


async def page(c, pid, title, markdown, *, parent_id=None):
    """Create and publish a page; returns its JSON."""
    r = await c.post(f"/projects/{pid}/docs/pages", json={"title": title, "parent_id": parent_id}, headers=H)
    assert r.status_code == 201, r.text
    p = r.json()
    await c.put(f"/docs/pages/{p['id']}/draft", json={"markdown": markdown}, headers=H)
    cur = (await c.get(f"/docs/pages/{p['id']}", headers=H)).json()
    r = await c.post(
        f"/docs/pages/{p['id']}/publish", json={"base_version": cur["version"]}, headers=H
    )
    assert r.status_code == 200, r.text
    return (await c.get(f"/docs/pages/{p['id']}", headers=H)).json()
