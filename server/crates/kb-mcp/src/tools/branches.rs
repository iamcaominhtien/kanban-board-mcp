//! The ticket branch tool.

use serde_json::{Map, Value};

use super::routing::{Op, dispatch, params_of};
use crate::common::{ToolResult, arg_bool, arg_int, arg_str, arg_text};
use crate::operations as ops;

/// `BRANCH_OPS`: what each action runs and takes.
pub const BRANCH_OPS: &[(&str, Op)] = &[
    (
        "add",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (branch_from, status) = (arg_str(&a, "branch_from"), arg_str(&a, "status"));
                    let (pr_url, commit_hash) = (arg_str(&a, "pr_url"), arg_str(&a, "commit_hash"));
                    let (linked, worktree_path) = (arg_str(&a, "linked_ticket_id"), arg_str(&a, "worktree_path"));
                    ops::add_branch(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "name"),
                        branch_from.as_deref().unwrap_or("main"),
                        status.as_deref().unwrap_or("open"),
                        pr_url.as_deref(),
                        commit_hash.as_deref(),
                        linked.as_deref(),
                        arg_int(&a, "ahead_count").unwrap_or(0),
                        arg_int(&a, "behind_count").unwrap_or(0),
                        arg_bool(&a, "create_worktree").unwrap_or(false),
                        worktree_path.as_deref(),
                        arg_bool(&a, "adopt").unwrap_or(false),
                    )
                    .await
                })
            },
            &["ticket_id", "name"],
            &[
                "branch_from",
                "status",
                "pr_url",
                "commit_hash",
                "linked_ticket_id",
                "ahead_count",
                "behind_count",
                "create_worktree",
                "worktree_path",
                "adopt",
            ],
        ),
    ),
    (
        "update",
        Op::new(
            |a| {
                Box::pin(async move {
                    let (name, status, branch_from) =
                        (arg_str(&a, "name"), arg_str(&a, "status"), arg_str(&a, "branch_from"));
                    let (pr_url, commit_hash) = (arg_str(&a, "pr_url"), arg_str(&a, "commit_hash"));
                    let linked = arg_str(&a, "linked_ticket_id");
                    ops::update_branch(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "branch_id"),
                        name.as_deref(),
                        status.as_deref(),
                        branch_from.as_deref(),
                        pr_url.as_deref(),
                        commit_hash.as_deref(),
                        linked.as_deref(),
                        arg_int(&a, "ahead_count"),
                        arg_int(&a, "behind_count"),
                    )
                    .await
                })
            },
            &["ticket_id", "branch"],
            &[
                "name",
                "status",
                "branch_from",
                "pr_url",
                "commit_hash",
                "linked_ticket_id",
                "ahead_count",
                "behind_count",
            ],
        )
        .rename(&[("branch", "branch_id")]),
    ),
    (
        "delete",
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::delete_branch(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "branch_id"),
                        arg_bool(&a, "remove_worktree").unwrap_or(false),
                        arg_bool(&a, "delete_git_branch").unwrap_or(false),
                        arg_bool(&a, "force").unwrap_or(false),
                    )
                    .await
                })
            },
            &["ticket_id", "branch"],
            &["remove_worktree", "delete_git_branch", "force"],
        )
        .rename(&[("branch", "branch_id")]),
    ),
    (
        "checkout",
        Op::new(
            |a| {
                Box::pin(
                    async move { ops::checkout_branch(&arg_text(&a, "ticket_id"), &arg_text(&a, "branch_id")).await },
                )
            },
            &["ticket_id", "branch"],
            &[],
        )
        .rename(&[("branch", "branch_id")]),
    ),
];

/// Branches of a ticket. If the project (update via manage_project's repo_path) or the ticket has a linked git repo,
/// the real git branch is created / renamed / deleted and commit, ahead and behind come from git; otherwise only the
/// board record changes. Returns the updated ticket (without its activity log). `action`: add, update, delete,
/// checkout.
pub async fn ticket_branches(args: Map<String, Value>) -> ToolResult {
    let action = arg_text(&args, "action");
    dispatch("ticket_branches", BRANCH_OPS, &action, params_of(args)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::snapshot;

    fn schema() -> &'static Value {
        let entry = snapshot(false).iter().find(|e| e["name"] == "ticket_branches").expect("ticket_branches");
        &entry["inputSchema"]
    }

    /// `test_every_table_entry_names_real_parameters`: a typo in a table would only show when that action is used;
    /// check them all once.
    #[test]
    fn every_table_entry_names_real_parameters() {
        let properties = schema()["properties"].as_object().expect("properties");
        for (action, op) in BRANCH_OPS {
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
        let actions: Vec<&str> = BRANCH_OPS.iter().map(|(action, _)| *action).collect();
        let listed: Vec<&str> = schema()["properties"]["action"]["enum"]
            .as_array()
            .expect("enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(actions, listed);
    }
}
