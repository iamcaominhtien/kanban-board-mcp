"""Golden vectors for `services/ai/teams.py` (`crates/kb-ai-run/src/teams/`).

`pure`: names and colours (`_clean_name`, `_clean_color`), a team's data (`_validate`), the one status of a team
(`status_of` over every state), what a run's end and a runner check do to a team's health (`note_run_outcome`,
`_apply_health`).

With a database, built here with the Python models and written as the rows the models dump (the Rust test puts the
same rows into its own database): `check_name` over a table of names (case, spaces, Unicode, a person, a team, a
removed team, the excluded id), `create` and `update` over tables of data (the stored rows or the refusal, and the
audit entry), `describe`, `list_teams` and `removal_impact` for teams in every shape.

Paths: this run's temporary folder is written `<ROOT>`; today's date (UTC), which `describe` counts a team's runs
from, `<TODAY>`.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_teams.py
Writes `ai_teams.json` next to this file.
"""

import asyncio
import itertools
import json
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

work = os.path.realpath(tempfile.mkdtemp(prefix="gen-ai-teams-"))
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude-config"
os.environ["KANBAN_AI_ROOTS"] = work
os.environ["KANBAN_AI_ACCOUNTS_HOME"] = f"{work}/accounts"
os.environ["HOME"] = f"{work}/home"
os.environ["PATH"] = f"{work}/bin:/usr/bin:/bin"
sys.path.insert(0, os.getcwd())
os.makedirs(f"{work}/home", exist_ok=True)

from sqlmodel import col, select  # noqa: E402

import database  # noqa: E402
from models import AiAccount, AiAudit, AiProjectSettings, AiRun, AiTeam, Member, Project, Ticket  # noqa: E402
from services.ai import teams  # noqa: E402

OUT = Path(__file__).with_name("ai_teams.json")
STAMP = "2025-01-01T00:00:00+00:00"
TODAY = datetime.now(UTC).date().isoformat()
out: dict = {}


def norm(value):
    if isinstance(value, str):
        return value.replace(work, "<ROOT>").replace(TODAY, "<TODAY>")
    if isinstance(value, list):
        return [norm(v) for v in value]
    if isinstance(value, dict):
        return {norm(k): norm(v) for k, v in value.items()}
    return value


def row_dict(row):
    return norm(json.loads(row.model_dump_json()))


def refused(call):
    try:
        return {"ok": call()}
    except teams.TeamError as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------------------------------------------------
# pure
# ---------------------------------------------------------------------------------------------------------------------
pure: dict = {}
NAMES = [
    "Dev An",
    "  Dev   An  ",
    "dev\tan\nmax",
    "",
    "   ",
    "\x1c\x1d",
    "x" * 80,
    "x" * 81,
    "é" * 80,
    "é" * 81,
    "Đội Phát triển",
    "ÄÖÜ ß İstanbul",
    "Claude Code · Backend",
    "a" * 79 + " b",
    "0",
    "名前",
]
pure["clean_name"] = [{"name": n, "out": refused(lambda n=n: teams._clean_name(n))} for n in NAMES]
COLORS = ["#2e6f40", "#2E6F40", " #abcdef ", "#ABCDEG", "2E6F40", "#2E6F4", "#2E6F400", "", "   ", "#äbcdef", "#123456\n", "red", "#FFF", "\t#0a0B0c\n"]
pure["clean_color"] = [{"color": c, "out": refused(lambda c=c: teams._clean_color(c))} for c in COLORS]
pure["constants"] = {
    "AI_COLORS": teams.AI_COLORS,
    "MAX_PERSONA": teams.MAX_PERSONA,
    "MODELS": list(teams.MODELS),
    "EFFORTS": list(teams.EFFORTS),
    "PERMISSION_MODES": list(teams.PERMISSION_MODES),
    "HEALTH_INTERVAL_S": teams.HEALTH_INTERVAL_S,
    "HEALTH_STALE_S": teams.HEALTH_STALE_S,
    "ACCOUNT_STALE_S": teams.ACCOUNT_STALE_S,
    "EDITABLE": list(teams._EDITABLE),
}

VALIDATE = [
    {},
    {"model": "haiku"},
    {"model": "sonnet"},
    {"model": "opus"},
    {"model": "gpt"},
    {"model": "claude-opus-5-1"},
    {"model": "-"},
    {"model": ""},
    {"model": None},
    {"model": "Haiku"},
    {"effort": "low"},
    {"effort": "xhigh"},
    {"effort": "max"},
    {"effort": "extreme"},
    {"effort": ""},
    {"effort": None},
    {"permission_mode": "bypass"},
    {"permission_mode": "auto"},
    {"permission_mode": "ask"},
    {"permission_mode": ""},
    {"persona": "x" * 4000},
    {"persona": "x" * 4001},
    {"persona": "é" * 4000},
    {"persona": ""},
    {"max_parallel": 1},
    {"max_parallel": 0},
    {"max_parallel": -3},
    {"max_parallel": None},
    {"max_runs_per_day": 0},
    {"max_runs_per_day": 50},
    {"tokens_per_day": 0},
    {"tokens_per_day": 1},
    {"daily_budget": 0},
    {"daily_budget": 0.0},
    {"daily_budget": -0.01},
    {"daily_budget": 12.5},
    {"daily_budget": None},
    {"monthly_cap": -1},
    {"cap_per_run": -1.5},
    {"cap_per_run": 3},
    {"scope": "assigned"},
    {"scope": "project"},
    {"scope": "all"},
    {"scope": ""},
    {"pack_key": "standard"},
    {"pack_key": "full"},
    {"pack_key": "my_pack-2"},
    {"pack_key": "My Pack"},
    {"pack_key": "x" * 40},
    {"pack_key": "x" * 41},
    {"pack_key": ""},
    {"pack_key": "pack\n"},
    {"pack_key": "ünï"},
    {"config": {}},
    {"config": {"roles": []}},
    {"config": None},
    {"model": "gpt", "effort": "extreme"},
    {"effort": "extreme", "scope": "all", "max_parallel": 0},
    {"name": "anything", "color": "not checked here", "max_parallel": 4, "daily_budget": 1.5, "scope": "project", "pack_key": "docs"},
]
pure["validate"] = [{"data": d, "out": refused(lambda d=d: teams._validate(d))} for d in VALIDATE]


def run_of(state, ticket_id="KAN-1"):
    return AiRun(id=f"run_{state}", project_id="p", member_id="m", state=state, ticket_id=ticket_id)


RUNS = {
    "none": [],
    "queued": ["queued"],
    "waiting": ["queued", "needs_input", "running"],
    "starting": ["starting"],
    "ended": ["finished", "failed"],
}
pure["status_of"] = []
for kind, health, paused_all, paused, runs_key in itertools.product(
    ("ai", "ai_removed"), ("ok", "unknown", "not_logged_in", "runner_missing", "rate_limited"), (False, True), (False, True), RUNS
):
    member = Member(id="m", project_id="p", name="Dev An", color="#000000", kind=kind)
    profile = AiTeam(id="m", project_id="p", health=health, health_detail=f"detail of {health}" if health not in ("ok", "unknown") else None, paused=paused, paused_reason="lunch" if paused else None)
    settings = AiProjectSettings(project_id="p", paused_all=paused_all, paused_reason="Stopped by An" if paused_all else None)
    got = teams.status_of(member, profile, [run_of(s) for s in RUNS[runs_key]], settings)
    pure["status_of"].append({"kind": kind, "health": health, "paused_all": paused_all, "paused": paused, "runs": RUNS[runs_key], "out": got, "keys": list(got)})

pure["note_run_outcome"] = []
for health, state, stop_code, reason in itertools.product(
    ("ok", "unknown", "rate_limited", "not_logged_in"), ("finished", "failed", "cancelled"), (None, "rate_limited", "budget"), (None, "You hit your limit, resets 3pm")
):
    profile = AiTeam(id="m", project_id="p", health=health, health_detail="before")
    changed = teams.note_run_outcome(profile, state, stop_code, reason)
    pure["note_run_outcome"].append({"health": health, "state": state, "stop_code": stop_code, "reason": reason, "changed": changed, "after": [profile.health, profile.health_detail]})

INFOS = [{}, {"found": False}, {"found": True, "logged_in": False}, {"found": True, "logged_in": None}, {"found": True, "logged_in": True}, {"found": True}, {"found": 1, "logged_in": 0}]
os.makedirs(f"{work}/tools", exist_ok=True)
Path(f"{work}/tools/plain.txt").write_text("not a program")
CLI_PATHS = [None, "", "   ", f"{work}/tools/no-such-claude", f"{work}/tools/plain.txt", "/etc/hostname-of-nobody/claude"]
pure["apply_health"] = []
for info, health, cli_path in itertools.product(INFOS, ("unknown", "ok", "rate_limited", "runner_missing"), CLI_PATHS):
    profile = AiTeam(id="m", project_id="p", health=health, health_detail="before", cli_path=cli_path)
    teams._apply_health(profile, info)
    pure["apply_health"].append({"info": info, "health": health, "cli_path": norm(cli_path), "after": [profile.health, norm(profile.health_detail)]})
pure["files"] = [{"path": "<ROOT>/tools/plain.txt", "text": "not a program"}]
out["pure"] = pure


# ---------------------------------------------------------------------------------------------------------------------
# with a database
# ---------------------------------------------------------------------------------------------------------------------
async def last_audit(session, project_id):
    row = (await session.exec(select(AiAudit).where(AiAudit.project_id == project_id).order_by(col(AiAudit.seq).desc()).limit(1))).first()
    if row is None:
        return None
    return {"action": row.action, "result": row.result, "member_name": row.member_name, "on_behalf_of": row.on_behalf_of, "detail": row.detail}


def stored(row, drop=("id", "created_at", "updated_at")):
    return {k: v for k, v in row_dict(row).items() if k not in drop}


async def check_names():
    pid = "p-names"
    async with database.async_session() as session:
        rows = [
            Project(id=pid, name="Kanban Board", prefix="NAM", color="#2E6F40"),
            Member(id="n-an", project_id=pid, name="An Nguyen", color="#3B82F6", created_at=STAMP),
            Member(id="n-mai", project_id=pid, name="  Mai   Trần ", color="#3B82F6", created_at=STAMP),
            Member(id="n-ist", project_id=pid, name="İstanbul Ops", color="#3B82F6", created_at=STAMP),
            Member(id="n-dev", project_id=pid, name="Dev An", color="#2E6F40", kind="ai", created_at=STAMP),
            Member(id="n-dev2", project_id=pid, name="dev an 2", color="#2E6F40", kind="ai", created_at=STAMP),
            Member(id="n-dev3", project_id=pid, name="Dev An 3", color="#2E6F40", created_at=STAMP),
            Member(id="n-qa", project_id=pid, name="QA Đội", color="#2E6F40", kind="ai", created_at=STAMP),
            Member(id="n-gone", project_id=pid, name="Old Bot", color="#2E6F40", kind="ai_removed", created_at=STAMP),
            Member(id="n-sigma", project_id=pid, name="ΣΑΣ", color="#2E6F40", kind="ai", created_at=STAMP),
            Project(id="p-names-other", name="Other", prefix="NAO", color="#2E6F40"),
            Member(id="o-zed", project_id="p-names-other", name="Zed", color="#3B82F6", created_at=STAMP),
        ]
        for r in rows:
            session.add(r)
        await session.commit()
        dumped = {"project": [row_dict(r) for r in rows if isinstance(r, Project)], "member": [row_dict(r) for r in rows if isinstance(r, Member)]}
        table = [
            ("An Nguyen", None),
            ("  an   nguyen ", None),
            ("AN NGUYEN", None),
            ("An Nguyen", "n-an"),
            ("Mai Trần", None),
            ("mai trần", None),
            ("Mai   Trần", None),
            ("MAI TRẦN", None),
            ("İstanbul Ops", None),
            ("i̇stanbul ops", None),
            ("istanbul ops", None),
            ("Dev An", None),
            ("dev an", None),
            ("DEV  AN", None),
            ("Dev An", "n-dev"),
            ("Dev An 2", None),
            ("Dev An 2", "n-dev2"),
            ("Dev An 3", None),
            ("Dev An 4", None),
            ("QA Đội", None),
            ("qa đội", None),
            ("QA ĐỘI", None),
            ("Old Bot", None),
            ("old bot", None),
            ("ΣΑΣ", None),
            ("σας", None),
            ("σασ", None),
            ("Zed", None),
            ("", None),
            ("   ", None),
            ("New Team", None),
            ("New\tTeam", "n-an"),
        ]
        cases = []
        for name, exclude in table:
            cases.append({"project_id": pid, "name": name, "exclude_id": exclude, "out": await teams.check_name(session, pid, name, exclude)})
        cases.append({"project_id": "p-no-such", "name": "Anyone", "exclude_id": None, "out": await teams.check_name(session, "p-no-such", "Anyone")})
        cases.append({"project_id": "p-names-other", "name": "zed", "exclude_id": None, "out": await teams.check_name(session, "p-names-other", "zed")})
        # a member of a project that is gone: "this project"
        orphan = Member(id="x-orphan", project_id="p-gone", name="Orphan", color="#000000", created_at=STAMP)
        session.add(orphan)
        await session.commit()
        dumped["member"].append(row_dict(orphan))
        cases.append({"project_id": "p-gone", "name": "orphan", "exclude_id": None, "out": await teams.check_name(session, "p-gone", "orphan")})
    return {"rows": dumped, "cases": cases}


CREATE = [
    {"name": "Dev An"},
    {"name": "  Dev   Bình  ", "color": "#6d5dd3", "description": "  Backend team  ", "working_dir": "  <ROOT>/repo  ", "cli_path": "<ROOT>/bin/claude", "model": "haiku", "effort": "high", "persona": "  You are careful.  ", "pack_key": "feature_ui", "permission_mode": "auto", "max_parallel": 4, "daily_budget": 12.5, "monthly_cap": 100, "max_runs_per_day": 30, "tokens_per_day": 500000, "cap_per_run": 2, "scope": "project", "config": {"roles": [{"key": "qa", "off": True}], "mcp_servers": "not a list", "extra": {"kept": 1}, "disallowed_tools": ["WebFetch"]}},
    {"name": "dev an"},
    {"name": "An Nguyen"},
    {"name": ""},
    {"name": None},
    {},
    {"name": "x" * 81},
    {"name": "Colour", "color": "red"},
    {"name": "Model", "model": "gpt"},
    {"name": "Effort", "effort": "extreme"},
    {"name": "Account", "account_id": "acct_teams_claude"},
    {"name": "No account", "account_id": "acct_no_such"},
    {"name": "Codex account", "account_id": "acct_teams_codex"},
    {"name": "Empty values", "color": "", "description": None, "working_dir": "   ", "cli_path": "", "model": "", "effort": "", "persona": None, "pack_key": "", "permission_mode": "", "max_parallel": None, "daily_budget": None, "scope": "", "config": None, "account_id": ""},
    {"name": "Long description", "description": "d" * 250, "model": "claude-sonnet-5-2", "pack_key": "own_pack"},
    {"name": "Zero budget", "daily_budget": 0, "monthly_cap": 0.0, "cap_per_run": 0},
    {"name": "Bad parallel", "max_parallel": 0},
    {"name": "Bad budget", "monthly_cap": -5},
    {"name": "Bad config", "config": []},
    {"name": "Đội Phát triển", "persona": "x" * 4001},
    {"name": "Đội Phát triển", "persona": "Viết tiếng Việt “rõ ràng”."},
]

UPDATE = [
    {},
    {"description": "  New words  "},
    {"description": ""},
    {"name": "  Renamed   Team "},
    {"name": "renamed team"},
    {"name": "An Nguyen"},
    {"name": "Other Team"},
    {"name": ""},
    {"name": None},
    {"color": "#c4432a"},
    {"color": "blue"},
    {"color": ""},
    {"color": None},
    {"pack_key": "feature_ui", "effort": "high", "permission_mode": "auto", "config": {"roles": [{"key": "qa", "off": True}, {"key": "security", "model": "opus"}]}},
    {"effort": "extreme"},
    {"permission_mode": "ask"},
    {"config": {"instructions": "Answer in English.", "mcp_servers": [{"name": "gh", "command": "gh-mcp"}]}},
    {"config": {"roles": None, "skills": "x"}},
    {"config": None},
    {"config": {}},
    {"working_dir": "  <ROOT>/elsewhere  "},
    {"working_dir": "   "},
    {"cli_path": "<ROOT>/bin/other-claude"},
    {"cli_path": None},
    {"persona": "  Short.  ", "model": "opus"},
    {"persona": None, "model": None, "effort": None, "pack_key": None},
    {"persona": "", "model": "claude-haiku-5-5"},
    {"max_parallel": 5, "daily_budget": 3, "monthly_cap": 40.5, "max_runs_per_day": 9, "tokens_per_day": 1000, "cap_per_run": 0.5, "scope": "project"},
    {"daily_budget": None, "monthly_cap": None, "max_runs_per_day": None, "tokens_per_day": None, "cap_per_run": None},
    {"max_parallel": 0},
    {"scope": "everything"},
    {"account_id": "acct_teams_claude"},
    {"account_id": "acct_teams_codex"},
    {"account_id": "acct_no_such"},
    {"account_id": None},
    {"account_id": ""},
    {"description": "after health", "unknown_key": "ignored", "health": "ok"},
]


def fill(data):
    return json.loads(json.dumps(data).replace("<ROOT>", work))


async def creates_and_updates():
    pid = "p-edit"
    async with database.async_session() as session:
        rows = [
            Project(id=pid, name="Kanban Board", prefix="EDT", color="#2E6F40"),
            Member(id="e-an", project_id=pid, name="An Nguyen", color="#3B82F6", created_at=STAMP),
            AiAccount(id="acct_teams_claude", name="Work Claude", cli="claude", folder=f"{work}/accounts/work", status="signed_in", created_at=STAMP, updated_at=STAMP),
            AiAccount(id="acct_teams_codex", name="Work Codex", cli="codex", folder=f"{work}/accounts/codex", status="signed_in", created_at=STAMP, updated_at=STAMP),
        ]
        for r in rows:
            session.add(r)
        await session.commit()
        dumped = {"project": [row_dict(rows[0])], "member": [row_dict(rows[1])], "ai_account": [row_dict(rows[2]), row_dict(rows[3])]}
        created = []
        for data in CREATE:
            try:
                member = await teams.create(session, pid, fill(data), by="An Nguyen")
            except Exception as exc:  # noqa: BLE001 - the kind of error is part of the vector
                await session.rollback()
                created.append({"data": data, "error": [type(exc).__name__, str(exc)]})
                continue
            profile = await session.get(AiTeam, member.id)
            created.append({"data": data, "member": stored(member, ("id", "created_at")), "profile": stored(profile), "audit": await last_audit(session, pid)})

    pid = "p-update"
    async with database.async_session() as session:
        rows = [
            Project(id=pid, name="Kanban Board", prefix="UPD", color="#2E6F40"),
            Member(id="u-an", project_id=pid, name="An Nguyen", color="#3B82F6", created_at=STAMP),
            Member(id="u-team", project_id=pid, name="Dev An", color="#2E6F40", kind="ai", created_at=STAMP),
            AiTeam(id="u-team", project_id=pid, model="haiku", pack_key="standard", working_dir=f"{work}/repo", cli_path=f"{work}/bin/claude", health="ok", checked_at=STAMP, created_by="An Nguyen", created_at=STAMP, updated_at=STAMP),
            Member(id="u-other", project_id=pid, name="Other Team", color="#2E6F40", kind="ai", created_at=STAMP),
            AiTeam(id="u-other", project_id=pid, created_at=STAMP, updated_at=STAMP),
            Member(id="u-gone", project_id=pid, name="Gone Team", color="#2E6F40", kind="ai_removed", created_at=STAMP),
            AiTeam(id="u-gone", project_id=pid, created_at=STAMP, updated_at=STAMP),
        ]
        for r in rows:
            session.add(r)
        await session.commit()
        updates = {"rows": {"project": [row_dict(rows[0])], "member": [row_dict(r) for r in rows if isinstance(r, Member)], "ai_team": [row_dict(r) for r in rows if isinstance(r, AiTeam)]}, "steps": []}
        for data in UPDATE:
            if "health" in data:
                # a healthy, checked team: only a new folder, CLI or account resets that
                profile = await session.get(AiTeam, "u-team")
                profile.health, profile.health_detail, profile.checked_at = "ok", "was fine", STAMP
                session.add(profile)
                await session.commit()
            try:
                profile = await teams.update(session, "u-team", fill({k: v for k, v in data.items() if k != "health"}), by="An Nguyen")
            except Exception as exc:  # noqa: BLE001 - the kind of error is part of the vector
                await session.rollback()
                updates["steps"].append({"data": data, "error": [type(exc).__name__, str(exc)]})
                continue
            member = await session.get(Member, "u-team")
            updates["steps"].append({"data": data, "member": stored(member, ()), "profile": stored(profile, ("updated_at",)), "audit": await last_audit(session, pid)})
        for member_id in ("u-gone", "u-an", "no-such"):
            try:
                await teams.update(session, member_id, {"description": "x"}, by="An Nguyen")
                updates["steps"].append({"member_id": member_id, "data": {"description": "x"}, "ok": True})
            except Exception as exc:  # noqa: BLE001 - the kind of error is part of the vector
                await session.rollback()
                updates["steps"].append({"member_id": member_id, "data": {"description": "x"}, "error": [type(exc).__name__, str(exc)]})
    return {"create": {"rows": dumped, "cases": created}, "update": updates}


async def describes():
    pid = "p-describe"
    day = TODAY

    def team(tid, name, created_at, kind="ai", **fields):
        return [
            Member(id=tid, project_id=pid, name=name, color="#2E6F40", kind=kind, created_at=created_at),
            AiTeam(id=tid, project_id=pid, created_at=created_at, updated_at=created_at, **fields),
        ]

    def ticket(tid, title, status, assignee):
        return Ticket(id=tid, project_id=pid, title=title, status=status, assignee=assignee, created_at=STAMP, updated_at=STAMP)

    def run(rid, member_id, state, **fields):
        return AiRun(id=rid, project_id=pid, member_id=member_id, state=state, queued_at=STAMP, **fields)

    rows = [
        Project(id=pid, name="Kanban Board", prefix="DSC", color="#2E6F40"),
        Member(id="d-an", project_id=pid, name="An Nguyen", color="#3B82F6", created_at=STAMP),
        AiAccount(id="acct_describe", name="Describe Claude", cli="claude", folder=f"{work}/accounts/describe", status="signed_in", email="an@work.example", plan="max", method="subscription", created_at=STAMP, updated_at=STAMP),
        *team("d-idle", "Idle Team", "2025-01-03T00:00:00+00:00", model="haiku", pack_key="standard", health="ok", checked_at=STAMP, created_by="An Nguyen"),
        *team(
            "d-busy",
            "Busy Team",
            "2025-01-02T00:00:00+00:00",
            model="opus",
            effort="high",
            pack_key="feature_ui",
            description="Does the UI work",
            persona="Careful.",
            cli_path=f"{work}/bin/claude",
            working_dir=f"{work}/repo",
            config=json.dumps({"roles": [{"key": "qa", "off": True}, {"key": "security", "model": "opus"}], "instructions": "English."}),
            permission_mode="auto",
            max_parallel=3,
            daily_budget=5.0,
            monthly_cap=80.5,
            max_runs_per_day=20,
            tokens_per_day=900000,
            cap_per_run=1.25,
            scope="project",
            health="ok",
            account_id="acct_describe",
            mcp_last_used_at="2025-01-05T10:00:00+00:00",
            created_by="An Nguyen",
        ),
        *team("d-paused", "Paused Team", "2025-01-04T00:00:00+00:00", pack_key="docs", paused=True, paused_at="2025-01-06T00:00:00+00:00", paused_reason="lunch", health="ok"),
        *team("d-limited", "Limited Team", "2025-01-05T00:00:00+00:00", pack_key="my_pack", health="rate_limited", health_detail="You hit your limit, resets 3pm", account_id="acct_gone"),
        *team("d-missing", "Missing Team", "2025-01-01T12:00:00+00:00", pack_key=None, health="runner_missing", health_detail="“claude” was not found on this computer", config="{broken"),
        *team("d-removed", "Removed Team", "2025-01-01T06:00:00+00:00", kind="ai_removed", paused=True, health="ok"),
        Member(id="d-noprofile", project_id=pid, name="No Profile", color="#2E6F40", kind="ai", created_at=STAMP),
        ticket("DSC-1", "Build the header", "in-progress", "d-busy"),
        ticket("DSC-2", "Write the footer", "todo", "d-busy"),
        ticket("DSC-3", "Done already", "done", "d-busy"),
        ticket("DSC-4", "Dropped", "wont_do", "d-busy"),
        ticket("DSC-5", "Someone else's", "review", "d-an"),
        ticket("DSC-6", "Run on a ticket of another", "testing", "d-an"),
        ticket("DSC-7", "For the idle team", "backlog", "d-idle"),
        run("r1", "d-busy", "running", ticket_id="DSC-1", number=2, started_at=f"{day}T01:00:00+00:00", cost_usd=0.12345, tokens_in=1000, tokens_out=200),
        run("r2", "d-busy", "starting", ticket_id="DSC-6", started_at=f"{day}T02:00:00+00:00", tokens_in=5),
        run("r3", "d-busy", "queued", ticket_id="DSC-2"),
        run("r4", "d-busy", "queued", ticket_id="DSC-404"),
        run("r5", "d-busy", "needs_input", ticket_id=None, started_at="2025-01-07T00:00:00+00:00", cost_usd=9.0),
        run("r6", "d-busy", "finished", ticket_id="DSC-3", number=1, started_at="2025-01-08T00:00:00+00:00", ended_at="2025-01-08T01:00:00+00:00", cost_usd=1.0),
        run("r7", "d-busy", "failed", ticket_id="DSC-1", number=1, started_at=f"{day}T00:10:00+00:00", ended_at=f"{day}T00:20:00+00:00", cost_usd=0.33333333, tokens_in=10, tokens_out=20),
        run("r8", "d-idle", "finished", ticket_id="DSC-7", number=3, started_at=f"{day}T00:30:00+00:00", ended_at=f"{day}T00:40:00+00:00"),
        run("r9", "d-paused", "cancelled", ticket_id=None, ended_at="2025-01-09T00:00:00+00:00"),
        run("r10", "d-limited", "needs_input", ticket_id="DSC-5", started_at="2025-01-10T00:00:00+00:00"),
    ]
    async with database.async_session() as session:
        for r in rows:
            session.add(r)
        await session.commit()
        dumped: dict = {}
        for r in rows:
            dumped.setdefault(r.__tablename__, []).append(row_dict(r))
        result: dict = {"rows": dumped, "describe": {}, "removal_impact": {}}
        for tid in ("d-idle", "d-busy", "d-paused", "d-limited", "d-missing", "d-removed"):
            member, profile = await teams.get_profile(session, tid)
            got = await teams.describe(session, member, profile)
            result["describe"][tid] = {"out": norm(got), "keys": list(got)}
            result["removal_impact"][tid] = norm(await teams.removal_impact(session, tid))
        result["list"] = [t["id"] for t in await teams.list_teams(session, pid)]
        result["list_removed"] = [t["id"] for t in await teams.list_teams(session, pid, include_removed=True)]
        # with every AI of the project paused
        settings = await session.get(AiProjectSettings, pid)
        settings.paused_all, settings.paused_reason = True, "Stopped by An"
        session.add(settings)
        await session.commit()
        result["paused_all"] = {t["id"]: t["status"] for t in await teams.list_teams(session, pid, include_removed=True)}
    return result


async def main():
    await database.init_db()
    out["check_name"] = await check_names()
    out.update(await creates_and_updates())
    out["describe"] = await describes()
    text = json.dumps(out, ensure_ascii=False, indent=1)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(text.encode()) // 1024} KB")
    for group in ("create", "update"):
        errors = [c for c in (out[group].get("cases") or out[group].get("steps")) if "error" in c]
        print(f"  {group}: {len(errors)} refused, kinds {sorted({e['error'][0] for e in errors})}")


asyncio.run(main())
