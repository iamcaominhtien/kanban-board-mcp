//! The New page gallery: the built-in templates (with their page style) and the templates people save from a page
//! ("Save as template…", `docs_template`), and creating a page from one.
//!
//! A saved template keeps either the whole page (`content`), its structure (headings and empty sections: the
//! words are left out) or only its style (page settings, an empty page).

use kb_base::{activity, time};
use kb_db::Session;
use kb_db::entities::{docs_page, docs_template};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, Set};
use kb_doctext::docs_access;
use kb_richdoc::RandomIds;
use serde_json::{Map, Value, json};

use super::body::{BodyInput, PageBody};
use super::pages::{draft_for, get_page, json_or_none, latest_version, page_detail, project};
use super::settings::read_settings;
use crate::{Result, docs_err};

/// Longest template name, in characters.
pub const MAX_TEMPLATE_NAME: usize = 60;
/// Longest template description, in characters.
pub const MAX_TEMPLATE_DESCRIPTION: usize = 200;

/// A built-in template of the rich gallery.
#[derive(Debug, Clone)]
pub struct Builtin {
    /// Its id (`blank`, `requirements`, … and the BA keys of the older list, plus the new long-form ones).
    pub id: String,
    /// Name on the card.
    pub name: String,
    /// One line under the name.
    pub description: String,
    /// Gallery chip: `work`, `writing` or `ba`.
    pub category: &'static str,
    /// The starting page in Markdown.
    pub markdown: String,
    /// Page settings the page starts with.
    pub settings: Value,
    /// Block attributes set after conversion: (index of a top-level block, attrs).
    pub tweaks: Vec<(usize, Value)>,
}

const BLOG_POST: &str = "## A heading that says what you learned\n\nOpen with the moment it started: a day, a number, a \
    sentence someone said.\n\n> One line worth quoting, on its own.\n\n## What happened\n\nTell it in order. Keep \
    paragraphs short.\n\n## What we would do again\n\n- One thing\n- Another thing\n";
const BOOK_CHAPTER: &str = "The first sentence of the chapter goes here, and the large first letter follows it.\n\n\
    Keep writing. Each paragraph is justified, like a printed page.\n\n---\n\nA scene break sits between two scenes.\n";
const SHORT_STORY: &str = "Begin in the middle of something.\n\nParagraphs are indented, as in a book.\n\n---\n\nThe \
    next scene starts after the break.\n";
const NEWSLETTER: &str = "## This week\n\nTwo or three lines on what is new.\n\n## Shipped\n\n- First thing\n- Second \
    thing\n\n## Coming up\n\nWhat to look forward to.\n\n## Thanks\n\nWho helped.\n";
const README: &str = "## What it is\n\nOne paragraph.\n\n## Getting started\n\n```bash\n# install\n```\n\n## How to use \
    it\n\nThe one example everybody needs.\n\n## Who to ask\n\nA name or a channel.\n";

/// The built-in templates of the gallery: the older list (`templates()`, unchanged) and the long-form ones.
pub fn builtins() -> Vec<Builtin> {
    let mut out: Vec<Builtin> = super::templates()
        .into_iter()
        .map(|(id, t)| Builtin {
            category: if id.starts_with("blank")
                || ["requirements", "decision-log", "technical-design", "meeting-notes"].contains(&id.as_str())
            {
                "work"
            } else {
                "ba"
            },
            id,
            name: t.name,
            description: t.description,
            markdown: t.markdown,
            settings: json!({}),
            tweaks: Vec::new(),
        })
        .collect();
    let new =
        |id: &str, name: &str, description: &str, markdown: &str, settings: Value, tweaks: Vec<(usize, Value)>| {
            Builtin {
                id: id.into(),
                name: name.into(),
                description: description.into(),
                category: "writing",
                markdown: markdown.into(),
                settings,
                tweaks,
            }
        };
    out.push(new(
        "blog-post",
        "Blog post",
        "Cover, centred title, pull quote",
        BLOG_POST,
        json!({"width": "narrow", "titleAlign": "center", "titleStyle": "serif", "eyebrow": "BLOG", "bodyFont": "source-serif"}),
        // the opening paragraph starts with a large first letter (Reader 1, 1)
        vec![(1, json!({"dropCap": 3}))],
    ));
    out.push(new(
        "book-chapter",
        "Book chapter",
        "Drop cap, justified text",
        BOOK_CHAPTER,
        json!({"width": "narrow", "bodyFont": "lora", "titleStyle": "serif", "titleAlign": "center", "showReadingTime": false}),
        vec![(0, json!({"dropCap": 3, "textAlign": "justify"})), (1, json!({"textAlign": "justify"}))],
    ));
    out.push(new(
        "short-story",
        "Short story",
        "Serif, indented",
        SHORT_STORY,
        json!({"width": "narrow", "bodyFont": "merriweather", "background": "paper", "titleStyle": "serif", "showOutline": false}),
        vec![(1, json!({"indent": 1})), (3, json!({"indent": 1}))],
    ));
    out.push(new(
        "newsletter",
        "Newsletter",
        "Sections for this week, shipped and coming up",
        NEWSLETTER,
        json!({"width": "normal"}),
        Vec::new(),
    ));
    out.push(new(
        "readme",
        "README",
        "What it is, how to start, who to ask",
        README,
        json!({"width": "normal"}),
        Vec::new(),
    ));
    out
}

/// Applies a built-in's tweaks to its converted page.
fn tweaked(b: &Builtin) -> Value {
    let mut doc = kb_richdoc::markdown_to_doc(&b.markdown, &mut RandomIds);
    if let Some(blocks) = doc.get_mut("content").and_then(Value::as_array_mut) {
        for (i, attrs) in &b.tweaks {
            if let (Some(block), Some(new)) = (blocks.get_mut(*i), attrs.as_object()) {
                let map = block.as_object_mut().and_then(|o| {
                    o.entry("attrs").or_insert_with(|| Value::Object(Map::new()));
                    o.get_mut("attrs").and_then(Value::as_object_mut)
                });
                if let Some(map) = map {
                    for (k, v) in new {
                        map.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    doc
}

fn template_json(t: &docs_template::Model, me: &str) -> Value {
    let content = json_or_none(Some(t.content.as_str()));
    let preview: String = kb_richdoc::doc_to_text(&content).chars().take(240).collect();
    json!({
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "category": t.category,
        "keeps": t.keeps,
        "scope": t.scope,
        "owner": t.owner,
        "mine": t.owner == me,
        "used_count": t.used_count,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
        "settings": json_or_none(t.settings.as_deref()),
        "preview": preview,
    })
}

/// Lists the gallery of a project: `{builtin, yours, project, default_template, hidden}`.
///
/// # Errors
/// The project errors (404, 403).
pub async fn gallery(session: &Session, project_id: &str) -> Result<Map<String, Value>> {
    let project = project(session, project_id, false).await?;
    let me = activity::current_actor();
    let space = super::space::read(&project);
    let builtin: Vec<Value> = builtins()
        .iter()
        .map(|b| {
            json!({"id": b.id, "name": b.name, "description": b.description, "category": b.category,
                   "settings": b.settings, "preview": b.markdown.chars().take(240).collect::<String>()})
        })
        .collect();
    let rows = docs_template::Entity::find()
        .filter(
            Condition::any()
                .add(
                    Condition::all()
                        .add(docs_template::Column::Owner.eq(me.as_str()))
                        .add(docs_template::Column::Scope.eq("me")),
                )
                .add(
                    Condition::all()
                        .add(docs_template::Column::ProjectId.eq(project_id))
                        .add(docs_template::Column::Scope.eq("project")),
                ),
        )
        .order_by_desc(docs_template::Column::UpdatedAt)
        .all(session)
        .await?;
    let (mine, shared): (Vec<_>, Vec<_>) = rows.iter().partition(|t| t.owner == me);
    let mut out = Map::new();
    out.insert("builtin".into(), Value::Array(builtin));
    out.insert("yours".into(), Value::Array(mine.iter().map(|t| template_json(t, &me)).collect()));
    out.insert("project".into(), Value::Array(shared.iter().map(|t| template_json(t, &me)).collect()));
    out.insert("default_template".into(), space.get("defaultTemplate").cloned().unwrap_or(json!("blank")));
    out.insert("hidden".into(), space.get("hiddenTemplates").cloned().unwrap_or(json!([])));
    Ok(out)
}

/// What "Save as template…" sends.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TemplateSave {
    /// The page to save from.
    pub page_id: String,
    /// The template's name.
    pub name: String,
    /// One line under the name.
    #[serde(default)]
    pub description: Option<String>,
    /// Gallery chip.
    #[serde(default)]
    pub category: Option<String>,
    /// `content`, `structure` or `style`.
    #[serde(default = "content")]
    pub keeps: String,
    /// `me` or `project`.
    #[serde(default = "me")]
    pub scope: String,
    /// Replace a template of yours with the same name (instead of 409 `name_taken`).
    #[serde(default)]
    pub replace: bool,
}

fn content() -> String {
    "content".into()
}
fn me() -> String {
    "me".into()
}

/// Keeps only the structure of a page: headings, and one empty paragraph under each; tables keep their shape.
fn structure_of(doc: &Value) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    for block in doc.get("content").and_then(Value::as_array).into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("heading") => {
                blocks.push(block.clone());
                blocks.push(json!({"type": "paragraph"}));
            }
            Some("table" | "callout" | "columns") => blocks.push(empty_text(block)),
            _ => {}
        }
    }
    if blocks.is_empty() {
        blocks.push(json!({"type": "paragraph"}));
    }
    json!({"type": "doc", "content": blocks})
}

/// A block with every text left out (a table keeps its rows and cells).
fn empty_text(node: &Value) -> Value {
    let mut out = node.clone();
    if let Some(o) = out.as_object_mut() {
        o.remove("text");
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            let kept: Vec<Value> = children
                .iter()
                .filter(|c| c.get("type").and_then(Value::as_str) != Some("text"))
                .map(empty_text)
                .collect();
            o.insert("content".into(), Value::Array(kept));
        }
    }
    out
}

/// Saves a page as a template; returns the template.
///
/// # Errors
/// 422 `name_required`, `name_too_long`, `bad_keeps`, `bad_scope`; 409 `name_taken` (with `template_id`) when a
/// template of yours has that name and `replace` is false; the page errors.
pub async fn save_template(session: &Session, project_id: &str, req: &TemplateSave) -> Result<Value> {
    project(session, project_id, false).await?;
    let page = get_page(session, &req.page_id, false, false).await?;
    if page.project_id != project_id {
        return docs_err(422, "bad_page", "The page belongs to another project");
    }
    let name = kb_base::pytext::strip(&req.name).to_string();
    if name.is_empty() {
        return docs_err(422, "name_required", "Give the template a name");
    }
    if name.chars().count() > MAX_TEMPLATE_NAME {
        return docs_err(422, "name_too_long", format!("A template name is limited to {MAX_TEMPLATE_NAME} characters"));
    }
    if !["content", "structure", "style"].contains(&req.keeps.as_str()) {
        return docs_err(422, "bad_keeps", "Keep the content, the structure or the style");
    }
    if !["me", "project"].contains(&req.scope.as_str()) {
        return docs_err(422, "bad_scope", "A template is yours or the project's");
    }
    let me = activity::current_actor();
    let body = match latest_version(session, &page).await? {
        Some(v) => PageBody::of_version(&v).into_rich(),
        None => match draft_for(session, &page.id, &me).await? {
            Some(d) => PageBody::of_draft(&d).into_rich(),
            None => PageBody::from_input(BodyInput::Markdown(""))?,
        },
    };
    let doc = body.content.unwrap_or_else(|| json!({"type": "doc", "content": [{"type": "paragraph"}]}));
    let kept = match req.keeps.as_str() {
        "structure" => structure_of(&doc),
        "style" => json!({"type": "doc", "content": [{"type": "paragraph"}]}),
        _ => doc,
    };
    let settings = read_settings(page.settings.as_deref());
    let existing = docs_template::Entity::find()
        .filter(docs_template::Column::Owner.eq(me.as_str()))
        .filter(docs_template::Column::Name.eq(name.as_str()))
        .one(session)
        .await?;
    let description = req.description.as_deref().map(|d| d.chars().take(MAX_TEMPLATE_DESCRIPTION).collect::<String>());
    let now = time::now_iso();
    let saved = match existing {
        Some(t) if !req.replace => {
            return Err(kb_doctext::docs_text::DocsError::new(
                409,
                "name_taken",
                "You already have a template with this name",
            )
            .with("template_id", t.id)
            .into());
        }
        Some(t) => {
            let mut row = kb_db::edit(t);
            row.content = Set(kept.to_string());
            row.settings = Set(Some(Value::Object(settings).to_string()));
            row.keeps = Set(req.keeps.clone());
            row.scope = Set(req.scope.clone());
            row.description = Set(description);
            row.category = Set(req.category.clone());
            row.project_id = Set(Some(project_id.to_string()));
            row.updated_at = Set(now);
            row.update(session).await?
        }
        None => {
            let mut row = docs_template::new();
            row.project_id = Set(Some(project_id.to_string()));
            row.owner = Set(me.clone());
            row.name = Set(name);
            row.description = Set(description);
            row.category = Set(req.category.clone());
            row.keeps = Set(req.keeps.clone());
            row.scope = Set(req.scope.clone());
            row.content = Set(kept.to_string());
            row.settings = Set(Some(Value::Object(settings).to_string()));
            row.insert(session).await?
        }
    };
    session.commit().await?;
    Ok(template_json(&saved, &me))
}

/// Renames, re-describes or re-shares a template (its owner, or a project admin for a project template).
///
/// # Errors
/// 404 `template_not_found`, 403 `not_yours`, 422 as `save_template`.
pub async fn update_template(session: &Session, template_id: &str, changes: &Map<String, Value>) -> Result<Value> {
    let t = owned_template(session, template_id).await?;
    let me = activity::current_actor();
    let mut row = kb_db::edit(t);
    for (k, v) in changes {
        match (k.as_str(), v) {
            ("name", Value::String(n)) => {
                let n = kb_base::pytext::strip(n).to_string();
                if n.is_empty() || n.chars().count() > MAX_TEMPLATE_NAME {
                    return docs_err(
                        422,
                        "name_too_long",
                        format!("A template name is 1 to {MAX_TEMPLATE_NAME} characters"),
                    );
                }
                row.name = Set(n);
            }
            ("description", d) => {
                row.description = Set(d.as_str().map(|s| s.chars().take(MAX_TEMPLATE_DESCRIPTION).collect()))
            }
            ("category", c) => row.category = Set(c.as_str().map(str::to_string)),
            ("scope", Value::String(s)) if s == "me" || s == "project" => row.scope = Set(s.clone()),
            _ => return docs_err(422, "invalid_template", format!("Cannot set '{k}' to {v}")),
        }
    }
    row.updated_at = Set(time::now_iso());
    let saved = row.update(session).await?;
    session.commit().await?;
    Ok(template_json(&saved, &me))
}

/// Deletes a template (its owner, or a project admin).
///
/// # Errors
/// 404 `template_not_found`, 403 `not_yours`.
pub async fn delete_template(session: &Session, template_id: &str) -> Result<Value> {
    let t = owned_template(session, template_id).await?;
    docs_template::Entity::delete_by_id(t.id.clone()).exec(session).await?;
    session.commit().await?;
    Ok(json!({"id": t.id, "deleted": true}))
}

async fn owned_template(session: &Session, template_id: &str) -> Result<docs_template::Model> {
    let Some(t) = docs_template::Entity::find_by_id(template_id).one(session).await? else {
        return docs_err(404, "template_not_found", "Template not found");
    };
    let me = activity::current_actor();
    if t.owner == me {
        return Ok(t);
    }
    if let Some(pid) = &t.project_id {
        let project = project(session, pid, false).await?;
        let members = docs_access::members_of(session, &project.id).await?;
        if docs_access::role_in(&members, &me) == "admin" {
            return Ok(t);
        }
    }
    docs_err(403, "not_yours", "Only the person who saved this template can change it")
}

/// The starting content and settings of a gallery template (a built-in id or a saved template's id), and counts
/// the use of a saved one. `None` when the id is neither.
///
/// # Errors
/// A database error.
pub async fn template_start(session: &Session, template: &str) -> Result<Option<(Value, Map<String, Value>)>> {
    if let Some(b) = builtins().into_iter().find(|b| b.id == template) {
        let settings = b.settings.as_object().cloned().unwrap_or_default();
        return Ok(Some((tweaked(&b), settings)));
    }
    let Some(t) = docs_template::Entity::find_by_id(template).one(session).await? else { return Ok(None) };
    let me = activity::current_actor();
    if t.scope != "project" && t.owner != me {
        return Ok(None);
    }
    let doc = json_or_none(Some(t.content.as_str()));
    let settings = read_settings(t.settings.as_deref());
    let used = t.used_count + 1;
    let mut row = kb_db::edit(t);
    row.used_count = Set(used);
    row.update(session).await?;
    Ok(Some((doc, settings)))
}

/// Creates a page from a gallery template: like `create_page`, with the template's page and style.
///
/// # Errors
/// As `create_page`; 422 `bad_template` for an unknown template.
pub async fn create_from_template(
    session: &Session,
    project_id: &str,
    title: &str,
    parent_id: Option<&str>,
    template: &str,
) -> Result<Map<String, Value>> {
    let Some((doc, settings)) = template_start(session, template).await? else {
        return docs_err(422, "bad_template", format!("Unknown template '{template}'"));
    };
    let detail = super::create_page(session, project_id, title, parent_id, "blank", Some("")).await?;
    let page_id = detail.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    super::save_draft(session, &page_id, BodyInput::Content(&doc), None, None).await?;
    if !settings.is_empty() {
        super::settings::update_settings(session, &page_id, &settings).await?;
    }
    let page = docs_page::Entity::find_by_id(page_id.as_str()).one(session).await?;
    match page {
        Some(_) => page_detail(session, &page_id).await,
        None => docs_err(404, "page_not_found", "Page not found"),
    }
}
