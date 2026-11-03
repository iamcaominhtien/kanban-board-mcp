"""A project's AI settings row is made on first use (services/ai/store.get_settings). Two first requests can race to
make it; the one that loses must keep what its session already loaded (a rollback would expire it, and reading it
afterwards is a 500: MissingGreenlet)."""

from models import AiProjectSettings, Project
from services.ai import store
from tests.test_ai import _project, env  # noqa: F401


async def _forget_settings(session, project_id: str) -> None:
    """As before the project's first AI request: no settings row yet."""
    row = await session.get(AiProjectSettings, project_id)
    if row is not None:
        await session.delete(row)
        await session.commit()


async def test_a_lost_race_to_make_the_settings_keeps_what_the_session_loaded(
    env,  # noqa: F811
):
    pid, _ = await _project(env["c"])
    maker = env["maker"]
    async with maker() as s:
        await _forget_settings(s, pid)

    async with maker() as a:
        project = await a.get(Project, pid)
        real_get = a.get

        async def get_then_lose_the_race(model, key, **kw):
            found = await real_get(model, key, **kw)
            if model is AiProjectSettings and found is None:
                # another request makes the row between this one's read and its insert
                async with maker() as b:
                    b.add(AiProjectSettings(project_id=key, max_chain_depth=7))
                    await b.commit()
            return found

        a.get = get_then_lose_the_race
        settings = await store.get_settings(a, pid)
        # the row the other request wrote, and the project this session loaded first is still readable
        assert settings.max_chain_depth == 7
        assert project.name == "Kanban Board"


async def test_settings_made_on_first_use_have_the_model_defaults(env):  # noqa: F811
    pid, _ = await _project(env["c"])
    async with env["maker"]() as s:
        await _forget_settings(s, pid)
    async with env["maker"]() as s:
        made = await store.get_settings(s, pid)
        expected = AiProjectSettings(project_id=pid)
        assert made.model_dump() == expected.model_dump()
