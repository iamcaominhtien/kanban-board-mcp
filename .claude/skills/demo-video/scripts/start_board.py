"""Starts a THROWAWAY board (the Rust server, with its own config, database, logs, uploads, workspace, home, UI build and
key file; never the user's real board), puts demo data in it and leaves it running. Two seeds:

  tour       a project, tickets in every column and an AI team. With --run (and --account-folder) the team also does one
             small real job with Haiku, which costs a little; without it the AI scenes have nothing in them.
  rich-docs  a project, a member, and a Docs space: a published rich page with two versions, child pages, a highlight.

  python3 start_board.py start --dir /tmp/demo-board [--seed rich-docs] [--ui-dist <built ui>] [--run --account-folder ~/.kanban-board/ai-accounts/<name>]
  python3 start_board.py stop  --dir /tmp/demo-board
"""
import argparse, json, os, re, signal, sqlite3, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
import common

def repo_root(given=None) -> Path:
    """The board's repository: --repo, or KANBAN_REPO, or the git repository of the folder you run this from."""
    root = Path(given or os.environ.get("KANBAN_REPO") or subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() or ".").resolve()
    if not (root / "server" / "Cargo.toml").exists(): sys.exit(f"{root} is not the board's repository (no server/Cargo.toml): run from it or pass --repo")
    return root

class Api:
    """A tiny JSON client for the throwaway board (urllib: no extra package)."""
    def __init__(self, base): self.base = base
    def __call__(self, method, path, body=None, actor=None):
        h = {"content-type": "application/json", **({"x-actor": actor} if actor else {})}
        req = urllib.request.Request(self.base + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=30) as r: t = r.read().decode()
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {path}: {e.code} {e.read().decode()[:300]}")
        return json.loads(t) if t else None

def server_binary(repo: Path) -> Path:
    """The Rust server binary (KANBAN_SERVER_BIN, or server/target/debug/kanban-server), built when missing."""
    b = Path(os.environ.get("KANBAN_SERVER_BIN") or repo / "server/target/debug/kanban-server")
    if not b.exists():
        print("building the server (cargo build -p kanban-server -p kanban-mcp-stdio -p fake-claude)", file=sys.stderr)
        subprocess.run(["cargo", "build", "-p", "kanban-server", "-p", "kanban-mcp-stdio", "-p", "fake-claude"], cwd=repo / "server", check=True)
    return b

def build_ui(repo: Path, out: Path):
    """A fresh build of the UI into `out`, so the video shows the code of the checkout and not a stale ui/dist."""
    print("building the UI (vite build)", file=sys.stderr)
    subprocess.run(["npx", "vite", "build", "--outDir", str(out), "--emptyOutDir"], cwd=repo / "ui", check=True, stdout=subprocess.DEVNULL)

HANDBOOK_V1 = """How the Atlas team plans, builds and ships. Read it once, then keep it open.

> [!TIP]
> New here? Start with **Your first week**, then read the release checklist.

## Your first week

Pair with someone on every ticket you pick up. Ask early; nobody minds.

- [x] Get access to the board and the repository
- [ ] Ship one small change to production
- [ ] Write down one thing you would improve

## How we review

| Step | Who | When |
| --- | --- | --- |
| Draft | Author | Any time |
| Review | One teammate | Within a day |
| Merge | Author | After a green build |

```rust
fn ship(change: Change) -> Result<Release> {
    review(&change)?;
    release(change)
}
```

## Release checklist

> A release is boring when it goes well. Keep it boring.

1. Freeze the branch
2. Run the full suite
3. Write the release notes
"""

def seed_rich_docs(c: Api) -> dict:
    """Project Atlas, a member (Hoa Mai) and a Docs space: 'Engineering handbook' (a callout, a task list, a table, code,
    quotes) published twice so history has a diff, a child page, two more pages and one highlight by Hoa Mai."""
    p = c("POST", "/projects", {"name": "Atlas", "prefix": "ATL", "color": "#2E6F40"})
    pid = p["id"]
    c("POST", f"/projects/{pid}/members", {"name": "Hoa Mai", "role": "member"})
    c("POST", f"/projects/{pid}/tickets", {"title": "Write the onboarding guide", "type": "task"})
    def publish(title, md, note, parent=None):
        page = c("POST", f"/projects/{pid}/docs/pages", {"title": title, **({"parent_id": parent} if parent else {})})
        c("PUT", f"/docs/pages/{page['id']}/draft", {"markdown": md, "base_version": 0})
        c("POST", f"/docs/pages/{page['id']}/publish", {"base_version": 0, "note": note})
        return page["id"]
    hb = publish("Engineering handbook", HANDBOOK_V1, "First version")
    publish("Your first week", "A short plan for the first five days.\n", "First version", hb)
    publish("Release notes", "Notes for version 2.4, mentioning the quarterly roadmap.\n", "First version")
    publish("Architecture", "The board, the docs and the AI team share one server.\n", "First version")
    v2 = (HANDBOOK_V1.replace("Pair with someone on every ticket you pick up. Ask early; nobody minds.", "Pair with someone on your first three tickets. Ask early: questions save days.")
          .replace("3. Write the release notes\n", "3. Write the release notes\n4. Tell support what changed\n"))
    c("PUT", f"/docs/pages/{hb}/draft", {"markdown": v2, "base_version": 1})
    c("POST", f"/docs/pages/{hb}/publish", {"base_version": 1, "note": "Clearer first week, support step"})
    intro = next((b for b in (c("GET", f"/docs/pages/{hb}").get("content") or {}).get("content", []) if b.get("type") == "paragraph"), None)
    if intro and intro.get("attrs", {}).get("blockId"):
        text = "".join(x.get("text", "") for x in intro.get("content", []))
        q = "Read it once, then keep it open."
        at = text.find(q)
        if at >= 0: c("POST", f"/docs/pages/{hb}/highlights", {"block_id": intro["attrs"]["blockId"], "start": at, "end": at + len(q), "quote": q, "color": "green"}, actor="Hoa Mai")
    return {"project": pid, "page": hb}

def seed_tour(c: Api, T: Path, run: bool, timeout: int) -> dict:
    """Project KAN with a ticket in every column and an AI team; with `run`, the team fixes KAN-7 for real."""
    repo = T / "repo"                       # the code the team works on: a tiny bug to fix
    repo.mkdir(); (repo / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    (repo / "test_calc.py").write_text("from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n")
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "init"]):
        subprocess.run(cmd, cwd=repo, check=True)
    p = c("POST", "/projects", {"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"})
    team = {"name": "Core team", "working_dir": str(repo), "model": "haiku", "pack_key": "bugfix"}
    if run: team["account_id"] = "acct_demo"
    team = c("POST", f"/projects/{p['id']}/ai/teams", team)
    def tk(title, status, desc, prio="medium", typ="task", tags=None):
        return c("POST", f"/projects/{p['id']}/tickets", {"title": title, "status": status, "description": desc, "priority": prio, "type": typ, **({"tags": tags} if tags else {})})
    tk("Dark mode for the board", "backlog", "Follow the system theme and remember the choice.", "low", "story", ["ui"])
    tk("Export a project as CSV", "todo", "One row per ticket with status, assignee and dates.", "medium", "task", ["export"])
    tk("Keyboard shortcuts cheat sheet", "todo", "Press ? to see every shortcut.", "low", "task", ["ui"])
    tk("Drag handle on ticket cards", "in-progress", "A six-dot handle so cards can be picked up without clicking the title.", "high", "task", ["ui"])
    tk("Debounce search in the doc picker", "review", "Wait 200 ms after the last key before searching.", "medium", "task", ["perf"])
    tk("Sync due-date picker locale", "done", "Use the app language for month and day names.", "low", "task", ["i18n"])
    bug = tk("Fix add() in calc.py", "todo", "add(a, b) in calc.py subtracts instead of adding, so test_calc.py fails. Fix it. Have the reviewer check the diff before you report.", "high", "bug", ["bug"])
    if run:
        c("PATCH", f"/tickets/{bug['id']}", {"assignee": team["id"]})
        deadline = time.time() + timeout
        while time.time() < deadline:
            runs = c("GET", f"/tickets/{bug['id']}/ai/runs")
            runs = runs.get("runs", runs) if isinstance(runs, dict) else runs
            if runs and runs[0]["state"] in ("finished", "failed", "cancelled", "needs_input", "timed_out"): break
            time.sleep(10)
        else:
            sys.exit("the run did not end in time")
        print("run:", runs[0]["state"], file=sys.stderr)
        c("PATCH", f"/tickets/{bug['id']}", {"status": "review"})   # what a person does with a finished ticket
    return {"project": p["id"], "ticket": bug["id"]}

def start(a):
    repo = repo_root(a.repo)
    T = Path(a.dir).expanduser().resolve()
    if T.exists() and any(T.iterdir()): sys.exit(f"{T} is not empty: pick a new folder or run `stop` and delete it")
    if a.run and not (a.account_folder and Path(a.account_folder).expanduser().is_dir()): sys.exit("--run needs --account-folder: the signed-in Claude Code folder of a board account (the run costs a little)")
    binary = server_binary(repo)
    for sub in ("cfg", "data", "logs", "uploads", "workspace", "home", "accounts"): (T / sub).mkdir(parents=True, exist_ok=True)
    ui = Path(a.ui_dist).expanduser().resolve() if a.ui_dist else T / "ui-dist"
    if not a.ui_dist: build_ui(repo, ui)
    env = {k: v for k, v in os.environ.items() if not k.startswith("KANBAN_")}
    env.update(KANBAN_CONFIG_DIR=str(T / "cfg"), KANBAN_DB_PATH=str(T / "data/board.db"), KANBAN_LOG_DIR=str(T / "logs"),
               KANBAN_UPLOADS_DIR=str(T / "uploads"), KANBAN_WORKSPACE_ROOT=str(T / "workspace"), KANBAN_UI_DIST=str(ui),
               HOME=str(T / "home"), KANBAN_AI_KEY_FILE=str(T / "ai.key"), KANBAN_AI_ACCOUNTS_HOME=str(T / "accounts"),
               KANBAN_AI_ROOTS=str(T), KANBAN_RUNNER="inprocess", KANBAN_DIAGRAM_EXPORT="off", PYTHONUNBUFFERED="1")
    if a.run: env["CLAUDE_CONFIG_DIR"] = str(Path(a.account_folder).expanduser())
    out = open(T / "server.out", "w"); err = open(T / "server.err", "w")
    srv = subprocess.Popen([str(binary)], cwd=T, env=env, stdout=out, stderr=err, start_new_session=True)
    (T / "pid").write_text(str(srv.pid))
    port = None
    for _ in range(120):
        m = re.search(r"READY port=(\d+)", (T / "server.out").read_text())
        if m: port = int(m.group(1)); break
        time.sleep(0.5)
    if not port: sys.exit("the throwaway board did not start; see " + str(T / "server.err"))
    base = f"http://127.0.0.1:{port}"
    c = Api(base)
    if a.run:
        folder = Path(a.account_folder).expanduser()
        db = sqlite3.connect(T / "data/board.db")
        db.execute("insert into ai_account (id,name,cli,folder,status,created_by,created_at,updated_at) values ('acct_demo',?,'claude',?,'signed_in','demo',datetime('now'),datetime('now'))", (folder.name, str(folder)))
        db.commit(); db.close()
    seeded = seed_rich_docs(c) if a.seed == "rich-docs" else seed_tour(c, T, a.run, a.timeout)
    info = {"url": base + "/", "dir": str(T), "pid": srv.pid, **seeded}
    (T / "info.json").write_text(json.dumps(info))
    print(json.dumps(info))

def stop(a):
    T = Path(a.dir).expanduser().resolve()
    try: os.killpg(int((T / "pid").read_text()), signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError, ValueError): pass
    print("stopped")

ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
s = sp.add_parser("start"); s.add_argument("--dir", required=True); s.add_argument("--seed", choices=["tour", "rich-docs"], default="tour")
s.add_argument("--run", action="store_true", help="tour only: let the AI team do a real (paid) run"); s.add_argument("--account-folder"); s.add_argument("--ui-dist", help="a built UI to serve; default: build one into <dir>/ui-dist")
s.add_argument("--timeout", type=int, default=420); s.add_argument("--repo")
t = sp.add_parser("stop"); t.add_argument("--dir", required=True)
a = ap.parse_args()
{"start": start, "stop": stop}[a.cmd](a)
