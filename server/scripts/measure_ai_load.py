#!/usr/bin/env python3
"""Measure the CPU and memory the server and its AI CLI processes use while several runs work together.

Starts its own server on a throwaway database, makes a project with N AI members, starts one run each and samples
every process under the server every few seconds (no psutil: it reads `ps`). Prints peak and mean per group and
writes every sample to a CSV.

    server/.venv/bin/python server/scripts/measure_ai_load.py --mode fake
    server/.venv/bin/python server/scripts/measure_ai_load.py --mode real --runs 3 --model haiku

`fake` uses the test CLI (no tokens, only measures the server). `real` runs the installed `claude` with a one-word
prompt (a few cents of tokens) and is the only mode that shows what the CLI itself costs.
"""

import argparse
import csv
import os
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

SERVER_DIR = Path(__file__).resolve().parent.parent
FAKE_CLI = SERVER_DIR / "tests" / "fixtures" / "fake_claude.py"
PROMPT = (
    "Reply with the single word pong. Do not use any tools and do not read any files."
)
GROUPS = ("server", "cli", "cli_children")


def _cpu_seconds(text: str) -> float:
    """`ps` cumulative CPU time ([dd-][hh:]mm:ss.cc) in seconds."""
    days = 0
    if "-" in text:
        d, text = text.split("-", 1)
        days = int(d)
    total = 0.0
    for part in text.split(":"):
        total = total * 60 + float(part)
    return days * 86400 + total


def snapshot() -> dict[int, dict]:
    """Every process: pid → {ppid, rss_mb, cpu_s, command}."""
    out = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,rss=,time=,command="],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    procs = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)", line)
        if m:
            pid, ppid, rss, cpu, cmd = m.groups()
            procs[int(pid)] = {
                "ppid": int(ppid),
                "rss_mb": int(rss) / 1024,
                "cpu_s": _cpu_seconds(cpu),
                "command": cmd,
            }
    return procs


def tree(procs: dict[int, dict], root: int) -> dict[int, int]:
    """Descendants of root (and root itself, depth 0): pid → depth."""
    depth = {root: 0}
    changed = True
    while changed:
        changed = False
        for pid, p in procs.items():
            if pid not in depth and p["ppid"] in depth:
                depth[pid] = depth[p["ppid"]] + 1
                changed = True
    return depth


def group_of(depth: int) -> str:
    """The server itself, a CLI it started, or something that CLI started."""
    return "server" if depth == 0 else "cli" if depth == 1 else "cli_children"


def start_server(workdir: Path, fake: bool) -> tuple[subprocess.Popen, int]:
    """Start the server on a throwaway database; returns it and its port."""
    env = {
        **os.environ,
        "KANBAN_DB_PATH": str(workdir / "measure.db"),
        "KANBAN_CONFIG_DIR": str(workdir / "cfg"),
    }
    if fake:
        env["FAKE_CLAUDE_MODE"] = "ticks"
    log = open(workdir / "server.log", "w")
    proc = subprocess.Popen(
        [sys.executable, str(SERVER_DIR / "main.py")],
        cwd=SERVER_DIR,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        m = re.search(r"READY port=(\d+)", (workdir / "server.log").read_text())
        if m:
            return proc, int(m.group(1))
        if proc.poll() is not None:
            raise SystemExit("server exited:\n" + (workdir / "server.log").read_text())
        time.sleep(0.3)
    raise SystemExit("server did not become ready")


def seed(c: httpx.Client, repo: Path, cli: str, model: str, runs: int) -> list[str]:
    """A project, `runs` members and one ticket each; returns the ticket ids."""
    pid = c.post(
        "/projects", json={"name": "Measure", "prefix": "MEA", "color": "#2E6F40"}
    ).json()["id"]
    pairs = []
    for i in range(runs):
        r = c.post(
            f"/projects/{pid}/ai/members",
            json={
                "name": f"Dev {i + 1}",
                "provider": "claude-code",
                "working_dir": str(repo),
                "cli_path": cli,
                "model": model,
                "template": "developer",
            },
        )
        assert r.status_code == 201, r.text
        t = c.post(
            f"/projects/{pid}/tickets",
            json={"title": f"Say pong {i + 1}", "status": "todo"},
        ).json()["id"]
        pairs.append((t, r.json()["id"]))
    c.state_pairs = pairs  # type: ignore[attr-defined]
    c.state_pid = pid  # type: ignore[attr-defined]
    return [t for t, _ in pairs]


def main() -> None:
    """Run the measurement and print the table."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mode", choices=["fake", "real"], default="fake")
    ap.add_argument("--runs", type=int, default=3, help="runs started together")
    ap.add_argument(
        "--duration", type=int, default=60, help="seconds to sample at most"
    )
    ap.add_argument(
        "--interval", type=float, default=2.0, help="seconds between samples"
    )
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--prompt", default=PROMPT, help="what a real run is asked to do")
    ap.add_argument(
        "--out",
        default="",
        help="CSV path (default: next to the temp folder, printed at the end)",
    )
    args = ap.parse_args()
    fake = args.mode == "fake"
    cli = str(FAKE_CLI) if fake else (shutil.which("claude") or "")
    if not cli:
        raise SystemExit("`claude` not found on PATH")

    # The project folder has to be inside the home folder.
    workdir = Path(tempfile.mkdtemp(prefix="kanban-measure-", dir=Path.home()))
    repo = workdir / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("measure\n")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    server, port = start_server(workdir, fake)
    rows: list[dict] = []
    try:
        c = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30)
        seed(c, repo, cli, args.model, args.runs)
        pid, pairs = c.state_pid, c.state_pairs  # type: ignore[attr-defined]
        base = snapshot()
        cpu_prev = {p: v["cpu_s"] for p, v in base.items()}
        t_prev = time.time()
        t0 = t_prev
        started = 0
        for t, m in pairs:
            body = {"member_id": m}
            if not fake:
                body["instruction"] = args.prompt
            started += c.post(f"/tickets/{t}/ai/run", json=body).status_code < 300
        print(
            f"server on port {port}, {started}/{args.runs} runs started ({args.mode} CLI)"
        )
        states: dict[str, str] = {}
        while time.time() - t0 < args.duration:
            time.sleep(args.interval)
            now = time.time()
            procs = snapshot()
            depth = tree(procs, server.pid)
            per_group = {g: {"rss_mb": 0.0, "cpu_pct": 0.0, "n": 0} for g in GROUPS}
            for p, d in depth.items():
                if p not in procs:
                    continue
                g = per_group[group_of(d)]
                g["rss_mb"] += procs[p]["rss_mb"]
                g["n"] += 1
                if p in cpu_prev:
                    g["cpu_pct"] += (
                        100 * (procs[p]["cpu_s"] - cpu_prev[p]) / (now - t_prev)
                    )
                elif (
                    now > t_prev
                ):  # a new process: all its CPU time happened since the last sample
                    g["cpu_pct"] += 100 * procs[p]["cpu_s"] / (now - t_prev)
            cpu_prev = {p: v["cpu_s"] for p, v in procs.items()}
            t_prev = now
            runs = c.get(f"/projects/{pid}/ai/runs", params={"limit": 60}).json()
            runs = runs if isinstance(runs, list) else runs.get("runs", [])
            states = {r["id"]: r["state"] for r in runs}
            row = {"t": round(now - t0, 1), "load1": round(os.getloadavg()[0], 2)}
            for name, g in per_group.items():
                row[f"{name}_n"] = g["n"]
                row[f"{name}_rss_mb"] = round(g["rss_mb"], 1)
                row[f"{name}_cpu_pct"] = round(g["cpu_pct"], 1)
            rows.append(row)
            if states and all(
                s not in ("queued", "starting", "running") for s in states.values()
            ):
                break
        body_bytes = len(
            c.get(f"/projects/{pid}/ai/runs", params={"limit": 60}).content
        )
        print(
            "run states:",
            sorted(set(states.values())) or "none",
            f"| /ai/runs response: {body_bytes / 1024:.0f} KB",
        )
    finally:
        try:
            os.killpg(server.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        server.wait(timeout=20)

    out = (
        Path(args.out)
        if args.out
        else Path(tempfile.gettempdir()) / f"measure-{args.mode}.csv"
    )
    if rows:
        with open(out, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    shutil.rmtree(workdir, ignore_errors=True)

    print(f"\n{len(rows)} samples, every {args.interval:g}s. CSV: {out}")
    print(
        f"{'group':<14}{'procs peak':>11}{'RSS peak MB':>13}{'RSS mean MB':>13}{'CPU peak %':>12}{'CPU mean %':>12}"
    )
    for name in GROUPS:
        if not rows:
            break
        n = [r[f"{name}_n"] for r in rows]
        rss = [r[f"{name}_rss_mb"] for r in rows]
        cpu = [r[f"{name}_cpu_pct"] for r in rows]
        print(
            f"{name:<14}{max(n):>11}{max(rss):>13.0f}{statistics.mean(rss):>13.0f}{max(cpu):>12.0f}{statistics.mean(cpu):>12.0f}"
        )
    if rows:
        print(
            f"load average (1 min): start {rows[0]['load1']}, peak {max(r['load1'] for r in rows)}"
        )
    print("CPU % is of one core (200 = two cores busy).")


if __name__ == "__main__":
    main()
