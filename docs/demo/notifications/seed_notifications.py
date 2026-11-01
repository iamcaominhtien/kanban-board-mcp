"""Demo data for the Notifications demo (docs/demo/notifications/notifications_demo.js).

Run it against a board started by hand (development: nothing checks the window secret), with the fake CLI of the
server tests as the AI members' CLI, from the `server` folder so the board's own modules are importable:

    cd server
    KANBAN_DB_PATH=/tmp/notif-demo/kanban.db uv run python ../docs/demo/notifications/seed_notifications.py setup
    KANBAN_DB_PATH=/tmp/notif-demo/kanban.db uv run python ../docs/demo/notifications/seed_notifications.py finish8
    KANBAN_DB_PATH=/tmp/notif-demo/kanban.db uv run python ../docs/demo/notifications/seed_notifications.py needs

`setup` makes three projects (Kanban Board KAN, Mobile App MOB, Marketing Site MKT), people and seven AI members, and
tickets AGT-13..AGT-20 on a project "AGY live test". `finish8` puts eight runs in "running" and, a few seconds later,
finishes them all (what used to pile eight toasts). `needs` makes the Needs you side: a question from BA Bao on
KAN-215, an approval from Dev An on KAN-212, a failed run on MOB-77, a signed-out account, a published page and a
reply in a followed thread. `daycard` writes today's card. The steps write through the board's own services, as the
features do, against the same database file; the running server announces the change to the open window.
"""

import asyncio
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

BASE = os.environ.get("BOARD", "http://127.0.0.1:8000").rstrip("/")
ROOT = Path(__file__).resolve().parents[3]
FAKE = str(ROOT / "server" / "tests" / "fixtures" / "fake_claude.py")
REPO = os.environ.get("DEMO_REPO", "/tmp/notif-demo/repo")
c = httpx.Client(base_url=BASE, timeout=60)

sys.path.insert(0, str(ROOT / "server"))


def ok(r: httpx.Response):
    if r.status_code >= 400:
        sys.exit(f"{r.request.method} {r.request.url.path}: {r.status_code} {r.text[:300]}")
    return r.json() if r.content else None


def project(name: str, prefix: str, color: str) -> str:
    for p in ok(c.get("/projects")):
        if p["prefix"] == prefix:
            return p["id"]
    return ok(c.post("/projects", json={"name": name, "prefix": prefix, "color": color}))["id"]


def member(pid: str, name: str, role: str = "member") -> dict:
    for m in ok(c.get(f"/projects/{pid}/members")):
        if m["name"] == name:
            return m
    return ok(c.post(f"/projects/{pid}/members", json={"name": name, "role": role}))


def ai(pid: str, name: str) -> dict:
    for m in ok(c.get(f"/projects/{pid}/ai/members")):
        if m["name"] == name:
            return m
    return ok(
        c.post(
            f"/projects/{pid}/ai/members",
            json={"name": name, "provider": "claude-code", "working_dir": REPO, "cli_path": FAKE, "model": "haiku"},
        )
    )


def ticket(pid: str, title: str, status: str = "in-progress") -> str:
    return ok(c.post(f"/projects/{pid}/tickets", json={"title": title, "status": status}))["id"]


def state() -> dict:
    path = Path(os.environ.get("KANBAN_DB_PATH", "/tmp/notif-demo/kanban.db")).with_name("demo-state.json")
    return json.loads(path.read_text()) if path.exists() else {}


def save(s: dict) -> None:
    path = Path(os.environ.get("KANBAN_DB_PATH", "/tmp/notif-demo/kanban.db")).with_name("demo-state.json")
    path.write_text(json.dumps(s, indent=2))


def setup() -> None:
    Path(REPO).mkdir(parents=True, exist_ok=True)
    s: dict = {}
    s["kan"] = project("Kanban Board", "KAN", "#2E6F40")
    s["mob"] = project("Mobile App", "MOB", "#3A6EA5")
    s["mkt"] = project("Marketing Site", "MKT", "#B4562E")
    s["agy"] = project("AGY live test", "AGT", "#7A5AA8")
    for pid in (s["kan"], s["mob"], s["agy"]):
        member(pid, "Hoa Mai", "admin")
        member(pid, "Tuan Vo")
    s["ai"] = {}
    for name in ("Reviewer Rin", "Dev Gem", "Dev An", "QA Quy", "BA Bao", "Tester", "Designer AI"):
        s["ai"][name] = ai(s["agy"], name)["id"]
    s["kan_ai"] = {n: ai(s["kan"], n)["id"] for n in ("BA Bao", "Dev An", "Reviewer Rin")}
    s["mob_ai"] = {"QA Quy": ai(s["mob"], "QA Quy")["id"]}
    # Tickets with the numbers of the design (AGT-13..20, KAN-208/212/215, MOB-77)
    s["agt"] = []
    while True:
        tid = ticket(s["agy"], "Live test task")
        n = int(tid.split("-")[1])
        if n >= 13:
            s["agt"].append(tid)
        if n >= 20:
            break
    kan: dict = {}
    while True:
        tid = ticket(s["kan"], "Export tickets")
        n = int(tid.split("-")[1])
        if n in (208, 212, 215):
            kan[str(n)] = tid
        if n >= 215:
            break
    s["kan_t"] = kan
    mob = None
    while mob is None or int(mob.split("-")[1]) < 77:
        mob = ticket(s["mob"], "Offline sync")
    s["mob77"] = mob
    titles = {
        "215": "Export: include archived tickets?",
        "212": "Assign the release checklist",
        "208": "Acceptance criteria for search",
    }
    for n, tid in kan.items():
        ok(c.patch(f"/tickets/{tid}", json={"title": titles[n]}))
    ok(c.patch(f"/tickets/{mob}", json={"title": "Offline sync: retry queue"}))
    save(s)
    print("setup done", json.dumps({k: v for k, v in s.items() if k in ("kan", "mob", "agy")}))


async def _runs(pid: str, member_ids: list[str], tickets: list[str], state_: str) -> list[str]:
    import database
    from models import AiRun

    ids = []
    async with database.async_session() as session:
        for mid, tid in zip(member_ids, tickets):
            run = AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=mid,
                state=state_,
                started_at=datetime.now(UTC).isoformat(),
                summary=None,
            )
            session.add(run)
            await session.commit()
            ids.append(run.id)
    return ids


async def finish8() -> None:
    """Eight AI members start, then all finish within seconds: the case of section B."""
    import database
    from models import AiRun
    from services import notifications as centre

    s = state()
    order = ["Reviewer Rin", "Dev Gem", "Dev An", "QA Quy", "QA Quy", "Reviewer Rin", "Dev An", "BA Bao"]
    ids = await _runs(s["agy"], [s["ai"][n] for n in order], s["agt"][:8], "running")
    s["finish8"] = ids
    save(s)
    await asyncio.sleep(float(os.environ.get("FINISH_AFTER", "6")))
    summaries = [
        "Review done: two naming nits, nothing blocking.",
        "Implemented the export endpoint; tests pass.",
        "Fixed the retry backoff.",
        "All 12 test cases pass.",
        "Smoke test on staging passed.",
        "Summary asks for a look: the migration renames a column.",
        "Refactored the queue worker.",
        "Wrote the acceptance criteria.",
    ]
    for rid, text in zip(ids, summaries):
        async with database.async_session() as session:
            run = await session.get(AiRun, rid)
            run.state = "finished"
            run.ended_at = datetime.now(UTC).isoformat()
            run.summary = text
            run.cost_usd = 0.12
            session.add(run)
            await session.commit()
        await centre.on_run_ended(rid)
        await asyncio.sleep(0.3)
    print("eight finished")


async def needs() -> None:
    import database
    from models import AiAccount, AiApproval, AiMember, AiRun
    from services import notifications as centre
    from services.ai import safety

    s = state()
    kan, k = s["kan"], s["kan_t"]
    # BA Bao asks a question on KAN-215 (its run pauses); the fake CLI resumes it when it is answered
    [q] = await _runs(kan, [s["kan_ai"]["BA Bao"]], [k["215"]], "needs_input")
    async with database.async_session() as session:
        run = await session.get(AiRun, q)
        run.session_id = "demo-session"
        run.question = json.dumps(
            {
                "text": "Should the export include archived tickets?",
                "options": ["Yes", "No"],
                "to": "user",
                "asked_at": (datetime.now(UTC) - timedelta(minutes=41)).isoformat(),
            }
        )
        session.add(run)
        await session.commit()
    await centre.on_run_question(q)
    # Dev An wants to change an assignee on KAN-212
    [r212] = await _runs(kan, [s["kan_ai"]["Dev An"]], [k["212"]], "running")
    async with database.async_session() as session:
        a = AiApproval(
            project_id=kan,
            member_id=s["kan_ai"]["Dev An"],
            run_id=r212,
            ticket_id=k["212"],
            action="change_assignee",
            summary="Assign KAN-212 to Tester when done.",
            risk="low",
            expires_at=(datetime.now(UTC) + timedelta(hours=24)).isoformat(),
        )
        session.add(a)
        await session.commit()
        aid = a.id
    await safety.notify(
        kan,
        "approval_requested",
        "Dev An wants to change an assignee",
        "Assign KAN-212 to Tester when done. Risk: low.",
        ref_kind="approval",
        ref_id=aid,
        member_id=s["kan_ai"]["Dev An"],
    )
    # Run #3 on MOB-77 failed
    [f] = await _runs(s["mob"], [s["mob_ai"]["QA Quy"]], [s["mob77"]], "failed")
    async with database.async_session() as session:
        run = await session.get(AiRun, f)
        run.number = 3
        run.ended_at = datetime.now(UTC).isoformat()
        run.ended_reason = "The CLI exited with code 1 at step 12. Nothing was committed."
        session.add(run)
        await session.commit()
    await centre.on_run_ended(f)
    # Work Claude is signed out (three members stopped)
    async with database.async_session() as session:
        acc = AiAccount(
            name="Work Claude",
            cli="claude",
            folder="/tmp/notif-demo/acc",
            status="needs_sign_in",
            signed_out_at=datetime.now(UTC).isoformat(),
            signed_out_how="run",
        )
        session.add(acc)
        await session.commit()
        for mid in s["kan_ai"].values():
            prof = await session.get(AiMember, mid)
            prof.account_id = acc.id
            session.add(prof)
        await session.commit()
    # Updates: a page published in a followed space, a reply in a followed thread, a memory restart
    async with database.async_session() as session:
        await centre.set_follow(session, "user", scope="space", scope_id=kan, level="follow", project_id=kan)
    await centre.on_page_published(
        {"id": "demo-page", "project_id": kan, "title": "API", "version": 14, "updated_by": "Hoa Mai", "path": "Architecture › API"},
        "Rate limits section rewritten.",
    )
    await centre.emit(
        "comment",
        project_id=kan,
        recipients=["user"],
        title="New reply in a thread you follow",
        body="Tuan Vo: “Agreed, let us keep the error in the field.”",
        actor="Tuan Vo",
        data={"page_title": "Login redesign"},
    )
    await centre.emit(
        "schedule",
        project_id=kan,
        recipients=["user"],
        title="Nightly check finished",
        body="4 of 4 checks passed · 6 min · $0.04",
        ticket_id=k["208"],
        target_kind="run",
    )
    # the running server notes the signed-out account and closes rows (its loop); doing it here too would race it
    print("needs done", q, aid, f)


async def daycard() -> None:
    from services import notifications as centre

    print("day cards", await centre.write_day_cards(force_for="user"))


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "setup"
    if step == "setup":
        setup()
    else:
        asyncio.run({"finish8": finish8, "needs": needs, "daycard": daycard}[step]())
