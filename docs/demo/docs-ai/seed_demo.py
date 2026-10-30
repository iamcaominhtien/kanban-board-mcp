"""Seeds the throwaway board the Docs AI demo screenshots are taken from (run against a server on a temp database).

    KANBAN_DB_PATH=/tmp/demo/kanban.db uvicorn main:app --port 8765     # from server/
    python3 docs/demo/docs-ai/seed_demo.py http://localhost:8765 /tmp/demo/repo

One project "Kanban Board" with 3 people, 4 tickets and 7 pages, and one AI member "Reviewer" that is a real Claude Code
(Haiku) runner. The data is planted on purpose: the API page still says rate limits are not enforced while KAN-1 is
Done; Auth says tokens last 30 days while the Decision log says 90; the Meeting notes have unchecked items.
"""

import json
import subprocess
import sys
from pathlib import Path

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
REPO = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/demo/repo")
H = {"X-Actor": "An Nguyen"}
c = httpx.Client(base_url=BASE, headers=H, timeout=60)


def ok(r):
    assert r.status_code < 300, (r.request.url, r.status_code, r.text)
    return r.json() if r.content else None


REPO.mkdir(parents=True, exist_ok=True)
if not (REPO / ".git").exists():
    subprocess.run(["git", "init", "-q", str(REPO)], check=True)
    (REPO / "README.md").write_text("# Kanban Board demo repo\n")

p = ok(c.post("/projects", json={"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"}))
pid = p["id"]
for name, role in (("An Nguyen", "admin"), ("Hoa Mai", "member"), ("Tuan Vo", "member")):
    ok(c.post(f"/projects/{pid}/members", json={"name": name, "role": role}))


def ticket(title, status, description="", **extra):
    return ok(c.post(f"/projects/{pid}/tickets", json={"title": title, "status": status, "description": description, **extra}))


t1 = ticket("Webhook retries", "done", "Retry failed webhook deliveries 5 times with exponential backoff.")
t2 = ticket("Publish the OpenAPI spec", "todo")
t3 = ticket("Rotate API tokens from Settings", "in-progress", "Tokens can be rotated at any time; the old one keeps working for 24 hours.")
t4 = ticket(
    "Export activity log to CSV",
    "backlog",
    "Admins want to download the activity log as CSV for audits. Columns: time, actor, action, target. Filter by date range. "
    "Large exports must not block the board.",
)
ok(c.post(f"/tickets/{t4['id']}/comments", json={"text": "Hoa: auditors only need the last 90 days, so a date range is enough for v1.", "author": "Hoa Mai"}))


def page(title, markdown, parent=None):
    pg = ok(c.post(f"/projects/{pid}/docs/pages", json={"title": title, "parent_id": parent}))
    ok(c.put(f"/docs/pages/{pg['id']}/draft", json={"markdown": markdown}))
    cur = ok(c.get(f"/docs/pages/{pg['id']}"))
    ok(c.post(f"/docs/pages/{pg['id']}/publish", json={"base_version": cur["version"]}))
    return pg["id"]


page("Overview", "# Overview\n\nKanban Board is a personal board with a REST API and an MCP server. See [[API]] for the endpoints and [[Auth]] for tokens.\n")
req = page("Requirements", "## Scope\n\nWhat the board must do.\n")
page(
    "Auth",
    "## Rotation\n\nTokens last 30 days. Tokens can be rotated at any time from Settings. The old token keeps working for 24 hours.\n\n"
    "## Scopes\n\nRead and write. TODO: describe admin scope.\n\n## Revocation\n\nSomeone can revoke a token somewhere.\n",
    req,
)
arch = page("Architecture", "## Parts\n\nA FastAPI server, a React UI and an MCP server.\n")
page(
    "API",
    "## Endpoints\n\nEvery route requires a bearer token. See [[Auth#Rotation]].\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n| POST | /tickets |\n\n"
    f"## Limits\n\nRate limits are not enforced yet. Failed webhook deliveries are retried by hand ({t1['id']}).\n",
    arch,
)
page("Data model", "## Tables\n\nProject, Ticket, Member and the Docs pages.\n")
page("Decision log", "## 2026-09-12 Token lifetime\n\nTokens last 90 days. Decided with the team.\n")
page(
    "Meeting notes",
    "## Weekly sync\n\n- [ ] Hoa to write the CSV export spec, due Friday\n- [ ] Tuan to check webhook retry logs\n- [x] Drop the v1 export\n",
)

m = ok(
    c.post(
        f"/projects/{pid}/ai/members",
        json={"name": "Reviewer", "provider": "claude-code", "working_dir": str(REPO), "model": "haiku", "template": "custom"},
    )
)
ok(c.patch(f"/projects/{pid}/ai/settings", json={"board_ai_id": m["id"]}))
print(json.dumps({"project_id": pid, "member_id": m["id"], "tickets": [t1["id"], t2["id"], t3["id"], t4["id"]]}))
