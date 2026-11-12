# Databases: SQLite, PostgreSQL, MySQL/MariaDB

The board keeps everything (projects, tickets, docs, AI runs) in one relational database. **SQLite is the default**:
one file, `kanban.db`, in the data folder, with nothing to set up. **PostgreSQL 14+** and **MySQL 8 / MariaDB 10.6+**
are real alternatives for a server you already run, backups with your own tools, or a team. Redis and MongoDB are not
offered: the board is 77 tables that refer to each other, and a key-value or document store could not keep those links.

Design: [`design/screens/ai-databases.md`](../../design/screens/ai-databases.md).

## Choosing one

| Where | How |
|---|---|
| App settings › Storage & backup › Database | **Move to another database…**: choose the engine, enter the connection, **Test connection**, then check, copy, verify and switch. No restart. |
| A terminal | `kanban-db migrate …` then `kanban-db use …` (below). The running board follows within a few seconds. |
| A server (environment) | `KANBAN_DATABASE_URL=postgresql://user@host:5432/kanban`. It wins over Settings and locks the card. `KANBAN_DB_PASSWORD` gives the password when the URL has none. |

The choice is saved in `~/.kanban-board/config.json` (engine, host, port, database, user, SSL mode). The password is
never stored as text: it is encrypted with the app's own key, which the desktop app keeps in the system keychain (and
elsewhere is a key file only you can read). The stdio MCP process that editors launch reads the same setting and follows
a switch, so the board and the editors always use one database.

Attachments, AI run logs and the board's skills stay in the data folder on this computer whichever database you use.

### Schema and versions

All three engines hold the same schema. The server brings the database it opens up to date by itself, with its own
migrations (`server/crates/kb-db/src/migrations/`, one module per revision, 80 in all), and keeps the revision in the
`alembic_version` table with the same revision ids the 4.x versions used. The schema did not change in 5.0.0, so a
database made by 4.0.x opens in 5.0.0 and a database made by 5.0.0 opens in 4.0.x. A database made by a newer version
than the app is refused and left as it is: update the app first.

## Moving data

One flow in four steps, run three ways (the Settings wizard, the script, and an AI that helps when a copy stops). Any
direction works: SQLite → PostgreSQL, PostgreSQL → MySQL, back to SQLite.

1. **Where to**: the test reaches the server, signs in, checks the version, the encoding / character set, that the user
   can create tables (in a transaction it rolls back), whether the connection is encrypted, and that the database is
   empty. Every problem comes with how to fix it and the statement to copy (`CREATE DATABASE …`, `GRANT …`).
2. **Check**: what will be copied (tables, rows), what stays behind, and values the target cannot take as they are
   (text over 255 characters in an indexed column on MySQL, empty values in required columns). Nothing is written.
3. **Copy**: the target gets the app's own tables (the migrations on SQLite; the schema stamped at the newest migration
   on PostgreSQL and MySQL). Rows go table by table, parents first, in batches of up to 1,000 rows, one transaction per
   table. The source is only read, from one consistent snapshot, so the board stays usable. Pause, resume and cancel
   (cancel clears the new database). A copy that stops resumes from the table it stopped in, re-reading it from its
   start, so nothing is duplicated.
4. **Verify**: row counts in every table, a random sample of up to 500 rows per table read back and compared value by
   value, the links between rows (the same on both sides), counters (the next ticket number, PostgreSQL sequences) and
   docs search. Then **Switch** points the board at the new database; the old one is left as it was. If the board was
   used during the copy, Switch copies the latest state again first.

### When a copy stops: the AI helper

The wizard shows what the board knows (table, row, column, the column's type on both sides, the length of the value,
the engines) and **Ask the AI** sends exactly that to an AI member of the board (a project's Board AI, or the first
Claude Code or API-key member): never the rows, never a password. It answers with the likely cause and a change to the
new database. Only `ALTER TABLE` on the board's own tables can be applied, and nothing that drops or renames. **Apply and
resume** runs it, resumes the copy and verifies again: the AI proposes, the board applies and checks.

### The script

The command is `kanban-db`. It is part of the server program: `kanban-server db <command>` runs it, and `kanban-db`
is the same program started under that name (a link to `kanban-server`). In the desktop app the program is in the
app's resources, in the `kanban-mcp-stdio` folder next to `kanban-mcp-stdio`. In a checkout:

```bash
cd server
cargo build -p kanban-server
export KANBAN_DB_PASSWORD=…        # the target's password, kept out of your shell history
./target/debug/kanban-server db test postgresql://kanban@db.internal/kanban
./target/debug/kanban-server db migrate --from sqlite:///$HOME/kanban-data/kanban.db --to postgresql://kanban@db.internal/kanban --dry-run
./target/debug/kanban-server db migrate --from sqlite:///$HOME/kanban-data/kanban.db --to postgresql://kanban@db.internal/kanban --verify
./target/debug/kanban-server db use postgresql://kanban@db.internal/kanban
```

(`cargo run -p kanban-server -- db test …` does the same without the path.)

`--empty-first` deletes what the target holds (it asks you to type its name; `--yes-empty NAME` for scripts),
`--resume` continues an interrupted copy. Exit codes: 0 done · 1 verify failed · 2 cannot connect · 3 target not empty ·
4 stopped (resume it). `KANBAN_DB_FROM_PASSWORD` gives the source's password.

## Export and import

Export is a ZIP with `kanban.db` and the attachments, on every engine: on PostgreSQL and MySQL the board copies every
table into a SQLite file for it, so one export loads into any engine (and into older versions of the app). Import
replaces the data in the database in use, after the same confirmation; on a server database, what was there is copied
aside first and put back if the import fails.

## How each engine is set up

- **SQLite**: WAL (readers never wait for the writer), `synchronous=NORMAL` (safe with WAL, one fsync less per commit),
  a 30-second busy timeout (the board and the stdio MCP process share the file: a writer waits for the other instead of
  failing), an in-memory temp store and a 16 MB page cache per connection.
- **PostgreSQL**: a pool of up to 15 connections checked before use and renewed every 30 minutes, SSL from
  `disable` to `verify-full`. Each process names its connections (`kanban-board app …`, `kanban-board mcp …`), so the card
  can say when another board uses the same database.
- **MySQL / MariaDB**: the same pool, `READ COMMITTED` (no gap locks between unrelated writers), tables in
  `utf8mb4` with the binary collation (exact comparison, as on SQLite and PostgreSQL). Long text is `LONGTEXT`; key and
  indexed text columns are `VARCHAR(255)`.
- **Links between tables** are kept by the app, not enforced by PostgreSQL or MySQL, exactly as on SQLite, where the
  board never turned `PRAGMA foreign_keys` on: the app writes some rows before the row they point at within a
  transaction and keeps rows whose parent went to the bin.
- **Live updates from other processes**: SQLite's `PRAGMA data_version` on SQLite; on a server database every write
  transaction adds a row to `kanban_change` (who wrote it) and the board polls the newest row another process wrote.
- **Search**: docs, knowledge-base and history search use SQLite's FTS5 index; on PostgreSQL and MySQL they use the plain
  search the board already falls back to (the same results, slower on very large boards).

## Testing on a server

The tests of the data layer (`kb-db`, `kb-dbkit`) run on SQLite always and on a server database when its URL is
set; each skips a server whose variable is missing. `scripts/dev-databases.sh start` (in `server/`) starts a local PostgreSQL
and MariaDB (their server programs must be installed) and prints the two URLs; `stop` removes them.

```bash
cd server
scripts/dev-databases.sh start      # prints the two URLs
KANBAN_TEST_POSTGRES_URL='postgresql://kanban@127.0.0.1:55432/kanban_test?sslmode=disable' \
KANBAN_TEST_MYSQL_URL='mysql://kanban:kanban@127.0.0.1:53306/kanban_test?sslmode=disable' \
  cargo test -p kb-db -p kb-dbkit
```

The Databases job of CI runs the same command against PostgreSQL 16 and MariaDB 10.11 service containers, including a
round trip SQLite → PostgreSQL → MariaDB → SQLite compared row by row (`test_round_trip_sqlite_postgres_mysql_sqlite`).
