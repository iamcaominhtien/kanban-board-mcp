"""Docs AI foundation: settings, the central access check (hidden pages), guidance, jobs and the engine."""

import json

import database
from models import DocsAiJob, DocsPage
from services.docs_ai import DocsAiError, access, engine, jobs
from services.docs_ai import settings as svc_settings
from tests.docs_ai_helpers import H, env, fake, page, setup  # noqa: F401


async def test_docs_ai_is_off_until_an_admin_turns_it_on(env):
    c, pid, member = await setup(env, enabled=False)
    d = (await c.get(f"/projects/{pid}/docs/ai")).json()
    assert d["enabled"] is False and d["state"] == "off"
    assert any(x["id"] == member["id"] for x in d["candidates"])
    async with database.async_session() as s:
        try:
            await svc_settings.require_enabled(s, pid)
            raise AssertionError("expected docs_ai_off")
        except DocsAiError as exc:
            assert exc.code == "docs_ai_off"
    r = await c.patch(f"/projects/{pid}/docs/ai", json={"enabled": True, "member_id": member["id"]})
    assert r.status_code == 200 and r.json()["state"] == "ready"
    assert r.json()["member"]["name"] == member["name"]


async def test_only_admins_change_settings_and_values_are_validated(env):
    c, pid, member = await setup(env)
    await c.post(f"/projects/{pid}/members", json={"name": "Mia", "role": "member"})
    r = await c.patch(f"/projects/{pid}/docs/ai", json={"enabled": False}, headers={"X-Actor": "Mia"})
    assert r.status_code == 403 and r.json()["code"] == "forbidden"
    for bad in ({"read_scope": "nope"}, {"edits_mode": "x"}, {"proposal_days": 0}, {"guidance_limit": 5}):
        r = await c.patch(f"/projects/{pid}/docs/ai", json=bad)
        assert r.status_code == 422, (bad, r.text)
    r = await c.patch(f"/projects/{pid}/docs/ai", json={"member_id": "nobody"})
    assert r.status_code == 422


async def test_a_hidden_page_is_invisible_to_every_ai(env):
    c, pid, member = await setup(env)
    a = await page(c, pid, "Public", "## Hi\n\nOpen.")
    b = await page(c, pid, "Secret", "## Keys\n\nNever.")
    r = await c.patch(f"/docs/pages/{b['id']}/ai", json={"hidden": True}, headers=H)
    assert r.json()["ai_hidden"] is True
    async with database.async_session() as s:
        titles = [p.title for p in await access.readable_pages(s, pid)]
        assert titles == ["Public"]
        assert await access.ai_can_read(s, await s.get(DocsPage, a["id"])) is True
        assert await access.ai_can_read(s, await s.get(DocsPage, b["id"])) is False
        assert await access.hidden_page_ids(s, pid) == {b["id"]}


async def test_read_scope_picked_limits_the_space(env):
    c, pid, member = await setup(env)
    await page(c, pid, "A", "x")
    b = await page(c, pid, "B", "y")
    await c.patch(f"/projects/{pid}/docs/ai", json={"read_scope": "picked", "picked_pages": [b["id"]]})
    async with database.async_session() as s:
        assert [p.title for p in await access.readable_pages(s, pid)] == ["B"]


async def test_a_hidden_page_cannot_be_guidance_and_guidance_is_capped(env):
    c, pid, member = await setup(env)
    a = await page(c, pid, "Rules", "## Naming\n\n" + "word " * 4000)
    r = await c.patch(f"/docs/pages/{a['id']}/ai", json={"guidance": True}, headers=H)
    assert r.json()["ai_guidance"] is True
    await c.patch(f"/projects/{pid}/docs/ai", json={"guidance_limit": 1000})
    async with database.async_session() as s:
        text, reads = await access.guidance_block(s, pid)
    assert "Guidance page: Rules" in text and reads[0]["cut"] is True
    assert len(text) < 1000 * 4 + 600
    r = await c.patch(f"/docs/pages/{a['id']}/ai", json={"hidden": True, "guidance": True}, headers=H)
    assert r.status_code == 422
    r = await c.patch(f"/docs/pages/{a['id']}/ai", json={"hidden": True}, headers=H)
    assert r.json() == {"id": a["id"], "ai_hidden": True, "ai_guidance": False}
    async with database.async_session() as s:
        assert await access.guidance_block(s, pid) == ("", [])


async def test_guidance_is_empty_when_docs_ai_is_off(env):
    c, pid, member = await setup(env, enabled=False)
    a = await page(c, pid, "Rules", "text")
    await c.patch(f"/docs/pages/{a['id']}/ai", json={"guidance": True}, headers=H)
    async with database.async_session() as s:
        assert await access.guidance_block(s, pid) == ("", [])


async def test_engine_call_meters_the_usage_and_the_job(env, fake):
    c, pid, member = await setup(env)
    fake.queue.append("Hello.")
    async with database.async_session() as s:
        job = await jobs.create(s, project_id=pid, kind="ask", started_by="An Nguyen")
    out = await engine.call(pid, system="s", prompt="p", job_id=job.id, person="An Nguyen")
    assert out.text == "Hello."
    async with database.async_session() as s:
        j = await s.get(DocsAiJob, job.id)
        assert j.tokens_in == 120 and j.cost_usd > 0 and j.member_id == member["id"]
    usage = (await c.get(f"/projects/{pid}/ai/assist", headers=H)).json()
    assert any(f["key"] == "docs" and f["cost_month"] > 0 for f in usage["features"])


async def test_engine_refuses_a_paused_member(env, fake):
    c, pid, member = await setup(env)
    await c.post(f"/ai/members/{member['id']}/pause", json={}, headers=H)
    try:
        await engine.call(pid, system="s", prompt="p")
        raise AssertionError("expected paused")
    except DocsAiError as exc:
        assert exc.code == "paused"


async def test_verify_refs_drops_links_to_pages_that_do_not_exist(env):
    c, pid, member = await setup(env)
    await page(c, pid, "Auth", "## Rotation\n\nText")
    t = await _ticket_key(c, pid)
    text = f"See [[Auth#Rotation]], [[Nowhere]] and {t} and KAN-999."
    out = await engine.verify_refs(pid, text)
    assert "[[Auth#Rotation]]" in out.text and "[[Nowhere]]" not in out.text and "Nowhere" in out.text
    assert out.unknown_tickets == ["KAN-999"] and out.unknown_pages == ["Nowhere"]
    assert len(out.problems) == 2


async def _ticket_key(c, pid):
    r = await c.post(f"/projects/{pid}/tickets", json={"title": "T", "status": "todo"})
    return r.json()["id"]


async def test_jobs_run_a_registered_handler_and_record_failures(env):
    c, pid, member = await setup(env)

    @jobs.handler("probe")
    async def _ok(job):
        await jobs.add_step(job.id, "Reading")
        return {"answer": 42}

    @jobs.handler("probe_fail")
    async def _bad(job):
        raise DocsAiError("not_found", "nope")

    async with database.async_session() as s:
        ok = await jobs.start(s, project_id=pid, kind="probe", started_by="x")
        bad = await jobs.start(s, project_id=pid, kind="probe_fail", started_by="x")
    import asyncio

    for _ in range(50):
        r = (await c.get(f"/docs/ai/jobs/{ok.id}")).json()
        if r["state"] != "queued" and r["state"] != "running":
            break
        await asyncio.sleep(0.05)
    assert r["state"] == "finished" and r["result"] == {"answer": 42} and r["steps"][0]["text"] == "Reading"
    r = (await c.get(f"/docs/ai/jobs/{bad.id}")).json()
    assert r["state"] == "failed" and r["error"]["code"] == "not_found"
    listed = (await c.get(f"/projects/{pid}/docs/ai/jobs", headers=H)).json()
    assert {j["kind"] for j in listed} == {"probe", "probe_fail"}


async def test_ai_runs_never_see_hidden_pages_through_mcp(env):
    from kanban_mcp.tools import docs_read
    from services.ai import guard
    from tests.test_ai import _ctx

    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]
    open_page = await page(c, pid, "Open", "## A\n\nvisible")
    secret = await page(c, pid, "Secret", "## B\n\nhidden")
    await c.patch(f"/docs/pages/{secret['id']}/ai", json={"hidden": True}, headers=H)
    # a person (no run) still sees both
    assert {p["title"] for p in await docs_read(action="list", project_id=pid)} == {"Open", "Secret"}
    tokens = guard.enter(ctx)
    try:
        assert [p["title"] for p in await docs_read(action="list", project_id=pid)] == ["Open"]
        assert (await docs_read(action="get", page_id=open_page["id"]))["title"] == "Open"
        try:
            await docs_read(action="get", page_id=secret["id"])
            raise AssertionError("a hidden page was read by an AI run")
        except Exception as exc:  # noqa: BLE001 - the tool wraps ValueError in a ToolError
            assert "hidden from AI" in str(exc)
        found = await docs_read(action="search", project_id=pid, query="hidden")
        assert all(p["page_id"] != secret["id"] for p in found["pages"])
    finally:
        guard.leave(tokens)


async def test_guidance_pages_are_added_to_every_run_and_listed_as_read(env):
    from models import AiRun
    from services.ai import runs
    from tests.test_ai import _ctx

    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]
    rules = await page(c, pid, "Conventions", "## Naming\n\nUse snake_case.")
    await c.patch(f"/projects/{pid}/docs/ai", json={"enabled": True})
    await c.patch(f"/docs/pages/{rules['id']}/ai", json={"guidance": True}, headers=H)
    from models import AiMember, Member

    async with env["maker"]() as s:
        run = await s.get(AiRun, ctx.run_id)
        system, prompt, _ = await runs._build_prompt(
            s, run, await s.get(AiMember, m["id"]), await s.get(Member, m["id"]), resume_note=None
        )
    assert "Guidance page: Conventions" in system and "snake_case" in system
    async with env["maker"]() as s:
        steps = json.loads((await s.get(AiRun, ctx.run_id)).steps)
    assert steps[0]["kind"] == "read" and steps[0]["detail"]["pages"][0]["title"] == "Conventions"
    # hiding the page removes it from the next run
    await c.patch(f"/docs/pages/{rules['id']}/ai", json={"hidden": True}, headers=H)
    async with env["maker"]() as s:
        run = await s.get(AiRun, ctx.run_id)
        system, _, _ = await runs._build_prompt(
            s, run, await s.get(AiMember, m["id"]), await s.get(Member, m["id"]), resume_note=None
        )
    assert "Conventions" not in system


async def test_the_board_ai_chat_context_skips_hidden_pages(env, fake):
    from services.ai.assist import context as ctxb

    c, pid, member = await setup(env)
    a = await page(c, pid, "Open", "## A\n\nvisible")
    b = await page(c, pid, "Secret", "## B\n\nnever")
    await c.patch(f"/docs/pages/{b['id']}/ai", json={"hidden": True}, headers=H)
    async with env["maker"]() as s:
        built = await ctxb.build(
            s, project_id=pid, scope="doc", person="An Nguyen", doc_ids=[a["id"], b["id"]],
            include_docs=[b["id"]],
        )
    assert "visible" in built.text and "never" not in built.text
    assert [x["title"] for x in built.private_skipped] == ["Secret"]
