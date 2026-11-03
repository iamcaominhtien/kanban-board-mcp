"""The move that the Settings wizard runs (design D0 to D4, E1, E2): one at a time, in the background, with its
progress readable at any moment, and pause, resume, cancel, an AI's fix, and the switch.

The source is always the database the board uses now. What a copy has done is written to ``db-move.json`` in the data
folder as it goes, so a copy the computer's sleep or a restart interrupted is offered again ("Resume from ai_run").
The target's password is kept there encrypted, as in the settings file.
"""

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path

import database

from . import assist, targets
from .move import CopyStopped, Mover, MoveError, TableState

logger = logging.getLogger("kanban.dbmove")

STATE_FILE = "db-move.json"

_job: "Job | None" = None
_lock = asyncio.Lock()


class JobError(ValueError):
    """A step that cannot be taken now; `code` and `status` for the API."""

    def __init__(self, code: str, message: str, status: int = 409, **info):
        """Say what and why."""
        super().__init__(message)
        self.code = code
        self.status = status
        self.info = info


def _attachments() -> dict:
    """The attachments that stay in the data folder (they are files, not rows)."""
    import uploads as uploads_module

    folder = uploads_module.get_uploads_dir(create=False)
    files = size = 0
    if folder.exists():
        for f in folder.rglob("*"):
            if f.is_file():
                files += 1
                size += f.stat().st_size
    return {"folder": str(folder), "files": files, "size": size}


def _state_path() -> Path:
    return database.get_data_dir() / STATE_FILE


class Job:
    """One move, from the database in use to `target`."""

    def __init__(self, target: targets.Target):
        """Prepare a move; nothing is opened until `check`."""
        self.id = uuid.uuid4().hex[:12]
        self.source = database.current_target()
        self.target = target
        self.state = "new"  # new | ready | copying | pausing | paused | stopped | verifying | verified | failed |
        #                      cancelled | switching | switched | interrupted
        self.mode = "copy"
        self.mover: Mover | None = None
        self.plan: dict | None = None
        self.report: dict | None = None
        self.stop = None
        self.verify: dict | None = None
        self.error: dict | None = None
        self.ai: dict = {"state": "idle"}
        self.task: asyncio.Task | None = None
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.current: str | None = None
        self.fingerprint: str | None = None
        self.resume_at: str | None = None
        self.applied: list[str] = []

    # -- what the page reads ------------------------------------------------

    @property
    def tables(self) -> list[TableState]:
        """Per-table progress."""
        return self.mover.tables if self.mover else []

    def as_dict(self) -> dict:
        """Everything the wizard shows."""
        tables = self.tables
        rows_total = sum(t.rows for t in tables)
        rows_done = sum(t.copied if t.state != "done" else t.rows for t in tables)
        done = sum(1 for t in tables if t.state == "done")
        elapsed = None
        if self.started_at:
            elapsed = round((self.finished_at or time.time()) - self.started_at, 1)
        left = None
        if elapsed and rows_done and self.state == "copying" and rows_total > rows_done:
            left = round(elapsed * (rows_total - rows_done) / rows_done, 0)
        return {
            "id": self.id,
            "state": self.state,
            "mode": self.mode,
            "source": {
                **self.source.public(),
                "label": self.source.label,
                "display": self.source.display(),
            },
            "target": {
                **self.target.public(),
                "label": self.target.label,
                "display": self.target.display(),
            },
            "plan": self.plan,
            "report": self.report,
            "tables": [
                {
                    "name": t.name,
                    "rows": t.rows,
                    "copied": t.rows if t.state == "done" else t.copied,
                    "state": t.state,
                }
                for t in tables
            ],
            "tables_done": done,
            "tables_total": len(tables),
            "rows_total": rows_total,
            "rows_done": rows_done,
            "current": self.current,
            "elapsed_s": elapsed,
            "left_s": left,
            "stop": self.stop.as_dict() if self.stop else None,
            "verify": self.verify,
            "error": self.error,
            "ai": self.ai,
            "resume_at": self.resume_at,
            "applied": self.applied,
        }

    def save(self) -> None:
        """Remember where the copy is, for a resume after a restart."""
        if self.state in ("cancelled", "switched", "new", "ready"):
            _state_path().unlink(missing_ok=True)
            return
        data = {
            "id": self.id,
            "state": self.state,
            "target": self.target.public(),
            "done": [t.name for t in self.tables if t.state == "done"],
            "stopped_in": self.current,
            "saved_at": time.time(),
        }
        if self.target.password:
            data["password_enc"] = targets._encrypt(self.target.password)
        try:
            _state_path().write_text(json.dumps(data, indent=2))
        except OSError:
            logger.warning("Could not save the move's progress", exc_info=True)

    async def _progress(self, event: dict) -> None:
        if event.get("type") == "table":
            self.current = event["table"]
        if event.get("type") == "table_done":
            self.save()

    # -- steps --------------------------------------------------------------

    async def check(self) -> dict:
        """Step 2: test the target and read what will be copied."""
        from . import probe

        report = await probe.test(self.target)
        self.report = report.as_dict()
        if not report.ok:
            raise JobError(
                "target",
                "The target did not pass the test.",
                status=422,
                report=self.report,
            )
        if self.mover is None:
            self.mover = Mover(self.source, self.target, on_progress=self._progress)
        await self.mover.open()
        try:
            plan = await self.mover.plan()
        finally:
            await self.mover.release()
        self.plan = plan.as_dict()
        self.plan["attachments"] = _attachments()
        self.state = "ready"
        return self.as_dict()

    def _run(self, coro) -> None:
        self.task = asyncio.create_task(self._guard(coro))

    async def _guard(self, coro) -> None:
        try:
            await coro
        except CopyStopped as stopped:
            self.stop = stopped.stop
            self.state = "stopped"
            self.resume_at = stopped.stop.table
            logger.warning(
                "The copy stopped at %s: %s", stopped.stop.table, stopped.stop.error
            )
        except MoveError as exc:
            self.state = "failed"
            self.error = {
                "code": exc.code,
                "message": str(exc),
                **{k: v for k, v in exc.info.items() if k != "state"},
            }
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - the page shows it
            logger.exception("The move failed")
            from .move import clean_error

            message, code = clean_error(exc)
            self.state = "failed"
            self.error = {"code": code or "error", "message": message}
        finally:
            self.finished_at = (
                time.time() if self.state not in ("copying", "verifying") else None
            )
            if self.mover is not None and self.state not in ("copying", "verifying"):
                await self.mover.release()
            self.save()

    async def start(self, *, mode: str = "copy", empty_first: bool = False) -> None:
        """Step 3: make the tables on the target, then copy (mode "copy") or leave it empty (mode "empty")."""
        if self.state not in ("ready", "failed"):
            raise JobError("state", f"The move is {self.state}.")
        self.mode = mode
        self.started_at = time.time()
        self.finished_at = None
        self.error = None
        self.state = "copying"
        self._run(self._copy_then_verify(empty_first=empty_first, resume=False))

    async def _copy_then_verify(
        self, *, empty_first: bool, resume: bool, start_at: str | None = None
    ) -> None:
        m = self.mover
        await m.open()
        if resume:
            await m.plan()  # counts as they are now
        await m.prepare_target(empty_first=empty_first, resume=resume)
        self.fingerprint = await m.source_fingerprint()
        if self.mode == "empty":
            self.state = "verifying"
            self.verify = {
                "ok": True,
                "empty": True,
                "checks": [
                    {
                        "key": "schema",
                        "ok": True,
                        "title": "The board's tables were made · no data copied",
                    }
                ],
            }
            self.state = "verified"
            return
        m.paused.clear()
        self.save()
        await m.copy(start_at=start_at)
        if m.paused.is_set():
            self.state = "cancelled" if m.stop_reason == "cancel" else "paused"
            self.resume_at = self.current
            return
        self.state = "verifying"
        self.verify = await m.verify()
        self.state = "verified" if self.verify["ok"] else "verified_with_differences"

    async def pause(self) -> None:
        """Stop at the next batch; the table it was in is copied again on resume."""
        if self.state != "copying" or self.mover is None:
            raise JobError("state", "Nothing is being copied.")
        self.state = "pausing"
        self.mover.stop_reason = "pause"
        self.mover.paused.set()
        if self.task:
            await self.task

    async def resume(self, *, start_at: str | None = None) -> None:
        """Go on from the table it stopped in, re-reading that table from its start."""
        if self.state not in (
            "paused",
            "stopped",
            "interrupted",
            "verified_with_differences",
        ):
            raise JobError("state", f"The move is {self.state}.")
        if self.mover is None:
            self.mover = Mover(self.source, self.target, on_progress=self._progress)
        start = start_at or self.resume_at
        self.stop = None
        self.ai = {"state": "idle"}
        self.state = "copying"
        self.started_at = self.started_at or time.time()
        self.finished_at = None
        self._run(
            self._copy_then_verify(empty_first=False, resume=True, start_at=start)
        )

    async def cancel(self) -> None:
        """Stop and clear the new database (the source was only read)."""
        if self.mover is not None and self.state == "copying":
            self.mover.stop_reason = "cancel"
            self.mover.paused.set()
            if self.task:
                await self.task
        if self.mover is not None:
            try:
                await self.mover.clear_target()
            except Exception:  # noqa: BLE001 - say it, do not fail the cancel
                logger.exception("Could not clear the target after a cancel")
            await self.mover.close()
        self.state = "cancelled"
        self.save()

    async def ask_ai(self, question: str | None = None) -> None:
        """Ask an AI about the stop, in the background."""
        if self.stop is None:
            raise JobError("state", "The copy has not stopped.")
        previous = (
            self.ai.get("proposal") if self.ai.get("state") == "answered" else None
        )
        try:
            member = await assist.pick_member()
        except assist.AssistError as exc:
            self.ai = {"state": "failed", "message": str(exc), "question": question}
            return
        self.ai = {
            "state": "asking",
            "question": question,
            "previous": previous,
            "member": member[1],
        }

        async def run():
            try:
                proposal = await assist.ask(
                    self.stop,
                    plan=self.plan,
                    question=question,
                    previous=previous,
                    member=member,
                )
                self.ai = {
                    "state": "answered",
                    "proposal": proposal,
                    "question": question,
                }
            except assist.AssistError as exc:
                self.ai = {"state": "failed", "message": str(exc), "question": question}
            except Exception as exc:  # noqa: BLE001
                logger.exception("Asking the AI failed")
                self.ai = {
                    "state": "failed",
                    "message": f"The AI could not be asked: {exc}",
                }

        asyncio.create_task(run())

    async def apply(self, statements: list[str]) -> None:
        """Run the fix on the new database, then resume from the table that stopped (the board re-checks)."""
        if self.stop is None or self.mover is None:
            raise JobError("state", "The copy has not stopped.")
        clean = assist.check_statements(statements)
        try:
            await self.mover.apply(clean)
        except Exception as exc:  # noqa: BLE001 - the server said no
            from .move import clean_error

            message, _ = clean_error(exc)
            raise JobError(
                "apply", f"The database refused it: {message}", status=422
            ) from exc
        self.applied.extend(clean)
        await self.resume()

    async def switch(self, *, force: bool = False) -> None:
        """Point the board at the target. When the source changed since the copy, the changes are copied first."""
        if self.state not in ("verified",):
            raise JobError("state", "Verify the copy before switching.")
        self.state = "switching"
        try:
            if self.mode == "copy" and not force:
                await self.mover.open()
                now = await self.mover.source_fingerprint()
                if now != self.fingerprint:
                    # the board was used during the copy: copy again, as it is now, and verify
                    await self.mover.plan()
                    await self.mover.copy()
                    self.verify = await self.mover.verify()
                    if not self.verify["ok"]:
                        self.state = "verified_with_differences"
                        raise JobError(
                            "verify", "The latest changes did not copy cleanly."
                        )
                await self.mover.release()
            if self.mover is not None:
                await self.mover.close()
            await database.use(self.target)
            self.state = "switched"
        except JobError:
            raise
        except Exception as exc:
            self.state = "verified"
            raise JobError(
                "switch", f"The switch did not happen: {exc}", status=500
            ) from exc
        finally:
            self.save()


async def current() -> Job | None:
    """The move in progress, or one an interruption left (offered as "Resume")."""
    global _job  # noqa: PLW0603
    if _job is not None:
        return _job
    path = _state_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        target = targets.from_fields(data["target"])
        password = targets._decrypt(data.get("password_enc"))
        target = target.with_password(password)
    except Exception:  # noqa: BLE001 - a file from an old version
        path.unlink(missing_ok=True)
        return None
    job = Job(target)
    job.id = data.get("id", job.id)
    job.state = "interrupted"
    job.mover = Mover(job.source, target, on_progress=job._progress)
    names = [t.name for t in job.mover.tables]
    done = set(data.get("done", []))
    for t in job.mover.tables:
        if t.name in done:
            t.state = "done"
    job.resume_at = data.get("stopped_in") or next(
        (n for n in names if n not in done), None
    )
    _job = job
    return job


async def new(target: targets.Target) -> Job:
    """Start a new move to `target` (step 2), replacing one that has finished."""
    global _job  # noqa: PLW0603
    async with _lock:
        old = await current()
        if old is not None and old.state in (
            "copying",
            "pausing",
            "verifying",
            "switching",
        ):
            raise JobError("busy", "A copy is running. Pause or cancel it first.")
        if old is not None and old.mover is not None:
            await old.mover.close()
        if database.target_source() == "environment":
            raise JobError(
                "locked",
                "KANBAN_DATABASE_URL is set, so the database cannot be changed from here.",
                status=423,
            )
        _job = Job(target)
        return _job


async def forget() -> None:
    """Close a finished move ("Keep SQLite, switch later" keeps nothing running)."""
    global _job  # noqa: PLW0603
    if _job is not None and _job.state in (
        "copying",
        "pausing",
        "verifying",
        "switching",
    ):
        raise JobError("busy", "A copy is running. Pause or cancel it first.")
    if _job is not None and _job.mover is not None:
        await _job.mover.close()
    _job = None
    _state_path().unlink(missing_ok=True)


def require() -> Job:
    """The move the request is about."""
    if _job is None:
        raise JobError("none", "No move is in progress.", status=404)
    return _job
