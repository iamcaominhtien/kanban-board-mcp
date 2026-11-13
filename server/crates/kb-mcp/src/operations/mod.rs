//! The operations behind the MCP tools: one function per verb, each doing exactly one thing.
//!
//! The tools in `crate::tools` route to these (the Idea Space ones are registered as tools one to one).

pub mod branches;
pub mod canvases;
pub mod checklists;
pub mod comments;
pub mod diagrams;
pub mod docs;
pub mod ideas;
pub mod members;
pub mod memory;
pub mod pictures;
pub mod projects;
pub mod relations;
pub mod sketches;
pub mod test_cases;
pub mod tickets;
pub mod work_log;

pub use branches::{add_branch, checkout_branch, delete_branch, update_branch};
pub use canvases::{
    comment_on_canvas, create_canvas_from_files, design_guide, diagram_guide, docs_guide, list_project_canvases,
    read_canvas, role_guide, shared_guides, ticket_guide, update_canvas_frame,
};
pub use checklists::{
    add_acceptance_criterion, add_sub_task, delete_acceptance_criterion, delete_sub_task, toggle_acceptance_criterion,
    toggle_sub_task,
};
pub use comments::{add_comment, attach_file, delete_comment, list_comments, restore_comment, update_comment};
pub use diagrams::{
    create_diagram_from_file, delete_diagram, export_diagram, list_project_diagrams, restore_diagram, save_diagram_file,
};
pub use docs::{
    add_docs_comment, create_docs_page, delete_docs_comment, delete_docs_page, duplicate_docs_page, edit_docs_comment,
    get_docs_page, get_docs_version, import_docs, link_ticket_doc, list_docs_comments, list_docs_pages,
    list_docs_recycle_bin, list_docs_versions, move_docs_page, reopen_docs_comment, reply_docs_comment,
    resolve_docs_comment, resolve_docs_links, restore_docs_page, restore_docs_version, search_docs, unlink_ticket_doc,
    update_docs_page, upload_file,
};
pub use ideas::{
    create_idea_ticket, get_idea_activity_trail, get_idea_ticket, list_idea_assumptions, list_idea_tickets,
};
pub use members::{add_member, list_members, remove_member};
pub use memory::memory_action;
pub use pictures::picture;
pub use projects::{create_project, list_projects, update_project};
pub use relations::{block_ticket, link_tickets, unblock_ticket, unlink_tickets};
pub use sketches::{create_sketch_from_files, export_sketch, list_project_sketches, save_sketch_files};
pub use test_cases::{add_test_case, delete_test_case, update_test_case};
pub use tickets::{
    DEFAULT_ACTIVITY_ENTRIES, create_child_ticket, create_ticket, delete_ticket, get_ticket, get_ticket_workspace_path,
    list_tickets, reopen_ticket, resume_ticket, set_ticket_pending, update_ticket, update_ticket_status,
};
pub use work_log::{add_work_log, delete_work_log, update_work_log};
