//! The Docs tools: reading and writing a project's page tree, its comments, files, diagrams, sketches and canvases.
//!
//! `docs_read` and `docs_write` are the two largest tools: each action is one operation in `crate::operations`
//! (`docs`, `diagrams`, `sketches`, `canvases`, `pictures`), routed by the tables in `read` and `write`; the actions
//! made of other actions (`edit`, `upload`, `tickets`, `assign`) are in `composite`.

pub mod composite;
pub mod read;
pub mod write;

pub use read::{DOCS_READ_OPS, docs_read};
pub use write::{DOCS_WRITE_COMPOSITE, DOCS_WRITE_OPS, docs_write};

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::registry::snapshot;

    fn properties(tool: &str) -> (&'static serde_json::Map<String, Value>, Vec<String>) {
        let entry = snapshot(false).iter().find(|e| e["name"] == tool).expect("the tool is in the snapshot");
        let schema = &entry["inputSchema"];
        let actions = schema["properties"]["action"]["enum"]
            .as_array()
            .expect("enum")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        (schema["properties"].as_object().expect("properties"), actions)
    }

    /// `test_every_table_entry_names_real_parameters`: a typo in a table would only show when that action is used;
    /// check them all once. Here against the tool's schema (the operation's parameters are the tool's).
    #[test]
    fn every_table_entry_names_real_parameters() {
        for (tool, table) in [("docs_read", DOCS_READ_OPS), ("docs_write", DOCS_WRITE_OPS)] {
            let (props, _) = properties(tool);
            for (action, op) in table {
                for name in op.required.iter().chain(op.optional) {
                    assert!(props.contains_key(*name), "{tool}.{action}: {name}");
                    assert!(!["action", "item"].contains(name), "{tool}.{action}: {name} is a selector");
                }
                assert!(!op.required.iter().any(|name| op.optional.contains(name)), "{tool}.{action}");
            }
        }
    }

    /// Every action of the schema is a real choice, and the other way round, in the schema's order.
    #[test]
    fn the_actions_are_those_of_the_schema() {
        let (_, read) = properties("docs_read");
        assert_eq!(DOCS_READ_OPS.iter().map(|(a, _)| a.to_string()).collect::<Vec<_>>(), read);
        let (_, write) = properties("docs_write");
        let mut listed: Vec<String> = DOCS_WRITE_OPS.iter().map(|(a, _)| a.to_string()).collect();
        listed.extend(DOCS_WRITE_COMPOSITE.iter().map(|a| a.to_string()));
        let mut sorted_listed = listed.clone();
        sorted_listed.sort();
        let mut sorted_schema = write;
        sorted_schema.sort();
        assert_eq!(sorted_listed, sorted_schema);
    }
}
