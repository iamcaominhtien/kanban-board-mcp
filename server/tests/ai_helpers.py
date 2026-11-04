"""Shared fixtures and helpers of the AI tests: a server on a fresh database with the scheduler running (`env`), a project,
a member on the fake CLI, a ticket, and waiting for a run state."""

import asyncio
import os
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from database import get_session
from main import app
from models import AiRun
from services.ai import api_agent, guard, runs
from tests.fast_db import fresh_db_file

FAKE = str(Path(__file__).parent / "fixtures" / "fake_claude.py")


@pytest.fixture
async def env(tmp_path, monkeypatch):
    engine = create_async_engine(fresh_db_file(tmp_path / "ai.db"))
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", maker)

    async def override():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_session] = override
    monkeypatch.setenv("KANBAN_AI_KEY_FILE", str(tmp_path / "ai.key"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setattr(runs, "RT", runs._Runtime())
    monkeypatch.setattr(api_agent, "BACKOFF_SCALE", 0.0)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    await runs.start_scheduler()
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield {"c": c, "repo": str(repo), "tmp": tmp_path, "maker": maker}
    await runs.stop_scheduler()
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


async def _project(c):
    p = (
        await c.post(
            "/projects",
            json={"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"},
        )
    ).json()
    an = (
        await c.post(f"/projects/{p['id']}/members", json={"name": "An Nguyen"})
    ).json()
    return p["id"], an["id"]


async def _runner(c, pid, repo, name="Claude Code · Backend", **extra):
    body = {
        "name": name,
        "provider": "claude-code",
        "working_dir": repo,
        "cli_path": FAKE,
        "model": "haiku",
        **extra,
    }
    r = await c.post(f"/projects/{pid}/ai/members", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def _ticket(c, pid, title="Fix add()", status="todo", **extra):
    r = await c.post(
        f"/projects/{pid}/tickets", json={"title": title, "status": status, **extra}
    )
    return r.json()["id"]


async def _wait(c, ticket_id, states, timeout=15.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        runs_ = (await c.get(f"/tickets/{ticket_id}/ai/runs")).json()
        if runs_ and runs_[0]["state"] in states:
            return runs_[0]
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(
                f"run never reached {states}: {runs_[0]['state'] if runs_ else None}"
            )
        runs.RT.wake.set()
        await asyncio.sleep(0.1)


def _ask_gate(env, monkeypatch) -> None:
    """In wait_question mode the fake CLI waits until the test has asked its question, not a fixed time."""
    gate = env["tmp"] / "asked"
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "wait_question")
    monkeypatch.setenv("FAKE_CLAUDE_GATE", str(gate))
    original = runs.record_question

    async def record(*args, **kwargs):
        out = await original(*args, **kwargs)
        gate.touch()
        return out

    monkeypatch.setattr(runs, "record_question", record)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split()[2]
        return state != "Z"
    except OSError:
        return True


async def _ctx(env, *, ceiling="review", template="developer", mode="work"):
    c = env["c"]
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"], ceiling=ceiling, template=template)
    tid = await _ticket(c, pid)
    await c.patch(f"/tickets/{tid}", json={"assignee": m["id"]})
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=m["id"],
            state="running",
            started_by="An Nguyen",
            mode=mode,
            token_hash=guard.token_hash("kbr_test"),
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
    ctx = await guard.context_for_token("kbr_test")
    return ctx, pid, an, m, tid


class FakeChat:
    """Scripted model: each call returns the next reply."""

    def __init__(self, script):
        self.script = list(script)
        self.results = []

    def start(self, system, user, tools):
        self.system, self.user, self.tools = system, user, tools

    async def call(self, max_tokens):
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    def add_results(self, results):
        self.results.extend(results)

    def add_user(self, text):
        pass


async def _api_member(c, pid, **extra):
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "Reviewer (Claude API)",
            "provider": "anthropic",
            "api_key": "sk-ant\x2dapi03-zzzzzzzzzzzz3f9a",
            "model": "claude-haiku-5-5",
            "daily_budget": 5,
            **extra,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()
