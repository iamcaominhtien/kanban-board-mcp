"""Execution waves of a parent's sub-tickets (design/components/ticket-detail-parent.md, 1 and 7; comp-2 TDP-1).

A sub-ticket's wave is computed from its Blocked by links to its siblings: one with no sibling blocker is wave 1, any
other one wave after its latest sibling blocker. A person may pin a sub-ticket to a wave by hand (`Ticket.wave_pin`,
"Auto-set from Blocked by" unchecked); a pinned wave is used as it is, and the siblings it blocks count from it. With
no pin anywhere the waves are the computed ones, as before the pin existed. The UI computes the same thing
(`ui/src/components/SubTicketsSection.tsx`, `buildRows`).
"""

import json
from typing import Iterable

from models import Ticket

WAVE_PIN_RANGE = (1, 99)


def _blockers(ticket: Ticket) -> list[str]:
    try:
        raw = json.loads(ticket.blocked_by or "[]")
    except (TypeError, ValueError):
        return []
    return [str(x) for x in raw] if isinstance(raw, list) else []


def waves(children: Iterable[Ticket]) -> dict[str, int]:
    """The wave of each sub-ticket, by id: its pin when one is set, else 1 + the latest wave of its sibling blockers.
    Circular blockers stop the descent (that ticket counts as wave 1 on the loop), as the UI does."""
    kids = list(children)
    by_id = {t.id: t for t in kids}
    out: dict[str, int] = {}

    def wave_of(t: Ticket, trail: set[str]) -> int:
        if t.id in out:
            return out[t.id]
        if t.wave_pin is not None:
            out[t.id] = int(t.wave_pin)
            return out[t.id]
        if t.id in trail:
            return 1
        trail.add(t.id)
        w = 1
        for b in _blockers(t):
            other = by_id.get(b)
            if other is not None:
                w = max(w, wave_of(other, trail) + 1)
        trail.discard(t.id)
        out[t.id] = w
        return w

    for t in kids:
        wave_of(t, set())
    return out


def pinned_ready(ticket: Ticket, siblings: Iterable[Ticket], closed: set[str]) -> bool:
    """Whether a sub-ticket pinned to a wave may start: every open sibling of an earlier wave is closed. Its own
    Blocked by links do not hold it back then (that is what pinning it earlier is for)."""
    kids = list(siblings)
    w = waves(kids)
    mine = w.get(ticket.id, ticket.wave_pin or 1)
    return all(
        k.id in closed for k in kids if k.id != ticket.id and w.get(k.id, 1) < mine
    )


def clean_pin(value) -> int | None:
    """A pin from the API: None clears it (the wave is computed again); else a whole number in range."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("wave_pin must be a whole number or null")
    lo, hi = WAVE_PIN_RANGE
    if not lo <= value <= hi:
        raise ValueError(f"wave_pin must be between {lo} and {hi}, or null")
    return value
