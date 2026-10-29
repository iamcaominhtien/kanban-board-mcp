"""The Board AI proposes AI members; a person edits and approves them. Nothing is created before that, nothing the
dialog guards with a confirmation can be smuggled in, and only an admin can approve."""

import json

from sqlmodel import select

from models import AiAudit
from services.ai.assist import member_drafts
from tests.test_ai_assist import H, _answer, _setup, fake  # noqa: F401
from tests.test_ai import _api_member, _project, env  # noqa: F401

ADMIN = {"X-Actor": "An Nguyen"}


def _block(members, text="Here is what I would create."):
    return f"{text}\n\n```kanban-actions\n{json.dumps({'ai_members': members})}\n```"


PROPOSAL = [
    {
        "name": "PM",
        "description": "Prepares tickets",
        "persona": "You are the PM. You never edit code.",
        "template": "read_only",
        "ceiling": "done",  # past Review: must be clamped
        "max_parallel": 99,
        "max_runs_per_day": 10,
        "api_key": "sk-ant\x2dapi03-zzzzzzzzzzzz3f9a",  # must never travel
        "bypass": True,
        "working_dir": "/etc",
        "why": "Someone has to prepare tickets",
    },
    {
        "name": "Reviewer",  # already a member (the Board AI itself)
        "persona": "x" * 1500,
        "template": "reviewer",
        "model": "sonnet",
    },
    {"name": "Dev", "template": "developer", "ceiling": "in progress"},
]


async def _make_admin(c, pid):
    members = (await c.get(f"/projects/{pid}/members")).json()
    an = next(m for m in members if m["name"] == "An Nguyen")
    r = await c.patch(f"/projects/{pid}/members/{an['id']}", json={"role": "admin"})
    assert r.status_code == 200, r.text


async def _propose(c, pid, fake, members=None, text="create a team"):
    fake.queue.append(_block(PROPOSAL if members is None else members))
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], text)
    assert msg["state"] == "done", msg
    return chat, msg


async def _names(c, pid):
    return sorted(
        m["name"] for m in (await c.get(f"/projects/{pid}/ai/members")).json()
    )


async def test_a_proposal_is_checked_and_nothing_is_created_until_approved(env, fake):
    c, pid, an, m = await _setup(env)
    before = await _names(c, pid)
    chat, msg = await _propose(c, pid, fake)
    d = msg["draft"]
    assert d["kind"] == "ai_members" and d["status"] == "open"
    pm, rev, dev = d["payload"]["members"]
    assert pm["ceiling"] == "review", (
        "past Review needs the owner's confirmation in the dialog"
    )
    assert pm["max_parallel"] == 10 and pm["read_only_cli"] is True
    assert rev["name"] == "Reviewer 2" and len(rev["persona"]) == 1000
    assert dev["ceiling"] == "in-progress" and dev["read_only_cli"] is False
    notes = " ".join(d["payload"]["problems"])
    for forbidden in ("api_key", "bypass", "working_dir"):
        assert f"Ignored “{forbidden}”" in notes
    assert "Reviewer” is already taken" in notes
    # nothing exists yet
    assert await _names(c, pid) == before


async def test_an_admin_edits_and_creates_the_chosen_members_as_themselves(env, fake):
    c, pid, an, m = await _setup(env)
    await _make_admin(c, pid)
    chat, msg = await _propose(c, pid, fake)
    d = msg["draft"]
    edited = d["payload"]["members"]
    edited[0]["name"] = "Product Manager"
    edited[0]["persona"] = "Edited by hand."
    r = await c.post(
        f"/ai/assist/drafts/{d['id']}/apply",
        json={"selected": [0, 2], "fields": {"members": edited}},
        headers=ADMIN,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "applied"
    created = r.json()["result"]["created"]
    assert [x["name"] for x in created] == ["Product Manager", "Dev"]
    assert await _names(c, pid) == sorted(["Reviewer", "Product Manager", "Dev"])
    pm = next(x for x in created if x["name"] == "Product Manager")
    full = (await c.get(f"/ai/members/{pm['id']}")).json()
    assert full["persona"] == "Edited by hand."
    assert full["template"] == "read_only" and full["ceiling"] == "review"
    assert full["config"]["allow_rules"] == member_drafts.READ_ONLY_ALLOW
    assert full["config"]["permission_mode"] == "allowlist"
    assert full["working_dir"] == env["repo"], (
        "the connection comes from the AI that proposed it"
    )
    dev = next(x for x in created if x["name"] == "Dev")
    assert (
        "Edit"
        in (await c.get(f"/ai/members/{dev['id']}")).json()["config"]["allow_rules"]
    )
    async with env["maker"]() as s:
        audit = (
            await s.exec(
                select(AiAudit).where(
                    AiAudit.action == "ai_member_created_via_assistant"
                )
            )
        ).all()
    assert {a.on_behalf_of for a in audit} == {"An Nguyen"} and len(audit) == 2
    # Undo removes what this draft created
    r = await c.post(f"/ai/assist/drafts/{d['id']}/undo", json={}, headers=ADMIN)
    assert r.json()["status"] == "undone" and r.json()["result"]["undo"]["undone"] == 2
    assert await _names(c, pid) == ["Reviewer"]


async def test_only_an_admin_can_approve(env, fake):
    c, pid, an, m = await _setup(env)  # An Nguyen is a plain member here
    chat, msg = await _propose(c, pid, fake)
    r = await c.post(
        f"/ai/assist/drafts/{msg['draft']['id']}/apply", json={}, headers=H
    )
    assert r.status_code == 403 and "admin" in r.json()["detail"]
    assert await _names(c, pid) == ["Reviewer"]


async def test_a_name_that_clashes_by_the_time_of_approval_is_reported(env, fake):
    c, pid, an, m = await _setup(env)
    await _make_admin(c, pid)
    chat, msg = await _propose(c, pid, fake, members=[{"name": "Solo"}])
    d = msg["draft"]
    # somebody added "Solo" while the proposal was open: the dialog's own name check refuses it again
    await c.post(f"/projects/{pid}/members", json={"name": "Solo"})
    r = await c.post(
        f"/ai/assist/drafts/{d['id']}/apply",
        json={"fields": {"members": [{"name": "Solo"}]}},
        headers=ADMIN,
    )
    assert r.status_code == 200, "the checker renames to Solo 2 instead of failing"
    assert r.json()["result"]["created"][0]["name"] == "Solo 2"


async def test_a_newer_proposal_replaces_the_open_one_and_the_model_sees_the_open_one(
    env, fake
):
    c, pid, an, m = await _setup(env)
    chat, first = await _propose(
        c, pid, fake, members=[{"name": "One"}, {"name": "Two"}]
    )
    fake.queue.append(_block([{"name": "One"}, {"name": "Two"}, {"name": "Three"}]))
    second = await _answer(c, chat["id"], "add a third one")
    sent = fake.prompts[-1]
    assert (
        "<open-proposal>" in sent
        and '"name": "One"' in sent
        and '"name": "Two"' in sent
    )
    old = (await c.get(f"/ai/assist/drafts/{first['draft']['id']}", headers=H)).json()
    assert old["status"] == "discarded" and second["draft"]["status"] == "open"
    assert [x["name"] for x in second["draft"]["payload"]["members"]] == [
        "One",
        "Two",
        "Three",
    ]


async def test_members_are_never_copied_from_an_api_key_board_ai(env, fake):
    c, pid, an, m = await _setup(env, board_ai=False)
    await _make_admin(c, pid)
    api = await _api_member(c, pid)
    await c.patch(f"/projects/{pid}/ai/settings", json={"board_ai_id": api["id"]})
    chat, msg = await _propose(c, pid, fake, members=[{"name": "Copy"}])
    d = msg["draft"]
    assert "API key is never copied" in d["payload"]["refusal"]
    r = await c.post(f"/ai/assist/drafts/{d['id']}/apply", json={}, headers=ADMIN)
    assert r.status_code == 422 and "never copied" in r.json()["detail"]
    assert "Copy" not in await _names(c, pid)


async def test_a_question_instead_of_a_proposal_creates_no_draft(env, fake):
    c, pid, an, m = await _setup(env)
    fake.queue.append(
        "Which stack does the repo use, and should the reviewer run tests?"
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "I need a reviewer")
    assert msg["state"] == "done" and not msg.get("draft")


def test_the_read_only_cli_lists_match_the_dialog_presets():
    from tests.test_ai_member_presets import PRESETS

    by = {p["id"]: p for p in PRESETS}
    assert by["pm"]["cliAllow"] == member_drafts.READ_ONLY_ALLOW
    assert by["reviewer"]["cliAllow"] == member_drafts.REVIEW_ALLOW


async def test_the_add_dialog_asks_for_one_member_and_creates_nothing(env, fake):
    """In the dialog the answer carries one checked member for the form to fill; no draft and no member are made."""
    c, pid, an, m = await _setup(env)
    before = await _names(c, pid)
    form = {"name": "", "persona": "", "template": "developer", "ceiling": "review"}
    fake.queue.append(
        _block(
            [
                {
                    "name": "Tester",
                    "persona": "You test.",
                    "template": "reviewer",
                    "ceiling": "done",
                    "api_key": "sk-ant\x2dapi03-zzzzzzzzzzzz3f9a",
                    "working_dir": "/etc",
                },
                {"name": "Second"},
            ],
            text="Here is a tester.",
        )
    )
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    msg = await _answer(c, chat["id"], "a tester", member_form=form)
    assert msg["state"] == "done" and msg["draft_id"] is None
    got = msg["context"]["member_form"]
    assert got["name"] == "Tester" and got["template"] == "reviewer"
    assert got["ceiling"] == "review", "past Review is clamped here too"
    assert "api_key" not in got and "working_dir" not in got
    assert "<form>" in fake.prompts[-1] and "<open-proposal>" not in fake.prompts[-1]
    assert await _names(c, pid) == before

    # the next message sends the form as the person has edited it since
    fake.queue.append(_block([{"name": "Tester", "persona": "You test hard."}]))
    form2 = {**form, "name": "Tester", "persona": "mine"}
    again = await _answer(c, chat["id"], "stricter", member_form=form2)
    assert '"persona": "mine"' in fake.prompts[-1]
    assert again["context"]["member_form"]["persona"] == "You test hard."


async def test_a_plain_chat_has_no_member_form(env, fake):
    c, pid, an, m = await _setup(env)
    chat, msg = await _propose(c, pid, fake, members=[{"name": "Solo"}])
    assert "member_form" not in msg["context"] and msg["draft"]["kind"] == "ai_members"
