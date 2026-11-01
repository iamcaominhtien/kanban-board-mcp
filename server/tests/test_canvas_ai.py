"""AI on a canvas, as the AI team works: the AI that knows the canvas answers "Ask AI", the whole canvas goes along, a
reply cut off is asked again, a failure says what the AI said, a double ask is one job, an @mention in a comment wakes
that AI (like Docs), "Propose a fix" goes to the AI that commented, and a waiting proposal is in the team's list. The
model is a fake; the board logic is real."""

import asyncio

import pytest

from kanban_mcp import common
from services import canvas_locks
from services.ai import llm
from tests.docs_ai_helpers import H, env, fake, setup, _ticket  # noqa: F401
from tests.test_ai_assist import _until

SIGN_IN = b"<title>Sign in</title><h1>Sign in</h1>"
SETTINGS = (
    b"<title>Settings</title><h1>Settings</h1><p>Secret sauce of the other frame</p>"
)


def block(bid: str, text: str = "<h1>New</h1>") -> str:
    return f"=== FILE {bid} index.html ===\n{text}\n=== END ===\nNOTE: changed it"


@pytest.fixture(autouse=True)
def _canvas_env(monkeypatch, tmp_path, env):  # noqa: F811
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(common, "async_session", env["maker"])
    canvas_locks.reset()


async def _canvas(env, member=None):
    c, pid, ai = await setup(env)
    tid = await _ticket(c, pid, "Redesign sign-in")
    if member is not None:
        await c.patch(f"/tickets/{tid}", json={"assignee": member["id"]}, headers=H)
    cv = (
        await c.post(
            "/canvases",
            json={"owner_kind": "ticket", "owner_id": tid, "title": "Login redesign"},
            headers=H,
        )
    ).json()
    boards = []
    for name, page in (("Sign in", SIGN_IN), ("Settings", SETTINGS)):
        r = await c.post(
            f"/canvases/{cv['id']}/boards",
            data={"kind": "html", "name": name},
            files=[("files", ("index.html", page, "text/html"))],
            headers=H,
        )
        assert r.status_code in (200, 201), r.text
        boards.append(r.json()["board"])
    return c, pid, ai, tid, cv, boards


async def _job(c, job_id):
    async def get():
        return (await c.get(f"/docs/ai/jobs/{job_id}", headers=H)).json()

    return await _until(get, lambda j: j["state"] in ("finished", "failed"))


async def test_ask_sends_the_whole_canvas_and_the_ai_that_knows_it_answers(env, fake):
    c, pid, ai, tid, cv, (sign, sett) = await _canvas(env)
    fake.queue.append(block(sign["id"]))
    r = await c.post(
        f"/canvases/{cv['id']}/ai/ask",
        json={"board_ids": [sign["id"]], "request": "Make it bigger"},
        headers=H,
    )
    assert r.status_code == 202, r.text
    done = await _job(c, r.json()["id"])
    assert done["state"] == "finished", done
    prompt = fake.prompts[0]
    assert "canvas outline" in prompt  # every frame is listed
    assert (
        sett["id"] in prompt and "Secret sauce of the other frame" in prompt
    )  # a local AI may look at the rest
    assert "do not change" in prompt and "change this" in prompt
    props = (await c.get(f"/canvases/{cv['id']}/proposals", headers=H)).json()
    assert len(props) == 1 and props[0]["member_id"] == ai["id"]


async def test_the_ai_the_ticket_is_assigned_to_is_the_default_answer(env, fake):
    c, pid, ai, tid, cv, boards = await _canvas(env)
    other = (
        (
            await c.post(
                f"/projects/{pid}/members",
                json={"name": "Dev Gem", "kind": "human"},
                headers=H,
            )
        ).json()
        if False
        else None
    )
    got = (await c.get(f"/canvases/{cv['id']}/ai/members", headers=H)).json()
    assert (
        got["default_member_id"] is None
    )  # nobody knows the canvas yet: the project's default answers
    assert [m["id"] for m in got["members"]] == [ai["id"]]
    await c.patch(f"/tickets/{tid}", json={"assignee": ai["id"]}, headers=H)
    got = (await c.get(f"/canvases/{cv['id']}/ai/members", headers=H)).json()
    assert got["default_member_id"] == ai["id"] and "ticket" in got["why"]
    assert other is None


async def test_a_reply_that_is_cut_off_is_asked_again(env, fake):
    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue += [
        f"=== FILE {sign['id']} index.html ===\n<h1>Half a pa",  # stops before its END
        block(sign["id"], "<h1>Whole</h1>"),
    ]
    r = await c.post(
        f"/canvases/{cv['id']}/ai/ask",
        json={"board_ids": [sign["id"]], "request": "Rewrite it"},
        headers=H,
    )
    done = await _job(c, r.json()["id"])
    assert done["state"] == "finished", done
    assert len(fake.prompts) == 2 and "cut off" in fake.prompts[1]
    props = (await c.get(f"/canvases/{cv['id']}/proposals", headers=H)).json()
    assert len(props) == 1


async def test_a_failed_ask_says_what_the_ai_said(env, fake):
    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue.append("I cannot do that because the frame uses a font I do not know.")
    r = await c.post(
        f"/canvases/{cv['id']}/ai/ask",
        json={"board_ids": [sign["id"]], "request": "Do it"},
        headers=H,
    )
    done = await _job(c, r.json()["id"])
    assert done["state"] == "failed"
    assert "font I do not know" in done["error"]["message"]


async def test_the_same_ask_twice_is_one_job(env, fake, monkeypatch):
    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)

    async def slow(*a, **k):
        await asyncio.sleep(0.4)
        return await fake(*a, **k)

    monkeypatch.setattr(llm, "complete", slow)
    fake.queue.append(block(sign["id"]))
    body = {"board_ids": [sign["id"]], "request": "Make it bigger"}
    a = (await c.post(f"/canvases/{cv['id']}/ai/ask", json=body, headers=H)).json()
    b = (await c.post(f"/canvases/{cv['id']}/ai/ask", json=body, headers=H)).json()
    assert a["id"] == b["id"]
    await _job(c, a["id"])
    assert len(fake.prompts) == 1


async def test_a_mention_in_a_comment_wakes_that_ai_and_it_answers_in_the_thread(
    env, fake
):
    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue.append("The logo is 24 px; I would make it 40.")
    r = await c.post(
        f"/canvases/{cv['id']}/threads",
        json={"body": f"@{ai['name']} is the logo too small?", "board_id": sign["id"]},
        headers=H,
    )
    assert r.status_code == 201, r.text
    deliveries = r.json()["ai_deliveries"]
    assert [d["result"] for d in deliveries] == ["job"]
    await _job(c, deliveries[0]["job_id"])
    threads = (await c.get(f"/canvases/{cv['id']}/threads", headers=H)).json()
    comments = threads[0]["comments"]
    assert [x["author"] for x in comments] == ["An Nguyen", ai["name"]]
    assert comments[1]["is_ai"] and "40" in comments[1]["body"]
    assert "is the logo too small" in fake.prompts[0]
    # an AI's own comment, or a note-only mention, wakes nobody
    again = await c.post(
        f"/canvases/threads/{threads[0]['id']}/replies",
        json={"body": f"@{ai['name']} thanks", "ai_intent": "notify"},
        headers=H,
    )
    assert [d["result"] for d in again.json()["ai_deliveries"]] == ["notified"]
    assert len(fake.prompts) == 1


async def test_send_and_propose_answers_and_prepares_the_change(env, fake):
    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue.append(block(sign["id"], "<h1>Bigger logo</h1>"))
    r = await c.post(
        f"/canvases/{cv['id']}/threads",
        json={
            "body": f"@{ai['name']} make the logo bigger",
            "board_id": sign["id"],
            "ai_intent": "suggest",
        },
        headers=H,
    )
    job = r.json()["ai_deliveries"][0]["job_id"]
    done = await _job(c, job)
    assert done["state"] == "finished", done
    props = (await c.get(f"/canvases/{cv['id']}/proposals", headers=H)).json()
    assert len(props) == 1
    threads = (await c.get(f"/canvases/{cv['id']}/threads", headers=H)).json()
    reply = threads[0]["comments"][-1]
    assert reply["is_ai"] and reply["ai"]["proposal_id"] == props[0]["id"]


async def test_propose_a_fix_goes_to_the_ai_that_wrote_the_comment(env, fake):
    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue.append("It is too small.")
    r = await c.post(
        f"/canvases/{cv['id']}/threads",
        json={"body": f"@{ai['name']} look at the logo", "board_id": sign["id"]},
        headers=H,
    )
    await _job(c, r.json()["ai_deliveries"][0]["job_id"])
    thread_id = (await c.get(f"/canvases/{cv['id']}/threads", headers=H)).json()[0][
        "id"
    ]
    fake.queue.append(block(sign["id"]))
    r = await c.post(f"/canvases/threads/{thread_id}/propose", headers=H)
    assert r.status_code == 202, r.text
    assert r.json()["member_id"] == ai["id"]
    await _job(c, r.json()["id"])
    assert (
        "It is too small." in fake.prompts[-1]
    )  # the whole thread, not only the first comment


async def test_a_proposal_waits_in_the_teams_list_for_a_person(env, fake):
    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue.append(block(sign["id"]))
    r = await c.post(
        f"/canvases/{cv['id']}/ai/ask",
        json={"board_ids": [sign["id"]], "request": "Make it bigger"},
        headers=H,
    )
    await _job(c, r.json()["id"])
    now = await c.get(f"/projects/{pid}/ai/team/now", headers=H)
    assert now.status_code == 200, now.text
    items = [i for i in now.json()["needs_you"] if i["kind"] == "canvas_proposal"]
    assert len(items) == 1 and items[0]["ticket_id"] == tid and items[0]["changes"] == 1


async def test_autopilot_accepts_a_canvas_proposal_and_says_so(env, fake):
    from sqlmodel import select

    from models import CanvasProposal, AiRun
    from services.ai import autopilot
    from tests.test_ai import _runner
    from tests.test_ai_autopilot import ON, _delegate_ctx, _settings

    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue.append(block(sign["id"], "<h1>Bigger logo</h1>"))
    r = await c.post(
        f"/canvases/{cv['id']}/ai/ask",
        json={"board_ids": [sign["id"]], "request": "Make the logo bigger"},
        headers=H,
    )
    await _job(c, r.json()["id"])
    delegate = await _runner(c, pid, env["repo"], name="Mai PM")
    r = await c.put(
        f"/projects/{pid}/ai/autopilot",
        json={**ON, "delegate_id": delegate["id"]},
    )
    assert r.status_code == 200, r.text
    autopilot._shown.clear()
    autopilot._woke.clear()
    s = await _settings(env, pid)
    assert await autopilot._wake(s, autopilot.config(s))
    async with env["maker"]() as session:
        run = (
            await session.exec(select(AiRun).where(AiRun.trigger == "autopilot"))
        ).first()
    assert "canvas proposal cp_" in run.instruction
    assert "Bigger logo" in run.instruction  # the delegate reads what changes
    dctx = await _delegate_ctx(env, pid, delegate)
    out = await autopilot.decide(
        dctx, (await _proposal_id(env)), True, "Fits the ticket"
    )
    assert out["decided"] == "approved"
    async with env["maker"]() as session:
        p = (await session.exec(select(CanvasProposal))).first()
    assert p.status == "accepted" and p.decided_by == "Mai PM (Autopilot)"
    got = (await c.get(f"/canvases/{cv['id']}", headers=H)).json()
    assert got["version"] >= 1  # saved as a new version of the canvas
    # it counts as one of the hour's decisions
    assert (await c.get(f"/projects/{pid}/ai/autopilot")).json()["used_last_hour"] == 1


async def _proposal_id(env):
    from sqlmodel import select

    from models import CanvasProposal

    async with env["maker"]() as session:
        return (await session.exec(select(CanvasProposal))).first().id


async def test_autopilot_leaves_a_canvas_proposal_to_a_person_in_safe_mode(env, fake):
    from services.ai import autopilot
    from tests.test_ai import _runner
    from tests.test_ai_autopilot import ON, _settings

    c, pid, ai, tid, cv, (sign, _) = await _canvas(env)
    fake.queue.append(block(sign["id"]))
    r = await c.post(
        f"/canvases/{cv['id']}/ai/ask",
        json={"board_ids": [sign["id"]], "request": "Make the logo bigger"},
        headers=H,
    )
    await _job(c, r.json()["id"])
    delegate = await _runner(c, pid, env["repo"], name="Mai PM")
    await c.put(
        f"/projects/{pid}/ai/autopilot", json={**ON, "delegate_id": delegate["id"]}
    )
    await c.patch(f"/projects/{pid}/ai/settings", json={"safe_mode": True})
    autopilot._shown.clear()
    autopilot._woke.clear()
    s = await _settings(env, pid)
    assert not await autopilot._wake(
        s, autopilot.config(s)
    )  # nothing is put to the delegate
