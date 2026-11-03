"""Rows the board makes on first use (a project's AI settings, the workspace settings, an account's quota row...).
Two requests can both find the row missing and both make it; the one that loses must neither fail (an
IntegrityError: a run that never starts) nor roll back (a rollback expires what its session had loaded, and reading
that afterwards is a 500: MissingGreenlet). database.insert_missing makes each of them with INSERT OR IGNORE."""

import pytest

from models import (
    AiAccountState,
    AiAssistSettings,
    AiConfigState,
    AiProjectKnowledge,
    AiProjectSettings,
    AiWorkspaceDefaults,
    DocsAiHealth,
    DocsAiSettings,
    Project,
    WorkspaceSettings,
)
from services import workspace
from services.ai import config_service, knowledge, quota, safety, store
from services.ai.assist import settings as assist
from services.docs_ai import health as docs_health
from services.docs_ai import settings as docs_ai_settings
from tests.test_ai import _project, env  # noqa: F401

# (the function that makes the row on first use, its model, the row's key given the project id, a column the other
# request sets to a value that is not the default, so the test can tell whose row it got)
CASES = [
    (
        lambda s, pid: store.get_settings(s, pid),
        AiProjectSettings,
        lambda pid: pid,
        ("max_chain_depth", 7),
    ),
    (
        lambda s, pid: workspace.get_workspace_settings(s),
        WorkspaceSettings,
        lambda pid: 1,
        ("default_retention_days", 99),
    ),
    (lambda s, pid: assist.get(s), AiAssistSettings, lambda pid: 1, None),
    (
        lambda s, pid: quota.state(s, "acct-1"),
        AiAccountState,
        lambda pid: "acct-1",
        None,
    ),
    (
        lambda s, pid: config_service.get_state(s, "m-1"),
        AiConfigState,
        lambda pid: "m-1",
        ("version", 7),
    ),
    (
        lambda s, pid: knowledge.get(s, pid),
        AiProjectKnowledge,
        lambda pid: pid,
        ("instructions", "theirs"),
    ),
    (
        lambda s, pid: safety.workspace_defaults(s),
        AiWorkspaceDefaults,
        lambda pid: 1,
        None,
    ),
    (
        lambda s, pid: docs_ai_settings.get(s, pid),
        DocsAiSettings,
        lambda pid: pid,
        None,
    ),
    (lambda s, pid: docs_health.row_of(s, pid), DocsAiHealth, lambda pid: pid, None),
]
IDS = [c[1].__name__ for c in CASES]


def _key_name(model) -> str:
    return model.__table__.primary_key.columns.keys()[0]


async def _forget(maker, model, key) -> None:
    """As before the first use: no row yet."""
    async with maker() as s:
        row = await s.get(model, key)
        if row is not None:
            await s.delete(row)
            await s.commit()


@pytest.mark.parametrize(("make", "model", "key_of", "theirs"), CASES, ids=IDS)
async def test_a_lost_race_on_first_use_neither_fails_nor_expires_the_session(
    env,  # noqa: F811
    make,
    model,
    key_of,
    theirs,
):
    pid, _ = await _project(env["c"])
    maker = env["maker"]
    key = key_of(pid)
    await _forget(maker, model, key)

    async with maker() as a:
        project = await a.get(Project, pid)
        real_get = a.get
        raced = []

        async def get_then_lose_the_race(m, k, **kw):
            found = await real_get(m, k, **kw)
            if m is model and found is None and not raced:
                # another request makes the row between this one's read and its insert
                raced.append(True)
                async with maker() as b:
                    values = {_key_name(model): key}
                    if theirs:
                        values[theirs[0]] = theirs[1]
                    b.add(model(**values))
                    await b.commit()
            return found

        a.get = get_then_lose_the_race
        row = await make(a, pid)
        assert raced, "the function did not look the row up with session.get"
        assert getattr(row, _key_name(model)) == key
        if theirs:  # the row the other request wrote
            assert getattr(row, theirs[0]) == theirs[1]
        # what this session loaded before is still readable (a rollback would have expired it)
        assert project.name == "Kanban Board"


@pytest.mark.parametrize(("make", "model", "key_of", "theirs"), CASES, ids=IDS)
async def test_a_row_made_on_first_use_has_the_model_defaults(
    env,  # noqa: F811
    make,
    model,
    key_of,
    theirs,
):
    pid, _ = await _project(env["c"])
    key = key_of(pid)
    await _forget(env["maker"], model, key)
    async with env["maker"]() as s:
        made = await make(s, pid)
        expected = model(**{_key_name(model): key})
        got, want = made.model_dump(), expected.model_dump()
        # a default the function sets itself on purpose (the workspace's root folder, Docs AI on for an old project)
        for name in ("root_path", "enabled"):
            if name in got and got[name] != want.get(name):
                want[name] = got[name]
        # timestamps default to "now": a few milliseconds apart
        for name in [n for n in got if n.endswith("_at") and got[n] and want.get(n)]:
            got.pop(name), want.pop(name)
        assert got == want
