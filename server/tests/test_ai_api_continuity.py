"""Continuity of API-key agents: the board's record of the ticket in the prompt, the work done before a question
after the answer, and compaction of a long session."""

import re


from services.ai import api_agent, api_prompt
from services.ai.providers import cheap_model, context_window
from tests.test_ai import _api_member, _project, _ticket, _wait, env  # noqa: F401


class Chat:
    """A scripted model that keeps its messages in the Anthropic shape, so compaction has real messages to fold."""

    def __init__(self, script):
        self.script = list(script)
        self.messages: list[dict] = []
        self.tools: list = []
        self.system = self.user = ""

    def start(self, system, user, tools):
        self.system, self.user, self.tools = system, user, tools
        self.messages = [{"role": "user", "content": user}]

    async def call(self, max_tokens):
        reply = self.script.pop(0)
        content = ([{"type": "text", "text": reply.text}] if reply.text else []) + [
            {"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["input"]}
            for c in reply.tool_calls
        ]
        self.messages.append({"role": "assistant", "content": content})
        return reply

    def add_results(self, results):
        self.messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": i, "content": c}
                    for i, c, _ in results
                ],
            }
        )

    def add_user(self, text):
        self.messages.append({"role": "user", "content": text})


def _say(text, tin=100, tout=20):
    return api_agent.Reply(text=text, tokens_in=tin, tokens_out=tout)


def _call(name, args, tin=100, tout=20, id_="1"):
    return api_agent.Reply(
        tool_calls=[{"id": id_, "name": name, "input": args}],
        tokens_in=tin,
        tokens_out=tout,
    )


def _chats(monkeypatch, *chats):
    """make_chat hands out the given chats in order and records them."""
    made = list(chats)
    given: list = []

    def make(*a, **k):
        chat = made.pop(0)
        given.append(chat)
        return chat

    monkeypatch.setattr(api_agent, "make_chat", make)
    return given


async def _run(c, tid, member_id, instruction="", start="now"):
    r = await c.post(
        f"/tickets/{tid}/ai/assign",
        json={"member_id": member_id, "start": start, "instruction": instruction},
        headers={"X-Actor": "An Nguyen"},
    )
    assert r.status_code == 200, r.text


async def test_api_agents_get_the_activity_block_with_their_own_and_others_runs(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    dev = await _api_member(c, pid, name="Dev")
    pm = await _api_member(c, pid, name="PM")
    tid = await _ticket(c, pid)
    given = _chats(
        monkeypatch,
        Chat([_say("Fixed add() and ran the tests.")]),
        Chat([_say("Dev fixed it.")]),
        Chat([_say("Second pass done.")]),
    )
    await _run(c, tid, dev["id"])
    await _wait(c, tid, ("finished",))
    assert "<activity" not in given[0].user  # nothing happened here before

    # a second agent: it sees what Dev did, fenced as data, and the preview shows the same source
    await c.patch(f"/tickets/{tid}", json={"status": "todo", "assignee": None})
    await _run(c, tid, pm["id"], "What has Dev done?")
    await _wait(c, tid, ("finished",))
    seen = given[1].user
    assert "<activity" in seen and "by Dev" in seen
    assert "Fixed add() and ran the tests." in seen
    assert '<untrusted source="run summary · AI member Dev">' in seen
    assert "by PM (you)" not in seen  # it has no earlier run here

    # Dev again: its own earlier run is marked, and so is PM's run since then
    await c.patch(f"/tickets/{tid}", json={"status": "todo", "assignee": None})
    await _run(c, tid, dev["id"])
    await _wait(c, tid, ("finished",))
    again = given[2].user
    assert "by Dev (you)" in again and "by PM" in again
    assert "Dev fixed it." in again

    async with env["maker"]() as s:
        from models import AiMember, Member, Project, Ticket
        from services.ai.config_model import estimate_tokens  # noqa: F401
        from services.ai.context import RunContext
        from services.ai.providers import merged_config
        from services.ai.store import loads

        ticket = await s.get(Ticket, tid)
        member = await s.get(Member, dev["id"])
        profile = await s.get(AiMember, dev["id"])
        ctx = RunContext("preview", member.id, member.name, pid, tid, "x", "work")
        out = await api_prompt.compose(
            s,
            profile,
            member,
            ticket,
            await s.get(Project, pid),
            merged_config(loads(profile.config, {})),
            ctx=ctx,
        )
    assert out["sources"]["activity"] > 0 and "by Dev (you)" in out["user"]


async def test_the_activity_block_is_cut_to_its_token_cap(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    dev = await _api_member(c, pid, name="Dev")
    pm = await _api_member(c, pid, name="PM")
    tid = await _ticket(c, pid)
    monkeypatch.setattr(api_prompt, "ACTIVITY_TOKENS", 200)
    _chats(monkeypatch, *[Chat([_say("x" * 380 + f" {n}")]) for n in range(5)])
    for _ in range(4):
        await c.patch(f"/tickets/{tid}", json={"status": "todo", "assignee": None})
        await _run(c, tid, dev["id"])
        await _wait(c, tid, ("finished",))
        runs_done = (await c.get(f"/tickets/{tid}/ai/runs")).json()
    assert len(runs_done) == 4
    given = _chats(monkeypatch, Chat([_say("ok")]))
    await c.patch(f"/tickets/{tid}", json={"status": "todo", "assignee": None})
    await _run(c, tid, pm["id"])
    await _wait(c, tid, ("finished",))
    block = given[0].user.split("<activity", 1)[1].split("</activity>")[0]
    assert (len(block) + 3) // 4 <= 260
    assert "Run #4" in block and "Run #1" not in block  # the oldest go first


async def test_an_answered_run_remembers_the_work_done_before_the_question(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, name="Dev")
    tid = await _ticket(c, pid)
    first = Chat(
        [
            _call("get_ticket", {"ticket_id": tid}, id_="a"),
            _call("ask_person", {"question": "Which file?"}, id_="b"),
        ]
    )
    second = Chat([_say("Used calc.py.")])
    _chats(monkeypatch, first, second)
    await _run(c, tid, m["id"])
    run = await _wait(c, tid, ("needs_input",))
    assert any(s.get("io", {}).get("name") == "get_ticket" for s in run["steps"])
    r = await c.post(f"/ai/runs/{run['id']}/answer", json={"text": "calc.py"})
    assert r.status_code == 200, r.text
    done = await _wait(c, tid, ("finished",))
    assert done["id"] == run["id"]
    resumed = second.user
    assert "Your own earlier work in this same run" in resumed
    assert "get_ticket(" in resumed and "ask_person(" in resumed
    assert '<untrusted source="your earlier tool calls">' in resumed
    assert "answered your question" in resumed and "calc.py" in resumed
    # the tokens and cost of the first part are not lost
    assert done["tokens_in"] == 100 + 100 + 100 and done["cost_usd"] > 0


def test_earlier_work_is_bounded_and_keeps_the_newest_steps():
    steps = [
        {
            "kind": "board",
            "text": "board.t",
            "io": {"name": "t", "in": f"{n}", "out": "o" * 200},
        }
        for n in range(200)
    ]
    text = api_prompt.earlier_work(steps, cap_tokens=300)
    assert "older tool call(s) left out" in text and "t(199)" in text
    assert "t(0)" not in text
    assert (len(text) + 3) // 4 < 450
    assert (
        api_prompt.earlier_work([{"kind": "start", "text": "Built the prompt"}]) == ""
    )
    after_compact = api_prompt.earlier_work(
        [
            {"kind": "board", "text": "x", "io": {"name": "old", "in": "", "out": ""}},
            {"kind": "compact", "text": "Long session compacted", "summary": "S-UM"},
            {"kind": "board", "text": "x", "io": {"name": "new", "in": "", "out": ""}},
        ]
    )
    assert (
        "S-UM" in after_compact
        and "new(" in after_compact
        and "old(" not in after_compact
    )


async def test_a_long_session_is_compacted_and_metered(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(
        c,
        pid,
        name="Dev",
        daily_budget=100,
        config={"max_tokens_per_run": 2_000_000, "max_steps": 20},
    )
    tid = await _ticket(c, pid)
    window = context_window("claude-haiku-5-5")
    big = int(window * 0.65)  # past the default 60 %
    main = Chat(
        [_call("get_ticket", {"ticket_id": tid}, tin=big, id_=str(n)) for n in range(4)]
        + [_say("All done.", tin=big)]
    )
    summary = Chat([_say("Read the ticket four times; nothing changed.", 5000, 100)])
    more = [Chat([_say("again", 4000, 80)]) for _ in range(4)]
    given = _chats(monkeypatch, main, summary, *more)
    await _run(c, tid, m["id"])
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    notes = [s for s in run["steps"] if s["kind"] == "compact"]
    assert notes and re.fullmatch(
        r"Long session compacted \([\d,]+ → [\d,]+ tokens\)", notes[0]["text"]
    )
    before, after = (
        int(x.replace(",", "")) for x in re.findall(r"[\d,]{3,}", notes[0]["text"])
    )
    assert after < before
    # the folded turns are in one summary on the first message, the newest turns stay
    head = main.messages[0]["content"]
    # a second compaction folds the first summary in again, and keeps one block
    assert head.count("<earlier_work>") == 1 and "again" in head
    assert "Read the ticket four times" in given[2].user
    assert len(main.messages) < 1 + 2 * 5
    assert given[1] is summary and summary.tools == []
    # the summary call is part of the run's tokens and cost, priced at the cheaper model
    main_in = big * 5 + 5 * 20
    assert run["tokens_in"] >= big * 5 + 5000
    cheap = cheap_model("anthropic", "claude-haiku-5-5")
    assert cheap == "claude-haiku-5-5"
    assert run["cost_usd"] > main_in / 1_000_000 * 1.0


async def test_compaction_that_fails_does_not_fail_the_run(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(
        c, pid, name="Dev", daily_budget=100, config={"max_tokens_per_run": 2_000_000}
    )
    tid = await _ticket(c, pid)
    big = int(context_window("claude-haiku-5-5") * 0.7)
    main = Chat(
        [_call("get_ticket", {"ticket_id": tid}, tin=big, id_=str(n)) for n in range(4)]
        + [_say("Done.", tin=big)]
    )
    broken = Chat([api_agent.ProviderError("outage", "503")])

    async def boom(max_tokens):
        raise api_agent.ProviderError("outage", "503")

    broken.call = boom
    _chats(monkeypatch, main, broken)
    await _run(c, tid, m["id"])
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished"
    assert not [s for s in run["steps"] if s["kind"] == "compact"]


async def test_compaction_waits_for_the_configured_share(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(
        c,
        pid,
        name="Dev",
        daily_budget=100,
        config={"max_tokens_per_run": 2_000_000, "compact_at_pct": 95},
    )
    tid = await _ticket(c, pid)
    mid = int(context_window("claude-haiku-5-5") * 0.7)  # above 60 %, below 95 %
    main = Chat(
        [_call("get_ticket", {"ticket_id": tid}, tin=mid, id_=str(n)) for n in range(4)]
        + [_say("Done.", tin=mid)]
    )
    _chats(monkeypatch, main)
    await _run(c, tid, m["id"])
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished"
    assert not [s for s in run["steps"] if s["kind"] == "compact"]
    assert "<earlier_work>" not in main.messages[0]["content"]


def test_split_for_compaction_never_separates_a_call_from_its_result():
    msgs = [{"role": "user", "content": "p"}]
    for n in range(4):
        msgs.append(
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": str(n), "name": "t", "input": {}}
                ],
            }
        )
        msgs.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": str(n), "content": "r"}
                ],
            }
        )
    head, tail = api_agent.split_for_compaction(msgs)
    assert head == 1 and msgs[tail]["role"] == "assistant" and tail == 5
    assert api_agent.split_for_compaction(msgs[:5]) is None
    oai = [{"role": "system", "content": "s"}, {"role": "user", "content": "p"}]
    for n in range(3):
        oai.append(
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": str(n), "function": {"name": "t", "arguments": "{}"}}
                ],
            }
        )
        oai.append({"role": "tool", "tool_call_id": str(n), "content": "r"})
    assert api_agent.split_for_compaction(oai) == (2, 4)
