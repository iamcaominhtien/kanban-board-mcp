"""What went wrong when a CLI run stopped, by kind (design/screens/ai-operations.md, C, table C5).

Today every stop looks the same and burns the same three tries. The kind decides what happens next:

| kind        | what                                   | next                                              | a try? |
|-------------|----------------------------------------|---------------------------------------------------|--------|
| window      | the plan's usage window is used up     | hold every run of the account until the reset     | no     |
| rate_limit  | a short provider limit (429)           | requeue after the wait (existing behaviour)       | yes, 3 |
| network     | the network dropped, a 5xx or a 529    | resume with backoff 30 s, 2 min, 10 min           | yes, 3 |
| crash       | the CLI exited with no result          | resume once, then diagnose from stderr            | yes, 1 |
| board_fault | a board call failed on the board's side| the same backoff, then Needs you, never the AI's  | yes, 3 |
| compact     | the conversation is too long           | a fresh conversation with a hand-over note        | yes, 1 |
| signed_out  | the account signed out                 | held until it signs in again, then resumes        | no     |
| error       | anything else                          | the run fails, with what the CLI said             | —      |
"""

import re

from . import cli

NETWORK_DELAYS_S = (30, 120, 600)
TRIES = {"network": 3, "board_fault": 3, "crash": 1, "compact": 1}

_NETWORK = re.compile(
    r"(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error"
    r"|connection (error|reset|refused|closed)|connect timeout|getaddrinfo|overloaded|\b529\b|\b50[0-4]\b"
    r"|internal server error|service unavailable|bad gateway|gateway timeout|api_error_status.?5\d\d)",
    re.IGNORECASE,
)
_COMPACT = re.compile(
    r"(prompt is too long|context (length|window) (exceeded|limit)|too many tokens|conversation (is )?too long"
    r"|compact(ion)? failed|failed to compact|exceeds the (model's )?context)",
    re.IGNORECASE,
)
_SIGNED_OUT = re.compile(
    r"(\blog ?in\b|not authenticated|invalid api key|authentication_error|oauth token (has )?expired|/login)",
    re.IGNORECASE,
)


def classify(
    result: dict | None,
    code: int | None,
    stderr: list[str],
    *,
    quota: dict | None = None,
    board_faults: int = 0,
) -> tuple[str, str]:
    """(kind, what the CLI said) for a run whose CLI ended without success."""
    said = ((result or {}).get("text") or "").strip()
    err = " ".join(stderr[-6:])
    both = f"{said}\n{err}"
    api = (result or {}).get("api_error") or ""
    status = (result or {}).get("api_status")
    if api == "usage_limit_reached" or (quota or {}).get("status") == "rejected":
        return "window", said or "The usage window is used up."
    if (
        api in ("authentication_failed", "authentication_error")
        or status == 401
        or (not said and _SIGNED_OUT.search(err))
        or re.search(r"not logged in|please run /login", said, re.IGNORECASE)
    ):
        return "signed_out", said or err
    if _COMPACT.search(both):
        return "compact", said or err
    if isinstance(status, int) and status >= 500:
        return "network", said or f"The API answered {status}."
    if api in ("overloaded_error", "api_error", "network_error", "timeout"):
        return "network", said or api
    if cli.rate_limit_wait(both) is not None:
        return "rate_limit", said or err
    if _NETWORK.search(both):
        return "network", said or err
    if board_faults and result is not None:
        return "board_fault", said or "A board tool failed on the board's side."
    if result is None and code not in (0, None):
        return "crash", err or f"Exit code {code}."
    return "error", said or err or f"Exit code {code}."


def stderr_reading(stderr: list[str]) -> str:
    """A one-line reading of a crash from what the CLI printed last."""
    lines = [s for s in stderr if s.strip()][-4:]
    if not lines:
        return "The CLI printed nothing before it exited."
    text = " ".join(lines)
    for pattern, reading in (
        (r"heap out of memory|JavaScript heap|ENOMEM", "The CLI ran out of memory."),
        (
            r"EACCES|permission denied",
            "The CLI could not open a file it needs (permission denied).",
        ),
        (r"ENOSPC|no space left", "The disk is full."),
        (r"Segmentation fault|SIGSEGV", "The CLI crashed (segmentation fault)."),
        (r"Killed|SIGKILL", "The CLI was killed by the system."),
        (
            r"Cannot find module|MODULE_NOT_FOUND",
            "The CLI's installation is broken (a module is missing).",
        ),
    ):
        if re.search(pattern, text, re.IGNORECASE):
            return reading
    return f"The CLI's last words: {text[:240]}"
