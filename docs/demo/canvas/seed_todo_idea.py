"""Demo: present the design of a mobile TODO app as an Idea with a Canvas (open, clickable frames).

Run it against any running board (needs the Canvas feature, version 3.17 or newer):

    python docs/demo/canvas/seed_todo_idea.py                       # http://127.0.0.1:8000
    python docs/demo/canvas/seed_todo_idea.py http://127.0.0.1:8000 # or your own address

It makes (or reuses) a project "Todo App" (prefix TODO), an idea "Todo app for mobile: design" with its assumptions, and
a canvas on that idea with five frames: Today, New task, Task detail, Upcoming (phone) and Today on a tablet, plus notes,
arrows and labels. The frames are real little prototypes (plain HTML, CSS and JavaScript): tick a task, add one in
"New task" and see it in "Today" (they share localStorage because they are served from the same address), open "Try it" in
the large view to click through. Needs only `httpx` (already a dependency of the server).
"""

import sys

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
c = httpx.Client(base_url=BASE, timeout=60)


def ok(r: httpx.Response) -> dict | list:
    if r.status_code >= 400:
        sys.exit(f"{r.request.method} {r.request.url.path}: {r.status_code} {r.text[:300]}")
    return r.json()


# --- the shared look (colour, type, spacing) ---------------------------------------------------------------------

CSS = """
:root{--ink:#1f2937;--mute:#6b7280;--line:#e5e7eb;--bg:#f6f7fb;--card:#fff;--brand:#5b5bd6;--brand2:#eef0ff;
--ok:#16a34a;--hi:#ef4444;--md:#f59e0b;--lo:#22c55e;--r:16px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
body{display:flex;flex-direction:column;min-height:100vh}
button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
.top{padding:22px 20px 8px}
.top small{color:var(--mute);font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:12px}
.top h1{margin:2px 0 0;font-size:28px;letter-spacing:-.02em}
.card{background:var(--card);border-radius:var(--r);box-shadow:0 1px 2px rgba(16,24,40,.06),0 4px 14px rgba(16,24,40,.04)}
.list{display:flex;flex-direction:column;gap:10px;padding:8px 16px 96px}
.task{display:flex;align-items:center;gap:12px;padding:14px 14px}
.task .t{flex:1;min-width:0}.task .t b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task .t span{color:var(--mute);font-size:13px}
.task.done .t b{text-decoration:line-through;color:var(--mute)}
.chk{width:26px;height:26px;border-radius:50%;border:2px solid #c7cbd6;display:grid;place-items:center;flex:none;transition:.15s}
.done .chk{background:var(--ok);border-color:var(--ok)}
.done .chk::after{content:"";width:7px;height:12px;border:solid #fff;border-width:0 3px 3px 0;transform:rotate(45deg) translate(-1px,-1px)}
.dot{width:10px;height:10px;border-radius:50%;flex:none}
.p-high{background:var(--hi)}.p-med{background:var(--md)}.p-low{background:var(--lo)}
.tabs{position:sticky;bottom:0;margin-top:auto;display:flex;background:#fff;border-top:1px solid var(--line);padding:6px 8px calc(6px + env(safe-area-inset-bottom))}
.tabs a,.tabs button{flex:1;text-align:center;padding:8px 0;font-size:12px;color:var(--mute);font-weight:600;text-decoration:none}
.tabs .on{color:var(--brand)}.tabs i{display:block;font-style:normal;font-size:20px;line-height:1.2}
.fab{position:fixed;right:20px;bottom:84px;width:58px;height:58px;border-radius:50%;background:var(--brand);color:#fff;font-size:30px;box-shadow:0 8px 20px rgba(91,91,214,.45)}
.toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%) translateY(20px);background:#111827;color:#fff;padding:10px 16px;border-radius:999px;font-size:14px;opacity:0;transition:.25s;pointer-events:none;white-space:nowrap}
.toast.show{opacity:1;transform:translateX(-50%)}
.btn{display:block;width:100%;padding:15px;border-radius:14px;background:var(--brand);color:#fff;font-weight:700}
.chip{padding:8px 14px;border-radius:999px;border:1.5px solid var(--line);background:#fff;font-weight:600;font-size:14px}
.chip.on{background:var(--brand2);border-color:var(--brand);color:var(--brand)}
@media (min-width:700px){body{font-size:17px}.top{padding:32px 36px 12px}.list{padding:8px 36px 96px}}
"""

STORE = """
const KEY='kanban-demo-todo-v1';
const SEED=[
 {id:1,t:'Buy oat milk',n:'Groceries',p:'low',d:0,done:true,sub:[]},
 {id:2,t:'Send the invoice to Hoa Mai',n:'Work',p:'high',d:0,done:false,sub:[['Check hours',true],['Attach PDF',false],['Send',false]]},
 {id:3,t:'Book dentist',n:'Health',p:'med',d:0,done:false,sub:[]},
 {id:4,t:'Review the design with the team',n:'Work',p:'med',d:1,done:false,sub:[]},
 {id:5,t:'Call mom',n:'Family',p:'low',d:2,done:false,sub:[]},
 {id:6,t:'Plan the weekend trip',n:'Personal',p:'med',d:3,done:false,sub:[]}];
function load(){try{return JSON.parse(localStorage.getItem(KEY))||SEED.map(x=>({...x}))}catch(e){return SEED.map(x=>({...x}))}}
function save(a){try{localStorage.setItem(KEY,JSON.stringify(a))}catch(e){}}
function toast(m){let t=document.querySelector('.toast');if(!t){t=document.createElement('div');t.className='toast';document.body.appendChild(t)}t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),1800)}
const DAYS=['Today','Tomorrow','Sun','Mon','Tue','Wed','Thu'];
"""


def page(title: str, body: str, script: str = "", extra_css: str = "") -> bytes:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title>
<style>{CSS}{extra_css}</style></head><body>{body}
<script>{STORE}{script}</script></body></html>""".encode()


TABS = """<nav class="tabs"><a class="%s" href="#"><i>☑</i>Today</a><a class="%s" href="#"><i>📅</i>Upcoming</a>
<a href="#"><i>☰</i>Lists</a><a href="#"><i>⚙</i>Settings</a></nav>"""

TODAY = page(
    "Today",
    """<header class="top"><small id="date"></small><h1>Today</h1>
<div class="card" style="margin-top:14px;padding:16px;display:flex;align-items:center;gap:16px">
<svg width="64" height="64" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="#e5e7eb" stroke-width="4"/>
<circle id="ring" cx="18" cy="18" r="15" fill="none" stroke="#5b5bd6" stroke-width="4" stroke-linecap="round"
 stroke-dasharray="0 94" transform="rotate(-90 18 18)" style="transition:.4s"/></svg>
<div><b id="sum" style="font-size:18px"></b><div id="sub" style="color:#6b7280;font-size:14px"></div></div></div></header>
<main class="list" id="list"></main>
<aside class="side card" id="side"><b>Pick a task</b><p style="color:#6b7280">On a tablet the detail sits next to the list.</p></aside>
<button class="fab" id="add" aria-label="New task">+</button>"""
    + TABS % ("on", ""),
    """
let tasks=load();let sel=null;
const PN={high:'High',med:'Medium',low:'Low'};
function draw(){
  const today=tasks.filter(x=>x.d===0);const done=today.filter(x=>x.done).length;
  document.getElementById('date').textContent=new Date().toLocaleDateString('en',{weekday:'long',day:'numeric',month:'long'});
  document.getElementById('sum').textContent=done+' of '+today.length+' done';
  document.getElementById('sub').textContent=done===today.length&&today.length?'All clear. Enjoy the rest of your day.':(today.length-done)+' to go';
  document.getElementById('ring').setAttribute('stroke-dasharray',(today.length?94*done/today.length:0)+' 94');
  const el=document.getElementById('list');el.innerHTML='';
  today.sort((a,b)=>a.done-b.done).forEach(x=>{
    const r=document.createElement('div');r.className='card task'+(x.done?' done':'');
    r.innerHTML='<button class="chk" aria-label="Done"></button><div class="t"><b></b><span></span></div><i class="dot p-'+x.p+'" title="'+PN[x.p]+'"></i>';
    r.querySelector('b').textContent=x.t;r.querySelector('span').textContent=x.n+(x.sub.length?' · '+x.sub.filter(s=>s[1]).length+'/'+x.sub.length:'');
    r.querySelector('.chk').onclick=e=>{e.stopPropagation();x.done=!x.done;save(tasks);draw();if(x.done)toast('Nice. '+x.t+' done')};
    r.onclick=()=>{sel=x;side()};el.appendChild(r)});
}
function side(){const s=document.getElementById('side');if(!sel)return;s.innerHTML='<b style="font-size:20px"></b><p style="color:#6b7280"></p>';
  s.querySelector('b').textContent=sel.t;s.querySelector('p').textContent=sel.n+' · '+PN[sel.p]+' priority'+(sel.sub.length?' · '+sel.sub.length+' subtasks':'')}
document.getElementById('add').onclick=()=>toast('Open the "New task" frame to add one');
draw();
""",
    """.side{display:none}
@media (min-width:700px){
 body{display:grid;grid-template-columns:minmax(0,1fr) 300px;grid-template-rows:auto 1fr auto;column-gap:20px}
 .top{grid-column:1}.list{grid-column:1}.side{display:block;grid-column:2;grid-row:1 / span 2;margin:32px 36px 0 0;padding:22px;align-self:start}
 .tabs{grid-column:1 / -1}.fab{right:36px}}""",
)

NEW = page(
    "New task",
    """<div style="flex:1;background:rgba(17,24,39,.35);display:flex;align-items:flex-end">
<form id="f" class="card" style="width:100%;border-radius:24px 24px 0 0;padding:22px 20px 26px" autocomplete="off">
<div style="width:40px;height:4px;background:#d1d5db;border-radius:9px;margin:-8px auto 16px"></div>
<h1 style="margin:0 0 14px;font-size:22px">New task</h1>
<input id="t" placeholder="What needs doing?" style="width:100%;border:0;border-bottom:2px solid var(--brand);padding:10px 0;font:600 18px inherit;outline:0;background:none" required>
<textarea id="n" rows="2" placeholder="Notes (optional)" style="width:100%;border:1.5px solid var(--line);border-radius:12px;margin-top:14px;padding:10px;font:inherit;resize:none"></textarea>
<p style="margin:16px 0 8px;font-weight:700;font-size:13px;color:var(--mute)">PRIORITY</p>
<div id="pr" style="display:flex;gap:8px"><button type="button" class="chip" data-v="low">Low</button><button type="button" class="chip on" data-v="med">Medium</button><button type="button" class="chip" data-v="high">High</button></div>
<p style="margin:16px 0 8px;font-weight:700;font-size:13px;color:var(--mute)">DUE</p>
<div id="du" style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="chip on" data-v="0">Today</button><button type="button" class="chip" data-v="1">Tomorrow</button><button type="button" class="chip" data-v="2">Sunday</button><button type="button" class="chip" data-v="3">Monday</button></div>
<button class="btn" style="margin-top:22px">Add task</button></form></div>""",
    """
let pr='med',du=0;
function pick(id,fn){document.querySelectorAll('#'+id+' .chip').forEach(b=>b.onclick=()=>{document.querySelectorAll('#'+id+' .chip').forEach(x=>x.classList.remove('on'));b.classList.add('on');fn(b.dataset.v)})}
pick('pr',v=>pr=v);pick('du',v=>du=+v);
document.getElementById('f').onsubmit=e=>{e.preventDefault();const a=load();
 a.push({id:Date.now(),t:document.getElementById('t').value.trim(),n:document.getElementById('n').value.trim()||'Inbox',p:pr,d:du,done:false,sub:[]});
 save(a);document.getElementById('f').reset();toast('Added to '+DAYS[du]+'. Open the "Today" frame')};
""",
)

DETAIL = page(
    "Task detail",
    """<header class="top" style="display:flex;align-items:center;gap:8px"><button aria-label="Back" style="font-size:26px;color:var(--brand)">‹</button><small style="margin-left:auto">Work</small></header>
<main style="padding:0 20px 24px;flex:1"><span class="chip on" style="display:inline-block">High priority</span>
<h1 style="margin:12px 0 4px;font-size:26px;letter-spacing:-.02em">Send the invoice to Hoa Mai</h1>
<p style="color:var(--mute);margin:0 0 18px">Due today · Work</p>
<div class="card" style="padding:16px"><div style="display:flex;justify-content:space-between;font-weight:700"><span>Subtasks</span><span id="cnt"></span></div>
<div style="height:8px;background:#eef0f4;border-radius:9px;margin:10px 0 6px;overflow:hidden"><i id="bar" style="display:block;height:100%;background:var(--brand);width:0;transition:.3s"></i></div>
<div id="subs"></div></div>
<div class="card" style="padding:16px;margin-top:14px"><b>Notes</b><p style="color:var(--mute);margin:6px 0 0">Hours are in the sheet. Mention the new rate from next month.</p></div></main>
<div style="padding:12px 20px 22px;display:flex;gap:10px"><button class="chip" style="flex:1;padding:14px;color:var(--hi)" id="del">Delete</button><button class="btn" style="flex:2" id="fin">Mark done</button></div>""",
    """
const t=load().find(x=>x.id===2)||SEED[1];let s=t.sub.map(x=>[...x]);
function draw(){const el=document.getElementById('subs');el.innerHTML='';
 s.forEach((x,i)=>{const r=document.createElement('div');r.className='task'+(x[1]?' done':'');r.style.padding='10px 0';
  r.innerHTML='<button class="chk"></button><div class="t"><b></b></div>';r.querySelector('b').textContent=x[0];
  r.onclick=()=>{x[1]=!x[1];draw()};el.appendChild(r)});
 const d=s.filter(x=>x[1]).length;document.getElementById('cnt').textContent=d+'/'+s.length;document.getElementById('bar').style.width=(100*d/s.length)+'%'}
document.getElementById('fin').onclick=()=>{s.forEach(x=>x[1]=true);draw();toast('All subtasks done')};
document.getElementById('del').onclick=()=>toast('Hold to delete (prototype)');
draw();
""",
)

UPCOMING = page(
    "Upcoming",
    """<header class="top"><small>Next 7 days</small><h1>Upcoming</h1></header>
<div id="week" style="display:flex;gap:8px;padding:6px 16px 10px;overflow-x:auto"></div>
<main class="list" id="list" style="padding-bottom:20px"></main>"""
    + TABS % ("", "on"),
    """
const tasks=load();let day=1;
const names=['Sat','Sun','Mon','Tue','Wed','Thu','Fri'];
function draw(){const w=document.getElementById('week');w.innerHTML='';
 for(let i=0;i<7;i++){const n=tasks.filter(x=>x.d===i&&!x.done).length;const b=document.createElement('button');b.className='chip'+(i===day?' on':'');
  b.style.cssText='min-width:52px;padding:10px 6px;border-radius:14px;text-align:center';b.innerHTML='<div style="font-size:12px">'+names[i]+'</div><div style="font-size:18px;font-weight:800">'+(1+i)+'</div><div style="font-size:11px;color:#9ca3af">'+(n?n+' due':'—')+'</div>';
  b.onclick=()=>{day=i;draw()};w.appendChild(b)}
 const el=document.getElementById('list');el.innerHTML='';const L=tasks.filter(x=>x.d===day);
 if(!L.length){el.innerHTML='<div class="card" style="padding:28px;text-align:center;color:#6b7280"><div style="font-size:34px">🌤</div><b>Nothing planned</b><br>Tap + to add a task for this day.</div>';return}
 L.forEach(x=>{const r=document.createElement('div');r.className='card task'+(x.done?' done':'');r.innerHTML='<button class="chk"></button><div class="t"><b></b><span></span></div><i class="dot p-'+x.p+'"></i>';
  r.querySelector('b').textContent=x.t;r.querySelector('span').textContent=x.n;r.querySelector('.chk').onclick=()=>{x.done=!x.done;save(tasks);draw()};el.appendChild(r)})}
draw();
""",
)

TOKENS = page(
    "Design tokens",
    """<main style="padding:36px 40px;max-width:900px"><small style="color:var(--mute);font-weight:700;letter-spacing:.06em">DESIGN TOKENS</small>
<h1 style="margin:4px 0 24px;font-size:34px;letter-spacing:-.02em">Todo: look and feel</h1>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px">
<div class="card" style="padding:12px"><i style="display:block;height:54px;border-radius:10px;background:#5b5bd6"></i><b>Brand</b><br><small>#5B5BD6</small></div>
<div class="card" style="padding:12px"><i style="display:block;height:54px;border-radius:10px;background:#16a34a"></i><b>Done</b><br><small>#16A34A</small></div>
<div class="card" style="padding:12px"><i style="display:block;height:54px;border-radius:10px;background:#ef4444"></i><b>High</b><br><small>#EF4444</small></div>
<div class="card" style="padding:12px"><i style="display:block;height:54px;border-radius:10px;background:#f59e0b"></i><b>Medium</b><br><small>#F59E0B</small></div>
<div class="card" style="padding:12px"><i style="display:block;height:54px;border-radius:10px;background:#22c55e"></i><b>Low</b><br><small>#22C55E</small></div></div>
<div class="card" style="padding:20px;margin-top:20px"><div style="font-size:28px;font-weight:800;letter-spacing:-.02em">Title 28 / 800</div>
<div style="font-size:18px;font-weight:600;margin-top:6px">Task 16 / 600 &middot; <span style="color:var(--mute);font-weight:400">meta 13 / 400</span></div>
<p style="color:var(--mute)">System font stack. Radius 16, tap targets 44+, one accent colour, large type.</p></div>
<div class="card" style="padding:20px;margin-top:14px"><b>Principles</b><ol style="margin:8px 0 0;padding-left:20px;color:var(--mute)"><li>One thumb: actions in the bottom half.</li><li>Today first: ring + list, nothing else.</li><li>Adding a task takes under 5 seconds.</li></ol></div></main>""",
)

# --- build -------------------------------------------------------------------------------------------------------

projects = ok(c.get("/projects"))
project = next((p for p in projects if p["prefix"] == "TODO"), None) or ok(
    c.post("/projects", json={"name": "Todo App", "prefix": "TODO", "color": "#5B5BD6"})
)
pid = project["id"]

idea = ok(
    c.post(
        "/api/idea-tickets",
        json={
            "project_id": pid,
            "title": "Todo app for mobile: design",
            "description": "A calm, one-thumb TODO app. Today first, adding a task in under five seconds, a weekly view for planning.",
            "problem_statement": "To-do apps are either too heavy to open for one task or too bare to plan a week.",
            "tags": ["mobile", "design"],
            "idea_emoji": "✅",
            "idea_color": "blue",
        },
    )
)
for text, impact in (
    ("People will add a task in under 5 seconds from the + button", "high"),
    ("A progress ring on Today is enough motivation (no streaks)", "medium"),
    ("The same list works on a tablet with a side detail pane", "low"),
):
    ok(c.post(f"/api/idea-tickets/{idea['id']}/assumptions", json={"text": text, "impact": impact}))

cv = ok(
    c.post(
        "/canvases",
        json={
            "owner_kind": "idea",
            "owner_id": idea["id"],
            "title": "Todo app: mobile design",
            "project_id": pid,
            "start": "none",
        },
    )
)
cid = cv["id"]


def board(name: str, html: bytes, size: str | None = None, w: int | None = None, h: int | None = None) -> dict:
    data = {"kind": "html", "name": name}
    if size:
        data["size"] = size
    if w and h:
        data["size"] = f"{w}x{h}"
    return ok(c.post(f"/canvases/{cid}/boards", data=data, files=[("files", ("index.html", html, "text/html"))]))["board"]


b_today = board("Today", TODAY, "phone")
b_new = board("New task", NEW, "phone")
b_detail = board("Task detail", DETAIL, "phone")
b_up = board("Upcoming", UPCOMING, "phone")
b_tab = board("Today: tablet", TODAY, "tablet")
b_tok = board("Design tokens", TOKENS, "desktop")

cur = ok(c.get(f"/canvases/{cid}"))
doc = cur["doc"]
by_name = {b["name"]: b for b in doc["boards"]}
label_y = min(b["y"] for b in doc["boards"]) - 190
upsert = {
    "labels": [
        {"id": "t_00000001", "x": by_name["Today"]["x"], "y": label_y, "text": "Todo app: mobile design", "size": 34},
        {"id": "t_00000002", "x": by_name["Today"]["x"], "y": label_y + 64, "text": "Phone 390 x 844, the same page redraws on a tablet", "size": 18},
    ],
    "notes": [
        {"id": "n_00000001", "x": by_name["Today"]["x"], "y": by_name["Today"]["y"] + 900, "w": 300, "h": 150, "color": "yellow",
         "text": "Tick a task: the ring fills. Try it in the large view (Try it)."},
        {"id": "n_00000002", "x": by_name["New task"]["x"], "y": by_name["New task"]["y"] + 900, "w": 300, "h": 150, "color": "green",
         "text": "Add a task here, then open Today: it is there (shared storage)."},
        {"id": "n_00000003", "x": by_name["Task detail"]["x"], "y": by_name["Task detail"]["y"] + 900, "w": 300, "h": 150, "color": "pink",
         "text": "Open question: swipe to delete, or a Delete button only?"},
        {"id": "n_00000004", "x": by_name["Upcoming"]["x"], "y": by_name["Upcoming"]["y"] + 900, "w": 300, "h": 150, "color": "blue",
         "text": "Week strip shows how many tasks are due each day."},
    ],
    "arrows": [
        {"id": "a_00000001", "from": by_name["Today"]["id"], "to": by_name["New task"]["id"], "label": "+ button"},
        {"id": "a_00000002", "from": by_name["Today"]["id"], "to": by_name["Task detail"]["id"], "label": "tap a task"},
        {"id": "a_00000003", "from": by_name["Task detail"]["id"], "to": by_name["Upcoming"]["id"], "label": "Upcoming tab"},
    ],
}
ok(c.patch(f"/canvases/{cid}", json={"base_rev": cur["rev"], "upsert": upsert}))

cv = ok(c.get(f"/canvases/{cid}"))
ok(
    c.patch(
        f"/api/idea-tickets/{idea['id']}",
        json={
            "description": (
                "A calm, one-thumb TODO app. Today first, adding a task in under five seconds, a weekly view for planning.\n\n"
                f"**Design**\n\n{cv['markdown']}\n"
            )
        },
    )
)
print(f"idea {idea['id']}: {idea['title']}")
print(f"canvas {cid}: {len(cv['doc']['boards'])} frames")
print(f"open {BASE}/ , Idea Space, '{idea['title']}'")
