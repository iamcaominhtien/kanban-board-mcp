"""A small but varied board for the database tests and the demo: projects, members, tickets with children, comments,
docs pages with versions, ideas, emoji and non-Latin text, and a long page."""

from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from models import ProjectCreate
from services import docs, idea_tickets, members, projects, tickets

LONG = (
    "## Why\n\n"
    + "Ticket boards outgrow one laptop: a team wants one database. 🚀 " * 120
)


async def seed(engine, *, projects_n: int = 2, tickets_n: int = 12) -> dict:
    """Fill a migrated, empty database through the app's own services; returns some ids."""
    make = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    out = {"projects": [], "tickets": []}
    async with make() as s:
        for p in range(projects_n):
            project = await projects.create_project(
                s,
                ProjectCreate(
                    name=["Kanban Board", "Mobile app — 移动应用", "Ops"][p % 3],
                    prefix=["KB", "MOB", "OPS"][p % 3],
                    color="#2E6F40",
                ),
            )
            out["projects"].append(project.id)
            owner = await members.create_member(s, project.id, "Minh", role="admin")
            await members.create_member(s, project.id, "Zoë Ångström")
            parent = None
            for i in range(tickets_n):
                t = await tickets.create_ticket(
                    s,
                    project.id,
                    f"Ticket {i + 1} · ünïcödé 🎯",
                    description=LONG if i == 0 else f"Step {i} of the plan.",
                    status=["backlog", "todo", "in-progress", "done"][i % 4],
                    parent_id=parent if i % 5 == 4 else None,
                    tags=["db", "move"] if i % 2 else [],
                    assignee=owner.id if i % 3 == 0 else None,
                    estimate=1.5 if i % 2 else None,
                )
                out["tickets"].append(t.id)
                if i == 0:
                    parent = t.id
                if i % 3 == 0:
                    await tickets.add_comment(s, t.id, f"Looks good — {i} ✅")
            page = await docs.create_page(
                s,
                project.id,
                "Architecture",
                markdown=LONG + "\n\n## Storage\n\nSQLite by default.",
            )
            await docs.publish_page(s, page["id"], base_version=0, note="first")
            child = await docs.create_page(
                s,
                project.id,
                "Database notes",
                parent_id=page["id"],
                markdown="# Notes\n\nPostgreSQL 14+.",
            )
            await docs.publish_page(s, child["id"], base_version=0)
            await idea_tickets.create_idea_ticket(
                s, project.id, "Offline mode", description=LONG, idea_emoji="🛰️"
            )
        await s.commit()
    return out
