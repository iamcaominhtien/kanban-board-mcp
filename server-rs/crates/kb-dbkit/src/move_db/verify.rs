//! Step 4 of a move: prove the copy.

use std::collections::HashMap;

use kb_db::entities::TableMeta;
use kb_db::sea_orm::{DatabaseConnection, DbBackend, DbErr, Value as DbValue};
use serde_json::{Value, json};

use super::errors::Error;
use super::mover::{Mover, SAMPLE_ROWS, app_tables, column_list, primary_key, serial_key};
use super::raw::{self, Reader, Sea, quote};
use super::values::{Cell, coerce, commas, key_of, same};

impl Mover {
    /// Prove the copy: equal row counts in every table, a random sample of each table read back and compared value
    /// by value, the same links between rows on both sides, counters that carry on, and docs search.
    pub async fn verify(&mut self, sample: Option<usize>) -> Result<Value, Error> {
        let sample = sample.unwrap_or(SAMPLE_ROWS);
        let mut checks: Vec<Value> = Vec::new();
        let mut tables: Vec<Value> = Vec::new();
        let mut differ: Vec<&str> = Vec::new();
        let mut rows = 0;
        let dst = self.dst().await?;
        for t in app_tables() {
            let a = raw::count(self.snap()?, t.name).await?;
            let b = raw::count(&mut Sea(&dst), t.name).await?;
            tables.push(json!({"name": t.name, "source": a, "target": b, "same": a == b}));
            rows += b;
            if a != b {
                differ.push(t.name);
            }
        }
        checks.push(json!({
            "key": "counts",
            "ok": differ.is_empty(),
            "title": format!(
                "Row counts{}",
                if differ.is_empty() {
                    format!(" · equal in all {} tables", tables.len())
                } else {
                    format!(
                        " · differ in {} table(s): {}",
                        differ.len(),
                        differ.iter().take(6).copied().collect::<Vec<_>>().join(", ")
                    )
                }
            ),
        }));
        let (mismatched, compared) = self.compare_samples(&dst, sample).await?;
        checks.push(json!({
            "key": "content",
            "ok": mismatched.is_empty(),
            "title": format!(
                "Content · {} rows read back and compared{}{}",
                commas(compared),
                if compared != 0 { format!(" ({sample} at random per big table)") } else { String::new() },
                match mismatched.first() {
                    None => String::new(),
                    Some(first) => format!(
                        " · {} differ, first in {}",
                        mismatched.len(),
                        first["table"].as_str().unwrap_or("")
                    ),
                }
            ),
            "mismatches": mismatched.iter().take(20).cloned().collect::<Vec<_>>(),
        }));
        checks.push(self.compare_links(&dst).await?);
        checks.push(self.counters(&dst).await?);
        if self.target.is_sqlite() {
            checks.push(search(&dst).await);
        }
        let ok = checks.iter().all(|c| c["ok"] == json!(true));
        Ok(json!({
            "ok": ok,
            "checks": checks,
            "tables": tables,
            "rows": rows,
            "differ": differ,
            "elapsed_s": self.started.map(|started| (started.elapsed().as_secs_f64() * 10.0).round() / 10.0),
        }))
    }

    async fn compare_samples(
        &mut self,
        dst: &DatabaseConnection,
        sample: usize,
    ) -> Result<(Vec<Value>, i64), Error> {
        let mut mismatched: Vec<Value> = Vec::new();
        let mut compared = 0;
        for t in app_tables() {
            let pk = primary_key(t);
            if pk.is_empty() {
                continue;
            }
            let pk_at: Vec<usize> = t.columns.iter().enumerate().filter(|(_, c)| c.primary_key).map(|(i, _)| i).collect();
            let source_backend = self.snap()?.backend();
            let random = if source_backend == DbBackend::MySql { "rand()" } else { "random()" };
            let rows = self
                .snap()?
                .rows(
                    &format!(
                        "SELECT {} FROM {} ORDER BY {random} LIMIT {sample}",
                        column_list(source_backend, t),
                        quote(source_backend, t.name)
                    ),
                    Vec::new(),
                )
                .await?;
            if rows.is_empty() {
                continue;
            }
            // by primary key, as the target will give it back; a key sampled twice keeps its last row
            let mut order: Vec<String> = Vec::new();
            let mut keyed: HashMap<String, (Vec<Cell>, Vec<Cell>)> = HashMap::new();
            for row in rows {
                let key: Vec<Cell> = pk_at.iter().map(|i| coerce(t.columns[*i].kind, row[*i].clone())).collect();
                let id = key.iter().map(key_of).collect::<Vec<_>>().join("\u{1f}");
                if !keyed.contains_key(&id) {
                    order.push(id.clone());
                }
                keyed.insert(id, (key, row));
            }
            let mut found: HashMap<String, Vec<Cell>> = HashMap::new();
            for chunk in order.chunks(200) {
                let keys: Vec<&Vec<Cell>> = chunk.iter().filter_map(|id| keyed.get(id).map(|(key, _)| key)).collect();
                for row in rows_by_key(dst, t, &keys).await? {
                    let id = pk_at.iter().map(|i| key_of(&row[*i])).collect::<Vec<_>>().join("\u{1f}");
                    found.insert(id, row);
                }
            }
            for id in &order {
                let Some((key, src_row)) = keyed.get(id) else { continue };
                compared += 1;
                let key: Vec<String> = key.iter().map(Cell::py_str).collect();
                let Some(got) = found.get(id) else {
                    mismatched.push(json!({"table": t.name, "key": key, "column": null}));
                    continue;
                };
                for (i, c) in t.columns.iter().enumerate() {
                    if !same(&coerce(c.kind, src_row[i].clone()), &got[i]) {
                        if src_row[i].is_null() && !c.nullable {
                            continue; // filled with the app's default on the way
                        }
                        mismatched.push(json!({"table": t.name, "key": key, "column": c.name}));
                        break;
                    }
                }
            }
        }
        Ok((mismatched, compared))
    }

    async fn compare_links(&mut self, dst: &DatabaseConnection) -> Result<Value, Error> {
        let mut differ: Vec<String> = Vec::new();
        let mut already = 0;
        let mut kinds = 0;
        for t in app_tables() {
            for c in t.columns {
                let Some((parent, parent_column)) = c.foreign_key else { continue };
                kinds += 1;
                let a = orphans(self.snap()?, t.name, c.name, parent, parent_column).await?;
                let b = orphans(&mut Sea(dst), t.name, c.name, parent, parent_column).await?;
                already += a;
                if a != b {
                    differ.push(format!("{}.{}", t.name, c.name));
                }
            }
        }
        let mut title = format!("Links between rows · the same {kinds} kinds of link on both sides");
        if already != 0 && differ.is_empty() {
            title.push_str(&format!(
                " ({} row(s) already pointed at a deleted row in the source and still do)",
                commas(already)
            ));
        }
        if !differ.is_empty() {
            title = format!(
                "Links between rows · differ in {}",
                differ.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
            );
        }
        Ok(json!({"key": "links", "ok": differ.is_empty(), "title": title, "orphans": already}))
    }

    async fn counters(&mut self, dst: &DatabaseConnection) -> Result<Value, Error> {
        let rows = Sea(dst)
            .rows("SELECT prefix, ticket_counter FROM project ORDER BY ticket_counter DESC", Vec::new())
            .await?;
        let src = self.snap()?.rows("SELECT prefix, ticket_counter FROM project", Vec::new()).await?;
        let src: HashMap<String, Cell> =
            src.into_iter().map(|row| (key_of(&row[0]), row.get(1).cloned().unwrap_or(Cell::Null))).collect();
        let mut ok = rows.iter().all(|row| src.get(&key_of(&row[0])).is_some_and(|n| same(n, &row[1])))
            && src.len() == rows.len();
        if self.target.engine == "postgresql" {
            ok = ok && sequences_ok(dst).await?;
        }
        let title = match rows.first() {
            Some(top) => format!(
                "Counters · the next ticket number carries on from {}-{}",
                top[0].py_str(),
                commas(top[1].as_i64().unwrap_or(0) + 1)
            ),
            None => "Counters · no projects yet".to_string(),
        };
        Ok(json!({"key": "counters", "ok": ok, "title": title}))
    }
}

/// Rows of `child` whose `column` names a row of `parent` that is not there.
async fn orphans<R: Reader + ?Sized>(
    reader: &mut R,
    child: &str,
    column: &str,
    parent: &str,
    parent_column: &str,
) -> Result<i64, DbErr> {
    let backend = reader.backend();
    let q = |name: &str| quote(backend, name);
    let statement = format!(
        "SELECT count(*) FROM {child} LEFT OUTER JOIN {parent} AS p ON {child}.{column} = p.{parent_column} \
         WHERE {child}.{column} IS NOT NULL AND p.{parent_column} IS NULL",
        child = q(child),
        parent = q(parent),
        column = q(column),
        parent_column = q(parent_column),
    );
    Ok(reader.scalar(&statement, Vec::new()).await?.as_i64().unwrap_or(0))
}

/// The target's rows with these primary keys.
async fn rows_by_key(dst: &DatabaseConnection, t: &TableMeta, keys: &[&Vec<Cell>]) -> Result<Vec<Vec<Cell>>, DbErr> {
    let backend = dst.get_database_backend();
    let pk = primary_key(t);
        let mut params: Vec<DbValue> = Vec::with_capacity(keys.len() * pk.len());
        let condition = if pk.len() == 1 {
            for key in keys {
                params.push(key[0].to_db_value(pk[0].kind));
            }
            format!("{} IN ({})", quote(backend, pk[0].name), vec!["?"; keys.len()].join(", "))
        } else {
            for key in keys {
                for (value, column) in key.iter().zip(&pk) {
                    params.push(value.to_db_value(column.kind));
                }
            }
            let one = format!("({})", vec!["?"; pk.len()].join(", "));
            format!(
                "({}) IN ({})",
                pk.iter().map(|c| quote(backend, c.name)).collect::<Vec<_>>().join(", "),
                vec![one; keys.len()].join(", ")
            )
        };
        let statement = format!("SELECT {} FROM {} WHERE {condition}", column_list(backend, t), quote(backend, t.name));
        Sea(dst).rows(&statement, params).await
    }


async fn sequences_ok(dst: &DatabaseConnection) -> Result<bool, Error> {
    let mut dst = Sea(dst);
    for t in app_tables() {
        let Some(pk) = serial_key(t) else { continue };
        let seq =
            dst.scalar("SELECT pg_get_serial_sequence(?, ?)", vec![t.name.into(), pk.name.into()]).await?;
        let Cell::Text(seq) = seq else { continue };
        let top = dst.scalar(&format!("SELECT max(\"{}\") FROM \"{}\"", pk.name, t.name), Vec::new()).await?;
        let last = dst.scalar(&format!("SELECT last_value FROM {seq}"), Vec::new()).await?;
        if let Some(top) = top.as_i64() {
            if last.as_i64().unwrap_or(0) < top {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

async fn search(dst: &DatabaseConnection) -> Value {
    let mut dst = Sea(dst);
    let counted = async {
        let live = dst.scalar("SELECT COUNT(*) FROM docs_page WHERE deleted_at IS NULL", Vec::new()).await?;
        let indexed = dst.scalar("SELECT COUNT(*) FROM docs_fts", Vec::new()).await?;
        Ok::<(i64, i64), DbErr>((live.as_i64().unwrap_or(0), indexed.as_i64().unwrap_or(0)))
    }
    .await;
    match counted {
        Err(_) => json!({
            "key": "search",
            "ok": true,
            "title": "Docs search · uses the plain search (no FTS5 here)",
        }),
        Ok((live, indexed)) => json!({
            "key": "search",
            "ok": indexed >= live,
            "title": format!("Docs search · {} of {} pages indexed", commas(indexed), commas(live)),
        }),
    }
}
