//! `server/alembic/versions/e4b6d8f0a2c3_docs_rich_tables.py`
//!
//! Rich Docs, phase 2: the tables the rich editor's features keep their rows in.
//!
//! `docs_template` (a page template, a person's own or the project's), `docs_public_link` (a page shared by a
//! secret link), `docs_highlight` (a coloured passage with an optional thread), `docs_suggestion` (a change an
//! AI member or a person proposes to a block) and `docs_export` (a PDF, Word, HTML or Markdown export and its
//! progress). A project also gets `docs_settings`, its Docs settings as JSON. Nothing is read or converted here.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult, Types};

/// One column of a table made here: name, SQL type with its `NOT NULL` and `DEFAULT`.
type Spec<'a> = (&'a str, String);

/// `CREATE TABLE name (...)` with `id` as the primary key, unless the table is already there (so the upgrade can run
/// again on MySQL, which cannot roll a failed migration back).
async fn create<C: ConnectionTrait>(conn: &C, name: &str, columns: &[Spec<'_>]) -> StepResult {
    if ops::has_table(conn, name).await? {
        return Ok(());
    }
    let mut lines: Vec<String> = columns.iter().map(|(column, definition)| format!("{column} {definition}")).collect();
    lines.push("PRIMARY KEY (id)".to_string());
    let body = lines.join(", \n\t");
    ops::exec(conn, &format!("CREATE TABLE {name} (\n\t{body}\n)")).await?;
    Ok(())
}

/// `UNIQUE INDEX name ON table (column)` unless the table has an index with that name.
async fn create_unique_index<C: ConnectionTrait>(conn: &C, name: &str, table: &str, column: &str) -> StepResult {
    if ops::index_names(conn, table).await?.iter().any(|n| n == name) {
        return Ok(());
    }
    ops::exec(conn, &format!("CREATE UNIQUE INDEX {name} ON {table} ({column})")).await?;
    Ok(())
}

/// `upgrade()` of revision `e4b6d8f0a2c3`: make each table and index the database lacks, then the project column.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    let types = Types::of(conn);
    let (s, t) = (types.s.to_string(), types.t.to_string());
    let required = |kind: &str| format!("{kind} NOT NULL");
    let text = |kind: &str| kind.to_string();
    let default = |kind: &str, value: &str| format!("{kind} {}", types.not_null_default(value));
    let int = || "INTEGER NOT NULL".to_string();
    // a boolean's default is `false` on PostgreSQL and `0` elsewhere
    let false_default = if conn.get_database_backend() == sea_orm::DbBackend::Postgres { "false" } else { "0" };
    let flag = || format!("{} {}", types.b, types.not_null_default(false_default));

    create(
        conn,
        "docs_template",
        &[
            ("id", required(&s)),
            ("project_id", text(&s)),
            ("owner", required(&s)),
            ("name", required(&s)),
            ("description", text(&t)),
            ("category", text(&s)),
            ("keeps", default(&s, "'content'")),
            ("scope", default(&s, "'me'")),
            ("content", required(&t)),
            ("settings", text(&t)),
            ("used_count", format!("INTEGER {}", types.not_null_default("0"))),
            ("created_at", required(&s)),
            ("updated_at", required(&s)),
        ],
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_docs_template_project_id", "docs_template", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_docs_template_owner", "docs_template", &["owner"]).await?;

    create(
        conn,
        "docs_public_link",
        &[
            ("id", required(&s)),
            ("page_id", required(&s)),
            ("token", required(&s)),
            ("created_by", required(&s)),
            ("created_at", required(&s)),
            ("expires_at", text(&s)),
            ("show_names", flag()),
            ("allow_index", flag()),
            ("revoked_at", text(&s)),
        ],
    )
    .await?;
    create_unique_index(conn, "ix_docs_public_link_token", "docs_public_link", "token").await?;
    ops::create_index_if_missing(conn, "ix_docs_public_link_page_id", "docs_public_link", &["page_id"]).await?;

    create(
        conn,
        "docs_highlight",
        &[
            ("id", required(&s)),
            ("page_id", required(&s)),
            ("block_id", required(&s)),
            ("start_offset", int()),
            ("end_offset", int()),
            ("end_block_id", text(&s)),
            ("quote", required(&t)),
            ("prefix", text(&t)),
            ("suffix", text(&t)),
            ("color", required(&s)),
            ("author", required(&s)),
            ("created_at", required(&s)),
            ("thread_id", text(&s)),
            ("state", default(&s, "'ok'")),
            ("deleted_at", text(&s)),
            ("deleted_by", text(&s)),
        ],
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_docs_highlight_page_id", "docs_highlight", &["page_id"]).await?;
    ops::create_index_if_missing(conn, "ix_docs_highlight_thread_id", "docs_highlight", &["thread_id"]).await?;

    // BEFORE is a reserved word on MySQL (and a keyword on SQLite), so the column name is always quoted
    let before = types.q("before");
    create(
        conn,
        "docs_suggestion",
        &[
            ("id", required(&s)),
            ("page_id", required(&s)),
            ("block_id", text(&s)),
            ("after_block_id", text(&s)),
            ("kind", required(&s)),
            ("content", text(&t)),
            (before.as_str(), text(&t)),
            ("base_version", int()),
            ("author", required(&s)),
            ("member_id", text(&s)),
            ("run_id", text(&s)),
            ("note", text(&t)),
            ("state", default(&s, "'pending'")),
            ("decided_by", text(&s)),
            ("decided_at", text(&s)),
            ("created_at", required(&s)),
        ],
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_docs_suggestion_page_id", "docs_suggestion", &["page_id"]).await?;
    ops::create_index_if_missing(conn, "ix_docs_suggestion_member_id", "docs_suggestion", &["member_id"]).await?;
    ops::create_index_if_missing(conn, "ix_docs_suggestion_run_id", "docs_suggestion", &["run_id"]).await?;

    create(
        conn,
        "docs_export",
        &[
            ("id", required(&s)),
            ("project_id", required(&s)),
            ("page_id", text(&s)),
            ("scope", required(&s)),
            ("format", required(&s)),
            ("options", text(&t)),
            ("state", default(&s, "'running'")),
            ("step", text(&s)),
            ("file_path", text(&t)),
            ("file_name", text(&t)),
            ("size", text("INTEGER")),
            ("error", text(&t)),
            ("created_by", required(&s)),
            ("created_at", required(&s)),
            ("finished_at", text(&s)),
            ("expires_at", text(&s)),
        ],
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_docs_export_project_id", "docs_export", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_docs_export_page_id", "docs_export", &["page_id"]).await?;

    ops::add_missing_columns(conn, "project", &[("docs_settings", types.t)]).await?;
    Ok(())
}
