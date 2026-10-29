"""Who may configure and operate AI members (design/screens/ai-safety-cost.md, H1): the role table of
`api/ai_roles.py`, owner confirmation of an admin's permission change, and the audit log scope per role."""

from api import ai_roles
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401


async def _people(c, pid):
    """An owner (the first admin), an admin, a member and a viewer."""
    for name, role in (
        ("Owner Olga", "admin"),
        ("Hoa Mai", "admin"),
        ("Tuan Vo", "member"),
        ("Linh Pham", "viewer"),
    ):
        r = await c.post(f"/projects/{pid}/members", json={"name": name, "role": role})
        assert r.status_code in (200, 201), r.text
    return {
        "owner": {"X-Actor": "Owner Olga"},
        "admin": {"X-Actor": "Hoa Mai"},
        "member": {"X-Actor": "Tuan Vo"},
        "viewer": {"X-Actor": "Linh Pham"},
    }


def test_rule_table():
    assert ai_roles.rule_for("POST", "/projects/p/ai/members") == (
        "admin",
        "add AI members",
    )
    assert ai_roles.rule_for("GET", "/projects/p/ai/members") is None
    assert ai_roles.rule_for("POST", "/ai/members/m/pause")[0] == "member"
    assert ai_roles.rule_for("POST", "/ai/members/m/resume")[0] == "admin"
    assert ai_roles.rule_for("PUT", "/projects/p/ai/workspace-defaults")[0] == "owner"
    assert ai_roles.rule_for("POST", "/tickets/KAN-1/ai/allow-more-runs")[0] == "owner"
    assert ai_roles.rule_for("POST", "/tickets/KAN-1/ai/run")[0] == "member"


async def test_roles_decide_who_configures_and_operates(env):
    c = env["c"]
    pid, _ = await _project(c)
    h = await _people(c, pid)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    # Viewers look but do not operate
    assert (
        await c.get(f"/projects/{pid}/ai/members", headers=h["viewer"])
    ).status_code == 200
    r = await c.post(
        f"/tickets/{tid}/ai/run", json={"member_id": m["id"]}, headers=h["viewer"]
    )
    assert (
        r.status_code == 403
        and r.json()["code"] == "forbidden"
        and r.json()["role"] == "viewer"
    )
    r = await c.post(f"/projects/{pid}/ai/pause-all", json={}, headers=h["viewer"])
    assert r.status_code == 403
    # Members pause but never resume, and do not add AI members or change budgets
    assert (
        await c.post(f"/ai/members/{m['id']}/pause", json={}, headers=h["member"])
    ).status_code == 200
    r = await c.post(f"/ai/members/{m['id']}/resume", headers=h["member"])
    assert r.status_code == 403 and "an admin or the owner" in r.json()["detail"]
    body = {
        "name": "Reviewer",
        "provider": "claude-code",
        "working_dir": env["repo"],
        "model": "haiku",
    }
    assert (
        await c.post(f"/projects/{pid}/ai/members", json=body, headers=h["member"])
    ).status_code == 403
    r = await c.patch(
        f"/projects/{pid}/ai/settings", json={"board_daily_cap": 5}, headers=h["member"]
    )
    assert r.status_code == 403
    # Admins do; workspace defaults stay with the owner
    assert (
        await c.post(f"/ai/members/{m['id']}/resume", headers=h["admin"])
    ).status_code == 200
    assert (
        await c.post(f"/projects/{pid}/ai/members", json=body, headers=h["admin"])
    ).status_code == 201
    r = await c.put(
        f"/projects/{pid}/ai/workspace-defaults", json={}, headers=h["admin"]
    )
    assert r.status_code == 403 and "the project owner" in r.json()["detail"]
    # Without X-Actor the board's own user acts, as the owner
    assert (await c.post(f"/ai/members/{m['id']}/pause", json={})).status_code == 200


async def test_admin_permission_change_waits_for_the_owner(env):
    c = env["c"]
    pid, _ = await _project(c)
    h = await _people(c, pid)
    m = await _runner(c, pid, env["repo"])
    mode = lambda d: {p["action"]: p["mode"] for p in d["matrix"]}  # noqa: E731
    before = (await c.get(f"/ai/members/{m['id']}/permissions")).json()
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"permissions": {"create_branches": "approval"}},
        headers=h["admin"],
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert (
        d["pendingChange" if "pendingChange" in d else "pending_change"]["by"]
        == "Hoa Mai"
    )
    after = (await c.get(f"/ai/members/{m['id']}/permissions")).json()
    assert (
        mode(after)["create_branches"] == mode(before)["create_branches"] == "allowed"
    )  # old setting stays
    # Only the owner decides
    r = await c.post(
        f"/ai/members/{m['id']}/permissions/pending/confirm", headers=h["admin"]
    )
    assert r.status_code == 403
    r = await c.post(
        f"/ai/members/{m['id']}/permissions/pending/confirm", headers=h["owner"]
    )
    assert r.status_code == 200, r.text
    assert r.json()["pending_change"] is None
    assert (
        mode((await c.get(f"/ai/members/{m['id']}/permissions")).json())[
            "create_branches"
        ]
        == "approval"
    )
    # The owner's own change applies at once
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"permissions": {"create_branches": "blocked"}},
        headers=h["owner"],
    )
    assert r.json()["pending_change"] is None
    assert (
        mode((await c.get(f"/ai/members/{m['id']}/permissions")).json())[
            "create_branches"
        ]
        == "blocked"
    )
    audit = (
        await c.get(
            f"/projects/{pid}/ai/audit",
            params={"actions": "permission_change_confirmed"},
        )
    ).json()
    assert audit["entries"] and audit["entries"][0]["detail"]["asked_by"] == "Hoa Mai"


async def test_audit_log_scope_per_role(env):
    c = env["c"]
    pid, _ = await _project(c)
    h = await _people(c, pid)
    m = await _runner(c, pid, env["repo"])
    await c.post(f"/ai/members/{m['id']}/pause", json={}, headers=h["member"])
    await c.post(f"/ai/members/{m['id']}/resume", headers=h["admin"])
    assert (
        await c.get(f"/projects/{pid}/ai/audit", headers=h["viewer"])
    ).status_code == 403
    mine = (await c.get(f"/projects/{pid}/ai/audit", headers=h["member"])).json()[
        "entries"
    ]
    assert mine and {e["on_behalf_of"] for e in mine} == {"Tuan Vo"}
    everyone = (await c.get(f"/projects/{pid}/ai/audit", headers=h["admin"])).json()[
        "entries"
    ]
    assert len(everyone) > len(mine)
