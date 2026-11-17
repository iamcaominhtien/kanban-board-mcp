//! Odd and hostile input: reading never panics, writing never panics, the annotated flavour reads back what it
//! wrote, and large inputs finish (the converters stay close to linear).

use std::time::{Duration, Instant};

use kb_richdoc::ops::{BlockOp, apply};
use kb_richdoc::{SeqIds, annotated_to_doc, doc_to_annotated, doc_to_markdown, doc_to_text, markdown_to_doc, validate};
use serde_json::{Value, json};

/// Every converter on one Markdown input; the annotated form must read back as the page.
fn exercise(md: &str) {
    let doc = markdown_to_doc(md, &mut SeqIds(1));
    let plain = doc_to_markdown(&doc);
    let _ = doc_to_text(&doc);
    let annotated = doc_to_annotated(&doc);
    let back = annotated_to_doc(&annotated, Some(&doc), &mut SeqIds(0xe00000));
    assert_eq!(back.as_ref().ok(), Some(&doc), "annotated round trip of {:?}", &md[..md.len().min(80)]);
    // reading the plain output again never panics either
    let _ = markdown_to_doc(&plain, &mut SeqIds(1));
    let _ = annotated_to_doc(&plain, None, &mut SeqIds(1));
    let _ = annotated_to_doc(md, None, &mut SeqIds(1));
}

/// A deterministic pseudo-random string over characters that matter to Markdown.
fn noise(seed: u64, len: usize) -> String {
    const ALPHABET: &[&str] = &[
        "a",
        "b",
        " ",
        "  ",
        "\n",
        "\n\n",
        "\t",
        "*",
        "_",
        "`",
        "~",
        "[",
        "]",
        "(",
        ")",
        "!",
        "<",
        ">",
        "&",
        "#",
        "-",
        "+",
        "1.",
        "|",
        "$",
        "=",
        "\\",
        ":",
        "/",
        "@",
        "\"",
        "'",
        "{",
        "}",
        ".",
        "\r",
        "\r\n",
        "\u{0}",
        "\u{1f}",
        "\u{a0}",
        "\u{2028}",
        "é",
        "日",
        "🎉",
        "<!--",
        "-->",
        "#b-000001",
        "[[",
        "]]",
        "KAN-1",
        "```",
        "~~~",
        "$$",
        "> [!INFO]",
        "- [ ] ",
        "http://x.y",
        "<br>",
        "<span>",
        "&amp;",
        "&#",
        ";",
        "\u{fffe}",
    ];
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut out = String::new();
    while out.len() < len {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push_str(ALPHABET[((x >> 33) as usize) % ALPHABET.len()]);
    }
    out
}

#[test]
fn odd_inputs_never_panic() {
    let cases = [
        "",
        "\n",
        "```",
        "```\nunclosed code",
        "````md\n```js\n",
        "~~~\n~~~~",
        "$$\nnever closed",
        "$$$$$",
        "> [!INFO]",
        "> [!",
        "[[",
        "]]",
        "[a](",
        "![](",
        "<",
        "<!--",
        "<!-- #b-000001",
        "<!-- #b-000001 -->",
        "<!-- #b-000001 columns -->",
        "<!-- #b-000001 columns -->\n<!-- column -->\n<!-- #b-000002 columns -->\n<!-- column -->\ndeep",
        "| a |\n|---|\n|",
        "|\n|",
        "1.\n2.\n3.",
        "- [ ]",
        "-\n-\n-",
        "\r\r\r",
        "a\u{0}b",
        "\u{2028}\u{2029}",
        "🎉*🎉*🎉",
        "*🎉**",
        "&#0; &#x110000; &#55296;",
        "[x]{.underline",
        "[x]{color=\"unclosed}",
        "[[a]]{page-id=",
    ];
    for c in cases {
        exercise(c);
    }
    for seed in 0..300 {
        exercise(&noise(seed, 200));
    }
}

#[test]
fn deep_nesting_is_read_as_text_beyond_the_limit() {
    let quotes = format!("{} deep", ">".repeat(10_000));
    let bullets = format!("{}x", "- ".repeat(10_000));
    let numbers = format!("{}x", "1. ".repeat(10_000));
    let tasks = format!("{}x", "- [ ] ".repeat(5_000));
    let callouts = "> [!INFO]\n".repeat(2_000).replace('\n', "\n> ");
    let staircase: String = (0..400).map(|i| format!("{}- level {i}\n", "  ".repeat(i))).collect();
    let emphasis = format!("{}x{}", "*".repeat(10_000), "*".repeat(10_000));
    let links = format!("{}x{}", "[".repeat(10_000), "](u)".repeat(10_000));
    for md in [quotes, bullets, numbers, tasks, callouts, staircase, emphasis, links] {
        exercise(&md);
    }
}

#[test]
fn large_hostile_inputs_finish() {
    let n = 6_000;
    let cases = [
        "*a ".repeat(n),
        "_a ".repeat(n),
        "**a ".repeat(n),
        "~a ".repeat(n),
        "[a](".repeat(n),
        "[[a".repeat(n),
        "`a ``".repeat(n),
        "$a ".repeat(n),
        "==a ".repeat(n),
        "<a ".repeat(n),
        "a@b.c ".repeat(n),
        "http://a.b/x. ".repeat(n),
        format!("{}\n|---|\n", "| a ".repeat(n)),
        "```\n".repeat(n),
        "- [ ] x\n".repeat(n),
        (0..n).map(|i| format!("{i}. x\n")).collect(),
        format!("| a | b |\n|---|---|\n{}", "| 1 | 2 |\n".repeat(n)),
        "a".repeat(200_000),
        " ".repeat(100_000),
        "\n".repeat(50_000),
    ];
    for md in cases {
        let t = Instant::now();
        let doc = markdown_to_doc(&md, &mut SeqIds(1));
        let _ = doc_to_markdown(&doc);
        let _ = doc_to_text(&doc);
        let _ = doc_to_annotated(&doc);
        // generous: a quadratic path takes minutes on these sizes
        assert!(t.elapsed() < Duration::from_secs(60), "too slow on {:?}…", &md[..20]);
    }
}

/// Deep or odd JSON (not schema-valid) is refused by `validate` and still written without a panic.
#[test]
fn odd_json_never_panics() {
    // built by hand: `json!` would serialise the nested value recursively
    fn node(ty: &str, content: Vec<Value>) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("type".into(), ty.into());
        m.insert("content".into(), Value::Array(content));
        Value::Object(m)
    }
    let mut deep = json!({"type": "paragraph", "content": [{"type": "text", "text": "x"}]});
    for i in 0..3_000 {
        deep = match i % 3 {
            0 => node("blockquote", vec![deep]),
            1 => node("bulletList", vec![node("listItem", vec![json!({"type": "paragraph"}), deep])]),
            _ => node("callout", vec![deep]),
        };
    }
    let doc = node("doc", vec![deep]);
    assert!(validate(&doc).is_err());
    let odd = [
        doc,
        json!({}),
        json!(null),
        json!({"type": "doc"}),
        json!({"type": "doc", "content": "x"}),
        json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text"}]}]}),
        json!({"type": "doc", "content": [{"type": "nope", "attrs": 3, "content": [1, "a", null]}]}),
        json!({"type": "doc", "content": [{"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"colspan": "x"}}, {"type": "tableHeader"}]}, {"type": "tableRow"}]}]}),
        json!({"type": "doc", "content": [{"type": "orderedList", "attrs": {"start": -3.5, "type": "I"}, "content": [
            {"type": "listItem", "content": [{"type": "paragraph"}]}]}]}),
        json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a",
            "marks": [{"type": "link"}, {"type": "link", "attrs": {"href": 5}}, {"type": "code"}, {"type": "nope"}]}]}]}),
    ];
    for d in odd {
        let _ = doc_to_markdown(&d);
        let _ = doc_to_text(&d);
        let a = doc_to_annotated(&d);
        let _ = annotated_to_doc(&a, Some(&d), &mut SeqIds(1));
        let _ = validate(&d);
        let _ = apply(&d, &[BlockOp::InsertAfter { block_id: None, markdown: "x".into() }], &mut SeqIds(1));
    }
}

/// Random block edits on a fixture-like page keep it valid with unique ids.
#[test]
fn random_edits_keep_pages_valid() {
    let base = markdown_to_doc(
        "# Title\n\nPara *one*.\n\n- a\n- b\n\n> [!WARNING] t\n> body\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```rs\nfn x() {}\n```",
        &mut SeqIds(1),
    );
    for seed in 0..100u64 {
        let mut doc = base.clone();
        for step in 0..6u64 {
            let ids: Vec<String> = kb_richdoc::top_level_blocks(&doc)
                .iter()
                .filter_map(|b| b["attrs"]["blockId"].as_str().map(str::to_string))
                .collect();
            let pick = |k: u64| ids[(k as usize) % ids.len()].clone();
            let r = seed * 31 + step * 7;
            let md = noise(r, 40);
            let op = match r % 4 {
                0 => BlockOp::Replace { block_id: pick(r), markdown: md },
                1 => BlockOp::InsertAfter { block_id: Some(pick(r)), markdown: md },
                2 => BlockOp::Delete { block_id: pick(r) },
                _ => BlockOp::SetAttrs {
                    block_id: pick(r),
                    attrs: json!({"textAlign": "center"}).as_object().cloned().unwrap_or_default(),
                },
            };
            if let Ok(next) = apply(&doc, &[op], &mut SeqIds(0x100000 + (seed * 100 + step) as u32 * 64)) {
                doc = next;
            }
            let mut seen = std::collections::HashSet::new();
            fn walk(n: &Value, seen: &mut std::collections::HashSet<String>) {
                if let Some(id) = n["attrs"]["blockId"].as_str() {
                    assert!(seen.insert(id.to_string()), "duplicate id {id}");
                }
                for c in n["content"].as_array().into_iter().flatten() {
                    walk(c, seen);
                }
            }
            walk(&doc, &mut seen);
        }
    }
}
