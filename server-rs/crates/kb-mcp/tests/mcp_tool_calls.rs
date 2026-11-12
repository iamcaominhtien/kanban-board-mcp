//! `tools/call` for the two project tools, call by call: every success and every error branch of `get_projects` and
//! `manage_project`, and a spread of calls with bad arguments (the texts an agent reads when FastMCP and Pydantic
//! refuse a call). What the Python server answers is kept in `contract/golden/mcp_tool_calls.json` (ids and times
//! normalized); both servers are compared with it. To record it again after adding a call:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_tool_calls`.

mod common;

use std::collections::HashMap;

use common::check_golden;
use serde_json::{Map, Value, json};
use testkit::normalize;

/// One call: a name for the golden file, the tool, its arguments (`$name` stands for the id captured under that
/// name), and the name under which the `id` of the result is kept.
struct Call {
    name: &'static str,
    tool: &'static str,
    arguments: Value,
    keep: Option<&'static str>,
}

fn call(name: &'static str, tool: &'static str, arguments: Value) -> Call {
    Call { name, tool, arguments, keep: None }
}

fn keep(name: &'static str, tool: &'static str, arguments: Value, keep: &'static str) -> Call {
    Call { name, tool, arguments, keep: Some(keep) }
}

fn fill(value: &Value, ids: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => match s.strip_prefix('$').and_then(|name| ids.get(name)) {
            Some(id) => json!(id),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, ids)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, ids))).collect()),
        other => other.clone(),
    }
}

fn calls() -> Vec<Call> {
    vec![
        // --- get_projects on an empty board, and arguments FastMCP refuses
        call("list: no projects", "get_projects", json!({})),
        call("list: unknown project on an empty board", "get_projects", json!({"project_id": "nope"})),
        call("list: project_id null", "get_projects", json!({"project_id": null})),
        call("list: project_id the text null", "get_projects", json!({"project_id": "null"})),
        call("list: project_id a number", "get_projects", json!({"project_id": 5})),
        call("list: project_id a boolean", "get_projects", json!({"project_id": true})),
        call("list: project_id a float", "get_projects", json!({"project_id": 1.5})),
        call("list: project_id a list", "get_projects", json!({"project_id": ["a", 1, null, true, 2.5, {"k": "v"}]})),
        call("list: project_id an object", "get_projects", json!({"project_id": {"a": 1}})),
        call("list: project_id a list in text", "get_projects", json!({"project_id": "[1, 2]"})),
        call("list: project_id an object in text", "get_projects", json!({"project_id": "{\"a\": 1}"})),
        call("list: project_id a number in text", "get_projects", json!({"project_id": "12"})),
        call("list: project_id true in text", "get_projects", json!({"project_id": "true"})),
        call("list: unknown argument", "get_projects", json!({"foo": 1})),
        call("list: two unknown arguments", "get_projects", json!({"zeta": "x", "alpha": [1, 2]})),
        call("list: unknown argument and a bad one", "get_projects", json!({"titel": "it's", "project_id": 7})),
        call("list: unknown argument with a long value", "get_projects", json!({"note": "0123456789 0123456789 0123456789 0123456789 0123456789 end"})),
        call("list: unknown argument with a long object", "get_projects", json!({"more": {"name": "A name that is long", "list": [1, 2, 3], "ok": false, "nothing": null}})),
        call("list: unknown argument with quotes", "get_projects", json!({"q": "say \"hi\" it's\nnew"})),
        call("list: unknown argument with accents", "get_projects", json!({"q": "Hà Nội café ☕ 東京 ééééééééééééééééééééééééééééééééééééééé"})),
        call("list: unknown argument with a float", "get_projects", json!({"q": 1.0, "r": 1e22, "s": -0.5})),
        // --- manage_project: arguments
        call("manage: no arguments", "manage_project", json!({})),
        call("manage: unknown action", "manage_project", json!({"action": "destroy"})),
        call("manage: action a number", "manage_project", json!({"action": 5})),
        call("manage: action null", "manage_project", json!({"action": null})),
        call("manage: action a list", "manage_project", json!({"action": ["create"]})),
        call("manage: action in other case", "manage_project", json!({"action": "Create"})),
        call("manage: name a number", "manage_project", json!({"action": "create", "name": 5, "prefix": "AB"})),
        call("manage: several errors at once", "manage_project", json!({"action": "nope", "name": 5, "prefix": ["x"], "worktree_by_default": "maybe", "extra": 1})),
        call("manage: worktree_by_default a number", "manage_project", json!({"action": "update", "project_id": "x", "worktree_by_default": 2})),
        call("manage: worktree_by_default a float", "manage_project", json!({"action": "update", "project_id": "x", "worktree_by_default": 0.5})),
        call("manage: worktree_by_default a list", "manage_project", json!({"action": "update", "project_id": "x", "worktree_by_default": []})),
        call("manage: worktree_by_default text", "manage_project", json!({"action": "update", "project_id": "x", "worktree_by_default": "maybe"})),
        call("manage: only an unknown argument", "manage_project", json!({"colour": "#fff"})),
        // --- manage_project: what each action takes
        call("create: nothing else", "manage_project", json!({"action": "create"})),
        call("create: no prefix", "manage_project", json!({"action": "create", "name": "Alpha"})),
        call("create: no name", "manage_project", json!({"action": "create", "prefix": "ALP"})),
        call("create: a parameter it does not use", "manage_project", json!({"action": "create", "name": "Alpha", "prefix": "ALP", "member_id": "m", "repo_path": "/x"})),
        call("create: null counts as left out", "manage_project", json!({"action": "create", "name": "Alpha", "prefix": null})),
        keep("create: Alpha", "manage_project", json!({"action": "create", "name": "Alpha", "prefix": "ALP"}), "alpha"),
        call("create: the same prefix again", "manage_project", json!({"action": "create", "name": "Again", "prefix": "ALP"})),
        keep("create: lower case prefix, a color", "manage_project", json!({"action": "create", "name": "Bêta ☕", "prefix": "bet", "color": "#ff0000"}), "beta"),
        call("create: prefix too long", "manage_project", json!({"action": "create", "name": "Long", "prefix": "TOOLONG"})),
        call("create: prefix without letters", "manage_project", json!({"action": "create", "name": "Digits", "prefix": "123"})),
        call("create: empty prefix", "manage_project", json!({"action": "create", "name": "Empty", "prefix": ""})),
        keep("create: prefix with spaces around", "manage_project", json!({"action": "create", "name": "Spaced", "prefix": " sp1 "}), "spaced"),
        call("create: empty name", "manage_project", json!({"action": "create", "name": "", "prefix": "EMP"})),
        call("create: text booleans are read", "manage_project", json!({"action": "create", "name": "Flag", "prefix": "FLG", "worktree_by_default": "yes"})),
        call("list: three projects", "get_projects", json!({})),
        call("list: one project with its members", "get_projects", json!({"project_id": "$alpha"})),
        call("list: unknown project", "get_projects", json!({"project_id": "ALP"})),
        call("update: nothing else", "manage_project", json!({"action": "update"})),
        call("update: a parameter it does not use", "manage_project", json!({"action": "update", "project_id": "$alpha", "prefix": "NEW"})),
        call("update: unknown project", "manage_project", json!({"action": "update", "project_id": "nope", "name": "x"})),
        call("update: no fields", "manage_project", json!({"action": "update", "project_id": "$alpha"})),
        call("update: name and color", "manage_project", json!({"action": "update", "project_id": "$alpha", "name": "Alpha 2", "color": "#00ff00"})),
        call("update: worktree settings", "manage_project", json!({"action": "update", "project_id": "$alpha", "worktree_template": " ../wt/{project}/{ticket_id}-{branch} ", "worktree_by_default": true})),
        call("update: worktree_by_default from text", "manage_project", json!({"action": "update", "project_id": "$alpha", "worktree_by_default": "off"})),
        call("update: worktree_by_default from a number", "manage_project", json!({"action": "update", "project_id": "$alpha", "worktree_by_default": 1})),
        call("update: worktree_by_default from a whole float", "manage_project", json!({"action": "update", "project_id": "$alpha", "worktree_by_default": 0.0})),
        call("update: empty template clears it", "manage_project", json!({"action": "update", "project_id": "$alpha", "worktree_template": ""})),
        call("update: a repository that does not exist", "manage_project", json!({"action": "update", "project_id": "$alpha", "repo_path": "/no/such/folder/anywhere"})),
        call("update: empty repo_path unlinks", "manage_project", json!({"action": "update", "project_id": "$alpha", "repo_path": ""})),
        call("add_member: nothing else", "manage_project", json!({"action": "add_member"})),
        call("add_member: no name", "manage_project", json!({"action": "add_member", "project_id": "$alpha"})),
        call("add_member: a parameter it does not use", "manage_project", json!({"action": "add_member", "project_id": "$alpha", "name": "Bao", "prefix": "X"})),
        keep("add_member: Bao", "manage_project", json!({"action": "add_member", "project_id": "$alpha", "name": "Bao"}), "bao"),
        keep("add_member: with a color", "manage_project", json!({"action": "add_member", "project_id": "$alpha", "name": "Hà My", "color": "#123456"}), "ha"),
        keep("add_member: third", "manage_project", json!({"action": "add_member", "project_id": "$alpha", "name": "Chi"}), "chi"),
        call("add_member: a project that does not exist", "manage_project", json!({"action": "add_member", "project_id": "ghost", "name": "Nobody"})),
        call("list: members of Alpha", "get_projects", json!({"project_id": "$alpha"})),
        call("remove_member: nothing else", "manage_project", json!({"action": "remove_member"})),
        call("remove_member: no member_id", "manage_project", json!({"action": "remove_member", "project_id": "$alpha"})),
        call("remove_member: a parameter it does not use", "manage_project", json!({"action": "remove_member", "project_id": "$alpha", "member_id": "$bao", "name": "Bao"})),
        call("remove_member: unknown member", "manage_project", json!({"action": "remove_member", "project_id": "$alpha", "member_id": "nope"})),
        call("remove_member: a member of another project", "manage_project", json!({"action": "remove_member", "project_id": "$beta", "member_id": "$bao"})),
        call("remove_member: Chi", "manage_project", json!({"action": "remove_member", "project_id": "$alpha", "member_id": "$chi"})),
        call("remove_member: Chi again", "manage_project", json!({"action": "remove_member", "project_id": "$alpha", "member_id": "$chi"})),
        // --- other tools
        call("unknown tool", "no_such_tool", json!({"a": 1})),
        call("tool name in other case", "Get_Projects", json!({})),
    ]
}

#[tokio::test]
async fn the_project_tools_answer_as_python_does() {
    let s = common::start().await;
    let mcp = s.mcp();
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut got = Map::new();
    for call in calls() {
        let result = mcp.call_tool(call.tool, fill(&call.arguments, &ids)).await;
        if let Some(name) = call.keep {
            let made = result.json();
            let id = made["id"].as_str().unwrap_or_else(|| panic!("{}: no id in {}", call.name, result.text));
            ids.insert(name.to_string(), id.to_string());
        }
        assert!(got.insert(call.name.to_string(), result.raw).is_none(), "two calls named {}", call.name);
    }

    // members with tickets: the tickets are made through the REST API (their creator is the project's first member)
    let c = s.client();
    let (alpha, bao, ha) = (&ids["alpha"], &ids["bao"], &ids["ha"]);
    let ticket = |title: &'static str, assignee: String| {
        let c = c.clone();
        let path = format!("/projects/{alpha}/tickets");
        async move {
            let made = c.post(&path, json!({"title": title, "assignee": assignee})).await;
            made.assert_status(201);
            made.json()
        }
    };
    ticket("One", bao.clone()).await;
    ticket("Two", bao.clone()).await;
    ticket("Three", ha.clone()).await;
    let dan = mcp.call_tool("manage_project", json!({"action": "add_member", "project_id": alpha, "name": "Dan"})).await;
    let dan = dan.json()["id"].as_str().expect("an id").to_string();
    let closed = ticket("Closed", dan.clone()).await;
    let closed_id = closed["id"].as_str().expect("a ticket id");
    c.patch(&format!("/tickets/{closed_id}"), json!({"status": "done"})).await.assert_status(200);
    let admin = mcp.call_tool("get_projects", json!({"project_id": alpha})).await.json()["members"][0]["id"].clone();
    let admin = admin.as_str().expect("the first member").to_string();

    let remove = |member: &str| json!({"action": "remove_member", "project_id": alpha, "member_id": member});
    let mut later = |name: &str, result: testkit::ToolResult| {
        assert!(got.insert(name.to_string(), result.raw).is_none(), "two calls named {name}");
    };
    later("remove_member: created tickets", mcp.call_tool("manage_project", remove(&admin)).await);
    later("remove_member: two open tickets", mcp.call_tool("manage_project", remove(bao)).await);
    later("remove_member: one open ticket", mcp.call_tool("manage_project", remove(ha)).await);
    later("remove_member: only a closed ticket", mcp.call_tool("manage_project", remove(&dan)).await);
    // the closed ticket is no longer assigned
    let after = c.get(&format!("/tickets/{closed_id}")).await;
    after.assert_status(200);
    got.insert("the closed ticket's assignee afterwards".to_string(), after.json()["assignee"].clone());
    let members = mcp.call_tool("get_projects", json!({"project_id": alpha})).await;
    got.insert("list: members at the end".to_string(), members.raw);

    // one value normalized as a whole, so that an id is the same `<uuid:N>` in every call
    let normalized = normalize(&Value::Object(got));
    check_golden("mcp_tool_calls.json", normalized.as_object().expect("an object"));
}
