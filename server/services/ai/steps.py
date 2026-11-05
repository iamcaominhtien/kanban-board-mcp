"""Steps of a run (AI v2): append-only rows, written in small batches, announced as typed SSE events.

A step is what the lead or one of its subagents did: a tool call, an edit, a command and its output, text, a
message, a hook event. `StepWriter` gathers the steps a stream yields and flushes them every `FLUSH_S` seconds (or on
demand), so a run streaming ten tool calls a second costs one commit and one event per batch, not ten.
"""

import asyncio
import json
import logging
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from models import AiRun, AiRunAgent, AiRunStep

from .store import now_iso

logger = logging.getLogger("kanban.ai.steps")

FLUSH_S = 0.25
OUTPUT_MAX = 12_000  # characters of a command's output kept on its step
EVENT_STEPS_MAX = 40  # steps carried by one SSE event (the rest is fetched)


def to_dict(step: AiRunStep, with_output: bool = False) -> dict[str, Any]:
    """A step for the API and the SSE event."""
    detail = {}
    if step.detail:
        try:
            detail = json.loads(step.detail)
        except ValueError:
            detail = {}
    out = {
        "id": step.id,
        "run_id": step.run_id,
        "seq": step.seq,
        "at": step.at,
        "agent_id": step.agent_id,
        "kind": step.kind,
        "tool": step.tool,
        "title": step.title,
        "detail": detail,
        "has_output": bool(step.output),
        "parent_tool_id": step.parent_tool_id,
        "tool_id": step.tool_id,
    }
    if with_output:
        out["output"] = step.output
    return out


def agent_dict(agent: AiRunAgent) -> dict[str, Any]:
    """A subagent row as the API shows it."""
    return {
        "id": agent.id,
        "run_id": agent.run_id,
        "agent_type": agent.agent_type,
        "claude_id": agent.claude_id,
        "started_at": agent.started_at,
        "ended_at": agent.ended_at,
        "steps_count": agent.steps_count,
        "last_text": agent.last_text,
    }


async def _next_seq(session: AsyncSession, run_id: str) -> int:
    last = (
        await session.exec(
            select(AiRunStep.seq)
            .where(AiRunStep.run_id == run_id)
            .order_by(col(AiRunStep.seq).desc())
            .limit(1)
        )
    ).first()
    return (last or 0) + 1


async def append(
    run_id: str,
    rows: list[dict[str, Any]],
    *,
    agents: list[dict[str, Any]] | None = None,
    fields: dict[str, Any] | None = None,
    files: list[dict[str, Any]] | None = None,
    announce: bool = True,
) -> list[AiRunStep]:
    """Write steps (and subagent starts/stops, run fields, changed files) in one commit and announce them.

    Each row: {kind, title, tool?, detail?, output?, agent_id?, parent_tool_id?, at?}.
    Each agent: {id, agent_type?, claude_id?, ended?: bool, last_text?}.
    """
    if not rows and not agents and not fields and not files:
        return []
    written: list[AiRunStep] = []
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return []
        seq = await _next_seq(session, run_id)
        per_agent: dict[str, int] = {}
        for r in rows:
            step = AiRunStep(
                run_id=run_id,
                seq=seq,
                at=r.get("at") or now_iso(),
                agent_id=r.get("agent_id"),
                kind=r.get("kind") or "tool",
                tool=r.get("tool"),
                title=(r.get("title") or "")[:400],
                detail=json.dumps(r.get("detail") or {}, default=str),
                output=(r["output"][:OUTPUT_MAX] if r.get("output") else None),
                parent_tool_id=r.get("parent_tool_id"),
                tool_id=r.get("tool_id"),
            )
            session.add(step)
            written.append(step)
            seq += 1
            if step.agent_id:
                per_agent[step.agent_id] = per_agent.get(step.agent_id, 0) + 1
        run.steps_count = (run.steps_count or 0) + len(rows)
        if rows:
            run.last_output_at = now_iso()
        for a in agents or []:
            agent = await session.get(AiRunAgent, a["id"])
            if agent is None:
                agent = AiRunAgent(
                    id=a["id"], run_id=run_id, agent_type=a.get("agent_type") or ""
                )
            if a.get("agent_type"):
                agent.agent_type = a["agent_type"]
            if a.get("claude_id"):
                agent.claude_id = a["claude_id"]
            if a.get("last_text"):
                agent.last_text = a["last_text"][:400]
            if a.get("ended"):
                agent.ended_at = now_iso()
            agent.steps_count += per_agent.pop(a["id"], 0)
            session.add(agent)
        for agent_id, n in per_agent.items():
            agent = await session.get(AiRunAgent, agent_id)
            if agent is None:
                agent = AiRunAgent(id=agent_id, run_id=run_id, agent_type="")
            agent.steps_count += n
            session.add(agent)
        if files:
            try:
                current = {f["path"]: f for f in json.loads(run.files or "[]")}
            except ValueError:
                current = {}
            for f in files:
                prev = current.get(f["path"])
                if prev:
                    prev["added"] = prev.get("added", 0) + f.get("added", 0)
                    prev["removed"] = prev.get("removed", 0) + f.get("removed", 0)
                else:
                    current[f["path"]] = dict(f)
            run.files = json.dumps(list(current.values()))
        for key, value in (fields or {}).items():
            setattr(run, key, value)
        session.add(run)
        await session.commit()
        for step in written:
            await session.refresh(step)
        snapshot = {
            "run_id": run_id,
            "state": run.state,
            "steps_count": run.steps_count,
            "last_output_at": run.last_output_at,
        }
        agent_rows = (
            [
                agent_dict(a)
                for a in (
                    await session.exec(
                        select(AiRunAgent).where(AiRunAgent.run_id == run_id)
                    )
                ).all()
            ]
            if agents or per_agent
            else None
        )
    if announce:
        payload = {
            **snapshot,
            "steps": [to_dict(s) for s in written[-EVENT_STEPS_MAX:]],
            "truncated": len(written) > EVENT_STEPS_MAX,
        }
        if agent_rows is not None:
            payload["agents"] = agent_rows
        if fields:
            payload["fields"] = {k: v for k, v in fields.items() if k != "steps_count"}
        await board_events.publish_typed("ai.step", payload)
        board_events.mark_own_change()
    return written


class StepWriter:
    """Gathers a run's steps as its stream yields them and writes them in batches."""

    def __init__(self, run_id: str):
        """Batch the steps of `run_id`."""
        self.run_id = run_id
        self.rows: list[dict[str, Any]] = []
        self.agents: list[dict[str, Any]] = []
        self.files: list[dict[str, Any]] = []
        self.fields: dict[str, Any] = {}
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self.written = 0

    def add(
        self,
        rows: list[dict[str, Any]] | None = None,
        *,
        agents: list[dict[str, Any]] | None = None,
        files: list[dict[str, Any]] | None = None,
        fields: dict[str, Any] | None = None,
    ) -> None:
        """Queue rows (and agents, fields, files) for the next flush."""
        if rows:
            self.rows.extend(rows)
        if agents:
            self.agents.extend(agents)
        if files:
            self.files.extend(files)
        if fields:
            self.fields.update(fields)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._later())

    async def _later(self) -> None:
        await asyncio.sleep(FLUSH_S)
        await self.flush()

    async def flush(self) -> None:
        """Write what is queued now."""
        async with self._lock:
            rows, agents, files, fields = (
                self.rows,
                self.agents,
                self.files,
                self.fields,
            )
            self.rows, self.agents, self.files, self.fields = [], [], [], {}
            if not (rows or agents or files or fields):
                return
            try:
                written = await append(
                    self.run_id, rows, agents=agents, files=files, fields=fields
                )
                self.written += len(written)
            except Exception:  # noqa: BLE001 - a lost batch of steps never stops the run
                logger.exception("Could not write the steps of run %s", self.run_id)

    async def close(self) -> None:
        """Write what is left and stop the timer."""
        if self._task and not self._task.done():
            self._task.cancel()
        await self.flush()


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


async def read(
    session: AsyncSession,
    run_id: str,
    *,
    after: int = 0,
    limit: int = 200,
    agent_id: str | None = None,
    last: bool = False,
) -> list[dict[str, Any]]:
    """Steps of a run after `after` (a seq), oldest first; with `last`, the newest `limit` instead."""
    stmt = select(AiRunStep).where(AiRunStep.run_id == run_id)
    if after:
        stmt = stmt.where(AiRunStep.seq > after)
    if agent_id == "lead":
        stmt = stmt.where(col(AiRunStep.agent_id).is_(None))
    elif agent_id:
        stmt = stmt.where(AiRunStep.agent_id == agent_id)
    stmt = stmt.order_by(
        col(AiRunStep.seq).desc() if last else col(AiRunStep.seq).asc()
    ).limit(limit)
    rows = list((await session.exec(stmt)).all())
    if last:
        rows.reverse()
    return [to_dict(s) for s in rows]


async def attach_result(
    run_id: str, tool_id: str, output_text: str | None, detail: dict[str, Any]
) -> bool:
    """A tool's result arrived for a step already written: its output and exit code go onto that step."""
    async with database.async_session() as session:
        row = (
            await session.exec(
                select(AiRunStep).where(
                    AiRunStep.run_id == run_id, AiRunStep.tool_id == tool_id
                )
            )
        ).first()
        if row is None:
            return False
        if output_text:
            row.output = output_text[:OUTPUT_MAX]
        try:
            current = json.loads(row.detail or "{}")
        except ValueError:
            current = {}
        row.detail = json.dumps({**current, **detail}, default=str)
        session.add(row)
        await session.commit()
        return True


async def output(session: AsyncSession, run_id: str, seq: int) -> dict[str, Any] | None:
    """One step with its output."""
    row = (
        await session.exec(
            select(AiRunStep).where(AiRunStep.run_id == run_id, AiRunStep.seq == seq)
        )
    ).first()
    return to_dict(row, with_output=True) if row else None


async def agents(session: AsyncSession, run_id: str) -> list[dict[str, Any]]:
    """The subagents of a run, oldest first."""
    rows = (
        await session.exec(
            select(AiRunAgent)
            .where(AiRunAgent.run_id == run_id)
            .order_by(col(AiRunAgent.started_at).asc())
        )
    ).all()
    return [agent_dict(a) for a in rows]


async def all_rows(session: AsyncSession, run_id: str) -> list[AiRunStep]:
    """Every step of a run (for the work log and the transcript)."""
    return list(
        (
            await session.exec(
                select(AiRunStep)
                .where(AiRunStep.run_id == run_id)
                .order_by(col(AiRunStep.seq).asc())
            )
        ).all()
    )


async def delete_for_run(session: AsyncSession, run_id: str) -> None:
    """Forget a run's steps and agents (retention, a deleted project)."""
    for row in (
        await session.exec(select(AiRunStep).where(AiRunStep.run_id == run_id))
    ).all():
        await session.delete(row)
    for row in (
        await session.exec(select(AiRunAgent).where(AiRunAgent.run_id == run_id))
    ).all():
        await session.delete(row)
