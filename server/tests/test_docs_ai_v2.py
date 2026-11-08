"""Docs AI on the assistant engine (AI v2 stage 7): the old API paths start jobs whose handlers run one assistant
turn with a skill; what needs no model (ignore, create tickets, undo) is plain code; proposals answer 410."""

import asyncio
import json

import pytest

from tests.ai_helpers import _project, _runner, env  # noqa: F401


@pytest.fixture(autouse=True)
def _assistant(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "assistant")


async def _space(env, monkeypatch, answers: dict):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    assert (
        await c.patch(f"/projects/{pid}/docs/ai", json={"enabled": True})
    ).status_code == 200
    r = await c.post(
        f"/projects/{pid}/docs/pages",
        json={
            "title": "API",
            "markdown": "# API\n\nThe API uses REST.\n\n- [ ] Add paging\n",
        },
    )
    assert r.status_code == 201, r.text
    monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_BY_SKILL", json.dumps(answers))
    return c, pid, r.json()["id"]


async def _job(c, job, timeout=15.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        j = (await c.get(f"/docs/ai/jobs/{job['id']}")).json()
        if j["state"] not in ("queued", "running"):
            return j
        assert asyncio.get_running_loop().time() < deadline, j
        await asyncio.sleep(0.05)


async def test_ask_the_docs_answers_with_citations(env, monkeypatch):
    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-ask": {
                "answer": "REST [1].",
                "verdict": "answered",
                "citations": [{"page_id": "PAGE", "title": "API"}],
                "pages_read": 2,
            }
        },
    )
    r = await c.post(
        f"/projects/{pid}/docs/ai/ask", json={"question": "  Which   API style? "}
    )
    assert r.status_code == 202, r.text
    assert r.json()["kind"] == "ask" and r.json()["instruction"] == "Which API style?"
    j = await _job(c, r.json())
    assert j["state"] == "finished", j
    res = j["result"]
    assert (
        res["answer"] == "REST [1]."
        and res["verdict"] == "answered"
        and res["pages_read"] == 2
    )
    assert res["citations"] == [
        {"n": 1, "page_id": "PAGE", "title": "API", "section": None}
    ]
    assert j["cost"] == 0.02 and j["tokens_in"] == 200
    chat = await c.post(f"/docs/ai/ask/{j['id']}/chat")
    assert chat.status_code == 201 and chat.json()["chat_id"]
    fb = await c.post(f"/docs/ai/ask/{j['id']}/feedback", json={"rating": "up"})
    assert fb.status_code == 200 and fb.json()["result"]["feedback"]["rating"] == "up"
    assert (
        await c.post(f"/projects/{pid}/docs/ai/ask", json={"question": " "})
    ).status_code == 422
    assert (
        await c.post(
            f"/projects/{pid}/docs/ai/ask", json={"question": "x", "scope": "moon"}
        )
    ).status_code == 422


async def test_docs_ai_off_refuses(env):
    c = env["c"]
    pid, _ = await _project(c)
    r = await c.post(f"/projects/{pid}/docs/ai/ask", json={"question": "Anything?"})
    assert r.status_code == 409 and r.json()["code"] == "docs_ai_off"


async def test_check_fix_and_ignore(env, monkeypatch):
    finding = {
        "kind": "unclear",
        "quote": "The API uses REST.",
        "message": "Say which version.",
        "suggestion": "The API uses REST v2.",
    }
    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-check": {
                "findings": [
                    finding,
                    {
                        "kind": "style",
                        "quote": "Add paging",
                        "message": "Write a full sentence.",
                    },
                ]
            },
            "docs-fix": {"old": "The API uses REST.", "new": "The API uses REST v2."},
        },
    )
    r = await c.post(f"/docs/pages/{page}/ai/check", json={})
    assert r.status_code == 202, r.text
    j = await _job(c, r.json())
    assert j["state"] == "finished", j
    found = j["result"]["findings"]
    assert [f["kind"] for f in found] == ["unclear", "style"] and all(
        len(f["id"]) == 10 for f in found
    )
    fix = await c.post(f"/docs/pages/{page}/ai/check/{found[0]['id']}/fix", json={})
    assert fix.status_code == 202, fix.text
    fixed = await _job(c, fix.json())
    assert (
        fixed["state"] == "finished"
        and fixed["result"]["new"] == "The API uses REST v2."
    )
    assert (
        await c.post(f"/docs/pages/{page}/ai/check/nope/fix", json={})
    ).status_code == 404
    ig = await c.post(
        f"/docs/pages/{page}/ai/check/ignore", json={"key": found[1]["id"]}
    )
    assert ig.status_code == 200 and ig.json()["ok"] is True
    again = await _job(
        c, (await c.post(f"/docs/pages/{page}/ai/check", json={})).json()
    )
    assert [f["kind"] for f in again["result"]["findings"]] == ["unclear"] and again[
        "result"
    ]["ignored"] == 1


async def test_page_views_summary_explain_translate(env, monkeypatch):
    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-summarise": {"text": "REST API.", "title": "API"},
            "docs-explain": {"text": "REST is a style."},
            "docs-translate": {
                "markdown": "# API\n\nAPI dùng REST.",
                "language": "Vietnamese",
            },
        },
    )
    s = await _job(c, (await c.post(f"/docs/pages/{page}/ai/summary")).json())
    assert s["result"]["text"] == "REST API." and s["result"]["title"] == "API"
    e = await _job(
        c,
        (
            await c.post(f"/docs/pages/{page}/ai/explain", json={"selection": "REST"})
        ).json(),
    )
    assert e["result"]["text"] == "REST is a style." and e["result"]["from"] == "API"
    t = await _job(
        c,
        (
            await c.post(
                f"/docs/pages/{page}/ai/translate", json={"language": "Vietnamese"}
            )
        ).json(),
    )
    assert (
        t["result"]["language"] == "Vietnamese"
        and "dùng REST" in t["result"]["markdown"]
    )
    assert (
        await c.post(f"/docs/pages/{page}/ai/explain", json={"selection": " "})
    ).status_code == 422


async def test_write_a_page_and_markers(env, monkeypatch):
    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-write": {
                "page_id": "PAGE",
                "title": "Paging",
                "gaps": ["Who owns it?"],
            }
        },
    )
    record = env["tmp"] / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(record))
    pre = await c.post(
        f"/projects/{pid}/docs/ai/write/preview",
        json={"source": {"kind": "prompt", "text": "Paging design"}},
    )
    assert pre.status_code == 200 and pre.json()["items"][0]["kind"] == "prompt"
    r = await c.post(
        f"/projects/{pid}/docs/ai/write",
        json={
            "source": {"kind": "prompt", "text": "Paging design"},
            "page_kind": "spec",
        },
    )
    assert r.status_code == 200, r.text
    j = await _job(c, r.json())
    assert j["state"] == "finished", j
    assert (
        j["result"]["page_id"] == "PAGE"
        and j["result"]["gaps"] == ["Who owns it?"]
        and j["page_id"] == "PAGE"
    )
    prompt = json.loads(record.read_text().splitlines()[-1])["prompt"]
    assert (
        "kanban-assistant:docs-write" in prompt
        and "Paging design" in prompt
        and "page_kind: spec" in prompt
    )
    bad = await c.post(
        f"/projects/{pid}/docs/ai/write", json={"source": {"kind": "notes", "text": ""}}
    )
    assert bad.status_code == 422
    m = await c.get(f"/docs/pages/{page}/ai/markers")
    assert m.status_code == 200 and m.json() == {"markers": [], "count": 0}


async def test_tickets_from_a_page_draft_create_undo(env, monkeypatch):
    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-tickets": {
                "drafts": [
                    {
                        "title": "Add paging",
                        "text": "From the API page.",
                        "type": "task",
                    }
                ],
                "skipped": [],
            }
        },
    )
    d = await _job(
        c, (await c.post(f"/docs/pages/{page}/ai/tickets/draft", json={})).json()
    )
    assert (
        d["state"] == "finished" and d["result"]["drafts"][0]["title"] == "Add paging"
    )
    made = await c.post(
        f"/docs/pages/{page}/ai/tickets/create", json={"drafts": d["result"]["drafts"]}
    )
    assert made.status_code == 200, made.text
    out = made.json()
    assert len(out["tickets"]) == 1 and out["linked"] is True and out["undo_token"]
    tid = out["tickets"][0]["id"]
    assert (await c.get(f"/tickets/{tid}")).json()["title"] == "Add paging"
    assert any(
        p["page_id"] == page for p in (await c.get(f"/tickets/{tid}/docs")).json()
    )
    undo = await c.post("/docs/ai/tickets/undo", json={"undo_token": out["undo_token"]})
    assert undo.status_code == 200 and undo.json()["removed"] == [tid]
    assert (await c.get(f"/tickets/{tid}")).status_code == 404
    assert (
        await c.post("/docs/ai/tickets/undo", json={"undo_token": out["undo_token"]})
    ).status_code == 404


async def test_freshness_banner(env, monkeypatch):
    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-freshness": {
                "state": "stale",
                "reasons": [
                    {
                        "quote": "REST",
                        "source": "KAN-1",
                        "why": "The API moved to gRPC.",
                    }
                ],
            }
        },
    )
    assert (await c.get(f"/docs/pages/{page}/ai/freshness")).json()[
        "state"
    ] == "unchecked"
    r = await c.post(f"/docs/pages/{page}/ai/freshness")
    assert r.status_code == 202, r.text
    j = await _job(c, r.json())
    assert j["state"] == "finished" and j["result"]["state"] == "stale"
    banner = (await c.get(f"/docs/pages/{page}/ai/freshness")).json()
    assert (
        banner["stale"] is True
        and banner["reasons"][0]["text"] == "The API moved to gRPC."
    )
    key = banner["reasons"][0]["key"]
    gone = (
        await c.post(
            f"/docs/pages/{page}/ai/freshness/dismiss",
            json={"key": key, "level": "once"},
        )
    ).json()
    assert gone["stale"] is False and gone["hidden"] == 1
    assert (await c.post(f"/docs/pages/{page}/ai/freshness/still-correct")).json()[
        "state"
    ] == "ok"
    assert (await c.post(f"/docs/pages/{page}/ai/freshness/suggest")).status_code == 410


async def test_thread_summary_and_proposals_are_gone(env, monkeypatch):
    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-thread": {
                "reply": "- Paging is wanted.\n- Nobody owns it.",
                "posted": True,
            }
        },
    )
    t = await c.post(
        f"/docs/pages/{page}/comments",
        json={"kind": "page", "body": "Who owns paging?"},
    )
    assert t.status_code == 201, t.text
    thread_id = t.json()["id"]
    r = await c.post(f"/docs/ai/threads/{thread_id}/summary")
    assert r.status_code == 202, r.text
    j = await _job(c, r.json())
    assert j["state"] == "finished", j
    assert j["thread_id"] == thread_id
    assert (
        await c.post(
            f"/docs/ai/threads/{thread_id}/suggest-edit", json={"comment_id": "x"}
        )
    ).status_code == 410
    assert (await c.get(f"/docs/pages/{page}/ai/proposals")).json() == []
    assert (await c.get(f"/projects/{pid}/docs/ai/proposals/pages")).json() == []
    assert (await c.post("/docs/ai/proposals/p1/accept-all")).status_code == 410
    assert (await c.post("/docs/ai/proposals/p1/changes/0/accept")).status_code == 410
    assert (await c.get(f"/docs/pages/{page}/comments")).json()["docs_ai"] is True


async def test_an_ai_mention_in_a_thread_is_answered_by_the_assistant(env, monkeypatch):
    c, pid, page = await _space(
        env,
        monkeypatch,
        {"docs-thread": {"reply": "Nobody yet: assign it.", "posted": False}},
    )
    team = (await c.get(f"/projects/{pid}/ai/teams")).json()[0]
    body = f"@[{team['name']}](member:{team['id']}) who owns paging?"
    t = await c.post(
        f"/docs/pages/{page}/comments", json={"kind": "page", "body": body}
    )
    assert t.status_code == 201, t.text
    delivery = t.json()["ai_delivery"]
    assert delivery and delivery[0]["result"] == "job", delivery
    j = await _job(c, {"id": delivery[0]["job_id"]})
    assert (
        j["state"] == "finished" and j["result"]["reply"] == "Nobody yet: assign it."
    ), j
    threads = (await c.get(f"/docs/pages/{page}/comments")).json()["threads"]
    replies = threads[0]["comments"]
    assert (
        len(replies) == 2
        and replies[-1]["body"] == "Nobody yet: assign it."
        and replies[-1]["ai"]["member"] == "Docs AI"
    )
    assert replies[-1]["id"] == j["reply_comment_id"]


async def test_a_note_to_a_page_reaches_the_page_assistant(env, monkeypatch):
    from services.ai import messaging

    c, pid, page = await _space(
        env,
        monkeypatch,
        {
            "docs-thread": {
                "reply": "Noted: the API page will say gRPC.",
                "posted": False,
            }
        },
    )
    out = await messaging.deliver_to_page(
        page, "The API moved to gRPC in KAN-1.", by="An Nguyen"
    )
    assert out["delivered"] == "page_assistant" and out["thread_id"] and out["job_id"]
    j = await _job(c, {"id": out["job_id"]})
    assert j["state"] == "finished", j
    thread = (await c.get(f"/docs/pages/{page}/comments")).json()["threads"][0]
    assert [x["body"] for x in thread["comments"]] == [
        "The API moved to gRPC in KAN-1.",
        "Noted: the API page will say gRPC.",
    ]
    assert thread["comments"][0]["author"] == "An Nguyen"
    await c.patch(f"/projects/{pid}/docs/ai", json={"enabled": False})
    quiet = await messaging.deliver_to_page(page, "Another note.", by="An Nguyen")
    assert quiet["delivered"] == "page_comment" and "job_id" not in quiet
    with pytest.raises(ValueError):
        await messaging.deliver_to_page("nope", "x", by="An Nguyen")
