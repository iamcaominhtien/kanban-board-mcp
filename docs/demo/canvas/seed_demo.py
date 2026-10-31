import json, httpx, sys
B = "http://127.0.0.1:8000"
import re
def sn(o):
    if isinstance(o, dict): return {re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), k): sn(v) for k, v in o.items()}
    if isinstance(o, list): return [sn(x) for x in o]
    return o
class Cl:
    def __init__(self): self.c = httpx.Client(base_url=B, timeout=30)
    def post(self, u, json=None, **kw): return self.c.post(u, json=sn(json) if json is not None else None, **kw)
    def patch(self, u, json=None, **kw): return self.c.patch(u, json=sn(json) if json is not None else None, **kw)
    def get(self, u, **kw): return self.c.get(u, **kw)
c = Cl()
def j(r):
    if r.status_code >= 400: print(r.status_code, r.text[:400]); sys.exit(1)
    return r.json()

existing = [p for p in c.get("/projects").json() if p["prefix"] == "KAN"]
pid = existing[0]["id"] if existing else j(c.post("/projects", json={"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"}))["id"]
for name, role in (("Hoa Mai", "member"), ("Tuan Vo", "member"), ("Linh Pham", "member"), ("An Nguyen", "member")):
    c.post(f"/projects/{pid}/members", json={"name": name, "color": "#2F6FB0", "role": role})

def page(title, body, *, width=1280, error=False, phone=False, extra=""):
    err = '<p class="err">Wrong password</p>' if error else ""
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<style>
*{{box-sizing:border-box}} body{{margin:0;font-family:system-ui,sans-serif;background:#F4F6F4;color:#1E2A22}}
header{{height:{56 if not phone else 48}px;background:#1E2A22;display:flex;align-items:center;gap:22px;padding:0 {32 if not phone else 16}px}}
header b{{color:#7BD39A;font-size:18px}} header span{{color:#9DB3A5;font-size:14px}}
main{{display:flex;justify-content:center;padding:{80 if not phone else 28}px 16px}}
.card{{width:{420 if not phone else 340}px;background:#fff;border:1px solid #E3E8E5;border-radius:14px;padding:{32 if not phone else 22}px;box-shadow:0 10px 30px rgba(30,42,34,.08)}}
h1{{margin:0 0 18px;font-size:{26 if not phone else 22}px}} label{{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}}
input{{width:100%;padding:11px 12px;border:1px solid #C7D2CB;border-radius:8px;font-size:15px}}
.err{{margin:8px 0 0;color:#C4432A;font-size:13px}}
button{{margin-top:22px;width:100%;padding:12px;border:0;border-radius:9px;background:#2E6F40;color:#fff;font-weight:700;font-size:15px}}
.note{{margin-top:14px;font-size:13px;color:#5B6B60}} {extra}
</style></head><body>
<header><b>kanban</b><span>Docs</span><span>Boards</span></header>
<main><div class="card"><h1>{title}</h1>{body}{err}</div></main></body></html>"""

signin = '<label>Email</label><input type="email" placeholder="you@example.com"><label>Password</label><input type="password" placeholder="••••••••">'
cv = None
t = j(c.post(f"/projects/{pid}/tickets", json={"title": "Redesign the sign-in screens", "type": "task", "description": "placeholder"}))
tid = t["id"]
print("ticket", tid)
cv = j(c.post("/canvases", json={"ownerKind": "ticket", "ownerId": tid, "title": "Login redesign", "projectId": pid, "start": "none"}))
cid = cv["id"]

def board(name, html, size=None, css=None):
    files = [("files", ("index.html", html.encode(), "text/html"))]
    if css: files.append(("files", ("style.css", css.encode(), "text/css")))
    data = {"kind": "html", "name": name}
    if size: data["size"] = size
    return j(c.post(f"/canvases/{cid}/boards", data=data, files=files))["board"]

b1 = board("Sign in", page("Sign in", signin + "<button>Continue</button>"))
b2 = board("Sign in: wrong password", page("Sign in", signin + '<button>Continue</button>', error=True))
b3 = board("Sign in: phone", page("Sign in", signin + "<button>Continue</button>", phone=True), size="phone")
b4 = board("Reset password", page("Reset password", '<label>Email</label><input type="email" placeholder="you@example.com"><button>Send reset link</button><p class="note">We email a link that works for 30 minutes.</p>'))
b5 = board("Reset: email sent", page("Check your email", '<p class="note">We sent a link to <b>you@example.com</b>.</p><button>Back to sign in</button>'))
b6 = board("Sign up", page("Create an account", '<label>Name</label><input placeholder="Hoa Mai"><label>Email</label><input type="email"><label>Password</label><input type="password"><button>Create account</button>'))
cv = j(c.get(f"/canvases/{cid}"))
doc = cv["doc"]; pg = doc["pages"][0]["id"]
# lay the boards out as a flow, 3 per row, with a label, notes and arrows
pos = {b1["id"]: (0, 0), b2["id"]: (1500, 0), b3["id"]: (3000, 0), b4["id"]: (0, 1100), b5["id"]: (1500, 1100), b6["id"]: (3000, 1100)}
up = []
for b in doc["boards"]:
    x, y = pos[b["id"]]
    up.append({**b, "x": x, "y": y})
rev = cv["rev"]
r = j(c.patch(f"/canvases/{cid}", json={"baseRev": rev, "upsert": {"boards": up, "labels": [{"x": 0, "y": -150, "text": "Sign in flow", "size": 48, "page": pg}, {"x": 0, "y": 950, "text": "Recovery", "size": 40, "page": pg}], "notes": [
    {"x": 1560, "y": -300, "w": 340, "h": 140, "text": "Error text sits under the field, not in a toast", "color": "yellow", "page": pg},
    {"x": 3060, "y": 960, "w": 340, "h": 130, "text": "Same copy as the Settings flow?", "color": "green", "page": pg}]}}))
ids = {n["text"][:5]: n["id"] for n in r["doc"]["notes"]}
j(c.patch(f"/canvases/{cid}", json={"baseRev": r["rev"], "upsert": {"arrows": [
    {"from": b1["id"], "to": b2["id"], "label": "wrong password", "page": pg},
    {"from": b2["id"], "to": b3["id"], "label": "", "page": pg},
    {"from": b4["id"], "to": b5["id"], "label": "submit", "page": pg}]}, "checkpoint": True, "name": "Review 1", "note": "Flow laid out"}))
# comments from different people
H = lambda who: {"x-actor": who}
t1 = j(c.post(f"/canvases/{cid}/threads", json={"body": "Is the logo meant to be this small on a wide screen?", "boardId": b1["id"], "x": 0.7, "y": 0.4}, headers=H("Tuan Vo")))
j(c.post(f"/canvases/threads/{t1['id']}/replies", json={"body": "Yes, it matches the new brand sheet."}, headers=H("Hoa Mai")))
t2 = j(c.post(f"/canvases/{cid}/threads", json={"body": "Please keep the error in the field, not a toast.", "boardId": b2["id"], "x": 0.6, "y": 0.62}, headers=H("Linh Pham")))
j(c.post(f"/canvases/threads/{t2['id']}/resolve", headers=H("Linh Pham")))
j(c.post(f"/canvases/{cid}/threads", json={"body": "Check this on a small screen @Tuan Vo", "boardId": b3["id"], "x": 0.5, "y": 0.3}, headers=H("Hoa Mai")))
# description of the ticket shows the canvas, and one board alone
desc = f"Agreed in the design review. Every screen is on one canvas so we can walk through the flow:\n\n![Login redesign](canvas:{cid})\n\nThe error state is the one to check first:\n\n![Sign in: wrong password](canvas:{cid}#{b2['id']})\n\nSee also [Login redesign](canvas:{cid}) for all states."
j(c.patch(f"/tickets/{tid}", json={"description": desc}))
# a docs page with the canvas as its own page
pgs = j(c.post("/canvases/pages", json={"projectId": pid, "title": "Settings flow"}))
json.dump({"pid": pid, "tid": tid, "cid": cid, "b": [b1["id"], b2["id"], b3["id"], b4["id"], b5["id"], b6["id"]], "page": pgs["page"]["id"], "pcid": pgs["canvas"]["id"]}, open("/tmp/cvdemo/ids.json", "w"))
print(open("/tmp/cvdemo/ids.json").read())
