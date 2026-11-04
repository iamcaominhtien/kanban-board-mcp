"""AI runs (v2). Stage 1 placeholder: the public names the rest of the server calls, with no behaviour yet.

Stage 3 of docs/specs/ai-v2-implementation.md replaces this file with the lead-per-ticket run pipeline.
"""

import asyncio
from dataclasses import dataclass, field

BOARD_CLOSED = "board_closed"
_UNSET = object()


class RunError(ValueError):
    """A run could not be started or changed; the message is for the person."""


@dataclass
class _Runtime:
    """What the scheduler holds in memory."""

    wake: asyncio.Event = field(default_factory=asyncio.Event)
    tasks: dict[str, asyncio.Task] = field(default_factory=dict)
    procs: dict = field(default_factory=dict)
    board_url: str | None = None


RT = _Runtime()


def set_board_url(url: str) -> None:
    """Where the CLI reaches the board (its MCP endpoint and the hook endpoint)."""
    RT.board_url = url


async def start_scheduler() -> None:
    """Stage 3."""


async def stop_scheduler() -> None:
    """Stage 3."""


async def create_run(*args, **kwargs):
    raise RunError("AI runs are not available yet (AI v2, stage 3).")


async def before_ticket_change(*args, **kwargs) -> None:
    """A person changes a ticket an AI may be working on. Stage 3: tell the lead."""


async def note_person_edit(*args, **kwargs) -> None:
    """Stage 3."""


async def wake_new_assignee(*args, **kwargs) -> None:
    """Stage 3: a ticket assigned to a team opens its run."""


async def _append(*args, **kwargs) -> None:
    """Stage 3: steps are rows."""


async def record_question(*args, **kwargs):
    raise RunError("Stage 3.")


async def record_report(*args, **kwargs):
    raise RunError("Stage 3.")
