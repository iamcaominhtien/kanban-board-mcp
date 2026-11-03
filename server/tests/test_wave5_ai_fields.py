"""Wave 5 of the design audit, the AI side: fields added for the UI, and messages that named a key where a person
reads a name (NT-1, TP-8, AT-4, ACC-5, NT-5, WV-7)."""

import asyncio
import stat

from models import AiKnowledgeDoc
from services import notifications as centre
from services.ai import accounts, safety, workflow
from tests.test_ai import _project, _runner, env  # noqa: F401


async def _page(c, **params):
    r = await c.get("/notifications", params={"view": "page", **params})
    assert r.status_code == 200, r.text
    return r.json()["items"]


# --- NT-1: Pause all AI names the person -------------------------------------------------------------------------


async def test_pause_all_by_the_board_user_names_the_owner_and_keeps_the_key(env):
    c = env["c"]
    pid, _an = await _project(c)
    # the project's first admin is its owner, the board's own user ("user") too
    await c.post(f"/projects/{pid}/members", json={"name": "Hoa Mai", "role": "admin"})
    assert (await c.post(f"/projects/{pid}/ai/pause-all", json={})).status_code == 200
    [row] = [r for r in await _page(c) if r["kind"] == "auto_trip"]
    assert row["body"].startswith("Hoa Mai paused all AI.")
    assert row["data"]["paused_by"] == "user"
    assert row["data"]["paused_by_name"] == "Hoa Mai"
    # the banner still compares with the key it always had
    board = (await c.get(f"/projects/{pid}/ai/board")).json()["settings"]
    assert board["paused_by"] == "user"


async def test_pause_all_by_a_named_person_writes_that_name(env):
    c = env["c"]
    pid, _an = await _project(c)
    r = await c.post(
        f"/projects/{pid}/ai/pause-all", json={}, headers={"X-Actor": "An Nguyen"}
    )
    assert r.status_code == 200
    [row] = [r for r in await _page(c) if r["kind"] == "auto_trip"]
    assert row["body"].startswith("An Nguyen paused all AI.")
    assert row["data"]["paused_by"] == "An Nguyen"


async def test_person_name_falls_back_to_the_key_without_an_admin(env):
    c = env["c"]
    p = (
        await c.post(
            "/projects", json={"name": "Solo", "prefix": "SOL", "color": "#123456"}
        )
    ).json()
    async with env["maker"]() as s:
        assert await safety.person_name(s, p["id"], "user") == "user"
        assert await safety.person_name(s, p["id"], "auto-trip") == "auto-trip"
        assert await safety.person_name(s, p["id"], "Hoa Mai") == "Hoa Mai"


# --- TP-8: role names in the workflow's messages -------------------------------------------------------------------


async def test_role_label_uses_the_display_names(env):
    c = env["c"]
    pid, _an = await _project(c)
    async with env["maker"]() as s:
        assert await workflow.role_label(s, pid, "ba") == "BA"
        assert await workflow.role_label(s, pid, "qa") == "QA"
        assert await workflow.role_label(s, pid, "dev") == "Dev"
        assert await workflow.role_label(s, pid, "user_tester") == "User tester"
        assert await workflow.role_label(s, pid, "data_wrangler") == "Data wrangler"
        assert await workflow.role_label(s, pid, None) == ""


# --- AT-4: the team card says which role pack a member came from -------------------------------------------------


async def test_team_card_carries_the_role_pack(env):
    c = env["c"]
    pid, _an = await _project(c)
    plain = await _runner(c, pid, env["repo"], name="Plain AI")
    made = await _runner(
        c,
        pid,
        env["repo"],
        name="Reviewer",
        config={"role": "reviewer", "pack": {"key": "reviewer", "version": 1}},
    )
    data = (await c.get(f"/projects/{pid}/ai/team/now")).json()
    cards = {m["id"]: m for m in data["members"]}
    assert cards[plain["id"]]["role"] is None
    assert cards[made["id"]]["role"] == "reviewer"


# --- ACC-5: the CLI version, read in the background ----------------------------------------------------------------


def test_parse_version_reads_the_first_version_number():
    assert accounts.parse_version("2.1.4 (Claude Code)") == "2.1.4"
    assert accounts.parse_version("codex-cli 0.46.0") == "0.46.0"
    assert accounts.parse_version("opencode v1.2.3-beta.1\n") == "1.2.3-beta.1"
    assert accounts.parse_version("no version here") is None
    assert accounts.parse_version("") is None


async def test_cli_version_is_read_once_in_the_background_and_cached(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(accounts, "_versions", {})
    monkeypatch.setattr(accounts, "_version_tried", {})
    calls = tmp_path / "calls"
    cli = tmp_path / "fake-cli"
    cli.write_text(f"#!/bin/sh\necho x >> {calls}\necho '2.1.4 (Claude Code)'\n")
    cli.chmod(cli.stat().st_mode | stat.S_IEXEC)
    # unknown at first: the page never waits for it
    assert accounts.cli_version(str(cli)) is None
    await asyncio.gather(*list(accounts._version_tasks))
    assert accounts.cli_version(str(cli)) == "2.1.4"
    assert accounts.cli_version(str(cli)) == "2.1.4"
    assert calls.read_text().count("x") == 1
    # nothing to read for a missing CLI, and no read outside a running loop
    assert accounts.cli_version(None) is None
    assert accounts.cli_version(str(tmp_path / "missing")) is None


async def test_a_cli_that_does_not_answer_stays_found_without_a_version(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(accounts, "_versions", {})
    monkeypatch.setattr(accounts, "_version_tried", {})
    monkeypatch.setattr(accounts, "VERSION_TIMEOUT_S", 0.2)
    cli = tmp_path / "slow-cli"
    cli.write_text("#!/bin/sh\nsleep 5\n")
    cli.chmod(cli.stat().st_mode | stat.S_IEXEC)
    assert accounts.cli_version(str(cli)) is None
    await asyncio.wait_for(asyncio.gather(*list(accounts._version_tasks)), 3)
    # not asked again before the retry time
    assert accounts.cli_version(str(cli)) is None
    assert not accounts._version_tasks
    bad = tmp_path / "bad-cli"
    bad.write_text("#!/bin/sh\nexit 3\n")
    bad.chmod(bad.stat().st_mode | stat.S_IEXEC)
    accounts.cli_version(str(bad))
    await asyncio.gather(*list(accounts._version_tasks))
    assert accounts.cli_version(str(bad)) is None


async def test_the_accounts_page_lists_a_version_field_for_each_cli(env):
    cards = (await env["c"].get("/ai/accounts")).json()["clis"]
    assert all("version" in x for x in cards)
    assert all(x["version"] is None for x in cards if not x["found"])
    # a read it started finishes inside this test's loop
    await asyncio.gather(*list(accounts._version_tasks))


# --- NT-5: the Needs you and Docs kinds of All notifications ----------------------------------------------------


async def test_needs_you_and_docs_families(env):
    c = env["c"]
    pid, _an = await _project(c)
    await centre.emit(
        "question", project_id=pid, recipients=["user"], title="A question"
    )
    await centre.emit(
        "comment",
        project_id=pid,
        recipients=["user"],
        title="New reply on a page",
        page_id="pg_1",
    )
    await centre.emit(
        "access_request", project_id=pid, recipients=["user"], title="Access"
    )
    await centre.emit("schedule", project_id=pid, recipients=["user"], title="Nightly")
    needs = {r["title"] for r in await _page(c, family="needs")}
    docs = {r["title"] for r in await _page(c, family="docs")}
    assert needs == {"A question"}
    assert docs == {"New reply on a page", "Access"}
    # the families that were there keep their rows
    assert {r["title"] for r in await _page(c, family="schedules")} == {"Nightly"}
    assert len(await _page(c)) == 4


# --- WV-7: the shared store as a list of its own -------------------------------------------------------------------


async def test_the_knowledge_base_lists_the_shared_store_even_when_not_searched(env):
    c = env["c"]
    pid, _an = await _project(c)
    async with env["maker"]() as s:
        s.add(
            AiKnowledgeDoc(
                store="shared", title="Style guide", summary="How we write", kind="text"
            )
        )
        s.add(
            AiKnowledgeDoc(
                store="project",
                project_id=pid,
                title="Runbook",
                summary="",
                kind="text",
            )
        )
        await s.commit()
    kb = (await c.get(f"/projects/{pid}/ai/kb")).json()
    assert kb["stores"] == ["project"]
    assert [d["title"] for d in kb["documents"]] == ["Runbook"]
    assert [d["title"] for d in kb["shared_documents"]] == ["Style guide"]
    assert kb["shared_documents"][0]["store"] == "shared"
