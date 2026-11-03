"""Live check of #274 with real models (Claude Code, sonnet for the Devs, haiku for the outside agent).

    server/.venv/bin/python docs/demo/ai-memory-274/live_check.py <work dir> [port]

Scenarios (the owner let us pick them):
  1. Dev An (role Dev, sonnet) fixes SHOP-1 in a small repository whose `./test.sh` watches and gives up after 20 s
     unless it is run with `--once`. A person's comment on the ticket asks for Vietnamese. Nobody asks the AI to
     remember anything. Does it keep the test command and the language request by itself?
  2. A person keeps the lessons proposed. Dev Binh, another member of the same role, takes SHOP-2. Does its prompt
     carry the notes, and does it run `./test.sh --once` the first time and write in Vietnamese?
  3. An outside agent (haiku), the board's MCP server only: does it read the memory and propose a lesson?

Writes <work dir>/report.json and prints a summary. Needs the `claude` CLI signed in.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[3]
WORK = Path(sys.argv[1]).resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
BASE = f"http://127.0.0.1:{PORT}"
CLAUDE = os.environ.get("CLAUDE_CLI", "claude")
DEV_MODEL = os.environ.get("DEV_MODEL", "sonnet")
H = {"X-Actor": "An Nguyen"}

WORK.mkdir(parents=True, exist_ok=True)
REPO = WORK / "shop"
report: dict = {}


def sh(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def make_repo() -> None:
    if REPO.exists():
        return
    (REPO / "tests").mkdir(parents=True)
    (REPO / "csv_export.py").write_text(
        '"""Export rows as CSV text."""\n\n\n'
        "def to_csv(rows: list[list[str]]) -> str:\n"
        '    """One line per row, fields separated by commas."""\n'
        '    return "\\n".join(",".join(str(f) for f in row) for row in rows)\n'
    )
    (REPO / "tests" / "__init__.py").write_text("")
    (REPO / "tests" / "test_csv_export.py").write_text(
        "import unittest\n\nfrom csv_export import to_csv\n\n\n"
        "class ToCsv(unittest.TestCase):\n"
        "    def test_plain(self):\n"
        '        self.assertEqual(to_csv([["a", "b"], ["c", "d"]]), "a,b\\nc,d")\n'
    )
    (REPO / "test.sh").write_text(
        "#!/bin/sh\n"
        "# Runs the tests. Without --once it watches the files and runs them again on every change.\n"
        'if [ "$1" = "--once" ]; then exec python3 -m unittest discover -s tests -t . -v; fi\n'
        'echo "Watching for changes (Ctrl+C to stop)..."\n'
        "sleep 20\n"
        'echo "watch mode: no terminal attached, giving up. In CI or a script run ./test.sh --once" >&2\n'
        "exit 1\n"
    )
    (REPO / "test.sh").chmod(0o755)
    (REPO / "README.md").write_text("# Shop\n\nRun the tests with `./test.sh`.\n")
    sh("git", "init", "-q", "-b", "main", cwd=REPO)
    sh("git", "add", "-A", cwd=REPO)
    sh("git", "-c", "user.name=An", "-c", "user.email=an@example.com", "commit", "-qm", "Shop", cwd=REPO)


def api(c: httpx.Client, method: str, url: str, **kw):
    r = c.request(method, url, headers=H, **kw)
    if r.status_code >= 400:
        raise SystemExit(f"{method} {url}: {r.status_code} {r.text}")
    return r.json() if r.text else None


def wait_run(c: httpx.Client, ticket_id: str, timeout: float = 1500) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        runs = api(c, "GET", f"/tickets/{ticket_id}/ai/runs")
        if runs and runs[0]["state"] in ("finished", "failed", "cancelled", "timed_out", "needs_input"):
            return runs[0]
        time.sleep(5)
    raise SystemExit(f"run on {ticket_id} did not end in time")


def commands_of(run: dict) -> list[str]:
    return [s.get("text", "") for s in run.get("steps", []) if s.get("text", "").startswith("Ran ")]


def comments_by(c, ticket_id: str, author: str) -> list[str]:
    t = api(c, "GET", f"/tickets/{ticket_id}")
    return [x.get("text", "") for x in (t.get("comments") or []) if x.get("author") == author]


def run_view(c, ticket_id: str, run: dict, author: str) -> dict:
    return {
        "state": run["state"],
        "model": run.get("model"),
        "cost_usd": run.get("cost_usd"),
        "tokens_in": run.get("tokens_in"),
        "tokens_out": run.get("tokens_out"),
        "commands": commands_of(run),
        "memory_steps": [s["text"] for s in run.get("steps", []) if s.get("kind") == "memory"],
        "memory_used": run.get("memory_used"),
        "summary": run.get("summary"),
        "comments": comments_by(c, ticket_id, author),
    }


def main() -> None:
    make_repo()
    env = {
        **os.environ,
        "KANBAN_DB_PATH": str(WORK / "kanban.db"),
        "KANBAN_AI_ROOTS": str(WORK),
        "KANBAN_SECRET_STORE": "file",
        "KANBAN_AI_RUNS_DIR": str(WORK / "runs"),
        "KANBAN_WORKSPACE_ROOT": str(WORK / "workspaces"),
        "KANBAN_BOARD_URL": BASE,
    }
    server = subprocess.Popen(
        [str(ROOT / "server" / ".venv" / "bin" / "uvicorn"), "main:app", "--port", str(PORT)],
        cwd=ROOT / "server",
        env=env,
        stdout=open(WORK / "server.log", "w"),
        stderr=subprocess.STDOUT,
    )
    try:
        with httpx.Client(base_url=BASE, timeout=60) as c:
            for _ in range(120):
                try:
                    if c.get("/version").status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.5)
            pid = api(c, "POST", "/projects", json={"name": "Shop", "prefix": "SHOP", "color": "#2E6F40"})["id"]
            api(c, "POST", f"/projects/{pid}/members", json={"name": "An Nguyen", "role": "admin"})
            api(c, "PATCH", f"/projects/{pid}/ai/ops", json={"commands": {"test": "./test.sh", "lint": "", "build": ""}})
            devs = {}
            for name in ("Dev An", "Dev Binh"):
                m = api(
                    c,
                    "POST",
                    f"/projects/{pid}/ai/members",
                    json={"name": name, "provider": "claude-code", "working_dir": str(REPO), "cli_path": CLAUDE, "model": DEV_MODEL},
                )
                api(c, "PATCH", f"/ai/members/{m['id']}", json={"config": {"role": "dev"}})
                devs[name] = m["id"]

            # 1. Dev An on SHOP-1
            t1 = api(
                c,
                "POST",
                f"/projects/{pid}/tickets",
                json={
                    "title": "CSV export breaks on commas",
                    "status": "todo",
                    "description": "`to_csv` in csv_export.py writes a field that contains a comma as it is, so the "
                    "line splits into too many columns. Quote such fields (and double any quote inside them).",
                },
            )["id"]
            for crit in ("A field with a comma is quoted", "A test covers it and the tests pass"):
                api(c, "POST", f"/tickets/{t1}/acceptance-criteria", json={"text": crit})
            api(c, "POST", f"/tickets/{t1}/comments", json={"author": "An Nguyen", "text": "Từ giờ hãy viết bình luận và báo cáo bằng tiếng Việt nhé."})
            api(c, "POST", f"/tickets/{t1}/ai/assign", json={"member_id": devs["Dev An"], "start": "now"})
            r1 = wait_run(c, t1)
            report["1_dev_an_shop_1"] = run_view(c, t1, r1, "Dev An")
            # the board's own pass over the run (a light model) runs after it ends: give it time to land
            end = time.time() + 180
            while time.time() < end:
                know = api(c, "GET", f"/projects/{pid}/ai/knowledge")
                if any((n.get("written_by") or "").startswith("the board") for n in know["notes"]):
                    break
                time.sleep(5)
            know = api(c, "GET", f"/projects/{pid}/ai/knowledge")
            report["1_memory_after"] = {
                "notes": [{k: n[k] for k in ("scope", "scope_key", "kind", "text", "written_by")} for n in know["notes"]],
                "proposals": [x["text"] for x in know["lessons"] if x["state"] == "proposed"],
            }

            # 2. a person keeps the proposals; Dev Binh on SHOP-2
            for x in know["lessons"]:
                if x["state"] == "proposed":
                    api(c, "PATCH", f"/ai/lessons/{x['id']}", json={"state": "kept"})
            t2 = api(
                c,
                "POST",
                f"/projects/{pid}/tickets",
                json={
                    "title": "CSV export: a delimiter option",
                    "status": "todo",
                    "description": "Let `to_csv` take a `delimiter` argument (default \",\") so a person can export "
                    "with \";\" for spreadsheets set to a European locale.",
                },
            )["id"]
            for crit in ('`to_csv(rows, delimiter=";")` works', "A test covers it and the tests pass"):
                api(c, "POST", f"/tickets/{t2}/acceptance-criteria", json={"text": crit})
            api(c, "POST", f"/tickets/{t2}/ai/assign", json={"member_id": devs["Dev Binh"], "start": "now"})
            r2 = wait_run(c, t2)
            report["2_dev_binh_shop_2"] = run_view(c, t2, r2, "Dev Binh")

            # 3. an outside agent, MCP only
            mcp = json.dumps({"mcpServers": {"kanban": {"type": "http", "url": f"{BASE}/mcp/"}}})
            out = subprocess.run(
                [
                    CLAUDE, "-p",
                    f"You work on the project 'Shop' (id {pid}) of a Kanban board, through its MCP server only. Before "
                    "you start any work there, find out what the project's AI team has learned and how they work. "
                    "Then propose one lesson for every AI on the project that is not there yet and that you can "
                    "support from what you read (for instance about how tickets are reported). Answer with what "
                    "you read and the lesson you proposed.",
                    "--model", "haiku", "--output-format", "json", "--strict-mcp-config", "--mcp-config", mcp,
                    "--allowedTools", "mcp__kanban__*", "--permission-mode", "dontAsk",
                ],
                capture_output=True, text=True, timeout=600, cwd=str(WORK), env={k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID")},
            )
            try:
                res = json.loads(out.stdout)
            except ValueError:
                res = {"result": out.stdout[-2000:], "stderr": out.stderr[-2000:]}
            know = api(c, "GET", f"/projects/{pid}/ai/knowledge")
            report["3_outside_agent"] = {
                "answer": res.get("result"),
                "cost_usd": res.get("total_cost_usd"),
                "proposals_now": [
                    {"text": x["text"], "by": x["proposed_by"]} for x in know["lessons"] if x["state"] == "proposed"
                ],
            }
    finally:
        server.terminate()
    (WORK / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
