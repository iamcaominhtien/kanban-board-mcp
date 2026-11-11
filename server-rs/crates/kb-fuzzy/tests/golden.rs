//! Golden vectors from the compiled rapidfuzz (`contract/golden/gen_fuzzy.py`).

use kb_fuzzy::{fuzz, process};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Case {
    scorer: String,
    a: String,
    b: String,
    score: f64,
}

#[derive(Deserialize)]
struct Expected {
    choice: String,
    score: f64,
    index: usize,
}

#[derive(Deserialize)]
struct ExtractCase {
    scorer: String,
    query: String,
    choices: Vec<String>,
    score_cutoff: Option<f64>,
    result: Option<Expected>,
}

#[derive(Deserialize)]
struct Golden {
    cases: Vec<Case>,
    extract_one: Vec<ExtractCase>,
}

fn load() -> Golden {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contract/golden/fuzzy.json"
    );
    let text = std::fs::read_to_string(path).expect("golden file fuzzy.json exists");
    serde_json::from_str(&text).expect("golden file parses")
}

fn scorer(name: &str) -> process::Scorer {
    match name {
        "ratio" => fuzz::ratio,
        "partial_ratio" => fuzz::partial_ratio,
        "token_sort_ratio" => fuzz::token_sort_ratio,
        "token_set_ratio" => fuzz::token_set_ratio,
        "token_ratio" => fuzz::token_ratio,
        "partial_token_sort_ratio" => fuzz::partial_token_sort_ratio,
        "partial_token_set_ratio" => fuzz::partial_token_set_ratio,
        "partial_token_ratio" => fuzz::partial_token_ratio,
        "WRatio" => fuzz::wratio,
        "QRatio" => fuzz::qratio,
        other => panic!("unknown scorer {other}"),
    }
}

#[test]
fn scorers_match_rapidfuzz() {
    let golden = load();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut failures = Vec::new();
    for case in &golden.cases {
        let got = scorer(&case.scorer)(&case.a, &case.b);
        *counts.entry(case.scorer.clone()).or_default() += 1;
        if (got - case.score).abs() > 1e-9 {
            failures.push(format!(
                "{}({:?}, {:?}): expected {} got {}",
                case.scorer, case.a, case.b, case.score, got
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ, first: {:#?}",
        failures.len(),
        golden.cases.len(),
        &failures[..failures.len().min(10)]
    );
    for name in ["ratio", "partial_ratio", "token_sort_ratio", "WRatio"] {
        assert!(
            counts.get(name).copied().unwrap_or(0) >= 1000,
            "too few {name} cases"
        );
    }
}

#[test]
fn extract_one_matches_rapidfuzz() {
    let golden = load();
    assert!(!golden.extract_one.is_empty());
    for case in &golden.extract_one {
        let got = process::extract_one(
            &case.query,
            &case.choices,
            scorer(&case.scorer),
            case.score_cutoff,
        );
        let label = format!(
            "{} {:?} {:?} cutoff {:?}",
            case.scorer, case.query, case.choices, case.score_cutoff
        );
        match (&case.result, got) {
            (None, None) => {}
            (Some(want), Some((choice, score, index))) => {
                assert_eq!(choice, want.choice, "{label}");
                assert_eq!(index, want.index, "{label}");
                assert!(
                    (score - want.score).abs() <= 1e-9,
                    "{label}: {score} vs {}",
                    want.score
                );
            }
            (want, got) => panic!("{label}: expected {:?} got {:?}", want.is_some(), got),
        }
    }
}
