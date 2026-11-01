"""AI Team, Flow: how work passes between the AIs (design/screens/ai-team.md, C to F). The same hand-off events feed
Health's Quality measure, so the two tabs agree on what "sent back" means.

A hand-off is a run that came from someone else: the sender is the last member of its chain, or the person who started
it. Its kind is the trigger the app recorded (assigned, mention, hand-off, report back). A *return* is work going back
to an AI that already held the ticket when the sender is a Reviewer (by template) or a person asked for changes; the
first return of a ticket is round 1 and normal, a later one is *sent back*.
"""

from collections import defaultdict
from datetime import datetime

from models import AiRun, Member

from .store import loads, parse_iso

KIND_OF = {
    "assign": "assigned",
    "run_button": "assigned",
    "retry": "assigned",
    "schedule": "assigned",
    "mention": "mention",
    "reply": "mention",
    "ask": "mention",
    "handoff": "hand-off",
    "report_back": "report back",
    "request_changes": "assigned",
    "answer": "answered",
}
PING_PONG_AT = 3


def _secs(a: str | None, b: str | None) -> int | None:
    x, y = parse_iso(a), parse_iso(b)
    return int((y - x).total_seconds()) if x and y else None


def events(
    runs: list[AiRun],
    ais: dict[str, Member],
    templates: dict[str, str],
    *,
    since: datetime | None = None,
) -> list[dict]:
    """Every hand-off between AIs and from people, oldest first, each marked returned / sent back where it is one.

    `runs` must hold the ticket's earlier runs too (the rounds are counted from the first), `since` only limits which
    events are returned.
    """
    by_ticket: dict[str, list[AiRun]] = defaultdict(list)
    for r in sorted(runs, key=lambda r: r.queued_at or ""):
        by_ticket[r.ticket_id].append(r)
    out: list[dict] = []
    for ticket_id, rows in by_ticket.items():
        held: set[str] = set()
        returns = 0
        pairs: dict[tuple[str, str], int] = defaultdict(int)
        for r in rows:
            if r.trigger == "autopilot":
                continue  # the delegate answering for the owner is not work passed between AIs
            chain = loads(r.chain, [])
            sender = chain[-1] if chain else r.started_by
            came_from_other = sender != r.member_id
            kind = KIND_OF.get(r.trigger, r.trigger)
            ev = None
            if came_from_other and r.trigger != "answer":
                returned = (
                    r.member_id in held
                    and kind != "report back"
                    and (
                        r.trigger == "request_changes"
                        or templates.get(sender) == "reviewer"
                    )
                )
                round_ = 0
                if returned:
                    returns += 1
                    round_ = returns
                    pairs[(sender, r.member_id)] += 1
                ev = {
                    "run_id": r.id,
                    "at": r.queued_at,
                    "ticket_id": ticket_id,
                    "from": sender,
                    "from_ai": sender in ais,
                    "to": r.member_id,
                    "kind": kind,
                    "trigger": r.trigger,
                    "round": round_,
                    "returned": returned and round_ == 1,
                    "sent_back": returned and round_ >= 2,
                    "wait_s": _secs(r.queued_at, r.started_at),
                    "pair_count": pairs[(sender, r.member_id)] if returned else 0,
                }
                out.append(ev)
            held.add(r.member_id)
    out.sort(key=lambda e: e["at"] or "")
    if since is not None:
        out = [e for e in out if (parse_iso(e["at"]) or since) >= since]
    return out


def ping_pong(evs: list[dict]) -> dict[str, int]:
    """Tickets where the same two AIs sent work back and forth PING_PONG_AT or more times after the first round."""
    count: dict[str, int] = defaultdict(int)
    for e in evs:
        if e["sent_back"]:
            count[e["ticket_id"]] += 1
    return {t: n for t, n in count.items() if n >= PING_PONG_AT}
