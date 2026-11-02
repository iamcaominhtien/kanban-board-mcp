"""AI Team, Flow: how work passes between the AIs (design/screens/ai-team.md, C to F). The same hand-off events feed
Health's Quality measure, so the two tabs agree on what "sent back" means.

A hand-off is a run that came from someone else: the sender is the last member of its chain, or the person who started
it. Its kind is the trigger the app recorded (assigned, mention, hand-off, report back). A *return* is work going back
to an AI that already held the ticket when the sender is a Reviewer (by template) or a person asked for changes; the
first return of a ticket is round 1 and normal, a later one is *sent back*.
"""

from collections import defaultdict
from datetime import datetime

from models import AiRun, AiTicketStep, Member

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
# runs the board starts as a workflow moves on (the next step, the PM, the coordinator's ruling, an odd job's review):
# their sender is the AI that held the ticket before, not the person who attached the workflow
WORKFLOW_TRIGGERS = ("workflow", "manager", "arbitration", "review")
# the coordinator's runs: the step after one takes the ticket from the PM, not from the step before
_COORDINATOR = ("manager", "arbitration")
CHECKS = "checks"
_SENT_BACK = "Sent back by "


def is_board(who: str | None) -> bool:
    """The board itself started it ("the board (intake)", "the board (red CI)"): no person handed it on."""
    return bool(who) and str(who).startswith("the board")


def _sent_back_by(row) -> str | None:
    """Who sent this step back, from the note the send-back left on it (workflow.send_back), or None."""
    note = (row.note_in or "") if row is not None else ""
    if not note.startswith(_SENT_BACK):
        return None
    return note[len(_SENT_BACK) :].split(":", 1)[0].strip()


def _handed_by(row, rows: list) -> tuple[object | None, list[str]]:
    """The last AI step done before `row` (the one that handed the ticket on) and the steps skipped since."""
    skipped: list[str] = []
    for x in reversed([x for x in rows if x.seq < row.seq and x.state != "superseded"]):
        if x.state == "skipped":
            skipped.append(x.label)
        elif x.state == "done" and x.kind == "ai":
            return x, list(reversed(skipped))
    return None, list(reversed(skipped))


def _secs(a: str | None, b: str | None) -> int | None:
    x, y = parse_iso(a), parse_iso(b)
    return int((y - x).total_seconds()) if x and y else None


def events(
    runs: list[AiRun],
    ais: dict[str, Member],
    templates: dict[str, str],
    *,
    since: datetime | None = None,
    steps: list[AiTicketStep] | None = None,
) -> list[dict]:
    """Every hand-off between AIs and from people, oldest first, each marked returned / sent back where it is one.

    `runs` must hold the ticket's earlier runs too (the rounds are counted from the first), `since` only limits which
    events are returned. `steps` are the workflow step rows of those tickets (every state), so a workflow's hand-offs
    come from the step before, not from whoever attached the workflow.
    """
    by_ticket: dict[str, list[AiRun]] = defaultdict(list)
    for r in sorted(runs, key=lambda r: r.queued_at or ""):
        by_ticket[r.ticket_id].append(r)
    step_of: dict[str, AiTicketStep] = {}
    steps_by_ticket: dict[str, list[AiTicketStep]] = defaultdict(list)
    for s in sorted(steps or [], key=lambda s: s.seq):
        steps_by_ticket[s.ticket_id].append(s)
        if s.run_id:
            step_of[s.run_id] = s
    out: list[dict] = []
    for ticket_id, rows in by_ticket.items():
        held: set[str] = set()
        returns = 0
        checks_back = 0
        pairs: dict[tuple[str, str], int] = defaultdict(int)
        last_ai: str | None = None  # who held the ticket before this run
        prev_run: AiRun | None = None
        for r in rows:
            if r.trigger == "autopilot":
                continue  # the delegate answering for the owner is not work passed between AIs
            chain = loads(r.chain, [])
            sender: str | None = chain[-1] if chain else r.started_by
            via: str | None = None
            back = False  # a workflow step sent back
            skipped: list[str] | None = (
                None  # the steps a workflow hand-off skipped (None: not a workflow step)
            )
            board_run = r.trigger in WORKFLOW_TRIGGERS
            row = step_of.get(r.id) if board_run else None
            if board_run:
                by = _sent_back_by(row) if r.trigger == "workflow" else None
                prev_row = step_of.get(prev_run.id) if prev_run is not None else None
                if (
                    by is not None
                    and last_ai
                    and (
                        (prev_row is not None and prev_row.outcome == "changes")
                        or by == "Reviewer"
                    )
                ):
                    sender, back = last_ai, True  # the Reviewer asked for changes
                elif by is not None and (by == "Checks" or is_board(by)):
                    # the Checks (or the test-first gate) failed the work: it comes back to the AI that did it
                    sender, via, back = r.member_id, CHECKS, True
                elif by is not None:
                    sender, back = by, True  # a person sent it back
                elif last_ai == r.member_id:
                    sender = (
                        r.member_id
                    )  # the same AI again (the board's retry): no hand-off
                elif prev_run is not None and prev_run.trigger in _COORDINATOR:
                    sender = last_ai  # the PM looked at it and passed it on
                else:
                    hand, gone = (
                        _handed_by(row, steps_by_ticket[ticket_id])
                        if row is not None
                        else (None, [])
                    )
                    if row is not None:
                        skipped = gone
                    if hand is not None and hand.member_id:
                        sender = hand.member_id
                    elif last_ai:
                        sender = last_ai
                    elif is_board(sender):
                        sender = None  # the board started it with nobody before: not a hand-off from a person
            elif not chain and is_board(sender):
                sender = None
            last_ai = r.member_id
            prev_run = r
            came_from_other = sender is not None and (
                sender != r.member_id or via == CHECKS
            )
            kind = KIND_OF.get(r.trigger, r.trigger)
            if board_run:
                kind = "hand-off" if sender in ais else "assigned"
            ev = None
            if came_from_other and r.trigger != "answer":
                if back:
                    returned = via != CHECKS
                else:
                    # a workflow step with its row is a send-back only when its row says so; without a row (an odd
                    # job's review, older runs) the review-round rule decides, as for any other run
                    returned = row is None and (
                        r.member_id in held
                        and kind != "report back"
                        and (
                            r.trigger == "request_changes"
                            or templates.get(sender) == "reviewer"
                        )
                    )
                round_ = 0
                if via == CHECKS:
                    # a failed check is a fact, not a review round: always sent back, counted on its own
                    checks_back += 1
                    round_ = checks_back
                    pairs[(CHECKS, r.member_id)] += 1
                elif returned:
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
                    "sent_back": via == CHECKS or (returned and round_ >= 2),
                    "wait_s": _secs(r.queued_at, r.started_at),
                    "pair_count": pairs[(CHECKS, r.member_id)]
                    if via == CHECKS
                    else pairs[(sender, r.member_id)]
                    if returned
                    else 0,
                    "via": via,
                    "skipped": skipped,
                    "workflow": board_run,
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
        if e["sent_back"] and e.get("via") != CHECKS:
            count[e["ticket_id"]] += 1
    return {t: n for t, n in count.items() if n >= PING_PONG_AT}
