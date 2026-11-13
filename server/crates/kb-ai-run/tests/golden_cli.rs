//! The pure functions of `cli` against what the Python module gave (`contract/golden/ai_cli.json`, made by
//! `gen_ai_cli.py`): command lines on each platform branch, `looks_like_cli`, the CLI's environment, limit messages
//! (in several zones of the computer, across DST, with the clock frozen), tool calls as step texts, test counts.

mod common;

use chrono::{DateTime, Utc};
use kb_ai_run::cli;
use kb_base::pyjson;
use serde_json::{Value, json};

fn golden() -> Value {
    common::golden("ai_cli.json")
}

fn cases(g: &Value, name: &str) -> Vec<Value> {
    let cases = g[name].as_array().unwrap_or_else(|| panic!("{name}")).clone();
    assert!(!cases.is_empty(), "{name}");
    cases
}

fn texts(value: &Value) -> Vec<String> {
    value.as_array().expect("a list").iter().map(|a| a.as_str().expect("text").to_string()).collect()
}

fn utc(text: &str) -> DateTime<Utc> {
    kb_ai::store::parse_iso(Some(text)).expect("a time").with_timezone(&Utc)
}

fn zone(case: &Value) -> chrono_tz::Tz {
    case["local"].as_str().expect("zone").parse().expect("a zone chrono-tz knows")
}

#[test]
fn spill_long_args_builds_the_command_line_of_each_platform_branch() {
    let g = golden();
    for platform in ["linux", "darwin", "win32"] {
        assert_eq!(json!(cli::max_command_chars(platform == "win32")), g["max_command_chars"][platform]);
    }
    for case in cases(&g, "spill") {
        let args = texts(&case["args"]);
        let windows = case["platform"] == "win32";
        let max = usize::try_from(case["max_chars"].as_u64().expect("max")).expect("usize");
        let on_stdin = case["prompt_on_stdin"].as_bool().expect("bool");
        let (out, stdin_text, folder) = cli::spill_long_args_with(&args, on_stdin, windows, max).expect("spill");
        let mut files = serde_json::Map::new();
        let shown: Vec<String> = match &folder {
            Some(folder) => {
                let name = std::path::Path::new(folder).file_name().expect("name").to_string_lossy().into_owned();
                assert!(name.starts_with("kanban-cli-"), "{name}");
                let mut names: Vec<_> =
                    std::fs::read_dir(folder).expect("folder").flatten().map(|e| e.file_name()).collect();
                names.sort();
                for name in names {
                    let text = std::fs::read_to_string(std::path::Path::new(folder).join(&name)).expect("file");
                    files.insert(name.to_string_lossy().into_owned(), json!(text));
                }
                std::fs::remove_dir_all(folder).expect("remove");
                out.iter().map(|a| a.replace(folder.as_str(), "<TEMP>")).collect()
            }
            None => out,
        };
        let what = format!("{} max {max} stdin {on_stdin}: {:?}", case["platform"], args);
        assert_eq!(json!(shown), case["out"], "{what}");
        assert_eq!(json!(stdin_text), case["stdin"], "{what}");
        assert_eq!(if folder.is_some() { Value::Object(files) } else { Value::Null }, case["files"], "{what}");
    }
    for case in cases(&g, "list2cmdline") {
        assert_eq!(json!(cli::list2cmdline(&texts(&case["args"]))), case["out"], "{}", case["args"]);
    }
}

#[test]
fn looks_like_cli_wants_the_cli_and_an_output_flag_on_the_command_line() {
    for case in cases(&golden(), "looks_like_cli") {
        let cmd = case["cmd"].as_str().expect("cmd");
        assert_eq!(json!(cli::command_looks_like_cli(cmd, case["binary"].as_str())), case["out"], "{case}");
    }
}

#[test]
fn child_env_drops_the_session_variables_and_sets_the_timeout() {
    for case in cases(&golden(), "child_env") {
        let pairs = |v: &Value| -> Vec<(String, String)> {
            v.as_array()
                .expect("pairs")
                .iter()
                .map(|p| (p[0].as_str().expect("k").into(), p[1].as_str().expect("v").into()))
                .collect()
        };
        let got = cli::child_env_of(pairs(&case["env"]), case["pct"].as_i64());
        assert_eq!(got, pairs(&case["out"]), "{case}");
    }
}

#[test]
fn limit_messages_give_the_line_and_the_wait() {
    let g = golden();
    for case in cases(&g, "rate_limit_line") {
        assert_eq!(json!(cli::rate_limit_line(case["text"].as_str())), case["out"], "{}", case["text"]);
    }
    for case in cases(&g, "rate_limit_wait") {
        let epoch = case["epoch"].as_f64().expect("epoch");
        let now = DateTime::<Utc>::from_timestamp(epoch as i64, 0).expect("now");
        let got = cli::rate_limit_wait_at(case["text"].as_str(), epoch, now, &zone(&case));
        assert_eq!(json!(got), case["out"], "{} in {}", case["text"], case["local"]);
    }
}

#[test]
fn reset_wait_reads_the_time_in_the_messages_zone_or_the_computers() {
    let cases = cases(&golden(), "reset_wait");
    assert!(cases.len() > 1000);
    let mut some = 0;
    for case in cases {
        let (text, now) = (case["text"].as_str().expect("text"), case["now"].as_str().expect("now"));
        let got = cli::reset_wait_in(text, utc(now), &zone(&case));
        some += usize::from(got.is_some());
        assert_eq!(json!(got), case["out"], "{text:?} at {now}, computer in {}", case["local"]);
    }
    assert!(some > 400, "{some} with a time");
}

#[test]
fn tool_calls_tests_and_results_read_as_in_python() {
    let g = golden();
    for case in cases(&g, "short") {
        let n = usize::try_from(case["n"].as_u64().expect("n")).expect("usize");
        assert_eq!(json!(cli::short(case["text"].as_str().expect("text"), n)), case["out"], "{case}");
    }
    for case in cases(&g, "describe_tool") {
        let input = case["input"].as_object().expect("input");
        let (kind, text, change) =
            cli::describe_tool(case["name"].as_str().expect("name"), input, case["cwd"].as_str().expect("cwd"))
                .expect("no raise");
        let got = json!([kind, text, change]);
        assert_eq!(got, case["out"], "{} {}", case["name"], case["input"]);
        assert_eq!(pyjson::dumps(&got), pyjson::dumps(&case["out"]), "{} (order)", case["name"]);
    }
    for case in cases(&g, "parse_tests") {
        let got = json!(cli::parse_tests(case["output"].as_str().expect("output")));
        assert_eq!(got, case["out"], "{}", case["output"]);
        assert_eq!(pyjson::dumps(&got), pyjson::dumps(&case["out"]), "{} (order)", case["output"]);
    }
    for case in cases(&g, "strip_ansi") {
        assert_eq!(json!(cli::strip_ansi(case["text"].as_str().expect("text"))), case["out"], "{case}");
    }
    for case in cases(&g, "result_text") {
        let content = Some(&case["content"]).filter(|c| !c.is_null());
        assert_eq!(json!(cli::result_text(content).expect("no raise")), case["out"], "{}", case["content"]);
    }
    for case in cases(&g, "message_of") {
        assert_eq!(Value::Object(cli::message_of(&case["event"]).clone()), case["out"], "{}", case["event"]);
    }
}
