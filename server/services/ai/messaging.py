"""The one primitive of contact between AIs and people (AI v2, spec 4.3): a note to a ticket's team, or to a Docs
page's assistant. Live when the receiver's session runs (its stdin), else the receiver's next turn on its
conversation; a receiver with no session yet gets a new one."""

from . import runs


async def deliver_to_ticket(ticket_id: str, text: str, *, by: str) -> dict:
    """A note to the ticket's team (see runs.deliver_to_ticket)."""
    return await runs.deliver_to_ticket(ticket_id, text, by=by)


async def deliver_to_page(page_id: str, text: str, *, by: str) -> dict:
    """A note to a Docs page: the page's assistant answers in the page's thread (stage 7); until then the note is
    kept as a comment thread on the page."""
    import database
    from services import docs_comments

    async with database.async_session() as session:
        try:
            thread = await docs_comments.create_thread(
                session, page_id, body=text, author=by, kind="page"
            )
        except TypeError:
            thread = None
        except Exception as exc:  # noqa: BLE001 - the page may not take comments
            raise ValueError(f"The note could not be left on the page: {exc}") from exc
    return {
        "delivered": "page_comment",
        "thread_id": (thread or {}).get("id") if isinstance(thread, dict) else None,
    }
