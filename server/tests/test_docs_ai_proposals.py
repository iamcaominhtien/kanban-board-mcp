"""Docs AI proposals (docs-ai-care B): an AI member's page edit becomes a proposal (or a private draft), a person
accepts changes into their own draft and publishes; an AI never decides; proposals expire."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import select

import database
from models import (
    AiApproval,
    AiAudit,
    AiNotification,
    DocsAiProposal,
    DocsDraft,
    DocsPage,
    Ticket,
)
from services.ai import approvals as svc_approvals
from services.ai import guard
from services.docs_ai import DocsAiError, proposals
from tests.docs_ai_helpers import H, env, page  # noqa: F401
from tests.test_ai import _ctx

TEXT = (
    "## Endpoints\n\n"
    "Failed webhook deliveries are retried. Retries are not implemented yet.\n\n"
    "| Method | Path |\n|---|---|\n| GET | /tickets |\n\n"
    "## Rollout checklist\n\n"
    "- [ ] Webhook retries\n"
)
NEW = (
    "## Endpoints\n\n"
    "Failed webhook deliveries are retried. Each failed delivery is retried 5 times with backoff.\n\n"
    "| Method | Path |\n|---|---|\n| GET | /tickets |\n| POST | /webhooks/{id}/retry |\n\n"
    "## Rollout checklist\n\n"
    "- [x] Webhook retries\n"
)


async def _setup(env, *, template="developer", enabled=True, mode="proposal"):
    ctx, pid, an, m, tid = await _ctx(env, template=template)
    c = env["c"]
    r = await c.patch(
        f"/projects/{pid}/docs/ai",
        json={"enabled": enabled, "member_id": m["id"], "edits_mode": mode},
    )
    assert r.status_code == 200, r.text
    p = await page(c, pid, "API", TEXT)
    return c, ctx, pid, m, tid, p


async def _ai_update(ctx, page_id, markdown=NEW, base_version=1, **extra):
    from kanban_mcp.tools import docs_write

    tokens = guard.enter(ctx)
    try:
        return await docs_write(
            action="update",
            page_id=page_id,
            markdown=markdown,
            base_version=base_version,
            note="KAN-31 added retries",
            **extra,
        )
    finally:
        guard.leave(tokens)


async def _published(c, page_id):
    return (await c.get(f"/docs/pages/{page_id}", headers=H)).json()


async def test_an_ai_edit_becomes_a_proposal_and_changes_nothing_published(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    out = await _ai_update(ctx, p["id"])
    assert out["published"] is False and out["status"] == "waiting"
    assert "nothing was changed" in out["message"]
    cur = await _published(c, p["id"])
    assert cur["version"] == 1 and cur["markdown"] == TEXT
    listed = (await c.get(f"/docs/pages/{p['id']}/ai/proposals", headers=H)).json()
    assert listed["can_review"] is True
    prop = listed["proposals"][0]
    assert (
        prop["status"] == "waiting"
        and prop["member_name"] == m["name"]
        and prop["ticket_id"] == tid
    )
    assert prop["on_behalf_of"] == "An Nguyen" and prop["base_version"] == 1
    assert (
        len(prop["changes"]) == 3
        and prop["still_apply"] == 3
        and prop["expires_in_days"] == 7
    )
    assert all("KAN-31 added retries" in ch["reason"] for ch in prop["changes"])
    assert prop["changes"][0]["section"] == "Endpoints"
    # the tree dot
    assert (
        await c.get(f"/projects/{pid}/docs/ai/proposals/pages", headers=H)
    ).json() == [p["id"]]
    async with database.async_session() as s:
        a = await s.get(AiApproval, prop["approval_id"])
        assert a.action == "edit_docs" and a.risk == "medium" and a.status == "pending"
        assert (
            a.on_behalf_of == "An Nguyen"
            and json.loads(a.payload)["proposal_id"] == prop["id"]
        )
        assert a.summary.startswith("Edit doc · API")
        notes = (
            await s.exec(select(AiNotification).where(AiNotification.ref_id == a.id))
        ).all()
        assert (
            len(notes) == 1
            and notes[0].title == f"{m['name']} proposed 3 changes to API"
        )
        audit = (
            await s.exec(select(AiAudit).where(AiAudit.result == "proposed"))
        ).all()
        assert len(audit) == 1 and audit[0].target == p["id"]
    # it is listed in Approvals with the proposal id
    rows = (await c.get(f"/projects/{pid}/ai/approvals")).json()
    assert any(r.get("proposal_id") == prop["id"] for r in rows)


async def test_docs_ai_off_keeps_the_old_behaviour(env):
    c, ctx, pid, m, tid, p = await _setup(env, template="custom", enabled=False)
    out = await _ai_update(ctx, p["id"])
    assert out["published"] is True and out["version"] == 2
    assert (await _published(c, p["id"]))["markdown"] == NEW
    async with database.async_session() as s:
        assert (await s.exec(select(DocsAiProposal))).all() == []


async def test_direct_mode_is_the_default_and_the_ai_edit_is_made(env):
    c, ctx, pid, m, tid, p = await _setup(env, template="custom", mode="direct")
    out = await _ai_update(ctx, p["id"])
    assert out["published"] is True and out["version"] == 2
    cur = await _published(c, p["id"])
    assert cur["markdown"] == NEW
    versions = (await c.get(f"/docs/pages/{p['id']}/versions", headers=H)).json()
    assert [v["with_ai"] for v in versions if v["version"] == 2] == [True]
    async with database.async_session() as s:
        assert (await s.exec(select(DocsAiProposal))).all() == []


async def test_direct_mode_still_refuses_a_page_hidden_from_ai(env):
    c, ctx, pid, m, tid, p = await _setup(env, template="custom", mode="direct")
    await c.patch(f"/docs/pages/{p['id']}/ai", json={"hidden": True}, headers=H)
    with pytest.raises(Exception) as exc:
        await _ai_update(ctx, p["id"])
    assert "hidden from AI" in str(exc.value)
    assert (await _published(c, p["id"]))["markdown"] == TEXT


async def test_draft_mode_saves_a_private_draft_for_the_person(env):
    c, ctx, pid, m, tid, p = await _setup(env, mode="draft")
    out = await _ai_update(ctx, p["id"])
    assert out["draft_for"] == "An Nguyen" and "Nothing was published" in out["message"]
    cur = await _published(c, p["id"])
    assert cur["version"] == 1 and cur["markdown"] == TEXT
    assert (
        cur["draft"]["markdown"] == NEW
        and cur["draft"]["ai_source"]["member_id"] == m["id"]
    )
    async with database.async_session() as s:
        assert (await s.exec(select(DocsAiProposal))).all() == []
    # nobody else sees it
    assert (await c.get(f"/docs/pages/{p['id']}")).json()["draft"] is None


async def test_accepting_a_change_writes_the_reviewers_draft_only(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    out = await _ai_update(ctx, p["id"])
    r = await c.post(
        f"/docs/ai/proposals/{out['proposal_id']}/changes/1/accept", headers=H
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "waiting" and d["changes"][0]["status"] == "accepted"
    cur = await _published(c, p["id"])
    assert cur["version"] == 1 and cur["markdown"] == TEXT  # nothing published
    assert "retried 5 times with backoff" in cur["draft"]["markdown"]
    assert "/webhooks/{id}/retry" not in cur["draft"]["markdown"]
    # the board's user has no draft: it went into the reviewer's own draft
    assert (await c.get(f"/docs/pages/{p['id']}")).json()["draft"] is None
    # publishing stays a person's manual step
    r = await c.post(
        f"/docs/pages/{p['id']}/publish", json={"base_version": 1}, headers=H
    )
    assert r.status_code == 200 and (await _published(c, p["id"]))["version"] == 2


async def test_accept_all_reject_all_and_edit(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    out = await _ai_update(ctx, p["id"])
    pid_ = out["proposal_id"]
    r = await c.post(
        f"/docs/ai/proposals/{pid_}/changes/1",
        json={"new": "Failed webhook deliveries are retried. Up to 5 times."},
        headers=H,
    )
    assert r.status_code == 200 and r.json()["changes"][0]["new"].endswith(
        "Up to 5 times."
    )
    r = await c.post(f"/docs/ai/proposals/{pid_}/accept-all", json={}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"
    draft = (await _published(c, p["id"]))["draft"]["markdown"]
    assert (
        "Up to 5 times." in draft
        and "/webhooks/{id}/retry" in draft
        and "- [x] Webhook retries" in draft
    )
    async with database.async_session() as s:
        prop = await s.get(DocsAiProposal, pid_)
        assert (await s.get(AiApproval, prop.approval_id)).status == "approved"
    assert (
        await c.get(f"/projects/{pid}/docs/ai/proposals/pages", headers=H)
    ).json() == []
    # a second proposal, rejected with a reason: the AI member sees it
    out2 = await _ai_update(
        ctx, p["id"], markdown=TEXT.replace("not implemented yet", "done")
    )
    r = await c.post(
        f"/docs/ai/proposals/{out2['proposal_id']}/reject-all",
        json={"note": "Not merged yet"},
        headers=H,
    )
    assert (
        r.json()["status"] == "rejected"
        and r.json()["decision_note"] == "Not merged yet"
    )
    async with database.async_session() as s:
        prop = await s.get(DocsAiProposal, out2["proposal_id"])
        assert (await s.get(AiApproval, prop.approval_id)).status == "denied"
        ticket = await s.get(Ticket, tid)
        assert "Not merged yet" in ticket.comments
    from kanban_mcp.tools import docs_read

    tokens = guard.enter(ctx)
    try:
        got = await docs_read(action="get", page_id=p["id"])
    finally:
        guard.leave(tokens)
    assert any(
        x["status"] == "rejected" and x["reason"] == "Not merged yet"
        for x in got["your_proposals"]
    )


async def test_a_stale_change_cannot_be_accepted_and_page_changed_since(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    out = await _ai_update(ctx, p["id"])
    # a person changes the sentence change 1 replaces and publishes v2
    await c.put(
        f"/docs/pages/{p['id']}/draft",
        json={"markdown": TEXT.replace("not implemented yet", "being built")},
        headers=H,
    )
    await c.post(f"/docs/pages/{p['id']}/publish", json={"base_version": 1}, headers=H)
    await c.delete(f"/docs/pages/{p['id']}/draft", headers=H)
    prop = (await c.get(f"/docs/pages/{p['id']}/ai/proposals", headers=H)).json()[
        "proposals"
    ][0]
    assert (
        prop["changed_since"] is True
        and prop["page_version"] == 2
        and prop["base_version"] == 1
    )
    assert prop["still_apply"] == 2 and prop["changes"][0]["stale"] is True
    r = await c.post(
        f"/docs/ai/proposals/{out['proposal_id']}/changes/1/accept", headers=H
    )
    assert r.status_code == 409 and r.json()["code"] == "stale"
    r = await c.post(
        f"/docs/ai/proposals/{out['proposal_id']}/accept-all", json={}, headers=H
    )
    d = r.json()
    assert d["status"] == "partial" and [x["status"] for x in d["changes"]] == [
        "pending",
        "accepted",
        "accepted",
    ]


async def test_the_ai_cannot_decide_its_own_proposal(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    out = await _ai_update(ctx, p["id"])
    async with database.async_session() as s:
        with pytest.raises(DocsAiError) as exc:
            await proposals.decide_all(s, out["proposal_id"], by=m["name"], accept=True)
        assert exc.value.code == "forbidden"
    async with database.async_session() as s:
        with pytest.raises(DocsAiError) as exc:
            tokens = guard.enter(ctx)
            try:
                await proposals.decide_all(
                    s, out["proposal_id"], by="An Nguyen", accept=True
                )
            finally:
                guard.leave(tokens)
        assert exc.value.code == "forbidden"
        approval_id = (await s.get(DocsAiProposal, out["proposal_id"])).approval_id
    with pytest.raises(svc_approvals.ApprovalForbidden):
        await svc_approvals.decide(approval_id, by=m["name"], approve=True)
    # the person it acts for approves through Approvals: changes go into their draft
    r = await c.post(f"/ai/approvals/{approval_id}/approve", json={}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    assert "retried 5 times" in (await _published(c, p["id"]))["draft"]["markdown"]
    assert (await _published(c, p["id"]))["version"] == 1


async def test_a_viewer_cannot_decide(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    await c.post(f"/projects/{pid}/members", json={"name": "Mia", "role": "viewer"})
    out = await _ai_update(ctx, p["id"])
    mia = {"X-Actor": "Mia"}
    listed = (await c.get(f"/docs/pages/{p['id']}/ai/proposals", headers=mia)).json()
    assert listed == {"proposals": [], "can_review": False}
    r = await c.post(
        f"/docs/ai/proposals/{out['proposal_id']}/changes/1/accept", headers=mia
    )
    assert r.status_code == 403 and r.json()["code"] == "viewer"


async def test_proposals_expire_with_nothing_changed(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    out = await _ai_update(ctx, p["id"])
    async with database.async_session() as s:
        prop = await s.get(DocsAiProposal, out["proposal_id"])
        prop.expires_at = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
        s.add(prop)
        await s.commit()
        assert await proposals.expire_due(s) == 1
        prop = await s.get(DocsAiProposal, out["proposal_id"])
        assert prop.status == "expired"
        assert (await s.get(AiApproval, prop.approval_id)).status == "expired"
        assert (
            await s.exec(select(AiAudit).where(AiAudit.result == "expired"))
        ).first() is not None
    assert (await _published(c, p["id"]))["markdown"] == TEXT
    r = await c.post(
        f"/docs/ai/proposals/{out['proposal_id']}/accept-all", json={}, headers=H
    )
    assert r.status_code == 409


async def test_a_hidden_page_is_refused(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    await c.patch(f"/docs/pages/{p['id']}/ai", json={"hidden": True}, headers=H)
    with pytest.raises(Exception) as exc:
        await _ai_update(ctx, p["id"])
    assert "hidden from AI" in str(exc.value)
    async with database.async_session() as s:
        assert (await s.exec(select(DocsAiProposal))).all() == []
        assert (await s.get(DocsPage, p["id"])).version == 1


async def test_endpoints_are_off_when_docs_ai_is_off(env):
    c, ctx, pid, m, tid, p = await _setup(env, enabled=False)
    r = await c.get(f"/docs/pages/{p['id']}/ai/proposals", headers=H)
    assert r.status_code == 409 and r.json()["code"] == "docs_ai_off"


def test_text_changes_are_block_level_and_unique():
    old = "## A\n\nSame.\n\n## B\n\nSame.\n\nEnd."
    new = "## A\n\nSame.\n\n## B\n\nChanged.\n\nEnd."
    ch = proposals.text_changes(old, new)
    assert len(ch) == 1 and ch[0]["section"] == "B"
    assert proposals.occurrences(old, ch[0]["old"]) == 1
    assert proposals.apply_change(old, ch[0]) == new
    assert proposals.apply_change("nothing", ch[0]) is None


async def test_draft_rows_are_per_person(env):
    c, ctx, pid, m, tid, p = await _setup(env)
    out = await _ai_update(ctx, p["id"])
    await c.post(f"/docs/ai/proposals/{out['proposal_id']}/changes/2/accept", headers=H)
    async with database.async_session() as s:
        drafts = (
            await s.exec(select(DocsDraft).where(DocsDraft.page_id == p["id"]))
        ).all()
    assert [d.author for d in drafts] == ["An Nguyen"]
