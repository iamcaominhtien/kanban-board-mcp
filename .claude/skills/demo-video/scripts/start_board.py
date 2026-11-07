"""Starts a THROWAWAY board (its own config, database, logs and key file; never the user's real board), puts demo
data in it (a project, tickets in every column, an AI team) and, unless --no-run, lets the team do one small real job
with Haiku so the AI activity, the Timeline and the comments have real content. Leaves the server running.

  python3 start_board.py start --dir /tmp/demo-board --account-folder ~/.kanban-board/ai-accounts/<name>
  python3 start_board.py stop  --dir /tmp/demo-board
"""
import argparse, json, os, re, signal, sqlite3, subprocess, sys, time
from pathlib import Path
import common
common.ensure_deps()

def repo_root() -> Path:
    return Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=common.SKILL, capture_output=True, text=True, check=True).stdout.strip())

def start(a):
    import httpx
    T = Path(a.dir).expanduser().resolve()
    if T.exists() and any(T.iterdir()): sys.exit(f"{T} is not empty: pick a new folder or run `stop` and delete it")
    for sub in ("cfg", "logs", "repo"): (T / sub).mkdir(parents=True, exist_ok=True)
    repo = T / "repo"                       # the code the team works on: a tiny bug to fix
    (repo / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    (repo / "test_calc.py").write_text("from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n")
    for c in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "init"]):
        subprocess.run(c, cwd=repo, check=True)
    env = {k: v for k, v in os.environ.items() if k != "KANBAN_DATABASE_URL"}
    env.update(KANBAN_CONFIG_DIR=str(T / "cfg"), KANBAN_DB_PATH=str(T / "board.db"), KANBAN_LOG_DIR=str(T / "logs"),
               KANBAN_AI_ACCOUNTS_HOME=str(T / "accounts"), KANBAN_AI_KEY_FILE=str(T / "ai.key"))
    out = open(T / "server.out", "w"); err = open(T / "server.err", "w")
    srv = subprocess.Popen(["uv", "run", "python", "main.py"], cwd=repo_root() / "server", env=env, stdout=out, stderr=err, start_new_session=True)
    (T / "pid").write_text(str(srv.pid))
    port = None
    for _ in range(120):
        m = re.search(r"READY port=(\d+)", (T / "server.out").read_text())
        if m: port = int(m.group(1)); break
        time.sleep(0.5)
    if not port: sys.exit("the throwaway board did not start; see " + str(T / "server.err"))
    base = f"http://127.0.0.1:{port}"
    c = httpx.Client(base_url=base, timeout=30)
    if not a.no_run:
        folder = Path(a.account_folder).expanduser()
        if not folder.is_dir(): sys.exit("--account-folder must be the signed-in Claude Code folder of a board account")
        db = sqlite3.connect(T / "board.db")
        db.execute("insert into ai_account (id,name,cli,folder,status,created_by,created_at,updated_at) values ('acct_demo',?,'claude',?,'signed_in','demo',datetime('now'),datetime('now'))", (folder.name, str(folder)))
        db.commit(); db.close()
    p = c.post("/projects", json={"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"}).json()
    team = {"name": "Core team", "working_dir": str(repo), "model": "haiku", "pack_key": "bugfix"}
    if not a.no_run: team["account_id"] = "acct_demo"
    team = c.post(f"/projects/{p['id']}/ai/teams", json=team).json()
    def tk(title, status, desc, prio="medium", typ="task", tags=None):
        return c.post(f"/projects/{p['id']}/tickets", json={"title": title, "status": status, "description": desc, "priority": prio, "type": typ, **({"tags": tags} if tags else {})}).json()
    tk("Dark mode for the board", "backlog", "Follow the system theme and remember the choice.", "low", "story", ["ui"])
    tk("Export a project as CSV", "todo", "One row per ticket with status, assignee and dates.", "medium", "task", ["export"])
    tk("Keyboard shortcuts cheat sheet", "todo", "Press ? to see every shortcut.", "low", "task", ["ui"])
    tk("Drag handle on ticket cards", "in-progress", "A six-dot handle so cards can be picked up without clicking the title.", "high", "task", ["ui"])
    tk("Debounce search in the doc picker", "review", "Wait 200 ms after the last key before searching.", "medium", "task", ["perf"])
    tk("Sync due-date picker locale", "done", "Use the app language for month and day names.", "low", "task", ["i18n"])
    bug = tk("Fix add() in calc.py", "todo", "add(a, b) in calc.py subtracts instead of adding, so test_calc.py fails. Fix it. Have the reviewer check the diff before you report.", "high", "bug", ["bug"])
    if not a.no_run:
        c.patch(f"/tickets/{bug['id']}", json={"assignee": team["id"]})
        deadline = time.time() + a.timeout
        while time.time() < deadline:
            runs = c.get(f"/tickets/{bug['id']}/ai/runs").json()
            if runs and runs[0]["state"] in ("finished", "failed", "cancelled", "needs_input", "timed_out"): break
            time.sleep(10)
        else:
            sys.exit("the run did not end in time")
        print("run:", runs[0]["state"], file=sys.stderr)
        c.patch(f"/tickets/{bug['id']}", json={"status": "review"})   # what a person does with a finished ticket
    info = {"url": base + "/", "dir": str(T), "pid": srv.pid, "ticket": bug["id"], "project": p["id"]}
    (T / "info.json").write_text(json.dumps(info))
    print(json.dumps(info))

def stop(a):
    T = Path(a.dir).expanduser().resolve()
    try: os.killpg(int((T / "pid").read_text()), signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError, ValueError): pass
    print("stopped")

ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
s = sp.add_parser("start"); s.add_argument("--dir", required=True); s.add_argument("--account-folder"); s.add_argument("--no-run", action="store_true"); s.add_argument("--timeout", type=int, default=420)
t = sp.add_parser("stop"); t.add_argument("--dir", required=True)
a = ap.parse_args()
{"start": start, "stop": stop}[a.cmd](a)
