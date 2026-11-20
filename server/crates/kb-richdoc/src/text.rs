//! The plain-text projection (README "Projections", `fixtures/*.txt`), as `ui/src/richdoc/text.ts` writes it.

use serde_json::Value;

use crate::schema::MAX_DOC_DEPTH;

fn str_of(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

fn attr<'v>(n: &'v Value, k: &str) -> Option<&'v Value> {
    n.get("attrs").and_then(|a| a.get(k))
}

fn children(n: &Value) -> &[Value] {
    match n.get("content") {
        Some(Value::Array(c)) => c,
        _ => &[],
    }
}

/// The text of a node's inline content.
pub fn inline_text(node: &Value, depth: usize) -> String {
    let mut out = String::new();
    if depth > MAX_DOC_DEPTH * 2 {
        return out;
    }
    for n in children(node) {
        match n.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => out.push_str(str_of(n.get("text"))),
            "hardBreak" => out.push('\n'),
            "docRef" => {
                let label = str_of(attr(n, "label"));
                let page = str_of(attr(n, "page"));
                let section = str_of(attr(n, "section"));
                if !label.is_empty() {
                    out.push_str(label);
                } else if !section.is_empty() {
                    out.push_str(&format!("{page} › {section}"));
                } else {
                    out.push_str(page);
                }
            }
            "ticketRef" => out.push_str(str_of(attr(n, "key"))),
            "mathInline" => out.push_str(str_of(attr(n, "latex"))),
            _ => {
                if n.get("content").is_some() {
                    out.push_str(&inline_text(n, depth + 1));
                }
            }
        }
    }
    out
}

fn non_empty(values: &[Option<&Value>]) -> Vec<String> {
    values.iter().map(|v| str_of(*v)).filter(|v| !crate::chars::trim(v).is_empty()).map(str::to_string).collect()
}

/// The text of one table cell: its blocks on one line.
pub fn cell_text(cell: &Value, depth: usize) -> String {
    blocks(children(cell), depth + 1).iter().map(|l| l.replace('\n', " ")).collect::<Vec<_>>().join(" ")
}

fn blocks(nodes: &[Value], depth: usize) -> Vec<String> {
    nodes.iter().flat_map(|n| block(n, depth)).collect()
}

fn item(node: &Value, prefix: &str, depth: usize) -> Vec<String> {
    let mut lines = blocks(children(node), depth + 1);
    if let Some(first) = lines.first_mut() {
        *first = format!("{prefix}{first}");
    }
    lines
}

fn block(node: &Value, depth: usize) -> Vec<String> {
    if depth > MAX_DOC_DEPTH * 2 {
        return Vec::new();
    }
    let a = |k: &str| attr(node, k);
    match node.get("type").and_then(Value::as_str).unwrap_or("") {
        "paragraph" | "heading" | "codeBlock" => non_empty(&[Some(&Value::String(inline_text(node, depth)))]),
        "pullQuote" => {
            let mut v = non_empty(&[Some(&Value::String(inline_text(node, depth)))]);
            v.extend(non_empty(&[a("source")]));
            v
        }
        "blockquote" => {
            let mut v = blocks(children(node), depth + 1);
            v.extend(non_empty(&[a("source")]));
            v
        }
        "callout" => {
            let mut v = non_empty(&[a("title")]);
            v.extend(blocks(children(node), depth + 1));
            v
        }
        "bulletList" | "orderedList" => children(node).iter().flat_map(|li| item(li, "- ", depth + 1)).collect(),
        "taskList" => children(node)
            .iter()
            .flat_map(|li| {
                let checked = attr(li, "checked").and_then(Value::as_bool).unwrap_or(false);
                item(li, if checked { "- [x] " } else { "- [ ] " }, depth + 1)
            })
            .collect(),
        "table" => children(node)
            .iter()
            .map(|row| children(row).iter().map(|c| cell_text(c, depth + 1)).collect::<Vec<_>>())
            .filter(|cells| cells.iter().any(|c| !c.is_empty()))
            .map(|cells| cells.join(" | "))
            .collect(),
        "image" => non_empty(&[a("alt"), a("caption")]),
        "video" => non_empty(&[a("title"), a("caption"), a("description")]),
        "htmlEmbed" => non_empty(&[a("title")]),
        "linkEmbed" => non_empty(&[a("title"), a("description")]),
        "fileCard" => non_empty(&[a("name")]),
        "pageCard" => non_empty(&[a("page")]),
        "ticketCard" => non_empty(&[a("key")]),
        // read from the stored attributes, as the UI does (a label at its default is not stored)
        "diagram" | "sketch" | "canvas" => non_empty(&[a("label")]),
        "mathBlock" => non_empty(&[a("latex")]),
        "horizontalRule" => Vec::new(),
        _ => blocks(children(node), depth + 1),
    }
}

/// The plain text of a page: its lines joined by `\n`, without a final newline.
pub fn doc_to_text(doc: &Value) -> String {
    blocks(children(doc), 0).join("\n")
}
