//! `canvas_html` (and the `HTMLParser` port under it) against what the Python module reads from ordinary and hostile
//! pages (`contract/golden/gen_canvas_html.py`).

use kb_draw::canvas_html;
use serde_json::Value;

#[test]
fn outline_and_title_of_read_pages_as_python_does() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/canvas_html.json");
    let g: Value = serde_json::from_slice(&std::fs::read(path).expect("golden file")).expect("golden json");
    let mut bad = Vec::new();
    for case in g["cases"].as_array().expect("cases") {
        let source = case["source"].as_str().expect("source");
        let outline: Vec<Value> = canvas_html::outline(source)
            .into_iter()
            .map(|(k, t)| Value::Array(vec![Value::String(k), Value::String(t)]))
            .collect();
        let title = canvas_html::title_of(source, "");
        let title_fb = canvas_html::title_of(source, "Fallback");
        if Value::Array(outline.clone()) != case["outline"] || title != case["title"] || title_fb != case["title_fb"] {
            bad.push(format!(
                "{source:?}\n  outline {}\n  expected {}\n  title {title:?} expected {}",
                Value::Array(outline),
                case["outline"],
                case["title"]
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of the cases differ:\n{}",
        bad.len(),
        bad.iter().take(15).cloned().collect::<Vec<_>>().join("\n")
    );
}
