//! The tool for the lists inside a ticket: comments, work log, acceptance criteria, sub-tasks, test cases.

use futures::future::BoxFuture;
use serde_json::{Map, Value};

use super::routing::{Op, batch, params_of, route};
use crate::common::{self, ToolError, ToolResult, arg_bool, arg_str, arg_text};
use crate::operations as ops;

/// The parameters of `add_work_log` as Pydantic's `validate_call` reads them: the role is one of the board's, where
/// the tool takes any text (a comment's role is free).
const WORK_LOG_ADD_PARAMS: &str = r#"{"properties": {
    "ticket_id": {"type": "string"},
    "author": {"type": "string"},
    "role": {"enum": ["PM", "Developer", "BA", "Tester", "Designer", "Other"], "type": "string"},
    "note": {"type": "string"},
    "kind": {"default": "investigation", "enum": ["investigation", "fix_attempt", "root_cause", "blocked", "resolved"], "type": "string"},
    "pinned": {"default": false, "type": "boolean"},
    "linked_branch": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null},
    "linked_test_case": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}
  }, "required": ["ticket_id", "author", "role", "note"]}"#;

/// `_TEST_CASE_FIELDS`.
const TEST_CASE_FIELDS: [&str; 6] = ["status", "description", "expected_result", "notes", "proof", "assignee"];

/// `ITEM_OPS`: what each (item, action) runs and takes, in the order of the Python table (the "Valid actions for"
/// message lists them in it).
pub const ITEM_OPS: &[((&str, &str), Op)] = &[
    (
        ("comment", "add"),
        Op::new(
            |a| {
                Box::pin(async move {
                    let role = arg_str(&a, "role");
                    ops::add_comment(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "text"),
                        &arg_text(&a, "author"),
                        role.as_deref(),
                    )
                    .await
                })
            },
            &["ticket_id", "text", "author"],
            &["role"],
        ),
    ),
    (
        ("attachment", "add"),
        Op::new(
            |a| {
                Box::pin(async move {
                    let (author, text) = (arg_str(&a, "author"), arg_str(&a, "text"));
                    ops::attach_file(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "path"),
                        author.as_deref().unwrap_or("Claude"),
                        text.as_deref(),
                        arg_bool(&a, "post").unwrap_or(true),
                    )
                    .await
                })
            },
            &["ticket_id", "path"],
            &["author", "text", "post"],
        ),
    ),
    (
        ("comment", "update"),
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::update_comment(&arg_text(&a, "ticket_id"), &arg_text(&a, "comment_id"), &arg_text(&a, "text"))
                        .await
                })
            },
            &["ticket_id", "item_id", "text"],
            &[],
        )
        .rename(&[("item_id", "comment_id")]),
    ),
    (
        ("comment", "delete"),
        Op::new(
            |a| Box::pin(async move { ops::delete_comment(&arg_text(&a, "ticket_id"), &arg_text(&a, "comment_id")).await }),
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "comment_id")]),
    ),
    (
        ("comment", "restore"),
        Op::new(
            |a| {
                Box::pin(async move { ops::restore_comment(&arg_text(&a, "ticket_id"), &arg_text(&a, "comment_id")).await })
            },
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "comment_id")]),
    ),
    (
        ("work_log", "add"),
        Op::new(
            |a| {
                Box::pin(async move {
                    let (kind, branch, test_case) =
                        (arg_str(&a, "kind"), arg_str(&a, "linked_branch"), arg_str(&a, "linked_test_case"));
                    ops::add_work_log(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "author"),
                        &arg_text(&a, "role"),
                        &arg_text(&a, "note"),
                        kind.as_deref().unwrap_or("investigation"),
                        arg_bool(&a, "pinned").unwrap_or(false),
                        branch.as_deref(),
                        test_case.as_deref(),
                    )
                    .await
                })
            },
            &["ticket_id", "author", "role", "note"],
            &["log_kind", "pinned", "linked_branch", "linked_test_case"],
        )
        .rename(&[("log_kind", "kind")])
        .params(WORK_LOG_ADD_PARAMS),
    ),
    (
        ("work_log", "update"),
        Op::new(
            |a| {
                Box::pin(async move {
                    let (note, kind) = (arg_str(&a, "note"), arg_str(&a, "kind"));
                    let (branch, test_case) = (arg_str(&a, "linked_branch"), arg_str(&a, "linked_test_case"));
                    ops::update_work_log(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "log_id"),
                        note.as_deref(),
                        kind.as_deref(),
                        arg_bool(&a, "pinned"),
                        branch.as_deref(),
                        test_case.as_deref(),
                    )
                    .await
                })
            },
            &["ticket_id", "item_id"],
            &["note", "log_kind", "pinned", "linked_branch", "linked_test_case"],
        )
        .rename(&[("item_id", "log_id"), ("log_kind", "kind")]),
    ),
    (
        ("work_log", "delete"),
        Op::new(
            |a| Box::pin(async move { ops::delete_work_log(&arg_text(&a, "ticket_id"), &arg_text(&a, "log_id")).await }),
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "log_id")]),
    ),
    (
        ("criterion", "add"),
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::add_acceptance_criterion(&arg_text(&a, "ticket_id"), &arg_text(&a, "description")).await
                })
            },
            &["ticket_id", "text"],
            &[],
        )
        .rename(&[("text", "description")]),
    ),
    (
        ("criterion", "toggle"),
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::toggle_acceptance_criterion(&arg_text(&a, "ticket_id"), &arg_text(&a, "criterion_id")).await
                })
            },
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "criterion_id")]),
    ),
    (
        ("criterion", "delete"),
        Op::new(
            |a| {
                Box::pin(async move {
                    ops::delete_acceptance_criterion(&arg_text(&a, "ticket_id"), &arg_text(&a, "criterion_id")).await
                })
            },
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "criterion_id")]),
    ),
    (
        ("sub_task", "add"),
        Op::new(
            |a| Box::pin(async move { ops::add_sub_task(&arg_text(&a, "ticket_id"), &arg_text(&a, "text")).await }),
            &["ticket_id", "text"],
            &[],
        ),
    ),
    (
        ("sub_task", "toggle"),
        Op::new(
            |a| {
                Box::pin(async move { ops::toggle_sub_task(&arg_text(&a, "ticket_id"), &arg_text(&a, "sub_task_id")).await })
            },
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "sub_task_id")]),
    ),
    (
        ("sub_task", "delete"),
        Op::new(
            |a| {
                Box::pin(async move { ops::delete_sub_task(&arg_text(&a, "ticket_id"), &arg_text(&a, "sub_task_id")).await })
            },
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "sub_task_id")]),
    ),
    (
        ("test_case", "add"),
        Op::new(
            |a| {
                Box::pin(async move {
                    let status = arg_str(&a, "status");
                    let (description, expected) = (arg_str(&a, "description"), arg_str(&a, "expected_result"));
                    let (notes, proof, assignee) =
                        (arg_str(&a, "notes"), arg_str(&a, "proof"), arg_str(&a, "assignee"));
                    ops::add_test_case(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "title"),
                        status.as_deref().unwrap_or("pending"),
                        description.as_deref(),
                        expected.as_deref(),
                        notes.as_deref(),
                        proof.as_deref(),
                        None,
                        assignee.as_deref(),
                    )
                    .await
                })
            },
            &["ticket_id", "title"],
            &TEST_CASE_FIELDS,
        ),
    ),
    (
        ("test_case", "update"),
        Op::new(
            |a| {
                Box::pin(async move {
                    let (title, status) = (arg_str(&a, "title"), arg_str(&a, "status"));
                    let (description, expected) = (arg_str(&a, "description"), arg_str(&a, "expected_result"));
                    let (notes, proof, assignee) =
                        (arg_str(&a, "notes"), arg_str(&a, "proof"), arg_str(&a, "assignee"));
                    ops::update_test_case(
                        &arg_text(&a, "ticket_id"),
                        &arg_text(&a, "test_case_id"),
                        title.as_deref(),
                        status.as_deref(),
                        description.as_deref(),
                        expected.as_deref(),
                        notes.as_deref(),
                        proof.as_deref(),
                        None,
                        assignee.as_deref(),
                    )
                    .await
                })
            },
            &["ticket_id", "item_id"],
            &["title", "status", "description", "expected_result", "notes", "proof", "assignee"],
        )
        .rename(&[("item_id", "test_case_id")]),
    ),
    (
        ("test_case", "delete"),
        Op::new(
            |a| {
                Box::pin(async move { ops::delete_test_case(&arg_text(&a, "ticket_id"), &arg_text(&a, "test_case_id")).await })
            },
            &["ticket_id", "item_id"],
            &[],
        )
        .rename(&[("item_id", "test_case_id")]),
    ),
];

/// `_item_op`: the operation of an (item, action), or the refusal that lists the actions the item has.
fn item_op(item: &str, action: &str) -> Result<Op, ToolError> {
    match ITEM_OPS.iter().find(|((i, a), _)| *i == item && *a == action) {
        Some((_, op)) => Ok(*op),
        None => {
            let valid: Vec<&str> = ITEM_OPS.iter().filter(|((i, _), _)| *i == item).map(|((_, a), _)| *a).collect();
            Err(ToolError::Value(format!(
                "ticket_items: a {item} cannot be '{action}'. Valid actions for {item}: {}.",
                valid.join(", ")
            )))
        }
    }
}

/// One call: checked by the AI guard when an AI run makes it, then routed to its operation.
async fn run_one(item: String, action: String, given: Map<String, Value>) -> ToolResult {
    let op = item_op(&item, &action)?;
    let label = format!("ticket_items(item='{item}', action='{action}')");
    let call = move |g: Map<String, Value>| -> BoxFuture<'static, ToolResult> {
        Box::pin(async move { route(&label, &op, g).await })
    };
    common::guarded("ticket_items", &format!("{item}.{action}"), given, Box::new(call)).await
}

/// Work on the lists inside a ticket. Pick `item`, then `action`; each combination takes only the parameters shown.
/// Returns the updated ticket (without its activity log); new sub-item ids are in its lists. `items` runs many
/// calls in one (max 25).
pub async fn ticket_items(args: Map<String, Value>) -> ToolResult {
    let item = arg_text(&args, "item");
    let action = arg_str(&args, "action").filter(|a| !a.is_empty());
    let outer_item_id = args.get("item_id").is_some_and(kb_base::pyjson::truthy);
    let mut given = params_of(args);
    let many = given.shift_remove("items").filter(|many| !many.is_null());

    // AIs often leave `action` out of a work_log note (`ticket_items(item='work_log', note=...)`); that was refused
    let act = move |extra: &Map<String, Value>| -> String {
        match &action {
            Some(action) => action.clone(),
            None => {
                let given_id = extra.get("item_id").is_some_and(kb_base::pyjson::truthy) || outer_item_id;
                (if given_id { "update" } else { "add" }).to_string()
            }
        }
    };

    if let Some(many) = many {
        let base = given.clone();
        let (item, act) = (item.clone(), act.clone());
        return batch(
            move |extra| {
                let mut merged = base.clone();
                merged.extend(extra.clone());
                Box::pin(run_one(item.clone(), act(&extra), merged))
            },
            &many,
            false,
        )
        .await;
    }
    let action = act(&Map::new());
    run_one(item, action, given).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::snapshot;

    fn schema() -> &'static Value {
        let entry = snapshot(false).iter().find(|e| e["name"] == "ticket_items").expect("ticket_items");
        &entry["inputSchema"]
    }

    /// `test_every_table_entry_names_real_parameters`: a typo in a table would only show when that action is used;
    /// check them all once.
    #[test]
    fn every_table_entry_names_real_parameters() {
        let properties = schema()["properties"].as_object().expect("properties");
        for ((item, action), op) in ITEM_OPS {
            for name in op.required.iter().chain(op.optional) {
                assert!(properties.contains_key(*name), "{item}.{action}: {name}");
                assert!(!["action", "item"].contains(name), "{item}.{action}: {name} is a selector");
            }
            assert!(!op.required.iter().any(|name| op.optional.contains(name)), "{item}.{action}");
        }
    }

    /// Every item of the schema has actions, and every action is one of the schema's.
    #[test]
    fn the_items_and_actions_are_those_of_the_schema() {
        let listed = |name: &str| -> Vec<String> {
            let property = &schema()["properties"][name];
            let values = property["enum"].as_array().or_else(|| property["anyOf"][0]["enum"].as_array());
            values.expect("an enum").iter().filter_map(Value::as_str).map(str::to_string).collect()
        };
        let (items, actions) = (listed("item"), listed("action"));
        for ((item, action), _) in ITEM_OPS {
            assert!(items.iter().any(|i| i == item), "{item}");
            assert!(actions.iter().any(|a| a == action), "{action}");
        }
        for item in &items {
            assert!(ITEM_OPS.iter().any(|((i, _), _)| i == item), "{item} has no action");
        }
    }
}
