//! The ticket tools: list and read tickets, and create, change, relate and delete them.

use serde_json::{Map, Value};

use super::checked_read;
use super::routing::{Op, dispatch, params_of};
use crate::common::{ToolResult, arg_bool, arg_f64, arg_int, arg_list, arg_str, arg_strings, arg_text};
use crate::operations as ops;
use crate::operations::tickets::{CreateTicket, GetTicket, ListTickets};

/// List a project's tickets as compact summaries (id, title, type, status, priority, assignee, parent_id, tags,
/// estimate, dates, blocked_by, and counts of acceptance criteria / test cases / comments / branches).
/// Call get_ticket for the description, comments, work log and the rest.
/// Returns {total, count, offset, has_more, tickets}: when has_more is true, call again with offset=offset+count.
pub async fn list_tickets(args: Map<String, Value>) -> ToolResult {
    checked_read("list_tickets", args, |a| {
        Box::pin(async move {
            let project_id = arg_text(&a, "project_id");
            let (status, priority, q) = (arg_str(&a, "status"), arg_str(&a, "priority"), arg_str(&a, "q"));
            let (kind, parent_id) = (arg_str(&a, "type"), arg_str(&a, "parent_id"));
            ops::list_tickets(ListTickets {
                project_id: &project_id,
                status: status.as_deref(),
                priority: priority.as_deref(),
                q: q.as_deref(),
                include_wont_do: arg_bool(&a, "include_wont_do").unwrap_or(true),
                pending: arg_bool(&a, "pending"),
                reopened: arg_bool(&a, "reopened"),
                r#type: kind.as_deref(),
                parent_id: parent_id.as_deref(),
                detail: arg_bool(&a, "detail").unwrap_or(false),
                limit: arg_int(&a, "limit").unwrap_or(100).max(0) as usize,
                offset: arg_int(&a, "offset").unwrap_or(0).max(0) as usize,
            })
            .await
        })
    })
    .await
}

/// Get one ticket in full: Markdown description, acceptance criteria, test cases, comments, work log (debug notes),
/// branches, relations (blocks / blocked_by / links). `view='comments'`: just the comment thread.
pub async fn get_ticket(args: Map<String, Value>) -> ToolResult {
    checked_read("get_ticket", args, |a| {
        Box::pin(async move {
            let ticket_id = arg_text(&a, "ticket_id");
            let view = arg_str(&a, "view").unwrap_or_else(|| "full".to_string());
            let since = arg_str(&a, "activity_since");
            ops::get_ticket(GetTicket {
                ticket_id: &ticket_id,
                view: &view,
                activity_limit: arg_int(&a, "activity_limit"),
                activity_since: since.as_deref(),
                comment_ids: arg_strings(&a, "comment_ids"),
            })
            .await
        })
    })
    .await
}

/// The fields of a ticket the create and update actions take (`_TICKET_FIELDS`).
const TICKET_FIELDS: [&str; 11] = [
    "title",
    "description",
    "type",
    "priority",
    "status",
    "estimate",
    "due_date",
    "start_date",
    "parent_id",
    "tags",
    "assignee",
];

/// The parameters of `create_ticket` as Pydantic's `validate_call` reads them: the starting column is one of the
/// board's, not 'wont_do'.
const CREATE_PARAMS: &str = r#"{"properties": {
    "project_id": {"type": "string"},
    "title": {"type": "string"},
    "type": {"default": "task", "enum": ["bug", "feature", "task", "chore", "story"], "type": "string"},
    "priority": {"default": "medium", "enum": ["low", "medium", "high", "critical"], "type": "string"},
    "status": {"default": "backlog", "enum": ["backlog", "todo", "in-progress", "review", "testing", "done"], "type": "string"},
    "description": {"default": "", "type": "string"},
    "parent_id": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null},
    "estimate": {"anyOf": [{"type": "number"}, {"type": "null"}], "default": null},
    "due_date": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null},
    "tags": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null},
    "start_date": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null},
    "assignee": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null},
    "acceptance_criteria": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null}
  }, "required": ["project_id", "title"]}"#;

/// `TicketAction`: what each action runs and takes (`TICKET_OPS`).
pub const TICKET_OPS: &[(&str, Op)] = &[
    (
        "create",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (project_id, title) = (arg_text(&a, "project_id"), arg_text(&a, "title"));
                    let (kind, priority, status) = (arg_str(&a, "type"), arg_str(&a, "priority"), arg_str(&a, "status"));
                    let description = arg_str(&a, "description");
                    let (parent_id, due_date) = (arg_str(&a, "parent_id"), arg_str(&a, "due_date"));
                    let (start_date, assignee) = (arg_str(&a, "start_date"), arg_str(&a, "assignee"));
                    ops::create_ticket(CreateTicket {
                        project_id: &project_id,
                        title: &title,
                        r#type: kind.as_deref().unwrap_or("task"),
                        priority: priority.as_deref().unwrap_or("medium"),
                        status: status.as_deref().unwrap_or("backlog"),
                        description: description.as_deref().unwrap_or_default(),
                        parent_id: parent_id.as_deref(),
                        estimate: arg_f64(&a, "estimate"),
                        due_date: due_date.as_deref(),
                        tags: arg_list(&a, "tags"),
                        start_date: start_date.as_deref(),
                        assignee: assignee.as_deref(),
                        acceptance_criteria: arg_strings(&a, "acceptance_criteria"),
                    })
                    .await
                })
            },
            &["project_id", "title"],
            &[
                "description",
                "type",
                "priority",
                "status",
                "estimate",
                "due_date",
                "start_date",
                "parent_id",
                "tags",
                "assignee",
                "acceptance_criteria",
            ],
        )
        .params(CREATE_PARAMS),
    ),
    (
        "update",
        Op::new(
            |a| {
                Box::pin(async move {
                    // the `fields` of `update_ticket`, in its order
                    let mut fields = Map::new();
                    for name in TICKET_FIELDS
                        .iter()
                        .chain(&[
                            "repo_path",
                            "wont_do_reason",
                            "block_done_if_acs_incomplete",
                            "block_done_if_tcs_incomplete",
                            "wave_pin",
                            "review_requested_from",
                        ])
                    {
                        if let Some(value) = a.get(*name) {
                            fields.insert(name.to_string(), value.clone());
                        }
                    }
                    ops::update_ticket(&arg_text(&a, "ticket_id"), fields, arg_strings(&a, "clear_fields")).await
                })
            },
            &["ticket_id"],
            &[
                "title",
                "description",
                "type",
                "priority",
                "status",
                "estimate",
                "due_date",
                "start_date",
                "parent_id",
                "tags",
                "assignee",
                "repo_path",
                "wont_do_reason",
                "block_done_if_acs_incomplete",
                "block_done_if_tcs_incomplete",
                "wave_pin",
                "review_requested_from",
                "clear_fields",
            ],
        ),
    ),
    ("delete", Op::new(|a| Box::pin(async move { ops::delete_ticket(&arg_text(&a, "ticket_id")).await }), &["ticket_id"], &[])),
    (
        "reopen",
        Op::new(
            |a| {
                Box::pin(async move {
                    let reason = arg_str(&a, "reason");
                    ops::reopen_ticket(
                        &arg_text(&a, "ticket_id"),
                        reason.as_deref(),
                        arg_bool(&a, "reset_ac").unwrap_or(false),
                        arg_bool(&a, "reset_tests").unwrap_or(false),
                        arg_bool(&a, "unassign").unwrap_or(false),
                        arg_bool(&a, "reopen_parent").unwrap_or(false),
                    )
                    .await
                })
            },
            &["ticket_id"],
            &["reason", "reset_ac", "reset_tests", "unassign", "reopen_parent"],
        ),
    ),
    (
        "pend",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (target, member_id) = (arg_str(&a, "target_ticket_id"), arg_str(&a, "member_id"));
                    let (party, note) = (arg_str(&a, "party"), arg_str(&a, "note"));
                    ops::set_ticket_pending(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "reason_type"),
                        target.as_deref(),
                        member_id.as_deref(),
                        party.as_deref(),
                        note.as_deref(),
                        arg_bool(&a, "add_blocked_by").unwrap_or(false),
                    )
                    .await
                })
            },
            &["ticket_id", "reason_type"],
            &["target_id", "member_id", "party", "note", "add_blocked_by"],
        )
        .rename(&[("target_id", "target_ticket_id")]),
    ),
    (
        "resume",
        Op::new(
            |a| {
                Box::pin(async move {
                    let reason = arg_str(&a, "reason");
                    ops::resume_ticket(
                        &arg_text(&a, "ticket_id"),
                        reason.as_deref(),
                        arg_bool(&a, "add_comment").unwrap_or(false),
                    )
                    .await
                })
            },
            &["ticket_id"],
            &["reason", "add_comment"],
        ),
    ),
    (
        "workspace",
        Op::new(
            |a| Box::pin(async move { ops::get_ticket_workspace_path(&arg_text(&a, "ticket_id")).await }),
            &["ticket_id"],
            &[],
        ),
    ),
    (
        "block",
        Op::new(
            |a| {
                Box::pin(
                    async move { ops::block_ticket(&arg_text(&a, "blocker_id"), &arg_text(&a, "blocked_id")).await },
                )
            },
            &["ticket_id", "target_id"],
            &[],
        )
        .rename(&[("ticket_id", "blocked_id"), ("target_id", "blocker_id")]),
    ),
    (
        "unblock",
        Op::new(
            |a| {
                Box::pin(
                    async move { ops::unblock_ticket(&arg_text(&a, "blocker_id"), &arg_text(&a, "blocked_id")).await },
                )
            },
            &["ticket_id", "target_id"],
            &[],
        )
        .rename(&[("ticket_id", "blocked_id"), ("target_id", "blocker_id")]),
    ),
    (
        "link",
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::link_tickets(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "target_id"),
                        &arg_text(&a, "relation_type"),
                    )
                    .await
                })
            },
            &["ticket_id", "target_id", "relation_type"],
            &[],
        ),
    ),
    (
        "unlink",
        Op::new(
            |a| Box::pin(async move { ops::unlink_tickets(&arg_text(&a, "ticket_id"), &arg_text(&a, "link_id")).await }),
            &["ticket_id", "link_id"],
            &[],
        ),
    ),
    (
        "link_doc",
        Op::new(
            |a| {
                Box::pin(async move { ops::link_ticket_doc(&arg_text(&a, "ticket_id"), &arg_text(&a, "page_id")).await })
            },
            &["ticket_id", "page_id"],
            &[],
        ),
    ),
    (
        "unlink_doc",
        Op::new(
            |a| {
                Box::pin(
                    async move { ops::unlink_ticket_doc(&arg_text(&a, "ticket_id"), &arg_text(&a, "page_id")).await },
                )
            },
            &["ticket_id", "page_id"],
            &[],
        ),
    ),
];

/// Create, change, relate or delete a ticket (a ticket's checklists, comments, work log and branches have their own
/// tools). `action`: create, update, delete, reopen, pend, resume, workspace, block, unblock, link, unlink,
/// link_doc, unlink_doc (the tool's description says what each takes).
pub async fn manage_ticket(args: Map<String, Value>) -> ToolResult {
    let action = arg_text(&args, "action");
    dispatch("manage_ticket", TICKET_OPS, &action, params_of(args)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::snapshot;

    fn schema() -> &'static Value {
        let entry = snapshot(false).iter().find(|e| e["name"] == "manage_ticket").expect("manage_ticket");
        &entry["inputSchema"]
    }

    /// `test_every_table_entry_names_real_parameters`: a typo in a table would only show when that action is used;
    /// check them all once.
    #[test]
    fn every_table_entry_names_real_parameters() {
        let properties = schema()["properties"].as_object().expect("properties");
        for (action, op) in TICKET_OPS {
            for name in op.required.iter().chain(op.optional) {
                assert!(properties.contains_key(*name), "{action}: {name}");
                assert!(!["action", "item"].contains(name), "{action}: {name} is a selector");
            }
            assert!(!op.required.iter().any(|name| op.optional.contains(name)), "{action}");
        }
    }

    /// Every action of the schema is a real choice, and the other way round, in the schema's order.
    #[test]
    fn the_actions_are_those_of_the_schema() {
        let actions: Vec<&str> = TICKET_OPS.iter().map(|(action, _)| *action).collect();
        let listed: Vec<&str> = schema()["properties"]["action"]["enum"]
            .as_array()
            .expect("enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(actions, listed);
    }
}
