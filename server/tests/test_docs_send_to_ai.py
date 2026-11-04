"""Send a Docs page's comments to the AI of a ticket (services/docs_ai/handoff.py): each open thread defaults to the
ticket its section names, the threads go to the run holding the ticket as a message or start a run of its AI
assignee, each thread says where it went; and an AI tagged in a thread can point at the ticket whose work it is."""

import asyncio

from sqlmodel import select

import database
from models import AiRun, DocsCommentEvent
from tests.docs_ai_helpers import H, _ticket, env, fake, page, setup  # noqa: F401
from tests.test_ai import _runner, _wait

TEXT = (
    "## Tool comparison\n\nWritten under {a}.\n\n### Which project\n\nRate limits are not enforced yet.\n\n"
    "## Storage\n\nWritten under {b}.\n\nTokens last 30 days.\n"
)


async def _thread(c, page_id, quote, body):
    r = await c.post(
        f"/docs/pages/{page_id}/comments",
        json={"kind": "inline", "body": body, "anchor": {"quote": quote}},
        headers=H,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _two_tickets(c, pid, member_id):
    a = await _ticket(c, pid, title="Compare the tools", assignee=member_id)
    b = await _ticket(c, pid, title="Storage and re-indexing", assignee=member_id)
    return a, b


async def test_threads_default_to_their_sections_ticket_and_start_or_reach_its_ai(
    env, fake, monkeypatch
):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    c, pid, m = await setup(env)
    a, b = await _two_tickets(c, pid, m["id"])
    p = await page(c, pid, "Research", TEXT.format(a=a, b=b))
    t1 = await _thread(c, p["id"], "Rate limits are not enforced yet.", "Add a source")
    t2 = await _thread(c, p["id"], "Tokens last 30 days.", "Is this still true?")
    got = (await c.get(f"/docs/pages/{p['id']}/send-to-ai", headers=H)).json()
    # an h3 under "Tool comparison" belongs to the ticket named there
    assert got["defaults"] == {t1["id"]: a, t2["id"]: b}
    assert {t["id"]: [x["name"] for x in t["ais"]] for t in got["tickets"]} == {
        a: [m["name"]],
        b: [m["name"]],
    }

    r = await c.post(
        f"/docs/pages/{p['id']}/send-to-ai",
        json={"thread_ids": [t1["id"]], "ticket_id": a},
        headers=H,
    )
    assert r.status_code == 200, r.text
    sent = r.json()
    assert sent["delivered"] == "run" and sent["threads"] == 1
    async with database.async_session() as s:
        run = await s.get(AiRun, sent["run_id"])
    assert run.ticket_id == a and run.trigger == "docs_comments" and run.mode == "work"
    assert f"thread_id {t1['id']}" in run.instruction and p["id"] in run.instruction
    assert "Add a source" in run.instruction and "<untrusted" in run.instruction
    assert t2["id"] not in run.instruction
    th = next(
        t
        for t in (await c.get(f"/docs/pages/{p['id']}/comments", headers=H)).json()[
            "threads"
        ]
        if t["id"] == t1["id"]
    )
    assert th["comments"][-1]["body"].startswith(
        f"Sent to {m['name']} on {a}: a new run"
    )
    # the board's note, not a comment of the person's: it notifies nobody
    assert th["comments"][-1]["ai"]["kind"] == "sent"
    async with database.async_session() as s:
        events = (
            await s.exec(
                select(DocsCommentEvent).where(DocsCommentEvent.thread_id == t1["id"])
            )
        ).all()
    assert [e.kind for e in events] == ["comment"]

    # while that run works on the ticket, more comments reach it as a message instead of a second run
    await _wait(c, a, ("running",))
    r = await c.post(
        f"/docs/pages/{p['id']}/send-to-ai",
        json={"thread_ids": [t2["id"]], "ticket_id": a},
        headers=H,
    )
    assert r.status_code == 200, r.text
    assert r.json()["delivered"] in ("input", "next_board_call")
    assert r.json()["run_id"] == sent["run_id"]
    async with database.async_session() as s:
        count = len((await s.exec(select(AiRun).where(AiRun.ticket_id == a))).all())
    assert count == 1
    await c.post(f"/ai/runs/{sent['run_id']}/cancel", json={})


async def test_a_ticket_without_an_ai_or_a_resolved_thread_is_refused(env, fake):
    c, pid, m = await setup(env)
    a = await _ticket(c, pid, title="Nobody on it")
    p = await page(c, pid, "Research", TEXT.format(a=a, b=a))
    t = await _thread(c, p["id"], "Rate limits are not enforced yet.", "Add a source")
    got = (await c.get(f"/docs/pages/{p['id']}/send-to-ai", headers=H)).json()
    assert got["tickets"][0]["ais"] == [] and got["defaults"][t["id"]] is None
    r = await c.post(
        f"/docs/pages/{p['id']}/send-to-ai",
        json={"thread_ids": [t["id"]], "ticket_id": a},
        headers=H,
    )
    assert r.status_code == 422 and "no AI member" in r.text
    await c.patch(f"/tickets/{a}", json={"assignee": m["id"]})
    await c.post(f"/docs/comments/threads/{t['id']}/resolve", headers=H)
    r = await c.post(
        f"/docs/pages/{p['id']}/send-to-ai",
        json={"thread_ids": [t["id"]], "ticket_id": a},
        headers=H,
    )
    assert r.status_code == 422 and "resolved" in r.text


async def test_a_page_comment_goes_to_the_ai_chosen_after_the_one_holding_the_ticket(
    env, fake, monkeypatch
):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    c, pid, dev = await setup(env, name="Dev")
    ba = await _runner(c, pid, env["repo"], name="BA")
    a, b = await _two_tickets(c, pid, dev["id"])
    p = await page(c, pid, "Research", TEXT.format(a=a, b=b))
    r = await c.post(
        f"/docs/pages/{p['id']}/comments",
        json={"kind": "page", "body": f"Did you review the table of {a}?"},
        headers=H,
    )
    assert r.status_code == 201, r.text
    pt = r.json()
    first = await c.post(
        f"/docs/pages/{p['id']}/send-to-ai",
        json={"thread_ids": [pt["id"]], "ticket_id": a},
        headers=H,
    )
    assert first.json()["member_name"] == "Dev"  # the default: its assignee
    await _wait(c, a, ("running",))
    got = (await c.get(f"/docs/pages/{p['id']}/send-to-ai", headers=H)).json()
    assert got["defaults"][pt["id"]] == a  # the ticket its comment names
    ticket = next(t for t in got["tickets"] if t["id"] == a)
    assert ticket["held_by"] == "Dev" and ticket["ais"][0]["working"] is True
    r = await c.post(
        f"/docs/pages/{p['id']}/send-to-ai",
        json={"thread_ids": [pt["id"]], "ticket_id": a, "member_id": ba["id"]},
        headers=H,
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["delivered"] == "run" and out["member_name"] == "BA"
    assert out["after"] == "Dev"  # BA's run waits for Dev's
    async with database.async_session() as s:
        run = await s.get(AiRun, out["run_id"])
    assert run.member_id == ba["id"] and run.behind_run_id == first.json()["run_id"]
    assert "a comment on the whole page" in run.instruction
    th = next(
        t
        for t in (await c.get(f"/docs/pages/{p['id']}/comments", headers=H)).json()[
            "threads"
        ]
        if t["id"] == pt["id"]
    )
    assert th["comments"][-1]["body"].endswith("after Dev's run.")
    await c.post(f"/ai/runs/{out['run_id']}/cancel", json={})
    await c.post(f"/ai/runs/{first.json()['run_id']}/cancel", json={})


async def _job(c, job_id):
    for _ in range(200):
        j = (await c.get(f"/docs/ai/jobs/{job_id}")).json()
        if j["state"] not in ("queued", "running"):
            return j
        await asyncio.sleep(0.05)
    raise AssertionError("job stuck")


async def test_an_ai_tagged_in_a_thread_points_at_the_ticket_whose_work_it_is(
    env, fake
):
    c, pid, m = await setup(env)
    a, b = await _two_tickets(c, pid, m["id"])
    p = await page(c, pid, "Research", TEXT.format(a=a, b=b))
    fake.queue.append(
        f"That needs new research, which is {a}'s work.\nHANDOFF: {a}\nVERDICT: OK"
    )
    t = await _thread(
        c,
        p["id"],
        "Rate limits are not enforced yet.",
        f"Redo this with sources @[{m['name']}](member:{m['id']})",
    )
    job = await _job(c, t["ai_delivery"][0]["job_id"])
    assert job["state"] == "finished", job
    assert "HANDOFF:" in fake.prompts[-1]
    reply = (await c.get(f"/docs/pages/{p['id']}/comments", headers=H)).json()[
        "threads"
    ][0]["comments"][-1]
    assert reply["ai"]["handoff"] == {"ticket_id": a}
    assert "HANDOFF" not in reply["body"] and "VERDICT" not in reply["body"]
    # a key the page does not name is not offered
    fake.queue.append("Ask elsewhere.\nHANDOFF: ZZZ-9\nVERDICT: OK")
    r = await c.post(
        f"/docs/comments/threads/{t['id']}/replies",
        json={"body": f"And this? @[{m['name']}](member:{m['id']})"},
        headers=H,
    )
    await _job(c, r.json()["ai_delivery"][0]["job_id"])
    last = (await c.get(f"/docs/pages/{p['id']}/comments", headers=H)).json()[
        "threads"
    ][0]["comments"][-1]
    assert "handoff" not in last["ai"] and "HANDOFF" not in last["body"]


async def test_an_ai_tagged_in_a_thread_asks_the_teammate_who_knows(
    env, fake, monkeypatch
):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    c, pid, pm = await setup(env, name="PM")
    ba = await _runner(c, pid, env["repo"], name="BA")
    a, b = await _two_tickets(c, pid, ba["id"])
    p = await page(c, pid, "Research", TEXT.format(a=a, b=b))
    fake.queue.append(
        f"The page does not say whether it was reviewed; BA checked {a}, so I asked them.\n"
        f"ASK: BA on {a}\nVERDICT: OK"
    )
    r = await c.post(
        f"/docs/pages/{p['id']}/comments",
        json={"kind": "page", "body": f"Reviewed yet? @[PM](member:{pm['id']})"},
        headers=H,
    )
    t = r.json()
    job = await _job(c, t["ai_delivery"][0]["job_id"])
    assert job["state"] == "finished", job
    assert "ASK: <their exact name>" in fake.prompts[-1]
    assert "Where you are and who else is on it" in fake.prompts[-1]
    th = (await c.get(f"/docs/pages/{p['id']}/comments", headers=H)).json()["threads"][
        0
    ]
    answer, note = th["comments"][-2], th["comments"][-1]
    assert answer["author"] == "PM" and "ASK:" not in answer["body"]
    assert note["ai"]["kind"] == "sent" and note["body"].startswith(
        f"Sent to BA on {a}"
    )
    async with database.async_session() as s:
        run = (await s.exec(select(AiRun).where(AiRun.ticket_id == a))).one()
    assert run.member_id == ba["id"] and run.trigger == "docs_comments"
    assert t["id"] in run.instruction
    await c.post(f"/ai/runs/{run.id}/cancel", json={})
