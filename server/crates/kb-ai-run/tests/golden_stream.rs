//! `stream::Parser` against what the Python parser gave for the same transcripts (`contract/golden/ai_stream.json`,
//! made by `gen_ai_stream.py`): every line of every transcript is fed to one parser per transcript, and everything the
//! line gave is compared, values and key order. A line the Python parser raises on must be an `Err` here.

mod common;

use std::collections::HashMap;

use kb_ai_run::stream::Parser;
use kb_base::pyjson;

#[test]
fn the_parser_gives_what_the_python_parser_gives_for_every_line() {
    let golden = common::golden("ai_stream.json");
    let transcripts = golden["transcripts"].as_array().expect("transcripts");
    assert!(transcripts.len() >= 30);
    let mut lines = 0;
    let mut wrong: Vec<String> = Vec::new();
    for t in transcripts {
        let name = t["name"].as_str().expect("name");
        let known: Option<HashMap<String, String>> = t["agent_types"]
            .as_object()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().expect("a role").to_string())).collect());
        let mut parser = Parser::new(t["cwd"].as_str().expect("cwd"), known);
        let outs = t["outs"].as_array().expect("outs");
        for (i, line) in t["lines"].as_array().expect("lines").iter().enumerate() {
            lines += 1;
            let line = line.as_str().expect("a line");
            let want = &outs[i];
            match parser.parse(line) {
                Err(why) => {
                    if want.get("raises").is_none() {
                        wrong.push(format!("{name} #{i}: Rust raised ({why}), Python gave {want}\n  {line}"));
                    }
                }
                Ok(got) => {
                    let got = got.to_value();
                    if want.get("raises").is_some() {
                        wrong.push(format!("{name} #{i}: Python raised {}, Rust gave {got}\n  {line}", want["raises"]));
                    } else if &got != want {
                        wrong.push(format!("{name} #{i}:\n  line: {line}\n  want: {want}\n  got:  {got}"));
                    } else if pyjson::dumps(&got) != pyjson::dumps(want) {
                        wrong.push(format!("{name} #{i} (key order):\n  want: {want}\n  got:  {got}"));
                    }
                }
            }
        }
        let after: HashMap<String, String> = parser
            .agent_types
            .iter()
            .filter(|(k, _)| !k.starts_with('\0'))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let want: HashMap<String, String> = t["agent_types_after"]
            .as_object()
            .expect("roles")
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().expect("a role").to_string()))
            .collect();
        if after != want {
            wrong.push(format!("{name}: roles at the end: want {want:?}, got {after:?}"));
        }
    }
    assert!(lines >= 400, "{lines} lines");
    let shown: Vec<&String> = wrong.iter().take(12).collect();
    assert!(
        wrong.is_empty(),
        "{} of {lines} lines differ:\n\n{}",
        wrong.len(),
        shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n\n")
    );
}
