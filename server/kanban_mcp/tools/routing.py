"""Routes a tool call to one operation, after checking that exactly the parameters it understands were passed."""

from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cache
from pydantic import ValidationError, validate_call
from typing import Any


@dataclass(frozen=True)
class Op:
    """One operation behind a tool: the function, the parameters it needs and may take, and renames
    (tool parameter -> function parameter) where a shared name is clearer for the agent."""

    impl: Callable
    required: tuple[str, ...] = ()
    optional: tuple[str, ...] = ()
    rename: dict[str, str] = field(default_factory=dict)

    def usage(self) -> str:
        """What the operation takes, for error messages."""
        need = ", ".join(self.required) or "nothing else"
        take = f"; optional: {', '.join(self.optional)}" if self.optional else ""
        return f"requires {need}{take}"


@cache
def _validated(impl: Callable) -> Callable:
    """The operation with its parameter constraints (enums, ranges, lengths) enforced, as FastMCP would do for it."""
    return validate_call(impl)


def _short(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
    )


async def route(label: str, op: Op, given: dict[str, Any]) -> Any:
    """Check the arguments against the operation, then run it with its own parameter names."""
    passed = {k: v for k, v in given.items() if v is not None}
    missing = [p for p in op.required if p not in passed]
    if missing:
        raise ValueError(f"{label} {op.usage()}. Missing: {', '.join(missing)}.")
    allowed = set(op.required) | set(op.optional)
    extra = [p for p in passed if p not in allowed]
    if extra:
        raise ValueError(f"{label} does not use: {', '.join(extra)}. It {op.usage()}.")
    kwargs = {op.rename.get(k, k): v for k, v in passed.items()}
    try:
        return await _validated(op.impl)(**kwargs)
    except ValidationError as exc:
        raise ValueError(f"{label}: {_short(exc)}") from exc


async def dispatch(
    tool: str, table: dict[str, Op], action: str, given: dict[str, Any]
) -> Any:
    """Run the operation that `action` names in a tool's table (checked by the AI guard when an AI run calls it)."""
    from services.ai import guard

    return await guard.guarded(
        tool,
        action,
        given,
        lambda g: route(f"{tool}(action='{action}')", table[action], g),
    )


def params_of(values: dict[str, Any]) -> dict[str, Any]:
    """The tool's own arguments (its `locals()` on entry) without the `action` / `item` selectors."""
    values = dict(values)
    for key in ("action", "item"):
        values.pop(key, None)
    return values


MAX_BATCH = 25
# A refusal that would repeat for every item (or a wait for a person): the rest of the batch is not tried
_STOPS = ("NEEDS_APPROVAL", "DENIED", "APPROVED_BUT_FAILED", "BLOCKED")


async def batch(
    call: Callable[[dict[str, Any]], Any], items: Any, *, keep_results: bool = True
) -> dict:
    """Run one call per item, in order, each as a call of its own (so each goes through the AI guard, permissions and
    audit as a single call would). An item that fails is reported and the others still run; the batch stops early only
    at a refusal that would repeat or at an item that waits for a person.

    `call` receives one item's own parameters. With `keep_results` False (the call returns a whole ticket) the result
    of the last item that worked is returned once, as `ticket`."""
    if not isinstance(items, list) or not items:
        raise ValueError("items: a non-empty list of objects, one per call.")
    if len(items) > MAX_BATCH:
        raise ValueError(
            f"items: at most {MAX_BATCH} per call; send the rest in another call."
        )
    results: list[dict] = []
    last = None
    stopped: str | None = None
    for i, extra in enumerate(items):
        if stopped:
            results.append({"index": i, "ok": False, "error": f"Not run: {stopped}"})
            continue
        if not isinstance(extra, dict):
            results.append(
                {
                    "index": i,
                    "ok": False,
                    "error": "Each item is an object of parameters.",
                }
            )
            continue
        try:
            out = await call(extra)
        except Exception as exc:  # noqa: BLE001 - reported per item
            message = str(exc)
            results.append({"index": i, "ok": False, "error": message})
            if message.startswith(_STOPS):
                stopped = "the batch stopped at the first item that needs a person or is refused."
        else:
            last = out
            row: dict[str, Any] = {"index": i, "ok": True}
            if keep_results:
                row["result"] = out
            results.append(row)
    done = sum(1 for r in results if r["ok"])
    out_: dict[str, Any] = {
        "done": done,
        "failed": len(results) - done,
        "results": results,
    }
    if not keep_results and last is not None:
        out_["ticket"] = last
    return out_
