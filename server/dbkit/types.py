"""Column types that mean the same thing on SQLite, PostgreSQL and MySQL/MariaDB.

A plain ``str`` model field is SQLModel's ``AutoString``: VARCHAR without a limit on SQLite and PostgreSQL, but
VARCHAR(255) on MySQL and MariaDB. Pages, comments, prompts and transcripts are far longer, so on MySQL every such
column that is not a key or indexed becomes LONGTEXT (up to 4 GB). Key and indexed columns stay VARCHAR(255): MySQL
cannot index a TEXT column without a prefix, and ids, names and states fit. Nothing changes on SQLite or PostgreSQL:
the type still compiles to VARCHAR there, so the migrations see no difference.

Tables on MySQL use utf8mb4 (emoji and every script) with the binary collation, so ``=`` and unique keys compare
exactly, as they do on SQLite and PostgreSQL ("Done" and "done" are two values).
"""

from sqlalchemy import Column, MetaData
from sqlalchemy.dialects import mysql
from sqlmodel.sql.sqltypes import AutoString

MYSQL_CHARSET = "utf8mb4"
MYSQL_COLLATE = "utf8mb4_bin"


class LongText(AutoString):
    """Text of any length: LONGTEXT on MySQL/MariaDB, VARCHAR elsewhere (as before)."""

    cache_ok = True

    def load_dialect_impl(self, dialect):
        """LONGTEXT on MySQL, the usual string type on the others."""
        if dialect.name in ("mysql", "mariadb"):
            return dialect.type_descriptor(mysql.LONGTEXT())
        return super().load_dialect_impl(dialect)


def _keyed_columns(metadata: MetaData) -> set[Column]:
    keyed: set[Column] = set()
    for table in metadata.tables.values():
        for index in table.indexes:
            keyed.update(c for c in index.columns if isinstance(c, Column))
        for constraint in table.constraints:
            keyed.update(getattr(constraint, "columns", ()))
        for column in table.columns:
            if (
                column.primary_key
                or column.foreign_keys
                or column.index
                or column.unique
            ):
                keyed.add(column)
            for fk in column.foreign_keys:
                keyed.add(fk.column)
    return keyed


def portable_text(metadata: MetaData) -> list[str]:
    """Declare every long text column as text and set MySQL's table options. Returns the columns it changed
    ("table.column"), so a test can see which ones stay VARCHAR(255) on MySQL."""
    keyed = _keyed_columns(metadata)
    changed = []
    for table in metadata.tables.values():
        table.dialect_kwargs["mysql_charset"] = MYSQL_CHARSET
        table.dialect_kwargs["mysql_collate"] = MYSQL_COLLATE
        table.dialect_kwargs["mysql_engine"] = "InnoDB"
        for column in table.columns:
            if (
                type(column.type) is AutoString
                and column.type.length is None
                and column not in keyed
            ):
                column.type = LongText()
                changed.append(f"{table.name}.{column.name}")
    return changed


def short_text_columns(metadata: MetaData) -> list[Column]:
    """String columns that are VARCHAR(255) on MySQL (keys and indexed columns): a longer value cannot go in."""
    return [
        column
        for table in metadata.tables.values()
        for column in table.columns
        if type(column.type) is AutoString and column.type.length is None
    ]


def server_metadata(metadata: MetaData, dialect: str | None = None) -> MetaData:
    """The schema as it is made on PostgreSQL and MySQL: the same tables, columns and indexes, and the links between
    tables kept by the app, not enforced by the database.

    SQLite has never enforced them for the board (``PRAGMA foreign_keys`` stays off), and the app relies on that: it
    writes a row before the one it points at within a transaction and keeps rows whose parent was deleted (a docs
    page whose parent went to the bin). Enforcing them on one engine only would make the same action fail there.

    MySQL and MariaDB have no partial index: a unique index that holds only some rows
    would hold all of them there, so on ``dialect`` "mysql" it is made as a plain index.
    """
    from sqlalchemy import ForeignKeyConstraint

    copy = MetaData()
    for table in metadata.sorted_tables:
        t = table.to_metadata(copy)
        for constraint in list(t.constraints):
            if isinstance(constraint, ForeignKeyConstraint):
                t.constraints.discard(constraint)
        for column in t.columns:
            column.foreign_keys.clear()
        t.foreign_keys.clear()
        if dialect in ("mysql", "mariadb"):
            for index in t.indexes:
                if (
                    index.unique
                    and index.dialect_kwargs.get("sqlite_where") is not None
                ):
                    index.unique = False
    return copy
