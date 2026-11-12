//! Project members (`services/members.py`).

use kb_db::Session;
use kb_db::entities::{member, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::sea_query::Expr;
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter, QueryOrder,
    QuerySelect,
};

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `ValueError`: the text is the message.
    Value(String),
    /// The database call failed.
    Db(DbErr),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

const _DEFAULT_COLORS: [&str; 8] =
    ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16"];

/// Return the members of a project.
pub async fn list_members(session: &Session, project_id: &str) -> Result<Vec<member::Model>, DbErr> {
    member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        // SQLite's insertion order, on every engine
        .order_by_asc(member::Column::CreatedAt)
        .order_by_asc(member::Column::Id)
        .all(session)
        .await
}

/// Return a member by id, or None.
pub async fn get_member(session: &Session, member_id: &str) -> Result<Option<member::Model>, DbErr> {
    member::Entity::find_by_id(member_id).one(session).await
}

/// Add a member, picking a default color when none is given.
///
/// `color` is the avatar color and defaults to the next palette color; `role` is the Docs comment role (viewer,
/// member or admin; "member" in Python when not given). `commit` commits the session; pass false to batch with
/// other changes. Returns the created member.
pub async fn create_member(
    session: &Session,
    project_id: &str,
    name: &str,
    color: Option<&str>,
    role: &str,
    commit: bool,
) -> Result<member::Model, DbErr> {
    let color = match color.filter(|c| !c.is_empty()) {
        Some(color) => color.to_string(),
        None => {
            let existing = list_members(session, project_id).await?;
            _DEFAULT_COLORS[existing.len() % _DEFAULT_COLORS.len()].to_string()
        }
    };
    let mut member = member::new();
    member.project_id = Set(project_id.to_string());
    member.name = Set(name.to_string());
    member.color = Set(color);
    member.role = Set(role.to_string());
    let member = member.insert(session).await?;
    if commit {
        session.commit().await?;
    }
    Ok(member)
}

/// Delete a member.
///
/// Returns true if removed, false if not found in that project. Fails with `ValueError` if the member created
/// tickets or is still assigned to some.
pub async fn remove_member(session: &Session, project_id: &str, member_id: &str) -> Result<bool, Error> {
    let Some(member) = get_member(session, member_id).await?.filter(|m| m.project_id == project_id) else {
        return Ok(false);
    };
    if member.kind != "human" {
        return Err(Error::Value(
            "This is an AI member: remove it from the AI members page (it handles its tickets and runs).".to_string(),
        ));
    }

    let creator_check = ticket::Entity::find()
        .filter(ticket::Column::ProjectId.eq(project_id))
        .filter(ticket::Column::CreatedBy.eq(member_id))
        .limit(1)
        .one(session)
        .await?;
    if creator_check.is_some() {
        return Err(Error::Value("Cannot remove member who created tickets".to_string()));
    }

    // Block removing member if assigned to open tickets (not done or wont_do)
    let open_tickets = ticket::Entity::find()
        .filter(ticket::Column::ProjectId.eq(project_id))
        .filter(ticket::Column::Assignee.eq(member_id))
        .filter(ticket::Column::Status.is_not_in(["done", "wont_do"]))
        .all(session)
        .await?;
    let count = open_tickets.len();
    if count > 0 {
        let tickets_str = if count == 1 { format!("{count} open ticket") } else { format!("{count} open tickets") };
        return Err(Error::Value(format!("Cannot remove: assigned to {tickets_str}. Reassign first.")));
    }

    // Unassign any remaining closed tickets assigned to this member
    ticket::Entity::update_many()
        .col_expr(ticket::Column::Assignee, Expr::value(Option::<String>::None))
        .filter(ticket::Column::ProjectId.eq(project_id))
        .filter(ticket::Column::Assignee.eq(member_id))
        .exec(session)
        .await?;

    member.delete(session).await?;
    session.commit().await?;
    Ok(true)
}

pub const MEMBER_ROLES: [&str; 3] = ["viewer", "member", "admin"];

/// Change a member's Docs role.
///
/// Returns the updated member, or None if not found in that project. Fails with `ValueError` if the role is not
/// one of `MEMBER_ROLES`.
pub async fn set_member_role(
    session: &Session,
    project_id: &str,
    member_id: &str,
    role: &str,
) -> Result<Option<member::Model>, Error> {
    if !MEMBER_ROLES.contains(&role) {
        // `{list(MEMBER_ROLES)}`
        let valid = MEMBER_ROLES.map(|r| format!("'{r}'")).join(", ");
        return Err(Error::Value(format!("Invalid role '{role}'. Valid roles: [{valid}]")));
    }
    let Some(member) = get_member(session, member_id).await?.filter(|m| m.project_id == project_id) else {
        return Ok(None);
    };
    let mut member = kb_db::edit(member);
    member.role = Set(role.to_string());
    let member = member.update(session).await?;
    session.commit().await?;
    Ok(Some(member))
}
