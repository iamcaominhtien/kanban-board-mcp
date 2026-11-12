//! The operations behind the MCP tools: one function per verb, each doing exactly one thing.
//!
//! The tools in `crate::tools` route to these (the Idea Space ones are registered as tools one to one).

pub mod branches;
pub mod checklists;
pub mod comments;
pub mod docs;
pub mod ideas;
pub mod members;
pub mod projects;
pub mod relations;
pub mod test_cases;
pub mod tickets;
pub mod work_log;

pub use branches::{add_branch, checkout_branch, delete_branch, update_branch};
pub use checklists::{
    add_acceptance_criterion, add_sub_task, delete_acceptance_criterion, delete_sub_task, toggle_acceptance_criterion,
    toggle_sub_task,
};
pub use comments::{add_comment, attach_file, delete_comment, list_comments, restore_comment, update_comment};
pub use docs::{link_ticket_doc, unlink_ticket_doc};
pub use ideas::{
    create_idea_ticket, get_idea_activity_trail, get_idea_ticket, list_idea_assumptions, list_idea_tickets,
};
pub use members::{add_member, list_members, remove_member};
pub use projects::{create_project, list_projects, update_project};
pub use relations::{block_ticket, link_tickets, unblock_ticket, unlink_tickets};
pub use test_cases::{add_test_case, delete_test_case, update_test_case};
pub use tickets::{
    DEFAULT_ACTIVITY_ENTRIES, create_child_ticket, create_ticket, delete_ticket, get_ticket, get_ticket_workspace_path,
    list_tickets, reopen_ticket, resume_ticket, set_ticket_pending, update_ticket, update_ticket_status,
};
pub use work_log::{add_work_log, delete_work_log, update_work_log};
