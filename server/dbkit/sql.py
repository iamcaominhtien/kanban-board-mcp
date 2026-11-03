"""The few statements the app writes by hand, in a form every engine runs."""

from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession


def _update_returning(session: AsyncSession) -> bool:
    # SQLite (3.35+) and PostgreSQL have UPDATE … RETURNING; MySQL and MariaDB do not
    return session.get_bind().dialect.name != "mysql"


async def bump_counter(
    session: AsyncSession,
    table: str,
    column: str,
    key: str,
    value,
    also: tuple[str, ...] = (),
):
    """Add one to `table.column` in the row where `key` = `value` and return that row's new counter (and the `also`
    columns), as a Row; None when there is no such row.

    The increment and the read are one step for every other writer: on MySQL the UPDATE locks the row until this
    transaction ends, so the SELECT after it reads this transaction's own value and no one else can take the same
    number. `table`, `column`, `key` and `also` are names written in the code, never user input."""
    names = ", ".join((column, *also))
    params = {"v": value}
    if _update_returning(session):
        result = await session.execute(
            text(
                f"UPDATE {table} SET {column} = {column} + 1 WHERE {key} = :v RETURNING {names}"  # noqa: S608
            ),
            params,
        )
        return result.first()
    result = await session.execute(
        text(f"UPDATE {table} SET {column} = {column} + 1 WHERE {key} = :v"),  # noqa: S608
        params,
    )
    if not result.rowcount:
        return None
    return (
        await session.execute(
            text(f"SELECT {names} FROM {table} WHERE {key} = :v"),  # noqa: S608
            params,
        )
    ).first()
