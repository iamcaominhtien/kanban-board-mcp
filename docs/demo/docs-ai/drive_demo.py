"""Drives the demo board with the real Claude Code member and writes what happened to /tmp/demo/evidence.json:
Ask on a page, a tag in a thread, the freshness check and a suggested edit, a chat about the page. The page session
table then shows one session for all of them.

    cd server && uv run python ../docs/demo/docs-ai/drive_demo.py http://localhost:8765 /tmp/demo/kanban.db
"""

import json
import sqlite3
import sys
import time

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
DB = sys.argv[2] if len(sys.argv) > 2 else "/tmp/demo/kanban.db"
H = {"X-Actor": "An Nguyen"}
c = httpx.Client(base_url=BASE, headers=H, timeout=180)


def ok(r):
    assert r.status_code < 300, (r.request.url, r.status_code, r.text)
    return r.json()


def wait_job(job_id, limit=240):
    end = time.time() + limit
    while time.time() < end:
        j = ok(c.get(f"/docs/ai/jobs/{job_id}"))
        if j["state"] not in ("queued", "running"):
            return j
        time.sleep(1.5)
    raise SystemExit(f"job {job_id} stuck")


pid = ok(c.get("/projects"))[0]["id"]
tree = ok(c.get(f"/projects/{pid}/docs/tree"))
page_id = next(n["id"] for n in tree if n["title"] == "API")
member = next(m for m in ok(c.get(f"/projects/{pid}/members")) if m["name"] == "Reviewer")
ev = {"page_id": page_id, "steps": []}

RESUME = "--resume" in sys.argv  # steps 1 and 2 and the check were already done (the check needs a changed ticket first)
if not RESUME:
  # 1. Ask this page
  j = ok(c.post(f"/projects/{pid}/docs/ai/ask", json={"question": "How are rate limits handled?", "scope": "page", "page_id": page_id}))
  j = wait_job(j["id"])
  ev["steps"].append({"what": "Ask this page", "job": j["id"], "state": j["state"], "answer": (j["result"] or {}).get("answer")})

  # 2. A tag in a thread
  body = f"Is the Limits section still true? @[Reviewer](member:{member['id']})"
  t = ok(c.post(f"/docs/pages/{page_id}/comments", json={"kind": "inline", "body": body, "anchor": {"quote": "Rate limits are not enforced yet."}}))
  d = t["ai_delivery"][0]
  j = wait_job(d["job_id"])
  ev["steps"].append({"what": "Tag in a thread", "job": j["id"], "state": j["state"], "thread_id": t["id"]})

# 3. Freshness check, then a suggested edit (a proposal)
if not RESUME:
    # the page depends on KAN-1: change it after the page was published, so the check has something to compare
    c.post("/tickets/KAN-1/comments", json={"text": "Shipped in 1.4: rate limits are now enforced on all public endpoints (60 requests per minute per token).", "author": "Hoa Mai"})
    ok(c.post(f"/docs/pages/{page_id}/ai/freshness"))
    for _ in range(90):
        f = ok(c.get(f"/docs/pages/{page_id}/ai/freshness"))
        if f.get("reasons"):
            break
        time.sleep(2)
f = ok(c.get(f"/docs/pages/{page_id}/ai/freshness"))
ev["freshness"] = f
sj = ok(c.post(f"/docs/pages/{page_id}/ai/freshness/suggest"))
sj = wait_job(sj["id"])
ev["steps"].append({"what": "Suggested edit", "job": sj["id"], "state": sj["state"], "result": sj["result"]})

# 4. Chat about the page
chat = ok(c.post(f"/projects/{pid}/ai/assist/chats", json={"scope": "doc", "doc_id": page_id}))
m = ok(c.post(f"/ai/assist/chats/{chat['id']}/messages", json={"text": "Which ticket did I mention in the thread?"}))
mid = m["ai"]["id"]
for _ in range(120):
    msg = ok(c.get(f"/ai/assist/messages/{mid}"))
    if msg["state"] not in ("thinking", "streaming", "queued"):
        break
    time.sleep(1.5)
ev["steps"].append({"what": "Chat about the page", "state": msg["state"], "answer": msg.get("text")})

db = sqlite3.connect(DB)
ev["sessions"] = [dict(zip(("scope", "member", "session_id", "calls"), r)) for r in db.execute("select scope, member_id, session_id, calls from docs_ai_session")]
ev["jobs"] = [dict(zip(("kind", "session_id"), r)) for r in db.execute("select kind, session_id from docs_ai_job where page_id=? order by queued_at", (page_id,))]
json.dump(ev, open("/tmp/demo/evidence.json", "w"), indent=1, default=str)
print(json.dumps({"sessions": ev["sessions"], "jobs": ev["jobs"], "steps": [(s["what"], s["state"]) for s in ev["steps"]]}, indent=1))
