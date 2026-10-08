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
    """Run the operation that `action` names in a tool's table."""
    return await route(f"{tool}(action='{action}')", table[action], given)


def params_of(values: dict[str, Any]) -> dict[str, Any]:
    """The tool's own arguments (its `locals()` on entry) without the `action` / `item` selectors."""
    values = dict(values)
    for key in ("action", "item"):
        values.pop(key, None)
    return values
