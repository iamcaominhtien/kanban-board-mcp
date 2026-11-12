//! The actions of `docs_write` that are made of other actions: `edit` (read the page, change one part, publish it
//! with `update`), `upload` (store the file, then put it on a page and/or a ticket), `tickets` (tickets from the
//! page's open tasks) and `assign` (a ticket that gives the page to an AI team).

use kb_base::{activity, pyjson, pytext};
use kb_doctext::pystr;
use kb_doctext::{docs_checklist, docs_edit};
use serde_json::{Map, Value, json};

use super::read::DOCS_READ_OPS;
use super::write::run_write;
use crate::common::{self, ToolError, ToolResult};
use crate::operations::docs::docs_error;
use crate::tools::routing::dispatch;

/// `_EDIT_KEYS`.
const EDIT_KEYS: [&str; 4] = ["section", "find", "markdown", "mode"];

/// `given.get(key) is not None`.
fn given_key<'a>(given: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    given.get(key).filter(|v| !v.is_null())
}

/// `given.get(key)` read as text.
fn given_text(given: &Map<String, Value>, key: &str) -> Option<String> {
    given_key(given, key).map(|v| match v {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    })
}

/// `n:,` of an f-string: thousands separated by commas.
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `_no_unpublished_draft`: an edit works on the published text. When the caller's own draft of the page holds text
/// that was never published (an import with publish=false, say), editing would publish the old text and drop the
/// draft: refuse.
async fn no_unpublished_draft(page_id: &str, page: &Value) -> Result<(), ToolError> {
    // the name an MCP write is made under (`common::notify_on_success`): the AI team's, else "agent"
    let me = activity::current_ai()
        .and_then(|ai| ai.get("member_name").and_then(Value::as_str).map(str::to_string))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| activity::AGENT_ACTOR.to_string());
    let session = common::async_session();
    let draft = kb_docs::docs::draft_for(&session, page_id, &me).await.map_err(docs_error)?;
    let Some(draft) = draft else { return Ok(()) };
    if pytext::strip(&draft.markdown).is_empty() {
        return Ok(());
    }
    let published = page["markdown"].as_str().unwrap_or_default();
    if pytext::strip(&draft.markdown) == pytext::strip(published) {
        return Ok(());
    }
    Err(ToolError::Value(format!(
        "You have an unpublished draft of this page ({} characters, published text {}). An edit works on the published \
         text and would drop the draft. Publish the whole text first with docs_write(action='update', markdown, \
         base_version={}), then edit.",
        thousands(draft.markdown.chars().count()),
        thousands(published.chars().count()),
        pyjson::py_str(&page["version"]),
    )))
}

/// One edit `{section | find, markdown, mode}` of the dict `docs_edit.apply` is given.
fn edit_of(e: &Map<String, Value>) -> docs_edit::Edit {
    let text = |key: &str| given_text(e, key);
    docs_edit::Edit { markdown: text("markdown"), mode: text("mode"), section: text("section"), find: text("find") }
}

/// `docs_write(edit)`: read the page, change one part (or several, in order), publish it as one new version through
/// `update`, so an AI run's edit goes through the same checks and history as a whole-page update.
pub fn edit(given: Map<String, Value>) -> futures::future::BoxFuture<'static, ToolResult> {
    Box::pin(edit_page(given))
}

async fn edit_page(given: Map<String, Value>) -> ToolResult {
    let page_id = given.get("page_id").filter(|v| pyjson::truthy(v)).map(pyjson::py_str);
    let Some(page_id) = page_id else {
        return Err(ToolError::value("docs_write(action='edit') requires page_id."));
    };
    let allowed = ["page_id", "base_version", "note", "publish", "items", "section", "find", "markdown", "mode"];
    let extra: Vec<&str> =
        given.iter().filter(|(k, v)| !v.is_null() && !allowed.contains(&k.as_str())).map(|(k, _)| k.as_str()).collect();
    if !extra.is_empty() {
        return Err(ToolError::Value(format!(
            "docs_write(action='edit') does not use: {}. It takes page_id, markdown, section | find [, mode, \
             base_version, note, publish] or items.",
            extra.join(", ")
        )));
    }
    let many = given_key(&given, "items").cloned();
    let edits: Vec<Value> = match &many {
        Some(many) => {
            if EDIT_KEYS.iter().any(|k| given_key(&given, k).is_some()) {
                return Err(ToolError::value("edit: give items, or one edit (section | find, markdown), not both."));
            }
            match many {
                Value::Array(list) if !list.is_empty() && list.len() <= 25 => list.clone(),
                _ => return Err(ToolError::value("items: a list of 1 to 25 edits.")),
            }
        }
        None => {
            let one: Map<String, Value> =
                EDIT_KEYS.iter().map(|k| (k.to_string(), given.get(*k).cloned().unwrap_or(Value::Null))).collect();
            vec![Value::Object(one)]
        }
    };
    let page = dispatch("docs_read", DOCS_READ_OPS, "get", json_map(json!({"page_id": page_id}))).await?;
    no_unpublished_draft(&page_id, &page).await?;
    let current = page["version"].as_i64().unwrap_or_default();
    let base_version = given_key(&given, "base_version").and_then(Value::as_i64);
    let mut base: Option<String> = None;
    if let Some(base_version) = base_version.filter(|b| *b != current) {
        if base_version > current || base_version < 1 {
            return Err(ToolError::Value(format!("base_version {base_version}: the page is at v{current}.")));
        }
        let old = dispatch(
            "docs_read",
            DOCS_READ_OPS,
            "version",
            json_map(json!({"page_id": page_id, "version": base_version})),
        )
        .await?;
        base = old["markdown"].as_str().map(str::to_string);
    }
    let published = page["markdown"].as_str().unwrap_or_default().to_string();
    let mut text = published.clone();
    let mut changed: Vec<String> = Vec::new();
    for (i, e) in edits.iter().enumerate() {
        let Value::Object(e) = e else {
            return Err(ToolError::Value(format!("items[{i}]: an object {{section | find, markdown, mode}}.")));
        };
        let unknown: Vec<&str> = e.keys().map(String::as_str).filter(|k| !EDIT_KEYS.contains(k)).collect();
        if !unknown.is_empty() {
            return Err(ToolError::Value(format!("items[{i}] does not use: {}.", unknown.join(", "))));
        }
        // a later edit in the same call works on the text the earlier ones made
        text = docs_edit::apply(&text, &edit_of(e), if i == 0 { base.as_deref() } else { None }).map_err(|exc| {
            let wher = if many.is_some() { format!("items[{i}]: ") } else { String::new() };
            ToolError::Value(format!("{wher}{} Nothing was changed.", exc.0))
        })?;
        changed.push(if e.get("section").is_some_and(pyjson::truthy) {
            format!("section '{}'", pyjson::py_str(&e["section"]))
        } else if given_key(e, "find").is_some() {
            "a passage".to_string()
        } else {
            "the end of the page".to_string()
        });
    }
    if text == published {
        return Ok(json!({
            "id": page["id"],
            "title": page["title"],
            "version": page["version"],
            "published": false,
            "changed": [],
            "message": "The text is the same as the published page; nothing was changed.",
        }));
    }
    let note = match given.get("note").filter(|v| pyjson::truthy(v)) {
        Some(note) => pyjson::py_str(note),
        None => {
            let mut distinct: Vec<&str> = Vec::new();
            for c in &changed {
                if !distinct.contains(&c.as_str()) {
                    distinct.push(c);
                }
            }
            format!("Edited {}", distinct.join(", "))
        }
    };
    let mut update =
        json_map(json!({"page_id": page_id, "markdown": text, "base_version": page["version"], "note": note}));
    if let Some(publish) = given_key(&given, "publish") {
        update.insert("publish".into(), publish.clone());
    }
    let out = run_write("update".to_string(), update).await?;
    let Value::Object(mut out) = out else { return Ok(out) };
    out.insert("changed".into(), json!(changed));
    let last = edits.last().and_then(Value::as_object).cloned().unwrap_or_default();
    if last.get("section").is_some_and(pyjson::truthy) && out.get("published").is_none_or(pyjson::truthy) {
        let mut name = pyjson::py_str(&last["section"]);
        let mode =
            last.get("mode").filter(|v| pyjson::truthy(v)).map(pyjson::py_str).unwrap_or_else(|| "replace".into());
        if mode == "replace" {
            let markdown = last.get("markdown").filter(|v| pyjson::truthy(v)).map(pyjson::py_str).unwrap_or_default();
            let head = pystr::lstrip(&markdown).split('\n').next().unwrap_or_default().to_string();
            if head.starts_with('#') {
                name = pytext::strip(pystr::lstrip_chars(&head, "#")).to_string();
            }
        }
        if let Ok(now) = docs_edit::section_text(&text, &name) {
            out.insert("now".into(), json!(now));
        }
    }
    Ok(Value::Object(out))
}

fn json_map(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// `docs_write(upload)`: store the file, then put it on the page (an `edit`) and/or post it on the ticket.
pub fn upload(given: Map<String, Value>) -> futures::future::BoxFuture<'static, ToolResult> {
    Box::pin(upload_file(given))
}

async fn upload_file(given: Map<String, Value>) -> ToolResult {
    let allowed = [
        "path",
        "data",
        "name",
        "page_id",
        "section",
        "find",
        "mode",
        "note",
        "base_version",
        "ticket_id",
        "body",
        "author",
    ];
    let extra: Vec<&str> =
        given.iter().filter(|(k, v)| !v.is_null() && !allowed.contains(&k.as_str())).map(|(k, _)| k.as_str()).collect();
    if !extra.is_empty() {
        return Err(ToolError::Value(format!(
            "docs_write(action='upload') does not use: {}. It takes path | data+name [, page_id, section, find, \
             mode, ticket_id, body, author].",
            extra.join(", ")
        )));
    }
    let truthy = |key: &str| given.get(key).filter(|v| pyjson::truthy(v)).cloned();
    let (page_id, ticket_id) = (truthy("page_id"), truthy("ticket_id"));
    if page_id.is_none() && ["section", "find", "mode"].iter().any(|k| given_key(&given, k).is_some()) {
        return Err(ToolError::value("upload: section, find and mode place the file on a page: give page_id."));
    }
    if ticket_id.is_none() && given_key(&given, "body").is_some() {
        return Err(ToolError::value("upload: body is the comment's text on a ticket: give ticket_id."));
    }
    let just: Map<String, Value> = ["path", "data", "name"]
        .iter()
        .map(|k| (k.to_string(), given.get(*k).cloned().unwrap_or(Value::Null)))
        .collect();
    let stored = run_write("upload".to_string(), just).await?;
    let mut out = stored.as_object().cloned().unwrap_or_default();
    if let Some(page_id) = page_id {
        let by_text = given_key(&given, "find").is_some();
        // by default the file goes at the end of the page or of the section, or in a paragraph of its own after `find`
        let mode = match truthy("mode") {
            Some(mode) => pyjson::py_str(&mode),
            None => (if by_text { "after" } else { "append" }).to_string(),
        };
        let mut snippet = pyjson::py_str(&stored["markdown"]);
        if by_text && (mode == "before" || mode == "after") {
            snippet = if mode == "before" { format!("{snippet}\n\n") } else { format!("\n\n{snippet}") };
        }
        let note = match truthy("note") {
            Some(note) => pyjson::py_str(&note),
            None => format!("Added {}", pyjson::py_str(&stored["name"])),
        };
        let edit = json_map(json!({
            "page_id": page_id,
            "markdown": snippet,
            "section": given.get("section").cloned().unwrap_or(Value::Null),
            "find": given.get("find").cloned().unwrap_or(Value::Null),
            "mode": mode,
            "note": note,
            "base_version": given.get("base_version").cloned().unwrap_or(Value::Null),
        }));
        out.insert("page".into(), edit_page(edit).await?);
    }
    if let Some(ticket_id) = ticket_id {
        let body = truthy("body").map(|b| pytext::strip(&pyjson::py_str(&b)).to_string()).unwrap_or_default();
        let text = if body.is_empty() {
            pyjson::py_str(&stored["markdown"])
        } else {
            format!("{body}\n\n{}", pyjson::py_str(&stored["markdown"]))
        };
        let author = truthy("author").map(|a| pyjson::py_str(&a)).unwrap_or_else(|| "Agent".to_string());
        let ticket = crate::tools::items::ticket_items(json_map(json!({
            "ticket_id": ticket_id,
            "item": "comment",
            "action": "add",
            "text": text,
            "author": author,
        })))
        .await?;
        let comments = ticket.get("comments").and_then(Value::as_array).filter(|c| !c.is_empty());
        let comment_id = comments.and_then(|c| c.last()).map(|c| c.get("id").cloned().unwrap_or(Value::Null));
        out.insert("ticket".into(), json!({"id": ticket_id, "comment_id": comment_id.unwrap_or(Value::Null)}));
    }
    Ok(Value::Object(out))
}

/// `_only(label, given, allowed, usage)`.
fn only(label: &str, given: &Map<String, Value>, allowed: &[&str], usage: &str) -> Result<(), ToolError> {
    let extra: Vec<&str> =
        given.iter().filter(|(k, v)| !v.is_null() && !allowed.contains(&k.as_str())).map(|(k, _)| k.as_str()).collect();
    if extra.is_empty() {
        return Ok(());
    }
    Err(ToolError::Value(format!("docs_write(action='{label}') does not use: {}. It takes {usage}.", extra.join(", "))))
}

/// `docs_write(tickets)`: tickets from the page's open tasks (or from drafts), linked, their keys on their lines.
pub fn tickets(given: Map<String, Value>) -> futures::future::BoxFuture<'static, ToolResult> {
    Box::pin(tickets_of_page(given))
}

async fn tickets_of_page(given: Map<String, Value>) -> ToolResult {
    only("tickets", &given, &["page_id", "find", "items", "publish"], "page_id [, find, items, publish]")?;
    let page_id = given.get("page_id").filter(|v| pyjson::truthy(v)).map(pyjson::py_str);
    let Some(page_id) = page_id else {
        return Err(ToolError::value("docs_write(action='tickets') requires page_id."));
    };
    let page = dispatch("docs_read", DOCS_READ_OPS, "get", json_map(json!({"page_id": page_id}))).await?;
    let markdown = page["markdown"].as_str().unwrap_or_default().to_string();
    let drafts_given = given_key(&given, "items").cloned();
    let mut lines: Vec<Option<String>> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let drafts: Vec<Value> = match drafts_given {
        None => {
            let find = given_key(&given, "find").map(pyjson::py_str);
            let found = docs_checklist::extract(&markdown, find.as_deref());
            if found.items.is_empty() {
                let skipped = serde_json::to_value(&found.skipped)?;
                let where_ =
                    if find.as_deref().is_some_and(|f| !f.is_empty()) { " in that passage." } else { " on the page." };
                return Ok(json!({
                    "tickets": [],
                    "skipped": skipped,
                    "message": format!("No unchecked task or action item without a ticket{where_}"),
                }));
            }
            lines = found.items.iter().map(|it| Some(it.raw.clone())).collect();
            skipped = serde_json::to_value(&found.skipped)?.as_array().cloned().unwrap_or_default();
            found
                .items
                .iter()
                .map(|it| json!({"title": docs_checklist::clean_title(&it.text), "text": it.text}))
                .collect()
        }
        Some(drafts) => {
            let list = match &drafts {
                Value::Array(list) if !list.is_empty() && list.len() <= 30 => list.clone(),
                _ => return Err(ToolError::value("items: 1 to 30 drafts {title, text, type, status, assignee}.")),
            };
            for (i, d) in list.iter().enumerate() {
                let titled = d.as_object().is_some_and(|d| {
                    d.get("title")
                        .filter(|t| pyjson::truthy(t))
                        .is_some_and(|t| !pytext::strip(&pyjson::py_str(t)).is_empty())
                });
                if !titled {
                    return Err(ToolError::Value(format!("items[{i}]: an object with a title.")));
                }
                let bad: Vec<&str> = d
                    .as_object()
                    .map(|d| {
                        d.keys()
                            .map(String::as_str)
                            .filter(|k| !["title", "text", "type", "status", "assignee"].contains(k))
                            .collect()
                    })
                    .unwrap_or_default();
                if !bad.is_empty() {
                    return Err(ToolError::Value(format!("items[{i}] does not use: {}.", bad.join(", "))));
                }
            }
            // a draft whose text is one line of the page gets its key on that line
            let page_lines: Vec<&str> = markdown.split('\n').collect();
            for d in &list {
                let text = d.get("text").filter(|t| pyjson::truthy(t)).unwrap_or(&d["title"]);
                let text = pytext::strip(&pyjson::py_str(text)).to_string();
                let hit: Vec<&&str> = page_lines
                    .iter()
                    .filter(|ln| !text.is_empty() && pytext::strip(&docs_checklist::line_text(ln)) == text)
                    .collect();
                lines.push((hit.len() == 1).then(|| hit[0].to_string()));
            }
            list
        }
    };
    let mut made: Vec<Value> = Vec::new();
    for d in &drafts {
        let text = pytext::strip(&d.get("text").filter(|t| pyjson::truthy(t)).map(pyjson::py_str).unwrap_or_default())
            .to_string();
        let title = format!("From the page [[{}]]", pyjson::py_str(&page["title"]));
        let description = if text.is_empty() {
            format!("{title}.")
        } else {
            format!("{title}:\n\n> {}", pytext::splitlines(&text).join("\n> "))
        };
        let heading: String = pytext::strip(&pyjson::py_str(&d["title"])).chars().take(200).collect();
        let mut args = json_map(json!({
            "action": "create",
            "project_id": page["project_id"],
            "title": heading,
            "description": description,
            "type": d.get("type").filter(|v| pyjson::truthy(v)).cloned().unwrap_or(json!("task")),
        }));
        for key in ["status", "assignee"] {
            if let Some(value) = d.get(key).filter(|v| pyjson::truthy(v)) {
                args.insert(key.into(), value.clone());
            }
        }
        let t = crate::tools::tickets::manage_ticket(args).await?;
        made.push(
            json!({"id": t["id"], "title": t["title"], "status": t.get("status").cloned().unwrap_or(Value::Null)}),
        );
    }
    for m in &made {
        crate::tools::tickets::manage_ticket(json_map(
            json!({"action": "link_doc", "ticket_id": m["id"], "page_id": page_id}),
        ))
        .await?;
    }
    let mut out = Map::new();
    out.insert("tickets".into(), Value::Array(made.clone()));
    if !skipped.is_empty() {
        out.insert("skipped".into(), Value::Array(skipped));
    }
    let marks: Vec<Value> = lines
        .iter()
        .zip(&made)
        .filter_map(|(ln, m)| {
            let ln = ln.as_ref().filter(|ln| !ln.is_empty())?;
            (markdown.matches(ln.as_str()).count() == 1)
                .then(|| json!({"find": ln, "markdown": format!("{} {}", pystr::rstrip(ln), pyjson::py_str(&m["id"])), "mode": "replace"}))
        })
        .collect();
    if !marks.is_empty() && given.get("publish") != Some(&Value::Bool(false)) {
        let ids: Vec<String> = made.iter().map(|m| pyjson::py_str(&m["id"])).collect();
        let page_edit = json_map(json!({
            "page_id": page_id,
            "items": marks,
            "note": format!("Tickets {} made from the page", ids.join(", ")),
        }));
        out.insert("page".into(), edit_page(page_edit).await?);
    }
    Ok(Value::Object(out))
}

/// `docs_write(assign)`: a ticket that gives the page to an AI team to write or review; its lead starts on it.
pub fn assign(given: Map<String, Value>) -> futures::future::BoxFuture<'static, ToolResult> {
    Box::pin(assign_page(given))
}

async fn assign_page(given: Map<String, Value>) -> ToolResult {
    only(
        "assign",
        &given,
        &["page_id", "member_id", "kind", "body"],
        "page_id, member_id, kind (write|review) [, body]",
    )?;
    for key in ["page_id", "member_id", "kind"] {
        if !given.get(key).is_some_and(pyjson::truthy) {
            return Err(ToolError::Value(format!("docs_write(action='assign') requires {key}.")));
        }
    }
    let session = common::async_session();
    let body = given_text(&given, "body");
    let actor = activity::current_actor();
    let out = kb_docs::docs_work::assign_page(
        &session,
        &pyjson::py_str(&given["page_id"]),
        &pyjson::py_str(&given["member_id"]),
        &pyjson::py_str(&given["kind"]),
        body.as_deref(),
        Some(&actor),
    )
    .await
    .map_err(|err| match err {
        // `str(exc)`: a DocsError is its message
        kb_docs::Error::Docs(exc) => ToolError::Value(exc.message),
        other => docs_error(other),
    })?;
    Ok(Value::Object(out))
}
