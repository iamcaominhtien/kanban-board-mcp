import asyncio

# ---------------------------------------------------------------------------
# Event type constants
# ---------------------------------------------------------------------------

INVALIDATE = "invalidate"
IDEA_TICKET_CREATED = "idea_ticket_created"
IDEA_TICKET_UPDATED = "idea_ticket_updated"
IDEA_TICKET_PROMOTED = "idea_ticket_promoted"
IDEA_TICKET_DROPPED = "idea_ticket_dropped"

# Global set of subscriber queues
_subscribers: set[asyncio.Queue] = set()


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


async def publish(event: str) -> None:
    """Broadcast an event string to all active SSE subscribers."""
    dead = set()
    for q in _subscribers:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            dead.add(q)
    for q in dead:
        _subscribers.discard(q)
