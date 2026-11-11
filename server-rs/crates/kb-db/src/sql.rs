//! The few statements the app writes by hand, in a form every engine runs.

use sea_orm::{ConnectionTrait, DbBackend, DbErr, QueryResult, Statement, Value};

/// A statement written with `?` placeholders, as the engine wants it (`$1`, `$2`... on PostgreSQL).
pub fn statement(
    backend: DbBackend,
    sql: &str,
    values: impl IntoIterator<Item = Value>,
) -> Statement {
    Statement::from_sql_and_values(backend, placeholders(backend, sql), values)
}

/// `?` placeholders rewritten for the engine. A `?` inside a quoted string is left alone.
pub fn placeholders(backend: DbBackend, sql: &str) -> String {
    if backend != DbBackend::Postgres {
        return sql.to_string();
    }
    let mut out = String::with_capacity(sql.len() + 8);
    let mut n = 0;
    let mut quote: Option<char> = None;
    for c in sql.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
                out.push(c);
            }
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                out.push(c);
            }
            None if c == '?' => {
                n += 1;
                out.push('$');
                out.push_str(&n.to_string());
            }
            None => out.push(c),
        }
    }
    out
}

/// Add one to `table.column` in the row where `key` = `value` and return that row's new counter (and the `also`
/// columns), as a row; `None` when there is no such row.
///
/// The increment and the read are one step for every other writer: on MySQL the UPDATE locks the row until this
/// transaction ends, so the SELECT after it reads this transaction's own value and no one else can take the same
/// number. `table`, `column`, `key` and `also` are names written in the code, never user input.
pub async fn bump_counter<C: ConnectionTrait>(
    conn: &C,
    table: &str,
    column: &str,
    key: &str,
    value: Value,
    also: &[&str],
) -> Result<Option<QueryResult>, DbErr> {
    let backend = conn.get_database_backend();
    let names = std::iter::once(column)
        .chain(also.iter().copied())
        .collect::<Vec<_>>()
        .join(", ");
    // SQLite (3.35+) and PostgreSQL have UPDATE … RETURNING; MySQL and MariaDB do not
    if backend != DbBackend::MySql {
        let sql =
            format!("UPDATE {table} SET {column} = {column} + 1 WHERE {key} = ? RETURNING {names}");
        return conn.query_one_raw(statement(backend, &sql, [value])).await;
    }
    let sql = format!("UPDATE {table} SET {column} = {column} + 1 WHERE {key} = ?");
    let result = conn
        .execute_raw(statement(backend, &sql, [value.clone()]))
        .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }
    let sql = format!("SELECT {names} FROM {table} WHERE {key} = ?");
    conn.query_one_raw(statement(backend, &sql, [value])).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_placeholders_for_postgres_only() {
        assert_eq!(
            placeholders(DbBackend::Postgres, "a = ? AND b = '?' AND c = ?"),
            "a = $1 AND b = '?' AND c = $2"
        );
        assert_eq!(placeholders(DbBackend::Sqlite, "a = ?"), "a = ?");
    }
}
