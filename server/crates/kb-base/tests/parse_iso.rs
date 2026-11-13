//! `kb_base::time::parse_iso` against `datetime.fromisoformat` of Python 3.12, and `parse_query_datetime` against
//! what Pydantic reads for a `datetime` of a query string: the vectors of `contract/golden/parse_iso.json`, made by
//! `gen_parse_iso.py` (removed in 5.0.0 with the Python server; see PORTING.md).

use kb_base::time::{self, Parsed};
use serde_json::Value;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/parse_iso.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the golden file")).expect("JSON")
}

/// The wall time as Python's `isoformat()` writes it, and the offset in seconds (`None`: no offset).
fn seen(parsed: &Parsed) -> (String, Option<f64>) {
    match parsed {
        Parsed::Naive(wall) => (time::iso_naive(wall), None),
        Parsed::Aware(at) => (time::iso_naive(&at.naive_local()), Some(f64::from(at.offset().local_minus_utc()))),
    }
}

#[test]
fn parse_iso_is_fromisoformat() {
    let golden = golden();
    assert!(golden["python"].as_str().is_some_and(|v| v.starts_with("3.12.")), "vectors of Python 3.12");
    let cases = golden["fromisoformat"].as_array().expect("cases");
    assert!(cases.len() > 150 && cases.iter().filter(|c| c["ok"] == false).count() > 80);
    for case in cases {
        let text = case["in"].as_str().expect("text");
        let got = time::parse_iso(text);
        if case["ok"] == false {
            assert!(got.is_none(), "{text:?}: Python refuses it, here it is {got:?}");
            assert!(time::isoformat_parts(text).is_none(), "{text:?}");
            continue;
        }
        let got = got.unwrap_or_else(|| panic!("{text:?}: Python reads it as {case}"));
        let offset = case["offset"].as_f64();
        // the wall time and the whole seconds of the offset, as written
        let (wall, seconds) = time::isoformat_parts(text).expect("parts");
        assert_eq!(time::iso_naive(&wall), case["wall"].as_str().expect("wall"), "{text:?}");
        assert_eq!(seconds.map(f64::from), offset.map(f64::trunc), "{text:?}");
        assert_eq!(matches!(got, Parsed::Naive(_)), case["naive"] == true, "{text:?}");
        match offset {
            None => assert_eq!(seen(&got), (case["wall"].as_str().expect("wall").to_string(), None), "{text:?}"),
            // an offset with a fraction: the instant is exact, the offset keeps its whole seconds
            Some(offset) if offset.fract() != 0.0 => {
                assert_eq!(time::iso(&got.utc()), case["utc"].as_str().expect("utc"), "{text:?}");
                assert_eq!(seen(&got).1, Some(offset.trunc()), "{text:?}");
            }
            Some(offset) => {
                assert_eq!(seen(&got), (case["wall"].as_str().expect("wall").to_string(), Some(offset)), "{text:?}");
                // where Python can say the instant in UTC (it cannot before year 1 or after 9999), it is this one
                if let Some(utc) = case["utc"].as_str().filter(|utc| *utc != "overflow") {
                    assert_eq!(time::iso(&got.utc()), utc, "{text:?}");
                }
            }
        }
    }
}

#[test]
fn parse_query_datetime_is_what_pydantic_reads() {
    let golden = golden();
    let cases = golden["query_datetime"].as_array().expect("cases");
    assert!(cases.len() > 250);
    for case in cases {
        let text = case["in"].as_str().expect("text");
        let got = time::parse_query_datetime(text);
        if case["ok"] == false {
            assert!(got.is_none(), "{text:?}: Pydantic refuses it, here it is {got:?}");
            continue;
        }
        let got = got.unwrap_or_else(|| panic!("{text:?}: Pydantic reads it as {case}"));
        let want = (case["wall"].as_str().expect("wall").to_string(), case["offset"].as_f64());
        assert_eq!(seen(&got), want, "{text:?}");
    }
}
