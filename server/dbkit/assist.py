"""An AI helps when a copy stops (design D4): it reads what the board knows about the stop and proposes a fix; the
board applies it, resumes the copy and re-checks the counts itself. The AI's own words never decide whether the copy
succeeded.

What the AI is shown: the error, the table and column names, the column types on both sides, the length of the value
that would not fit, the engines and row counts. Not the rows themselves and never a password or a host's credentials.

It answers through the app's own AI members (`services.ai.llm`): the Board AI of a project, else the first AI member
that can answer. A proposal is only ever ALTER TABLE statements on the board's own tables (`check_statements`).
"""

import json
import re

from sqlmodel import select

import database
from models import Project

from .move import Stop, app_tables

SYSTEM = (
    "You help a person move a Kanban board's database between SQLite, PostgreSQL and MySQL/MariaDB. A copy stopped "
    "because a value would not go into the new database. You are given what the board knows (never the rows). "
    "Explain the likely cause in two or three plain sentences, then propose the smallest change to the NEW database "
    "that lets the copy go on without losing or truncating data. Only ALTER TABLE statements on the named tables, in "
    "the dialect of the target and valid for its version; never DROP a table or a column, never change the source. "
    "Mind the target's limits (on MySQL an indexed VARCHAR column can hold at most 768 characters in utf8mb4, and a "
    "TEXT column cannot be indexed without a prefix). If more columns are likely to hit the same limit, say which.\n"
    'Reply with JSON only: {"cause": str, "statements": [str], "affects": str, "other_columns": [str], '
    '"confidence": "high"|"medium"|"low", "answer": str}. `answer` replies to the person\'s question when '
    "there is one, else is empty."
)

_ALTER = re.compile(
    r"^\s*ALTER\s+TABLE\s+[`\"]?(?P<table>[A-Za-z_][A-Za-z0-9_]*)[`\"]?\s+(?P<rest>.+?)\s*;?\s*$",
    re.I | re.S,
)
_FORBIDDEN = re.compile(
    r"\b(DROP|RENAME|TRUNCATE|DELETE|INSERT|UPDATE|GRANT|REVOKE|CREATE|ATTACH)\b", re.I
)


class AssistError(ValueError):
    """No AI can answer, or a proposal cannot be applied; the message says why."""


def bundle(stop: Stop, plan: dict | None = None) -> dict:
    """What the AI is shown about a stop (no values, no credentials)."""
    out = {
        "table": stop.table,
        "rows_in_table": stop.total,
        "stopped_at_row": stop.row,
        "rows_before_it": stop.copied,
        "tables_done": stop.tables_done,
        "tables_total": stop.tables_total,
        "error": stop.error,
        "error_code": stop.code,
        "column": stop.column,
        "value_length_chars": stop.value_length,
        "value_is_empty": stop.value_null,
        "column_type_source": stop.source_type,
        "column_type_target": stop.target_type,
        "column_target_nullable": stop.target_nullable,
        "column_target_default": stop.target_default,
        "column_target_indexes": stop.target_indexes,
        "source_engine": stop.source_engine,
        "target_engine": stop.target_engine,
        "target_version": stop.target_version,
    }
    if plan:
        out["problems_found_by_the_check"] = [
            {k: p.get(k) for k in ("table", "column", "title")}
            for p in plan.get("problems", [])
        ][:20]
    return out


def check_statements(statements: list[str]) -> list[str]:
    """Statements the board may run on the target: ALTER TABLE on one of the app's tables, one at a time, nothing that
    removes data. Returns them cleaned; raises `AssistError` naming the first that is refused."""
    known = {t.name for t in app_tables()}
    out = []
    for raw in statements:
        s = (raw or "").strip()
        if not s or s.startswith("--"):
            continue
        body = s.rstrip(";").strip()
        if ";" in body:
            raise AssistError("One statement at a time: split it at the semicolon.")
        m = _ALTER.match(body)
        if not m:
            raise AssistError(
                f"Only ALTER TABLE statements can be applied here: {s[:80]}"
            )
        if m.group("table") not in known:
            raise AssistError(f"{m.group('table')} is not one of the board's tables.")
        rest = re.sub(
            r"\bDROP\s+(NOT\s+NULL|DEFAULT)\b", "", m.group("rest"), flags=re.I
        )
        if _FORBIDDEN.search(rest):
            raise AssistError(
                f"This statement would remove or rename something: {s[:80]}"
            )
        out.append(body)
    if not out:
        raise AssistError("There is no statement to apply.")
    return out


async def pick_member():
    """(profile, name) of the AI that answers: a project's Board AI, else the first AI member that can answer."""
    from services.ai.assist import settings as assist_settings

    async with database.async_session() as session:
        projects = (await session.exec(select(Project))).all()
        for p in projects:
            info = await assist_settings.board_ai(session, p.id, fallback=True)
            if info["state"] == "ready":
                return info["profile"], info["member"].name
        for p in projects:
            for cand in await assist_settings.answerers(session, p.id):
                if cand["state"] == "ready":
                    from models import AiMember

                    return await session.get(AiMember, cand["id"]), cand["name"]
    raise AssistError(
        "No AI member can answer: add a Claude Code or API-key member in a project (AI › Members), then ask again."
    )


def _parse(text: str) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise AssistError("The AI did not answer with a proposal. Ask again.")
    try:
        data = json.loads(m.group(0))
    except ValueError as exc:
        raise AssistError("The AI's answer could not be read. Ask again.") from exc
    statements = [str(s) for s in data.get("statements") or [] if str(s).strip()]
    return {
        "cause": str(data.get("cause") or "").strip(),
        "statements": statements,
        "affects": str(data.get("affects") or "").strip(),
        "other_columns": [str(c) for c in data.get("other_columns") or []][:20],
        "confidence": str(data.get("confidence") or "medium"),
        "answer": str(data.get("answer") or "").strip(),
    }


async def ask(
    stop: Stop,
    *,
    plan: dict | None = None,
    question: str | None = None,
    previous: dict | None = None,
    member=None,
) -> dict:
    """Ask the AI about `stop`; returns its proposal (statements checked, `applicable` false when they were refused)."""
    from services.ai import llm

    profile, name = member or await pick_member()
    prompt = "What the board knows about the stop:\n" + json.dumps(
        bundle(stop, plan), indent=2
    )
    if previous:
        prompt += "\n\nYour earlier proposal:\n" + json.dumps(
            {k: previous.get(k) for k in ("cause", "statements", "affects")}, indent=2
        )
    if question:
        prompt += f"\n\nThe person asks: {question.strip()[:1000]}"
    try:
        out = await llm.complete(
            profile,
            system=SYSTEM,
            prompt=prompt,
            max_tokens=1500,
            timeout=240 if profile.connection == "local" else 90,
        )
    except llm.LlmError as exc:
        raise AssistError(f"{name} could not answer: {exc}") from exc
    proposal = _parse(out.text)
    try:
        proposal["statements"] = check_statements(proposal["statements"])
        proposal["applicable"] = True
        proposal["refused"] = None
    except AssistError as exc:
        proposal["applicable"] = False
        proposal["refused"] = str(exc)
    proposal["member"] = name
    proposal["elapsed_s"] = out.elapsed_s
    proposal["cost"] = out.cost
    proposal["shown"] = bundle(stop, plan)
    return proposal
