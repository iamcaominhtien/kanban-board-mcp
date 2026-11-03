"""Live check of #268 with real Claude Code runs (sonnet / haiku): a BA writes a spec on a Docs page, a Dev on the
ticket reads it. Sets up the board; the runs are started and watched by live_run.py.

    python docs/demo/docs-268/live_setup.py http://127.0.0.1:8010 /tmp/claude-0/live/repo state.json
"""

import json
import sys

import httpx

BASE, REPO, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
c = httpx.Client(base_url=BASE, headers={"X-Actor": "An Nguyen"}, timeout=120)


def ok(r):
    assert r.status_code < 300, (r.request.url, r.status_code, r.text[:400])
    return r.json() if r.content else None


p = ok(c.post("/projects", json={"name": "Studio app", "prefix": "STU", "color": "#2E6F40"}))
pid = p["id"]
ok(c.post(f"/projects/{pid}/members", json={"name": "An Nguyen", "role": "admin"}))
members = {}
for key, name, model in (("ba", "BA", "sonnet"), ("dev", "Dev", "haiku")):
    m = ok(c.post(f"/projects/{pid}/ai/packs/{key}/member", json={"name": name, "working_dir": REPO}))
    ok(c.patch(f"/ai/members/{m['id']}", json={"model": model}))
    members[key] = m["id"]
req = ok(c.post(f"/projects/{pid}/docs/pages", json={"title": "Requirements"}))
ok(c.put(f"/docs/pages/{req['id']}/draft", json={"markdown": "## Scope\n\nWhat the studio app must do, one page per feature.\n"}))
cur = ok(c.get(f"/docs/pages/{req['id']}"))
ok(c.post(f"/docs/pages/{req['id']}/publish", json={"base_version": cur["version"]}))
t = ok(
    c.post(
        f"/projects/{pid}/tickets",
        json={
            "title": "Lock the account after 5 failed sign-ins",
            "status": "todo",
            "type": "feature",
            "description": "Someone guessing passwords must be stopped. Today `sign_in` in auth.py accepts any number "
            "of tries.",
        },
    )
)
json.dump({"project_id": pid, "members": members, "ticket": t["id"], "requirements": req["id"]}, open(OUT, "w"))
print(json.dumps({"project": pid, "members": members, "ticket": t["id"]}))
