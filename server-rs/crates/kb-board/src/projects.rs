//! Projects (`services/projects.py`).

use kb_db::Session;
use kb_db::entities::{META, TableMeta, docs_ai_settings, project, table_meta};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::sea_query::{Alias, Expr, ExprTrait, Query, SimpleExpr};
use kb_db::sea_orm::{ActiveModelTrait, ConnectionTrait, DbErr, EntityTrait, IntoActiveModel, QueryOrder, SqlErr};

use crate::git_repo::{GitError, normalize_repo_path};
use crate::members::create_member as _create_member;
use crate::schemas::{ProjectCreate, ProjectUpdate};
use kb_base::pytext;

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `ValueError` (a `GitRepoError` is one): the text is the message.
    Value(String),
    /// The database call failed.
    Db(DbErr),
    /// Any other exception (git could not be run): a 500.
    Other(String),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl From<GitError> for Error {
    fn from(err: GitError) -> Self {
        match err {
            GitError::Repo(message) => Error::Value(message),
            other => Error::Other(other.to_string()),
        }
    }
}

/// Return all projects (in the order they were made on SQLite; by name elsewhere, where a table has no order of
/// its own and projects have no creation time).
pub async fn list_projects(session: &Session) -> Result<Vec<project::Model>, DbErr> {
    let mut stmt = project::Entity::find();
    if session.dialect() != "sqlite" {
        stmt = stmt.order_by_asc(project::Column::Name).order_by_asc(project::Column::Id);
    }
    stmt.all(session).await
}

/// Return a project by id, or None.
pub async fn get_project(session: &Session, project_id: &str) -> Result<Option<project::Model>, DbErr> {
    project::Entity::find_by_id(project_id).one(session).await
}

/// SQLAlchemy's `IntegrityError`: a unique or foreign key rule of the database refused the row.
fn is_integrity_error(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_) | SqlErr::ForeignKeyConstraintViolation(_)))
}

/// Create a project.
///
/// `data` holds name, prefix and color; the prefix must be uppercase, at most 6 characters. Returns the created
/// project; fails with `ValueError` if the prefix is invalid or already used.
pub async fn create_project(session: &Session, data: &ProjectCreate) -> Result<project::Model, Error> {
    let prefix = pytext::strip(&data.prefix);
    if !pytext::isupper(prefix) || prefix.chars().count() > 6 {
        return Err(Error::Value("prefix must be uppercase and at most 6 characters".to_string()));
    }

    let mut project = project::new();
    project.name = Set(data.name.clone());
    project.prefix = Set(prefix.to_string());
    project.color = Set(data.color.clone());
    project.ticket_counter = Set(0);
    let stored = async {
        let project = project.insert(session).await?;
        _create_member(session, &project.id, "Admin", Some("#3B82F6"), "member", false).await?;
        // Docs AI is off for a new project until an admin turns it on (AI-1); projects made before keep theirs
        let mut settings = docs_ai_settings::new();
        settings.project_id = Set(project.id.clone());
        settings.enabled = Set(false);
        settings.insert(session).await?;
        session.commit().await?;
        Ok::<_, DbErr>(project)
    }
    .await;
    match stored {
        Ok(project) => Ok(project),
        Err(exc) if is_integrity_error(&exc) => {
            session.rollback().await?;
            Err(Error::Value("A project with this prefix already exists".to_string()))
        }
        Err(exc) => Err(exc.into()),
    }
}

/// Apply a partial update.
///
/// `data` holds the fields to change; an empty `repo_path` unlinks the repository. Returns the updated project,
/// or None if it does not exist.
pub async fn update_project(
    session: &Session,
    project_id: &str,
    data: &ProjectUpdate,
) -> Result<Option<project::Model>, Error> {
    let Some(project) = get_project(session, project_id).await? else {
        return Ok(None);
    };

    // `data.model_dump(exclude_none=True)`: only the fields that were given, in the model's order
    let unchanged = project.clone();
    let mut project = project.into_active_model();
    if let Some(name) = &data.name {
        project.name = Set(name.clone());
    }
    if let Some(color) = &data.color {
        project.color = Set(color.clone());
    }
    if let Some(repo_path) = &data.repo_path {
        let raw_path = pytext::strip(repo_path);
        // Empty string unlinks the repository; anything else must be a real git repo.
        project.repo_path = Set(if raw_path.is_empty() { None } else { Some(normalize_repo_path(raw_path).await?) });
    }
    if let Some(worktree_template) = &data.worktree_template {
        let raw_tmpl = pytext::strip(worktree_template);
        project.worktree_template = Set(if raw_tmpl.is_empty() { None } else { Some(raw_tmpl.to_string()) });
    }
    if let Some(worktree_by_default) = data.worktree_by_default {
        project.worktree_by_default = Set(worktree_by_default);
    }
    if let Some(docs_enabled) = data.docs_enabled {
        project.docs_enabled = Set(docs_enabled);
    }
    if let Some(docs_edit_policy) = data.docs_edit_policy {
        project.docs_edit_policy = Set(docs_edit_policy.as_str().to_string());
    }

    if !project.is_changed() {
        return Ok(Some(unchanged));
    }
    let project = project.update(session).await?;
    session.commit().await?;
    Ok(Some(project))
}

/// SQL condition selecting the rows of `table` that belong to the project, or None when the table is not tied to a
/// project (a global setting). A table with a `project_id` column is selected by it; a child table (a chat's
/// messages, a page's versions) through its foreign key to a table that is.
fn _owned_by(table: &TableMeta, project_id: &str, seen: &[&str]) -> Option<SimpleExpr> {
    if table.name == "project" {
        return None;
    }
    if table.column("project_id").is_some() {
        return Some(Expr::col((Alias::new(table.name), Alias::new("project_id"))).eq(project_id));
    }
    for column in table.columns {
        let Some((parent_name, parent_column)) = column.foreign_key else { continue };
        if parent_name == "project" || seen.contains(&parent_name) {
            continue;
        }
        let Some(parent) = table_meta(parent_name) else { continue };
        let mut seen = seen.to_vec();
        seen.push(table.name);
        if let Some(inner) = _owned_by(parent, project_id, &seen) {
            let rows = Query::select()
                .column((Alias::new(parent_name), Alias::new(parent_column)))
                .from(Alias::new(parent_name))
                .and_where(inner)
                .to_owned();
            return Some(Expr::col((Alias::new(table.name), Alias::new(column.name))).in_subquery(rows));
        }
    }
    None
}

/// Delete a project with everything in it: tickets, members, docs, AI members and runs, chats, ideas, sketches...
///
/// The database does not enforce foreign keys, so the rows are removed here: every table tied to the project, child
/// tables first, then the project. Files that tickets uploaded stay on disk.
///
/// Returns true if deleted, false if it does not exist.
pub async fn delete_project(session: &Session, project_id: &str) -> Result<bool, Error> {
    if get_project(session, project_id).await?.is_none() {
        return Ok(false);
    }

    // `reversed(SQLModel.metadata.sorted_tables)`: META lists parents before children
    for table in META.iter().rev() {
        if let Some(condition) = _owned_by(table, project_id, &[]) {
            let stmt = Query::delete().from_table(Alias::new(table.name)).and_where(condition).to_owned();
            session.execute(&stmt).await?;
        }
    }
    // the one child table without a foreign key to its page
    session.execute_unprepared("DELETE FROM docs_ai_ignore WHERE page_id NOT IN (SELECT id FROM docs_page)").await?;
    let stmt = Query::delete()
        .from_table(Alias::new("project"))
        .and_where(Expr::col((Alias::new("project"), Alias::new("id"))).eq(project_id))
        .to_owned();
    session.execute(&stmt).await?;
    session.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_db::sea_orm::sea_query::SqliteQueryBuilder;

    /// The tables in the order `delete_project` walks them, each with the rows it deletes for project `P`, written
    /// as SQLAlchemy writes the condition.
    fn walk() -> Vec<(String, Option<String>)> {
        META.iter()
            .rev()
            .map(|table| {
                let condition = _owned_by(table, "P", &[]).map(|c| {
                    let sql = Query::select().and_where(c).to_owned().to_string(SqliteQueryBuilder);
                    sql.trim_start_matches("SELECT  WHERE ").replace('"', "")
                });
                (table.name.to_string(), condition)
            })
            .collect()
    }

    /// `contract/golden/project_delete.json` is what the Python `_owned_by` gives over `SQLModel.metadata`.
    #[test]
    fn the_same_rows_of_the_same_tables_in_the_same_order_as_python() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/project_delete.json");
        let text = std::fs::read_to_string(path).expect("golden file project_delete.json exists");
        let golden: serde_json::Value = serde_json::from_str(&text).expect("golden file parses");
        let expected: Vec<(String, Option<String>)> = golden["tables"]
            .as_array()
            .expect("tables")
            .iter()
            .map(|t| (t["table"].as_str().expect("table").to_string(), t["where"].as_str().map(str::to_string)))
            .collect();
        assert!(expected.len() > 70, "{} tables", expected.len());
        assert_eq!(walk(), expected);
    }

    #[test]
    fn rows_are_selected_by_project_id_or_through_a_parent() {
        let walk = walk();
        let condition = |table: &str| walk.iter().find(|(t, _)| t == table).expect(table).1.clone();
        assert_eq!(condition("project"), None);
        assert_eq!(condition("ticket").as_deref(), Some("ticket.project_id = 'P'"));
        assert_eq!(
            condition("docs_version").as_deref(),
            Some("docs_version.page_id IN (SELECT docs_page.id FROM docs_page WHERE docs_page.project_id = 'P')")
        );
        // children are deleted before their parents
        let at = |table: &str| walk.iter().position(|(t, _)| t == table).expect(table);
        assert!(at("docs_version") < at("docs_page"));
        assert!(at("ai_chat_message") < at("ai_chat"));
        assert!(at("member") < at("project"));
    }
}
