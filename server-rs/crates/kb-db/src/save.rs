//! Writing a loaded row back: only the columns that changed.
//!
//! SQLAlchemy keeps, for every loaded row, the values it read. At a flush it sends an `UPDATE` of the columns whose
//! value differs from what was read, and no statement at all when none does. Two writers of one row that change
//! different columns therefore both keep their change. The port has no unit of work, so the code keeps the row as
//! it was read and gives both to this module:
//!
//! - `save_model(conn, &before, after)` for a `Model` that was changed in memory;
//! - `edit(row)` where the code sets columns on an `ActiveModel`: an `Edit` is the active model together with the
//!   row as it was read, and its `update` drops every column that was set to the value it already had.
//!
//! Neither protects a read-modify-write of *one* column (a JSON list that is read, added to and written back):
//! SQLAlchemy does not either.

use std::future::Future;
use std::ops::{Deref, DerefMut};
use std::pin::Pin;

use sea_orm::{
    ActiveModelBehavior, ActiveModelTrait, ActiveValue, ConnectionTrait, DbErr, EntityTrait, IntoActiveModel, Iterable,
    ModelTrait,
};

/// What `save_model` and `Edit::update` give back: the write, kept on the heap. The rows of the app are wide (an
/// `ai_run` has some sixty columns), and a future that holds the row, its active model and SeaORM's own UPDATE inside
/// every caller's future made the deepest call chains (a run that restarts inside its own task) overflow a worker's
/// stack.
pub type Saving<'a, M> = Pin<Box<dyn Future<Output = Result<M, DbErr>> + Send + 'a>>;

/// `session.add(row)` of a row that was loaded and changed: an UPDATE of the columns that differ from `before`
/// (nothing is sent when none does). Returns the row as stored (`after` itself when nothing was sent).
pub fn save_model<'a, C, M>(conn: &'a C, before: &'a M, after: M) -> Saving<'a, M>
where
    C: ConnectionTrait,
    M: ModelTrait + IntoActiveModel<<M::Entity as EntityTrait>::ActiveModel> + Clone + Send + Sync + 'a,
    M::Entity: EntityTrait<Model = M>,
    <M::Entity as EntityTrait>::ActiveModel: ActiveModelBehavior + Send,
    <M::Entity as EntityTrait>::Column: Iterable,
{
    Box::pin(async move {
        let mut row = before.clone().into_active_model();
        for column in <<M::Entity as EntityTrait>::Column as Iterable>::iter() {
            let value = after.get(column);
            if value != before.get(column) {
                row.set(column, value);
            }
        }
        if !row.is_changed() {
            return Ok(after);
        }
        row.update(conn).await
    })
}

/// A loaded row being changed column by column: the active model (reached through `Deref`, so `row.name = Set(..)`
/// works as on the active model itself) and the row as it was read.
pub struct Edit<M>
where
    M: ModelTrait,
{
    before: M,
    row: <M::Entity as EntityTrait>::ActiveModel,
}

/// Start changing a loaded row (`row.into_active_model()`, remembering what was read).
pub fn edit<M>(row: M) -> Edit<M>
where
    M: ModelTrait + IntoActiveModel<<M::Entity as EntityTrait>::ActiveModel> + Clone,
{
    Edit { before: row.clone(), row: row.into_active_model() }
}

impl<M> Deref for Edit<M>
where
    M: ModelTrait,
{
    type Target = <M::Entity as EntityTrait>::ActiveModel;

    fn deref(&self) -> &Self::Target {
        &self.row
    }
}

impl<M> DerefMut for Edit<M>
where
    M: ModelTrait,
{
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.row
    }
}

impl<M> Edit<M>
where
    M: ModelTrait + IntoActiveModel<<M::Entity as EntityTrait>::ActiveModel> + Clone + Send + Sync,
    M::Entity: EntityTrait<Model = M>,
    <M::Entity as EntityTrait>::ActiveModel: ActiveModelBehavior + Send,
    <M::Entity as EntityTrait>::Column: Iterable,
{
    /// The row as it was read.
    pub fn before(&self) -> &M {
        &self.before
    }

    /// Whether a column was set to a value other than the one that was read.
    pub fn is_changed(&self) -> bool {
        <<M::Entity as EntityTrait>::Column as Iterable>::iter()
            .any(|column| matches!(self.row.get(column), ActiveValue::Set(value) if value != self.before.get(column)))
    }

    /// The UPDATE of the columns that were set to a value other than the one that was read (nothing is sent when
    /// there is none). Returns the row as stored; when nothing was sent, the row as it was read.
    pub fn update<'a, C>(self, conn: &'a C) -> Saving<'a, M>
    where
        C: ConnectionTrait,
        M: 'a,
    {
        Box::pin(async move {
            let mut row = self.before.clone().into_active_model();
            for column in <<M::Entity as EntityTrait>::Column as Iterable>::iter() {
                if let ActiveValue::Set(value) = self.row.get(column) {
                    if value != self.before.get(column) {
                        row.set(column, value);
                    }
                }
            }
            if !row.is_changed() {
                return Ok(self.before);
            }
            row.update(conn).await
        })
    }
}
