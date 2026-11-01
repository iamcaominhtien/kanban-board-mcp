"""Standing orders: a rule in your words, tried before it does anything (design/screens/ai-board-wave3.md, G and H;
D25 level 2).

1. A person writes a sentence ("if an AI hangs for more than half an hour, diagnose it and fix it if you can").
2. It becomes a rule they can read and change: when (a signal from services/ai/signals.py), only if (conditions),
   then (let the AI analyse, then decide; or always one fixed action), afterwards (write the lesson), at most (per
   day, per target).
3. It runs in **trial** first: it only writes down what it would have done. It can go live only after its trial fired
   at least once, or ran a day with nothing to fire on.
4. On: every firing is recorded with what it changed and one Undo.

What a rule may do: only the middle tier of the Board AI's tiers (services/ai/assist/tiers.py) — the server refuses
anything else. It never does what the PM is doing on the same ticket, two rules cannot set each other off (a target
a rule acted on is left alone for a while), and Pause all AI stops every rule too.
"""

import asyncio
import json
import logging
import re
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select

import database
from models import AiOrderFiring, AiRun, AiStandingOrder

from . import signals
from .store import get_settings, loads

logger = logging.getLogger(__name__)

TICK_S = 30
# a rule holds at most this many runs at once: more is a bulk action, ask-first under D23
HOLD_MAX = 3
TRIAL_MIN = timedelta(days=1)
COOLDOWN = timedelta(
    minutes=10
)  # a target a rule acted on is left alone this long (no rule sets another off)

# What a rule may do, per signal: the middle tier only (each one either undoable or a stop that is not an erase)
ACTIONS: dict[str, dict] = {
    "diagnose": {"label": "Let the AI analyse, then decide", "signals": ["ai_hang"]},
    "stop_child": {"label": "Stop the stuck child process", "signals": ["ai_hang"]},
    "continue_note": {"label": "Stop and continue with a note", "signals": ["ai_hang"]},
    "wait": {"label": "Wait longer", "signals": ["ai_hang"]},
    "needs_you": {
        "label": "Hand it to Needs you",
        "signals": ["ai_hang", "ai_failing", "arbitration_wait"],
    },
    "retry_higher": {
        "label": "Try once more at a higher effort",
        "signals": ["run_failed_network", "ai_failing"],
    },
    "back_to_dev": {
        "label": "Give it back to the Dev who wrote it",
        "signals": ["ci_red"],
    },
    "remind": {
        "label": "Remind (a comment on the ticket)",
        "signals": ["review_stale", "needs_queue"],
    },
    "hold_low": {
        "label": "Hold the work that is not urgent",
        "signals": ["quota_near"],
    },
    "run_arbitration": {
        "label": "Run the arbitration now",
        "signals": ["arbitration_wait"],
    },
}

TEMPLATES: list[dict] = [
    {
        "key": "hang",
        "name": "Hung AI → diagnose and act",
        "sentence": "If an AI produces no output for 30 minutes, diagnose it and fix it if you can.",
        "rule": {
            "when": "ai_hang",
            "if": {"min_minutes": 30, "confident": True},
            "then": {"mode": "diagnose"},
            "afterwards": {"lesson": True},
            "max_per_day": 3,
            "max_per_target": 1,
        },
    },
    {
        "key": "network",
        "name": "Network failure → one more try",
        "sentence": "If a run fails on the network or a 5xx, try once more at a higher effort.",
        "rule": {
            "when": "run_failed_network",
            "if": {},
            "then": {"mode": "fixed", "action": "retry_higher"},
            "afterwards": {"lesson": False},
            "max_per_day": 5,
            "max_per_target": 1,
        },
    },
    {
        "key": "ci_red",
        "name": "Red CI → back to its Dev",
        "sentence": "If CI goes red on a pull request the board opened, give it back to the Dev who wrote it.",
        "rule": {
            "when": "ci_red",
            "if": {},
            "then": {"mode": "fixed", "action": "back_to_dev"},
            "afterwards": {"lesson": False},
            "max_per_day": 5,
            "max_per_target": 2,
        },
    },
    {
        "key": "review_stale",
        "name": "In Review 24 h → remind me",
        "sentence": "If a ticket has sat in Review for 24 hours, remind me once.",
        "rule": {
            "when": "review_stale",
            "if": {},
            "then": {"mode": "fixed", "action": "remind"},
            "afterwards": {"lesson": False},
            "max_per_day": 5,
            "max_per_target": 1,
        },
    },
    {
        "key": "quota",
        "name": "Window nearly used → hold low-priority work",
        "sentence": "If an account is near its window, hold the work that is not urgent.",
        "rule": {
            "when": "quota_near",
            "if": {},
            "then": {"mode": "fixed", "action": "hold_low"},
            "afterwards": {"lesson": False},
            "max_per_day": 2,
            "max_per_target": 1,
        },
    },
]


class OrderError(ValueError):
    """The rule is not allowed or not understood."""


def _now() -> datetime:
    return datetime.now(UTC)


def _check_conditions(cond) -> dict:
    """The "only if" part, each value of its own type (a bad one would fail the rule on every tick)."""
    if not isinstance(cond, dict):
        raise OrderError("“Only if” is a set of conditions.")
    out: dict = {}
    if cond.get("min_minutes") not in (None, ""):
        mins = cond["min_minutes"]
        if isinstance(mins, bool) or not isinstance(mins, (int, float, str)):
            raise OrderError("The minutes are a whole number.")
        try:
            out["min_minutes"] = max(0, min(int(str(mins).strip()), 7 * 24 * 60))
        except ValueError as exc:
            raise OrderError("The minutes are a whole number.") from exc
    if "confident" in cond:
        if not isinstance(cond["confident"], bool):
            raise OrderError("“Only when the cause is clear” is yes or no.")
        out["confident"] = cond["confident"]
    for k in ("member_id", "label"):
        if cond.get(k) not in (None, ""):
            if not isinstance(cond[k], str):
                raise OrderError(f"{k} is a text.")
            out[k] = cond[k][:200]
    return out


def check_rule(rule: dict) -> dict:
    """A rule as the server accepts it: a known signal, an action of the middle tier that fits it, sane limits.

    Raises:
        OrderError: Anything else (this is what stops a rule reaching an ask-first action).
    """
    when = rule.get("when")
    if when not in signals.RULE_KINDS:
        raise OrderError(f"Unknown signal: {when!r}.")
    then = rule.get("then") or {}
    mode = then.get("mode")
    if mode == "diagnose":
        if when != "ai_hang":
            raise OrderError(
                "Only a hang has a diagnosis to act on; choose a fixed action."
            )
        action = "diagnose"
    elif mode == "fixed":
        action = then.get("action")
        if action not in ACTIONS:
            raise OrderError(
                f"A rule may only do what can be undone; {action!r} is not one of those."
            )
        if when not in ACTIONS[action]["signals"]:
            raise OrderError(
                f"{ACTIONS[action]['label']} does not fit the signal {when}."
            )
    else:
        raise OrderError(
            "Then is either “let the AI analyse, then decide” or one fixed action."
        )
    try:
        per_day = max(1, min(int(rule.get("max_per_day") or 3), 50))
        per_target = max(1, min(int(rule.get("max_per_target") or 1), 10))
    except (TypeError, ValueError) as exc:
        raise OrderError("The limits are whole numbers.") from exc
    return {
        "when": when,
        "if": _check_conditions(rule.get("if") or {}),
        "then": {"mode": mode, **({"action": action} if mode == "fixed" else {})},
        "afterwards": {"lesson": bool((rule.get("afterwards") or {}).get("lesson"))},
        "max_per_day": per_day,
        "max_per_target": per_target,
        "only_project": rule.get("only_project", True),
    }


_HANG = re.compile(
    r"\b(hangs?|hung|stuck|no output|produces nothing|silent|treo)\b", re.I
)
_NETWORK = re.compile(r"\b(network|5xx|529|overload|connection|mạng)\b", re.I)
_CI = re.compile(r"\b(ci|pipeline|checks? (fail|red)|red build)\b", re.I)
_REVIEW = re.compile(
    r"\b(review)\b.*\b(\d+)\s*(h|hours|giờ|days?)\b|\bin review\b", re.I
)
_QUOTA = re.compile(r"\b(quota|window|usage|limit)\b", re.I)
_MINUTES = re.compile(r"(\d+)\s*(minutes?|mins?|phút)|half an hour|nửa tiếng", re.I)


def parse_sentence(sentence: str) -> dict:
    """The rule a sentence most likely means, read by code (the Board AI chat can refine it; a person changes any part
    before it is saved). Raises OrderError when no ready-made signal fits."""
    text = sentence or ""
    if _HANG.search(text):
        base = copy_rule("hang")
        m = _MINUTES.search(text)
        if m:
            base["if"]["min_minutes"] = int(m.group(1)) if m.group(1) else 30
        if re.search(r"\b(always|just|only)\b.*\b(stop|kill)\b", text, re.I):
            base["then"] = {"mode": "fixed", "action": "stop_child"}
        return check_rule(base)
    if _NETWORK.search(text):
        return check_rule(copy_rule("network"))
    if _CI.search(text):
        return check_rule(copy_rule("ci_red"))
    if _REVIEW.search(text):
        return check_rule(copy_rule("review_stale"))
    if _QUOTA.search(text):
        return check_rule(copy_rule("quota"))
    raise OrderError(
        "I could not tell which signal this is about. Pick one in the editor."
    )


def copy_rule(key: str) -> dict:
    """A ready-made rule's body."""
    found = next(t for t in TEMPLATES if t["key"] == key)
    return json.loads(json.dumps(found["rule"]))


def to_dict(row: AiStandingOrder) -> dict:
    """A standing order for the API."""
    trial_until = row.trial_started_at
    can_go_live = row.state == "trial" and (
        bool(row.trial_fired_at)
        or (
            row.trial_started_at
            and _now() - datetime.fromisoformat(row.trial_started_at) >= TRIAL_MIN
        )
    )
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "sentence": row.sentence,
        "rule": loads(row.rule, {}),
        "state": row.state,
        "trial_days": row.trial_days,
        "trial_started_at": trial_until,
        "trial_fired_at": row.trial_fired_at,
        "can_go_live": bool(can_go_live),
        "fired": row.fired,
        "would_have": row.would_have,
        "last_fired_at": row.last_fired_at,
        "last_summary": row.last_summary,
        "template": row.template,
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


async def create(
    session,
    project_id: str,
    *,
    name: str,
    sentence: str,
    rule: dict,
    by: str,
    template: str | None = None,
) -> AiStandingOrder:
    """Save a rule (it starts off: Start the trial is the next step)."""
    row = AiStandingOrder(
        project_id=project_id,
        name=(name or sentence or "Rule")[:120],
        sentence=sentence or "",
        rule=json.dumps(check_rule(rule)),
        created_by=by,
        template=template,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def change_rule(session, row: AiStandingOrder, rule: dict) -> AiStandingOrder:
    """Edit a rule. A changed rule was never tried: one that was on or in trial starts its trial again, so it cannot
    act live until the new rule has run in trial (G)."""
    new = check_rule(rule)
    if new == loads(row.rule, {}):
        return row
    row.rule = json.dumps(new)
    if row.state in ("on", "trial"):
        row.state = "trial"
        row.trial_started_at = _now().isoformat()
        row.trial_fired_at = None
        row.would_have = 0
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def set_state(
    session, row: AiStandingOrder, state: str, *, trial_days: int | None = None
) -> AiStandingOrder:
    """off → trial → on (and back to off). On is refused until the trial has run."""
    if state not in ("off", "trial", "on"):
        raise OrderError("A rule is off, in trial or on.")
    if state == "trial":
        row.trial_started_at = _now().isoformat()
        row.trial_fired_at = None
        row.would_have = 0
        if trial_days:
            row.trial_days = max(1, min(int(trial_days), 30))
    if state == "on" and not to_dict(row)["can_go_live"]:
        raise OrderError(
            "Turn it on is off until the trial has run: it must fire at least once, or run a day with nothing to fire on."
        )
    row.state = state
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------


async def _recent_targets(session, project_id: str) -> set[str]:
    since = (_now() - COOLDOWN).isoformat()
    rows = (
        await session.exec(
            select(AiOrderFiring).where(
                AiOrderFiring.project_id == project_id, col(AiOrderFiring.at) >= since
            )
        )
    ).all()
    return {r.target for r in rows if r.target and not r.would}


async def _count(
    session,
    order_id: str,
    *,
    would: bool,
    target: str | None = None,
    since: datetime,
) -> int:
    """Firings of the rule's current mode: what a trial would have done never uses up the limits of the real rule."""
    stmt = select(AiOrderFiring).where(
        AiOrderFiring.order_id == order_id,
        AiOrderFiring.would == would,
        col(AiOrderFiring.at) >= since.isoformat(),
    )
    if target:
        stmt = stmt.where(AiOrderFiring.target == target)
    return len((await session.exec(stmt)).all())


def _matches(rule: dict, finding: dict) -> bool:
    if finding["kind"] != rule["when"]:
        return False
    cond = rule.get("if") or {}
    if cond.get("min_minutes"):
        try:
            if int((finding.get("data") or {}).get("minutes") or 0) < int(
                cond["min_minutes"]
            ):
                return False
        except (TypeError, ValueError):
            return False  # a rule saved before its conditions were checked: it matches nothing
    if cond.get("confident") and (finding.get("data") or {}).get("cause") in (
        None,
        "unknown",
    ):
        return False
    if cond.get("member_id") and finding.get("member_id") != cond["member_id"]:
        return False
    return True


def _target(finding: dict) -> str:
    return (
        finding.get("run_id")
        or finding.get("ticket_id")
        or finding.get("account_key")
        or finding["key"]
    )


async def _pm_is_on_it(session, finding: dict) -> bool:
    """A rule never does what the PM (coordinator) is doing on the same ticket."""
    if not finding.get("ticket_id"):
        return False
    from . import plugins

    for run in (
        await session.exec(
            select(AiRun).where(
                AiRun.ticket_id == finding["ticket_id"],
                col(AiRun.state).in_(["queued", "starting", "running"]),
            )
        )
    ).all():
        from models import AiMember

        prof = await session.get(AiMember, run.member_id)
        if prof is not None and plugins.role_of(prof) == "pm":
            return True
    return False


# project id -> [its lock, how many ticks hold or wait for it]: the loop and POST …/orders/tick never tick one project
# at once, so the limits are counted once
_TICK_LOCKS: dict[str, list] = {}


async def tick(project_id: str) -> list[AiOrderFiring]:
    """Look at the project's signals once and fire the rules that match (trial ones only write it down). One tick
    per project at a time."""
    entry = _TICK_LOCKS.setdefault(project_id, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            return await _tick(project_id)
    finally:
        entry[1] -= 1
        if entry[1] == 0 and _TICK_LOCKS.get(project_id) is entry:
            _TICK_LOCKS.pop(project_id, None)


async def _tick(project_id: str) -> list[AiOrderFiring]:
    fired: list[AiOrderFiring] = []
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        if settings.paused_all:
            return []  # Pause all AI stops the rules too
        orders = (
            await session.exec(
                select(AiStandingOrder).where(
                    AiStandingOrder.project_id == project_id,
                    col(AiStandingOrder.state).in_(["trial", "on"]),
                )
            )
        ).all()
        if not orders:
            return []
        findings = await signals.for_rules(session, project_id)
        busy = await _recent_targets(session, project_id)
        day_ago = _now() - timedelta(days=1)
        for oid in [o.id for o in orders]:
            try:
                # read afresh: a rollback after another rule's failure expired what was loaded
                order = await session.get(AiStandingOrder, oid, populate_existing=True)
                if order is not None:
                    fired += await _tick_order(session, order, findings, busy, day_ago)
            except Exception:  # noqa: BLE001 - one bad rule never stops the others
                logger.exception("The standing order %s failed this tick", oid)
                await session.rollback()
    return fired


async def _tick_order(
    session,
    order: AiStandingOrder,
    findings: list[dict],
    busy: set[str],
    day_ago: datetime,
) -> list[AiOrderFiring]:
    fired: list[AiOrderFiring] = []
    rule = loads(order.rule, {})
    if order.state == "trial" and order.trial_started_at:
        if _now() - datetime.fromisoformat(order.trial_started_at) > timedelta(
            days=order.trial_days or 3
        ):
            return []  # the trial is over: it waits for a person to read it and turn it on
    for f in findings:
        if not _matches(rule, f):
            continue
        target = _target(f)
        if order.state == "on" and target in busy:
            continue
        would = order.state == "trial"
        if await _count(session, order.id, would=would, since=day_ago) >= rule.get(
            "max_per_day", 3
        ):
            break
        if await _count(
            session, order.id, would=would, target=target, since=day_ago
        ) >= rule.get("max_per_target", 1):
            continue
        if await _pm_is_on_it(session, f):
            continue
        firing = await _fire(session, order, rule, f, would=order.state == "trial")
        session.expunge(
            firing
        )  # kept as it was saved, whatever a later rule's rollback does
        fired.append(firing)
        busy.add(target)
    return fired


async def _fire(
    session, order: AiStandingOrder, rule: dict, finding: dict, *, would: bool
) -> AiOrderFiring:
    action = (
        rule["then"].get("action") if rule["then"]["mode"] == "fixed" else "diagnose"
    )
    plan = await _plan(finding, action)
    firing = AiOrderFiring(
        order_id=order.id,
        project_id=order.project_id,
        target=_target(finding),
        ticket_id=finding.get("ticket_id"),
        trigger=json.dumps(
            {
                "kind": finding["kind"],
                "title": finding.get("title"),
                "detail": finding.get("detail"),
                "data": finding.get("data"),
            }
        ),
        action=json.dumps(plan),
        would=would,
    )
    if not would:
        try:
            firing.result, firing.undo = await _apply(
                plan,
                finding,
                by=f"the rule “{order.name}”",
                project_id=order.project_id,
            )
        except Exception as exc:  # noqa: BLE001 - a rule that fails says so on its own history
            firing.result = f"Could not do it: {exc}"[:400]
        if rule.get("afterwards", {}).get("lesson") and finding.get("run_id"):
            diag = await _diagnosis(finding["run_id"])
            if diag.get("lesson"):
                from . import knowledge

                await knowledge.propose_from_diagnosis(
                    finding["run_id"], diag["lesson"]
                )
    session.add(firing)
    order.last_fired_at = _now().isoformat()
    order.last_summary = (
        f"would have: {plan['label']}" if would else (firing.result or plan["label"])
    )[:200]
    if would:
        order.would_have = (order.would_have or 0) + 1
        order.trial_fired_at = order.trial_fired_at or _now().isoformat()
    else:
        order.fired = (order.fired or 0) + 1
    session.add(order)
    await session.commit()
    await session.refresh(firing)
    return firing


async def _diagnosis(run_id: str) -> dict:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        return loads(run.diagnosis, {}) if run else {}


async def _plan(finding: dict, action: str) -> dict:
    """What the firing does: for a diagnosis, the first action the diagnosis allows."""
    if action == "diagnose":
        diag = await _diagnosis(finding.get("run_id") or "")
        allowed = [
            a
            for a in diag.get("actions") or []
            if a in ("stop_child", "continue_note", "wait")
        ]
        if diag.get("cause") in (None, "unknown") or not allowed:
            return {
                "action": "needs_you",
                "label": "Hand it to Needs you (the cause is not clear)",
            }
        return {
            "action": allowed[0],
            "label": ACTIONS[allowed[0]]["label"],
            "cause": diag.get("cause"),
        }
    return {"action": action, "label": ACTIONS[action]["label"]}


async def _apply(
    plan: dict, finding: dict, *, by: str, project_id: str
) -> tuple[str, str | None]:
    """Do the planned action. Returns (what happened, the undo record as JSON or None)."""
    from services import tickets as svc_tickets

    from . import runs

    action = plan["action"]
    if action in ("stop_child", "continue_note", "wait"):
        out = await runs.act_on_trouble(finding["run_id"], action, by=by)
        return out[
            "text"
        ], None  # a started run is stopped, not erased: nothing to put back
    if action == "needs_you":
        return "Left for a person in Needs you.", None
    if action == "retry_higher":
        old_id = (
            finding.get("run_id")
            or ((finding.get("data") or {}).get("runs") or [None])[0]
        )
        async with database.async_session() as session:
            old = await session.get(AiRun, old_id)
            new = await runs.create_run(
                session,
                ticket_id=old.ticket_id,
                member_id=old.member_id,
                mode=old.mode,
                trigger="retry",
                started_by=by,
                instruction=old.instruction,
                effort_override="high",
            )
        return f"Started run #{new.number} at a higher effort.", json.dumps(
            {"cancel_run": new.id}
        )
    if action == "remind":
        async with database.async_session() as session:
            t = await svc_tickets.add_comment(
                session,
                finding["ticket_id"],
                f"Reminder from {by}: {finding.get('title')}.",
                author="Board AI",
                meta={"standing_order": True},
            )
            cid = (loads(t.comments, [])[-1] or {}).get("id") if t else None
        return "Posted a reminder on the ticket.", json.dumps(
            {"delete_comment": [finding["ticket_id"], cid]}
        )
    if action == "hold_low":
        held = []
        key = finding.get("account_key")
        async with database.async_session() as session:
            from models import AiMember, Ticket

            from . import quota

            queued = (
                await session.exec(
                    select(AiRun)
                    .where(AiRun.project_id == project_id, AiRun.state == "queued")
                    .order_by(col(AiRun.queued_at).desc())
                )
            ).all()
            for run in queued:
                if len(held) >= HOLD_MAX:
                    break  # holding more is a bulk action: a person's to ask for (D23)
                if (
                    not key
                    or quota.key_for(await session.get(AiMember, run.member_id), run)
                    != key
                ):
                    continue  # only work that spends the account near its window
                t = await session.get(Ticket, run.ticket_id)
                if (
                    t is not None
                    and t.priority in ("low", "medium")
                    and not run.retry_at
                ):
                    run.retry_at = (
                        datetime.fromisoformat(
                            (finding.get("data") or {}).get("resets_at")
                        )
                        if (finding.get("data") or {}).get("resets_at")
                        else _now() + timedelta(hours=1)
                    ).isoformat()
                    session.add(run)
                    held.append(run.id)
            await session.commit()
        return (
            f"Held {len(held)} run{'s' if len(held) != 1 else ''} that are not urgent until the window reopens.",
            json.dumps({"release": held}),
        )
    if action == "back_to_dev":
        from . import github

        run_id = await github.back_to_dev(finding)
        return "Gave the failing check back to the Dev who wrote it.", json.dumps(
            {"cancel_run": run_id}
        ) if run_id else None
    if action == "run_arbitration":
        from . import workflow

        await workflow.start_arbitration(
            finding["ticket_id"], why=finding.get("detail") or "Waiting for arbitration"
        )
        return "Started the arbitration.", None
    raise OrderError(f"Unknown action {action}")


async def undo(session, firing: AiOrderFiring, *, by: str) -> str:
    """Put one firing back, as far as it can be; says what it could not take back."""
    from services import tickets as svc_tickets

    from . import runs

    if firing.undone_at:
        raise OrderError("Already undone.")
    if firing.would:
        raise OrderError("A trial firing changed nothing.")
    rec = loads(firing.undo, None)
    if not rec:
        raise OrderError(
            "This firing cannot be put back: a started run is stopped, not erased."
        )
    text = "Put back."
    if rec.get("cancel_run"):
        run = await session.get(AiRun, rec["cancel_run"])
        if run is not None and run.state in (
            "queued",
            "starting",
            "running",
            "needs_input",
        ):
            await runs.cancel(run.id, by=by, reason=f"Undone by {by}.")
            text = (
                "Put back."
                if run.state == "queued"
                else "Put back, but the run had already started."
            )
        else:
            text = "The run had already ended, so it is not taken back."
    if rec.get("delete_comment"):
        tid, cid = rec["delete_comment"]
        if cid:
            await svc_tickets.delete_comment(session, tid, cid)
    if rec.get("release"):
        for rid in rec["release"]:
            run = await session.get(AiRun, rid)
            if run is not None and run.state == "queued":
                run.retry_at = None
                session.add(run)
    firing.undone_at = _now().isoformat()
    firing.undone_by = by
    session.add(firing)
    await session.commit()
    runs.RT.wake.set()
    return text


def firing_dict(f: AiOrderFiring) -> dict:
    """A firing for the API."""
    return {
        "id": f.id,
        "order_id": f.order_id,
        "at": f.at,
        "target": f.target,
        "ticket_id": f.ticket_id,
        "trigger": loads(f.trigger, {}),
        "action": loads(f.action, {}),
        "would": f.would,
        "result": f.result,
        "can_undo": bool(f.undo) and not f.undone_at and not f.would,
        "undone_at": f.undone_at,
        "undone_by": f.undone_by,
    }


_LOOP: dict = {"task": None}


async def _loop() -> None:
    while True:
        try:
            async with database.async_session() as session:
                projects = {
                    o.project_id
                    for o in (
                        await session.exec(
                            select(AiStandingOrder).where(
                                col(AiStandingOrder.state).in_(["trial", "on"])
                            )
                        )
                    ).all()
                }
            for pid in projects:
                await tick(pid)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Standing orders tick failed")
        await asyncio.sleep(TICK_S)


def start() -> None:
    """Start the standing orders loop (once)."""
    if _LOOP["task"] is None or _LOOP["task"].done():
        _LOOP["task"] = asyncio.get_running_loop().create_task(_loop())


async def stop() -> None:
    """Stop the loop."""
    task = _LOOP["task"]
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        _LOOP["task"] = None
