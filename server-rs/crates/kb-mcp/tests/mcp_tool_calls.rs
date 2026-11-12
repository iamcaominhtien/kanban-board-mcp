//! `tools/call`, call by call: every success and every error branch of `get_projects` and `manage_project`, of the
//! ticket tools (`list_tickets`, `get_ticket`, `manage_ticket`, `ticket_items`, `ticket_branches`) and of the Idea
//! Space tools, and a spread of calls with bad arguments (the texts an agent reads when FastMCP and Pydantic refuse a
//! call). What the Python server answers is kept in `contract/golden/` (ids, times and the folders of the test
//! normalized): `mcp_tool_calls.json` for the project tools, `mcp_tool_calls_tickets.json` for the ticket tools,
//! `mcp_tool_calls_ideas.json` for the Idea Space tools; both servers are compared with them. To record them again
//! after adding a call: `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_tool_calls`.

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
    /// The name under which a value of the result is kept, and where it is (a JSON pointer; the `id` by default).
    keep: Option<(&'static str, &'static str)>,
}

fn call(name: &'static str, tool: &'static str, arguments: Value) -> Call {
    Call { name, tool, arguments, keep: None }
}

fn keep(name: &'static str, tool: &'static str, arguments: Value, keep: &'static str) -> Call {
    Call { name, tool, arguments, keep: Some((keep, "/id")) }
}

/// A call that keeps the value at `pointer` of its result under `keep`.
fn keep_at(name: &'static str, tool: &'static str, arguments: Value, keep: &'static str, pointer: &'static str) -> Call {
    Call { name, tool, arguments, keep: Some((keep, pointer)) }
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
        call(
            "list: unknown argument with a long value",
            "get_projects",
            json!({"note": "0123456789 0123456789 0123456789 0123456789 0123456789 end"}),
        ),
        call(
            "list: unknown argument with a long object",
            "get_projects",
            json!({"more": {"name": "A name that is long", "list": [1, 2, 3], "ok": false, "nothing": null}}),
        ),
        call("list: unknown argument with quotes", "get_projects", json!({"q": "say \"hi\" it's\nnew"})),
        call(
            "list: unknown argument with accents",
            "get_projects",
            json!({"q": "Hà Nội café ☕ 東京 ééééééééééééééééééééééééééééééééééééééé"}),
        ),
        call("list: unknown argument with a float", "get_projects", json!({"q": 1.0, "r": 1e22, "s": -0.5})),
        // --- manage_project: arguments
        call("manage: no arguments", "manage_project", json!({})),
        call("manage: unknown action", "manage_project", json!({"action": "destroy"})),
        call("manage: action a number", "manage_project", json!({"action": 5})),
        call("manage: action null", "manage_project", json!({"action": null})),
        call("manage: action a list", "manage_project", json!({"action": ["create"]})),
        call("manage: action in other case", "manage_project", json!({"action": "Create"})),
        call("manage: name a number", "manage_project", json!({"action": "create", "name": 5, "prefix": "AB"})),
        call(
            "manage: several errors at once",
            "manage_project",
            json!({"action": "nope", "name": 5, "prefix": ["x"], "worktree_by_default": "maybe", "extra": 1}),
        ),
        call(
            "manage: worktree_by_default a number",
            "manage_project",
            json!({"action": "update", "project_id": "x", "worktree_by_default": 2}),
        ),
        call(
            "manage: worktree_by_default a float",
            "manage_project",
            json!({"action": "update", "project_id": "x", "worktree_by_default": 0.5}),
        ),
        call(
            "manage: worktree_by_default a list",
            "manage_project",
            json!({"action": "update", "project_id": "x", "worktree_by_default": []}),
        ),
        call(
            "manage: worktree_by_default text",
            "manage_project",
            json!({"action": "update", "project_id": "x", "worktree_by_default": "maybe"}),
        ),
        call("manage: only an unknown argument", "manage_project", json!({"colour": "#fff"})),
        // --- manage_project: what each action takes
        call("create: nothing else", "manage_project", json!({"action": "create"})),
        call("create: no prefix", "manage_project", json!({"action": "create", "name": "Alpha"})),
        call("create: no name", "manage_project", json!({"action": "create", "prefix": "ALP"})),
        call(
            "create: a parameter it does not use",
            "manage_project",
            json!({"action": "create", "name": "Alpha", "prefix": "ALP", "member_id": "m", "repo_path": "/x"}),
        ),
        call(
            "create: null counts as left out",
            "manage_project",
            json!({"action": "create", "name": "Alpha", "prefix": null}),
        ),
        keep("create: Alpha", "manage_project", json!({"action": "create", "name": "Alpha", "prefix": "ALP"}), "alpha"),
        call(
            "create: the same prefix again",
            "manage_project",
            json!({"action": "create", "name": "Again", "prefix": "ALP"}),
        ),
        keep(
            "create: lower case prefix, a color",
            "manage_project",
            json!({"action": "create", "name": "Bêta ☕", "prefix": "bet", "color": "#ff0000"}),
            "beta",
        ),
        call(
            "create: prefix too long",
            "manage_project",
            json!({"action": "create", "name": "Long", "prefix": "TOOLONG"}),
        ),
        call(
            "create: prefix without letters",
            "manage_project",
            json!({"action": "create", "name": "Digits", "prefix": "123"}),
        ),
        call("create: empty prefix", "manage_project", json!({"action": "create", "name": "Empty", "prefix": ""})),
        keep(
            "create: prefix with spaces around",
            "manage_project",
            json!({"action": "create", "name": "Spaced", "prefix": " sp1 "}),
            "spaced",
        ),
        call("create: empty name", "manage_project", json!({"action": "create", "name": "", "prefix": "EMP"})),
        call(
            "create: text booleans are read",
            "manage_project",
            json!({"action": "create", "name": "Flag", "prefix": "FLG", "worktree_by_default": "yes"}),
        ),
        call("list: three projects", "get_projects", json!({})),
        call("list: one project with its members", "get_projects", json!({"project_id": "$alpha"})),
        call("list: unknown project", "get_projects", json!({"project_id": "ALP"})),
        call("update: nothing else", "manage_project", json!({"action": "update"})),
        call(
            "update: a parameter it does not use",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "prefix": "NEW"}),
        ),
        call(
            "update: unknown project",
            "manage_project",
            json!({"action": "update", "project_id": "nope", "name": "x"}),
        ),
        call("update: no fields", "manage_project", json!({"action": "update", "project_id": "$alpha"})),
        call(
            "update: name and color",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "name": "Alpha 2", "color": "#00ff00"}),
        ),
        call(
            "update: worktree settings",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "worktree_template": " ../wt/{project}/{ticket_id}-{branch} ", "worktree_by_default": true}),
        ),
        call(
            "update: worktree_by_default from text",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "worktree_by_default": "off"}),
        ),
        call(
            "update: worktree_by_default from a number",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "worktree_by_default": 1}),
        ),
        call(
            "update: worktree_by_default from a whole float",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "worktree_by_default": 0.0}),
        ),
        call(
            "update: empty template clears it",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "worktree_template": ""}),
        ),
        call(
            "update: a repository that does not exist",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "repo_path": "/no/such/folder/anywhere"}),
        ),
        call(
            "update: empty repo_path unlinks",
            "manage_project",
            json!({"action": "update", "project_id": "$alpha", "repo_path": ""}),
        ),
        call("add_member: nothing else", "manage_project", json!({"action": "add_member"})),
        call("add_member: no name", "manage_project", json!({"action": "add_member", "project_id": "$alpha"})),
        call(
            "add_member: a parameter it does not use",
            "manage_project",
            json!({"action": "add_member", "project_id": "$alpha", "name": "Bao", "prefix": "X"}),
        ),
        keep(
            "add_member: Bao",
            "manage_project",
            json!({"action": "add_member", "project_id": "$alpha", "name": "Bao"}),
            "bao",
        ),
        keep(
            "add_member: with a color",
            "manage_project",
            json!({"action": "add_member", "project_id": "$alpha", "name": "Hà My", "color": "#123456"}),
            "ha",
        ),
        keep(
            "add_member: third",
            "manage_project",
            json!({"action": "add_member", "project_id": "$alpha", "name": "Chi"}),
            "chi",
        ),
        call(
            "add_member: a project that does not exist",
            "manage_project",
            json!({"action": "add_member", "project_id": "ghost", "name": "Nobody"}),
        ),
        call("list: members of Alpha", "get_projects", json!({"project_id": "$alpha"})),
        call("remove_member: nothing else", "manage_project", json!({"action": "remove_member"})),
        call(
            "remove_member: no member_id",
            "manage_project",
            json!({"action": "remove_member", "project_id": "$alpha"}),
        ),
        call(
            "remove_member: a parameter it does not use",
            "manage_project",
            json!({"action": "remove_member", "project_id": "$alpha", "member_id": "$bao", "name": "Bao"}),
        ),
        call(
            "remove_member: unknown member",
            "manage_project",
            json!({"action": "remove_member", "project_id": "$alpha", "member_id": "nope"}),
        ),
        call(
            "remove_member: a member of another project",
            "manage_project",
            json!({"action": "remove_member", "project_id": "$beta", "member_id": "$bao"}),
        ),
        call(
            "remove_member: Chi",
            "manage_project",
            json!({"action": "remove_member", "project_id": "$alpha", "member_id": "$chi"}),
        ),
        call(
            "remove_member: Chi again",
            "manage_project",
            json!({"action": "remove_member", "project_id": "$alpha", "member_id": "$chi"}),
        ),
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
        if let Some((name, pointer)) = call.keep {
            let made = result.json();
            let id = made.pointer(pointer).and_then(Value::as_str);
            let id = id.unwrap_or_else(|| panic!("{}: nothing at {pointer} in {}", call.name, result.text));
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
    let dan =
        mcp.call_tool("manage_project", json!({"action": "add_member", "project_id": alpha, "name": "Dan"})).await;
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

/// Every failing call is written to the server's log (`registry._log_tool_failures`): a call the agent got wrong
/// as a warning, with the names of its arguments and never their values.
#[tokio::test]
async fn failing_calls_are_logged_without_argument_values() {
    let s = common::start().await;
    let mcp = s.mcp();
    mcp.call_tool("no_such_tool", json!({"zeta": "secret-1", "alpha": 2})).await;
    mcp.call_tool("get_projects", json!({"titel": "secret-2"})).await;
    mcp.call_tool("manage_project", json!({"action": "update", "project_id": "secret-3", "name": "secret-4"})).await;
    mcp.call_tool("get_projects", json!({})).await;

    // the log file is written as the call ends; give a slow disk a moment
    let mut found: Vec<String> = Vec::new();
    for _ in 0..50 {
        found.clear();
        for entry in std::fs::read_dir(s.log_dir()).expect("the log folder") {
            let text = std::fs::read_to_string(entry.expect("an entry").path()).unwrap_or_default();
            found.extend(text.lines().filter(|l| l.contains("MCP tool ")).map(str::to_string));
        }
        if found.len() >= 3 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let messages: Vec<&str> = found.iter().map(|l| &l[l.find("MCP tool ").expect("the message")..]).collect();
    assert_eq!(
        messages,
        [
            "MCP tool no_such_tool rejected (arguments: ['alpha', 'zeta']): Unknown tool: no_such_tool",
            "MCP tool get_projects rejected (arguments: ['titel']): Error executing tool get_projects: 1 validation \
             error for get_projectsArguments",
            "MCP tool manage_project rejected (arguments: ['action', 'name', 'project_id']): Error executing tool \
             manage_project: Project 'secret-3' not found. Use get_projects to see project ids.",
        ]
    );
    for line in &found {
        assert!(line.contains("WARNING") && line.contains("kanban_mcp.registry"), "{line}");
    }
    let whole = found.join("\n");
    assert!(!whole.contains("secret-1") && !whole.contains("secret-2") && !whole.contains("secret-4"), "{whole}");
}

// ---------------------------------------------------------------------------------------------------------------
// The ticket tools
// ---------------------------------------------------------------------------------------------------------------

/// `manage_ticket(action=..., **rest)`.
fn mt(name: &'static str, action: &str, rest: Value) -> Call {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(name, "manage_ticket", arguments)
}

/// `ticket_items(ticket_id=..., item=..., **rest)`.
fn it(name: &'static str, ticket_id: &str, item: &str, rest: Value) -> Call {
    call(name, "ticket_items", it_arguments(ticket_id, item, rest))
}

fn it_arguments(ticket_id: &str, item: &str, rest: Value) -> Value {
    let mut arguments = json!({"ticket_id": ticket_id, "item": item});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    arguments
}

/// `ticket_branches(ticket_id=..., action=..., **rest)`.
fn br(name: &'static str, ticket_id: &str, action: &str, rest: Value) -> Call {
    let mut arguments = json!({"ticket_id": ticket_id, "action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(name, "ticket_branches", arguments)
}

/// The text a tool result carries, with the folders of this test run replaced: where a server keeps its files and
/// where the test keeps the files it attaches differ from one run to the next.
fn scrub(value: &Value, folders: &[(String, &str)]) -> Value {
    match value {
        Value::String(text) => {
            let mut text = text.clone();
            for (folder, name) in folders {
                text = text.replace(folder.as_str(), name);
            }
            // the name an uploaded file is stored under ends in a few random characters
            static STORED: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(r"(/uploads/[A-Za-z0-9_.-]*?)-[0-9a-f]{6,12}(\.[a-z0-9]+)").expect("a pattern")
            });
            Value::String(STORED.replace_all(&text, "$1-<random>$2").into_owned())
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| scrub(v, folders)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), scrub(v, folders))).collect()),
        other => other.clone(),
    }
}

/// A server being worked through the tools: the calls made so far and what they answered.
struct Run {
    mcp: testkit::Mcp,
    ids: HashMap<String, String>,
    got: Map<String, Value>,
}

impl Run {
    fn new(mcp: testkit::Mcp) -> Self {
        Run { mcp, ids: HashMap::new(), got: Map::new() }
    }

    async fn run(&mut self, calls: Vec<Call>) {
        for call in calls {
            let result = self.mcp.call_tool(call.tool, fill(&call.arguments, &self.ids)).await;
            if let Some((name, pointer)) = call.keep {
                let made = result.json();
                let id = made.pointer(pointer).and_then(Value::as_str);
                let id = id.unwrap_or_else(|| panic!("{}: nothing at {pointer} in {}", call.name, result.text));
                self.ids.insert(name.to_string(), id.to_string());
            }
            assert!(self.got.insert(call.name.to_string(), result.raw).is_none(), "two calls named {}", call.name);
        }
    }

    fn id(&self, name: &str) -> String {
        self.ids[name].clone()
    }
}

/// The projects, members and tickets the calls below work on.
fn ticket_setup() -> Vec<Call> {
    vec![
        keep("setup: project", "manage_project", json!({"action": "create", "name": "Tickets", "prefix": "TKT"}), "p"),
        keep("setup: other project", "manage_project", json!({"action": "create", "name": "Beta", "prefix": "BET"}), "p2"),
        keep("setup: Bao", "manage_project", json!({"action": "add_member", "project_id": "$p", "name": "Bao"}), "bao"),
        keep("setup: Hà My", "manage_project", json!({"action": "add_member", "project_id": "$p", "name": "Hà My"}), "ha"),
        keep("setup: a member of the other project", "manage_project", json!({"action": "add_member", "project_id": "$p2", "name": "Other"}), "other"),
    ]
}

/// list_tickets and get_ticket on an empty project, and the arguments they refuse.
fn list_and_get_on_nothing() -> Vec<Call> {
    vec![
        call("list_tickets: an empty project", "list_tickets", json!({"project_id": "$p"})),
        call("list_tickets: a project that does not exist", "list_tickets", json!({"project_id": "nope"})),
        call("list_tickets: no arguments", "list_tickets", json!({})),
        call("list_tickets: project_id a number", "list_tickets", json!({"project_id": 5})),
        call("list_tickets: unknown argument", "list_tickets", json!({"project_id": "$p", "statuss": "done"})),
        call("list_tickets: status unknown", "list_tickets", json!({"project_id": "$p", "status": "bogus"})),
        call("list_tickets: priority unknown", "list_tickets", json!({"project_id": "$p", "priority": "urgent"})),
        call("list_tickets: type unknown", "list_tickets", json!({"project_id": "$p", "type": "epic"})),
        call("list_tickets: limit 0", "list_tickets", json!({"project_id": "$p", "limit": 0})),
        call("list_tickets: limit 501", "list_tickets", json!({"project_id": "$p", "limit": 501})),
        call("list_tickets: limit text", "list_tickets", json!({"project_id": "$p", "limit": "ten"})),
        call("list_tickets: limit a text number", "list_tickets", json!({"project_id": "$p", "limit": "5"})),
        call("list_tickets: offset -1", "list_tickets", json!({"project_id": "$p", "offset": -1})),
        call("list_tickets: pending maybe", "list_tickets", json!({"project_id": "$p", "pending": "maybe"})),
        call("list_tickets: detail yes", "list_tickets", json!({"project_id": "$p", "detail": "yes"})),
        call("list_tickets: several errors at once", "list_tickets", json!({"limit": 0, "offset": -3, "status": 5, "zz": 1})),
        call("get_ticket: no arguments", "get_ticket", json!({})),
        call("get_ticket: a ticket that does not exist", "get_ticket", json!({"ticket_id": "TKT-99"})),
        call("get_ticket: ticket_id a number", "get_ticket", json!({"ticket_id": 7})),
        call("get_ticket: view unknown", "get_ticket", json!({"ticket_id": "TKT-1", "view": "short"})),
        call("get_ticket: activity_limit 1001", "get_ticket", json!({"ticket_id": "TKT-1", "activity_limit": 1001})),
        call("get_ticket: activity_limit text", "get_ticket", json!({"ticket_id": "TKT-1", "activity_limit": "many"})),
        call("get_ticket: comments of a ticket that does not exist", "get_ticket", json!({"ticket_id": "TKT-99", "view": "comments"})),
        call("get_ticket: unknown argument", "get_ticket", json!({"ticket_id": "TKT-1", "include_activity": true})),
    ]
}

/// manage_ticket create: the starting values, every field, and each refusal.
fn create_tickets() -> Vec<Call> {
    vec![
        mt("create: nothing else", "create", json!({})),
        mt("create: no title", "create", json!({"project_id": "$p"})),
        mt("create: no project", "create", json!({"title": "x"})),
        mt("create: a parameter it does not use", "create", json!({"project_id": "$p", "title": "x", "ticket_id": "TKT-1"})),
        mt("create: two parameters it does not use", "create", json!({"project_id": "$p", "title": "x", "link_id": "l", "reason": "r"})),
        mt("create: null counts as left out", "create", json!({"project_id": "$p", "title": null})),
        mt("create: unknown project", "create", json!({"project_id": "nope", "title": "x"})),
        mt("create: project given by its prefix", "create", json!({"project_id": "TKT", "title": "x"})),
        keep("create: a title alone", "manage_ticket", json!({"action": "create", "project_id": "$p", "title": "  Nhắc uống nước mỗi giờ  "}), "t1"),
        keep(
            "create: every field",
            "manage_ticket",
            json!({"action": "create", "project_id": "$p", "title": "Login: a wrong password shows no message",
                   "description": "Steps in [[Login spec#Errors]].\n\n\"Quoted\" & <tagged> \\ slash", "type": "bug",
                   "priority": "critical", "status": "todo", "estimate": 3, "due_date": "2026-06-30",
                   "start_date": "2026-06-01", "parent_id": null, "tags": [" auth ", "Đăng nhập", "AUTH", "p1"],
                   "assignee": "$bao", "acceptance_criteria": ["A wrong password shows a message", "  The field keeps its text  "]}),
            "t2",
        ),
        keep("create: a story", "manage_ticket", json!({"action": "create", "project_id": "$p", "title": "Export a month as CSV", "type": "story", "estimate": 0.5}), "story"),
        keep("create: a ticket under the story", "manage_ticket", json!({"action": "create", "project_id": "$p", "title": "The file", "parent_id": "$story", "status": "in-progress"}), "under"),
        keep("create: a sub-ticket", "manage_ticket", json!({"action": "create", "project_id": "$p", "title": "The header row", "parent_id": "$under", "type": "chore"}), "sub"),
        mt("create: too deep", "create", json!({"project_id": "$p", "title": "Too deep", "parent_id": "$sub"})),
        mt("create: a sub-ticket of a plain ticket", "create", json!({"project_id": "$p", "title": "Child", "parent_id": "$t1"})),
        mt("create: a parent that does not exist", "create", json!({"project_id": "$p", "title": "Orphan", "parent_id": "TKT-99"})),
        mt("create: a parent of another project", "create", json!({"project_id": "$p2", "title": "Stranger", "parent_id": "$t1"})),
        mt("create: starts in wont_do", "create", json!({"project_id": "$p", "title": "x", "status": "wont_do"})),
        mt("create: status unknown", "create", json!({"project_id": "$p", "title": "x", "status": "doing"})),
        mt("create: type unknown", "create", json!({"project_id": "$p", "title": "x", "type": "epic"})),
        mt("create: priority unknown", "create", json!({"project_id": "$p", "title": "x", "priority": "asap"})),
        mt("create: an empty title", "create", json!({"project_id": "$p", "title": ""})),
        mt("create: a blank title", "create", json!({"project_id": "$p", "title": "   "})),
        mt("create: a title of 300 characters", "create", json!({"project_id": "$p", "title": "ñ".repeat(300)})),
        mt("create: a title of 301 characters", "create", json!({"project_id": "$p", "title": "ñ".repeat(301)})),
        mt("create: title a number", "create", json!({"project_id": "$p", "title": 12})),
        mt("create: a due date that is not a date", "create", json!({"project_id": "$p", "title": "x", "due_date": "next week"})),
        mt("create: a start date that is not a date", "create", json!({"project_id": "$p", "title": "x", "start_date": "2026-13-45"})),
        mt("create: a start date after the due date", "create", json!({"project_id": "$p", "title": "x", "start_date": "2026-12-01", "due_date": "2026-01-01"})),
        mt("create: a negative estimate", "create", json!({"project_id": "$p", "title": "x", "estimate": -1})),
        mt("create: an estimate too large", "create", json!({"project_id": "$p", "title": "x", "estimate": 100001})),
        mt("create: an estimate from text", "create", json!({"project_id": "$p", "title": "x", "estimate": "3"})),
        mt("create: an estimate that is not a number", "create", json!({"project_id": "$p", "title": "x", "estimate": "lots"})),
        mt("create: tags from text", "create", json!({"project_id": "$p", "title": "From text", "tags": "[\"a\", \"b\"]"})),
        mt("create: a tag of 51 characters", "create", json!({"project_id": "$p", "title": "x", "tags": ["x".repeat(51)]})),
        mt("create: 31 tags", "create", json!({"project_id": "$p", "title": "x", "tags": (0..31).map(|i| format!("t{i}")).collect::<Vec<_>>()})),
        mt("create: a tag that is a number", "create", json!({"project_id": "$p", "title": "x", "tags": [1]})),
        mt("create: an assignee that is not a member", "create", json!({"project_id": "$p", "title": "x", "assignee": "nobody"})),
        mt("create: an assignee of another project", "create", json!({"project_id": "$p", "title": "x", "assignee": "$other"})),
        mt("create: 51 criteria", "create", json!({"project_id": "$p", "title": "x", "acceptance_criteria": (0..51).map(|i| format!("c{i}")).collect::<Vec<_>>()})),
        mt("create: an empty criterion", "create", json!({"project_id": "$p", "title": "x", "acceptance_criteria": ["ok", ""]})),
        mt("create: a criterion of 1001 characters", "create", json!({"project_id": "$p", "title": "x", "acceptance_criteria": ["c".repeat(1001)]})),
        mt("create: criteria that are not a list", "create", json!({"project_id": "$p", "title": "x", "acceptance_criteria": 5})),
        keep("create: another ticket", "manage_ticket", json!({"action": "create", "project_id": "$p", "title": "Peer", "priority": "low", "status": "in-progress", "description": "![shot](/uploads/shot.png)"}), "t3"),
        keep("create: a ticket in the other project", "manage_ticket", json!({"action": "create", "project_id": "$p2", "title": "Elsewhere", "status": "done"}), "other_ticket"),
        keep("create: a ticket to delete", "manage_ticket", json!({"action": "create", "project_id": "$p", "title": "To delete", "tags": ["x"]}), "gone"),
    ]
}

/// list_tickets and get_ticket on the tickets made.
fn list_and_get() -> Vec<Call> {
    vec![
        call("list_tickets: the tickets", "list_tickets", json!({"project_id": "$p"})),
        call("list_tickets: details", "list_tickets", json!({"project_id": "$p", "detail": true, "limit": 2})),
        call("list_tickets: the second page", "list_tickets", json!({"project_id": "$p", "limit": 2, "offset": 2})),
        call("list_tickets: past the end", "list_tickets", json!({"project_id": "$p", "offset": 50})),
        call("list_tickets: by status", "list_tickets", json!({"project_id": "$p", "status": "in-progress"})),
        call("list_tickets: by priority", "list_tickets", json!({"project_id": "$p", "priority": "critical"})),
        call("list_tickets: by type", "list_tickets", json!({"project_id": "$p", "type": "story"})),
        call("list_tickets: by parent", "list_tickets", json!({"project_id": "$p", "parent_id": "$story"})),
        call("list_tickets: an empty parent is no filter", "list_tickets", json!({"project_id": "$p", "parent_id": ""})),
        call("list_tickets: a text", "list_tickets", json!({"project_id": "$p", "q": "password"})),
        call("list_tickets: a text with accents", "list_tickets", json!({"project_id": "$p", "q": "nhac uong nuoc"})),
        call("list_tickets: a blank text", "list_tickets", json!({"project_id": "$p", "q": "   "})),
        call("list_tickets: a text that matches nothing", "list_tickets", json!({"project_id": "$p", "q": "zzzzqqq"})),
        call("list_tickets: without wont_do", "list_tickets", json!({"project_id": "$p", "include_wont_do": false})),
        call("list_tickets: the other project", "list_tickets", json!({"project_id": "$p2"})),
        call("get_ticket: the first", "get_ticket", json!({"ticket_id": "$t1"})),
        call("get_ticket: every field", "get_ticket", json!({"ticket_id": "$t2"})),
        call("get_ticket: with an upload in the text", "get_ticket", json!({"ticket_id": "$t3"})),
        call("get_ticket: a ticket under a story", "get_ticket", json!({"ticket_id": "$under"})),
        call("get_ticket: no activity", "get_ticket", json!({"ticket_id": "$t2", "activity_limit": 0})),
        call("get_ticket: the last entry", "get_ticket", json!({"ticket_id": "$t2", "activity_limit": 1})),
        call("get_ticket: all the activity", "get_ticket", json!({"ticket_id": "$t2", "activity_limit": -1})),
        call("get_ticket: any negative limit", "get_ticket", json!({"ticket_id": "$t2", "activity_limit": -50})),
        call("get_ticket: activity since long ago", "get_ticket", json!({"ticket_id": "$t2", "activity_since": "2000-01-01"})),
        call("get_ticket: activity since the future", "get_ticket", json!({"ticket_id": "$t2", "activity_since": "2999-01-01T00:00:00Z"})),
        call("get_ticket: activity since with a limit", "get_ticket", json!({"ticket_id": "$t2", "activity_since": "2000-01-01", "activity_limit": 1})),
        call("get_ticket: activity since an offset time", "get_ticket", json!({"ticket_id": "$t2", "activity_since": "2000-01-01T07:00:00+07:00"})),
        call("get_ticket: activity since a blank text", "get_ticket", json!({"ticket_id": "$t2", "activity_since": ""})),
        call("get_ticket: activity since that is not a time", "get_ticket", json!({"ticket_id": "$t2", "activity_since": "yesterday"})),
        call("get_ticket: activity since with a trailing Z only", "get_ticket", json!({"ticket_id": "$t2", "activity_since": " 2000-01-01Z "})),
        call("get_ticket: comments", "get_ticket", json!({"ticket_id": "$t1", "view": "comments"})),
        call("get_ticket: comments with a limit", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "activity_limit": 3})),
        call("get_ticket: comments with a limit of 0", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "activity_limit": 0})),
        call("get_ticket: comments since", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "activity_since": "2000-01-01"})),
        call("get_ticket: comments since a blank text", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "activity_since": ""})),
        call("get_ticket: comment ids with the full view", "get_ticket", json!({"ticket_id": "$t1", "comment_ids": ["x"]})),
        call("get_ticket: empty comment ids with the full view", "get_ticket", json!({"ticket_id": "$t1", "comment_ids": []})),
        call("get_ticket: comment ids from text", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "comment_ids": "[\"x\"]"})),
    ]
}

/// manage_ticket update and delete.
fn update_tickets() -> Vec<Call> {
    vec![
        mt("update: nothing else", "update", json!({})),
        mt("update: a ticket that does not exist", "update", json!({"ticket_id": "TKT-99", "title": "x"})),
        mt("update: a parameter it does not use", "update", json!({"ticket_id": "$t1", "title": "x", "project_id": "$p"})),
        mt("update: no fields", "update", json!({"ticket_id": "$t1"})),
        mt("update: the title", "update", json!({"ticket_id": "$t1", "title": "Nhắc uống nước mỗi giờ (8:00–18:00)"})),
        mt("update: several fields", "update", json!({"ticket_id": "$t1", "description": "Why: [[Sức khỏe]].", "priority": "high", "type": "feature", "estimate": 1.5, "tags": ["sức khỏe", "Mobile", "mobile"], "due_date": "2026-07-01", "assignee": "$ha", "block_done_if_acs_incomplete": true}))
        ,
        mt("update: an estimate of 2", "update", json!({"ticket_id": "$t1", "estimate": 2})),
        mt("update: clear fields", "update", json!({"ticket_id": "$t1", "clear_fields": ["estimate", "due_date", "assignee"]})),
        mt("update: clear a field that is already empty", "update", json!({"ticket_id": "$t1", "clear_fields": ["estimate"]})),
        mt("update: clear the same field twice", "update", json!({"ticket_id": "$t1", "clear_fields": ["estimate", "estimate"]})),
        mt("update: set and clear a field", "update", json!({"ticket_id": "$t1", "estimate": 1, "clear_fields": ["estimate"]})),
        mt("update: clear a field that cannot be cleared", "update", json!({"ticket_id": "$t1", "clear_fields": ["title"]})),
        mt("update: clear fields from text", "update", json!({"ticket_id": "$t1", "clear_fields": "[\"wave_pin\"]"})),
        mt("update: an empty list of fields to clear", "update", json!({"ticket_id": "$t1", "clear_fields": []})),
        mt("update: clear the parent", "update", json!({"ticket_id": "$sub", "clear_fields": ["parent_id"]})),
        mt("update: a parent again", "update", json!({"ticket_id": "$sub", "parent_id": "$under"})),
        mt("update: a parent that does not exist", "update", json!({"ticket_id": "$t1", "parent_id": "TKT-99"})),
        mt("update: itself as the parent", "update", json!({"ticket_id": "$t1", "parent_id": "$t1"})),
        mt("update: a ticket with sub-tickets under another ticket", "update", json!({"ticket_id": "$under", "parent_id": "$t1"})),
        mt("update: an empty title", "update", json!({"ticket_id": "$t1", "title": ""})),
        mt("update: a title that is too long", "update", json!({"ticket_id": "$t1", "title": "x".repeat(301)})),
        mt("update: a bad date", "update", json!({"ticket_id": "$t1", "due_date": "2026-02-30"})),
        mt("update: the dates in the wrong order", "update", json!({"ticket_id": "$t1", "start_date": "2026-05-01", "due_date": "2026-04-01"})),
        mt("update: dates", "update", json!({"ticket_id": "$t1", "start_date": "2026-05-01", "due_date": "2026-06-01"})),
        mt("update: a negative estimate", "update", json!({"ticket_id": "$t1", "estimate": -2})),
        mt("update: too many tags", "update", json!({"ticket_id": "$t1", "tags": (0..31).map(|i| format!("t{i}")).collect::<Vec<_>>()})),
        mt("update: an assignee that is not a member", "update", json!({"ticket_id": "$t1", "assignee": "nobody"})),
        mt("update: an assignee of another project", "update", json!({"ticket_id": "$t1", "assignee": "$other"})),
        mt("update: an assignee", "update", json!({"ticket_id": "$t1", "assignee": "$bao"})),
        mt("update: unassign", "update", json!({"ticket_id": "$t1", "clear_fields": ["assignee"]})),
        mt("update: review requested from a member", "update", json!({"ticket_id": "$t1", "status": "review", "review_requested_from": "$ha"})),
        mt("update: review requested from a stranger", "update", json!({"ticket_id": "$t1", "review_requested_from": "$other"})),
        mt("update: review request cleared", "update", json!({"ticket_id": "$t1", "clear_fields": ["review_requested_from"]})),
        mt("update: wave_pin on a sub-ticket", "update", json!({"ticket_id": "$sub", "wave_pin": 3})),
        mt("update: wave_pin 0", "update", json!({"ticket_id": "$sub", "wave_pin": 0})),
        mt("update: wave_pin 100", "update", json!({"ticket_id": "$sub", "wave_pin": 100})),
        mt("update: wave_pin from text", "update", json!({"ticket_id": "$sub", "wave_pin": "4"})),
        mt("update: wave_pin cleared", "update", json!({"ticket_id": "$sub", "clear_fields": ["wave_pin"]})),
        mt("update: wave_pin on a plain ticket", "update", json!({"ticket_id": "$t1", "wave_pin": 2})),
        mt("update: a repository that does not exist", "update", json!({"ticket_id": "$t1", "repo_path": "/no/such/folder/anywhere"})),
        mt("update: the repository cleared", "update", json!({"ticket_id": "$t1", "repo_path": ""})),
        mt("update: the guards", "update", json!({"ticket_id": "$t1", "block_done_if_acs_incomplete": true, "block_done_if_tcs_incomplete": true})),
        mt("update: guards from text", "update", json!({"ticket_id": "$t1", "block_done_if_acs_incomplete": "no"})),
        mt("update: a status", "update", json!({"ticket_id": "$t1", "status": "in-progress"})),
        mt("update: a status unknown", "update", json!({"ticket_id": "$t1", "status": "doing"})),
        mt("update: a priority unknown", "update", json!({"ticket_id": "$t1", "priority": "asap"})),
        mt("update: a story becomes a ticket", "update", json!({"ticket_id": "$story", "type": "task"})),
        mt("update: a ticket becomes a story", "update", json!({"ticket_id": "$t1", "type": "story"})),
        mt("update: a story is moved by hand", "update", json!({"ticket_id": "$story", "status": "done"})),
        mt("update: done with the guards on and nothing checked", "update", json!({"ticket_id": "$t1", "status": "done"})),
        mt("update: won't do without a reason", "update", json!({"ticket_id": "$t1", "status": "wont_do"})),
        mt("update: won't do for a sub-ticket", "update", json!({"ticket_id": "$sub", "status": "wont_do", "wont_do_reason": "no"})),
        mt("update: a reason without wont_do", "update", json!({"ticket_id": "$t1", "wont_do_reason": "just because"})),
        mt("update: won't do", "update", json!({"ticket_id": "$t3", "status": "wont_do", "wont_do_reason": "obsolete"})),
        mt("update: a reason cleared", "update", json!({"ticket_id": "$t3", "clear_fields": ["wont_do_reason"]})),
        mt("update: back to todo", "update", json!({"ticket_id": "$t3", "status": "todo"})),
        mt("update: guards off, done", "update", json!({"ticket_id": "$t3", "block_done_if_acs_incomplete": false, "block_done_if_tcs_incomplete": false, "status": "done"})),
        mt("update: null counts as left out", "update", json!({"ticket_id": "$t1", "title": null, "estimate": null})),
        mt("update: several errors at once", "update", json!({"ticket_id": 5, "status": "doing", "wave_pin": 0, "tags": "x", "zz": 1})),
        mt("delete: nothing else", "delete", json!({})),
        mt("delete: a parameter it does not use", "delete", json!({"ticket_id": "$gone", "reason": "r"})),
        mt("delete: a ticket that does not exist", "delete", json!({"ticket_id": "TKT-99"})),
        mt("delete: a ticket", "delete", json!({"ticket_id": "$gone"})),
        mt("delete: the same ticket again", "delete", json!({"ticket_id": "$gone"})),
        call("list_tickets: after the changes", "list_tickets", json!({"project_id": "$p"})),
    ]
}

/// reopen, pend, resume and workspace.
fn reopen_pend_resume() -> Vec<Call> {
    vec![
        mt("reopen: nothing else", "reopen", json!({})),
        mt("reopen: a ticket that is not closed", "reopen", json!({"ticket_id": "$t2"})),
        mt("reopen: a ticket that does not exist", "reopen", json!({"ticket_id": "TKT-99"})),
        mt("reopen: a parameter it does not use", "reopen", json!({"ticket_id": "$t3", "title": "x"})),
        mt("reopen: a done ticket", "reopen", json!({"ticket_id": "$t3"})),
        mt("reopen: done again", "update", json!({"ticket_id": "$t3", "status": "done"})),
        mt("reopen: with everything", "reopen", json!({"ticket_id": "$t3", "reason": "regression", "reset_ac": true, "reset_tests": true, "unassign": true, "reopen_parent": true})),
        mt("reopen: a reason of 241 characters", "reopen", json!({"ticket_id": "$other_ticket", "reason": "r".repeat(241)})),
        mt("reopen: a reason of 240 characters", "reopen", json!({"ticket_id": "$other_ticket", "reason": "r".repeat(240)})),
        mt("reopen: flags from text", "reopen", json!({"ticket_id": "$t3", "reset_ac": "yes"})),
        mt("pend: nothing else", "pend", json!({})),
        mt("pend: no reason_type", "pend", json!({"ticket_id": "$t2"})),
        mt("pend: a reason_type unknown", "pend", json!({"ticket_id": "$t2", "reason_type": "weather"})),
        mt("pend: a ticket without a target", "pend", json!({"ticket_id": "$t2", "reason_type": "ticket"})),
        mt("pend: a person without a member", "pend", json!({"ticket_id": "$t2", "reason_type": "person"})),
        mt("pend: a party without a name", "pend", json!({"ticket_id": "$t2", "reason_type": "party"})),
        mt("pend: a parameter it does not use", "pend", json!({"ticket_id": "$t2", "reason_type": "party", "party": "Acme", "title": "x"})),
        mt("pend: a ticket that does not exist", "pend", json!({"ticket_id": "TKT-99", "reason_type": "party", "party": "Acme"})),
        mt("pend: waiting on a ticket that does not exist", "pend", json!({"ticket_id": "$t2", "reason_type": "ticket", "target_id": "TKT-99"})),
        mt("pend: waiting on itself", "pend", json!({"ticket_id": "$t2", "reason_type": "ticket", "target_id": "$t2"})),
        mt("pend: waiting on a member that is not one", "pend", json!({"ticket_id": "$t2", "reason_type": "person", "member_id": "nobody"})),
        mt("pend: a note of 241 characters", "pend", json!({"ticket_id": "$t2", "reason_type": "party", "party": "Acme", "note": "n".repeat(241)})),
        mt("pend: a party of 241 characters", "pend", json!({"ticket_id": "$t2", "reason_type": "party", "party": "p".repeat(241)})),
        mt("pend: waiting on a ticket", "pend", json!({"ticket_id": "$t2", "reason_type": "ticket", "target_id": "$t1", "add_blocked_by": true, "note": "needs the water"})),
        mt("pend: waiting on a person", "pend", json!({"ticket_id": "$under", "reason_type": "person", "member_id": "$ha"})),
        mt("pend: waiting on a party", "pend", json!({"ticket_id": "$sub", "reason_type": "party", "party": "  Acme  ", "note": "  contract  "})),
        mt("pend: a ticket that is done", "pend", json!({"ticket_id": "$other_ticket", "reason_type": "party", "party": "Acme"})),
        mt("resume: nothing else", "resume", json!({})),
        mt("resume: a ticket that does not exist", "resume", json!({"ticket_id": "TKT-99"})),
        mt("resume: a ticket that is not pending", "resume", json!({"ticket_id": "$t1"})),
        mt("resume: a parameter it does not use", "resume", json!({"ticket_id": "$t2", "title": "x"})),
        mt("resume: a reason of 241 characters", "resume", json!({"ticket_id": "$t2", "reason": "r".repeat(241)})),
        mt("resume: with a comment", "resume", json!({"ticket_id": "$t2", "reason": "unblocked", "add_comment": true})),
        mt("resume: without a reason", "resume", json!({"ticket_id": "$under"})),
        mt("resume: a comment without a reason", "resume", json!({"ticket_id": "$sub", "add_comment": true})),
        call("list_tickets: only the pending", "list_tickets", json!({"project_id": "$p", "pending": true})),
        call("list_tickets: without the pending", "list_tickets", json!({"project_id": "$p", "pending": false, "limit": 3})),
        call("list_tickets: only the reopened", "list_tickets", json!({"project_id": "$p", "reopened": true})),
        call("list_tickets: without the reopened", "list_tickets", json!({"project_id": "$p", "reopened": false, "limit": 3})),
        mt("workspace: nothing else", "workspace", json!({})),
        mt("workspace: a ticket that does not exist", "workspace", json!({"ticket_id": "TKT-99"})),
        mt("workspace: a path that is not a ticket", "workspace", json!({"ticket_id": "../etc"})),
        mt("workspace: a parameter it does not use", "workspace", json!({"ticket_id": "$t1", "path": "/tmp"})),
        mt("workspace: a ticket", "workspace", json!({"ticket_id": "$t1"})),
        mt("workspace: the same ticket again", "workspace", json!({"ticket_id": "$t1"})),
        call("get_ticket: with a workspace", "get_ticket", json!({"ticket_id": "$t1", "activity_limit": 0})),
    ]
}

/// block, unblock, link, unlink, link_doc and unlink_doc.
fn relations() -> Vec<Call> {
    vec![
        mt("block: nothing else", "block", json!({})),
        mt("block: no target", "block", json!({"ticket_id": "$t1"})),
        mt("block: a parameter it does not use", "block", json!({"ticket_id": "$t1", "target_id": "$t2", "link_id": "l"})),
        mt("block: a ticket that does not exist", "block", json!({"ticket_id": "TKT-99", "target_id": "$t2"})),
        mt("block: a target that does not exist", "block", json!({"ticket_id": "$t1", "target_id": "TKT-99"})),
        mt("block: itself", "block", json!({"ticket_id": "$t1", "target_id": "$t1"})),
        mt("block: a ticket of another project", "block", json!({"ticket_id": "$t1", "target_id": "$other_ticket"})),
        mt("block: one ticket waits for another", "block", json!({"ticket_id": "$t1", "target_id": "$t3"})),
        mt("block: the same again", "block", json!({"ticket_id": "$t1", "target_id": "$t3"})),
        mt("block: a cycle", "block", json!({"ticket_id": "$t3", "target_id": "$t1"})),
        mt("block: a chain", "block", json!({"ticket_id": "$t3", "target_id": "$under"})),
        mt("block: a longer cycle", "block", json!({"ticket_id": "$under", "target_id": "$t1"})),
        mt("update: done while a blocker is open", "update", json!({"ticket_id": "$t1", "status": "done"})),
        mt("unblock: nothing else", "unblock", json!({})),
        mt("unblock: a ticket that does not exist", "unblock", json!({"ticket_id": "TKT-99", "target_id": "$t3"})),
        mt("unblock: a target that does not exist", "unblock", json!({"ticket_id": "$t1", "target_id": "TKT-99"})),
        mt("unblock: tickets that are not blocking", "unblock", json!({"ticket_id": "$t2", "target_id": "$sub"})),
        mt("unblock: a block", "unblock", json!({"ticket_id": "$t3", "target_id": "$under"})),
        mt("link: nothing else", "link", json!({})),
        mt("link: no relation type", "link", json!({"ticket_id": "$t1", "target_id": "$t2"})),
        mt("link: a relation type unknown", "link", json!({"ticket_id": "$t1", "target_id": "$t2", "relation_type": "likes"})),
        mt("link: a parameter it does not use", "link", json!({"ticket_id": "$t1", "target_id": "$t2", "relation_type": "causes", "note": "n"})),
        mt("link: itself", "link", json!({"ticket_id": "$t1", "target_id": "$t1", "relation_type": "causes"})),
        mt("link: a ticket that does not exist", "link", json!({"ticket_id": "TKT-99", "target_id": "$t2", "relation_type": "causes"})),
        mt("link: a target that does not exist", "link", json!({"ticket_id": "$t1", "target_id": "TKT-99", "relation_type": "causes"})),
        mt("link: a ticket of another project", "link", json!({"ticket_id": "$t1", "target_id": "$other_ticket", "relation_type": "causes"})),
        keep_at("link: relates to", "manage_ticket", json!({"action": "link", "ticket_id": "$t1", "target_id": "$t2", "relation_type": "relates_to"}), "link1", "/id"),
        mt("link: the same again", "link", json!({"ticket_id": "$t1", "target_id": "$t2", "relation_type": "relates_to"})),
        keep_at("link: causes", "manage_ticket", json!({"action": "link", "ticket_id": "$t2", "target_id": "$t3", "relation_type": "causes"}), "link2", "/id"),
        keep_at("link: duplicated by", "manage_ticket", json!({"action": "link", "ticket_id": "$t3", "target_id": "$under", "relation_type": "duplicated_by"}), "link3", "/id"),
        mt("link: the inverse of a link", "link", json!({"ticket_id": "$t3", "target_id": "$t2", "relation_type": "caused_by"})),
        call("get_ticket: with its links", "get_ticket", json!({"ticket_id": "$t2", "activity_limit": 0})),
        mt("unlink: nothing else", "unlink", json!({})),
        mt("unlink: no link", "unlink", json!({"ticket_id": "$t1"})),
        mt("unlink: a ticket that does not exist", "unlink", json!({"ticket_id": "TKT-99", "link_id": "$link1"})),
        mt("unlink: a link that does not exist", "unlink", json!({"ticket_id": "$t1", "link_id": "nope"})),
        mt("unlink: the other side of a link", "unlink", json!({"ticket_id": "$t2", "link_id": "$link1"})),
        mt("unlink: a parameter it does not use", "unlink", json!({"ticket_id": "$t1", "link_id": "$link1", "target_id": "$t2"})),
        mt("unlink: a link", "unlink", json!({"ticket_id": "$t1", "link_id": "$link1"})),
        mt("unlink: the same link again", "unlink", json!({"ticket_id": "$t1", "link_id": "$link1"})),
        mt("unlink: a second link", "unlink", json!({"ticket_id": "$t2", "link_id": "$link2"})),
        call("get_ticket: after the links", "get_ticket", json!({"ticket_id": "$t3", "activity_limit": 2})),
    ]
}

/// link_doc and unlink_doc, once the pages exist.
fn doc_links() -> Vec<Call> {
    vec![
        mt("link_doc: nothing else", "link_doc", json!({})),
        mt("link_doc: no page", "link_doc", json!({"ticket_id": "$t1"})),
        mt("link_doc: a parameter it does not use", "link_doc", json!({"ticket_id": "$t1", "page_id": "$page", "target_id": "x"})),
        mt("link_doc: a ticket that does not exist", "link_doc", json!({"ticket_id": "TKT-99", "page_id": "$page"})),
        mt("link_doc: a page that does not exist", "link_doc", json!({"ticket_id": "$t1", "page_id": "nope"})),
        mt("link_doc: a page of another project", "link_doc", json!({"ticket_id": "$t1", "page_id": "$page2"})),
        mt("link_doc: a page", "link_doc", json!({"ticket_id": "$t1", "page_id": "$page"})),
        mt("link_doc: the same page again", "link_doc", json!({"ticket_id": "$t1", "page_id": "$page"})),
        call("get_ticket: with a linked page", "get_ticket", json!({"ticket_id": "$t1", "activity_limit": 3})),
        mt("unlink_doc: nothing else", "unlink_doc", json!({})),
        mt("unlink_doc: a ticket that does not exist", "unlink_doc", json!({"ticket_id": "TKT-99", "page_id": "$page"})),
        mt("unlink_doc: a page that does not exist", "unlink_doc", json!({"ticket_id": "$t1", "page_id": "nope"})),
        mt("unlink_doc: a page", "unlink_doc", json!({"ticket_id": "$t1", "page_id": "$page"})),
        mt("unlink_doc: the same page again", "unlink_doc", json!({"ticket_id": "$t1", "page_id": "$page"})),
    ]
}

/// ticket_items: the comments, the work log, the criteria, the sub-tasks, the test cases and the attachments.
/// `files` are real files the test made: a picture, a text, and a folder.
fn item_calls(png: &str, txt: &str, folder: &str) -> Vec<Call> {
    let with_picture = format!("Look: ![screen]({png}) and [notes]({txt})");
    vec![
        // --- the call itself
        call("items: no arguments", "ticket_items", json!({})),
        call("items: no item", "ticket_items", json!({"ticket_id": "$t1"})),
        call("items: no ticket", "ticket_items", json!({"item": "comment"})),
        call("items: an item unknown", "ticket_items", json!({"ticket_id": "$t1", "item": "label"})),
        call("items: an action unknown", "ticket_items", json!({"ticket_id": "$t1", "item": "comment", "action": "like"})),
        it("items: an action the item does not have", "$t1", "comment", json!({"action": "toggle", "item_id": "x"})),
        it("items: a criterion cannot be updated", "$t1", "criterion", json!({"action": "update", "item_id": "x"})),
        it("items: a sub-task cannot be restored", "$t1", "sub_task", json!({"action": "restore", "item_id": "x"})),
        it("items: a test case cannot be toggled", "$t1", "test_case", json!({"action": "toggle", "item_id": "x"})),
        it("items: a work log cannot be restored", "$t1", "work_log", json!({"action": "restore", "item_id": "x"})),
        it("items: an attachment cannot be deleted", "$t1", "attachment", json!({"action": "delete", "item_id": "x"})),
        it("items: a ticket that does not exist", "TKT-99", "comment", json!({"action": "add", "text": "hi", "author": "Claude"})),
        it("items: a comment without a text", "$t1", "comment", json!({"action": "add", "author": "Claude"})),
        it("items: a comment without an author", "$t1", "comment", json!({"action": "add", "text": "hi"})),
        it("items: a comment with a parameter of another item", "$t1", "comment", json!({"action": "add", "text": "hi", "author": "C", "log_kind": "investigation"})),
        it("items: a comment with several parameters of other items", "$t1", "comment", json!({"action": "add", "text": "hi", "author": "C", "title": "t", "pinned": true})),
        it("items: no action, no id: add", "$t1", "sub_task", json!({"text": "inferred add"})),
        // --- comments
        keep_at("comment: add", "ticket_items", it_arguments("$t1", "comment", json!({"action": "add", "text": "first", "author": "Claude"})), "c1", "/comments/0/id"),
        it("comment: add with a role", "$t1", "comment", json!({"action": "add", "text": "with a role", "author": "Claude", "role": "  Reviewer  "})),
        it("comment: add with a blank role", "$t1", "comment", json!({"action": "add", "text": "blank role", "author": "Claude", "role": "   "})),
        it("comment: add with a long role", "$t1", "comment", json!({"action": "add", "text": "long role", "author": "Claude", "role": "r".repeat(60)})),
        it("comment: add with a mention", "$t1", "comment", json!({"action": "add", "text": "cc @[Bao](member:$bao) and [[Login spec]]", "author": "Claude"})),
        it("comment: add as the user", "$t1", "comment", json!({"action": "add", "text": "from the user", "author": "user"})),
        it("comment: add with Markdown", "$t1", "comment", json!({"action": "add", "text": "# Title\n\n- a\n- b\n\n```py\nx = 1\n```\n[link](https://example.com/a)", "author": "Claude"})),
        it("comment: add an empty text", "$t1", "comment", json!({"action": "add", "text": "", "author": "Claude"})),
        it("comment: add a blank text", "$t1", "comment", json!({"action": "add", "text": "   ", "author": "Claude"})),
        // the longest text a comment holds, on a ticket that is deleted at once (it would be in every answer after)
        keep("items: a ticket for a long comment", "manage_ticket", json!({"action": "create", "project_id": "$p", "title": "Long"}), "long"),
        it("comment: add 50000 characters", "$long", "comment", json!({"action": "add", "text": "e".repeat(50000), "author": "Claude"})),
        it("comment: add 50001 characters", "$long", "comment", json!({"action": "add", "text": "e".repeat(50001), "author": "Claude"})),
        mt("items: delete the ticket with the long comment", "delete", json!({"ticket_id": "$long"})),
        it("comment: add with a file that does not exist", "$t1", "comment", json!({"action": "add", "text": "![x](/no/such/file.png)", "author": "Claude"})),
        it("comment: add with a relative path", "$t1", "comment", json!({"action": "add", "text": "![x](qa/shot.png)", "author": "Claude"})),
        it("comment: add with a picture and a document", "$t1", "comment", json!({"action": "add", "text": with_picture.clone(), "author": "Claude"})),
        it("comment: add with a link to code", "$t1", "comment", json!({"action": "add", "text": "[code](src/main.rs) and [web](https://example.com/x.png)", "author": "Claude"})),
        it("comment: add a number as the text", "$t1", "comment", json!({"action": "add", "text": 5, "author": "Claude"})),
        it("comment: add as another ticket's", "$t2", "comment", json!({"action": "add", "text": "on t2", "author": "Bao"})),
        it("comment: update without an id", "$t1", "comment", json!({"action": "update", "text": "x"})),
        it("comment: update without a text", "$t1", "comment", json!({"action": "update", "item_id": "$c1"})),
        it("comment: update", "$t1", "comment", json!({"action": "update", "item_id": "$c1", "text": "first, edited"})),
        it("comment: update an id that does not exist", "$t1", "comment", json!({"action": "update", "item_id": "wrong-id", "text": "x"})),
        it("comment: update an empty text", "$t1", "comment", json!({"action": "update", "item_id": "$c1", "text": ""})),
        it("comment: update with a file that does not exist", "$t1", "comment", json!({"action": "update", "item_id": "$c1", "text": "![x](/no/such/file.png)"})),
        it("comment: update on a ticket that does not exist", "TKT-99", "comment", json!({"action": "update", "item_id": "$c1", "text": "x"})),
        it("comment: delete without an id", "$t1", "comment", json!({"action": "delete"})),
        it("comment: delete an id that does not exist", "$t1", "comment", json!({"action": "delete", "item_id": "wrong-id"})),
        it("comment: delete", "$t1", "comment", json!({"action": "delete", "item_id": "$c1"})),
        it("comment: delete a comment that is already deleted", "$t1", "comment", json!({"action": "delete", "item_id": "$c1"})),
        call("comment: the thread without it", "get_ticket", json!({"ticket_id": "$t1", "view": "comments"})),
        it("comment: restore an id that does not exist", "$t1", "comment", json!({"action": "restore", "item_id": "wrong-id"})),
        it("comment: restore a comment that is not deleted", "$t1", "comment", json!({"action": "restore", "item_id": "$t1"})),
        it("comment: restore", "$t1", "comment", json!({"action": "restore", "item_id": "$c1"})),
        call("comment: the thread with it", "get_ticket", json!({"ticket_id": "$t1", "view": "comments"})),
        call("comment: the thread narrowed by id", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "comment_ids": ["$c1"]})),
        call("comment: the thread narrowed by an id that does not exist", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "comment_ids": ["nope"]})),
        call("comment: the thread narrowed by no ids", "get_ticket", json!({"ticket_id": "$t1", "view": "comments", "comment_ids": []})),
        // --- the work log
        it("work_log: add without a role", "$t1", "work_log", json!({"action": "add", "author": "Claude", "note": "n"})),
        it("work_log: add without a note", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Developer"})),
        it("work_log: add a role that does not exist", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Wizard", "note": "n"})),
        it("work_log: add a role in other case", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "developer", "note": "n"})),
        it("work_log: add a kind that does not exist", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Developer", "note": "n", "log_kind": "idea"})),
        it("work_log: add an empty note", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Developer", "note": ""})),
        it("work_log: add an empty author", "$t1", "work_log", json!({"action": "add", "author": "", "role": "Developer", "note": "n"})),
        it("work_log: add 20001 characters", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Developer", "note": "n".repeat(20001)})),
        it("work_log: add a branch that does not exist", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Developer", "note": "n", "linked_branch": "feat/none"})),
        it("work_log: add a test case that does not exist", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Developer", "note": "n", "linked_test_case": "TC-9"})),
        keep_at("work_log: add", "ticket_items", it_arguments("$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Developer", "note": "looked at the logs", "log_kind": "root_cause", "pinned": true})), "w1", "/work_log/0/id"),
        it("work_log: add with defaults", "$t1", "work_log", json!({"action": "add", "author": "PM", "role": "PM", "note": "Checked the links."})),
        it("work_log: add with a picture", "$t1", "work_log", json!({"action": "add", "author": "Claude", "role": "Tester", "note": with_picture.clone(), "log_kind": "fix_attempt"})),
        it("work_log: add with no action", "$t1", "work_log", json!({"author": "Claude", "role": "Other", "note": "no action given", "log_kind": "blocked"})),
        it("work_log: update with no action but an id", "$t1", "work_log", json!({"item_id": "$w1", "note": "updated by inference"})),
        it("work_log: update without an id", "$t1", "work_log", json!({"action": "update", "note": "x"})),
        it("work_log: update an id that does not exist", "$t1", "work_log", json!({"action": "update", "item_id": "nope", "note": "x"})),
        it("work_log: update", "$t1", "work_log", json!({"action": "update", "item_id": "$w1", "note": "rewritten", "pinned": false, "log_kind": "resolved"})),
        it("work_log: update a kind that does not exist", "$t1", "work_log", json!({"action": "update", "item_id": "$w1", "log_kind": "idea"})),
        it("work_log: update an empty note", "$t1", "work_log", json!({"action": "update", "item_id": "$w1", "note": ""})),
        it("work_log: update with no fields", "$t1", "work_log", json!({"action": "update", "item_id": "$w1"})),
        it("work_log: update a link that does not exist", "$t1", "work_log", json!({"action": "update", "item_id": "$w1", "linked_branch": "feat/none"})),
        it("work_log: update with a parameter it does not use", "$t1", "work_log", json!({"action": "update", "item_id": "$w1", "role": "PM"})),
        it("work_log: delete without an id", "$t1", "work_log", json!({"action": "delete"})),
        it("work_log: delete an id that does not exist", "$t1", "work_log", json!({"action": "delete", "item_id": "nope"})),
        it("work_log: delete", "$t1", "work_log", json!({"action": "delete", "item_id": "$w1"})),
        // --- criteria
        it("criterion: add without a text", "$t1", "criterion", json!({"action": "add"})),
        it("criterion: add an empty text", "$t1", "criterion", json!({"action": "add", "text": ""})),
        it("criterion: add 1001 characters", "$t1", "criterion", json!({"action": "add", "text": "c".repeat(1001)})),
        keep_at("criterion: add", "ticket_items", it_arguments("$t1", "criterion", json!({"action": "add", "text": "  Login fails with a clear message  "})), "ac1", "/acceptance_criteria/0/id"),
        it("criterion: add a second", "$t1", "criterion", json!({"action": "add", "text": "The field keeps its text"})),
        it("criterion: toggle without an id", "$t1", "criterion", json!({"action": "toggle"})),
        it("criterion: toggle an id that does not exist", "$t1", "criterion", json!({"action": "toggle", "item_id": "nope"})),
        it("criterion: toggle", "$t1", "criterion", json!({"action": "toggle", "item_id": "$ac1"})),
        it("criterion: toggle again", "$t1", "criterion", json!({"action": "toggle", "item_id": "$ac1"})),
        it("criterion: toggle with no action but an id", "$t1", "criterion", json!({"item_id": "$ac1"})),
        it("criterion: delete an id that does not exist", "$t1", "criterion", json!({"action": "delete", "item_id": "nope"})),
        it("criterion: delete", "$t1", "criterion", json!({"action": "delete", "item_id": "$ac1"})),
        // --- sub-tasks
        it("sub_task: add an empty text", "$t1", "sub_task", json!({"action": "add", "text": ""})),
        it("sub_task: add 501 characters", "$t1", "sub_task", json!({"action": "add", "text": "s".repeat(501)})),
        keep_at("sub_task: add", "ticket_items", it_arguments("$t1", "sub_task", json!({"action": "add", "text": "Confirm the spec"})), "st1", "/sub_tasks/0/id"),
        it("sub_task: toggle an id that does not exist", "$t1", "sub_task", json!({"action": "toggle", "item_id": "nope"})),
        it("sub_task: toggle", "$t1", "sub_task", json!({"action": "toggle", "item_id": "$st1"})),
        it("sub_task: delete an id that does not exist", "$t1", "sub_task", json!({"action": "delete", "item_id": "nope"})),
        it("sub_task: delete", "$t1", "sub_task", json!({"action": "delete", "item_id": "$st1"})),
        // --- test cases
        it("test_case: add without a title", "$t1", "test_case", json!({"action": "add"})),
        it("test_case: add an empty title", "$t1", "test_case", json!({"action": "add", "title": ""})),
        it("test_case: add a status that does not exist", "$t1", "test_case", json!({"action": "add", "title": "x", "status": "green"})),
        it("test_case: add 301 characters", "$t1", "test_case", json!({"action": "add", "title": "t".repeat(301)})),
        it("test_case: add an assignee that is not a member", "$t1", "test_case", json!({"action": "add", "title": "x", "assignee": "nobody"})),
        it("test_case: add with a parameter of another item", "$t1", "test_case", json!({"action": "add", "title": "x", "note": "n"})),
        keep_at("test_case: add", "ticket_items", it_arguments("$t1", "test_case", json!({"action": "add", "title": "It runs", "description": "Steps", "expected_result": "ok", "notes": "n", "assignee": "$bao"})), "tc1", "/test_cases/0/id"),
        it("test_case: add a second, already running", "$t1", "test_case", json!({"action": "add", "title": "Second", "status": "running"})),
        it("test_case: add a third, passed with a proof", "$t1", "test_case", json!({"action": "add", "title": "Third", "status": "pass", "proof": "Not provable: no screen"})),
        it("test_case: add with a picture", "$t1", "test_case", json!({"action": "add", "title": "Fourth", "proof": format!("![shot]({png})"), "notes": format!("see [log]({txt})")})),
        it("test_case: add a proof with a file that does not exist", "$t1", "test_case", json!({"action": "add", "title": "Fifth", "proof": "![shot](/no/such/file.png)"})),
        it("test_case: update without an id", "$t1", "test_case", json!({"action": "update", "status": "pass"})),
        it("test_case: update an id that does not exist", "$t1", "test_case", json!({"action": "update", "item_id": "TC-99", "status": "pass"})),
        it("test_case: update by code", "$t1", "test_case", json!({"action": "update", "item_id": "TC-1", "status": "pass", "proof": "log.txt"})),
        it("test_case: update by id", "$t1", "test_case", json!({"action": "update", "item_id": "$tc1", "status": "fail", "title": "It runs fast"})),
        it("test_case: update to running", "$t1", "test_case", json!({"action": "update", "item_id": "TC-2", "status": "running"})),
        it("test_case: update a status that does not exist", "$t1", "test_case", json!({"action": "update", "item_id": "TC-1", "status": "green"})),
        it("test_case: update an empty title", "$t1", "test_case", json!({"action": "update", "item_id": "TC-1", "title": ""})),
        it("test_case: update an assignee that is not a member", "$t1", "test_case", json!({"action": "update", "item_id": "TC-1", "assignee": "nobody"})),
        it("test_case: update all the fields", "$t1", "test_case", json!({"action": "update", "item_id": "TC-1", "description": "d", "expected_result": "e", "notes": "n", "proof": "p", "assignee": "$ha", "status": "pass"})),
        it("test_case: update with no action but an id", "$t1", "test_case", json!({"item_id": "TC-2", "notes": "no action"})),
        it("test_case: update with a parameter it does not use", "$t1", "test_case", json!({"action": "update", "item_id": "TC-1", "text": "x"})),
        it("test_case: delete without an id", "$t1", "test_case", json!({"action": "delete"})),
        it("test_case: delete an id that does not exist", "$t1", "test_case", json!({"action": "delete", "item_id": "TC-99"})),
        it("test_case: delete by code", "$t1", "test_case", json!({"action": "delete", "item_id": "TC-3"})),
        it("test_case: add after a delete", "$t1", "test_case", json!({"action": "add", "title": "After the delete"})),
        mt("update: done with a test case that is not passed", "update", json!({"ticket_id": "$t1", "block_done_if_tcs_incomplete": true, "block_done_if_acs_incomplete": false, "status": "done"})),
        // --- attachments
        it("attachment: add without a path", "$t2", "attachment", json!({"action": "add"})),
        it("attachment: add with a parameter it does not use", "$t2", "attachment", json!({"action": "add", "path": txt, "title": "x"})),
        it("attachment: add a type the board does not store", "$t2", "attachment", json!({"action": "add", "path": "/tmp/tool.exe"})),
        it("attachment: add a file with no extension", "$t2", "attachment", json!({"action": "add", "path": "/tmp/README"})),
        it("attachment: add a file that does not exist", "$t2", "attachment", json!({"action": "add", "path": "/no/such/file.png"})),
        it("attachment: add a relative path", "$t2", "attachment", json!({"action": "add", "path": "qa/shot.png"})),
        it("attachment: add a folder", "$t2", "attachment", json!({"action": "add", "path": format!("{folder}/pics.png")})),
        it("attachment: add a picture", "$t2", "attachment", json!({"action": "add", "path": png, "text": "  The login screen  "})),
        it("attachment: add a text file as someone", "$t2", "attachment", json!({"action": "add", "path": txt, "author": "Reviewer"})),
        it("attachment: add without a comment", "$t2", "attachment", json!({"action": "add", "path": png, "post": false})),
        it("attachment: add to a ticket that does not exist", "TKT-99", "attachment", json!({"action": "add", "path": png})),
        it("attachment: add with no action", "$t2", "attachment", json!({"path": txt, "text": "no action given"})),
        // --- batches
        it("items: a batch of comments", "$t3", "comment", json!({"action": "add", "author": "Claude", "items": [{"text": "one"}, {"text": "two"}, {"author": "Bao"}, {"text": "four", "author": "Bao"}]})),
        it("items: a batch with different actions each", "$t3", "sub_task", json!({"items": [{"text": "step 1"}, {"text": "step 2"}]})),
        it("items: a batch that is not a list", "$t3", "comment", json!({"action": "add", "author": "Claude", "items": "text"})),
        it("items: a batch of nothing", "$t3", "comment", json!({"action": "add", "author": "Claude", "items": []})),
        it("items: a batch with an item that is not an object", "$t3", "sub_task", json!({"action": "add", "items": [{"text": "ok"}, "not an object", 5, null]})),
        it("items: a batch of 26", "$t3", "sub_task", json!({"action": "add", "items": (0..26).map(|i| json!({"text": format!("s{i}")})).collect::<Vec<_>>()})),
        it("items: a batch of 25", "$t3", "criterion", json!({"action": "add", "items": (0..25).map(|i| json!({"text": format!("c{i}")})).collect::<Vec<_>>()})),
        it("items: a batch with a parameter of another item", "$t3", "comment", json!({"action": "add", "author": "C", "items": [{"text": "a", "log_kind": "blocked"}]})),
        it("items: a batch from a text", "$t3", "sub_task", json!({"action": "add", "items": "[{\"text\": \"from text\"}]"})),
        it("items: a batch that updates", "$t3", "test_case", json!({"action": "add", "items": [{"title": "A"}, {"title": "B", "status": "pass"}, {"title": ""}]})),
        it("items: a batch of updates by code", "$t3", "test_case", json!({"action": "update", "items": [{"item_id": "TC-1", "status": "pass"}, {"item_id": "TC-9", "status": "pass"}, {"item_id": "TC-2", "status": "fail"}]})),
        it("items: a batch that infers the action", "$t3", "test_case", json!({"items": [{"item_id": "TC-1", "notes": "inferred update"}, {"title": "inferred add"}]})),
        it("items: a batch with an action of its own", "$t3", "test_case", json!({"items": [{"action": "delete", "item_id": "TC-1"}]})),
        it("items: a batch on a ticket that does not exist", "TKT-99", "sub_task", json!({"action": "add", "items": [{"text": "a"}]})),
    ]
}

/// ticket_branches on tickets whose project has no repository linked.
fn branch_calls() -> Vec<Call> {
    vec![
        call("branches: no arguments", "ticket_branches", json!({})),
        call("branches: no action", "ticket_branches", json!({"ticket_id": "$t1"})),
        call("branches: an action unknown", "ticket_branches", json!({"ticket_id": "$t1", "action": "merge"})),
        call("branches: no ticket", "ticket_branches", json!({"action": "add", "name": "x"})),
        br("branches: add without a name", "$t1", "add", json!({})),
        br("branches: add a parameter it does not use", "$t1", "add", json!({"name": "x", "force": true})),
        br("branches: add two parameters it does not use", "$t1", "add", json!({"name": "x", "force": true, "remove_worktree": false})),
        br("branches: add a ticket that does not exist", "TKT-99", "add", json!({"name": "x"})),
        keep_at("branches: add", "ticket_branches", json!({"ticket_id": "$t1", "action": "add", "name": "feat/TKT-1-login"}), "b1", "/branches/0/id"),
        br("branches: add the same name again", "$t1", "add", json!({"name": "feat/TKT-1-login"})),
        br("branches: add with everything", "$t1", "add", json!({"name": "feat/second", "branch_from": "develop", "status": "stale", "pr_url": "https://example.com/pr/2", "commit_hash": "abc123", "linked_ticket_id": "$t2", "ahead_count": 3, "behind_count": 1})),
        br("branches: add a status that does not exist", "$t1", "add", json!({"name": "x", "status": "closed"})),
        br("branches: add a negative ahead count", "$t1", "add", json!({"name": "x", "ahead_count": -1})),
        br("branches: add a negative behind count", "$t1", "add", json!({"name": "x", "behind_count": -1})),
        br("branches: add a count that is not a number", "$t1", "add", json!({"name": "x", "ahead_count": "many"})),
        br("branches: add a count from text", "$t1", "add", json!({"name": "feat/counts", "ahead_count": "2", "behind_count": 2.0})),
        br("branches: add an empty name", "$t1", "add", json!({"name": ""})),
        br("branches: add with a worktree and no repository", "$t1", "add", json!({"name": "feat/wt", "create_worktree": true})),
        br("branches: add with a worktree path and no repository", "$t1", "add", json!({"name": "feat/wt2", "worktree_path": "../wt/x"})),
        br("branches: add adopting a branch with no repository", "$t1", "add", json!({"name": "feat/adopted", "adopt": true})),
        br("branches: add a baseline", "$t1", "add", json!({"name": "main", "status": "baseline"})),
        br("branches: update without a branch", "$t1", "update", json!({"name": "x"})),
        br("branches: update a branch that does not exist", "$t1", "update", json!({"branch": "feat/none", "name": "x"})),
        br("branches: update a parameter it does not use", "$t1", "update", json!({"branch": "feat/second", "create_worktree": true})),
        br("branches: update with no fields", "$t1", "update", json!({"branch": "feat/second"})),
        br("branches: update by name", "$t1", "update", json!({"branch": "feat/second", "pr_url": "https://example.com/pr/3", "status": "open"})),
        br("branches: update by id", "$t1", "update", json!({"branch": "$b1", "commit_hash": "def456", "ahead_count": 5, "behind_count": 0})),
        br("branches: rename", "$t1", "update", json!({"branch": "feat/second", "name": "feat/renamed"})),
        br("branches: rename to a name in use", "$t1", "update", json!({"branch": "feat/renamed", "name": "feat/TKT-1-login"})),
        br("branches: update a status that does not exist", "$t1", "update", json!({"branch": "$b1", "status": "closed"})),
        br("branches: mark merged", "$t1", "update", json!({"branch": "$b1", "status": "merged"})),
        br("branches: update a negative count", "$t1", "update", json!({"branch": "$b1", "ahead_count": -1})),
        br("branches: update another ticket's link", "$t1", "update", json!({"branch": "$b1", "linked_ticket_id": "TKT-99"})),
        br("branches: update on a ticket that does not exist", "TKT-99", "update", json!({"branch": "$b1", "name": "x"})),
        br("branches: checkout without a branch", "$t1", "checkout", json!({})),
        br("branches: checkout without a repository", "$t1", "checkout", json!({"branch": "$b1"})),
        br("branches: checkout a branch that does not exist", "$t1", "checkout", json!({"branch": "feat/none"})),
        br("branches: checkout a parameter it does not use", "$t1", "checkout", json!({"branch": "$b1", "force": true})),
        br("branches: delete without a branch", "$t1", "delete", json!({})),
        br("branches: delete a branch that does not exist", "$t1", "delete", json!({"branch": "feat/none"})),
        br("branches: delete a parameter it does not use", "$t1", "delete", json!({"branch": "$b1", "name": "x"})),
        br("branches: delete asking for git without a repository", "$t1", "delete", json!({"branch": "feat/counts", "delete_git_branch": true, "force": true, "remove_worktree": true})),
        br("branches: delete by name", "$t1", "delete", json!({"branch": "feat/renamed"})),
        br("branches: delete by id", "$t1", "delete", json!({"branch": "$b1"})),
        br("branches: delete on a ticket that does not exist", "TKT-99", "delete", json!({"branch": "$b1"})),
        call("branches: the ticket at the end", "get_ticket", json!({"ticket_id": "$t1", "activity_limit": 4})),
    ]
}

#[tokio::test]
async fn the_ticket_tools_answer_as_python_does() {
    let s = common::start().await;
    let files = tempfile::Builder::new().prefix("kbfiles").tempdir().expect("a folder for the files");
    let png = files.path().join("shot.png");
    // the first bytes of a PNG: the board stores a picture as it is
    std::fs::write(&png, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89").expect("a picture");
    let txt = files.path().join("notes.txt");
    std::fs::write(&txt, "stack trace\nline 2\n").expect("a text");
    std::fs::create_dir(files.path().join("pics.png")).expect("a folder named like a picture");
    let (png, txt) = (png.to_string_lossy().into_owned(), txt.to_string_lossy().into_owned());
    let folder = files.path().to_string_lossy().into_owned();

    let mut run = Run::new(s.mcp());
    run.run(ticket_setup()).await;
    run.run(list_and_get_on_nothing()).await;
    run.run(create_tickets()).await;
    run.run(list_and_get()).await;
    run.run(update_tickets()).await;
    run.run(reopen_pend_resume()).await;
    run.run(relations()).await;

    // Docs pages to link (the docs tools are not ported yet: the pages are made through the REST API)
    let c = s.client();
    let page = c.post(&format!("/projects/{}/docs/pages", run.id("p")), json!({"title": "Login spec"})).await;
    page.assert_status(201);
    run.ids.insert("page".into(), page.json()["id"].as_str().expect("a page id").to_string());
    let page = c.post(&format!("/projects/{}/docs/pages", run.id("p2")), json!({"title": "Beta notes"})).await;
    page.assert_status(201);
    run.ids.insert("page2".into(), page.json()["id"].as_str().expect("a page id").to_string());
    run.run(doc_links()).await;
    // two golden files, so that none of them is large
    let first = std::mem::take(&mut run.got);
    run.run(item_calls(&png, &txt, &folder)).await;
    run.run(branch_calls()).await;
    let second = std::mem::take(&mut run.got);
    let dir = s.dir().to_string_lossy().into_owned();
    let mut folders = vec![(folder, "<files>"), (dir.clone(), "<dir>")];
    if let Ok(real) = std::fs::canonicalize(&dir) {
        folders.push((real.to_string_lossy().into_owned(), "<dir>"));
    }
    // the longer folder first: the server's folder may hold the other
    folders.sort_by_key(|(folder, _)| std::cmp::Reverse(folder.len()));
    // one value normalized as a whole, so that an id is the same `<uuid:N>` in every call, then split in two
    let mut all = first;
    all.extend(second.clone());
    let normalized = normalize(&scrub(&Value::Object(all), &folders));
    let normalized = normalized.as_object().expect("an object");
    let (mut tickets, mut items) = (Map::new(), Map::new());
    for (name, reply) in normalized {
        let into = if second.contains_key(name) { &mut items } else { &mut tickets };
        into.insert(name.clone(), reply.clone());
    }
    check_golden("mcp_tool_calls_tickets.json", &tickets);
    check_golden("mcp_tool_calls_items.json", &items);
}

// ---------------------------------------------------------------------------------------------------------------
// The Idea Space tools (listed with KANBAN_MCP_IDEA_TOOLS=1)
// ---------------------------------------------------------------------------------------------------------------

fn idea_calls_before_the_page() -> Vec<Call> {
    vec![
        keep("setup: project", "manage_project", json!({"action": "create", "name": "Ideas", "prefix": "IDQ"}), "p"),
        keep("setup: other project", "manage_project", json!({"action": "create", "name": "Other", "prefix": "OTH"}), "p2"),
        call("list: no ideas", "list_idea_tickets", json!({})),
        call("list: no ideas in a project", "list_idea_tickets", json!({"project_id": "$p"})),
        call("list: a project that does not exist", "list_idea_tickets", json!({"project_id": "nope"})),
        call("list: a stage unknown", "list_idea_tickets", json!({"stage": "someday"})),
        call("list: a stage in other case", "list_idea_tickets", json!({"stage": "Inbox"})),
        call("list: project_id a number", "list_idea_tickets", json!({"project_id": 5})),
        call("list: unknown argument", "list_idea_tickets", json!({"limit": 5})),
        call("list: q a number", "list_idea_tickets", json!({"q": 5})),
        call("get: no arguments", "get_idea_ticket", json!({})),
        call("get: an idea that does not exist", "get_idea_ticket", json!({"ticket_id": "IDEA-999"})),
        call("get: ticket_id a number", "get_idea_ticket", json!({"ticket_id": 1})),
        call("get: unknown argument", "get_idea_ticket", json!({"ticket_id": "IDEA-1", "project_id": "x"})),
        call("assumptions: no arguments", "list_idea_assumptions", json!({})),
        call("assumptions: an idea that does not exist", "list_idea_assumptions", json!({"ticket_id": "IDEA-999"})),
        call("trail: no arguments", "get_idea_activity_trail", json!({})),
        call("trail: an idea that does not exist", "get_idea_activity_trail", json!({"ticket_id": "IDEA-999"})),
        call("create: no arguments", "create_idea_ticket", json!({})),
        call("create: an unknown argument", "create_idea_ticket", json!({"title": "x", "stage": "ready"})),
        call("create: title a number", "create_idea_ticket", json!({"title": 5})),
        call("create: tags that are not text", "create_idea_ticket", json!({"title": "x", "tags": [1, 2]})),
        call("create: a project that does not exist", "create_idea_ticket", json!({"title": "x", "project_id": "nope"})),
        call("create: an empty project id", "create_idea_ticket", json!({"title": "x", "project_id": ""})),
        keep("create: a title alone", "create_idea_ticket", json!({"title": "Dark mode"}), "i1"),
        keep(
            "create: every field",
            "create_idea_ticket",
            json!({"title": "Split the card renderer", "description": "It is 480 lines.\n\n> quoted", "project_id": "$p",
                   "why": "Out of scope for KAN-231", "ticket_id": "KAN-231", "tags": ["perf", "refactor"]}),
            "i2",
        ),
        keep("create: with a reason only", "create_idea_ticket", json!({"title": "Offline mode", "project_id": "$p", "why": "Asked twice", "tags": "[\"sync\"]"}), "i3"),
        keep("create: an empty reason and ticket", "create_idea_ticket", json!({"title": "Another", "project_id": "$p2", "why": "", "ticket_id": ""}), "i4"),
        call("create: an empty title", "create_idea_ticket", json!({"title": ""})),
        call("create: a blank title", "create_idea_ticket", json!({"title": "   "})),
        call("create: a long title", "create_idea_ticket", json!({"title": "t".repeat(400)})),
        call("create: null counts as left out", "create_idea_ticket", json!({"title": "Nulls", "description": null, "project_id": null})),
        call("get: the first", "get_idea_ticket", json!({"ticket_id": "$i1"})),
        call("get: the second", "get_idea_ticket", json!({"ticket_id": "$i2"})),
        call("get: by a number in other case", "get_idea_ticket", json!({"ticket_id": "idea-1"})),
        call("assumptions: none yet", "list_idea_assumptions", json!({"ticket_id": "$i2"})),
        call("trail: the first", "get_idea_activity_trail", json!({"ticket_id": "$i2"})),
        call("list: every idea", "list_idea_tickets", json!({})),
        call("list: one project", "list_idea_tickets", json!({"project_id": "$p"})),
        call("list: the other project", "list_idea_tickets", json!({"project_id": "$p2"})),
        call("list: by stage", "list_idea_tickets", json!({"stage": "inbox"})),
        call("list: by a stage with no ideas", "list_idea_tickets", json!({"stage": "building"})),
        call("list: by a project and a stage", "list_idea_tickets", json!({"project_id": "$p", "stage": "inbox"})),
        call("list: by words", "list_idea_tickets", json!({"q": "card renderer"})),
        call("list: by words that are not all there", "list_idea_tickets", json!({"q": "card nothing"})),
        call("list: by words in other case", "list_idea_tickets", json!({"q": "DARK"})),
        call("list: by blank words", "list_idea_tickets", json!({"q": "  "})),
        call("list: an empty project id lists every idea", "list_idea_tickets", json!({"project_id": ""})),
    ]
}

fn idea_calls_after_the_changes() -> Vec<Call> {
    vec![
        call("assumptions: with two", "list_idea_assumptions", json!({"ticket_id": "$i2"})),
        call("get: with assumptions", "get_idea_ticket", json!({"ticket_id": "$i2"})),
        call("trail: with moves", "get_idea_activity_trail", json!({"ticket_id": "$i2"})),
        call("list: closest to ready first", "list_idea_tickets", json!({"project_id": "$p"})),
        call("list: exploring", "list_idea_tickets", json!({"stage": "exploring"})),
        call("list: words in an assumption", "list_idea_tickets", json!({"q": "pay"})),
    ]
}

#[tokio::test]
async fn the_idea_tools_answer_as_python_does() {
    let s = common::start_with(testkit::Options {
        env: vec![("KANBAN_MCP_IDEA_TOOLS".into(), "1".into())],
        ..testkit::Options::default()
    })
    .await;
    let mut run = Run::new(s.mcp());
    run.run(idea_calls_before_the_page()).await;
    // an assumption and a stage move: only people make them, so through the REST API
    let c = s.client();
    let idea = run.id("i2");
    for body in [json!({"text": "They pay", "impact": "high"}), json!({"text": "They come back", "impact": "low"})] {
        c.post(&format!("/api/idea-tickets/{idea}/assumption-records"), body).await.assert_status(200);
    }
    c.post(&format!("/api/idea-tickets/{idea}/stage"), json!({"to": "exploring"})).await.assert_status(200);
    run.run(idea_calls_after_the_changes()).await;
    let normalized = normalize(&Value::Object(run.got));
    check_golden("mcp_tool_calls_ideas.json", normalized.as_object().expect("an object"));
}
