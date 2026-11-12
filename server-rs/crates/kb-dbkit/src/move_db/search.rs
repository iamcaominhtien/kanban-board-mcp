//! The SQLite target's full-text indexes after a copy.

use kb_db::sea_orm::{ConnectionTrait, DatabaseTransaction, DbBackend, DbErr, Statement, TransactionTrait};

use super::errors::Error;
use super::mover::{FTS_TABLES, Mover};
use super::raw::{self, Reader, Sea};
use super::values::Cell;
use crate::hooks;

impl Mover {
    /// The SQLite target's full-text indexes: copied from a SQLite source, rebuilt otherwise.
    pub(crate) async fn rebuild_search(&mut self) -> Result<(), Error> {
        let source_is_sqlite = self.source.is_sqlite();
        let src_names = raw::table_names(self.snap()?).await?;
        let txn = self.dst().await?.begin().await?;
        let dst_names = raw::table_names(&mut Sea(&txn)).await?;
        for fts in FTS_TABLES {
            if !dst_names.iter().any(|n| n == fts) {
                continue;
            }
            txn.execute_unprepared(&format!("DELETE FROM {fts}")).await?;
            if source_is_sqlite && src_names.iter().any(|n| n == fts) {
                let info = self.snap()?.rows(&format!("PRAGMA table_info({fts})"), Vec::new()).await?;
                let cols: Vec<String> = info.iter().filter_map(|r| r.get(1).map(Cell::py_str)).collect();
                let rows = self.snap()?.rows(&format!("SELECT {} FROM {fts}", cols.join(", ")), Vec::new()).await?;
                let insert = format!(
                    "INSERT INTO {fts} ({}) VALUES ({})",
                    cols.join(", "),
                    vec!["?"; cols.len()].join(", ")
                );
                for row in rows {
                    let values = row.iter().map(|v| v.to_db_value("str"));
                    txn.execute_raw(Statement::from_sql_and_values(DbBackend::Sqlite, &insert, values)).await?;
                }
            } else if fts == "docs_fts" {
                // `docs_search.backfill_sync`: the Docs area builds its own index
                if let Some(hook) = hooks::docs_search() {
                    hook.backfill(&txn).await?;
                }
            } else if fts == "kb_fts" {
                rebuild_kb(&txn).await?;
            }
        }
        txn.commit().await?;
        Ok(())
    }
}

async fn rebuild_kb(txn: &DatabaseTransaction) -> Result<(), Error> {
    let rows = Sea(txn)
        .rows("SELECT id, project_id, store, title, summary, keywords, text FROM ai_knowledge_doc", Vec::new())
        .await?;
    for d in rows {
        let text = |i: usize| match &d[i] {
            Cell::Null => String::new(),
            other => other.py_str(),
        };
        let keywords = Some(text(5)).filter(|k| !k.is_empty()).unwrap_or_else(|| "[]".to_string());
        let keywords: Vec<String> = serde_json::from_str(&keywords)
            .map_err(|err| DbErr::Custom(format!("ai_knowledge_doc.keywords of {} is not a list of words: {err}", text(0))))?;
        let values = [
            d[0].to_db_value("str"),
            text(1).into(),
            d[2].to_db_value("str"),
            d[3].to_db_value("str"),
            text(4).into(),
            keywords.join(" ").into(),
            text(6).into(),
        ];
        txn.execute_raw(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO kb_fts (doc_id, project_id, store, title, summary, keywords, body) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            values,
        ))
        .await?;
    }
    Ok(())
}
