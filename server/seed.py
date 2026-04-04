"""Idempotent seed script — requires migrations to be applied first.
Run: uv run alembic upgrade head && uv run python seed.py"""

import asyncio

from sqlmodel import select

from database import async_session
from models import Project


async def seed() -> None:
    async with async_session() as session:
        existing = await session.exec(select(Project).where(Project.prefix == "IAM"))
        if existing.first() is not None:
            print("Seed data already present — skipping.")
            return

        project = Project(
            name="Kanban Board MCP",
            prefix="IAM",
            color="#6366f1",
        )
        session.add(project)
        await session.commit()
        print(f"Seeded project: {project.name} (id={project.id})")


if __name__ == "__main__":
    asyncio.run(seed())
