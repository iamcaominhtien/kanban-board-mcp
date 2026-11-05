"""The one primitive of contact between AIs and people (AI v2, spec 4.3): a note to a ticket's team, or to a Docs
page's assistant. Live when the receiver's session runs (its stdin), else the receiver's next turn on its
conversation; a receiver with no session yet gets a new one."""

from . import runs


async def deliver_to_ticket(ticket_id: str, text: str, *, by: str) -> dict:
    """A note to the ticket's team (see runs.deliver_to_ticket)."""
    return await runs.deliver_to_ticket(ticket_id, text, by=by)


async def deliver_to_page(page_id: str, text: str, *, by: str) -> dict:
    """A note to a Docs page: it is kept as a page comment thread written by `by`, and the page's assistant answers
    in that thread on the page's own conversation (a `thread_reply` job) when Docs AI is on for the project.

    Returns:
        `{delivered: "page_assistant" | "page_comment", thread_id, job_id?}`.

    Raises:
        ValueError: the note could not be left on the page.
    """
    import database
    from services import activity, docs_comments
    from services.assistant import docs as assistant_docs
    from services.docs_ai import jobs

    token = activity.set_actor(by)
    try:
        async with database.async_session() as session:
            try:
                thread = await docs_comments.create_thread(
                    session, page_id, kind="page", body=text
                )
            except Exception as exc:  # noqa: BLE001 - the page may not take comments from this sender
                raise ValueError(
                    f"The note could not be left on the page: {exc}"
                ) from exc
            project_id = thread["project_id"] if "project_id" in thread else None
            if project_id is None:
                from models import DocsPage

                page = await session.get(DocsPage, page_id)
                project_id = page.project_id if page else None
            out = {"delivered": "page_comment", "thread_id": thread["id"]}
            if project_id is None or not await assistant_docs.docs_ai_on(
                session, project_id
            ):
                return out
            from services.assistant import engine

            if (await engine.ready(project_id))["state"] != "ready":
                return out
            job = await jobs.start(
                session,
                project_id=project_id,
                kind="thread_reply",
                started_by=by,
                page_id=page_id,
                thread_id=thread["id"],
                instruction=text[:300],
            )
            return {**out, "delivered": "page_assistant", "job_id": job.id}
    finally:
        activity.reset_actor(token)
