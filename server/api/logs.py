import platform
import sys
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

import app_logging
import database as db
from version import version_info

router = APIRouter(prefix="/logs", tags=["logs"])


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
