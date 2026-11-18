//! Rich pages over MCP (`server/contract/richdoc/README.md`): the annotated view an agent reads, the block edits it
//! sends, and how a change reaches the page.
//!
//! A page is stored as rich JSON with a block id on every block. An agent reads it as annotated Markdown (a
//! `<!-- #b-… -->` marker before every top-level block, inline spans for colours and fonts, one-line placeholders
//! for what Markdown cannot hold) and writes it back block by block, or as Markdown that is read with the page's
//! ids, so the formatting of what it did not touch stays. A person's change (or an agent outside any board run) is
//! published at once; an AI team's change becomes block-level suggestions unless the page or the team applies
//! directly (`kb_docs::docs_suggestions`).

use std::collections::HashSet;

use kb_base::activity;
use kb_db::Session;
use kb_docs::docs::{self, BodyInput, PageBody};
use kb_docs::docs_suggestions::{self, ApplyMode};
use kb_richdoc::ops::BlockOp;
use kb_richdoc::{RandomIds, RichDocError};
use serde_json::{Map, Value, json};

use super::docs::docs_error;
use crate::common::{self, ToolError};

/// What an AI team reads when it asks for a page marked "Not for AI teams".
pub const NOT_FOR_AI: &str = "This page is marked \"Not for AI teams\": AI teams cannot read or change it. Work \
                              without it, or ask a person to change the page's Access settings.";

/// The block edits of `docs_write(action='edit')` (`mode` with `block_id`).
pub const BLOCK_MODES: [&str; 4] = ["replace", "after", "delete", "attrs"];

/// A page as the Docs tools work on it.
pub struct Page {
    /// `page_detail` of the page (its `markdown` is the plain projection).
    pub detail: Map<String, Value>,
    /// The latest published page as rich JSON; `None` for a page still in Markdown (never published, or one whose
    /// conversion failed).
    pub doc: Option<Value>,
}

impl Page {
    /// The published version number.
    pub fn version(&self) -> i64 {
        self.detail.get("version").and_then(Value::as_i64).unwrap_or_default()
    }

    /// What an agent reads and edits: the annotated Markdown of a rich page, else the page's Markdown.
    pub fn view(&self) -> String {
        match &self.doc {
            Some(doc) => kb_richdoc::doc_to_annotated(doc),
            None => self.detail.get("markdown").and_then(Value::as_str).unwrap_or_default().to_string(),
        }
    }
}

/// Whether the call comes from an AI team (a board run or an assistant's answer).
///
/// # Errors
/// The guard's refusal of a dead run token.
pub async fn ai_acting() -> Result<bool, ToolError> {
    Ok(common::resolve().await?.is_some())
}

/// Reads a page for the Docs tools.
///
/// # Errors
/// The Docs errors of the page (not found, deleted), and [`NOT_FOR_AI`] when an AI team asks for a page marked
/// "Not for AI teams".
pub async fn load(session: &Session, page_id: &str) -> Result<Page, ToolError> {
    let detail = docs::page_detail(session, page_id).await.map_err(docs_error)?;
    let not_for_ai = detail.get("settings").and_then(|s| s.get("notForAi")).and_then(Value::as_bool) == Some(true);
    if not_for_ai && ai_acting().await? {
        return Err(ToolError::value(NOT_FOR_AI));
    }
    let rich = detail.get("format").and_then(Value::as_str) == Some("rich");
    let doc = detail.get("content").filter(|c| rich && c.is_object()).cloned();
    Ok(Page { detail, doc })
}

/// The refusal of a Markdown input or a block edit, as the tool words it.
pub fn richdoc_error(err: RichDocError) -> ToolError {
    match err {
        RichDocError::NoBlock(id) => ToolError::Value(format!(
            "No block {id} on this page. Block ids are in the markers of docs_read(action='get'): <!-- #b-… -->."
        )),
        RichDocError::Syntax(m) => ToolError::Value(format!("markdown: {m}")),
        RichDocError::Invalid(m) | RichDocError::Placeholder(m) => ToolError::Value(m),
    }
}

/// Reads annotated (or plain) Markdown as a page; `existing` is the page it was read from (its ids and the blocks of
/// its placeholders are kept).
///
/// # Errors
/// A broken marker or span, a placeholder whose block `existing` does not have.
pub fn read_markdown(markdown: &str, existing: Option<&Value>) -> Result<Value, ToolError> {
    kb_richdoc::annotated_to_doc(markdown, existing, &mut RandomIds).map_err(richdoc_error)
}

/// The placeholders of an annotated text: `(block id, kind)` of each marker with a type that an `[embed: …]` line
/// follows (a video, an HTML embed, a link embed, a table with merged cells, a block Markdown cannot hold exactly).
pub fn placeholders(text: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some(inner) = line.trim().strip_prefix("<!-- #").and_then(|l| l.strip_suffix("-->")) else { continue };
        let mut words = inner.split_whitespace();
        let (Some(id), Some(kind)) = (words.next(), words.next()) else { continue };
        if kind.contains('=') || !kb_richdoc::is_block_id(id) {
            continue;
        }
        let next = lines[i + 1..].iter().find(|l| !l.trim().is_empty());
        if next.is_some_and(|l| l.trim_start().starts_with("[embed:")) {
            out.push((id.to_string(), kind.to_string()));
        }
    }
    out
}

/// Every block id of a document.
pub fn ids_in(doc: &Value) -> HashSet<String> {
    fn walk(n: &Value, out: &mut HashSet<String>) {
        if let Some(id) = n.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str) {
            out.insert(id.to_string());
        }
        for c in n.get("content").and_then(Value::as_array).into_iter().flatten() {
            walk(c, out);
        }
    }
    let mut out = HashSet::new();
    walk(doc, &mut out);
    out
}

/// The node of a block id anywhere in a document.
pub fn find_block<'a>(doc: &'a Value, id: &str) -> Option<&'a Value> {
    if doc.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str) == Some(id) {
        return Some(doc);
    }
    doc.get("content").and_then(Value::as_array).into_iter().flatten().find_map(|c| find_block(c, id))
}

/// The annotated Markdown of one top-level block (marker and Markdown), `None` for a nested part that is no block of
/// its own (a list item, a table row or cell, a column).
pub fn block_view(node: &Value) -> Option<String> {
    let ty = node.get("type").and_then(Value::as_str).unwrap_or_default();
    if matches!(ty, "listItem" | "taskItem" | "tableRow" | "tableCell" | "tableHeader" | "column") {
        return None;
    }
    let text = kb_richdoc::doc_to_annotated(&json!({"type": "doc", "content": [node]}));
    Some(text.trim_end_matches('\n').to_string())
}

/// Whether two documents hold the same page.
pub fn same_doc(a: &Value, b: &Value) -> bool {
    kb_richdoc::schema::same(&kb_richdoc::schema::canonical(a), &kb_richdoc::schema::canonical(b))
}

/// Refuses a text edit that dropped a placeholder: such a block can only be removed with an explicit block delete.
///
/// # Errors
/// The refusal, naming the block.
pub fn check_placeholders_kept(before: &str, after: &Value) -> Result<(), ToolError> {
    let ids = ids_in(after);
    match placeholders(before).into_iter().find(|(id, _)| !ids.contains(id)) {
        None => Ok(()),
        Some((id, kind)) => Err(ToolError::Value(format!(
            "This edit would remove block {id} ({kind}), which Markdown cannot hold: keep its two lines (the marker \
             and the [embed: …] line) as they are, or remove it on purpose with block_id='{id}', mode='delete'."
        ))),
    }
}

/// The marker line of a block's annotated Markdown, when it starts with one.
fn marker_of(view: &str) -> Option<&str> {
    view.lines().next().filter(|l| l.trim_start().starts_with("<!-- #"))
}

/// Applies one block edit (`mode`: replace, after, delete, attrs).
///
/// A replacement without a marker of its own keeps the block's attributes (alignment, colour, image placement…)
/// when it is a block of the same kind, so rewording a centred paragraph keeps it centred.
///
/// # Errors
/// An unknown block or mode, a missing `markdown` or `attrs`, a fragment that cannot be read, an attribute the block
/// does not have, the replacement of a placeholder.
pub fn block_edit(
    doc: &Value,
    block_id: &str,
    mode: &str,
    markdown: Option<&str>,
    attrs: Option<&Value>,
) -> Result<Value, ToolError> {
    let need_markdown = || {
        markdown
            .filter(|m| !m.trim().is_empty())
            .ok_or_else(|| ToolError::Value(format!("block_id with mode='{mode}' needs markdown: the new block(s).")))
    };
    if !matches!(mode, "attrs") && attrs.is_some() {
        return Err(ToolError::value("attrs works with block_id and mode='attrs'."));
    }
    let apply = |op: BlockOp| kb_richdoc::ops::apply(doc, &[op], &mut RandomIds).map_err(richdoc_error);
    match mode {
        "replace" => {
            let markdown = need_markdown()?;
            let id = block_id.to_string();
            let old = find_block(doc, block_id);
            let starts_with_marker = markdown.trim_start().starts_with("<!--");
            if let (false, Some(old)) = (starts_with_marker, old) {
                if let Some(marker) = block_view(old).as_deref().and_then(marker_of) {
                    let with_marker = format!("{marker}\n{markdown}");
                    let kept = apply(BlockOp::Replace { block_id: id.clone(), markdown: with_marker });
                    if let Ok(new) = kept {
                        let same_kind = find_block(&new, block_id).map(|n| &n["type"]) == Some(&old["type"]);
                        if same_kind {
                            return Ok(new);
                        }
                    }
                }
            }
            apply(BlockOp::Replace { block_id: id, markdown: markdown.to_string() })
        }
        "after" => {
            let markdown = need_markdown()?;
            apply(BlockOp::InsertAfter { block_id: Some(block_id.to_string()), markdown: markdown.to_string() })
        }
        "delete" => {
            if markdown.is_some_and(|m| !m.is_empty()) {
                return Err(ToolError::value("block_id with mode='delete' takes no markdown."));
            }
            apply(BlockOp::Delete { block_id: block_id.to_string() })
        }
        "attrs" => {
            if markdown.is_some_and(|m| !m.is_empty()) {
                return Err(ToolError::value("block_id with mode='attrs' takes attrs, not markdown."));
            }
            let Some(Value::Object(attrs)) = attrs else {
                return Err(ToolError::value(
                    "block_id with mode='attrs' needs attrs: an object such as {\"align\": \"center\"} (null clears one).",
                ));
            };
            apply(BlockOp::SetAttrs { block_id: block_id.to_string(), attrs: attrs.clone() })
        }
        other => Err(ToolError::Value(format!("mode with block_id: {}, not '{other}'.", BLOCK_MODES.join(", ")))),
    }
}

/// The page's fields an answer carries: the listed keys, in that order.
fn pick(page: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    keys.iter().map(|k| (k.to_string(), page.get(*k).cloned().unwrap_or(Value::Null))).collect()
}

/// `n suggestion(s)`.
fn suggestions(n: u64) -> String {
    format!("{n} suggestion{}", if n == 1 { "" } else { "s" })
}

/// Saves a new page content: a draft (`publish` false), a published version, or, for an AI team on a page set to
/// "Suggest first", block suggestions that wait for a person. Returns `{id, title, version, published}`, plus for an
/// AI team `{mode, suggestions, left_alone, message}`.
///
/// `base_version` is the version the change was made from (a stale one is refused).
///
/// # Errors
/// The Docs errors (edit rights, a stale base version, a page that cannot be edited, content too large).
pub async fn save(
    session: &Session,
    page_id: &str,
    doc: &Value,
    base_version: i64,
    note: Option<&str>,
    publish: bool,
) -> Result<Map<String, Value>, ToolError> {
    if !publish {
        let page = docs::save_draft(session, page_id, BodyInput::Content(doc), None, i32::try_from(base_version).ok())
            .await
            .map_err(docs_error)?;
        // a team's draft says so, with the formatting it used (the Gaps panel of the draft)
        if let Some(run) = common::resolve().await? {
            let mut source = Map::new();
            source.insert("kind".into(), json!("team"));
            source.insert("from".into(), json!(run.ticket_id));
            source.insert("member_id".into(), json!(run.member_id));
            let author = activity::current_actor();
            docs_suggestions::mark_ai_draft(session, page_id, Some(&author), source).await.map_err(docs_error)?;
        }
        let mut out = pick(&page, &["id", "title", "version"]);
        out.insert("published".into(), json!(false));
        return Ok(out);
    }
    let run = common::resolve().await?;
    let page = docs::get_page(session, page_id, false, true).await.map_err(docs_error)?;
    // a person's change, an agent's outside a board run, and the first version of a page are published at once
    let Some(run) = run.filter(|_| page.version > 0) else {
        let page = docs::publish_page(session, page_id, base_version, note, Some(BodyInput::Content(doc)), None)
            .await
            .map_err(docs_error)?;
        let mut out = pick(&page, &["id", "title", "version"]);
        out.insert("published".into(), json!(true));
        return Ok(out);
    };
    docs::check_editable(&page).map_err(docs_error)?;
    if base_version != i64::from(page.version) {
        return Err(ToolError::Value(format!(
            "Page was published as v{} since you started from v{base_version}. Call docs_read(action='get') again, \
             re-apply your edit on the new version, and retry.",
            page.version
        )));
    }
    // checked, cleaned (HTML embeds) and given ids as any saved page
    let body = PageBody::from_input(BodyInput::Content(doc)).map_err(docs_error)?;
    let doc = body.content.unwrap_or_else(|| doc.clone());
    let author = activity::current_actor();
    let mode = docs_suggestions::apply_mode(session, &page, Some(&run.member_id), &author).await.map_err(docs_error)?;
    let run_id = Some(run.run_id.as_str()).filter(|r| !r.is_empty());
    let done = docs_suggestions::propose(session, page_id, &doc, mode, Some(&run.member_id), run_id, note)
        .await
        .map_err(docs_error)?;
    let detail = docs::page_detail(session, page_id).await.map_err(docs_error)?;
    let mut out = pick(&detail, &["id", "title", "version"]);
    let left_alone = done.get("left_alone").cloned().unwrap_or(json!([]));
    let left: Vec<&str> = left_alone.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let mut left_note = if left.is_empty() {
        String::new()
    } else {
        format!(" Left as they are (locked for teams: \"Teams cannot change this\"): {}.", left.join(", "))
    };
    let kept: Vec<&str> =
        done.get("kept_formatting").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if !kept.is_empty() {
        left_note.push_str(&format!(
            " Left as they are (rewriting them would remove their colours, highlights, links or fonts; keep the \
             spans of docs_read(action='get')): {}.",
            kept.join(", ")
        ));
    }
    let version = detail.get("version").and_then(Value::as_i64).unwrap_or_default();
    let (published, message) = match mode {
        ApplyMode::Direct => {
            let changed = done.get("changed").and_then(Value::as_u64).unwrap_or(0);
            let message = if changed == 0 {
                format!("Nothing was changed.{left_note}")
            } else {
                format!("Published as v{version}: this page applies a team's changes directly.{left_note}")
            };
            (changed > 0, message)
        }
        ApplyMode::Suggest => {
            let n = done.get("suggestions").and_then(Value::as_u64).unwrap_or(0);
            let message = if n == 0 {
                format!("Nothing was changed.{left_note}")
            } else {
                format!(
                    "Saved as {} for a person to accept or reject, block by block; the page stays at v{version} \
                     until then.{left_note}",
                    suggestions(n)
                )
            };
            (false, message)
        }
    };
    out.insert("published".into(), json!(published));
    out.insert("mode".into(), json!(if mode == ApplyMode::Direct { "direct" } else { "suggest" }));
    out.insert("suggestions".into(), done.get("suggestions").cloned().unwrap_or(json!(0)));
    out.insert("left_alone".into(), left_alone);
    out.insert("message".into(), json!(message));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(id: &str, text: &str) -> Value {
        json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [{"type": "text", "text": text}]})
    }

    /// The examples of the Docs guide read as the guide says (`kb_doctext::docs_guide`, section 5).
    #[test]
    fn the_examples_of_the_docs_guide_read_as_it_says() {
        let guide = kb_doctext::docs_guide::GUIDE;
        // the insides of the fences: every other piece
        let fences: Vec<&str> = guide.split("```\n").skip(1).step_by(2).collect();
        let post = fences.iter().find(|f| f.contains("<!-- pullQuote -->")).expect("the post example");
        let doc = read_markdown(post, None).expect("it reads");
        let blocks = doc["content"].as_array().expect("blocks");
        assert_eq!(blocks[0]["type"], "heading");
        assert_eq!(blocks[0]["attrs"]["textAlign"], "center");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["attrs"]["placement"], "floatRight");
        assert_eq!(blocks[1]["attrs"]["widthPct"], 40);
        assert_eq!(blocks[1]["attrs"]["caption"], "Planning night");
        assert_eq!(blocks[2]["type"], "paragraph");
        assert_eq!(blocks[3]["type"], "pullQuote");
        let markers = fences.iter().find(|f| f.contains("<!-- #b-3f2a9c align=center -->")).expect("the markers");
        let doc = read_markdown(markers, None).expect("it reads");
        assert_eq!(doc["content"][0]["attrs"]["blockId"], "b-3f2a9c");
        assert_eq!(doc["content"][1]["attrs"]["blockId"], "b-77c1aa");
        // the spans of the guide
        let spans = "[a]{color=red} [b]{highlight=pink} [c]{.underline} [d]{.sup} [e]{.sub} [f]{font=lora size=18} \
                     [g]{.underline color=teal}";
        let doc = read_markdown(spans, None).expect("spans read");
        let text = doc["content"][0]["content"].as_array().expect("inline");
        assert!(text.iter().all(|t| t["text"] == " " || t.get("marks").is_some()), "{text:?}");
    }

    #[test]
    fn placeholders_are_found_by_their_marker_and_embed_line() {
        let text = "<!-- #b-000001 -->\nText.\n\n<!-- #b-000002 video -->\n[embed: video · Demo]\n\n\
                    <!-- #b-000003 fileCard size=2 -->\n[a.pdf](/uploads/a.pdf)\n";
        assert_eq!(placeholders(text), [("b-000002".to_string(), "video".to_string())]);
    }

    #[test]
    fn a_replacement_keeps_the_attributes_of_a_block_of_the_same_kind() {
        let mut centred = para("b-000001", "Old");
        centred["attrs"]["textAlign"] = json!("center");
        let doc = json!({"type": "doc", "content": [centred, para("b-000002", "Next")]});
        let new = block_edit(&doc, "b-000001", "replace", Some("New *words*"), None).unwrap();
        let block = find_block(&new, "b-000001").unwrap();
        assert_eq!(block["attrs"]["textAlign"], "center");
        assert_eq!(find_block(&new, "b-000002"), find_block(&doc, "b-000002"));
        // a heading in its place is a new kind of block: nothing is carried over
        let new = block_edit(&doc, "b-000001", "replace", Some("## Title"), None).unwrap();
        assert_eq!(find_block(&new, "b-000001").unwrap()["type"], "heading");
        assert!(find_block(&new, "b-000001").unwrap()["attrs"].get("textAlign").is_none());
        let new = block_edit(&doc, "b-000002", "attrs", None, Some(&json!({"align": "right"}))).unwrap();
        assert_eq!(find_block(&new, "b-000002").unwrap()["attrs"]["textAlign"], "right");
        assert!(block_edit(&doc, "b-000002", "attrs", None, Some(&json!({"nope": 1}))).is_err());
        assert!(block_edit(&doc, "b-0000ff", "delete", None, None).is_err());
    }
}
