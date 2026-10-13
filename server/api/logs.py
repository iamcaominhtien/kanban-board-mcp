import logging
import platform
import sys
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import app_logging
import database as db
from version import version_info

router = APIRouter(prefix="/logs", tags=["logs"])
client_logger = logging.getLogger("ui")

# The server accepts requests from any origin, so cap what a client can write.
_CLIENT_LOGS_PER_MINUTE = 60
_client_log_times: list[float] = []


class ClientLogEntry(BaseModel):
    """An error or warning reported by the web UI."""

    level: str = Field("error", pattern="^(warning|error)$")
    message: str = Field(max_length=2000)
    stack: str | None = Field(None, max_length=8000)
    url: str | None = Field(None, max_length=500)


@router.post("/client", status_code=204)
async def log_client_event(entry: ClientLogEntry) -> None:
    """Record an error from the web UI in the application log.

    Args:
        entry: The reported message, optional stack and page URL.

    Raises:
        HTTPException: 429 when more than 60 entries arrive within a minute.
    """
    now = time.monotonic()
    while _client_log_times and now - _client_log_times[0] > 60:
        _client_log_times.pop(0)
    if len(_client_log_times) >= _CLIENT_LOGS_PER_MINUTE:
        raise HTTPException(status_code=429, detail="Too many client log entries")
    _client_log_times.append(now)
    client_logger.log(
        logging.ERROR if entry.level == "error" else logging.WARNING,
        "%s%s%s",
        entry.message,
        f" (at {entry.url})" if entry.url else "",
        f"\n{entry.stack}" if entry.stack else "",
    )


def _parse_time(name: str, value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"Invalid '{name}': expected an ISO-8601 date-time"
        )


@router.get("/export")
async def export_logs(
    since: str | None = Query(None, description="Start of range, ISO-8601"),
    until: str | None = Query(None, description="End of range, ISO-8601"),
    level: str = Query("INFO", description="Lowest level to include"),
):
    """Download the application log as a text file, optionally limited to a time range.

    Args:
        since: Inclusive start of the range. A value without a UTC offset is local server time.
        until: Inclusive end of the range.
        level: Lowest level to include (DEBUG, INFO, WARNING, ERROR, CRITICAL).

    Raises:
        HTTPException: 400 for an unparsable time, an inverted range or an unknown level.
    """
    start = _parse_time("since", since)
    end = _parse_time("until", until)
    if start and end and app_logging.aware(start) > app_logging.aware(end):
        raise HTTPException(status_code=400, detail="'since' must not be after 'until'")
    level = level.upper()
    if level not in app_logging.LEVELS:
        raise HTTPException(status_code=400, detail=f"Unknown level: {level}")

    header = [
        "# Kanban Board MCP log export",
        f"# Exported: {datetime.now().astimezone().isoformat(timespec='seconds')}",
        f"# Range: {since or 'beginning'} -> {until or 'now'}  (level >= {level})",
        f"# Version: {version_info().get('version', '?')}",
        f"# Platform: {platform.platform()}  Python {sys.version.split()[0]}",
        f"# Database: {db.get_db_path()}",
        f"# Log file: {app_logging.get_log_path()}",
        "",
    ]

    def generate():
        yield "\n".join(header) + "\n"
        found = False
        for record in app_logging.iter_records(start, end, level):
            found = True
            yield record
        if not found:
            yield "# (no log entries in this range)\n"

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        generate(),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=kanban-log-{stamp}.log"},
    )
