//! What Python's `\w`, `\d`, `\s`, `lower()`, `upper()` and `casefold()` do to every code point
//! (`contract/golden/docs_text_charclasses.json`), against the Rust side the Docs text modules use.
//!
//! Python 3.12 knows Unicode 15; Rust's case mapping is newer. The case maps are compared on the code points that
//! Unicode 15 has assigned (a letter added later is not one the server's data can hold in Python's view either).

mod common;

use std::collections::HashMap;

use kb_doctext::pystr;
use serde_json::Value;

fn ranges(v: &Value) -> Vec<(u32, u32)> {
    v.as_array()
        .expect("ranges")
        .iter()
        .map(|r| (r[0].as_u64().unwrap_or(0) as u32, r[1].as_u64().unwrap_or(0) as u32))
        .collect()
}

fn contains(table: &[(u32, u32)], cp: u32) -> bool {
    table
        .binary_search_by(|&(lo, hi)| {
            if cp < lo {
                std::cmp::Ordering::Greater
            } else if cp > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn map(v: &Value) -> HashMap<u32, String> {
    v.as_array()
        .expect("pairs")
        .iter()
        .map(|p| (p[0].as_u64().unwrap_or(0) as u32, p[1].as_str().unwrap_or("").to_string()))
        .collect()
}

fn all_chars() -> impl Iterator<Item = (u32, char)> {
    (0..=0x10FFFFu32).filter_map(|cp| char::from_u32(cp).map(|c| (cp, c)))
}

#[test]
fn golden_charclasses_word_decimal_space() {
    let data = common::load("docs_text_charclasses.json");
    let (word, decimal, space, isspace) =
        (ranges(&data["word"]), ranges(&data["decimal"]), ranges(&data["space"]), ranges(&data["isspace"]));
    let mut bad = Vec::new();
    for (cp, c) in all_chars() {
        if pystr::is_word(c) != contains(&word, cp) {
            bad.push(format!("is_word(U+{cp:04X})"));
        }
        if pystr::is_decimal(c) != contains(&decimal, cp) {
            bad.push(format!("is_decimal(U+{cp:04X})"));
        }
        if pystr::is_space(c) != contains(&space, cp) || pystr::is_space(c) != contains(&isspace, cp) {
            bad.push(format!("is_space(U+{cp:04X})"));
        }
    }
    assert!(bad.is_empty(), "{} code points differ, e.g. {:?}", bad.len(), &bad[..bad.len().min(10)]);
}

#[test]
fn golden_charclasses_regex_classes_agree_with_the_predicates() {
    // the classes built for the `regex` crate must match exactly the characters of the predicates
    let word = regex::Regex::new(&format!("^[{}]$", pystr::WORD_CLASS.as_str())).expect("word class");
    let decimal = regex::Regex::new(&format!("^[{}]$", pystr::DECIMAL_CLASS.as_str())).expect("decimal class");
    let space = regex::Regex::new(&format!("^[{}]$", pystr::SPACE_CLASS)).expect("space class");
    let mut buf = [0u8; 4];
    for (cp, c) in all_chars() {
        let text: &str = c.encode_utf8(&mut buf);
        assert_eq!(word.is_match(text), pystr::is_word(c), "word class at U+{cp:04X}");
        assert_eq!(decimal.is_match(text), pystr::is_decimal(c), "decimal class at U+{cp:04X}");
        assert_eq!(space.is_match(text), pystr::is_space(c), "space class at U+{cp:04X}");
    }
}

fn compare_case_map(key: &str, convert: impl Fn(char) -> String) {
    let data = common::load("docs_text_charclasses.json");
    let python = map(&data[key]);
    let assigned = ranges(&data["assigned"]);
    let mut bad = Vec::new();
    let mut compared = 0;
    for (cp, c) in all_chars() {
        if !contains(&assigned, cp) {
            continue;
        }
        compared += 1;
        let expected = python.get(&cp).cloned().unwrap_or_else(|| c.to_string());
        let got = convert(c);
        if got != expected {
            bad.push(format!("U+{cp:04X}: python {expected:?}, rust {got:?}"));
        }
    }
    assert!(compared > 100_000);
    assert!(bad.is_empty(), "{key}: {} code points differ, e.g. {:?}", bad.len(), &bad[..bad.len().min(10)]);
}

#[test]
fn golden_charclasses_lower() {
    compare_case_map("lower", |c| c.to_lowercase().collect());
}

#[test]
fn golden_charclasses_upper() {
    compare_case_map("upper", pystr::upper_char);
}

#[test]
fn golden_charclasses_casefold() {
    compare_case_map("casefold", |c| caseless::default_case_fold_str(&c.to_string()));
}

#[test]
fn golden_charclasses_lower_of_words_depends_on_neighbours() {
    let data = common::load("docs_text_charclasses.json");
    for pair in data["lower_words"].as_array().expect("pairs") {
        let (text, lower) = (common::s(&pair[0]), common::s(&pair[1]));
        assert_eq!(text.to_lowercase(), lower, "lower() of {text:?}");
    }
}
