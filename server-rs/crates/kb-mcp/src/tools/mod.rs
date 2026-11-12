//! The 13 tools the agent sees (12, plus ai_run for runs the board started). Each is a family of related operations
//! picked with `action`.
//!
//! Why so few: an agent pays for every tool description and schema on every session. Grouping by noun keeps all the
//! capabilities while the tool list shrinks to a fraction of its size. The operations themselves live in
//! `crate::operations` (one function per verb); a tool only routes `action` (and `item` for ticket sub-items) to one
//! of them. Annotations are per tool (they are in the snapshot the list is served from), so a tool that can delete
//! is marked destructive as a whole.
//!
//! # Adding a tool
//!
//! 1. Port its operations to `operations/<area>.rs` (one function per verb, the Python signature; wrap a changing
//!    one in `common::notify_on_success`), as `operations/projects.rs` and `operations/members.rs`.
//! 2. Port the tool function to `tools/<area>.rs`: `async fn <tool>(args: Map<String, Value>) -> ToolResult` with
//!    its table of `Op`s routed by `routing::dispatch`, as `tools/projects.rs`. The arguments arrive validated
//!    against the tool's input schema, every parameter present (its default when left out).
//! 3. Add `tool!(<name>, <area>::<function>)` to the table below, at the tool's place in the Python table, and
//!    remove its name from `registry::NOT_PORTED_YET` (a unit test of the registry fails until both are done).
//! 4. Add its calls to a differential test like `tests/mcp_tool_calls.rs` and record what Python answers.

pub mod branches;
pub mod ideas;
pub mod items;
pub mod projects;
pub mod routing;
pub mod tickets;

use serde_json::{Map, Value};

use crate::common::{self, ToolResult};
use crate::registry::{Tool, ToolFn};

/// A table entry: the tool's name and its async function as a `ToolFn`.
macro_rules! tool {
    ($name:ident, $function:path) => {
        Tool { name: stringify!($name), run: |args| Box::pin($function(args)) }
    };
}

/// A read tool that honours the "Read tickets" permission of an AI run (the guard checks it): `_checked_read(fn)`.
/// A read tool's function calls this with its own name and body.
pub async fn checked_read(name: &'static str, args: Map<String, Value>, run: ToolFn) -> ToolResult {
    let given = args.clone();
    // `lambda _g: fn(*args, **kwargs)`: the guard never changes what a read is given
    common::guarded(name, "read", given, Box::new(move |_g| run(args))).await
}

/// The tools of the server, in the order the Python server registers them (the order of `tools/list`). The ones
/// that are not ported yet are named in `registry::NOT_PORTED_YET`.
pub const CORE_TOOL_TABLE: &[Tool] = &[
    tool!(get_projects, projects::get_projects),
    tool!(list_tickets, tickets::list_tickets),
    tool!(get_ticket, tickets::get_ticket),
    // docs_read
    tool!(manage_project, projects::manage_project), // remove_member
    tool!(manage_ticket, tickets::manage_ticket),    // delete, unlink
    tool!(ticket_items, items::ticket_items),        // delete
    tool!(ticket_branches, branches::ticket_branches), // delete (optionally the git branch)
    // docs_write (delete), ai_schedules (delete),
    // knowledge: the knowledge base (table of contents, search, read) and the project memory,
    // board_wait: wait until the board moves (the notification log),
    // ai_run: only inside a run the board started: ask a person, message a ticket's team, report
];

/// The Idea Space tools are hidden from the MCP tool list for now (about a quarter of its size). They are fully
/// implemented in Python: set KANBAN_MCP_IDEA_TOOLS=1 to expose them. AI members may only read ideas and add to the
/// Inbox: moving, editing, merging, archiving and promoting are for people, in the app.
pub const IDEA_TOOL_TABLE: &[Tool] = &[
    tool!(list_idea_tickets, ideas::list_idea_tickets),
    tool!(get_idea_ticket, ideas::get_idea_ticket),
    tool!(list_idea_assumptions, ideas::list_idea_assumptions),
    tool!(get_idea_activity_trail, ideas::get_idea_activity_trail),
    tool!(create_idea_ticket, ideas::create_idea_ticket),
];
