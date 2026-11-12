//! The stdio program against the Python `mcp_stdio.py`: the same lines are written to both (each with a temporary
//! config folder, database and log folder of its own) and what they write back is compared, line for line: what
//! is served before `initialize`, lines that are not messages, the tools, and how the program ends when its input
//! closes. Standard output carries JSON-RPC and nothing else.

mod common;

use common::{Which, python_available, spawn};
use serde_json::{Value, json};
use testkit::normalize;

const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":10,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"stdio-test","version":"0"}}}"#;

/// The lines of the session: a name, the line, and the id of the reply to wait for (a line that gets none has none).
fn script() -> Vec<(&'static str, &'static str, Option<Value>)> {
    vec![
        ("ping before initialize", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, Some(json!(1))),
        ("a request before initialize", r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, Some(json!(2))),
        (
            "a tool call before initialize",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_projects","arguments":{}}}"#,
            Some(json!(3)),
        ),
        ("not JSON", "this is not JSON", None),
        ("an empty line", "", None),
        ("JSON that is no message", "{}", None),
        ("a batch", r#"[{"jsonrpc":"2.0","id":4,"method":"ping"},{"jsonrpc":"2.0","id":5,"method":"ping"}]"#, None),
        ("a notification before initialize", r#"{"jsonrpc":"2.0","method":"notifications/roots/list_changed"}"#, None),
        (
            "initialize without clientInfo",
            r#"{"jsonrpc":"2.0","id":6,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}"#,
            Some(json!(6)),
        ),
        ("still not initialized", r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#, Some(json!(7))),
        ("initialize", INITIALIZE, Some(json!(10))),
        ("a request right after initialize", r#"{"jsonrpc":"2.0","id":11,"method":"resources/list"}"#, Some(json!(11))),
        ("notifications/initialized", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, None),
        (
            "get_projects on a new board",
            r#"{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"get_projects","arguments":{}}}"#,
            Some(json!(12)),
        ),
        (
            "create a project",
            r#"{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"manage_project","arguments":{"action":"create","name":"Over stdio","prefix":"std"}}}"#,
            Some(json!(13)),
        ),
        (
            "get_projects with one project",
            r#"{"jsonrpc":"2.0","id":"fourteen","method":"tools/call","params":{"name":"get_projects"}}"#,
            Some(json!("fourteen")),
        ),
        (
            "a tool refuses",
            r#"{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"manage_project","arguments":{"action":"update","project_id":"nope","name":"x"}}}"#,
            Some(json!(15)),
        ),
        (
            "bad arguments",
            r#"{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"get_projects","arguments":{"titel":1}}}"#,
            Some(json!(16)),
        ),
        (
            "an unknown tool",
            r#"{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}"#,
            Some(json!(17)),
        ),
        ("an unknown method", r#"{"jsonrpc":"2.0","id":18,"method":"foo/bar"}"#, Some(json!(18))),
        ("prompts/list", r#"{"jsonrpc":"2.0","id":19,"method":"prompts/list"}"#, Some(json!(19))),
        (
            "resources/templates/list",
            r#"{"jsonrpc":"2.0","id":20,"method":"resources/templates/list"}"#,
            Some(json!(20)),
        ),
        (
            "resources/read",
            r#"{"jsonrpc":"2.0","id":21,"method":"resources/read","params":{"uri":"file:///x"}}"#,
            Some(json!(21)),
        ),
        (
            "logging/setLevel",
            r#"{"jsonrpc":"2.0","id":22,"method":"logging/setLevel","params":{"level":"debug"}}"#,
            Some(json!(22)),
        ),
        ("a request whose id is no id", r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#, None),
        ("a response to nothing", r#"{"jsonrpc":"2.0","id":99,"result":{}}"#, None),
        ("an error to nothing", r#"{"jsonrpc":"2.0","id":98,"error":{"code":1,"message":"x"}}"#, None),
        (
            "cancelling nothing",
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":12345}}"#,
            None,
        ),
        ("an unknown notification", r#"{"jsonrpc":"2.0","method":"notifications/whatever"}"#, None),
        (
            "a progress notification",
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":0.5}}"#,
            None,
        ),
        ("not JSON, after initialize", "{oops", None),
        (
            "initialize again",
            r#"{"jsonrpc":"2.0","id":23,"method":"initialize","params":{"protocolVersion":"1999-01-01","capabilities":{},"clientInfo":{"name":"again","version":"1"}}}"#,
            Some(json!(23)),
        ),
        (
            "accented text comes back as it is",
            r#"{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"manage_project","arguments":{"action":"create","name":"Hà Nội ☕","prefix":"HN"}}}"#,
            Some(json!(24)),
        ),
    ]
}

/// The whole session: for each line of the script what was written back, then the tool list, then the end.
fn session(which: Which) -> (Vec<(&'static str, String)>, Value, (Option<i32>, Vec<String>, String)) {
    let mut program = spawn(which, &[], &[]);
    let mut steps = Vec::new();
    for (name, line, reply_id) in script() {
        let got = program.exchange(line, reply_id);
        // as text: the order of the keys is part of what is written
        steps.push((name, normalize(&Value::Array(got)).to_string()));
    }
    let tools = program.exchange(r#"{"jsonrpc":"2.0","id":30,"method":"tools/list"}"#, Some(json!(30)));
    let tools = tools.into_iter().next().expect("the tool list");
    // keep the folder until the log is read
    let log_dir = program.log_dir();
    let log = std::fs::read_dir(&log_dir).map(|d| d.count()).unwrap_or(0);
    assert!(log > 0, "{which:?} wrote no log file in {}", log_dir.display());
    (steps, tools, program.finish())
}

#[test]
fn the_rust_program_answers_each_line_as_the_python_program_does() {
    if !python_available() {
        eprintln!("SKIPPED: no Python virtualenv to compare with");
        return;
    }
    let python = std::thread::spawn(|| session(Which::Python));
    let (rust_steps, rust_tools, rust_end) = session(Which::Rust);
    let (python_steps, python_tools, python_end) = python.join().expect("the Python session");

    if std::env::var("KANBAN_SHOW_STDIO").is_ok() {
        for (name, got) in &python_steps {
            eprintln!("### {name}\n    {}", got.chars().take(700).collect::<String>());
        }
        eprintln!("### end: {python_end:?}");
    }
    let mut wrong = Vec::new();
    for ((name, python), (_, rust)) in python_steps.iter().zip(&rust_steps) {
        if python != rust {
            let cut = |v: &String| v.chars().take(900).collect::<String>();
            wrong.push(format!("--- {name}\n python: {}\n   rust: {}", cut(python), cut(rust)));
        }
    }
    assert!(wrong.is_empty(), "{} lines are answered differently:\n{}", wrong.len(), wrong.join("\n"));

    // the tool list: Rust lists the tools that are ported, each exactly as Python lists it, in its order
    let python_tools = python_tools["result"]["tools"].as_array().expect("tools").clone();
    let rust_tools = rust_tools["result"]["tools"].as_array().expect("tools").clone();
    assert!(!rust_tools.is_empty());
    // (compared as text: the order of the keys counts)
    let python_texts: Vec<String> = python_tools.iter().map(Value::to_string).collect();
    let mut at = 0;
    for tool in &rust_tools {
        let text = tool.to_string();
        let found = python_texts[at..].iter().position(|python| *python == text);
        at += found
            .unwrap_or_else(|| panic!("{} is not listed by Python like this, or not in this order", tool["name"]))
            + 1;
    }

    // the input closed: both end at once, with success and nothing more on standard output
    assert_eq!(rust_end.0, python_end.0, "exit codes: rust {rust_end:?}, python {python_end:?}");
    assert_eq!(rust_end.0, Some(0));
    assert_eq!((rust_end.1.len(), python_end.1.len()), (0, 0), "{rust_end:?} {python_end:?}");
}
