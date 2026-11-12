//! Diagrams: draw.io drawings kept as an editable `.drawio` source plus an SVG preview.
//!
//! A diagram is referenced from any markdown field as `[Auth flow](diagram:dg_8f2a)`. Saving a new version needs the
//! version you started from (`base_version`), so two people cannot silently overwrite each other. Deleting only
//! *unlinks*: the row and its versions stay (Recycle Bin). Docs pages pin the diagram versions they were published
//! with, so restoring a page restores them.

use std::path::Path;
use std::sync::OnceLock;

use kb_base::{activity, pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{diagram, diagram_settings, diagram_version, project};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder};
use kb_doctext::docs_access;
use kb_doctext::docs_text::DocsError;
use kb_files::drawio_bundle;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::xml::{self, Element};
use crate::{Result, diagram_export, diagram_model, util};

/// Per diagram: the `.drawio` source and the SVG preview each.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_LABEL: usize = 200;
pub const MAX_SUMMARY: usize = 1000;
pub const ITEM_KINDS: [&str; 3] = ["ticket", "comment", "doc"];
pub const SELF_HOSTED_DEFAULT: &str = "http://localhost:8080";
pub const PUBLIC_URL: &str = "https://embed.diagrams.net";


fn diagram_ref() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(diagram:(dg_[0-9a-f]{8})\)").expect("static pattern"))
}

/// Return the diagram ids a markdown text references, in order, without repeats.
pub fn refs_in(markdown: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for m in diagram_ref().captures_iter(markdown) {
        let id = m[1].to_string();
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

// --- validation ------------------------------------------------------------------

/// `_check_size`: 413 when `text` is over the limit.
pub fn check_size(label: &str, text: &str) -> std::result::Result<(), DocsError> {
    let size = text.len();
    if size > MAX_BYTES {
        let mb = size as f64 / (1024.0 * 1024.0);
        return Err(DocsError::new(
            413,
            "diagram_too_large",
            format!(
                "This diagram is {mb:.1} MB. The limit is {} MB. Remove embedded images or split it into pages, then \
                 save again.",
                MAX_BYTES / (1024 * 1024)
            ),
        )
        .with("size_bytes", size as u64)
        .with("limit_bytes", MAX_BYTES as u64)
        .with("part", label));
    }
    Ok(())
}

/// Reject DTDs and entities: they are never part of a drawing and enable entity bombs.
pub fn forbid_dtd(text: &str, what: &str) -> std::result::Result<(), DocsError> {
    let trimmed = text.trim_start_matches(pytext::is_space);
    let head: String = trimmed.chars().take(4096).collect::<String>().to_uppercase();
    if head.contains("<!DOCTYPE") || text.to_uppercase().contains("<!ENTITY") {
        return Err(DocsError::new(
            422,
            "invalid_diagram",
            format!("The {what} contains a DTD or entity declaration, which is not allowed."),
        ));
    }
    Ok(())
}

/// `_parse(text, what)`.
fn parse(text: &str, what: &str) -> std::result::Result<Element, DocsError> {
    forbid_dtd(text, what)?;
    xml::fromstring(text)
        .map_err(|e| DocsError::new(422, "invalid_diagram", format!("The {what} is not valid XML ({e}).")))
}

/// Check a `.drawio` source is well-formed draw.io XML and within the size limit.
///
/// `source` is `<mxfile>` or `<mxGraphModel>` XML. Returns the parsed root element; fails with 413 if too large and
/// 422 if it is not draw.io XML.
pub fn validate_source(source: &str) -> std::result::Result<Element, DocsError> {
    check_size("source", source)?;
    let root = parse(source, "diagram file")?;
    if !matches!(root.local(), "mxfile" | "mxGraphModel") {
        return Err(DocsError::new(
            422,
            "invalid_diagram",
            "This is not a draw.io file (expected an <mxfile> or <mxGraphModel>).",
        ));
    }
    Ok(root)
}

/// The `<mxGraphModel>` of each page; compressed pages are inflated.
fn graph_models(root: &Element) -> Vec<Element> {
    if root.local() == "mxGraphModel" {
        return vec![root.clone()];
    }
    let mut models = Vec::new();
    for page in root.iter() {
        if page.local() != "diagram" {
            continue;
        }
        if let Some(inner) = page.children.iter().find(|c| c.local() == "mxGraphModel") {
            models.push(inner.clone());
            continue;
        }
        let data = pytext::strip(page.text.as_deref().unwrap_or(""));
        if data.is_empty() {
            continue;
        }
        if let Ok(parsed) = diagram_model::inflate(data) {
            models.push(parsed);
        }
    }
    models
}

/// Every `mxCell`, `UserObject` and `object` of every page (cloned out of the models).
fn cells(root: &Element) -> Vec<Element> {
    let mut out = Vec::new();
    for m in graph_models(root) {
        for c in m.iter() {
            if matches!(c.local(), "mxCell" | "UserObject" | "object") {
                out.push(c.clone());
            }
        }
    }
    out
}

/// True when the drawing has no shape or connector (only the two root cells).
pub fn is_empty(root: &Element) -> bool {
    let all = cells(root);
    for c in &all {
        if c.get("vertex") == Some("1") || c.get("edge") == Some("1") {
            return false;
        }
    }
    !all.iter().any(|c| matches!(c.local(), "UserObject" | "object"))
}

/// `_plain`: a label with its tags taken out and its white space squeezed.
fn plain(label: &str) -> String {
    static TAGS: OnceLock<Regex> = OnceLock::new();
    let tags = TAGS.get_or_init(|| Regex::new(r"<[^>]{0,200}>").expect("static pattern"));
    let text = tags.replace_all(label, " ");
    let text = text.replace("&nbsp;", " ").replace("&amp;", "&");
    pytext::squash(&text)
}

/// Draft a short text summary from the labels in the drawing (shape and connector text).
pub fn text_summary(root: &Element, limit: usize) -> String {
    let mut labels: Vec<String> = Vec::new();
    for c in cells(root) {
        let text = if matches!(c.local(), "UserObject" | "object") {
            plain(c.get("label").unwrap_or(""))
        } else {
            plain(c.get("value").unwrap_or(""))
        };
        if !text.is_empty() && !labels.contains(&text) {
            labels.push(text);
        }
    }
    if labels.is_empty() {
        return String::new();
    }
    let shown = labels.iter().take(limit).cloned().collect::<Vec<_>>().join(", ");
    let more = if labels.len() > limit { format!(" and {} more", labels.len() - limit) } else { String::new() };
    format!("Contains: {shown}{more}.")
}

fn starts_dangerous(value: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^\s*(?:javascript|data:text/html)").expect("static pattern")).is_match(value)
}

fn clean_attributes(el: &mut Element) {
    el.attrib.retain(|(name, value)| {
        let local = xml::local(name);
        if local.to_lowercase().starts_with("on") {
            return false;
        }
        !(local == "href" && starts_dangerous(value))
    });
    el.children.retain(|c| !matches!(c.local(), "script" | "iframe" | "object" | "embed"));
    for child in &mut el.children {
        clean_attributes(child);
    }
}

/// Return the SVG preview without scripts, event handlers or `javascript:` links.
///
/// `svg` is the SVG exported by the editor; fails with 413 if too large and 422 if it is not an SVG.
pub fn sanitize_svg(svg: &str) -> std::result::Result<String, DocsError> {
    check_size("preview", svg)?;
    let mut root = parse(svg, "preview image")?;
    if root.local() != "svg" {
        return Err(DocsError::new(422, "invalid_diagram", "The preview must be an SVG image."));
    }
    // the root's own attributes are cleaned too, and its children are filtered before they are visited
    clean_attributes(&mut root);
    let out = xml::tostring(&root, &diagram_model::REGISTERED_NAMESPACES);
    check_size("preview", &out)?;
    Ok(out)
}

// --- permissions and lookups --------------------------------------------------------

/// The caller's role in a project: viewer, member or admin.
pub async fn role_of(session: &Session, project_id: &str) -> Result<String> {
    Ok(docs_access::role_in(&docs_access::members_of(session, project_id).await?, &activity::current_actor()))
}

/// `_need_member`: viewers cannot edit.
pub fn need_member(role: &str) -> std::result::Result<(), DocsError> {
    if role == "viewer" {
        return Err(DocsError::new(
            403,
            "read_only",
            "Viewers can look at and download diagrams but cannot edit them.",
        ));
    }
    Ok(())
}

/// `_diagram(session, diagram_id, deleted_ok=...)`.
pub async fn get_row(session: &Session, diagram_id: &str, deleted_ok: bool) -> Result<diagram::Model> {
    let found = diagram::Entity::find_by_id(diagram_id).one(session).await?;
    match found {
        Some(d) if deleted_ok || d.deleted_at.as_deref().is_none_or(str::is_empty) => Ok(d),
        _ => Err(DocsError::new(
            404,
            "diagram_not_found",
            "Diagram not found. It was deleted, or you do not have access.",
        )
        .into()),
    }
}

/// `_version(session, diagram_id, n, current)`.
async fn version_row(
    session: &Session,
    diagram_id: &str,
    n: Option<i32>,
    current: i32,
) -> Result<diagram_version::Model> {
    let want = n.unwrap_or(current);
    let row = diagram_version::Entity::find()
        .filter(diagram_version::Column::DiagramId.eq(diagram_id))
        .filter(diagram_version::Column::Version.eq(want))
        .one(session)
        .await?;
    row.ok_or_else(|| DocsError::new(404, "version_not_found", format!("Diagram version {want} not found")).into())
}

/// `_label`: a name without brackets or line breaks, at most 200 characters, `Diagram` when nothing is left.
pub fn label(label: Option<&str>) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[\[\]\n\r]+").expect("static pattern"));
    let text = re.replace_all(label.unwrap_or(""), " ");
    let text = util::strip_cut(&text, MAX_LABEL);
    if text.is_empty() { "Diagram".to_string() } else { text }
}

fn is_live(deleted_at: &Option<String>) -> bool {
    deleted_at.as_deref().is_none_or(str::is_empty)
}

/// The diagram as the API returns it (no source or SVG body).
pub async fn out(session: &Session, d: &diagram::Model, v: Option<&diagram_version::Model>) -> Result<Map<String, Value>> {
    let role = role_of(session, &d.project_id).await?;
    let fetched;
    let ver = match v {
        Some(v) => v,
        None => {
            fetched = version_row(session, &d.id, None, d.version).await?;
            &fetched
        }
    };
    let empty = if ver.source.is_empty() {
        true
    } else {
        match xml::fromstring(&ver.source) {
            Ok(root) => is_empty(&root),
            Err(_) => false,
        }
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(d.id));
    out.insert("project_id".into(), json!(d.project_id));
    out.insert("label".into(), json!(d.label));
    out.insert("summary".into(), json!(d.summary));
    out.insert("item_kind".into(), json!(d.item_kind));
    out.insert("item_id".into(), json!(d.item_id));
    out.insert("version".into(), json!(d.version));
    out.insert("shown_version".into(), json!(ver.version));
    out.insert("empty".into(), json!(empty));
    out.insert("preview_kind".into(), json!(ver.preview_kind));
    out.insert("created_by".into(), json!(d.created_by));
    out.insert("created_at".into(), json!(d.created_at));
    out.insert("updated_by".into(), json!(d.updated_by));
    out.insert("updated_at".into(), json!(d.updated_at));
    out.insert("deleted_at".into(), json!(d.deleted_at));
    out.insert("size_bytes".into(), json!(ver.source.len()));
    out.insert("role".into(), json!(role));
    out.insert("can_edit".into(), json!(role != "viewer" && is_live(&d.deleted_at)));
    Ok(out)
}

// --- create, read, update, delete ---------------------------------------------------

/// What `create_diagram` is given besides the project (the request body of `POST /projects/{id}/diagrams`).
#[derive(Debug, Clone, Default)]
pub struct NewDiagram {
    /// Name; becomes the alt text.
    pub label: Option<String>,
    /// The `.drawio` XML.
    pub source: String,
    /// The SVG preview made by the editor on save.
    pub svg: String,
    /// Optional short text summary.
    pub summary: Option<String>,
    /// `ticket`, `comment` or `doc` when it belongs to an item.
    pub item_kind: Option<String>,
    /// Id of that item.
    pub item_id: Option<String>,
    /// Who drew the preview: `editor` (exact), `agent` or `basic`.
    pub preview_kind: String,
}

/// Save a new diagram (version 1).
///
/// Fails with 403 for viewers, 404 for an unknown project, 413 / 422 for a bad file.
pub async fn create_diagram(session: &Session, project_id: &str, new: NewDiagram) -> Result<Map<String, Value>> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(DocsError::new(404, "project_not_found", "Project not found").into());
    }
    need_member(&role_of(session, project_id).await?)?;
    validate_source(&new.source)?;
    let clean_svg = sanitize_svg(&new.svg)?;
    if let Some(kind) = &new.item_kind {
        if !ITEM_KINDS.contains(&kind.as_str()) {
            return Err(DocsError::new(422, "invalid_item", "item_kind must be one of ('ticket', 'comment', 'doc')").into());
        }
    }
    let actor = activity::current_actor();
    let mut row = diagram::new();
    row.project_id = Set(project_id.to_string());
    row.label = Set(label(new.label.as_deref()));
    row.summary = Set(util::strip_cut(new.summary.as_deref().unwrap_or(""), MAX_SUMMARY));
    row.item_kind = Set(new.item_kind.clone());
    row.item_id = Set(new.item_id.clone());
    row.created_by = Set(actor.clone());
    row.updated_by = Set(actor.clone());
    let d = row.insert(session).await?;
    let mut version = diagram_version::new();
    version.diagram_id = Set(d.id.clone());
    version.version = Set(1);
    version.source = Set(new.source.clone());
    version.svg = Set(clean_svg);
    version.preview_kind = Set(new.preview_kind.clone());
    version.author = Set(actor);
    version.insert(session).await?;
    session.commit().await?;
    out(session, &d, None).await
}

/// Return a diagram's details and a text summary drafted from its labels.
///
/// `version` is a specific saved version (the latest by default); `include_source` also returns the `.drawio` source
/// (the editor needs it, a page does not).
pub async fn get_diagram(
    session: &Session,
    diagram_id: &str,
    version: Option<i32>,
    include_source: bool,
) -> Result<Map<String, Value>> {
    let d = get_row(session, diagram_id, false).await?;
    let v = version_row(session, &d.id, version, d.version).await?;
    let mut out = out(session, &d, Some(&v)).await?;
    if include_source {
        out.insert("source".into(), json!(v.source));
    }
    let summary = match xml::fromstring(&v.source) {
        Ok(root) => text_summary(&root, 12),
        Err(_) => String::new(),
    };
    out.insert("suggested_summary".into(), json!(summary));
    Ok(out)
}

/// Return `(content, media_type, file_name)` of a diagram's `svg` preview or `drawio` source.
pub async fn read_file(
    session: &Session,
    diagram_id: &str,
    kind: &str,
    version: Option<i32>,
) -> Result<(String, &'static str, String)> {
    let d = get_row(session, diagram_id, false).await?;
    let v = version_row(session, &d.id, version, d.version).await?;
    let stem = util::file_stem(&d.label);
    let stem = if stem.is_empty() { "diagram".to_string() } else { stem };
    if kind == "svg" {
        return Ok((v.svg, "image/svg+xml", format!("{stem}.svg")));
    }
    Ok((v.source, "application/vnd.jgraph.mxfile", format!("{stem}.drawio")))
}

/// What `update_diagram` is given besides the diagram.
#[derive(Debug, Clone, Default)]
pub struct DiagramChange {
    /// The version the edit started from; must be the latest.
    pub base_version: i32,
    /// The `.drawio` XML.
    pub source: String,
    /// The SVG preview.
    pub svg: String,
    /// New name, if changed.
    pub label: Option<String>,
    /// New text summary, if changed.
    pub summary: Option<String>,
    /// What changed, kept with the version.
    pub note: Option<String>,
    /// Who drew the preview: `editor` (exact), `agent` or `basic`.
    pub preview_kind: String,
}

/// Save a new version of a diagram.
///
/// Fails with 403 for viewers and 409 `diagram_conflict` if someone saved a newer version.
pub async fn update_diagram(session: &Session, diagram_id: &str, change: DiagramChange) -> Result<Map<String, Value>> {
    let d = get_row(session, diagram_id, false).await?;
    need_member(&role_of(session, &d.project_id).await?)?;
    if change.base_version != d.version {
        let latest = version_row(session, &d.id, None, d.version).await?;
        return Err(DocsError::new(
            409,
            "diagram_conflict",
            format!("{} saved a newer version while you were editing.", latest.author),
        )
        .with("latest_version", d.version)
        .with("latest_author", latest.author.clone())
        .with("latest_at", latest.created_at.clone())
        .into());
    }
    validate_source(&change.source)?;
    let clean_svg = sanitize_svg(&change.svg)?;
    let actor = activity::current_actor();
    let new_version = d.version + 1;
    let mut row = d.into_active_model();
    row.version = Set(new_version);
    row.updated_by = Set(actor.clone());
    row.updated_at = Set(time::now_iso());
    if let Some(l) = &change.label {
        row.label = Set(label(Some(l)));
    }
    if let Some(s) = &change.summary {
        row.summary = Set(util::strip_cut(s, MAX_SUMMARY));
    }
    let d = row.update(session).await?;
    let mut version = diagram_version::new();
    version.diagram_id = Set(d.id.clone());
    version.version = Set(d.version);
    version.source = Set(change.source.clone());
    version.svg = Set(clean_svg);
    version.preview_kind = Set(change.preview_kind.clone());
    version.author = Set(actor);
    let note = util::strip_cut(change.note.as_deref().unwrap_or(""), 200);
    version.note = Set((!note.is_empty()).then_some(note));
    version.insert(session).await?;
    session.commit().await?;
    out(session, &d, None).await
}

/// Unlink a diagram: it stops resolving but is kept, with its versions, for restoring.
pub async fn delete_diagram(session: &Session, diagram_id: &str) -> Result<Map<String, Value>> {
    let d = get_row(session, diagram_id, false).await?;
    need_member(&role_of(session, &d.project_id).await?)?;
    let mut row = d.into_active_model();
    row.deleted_at = Set(Some(time::now_iso()));
    row.deleted_by = Set(Some(activity::current_actor()));
    let d = row.update(session).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("id".into(), json!(d.id));
    out.insert("deleted_at".into(), json!(d.deleted_at));
    Ok(out)
}

/// Bring an unlinked diagram back.
pub async fn restore_diagram(session: &Session, diagram_id: &str) -> Result<Map<String, Value>> {
    let d = get_row(session, diagram_id, true).await?;
    need_member(&role_of(session, &d.project_id).await?)?;
    let mut row = d.into_active_model();
    row.deleted_at = Set(None);
    row.deleted_by = Set(None);
    let d = row.update(session).await?;
    session.commit().await?;
    out(session, &d, None).await
}

/// List a diagram's saved versions, newest first.
pub async fn list_versions(session: &Session, diagram_id: &str) -> Result<Vec<Value>> {
    let d = get_row(session, diagram_id, false).await?;
    let rows = diagram_version::Entity::find()
        .filter(diagram_version::Column::DiagramId.eq(d.id.as_str()))
        .order_by_desc(diagram_version::Column::Version)
        .all(session)
        .await?;
    Ok(rows
        .into_iter()
        .map(|v| {
            json!({
                "version": v.version, "author": v.author, "note": v.note, "created_at": v.created_at,
                "size_bytes": v.source.len(),
            })
        })
        .collect())
}

/// List a project's diagrams (or, with `deleted`, the ones in the Recycle Bin).
pub async fn list_diagrams(session: &Session, project_id: &str, deleted: bool) -> Result<Vec<Map<String, Value>>> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(DocsError::new(404, "project_not_found", "Project not found").into());
    }
    let rows = diagram::Entity::find()
        .filter(diagram::Column::ProjectId.eq(project_id))
        .order_by_desc(diagram::Column::UpdatedAt)
        .all(session)
        .await?;
    let mut out = Vec::new();
    for d in rows {
        if !is_live(&d.deleted_at) == deleted {
            out.push(self::out(session, &d, None).await?);
        }
    }
    Ok(out)
}

// --- Docs history -------------------------------------------------------------------

/// JSON `{diagram id: version}` for the live diagrams a page text references.
pub async fn pin_versions(session: &Session, markdown: &str) -> Result<String> {
    let mut pins = Map::new();
    for diagram_id in refs_in(markdown) {
        if let Some(d) = diagram::Entity::find_by_id(diagram_id.as_str()).one(session).await? {
            if is_live(&d.deleted_at) {
                pins.insert(diagram_id, json!(d.version));
            }
        }
    }
    Ok(pyjson::dumps(&Value::Object(pins)))
}

/// Read the pins stored on a page version (only whole numbers are kept, `true` and `false` count as 1 and 0 as
/// Python's `isinstance(v, int)` has it).
pub fn parse_pins(raw: Option<&str>) -> Map<String, Value> {
    let raw = match raw {
        Some(r) if !r.is_empty() => r,
        _ => "{}",
    };
    match pyjson::loads(raw) {
        Some(Value::Object(map)) => map
            .into_iter()
            .filter(|(_, v)| v.is_i64() || v.is_u64() || v.is_boolean())
            .collect(),
        _ => Map::new(),
    }
}

fn pin_number(value: &Value) -> i64 {
    match value {
        Value::Bool(b) => i64::from(*b),
        other => other.as_i64().unwrap_or(i64::MAX),
    }
}

/// Make each pinned diagram's latest version the pinned one (as a new version); no commit.
///
/// An unlinked diagram that a restored page uses is linked again. A diagram that no longer exists is skipped; the
/// page then shows its "Diagram not found" state.
pub async fn restore_pins(session: &Session, pins: &Map<String, Value>) -> Result<()> {
    let actor = activity::current_actor();
    for (diagram_id, n) in pins {
        let n = pin_number(n);
        let Some(d) = diagram::Entity::find_by_id(diagram_id.as_str()).one(session).await? else {
            continue;
        };
        let current = d.version;
        let id = d.id.clone();
        let mut row = d.into_active_model();
        row.deleted_at = Set(None);
        row.deleted_by = Set(None);
        let mut copy = None;
        if i64::from(current) != n {
            let old = diagram_version::Entity::find()
                .filter(diagram_version::Column::DiagramId.eq(id.as_str()))
                .filter(diagram_version::Column::Version.eq(n))
                .one(session)
                .await?;
            if let Some(old) = old {
                row.version = Set(current + 1);
                row.updated_by = Set(actor.clone());
                row.updated_at = Set(time::now_iso());
                let mut version = diagram_version::new();
                version.diagram_id = Set(id.clone());
                version.version = Set(current + 1);
                version.source = Set(old.source);
                version.svg = Set(old.svg);
                version.preview_kind = Set(old.preview_kind);
                version.author = Set(actor.clone());
                version.note = Set(Some(format!("Restored from v{n}")));
                copy = Some(version);
            }
        }
        row.update(session).await?;
        if let Some(version) = copy {
            version.insert(session).await?;
        }
    }
    Ok(())
}

// --- editor setting -----------------------------------------------------------------

/// Where the draw.io editor runs, with the address the browser should open.
///
/// The editor shipped with the app (`built-in`, `drawio_bundle`) is the default when this install has it, also for a
/// self-hosted setting left at its default address: that address (http://localhost:8080) was only ever an example,
/// which nobody had started, so Edit spun and failed. `origin` is the board's address as the caller sees it (a
/// request's base URL); without it the board's own local address is used, and `effective_url` is None for the
/// built-in editor until that is known.
pub async fn get_settings(session: &Session, origin: Option<&str>) -> Result<Map<String, Value>> {
    let row = diagram_settings::Entity::find_by_id(1).one(session).await?;
    let url = row.as_ref().map(|r| pytext::strip(&r.url).to_string()).unwrap_or_default();
    let mut mode = row.map_or("self-hosted".to_string(), |r| r.mode);
    let built_in = drawio_bundle::available();
    if mode == "built-in" || (built_in && mode == "self-hosted" && url.is_empty()) {
        mode = "built-in".to_string();
    }
    let effective: Option<String> = if mode == "public" {
        Some(PUBLIC_URL.to_string())
    } else if mode == "built-in" {
        if built_in { drawio_bundle::url(origin) } else { None }
    } else if url.is_empty() {
        Some(SELF_HOSTED_DEFAULT.to_string())
    } else {
        Some(url.clone())
    };
    let mut out = Map::new();
    out.insert("mode".into(), json!(mode));
    out.insert("url".into(), json!(url));
    out.insert("effective_url".into(), json!(effective.as_deref().filter(|e| !e.is_empty()).map(|e| e.trim_end_matches('/'))));
    out.insert("default_self_hosted_url".into(), json!(SELF_HOSTED_DEFAULT));
    out.insert("public_url".into(), json!(PUBLIC_URL));
    out.insert("built_in_available".into(), json!(built_in));
    out.insert("built_in_version".into(), json!(drawio_bundle::version()));
    out.insert("sends_drawings_to_third_party".into(), json!(mode == "public"));
    Ok(out)
}

/// Whether the editor answers at its address. The public editor is not probed (the browser loads it from the
/// internet), the built-in one is there when this install ships it; a self-hosted one is asked with a short TCP
/// connection.
pub async fn editor_check(session: &Session, origin: Option<&str>) -> Result<Map<String, Value>> {
    let s = get_settings(session, origin).await?;
    let mode = s["mode"].as_str().unwrap_or_default().to_string();
    let url = s["effective_url"].clone();
    let mut out = Map::new();
    if mode == "public" {
        out.insert("mode".into(), json!("public"));
        out.insert("url".into(), url);
        out.insert("reachable".into(), json!(true));
        return Ok(out);
    }
    if mode == "built-in" {
        out.insert("mode".into(), json!("built-in"));
        out.insert("reachable".into(), json!(url.as_str().is_some_and(|u| !u.is_empty())));
        out.insert("url".into(), url);
        // keep the Python key order: mode, url, reachable
        let reachable = out.remove("reachable").unwrap_or(Value::Null);
        out.insert("reachable".into(), reachable);
        return Ok(out);
    }
    let ok = diagram_export::reachable(url.as_str().unwrap_or(""), std::time::Duration::from_secs_f64(1.5)).await;
    out.insert("mode".into(), json!(mode));
    out.insert("url".into(), url);
    out.insert("reachable".into(), json!(ok));
    Ok(out)
}

/// Change where the editor runs. Admin only.
///
/// Fails with 403 unless the caller is an admin and 422 for a bad mode or address.
pub async fn set_settings(
    session: &Session,
    mode: &str,
    url: Option<&str>,
    origin: Option<&str>,
) -> Result<Map<String, Value>> {
    let projects = project::Entity::find().all(session).await?;
    let actor = activity::current_actor();
    let mut is_admin = actor == activity::HUMAN_ACTOR;
    if !is_admin {
        for p in &projects {
            if docs_access::role_in(&docs_access::members_of(session, &p.id).await?, &actor) == "admin" {
                is_admin = true;
                break;
            }
        }
    }
    if !is_admin {
        return Err(DocsError::new(403, "admin_only", "Only an admin can change where the editor runs.").into());
    }
    if !matches!(mode, "built-in" | "self-hosted" | "public") {
        return Err(DocsError::new(422, "invalid_mode", "mode must be built-in, self-hosted or public").into());
    }
    if mode == "built-in" && !drawio_bundle::available() {
        return Err(DocsError::new(
            422,
            "no_built_in_editor",
            "This install has no built-in draw.io editor; choose self-hosted or public.",
        )
        .into());
    }
    let clean = pytext::strip(url.unwrap_or("")).to_string();
    static URL: OnceLock<Regex> = OnceLock::new();
    let re = URL.get_or_init(|| Regex::new(r"^https?://[^\s/?#]+(?:/[^\s?#]*)?$").expect("static pattern"));
    if !clean.is_empty() && !re.is_match(&clean) {
        return Err(DocsError::new(422, "invalid_url", "The editor address must start with http:// or https://").into());
    }
    match diagram_settings::Entity::find_by_id(1).one(session).await? {
        Some(row) => {
            let mut row = row.into_active_model();
            row.mode = Set(mode.to_string());
            row.url = Set(clean);
            row.update(session).await?;
        }
        None => {
            let mut row = diagram_settings::new();
            row.id = Set(1);
            row.mode = Set(mode.to_string());
            row.url = Set(clean);
            row.insert(session).await?;
        }
    }
    session.commit().await?;
    get_settings(session, origin).await
}

// --- AI agent access: the .drawio file on disk ---------------------------------------------------

fn file_error(message: impl Into<String>) -> DocsError {
    DocsError::new(422, "invalid_path", message)
}

/// Text of a local file an agent points at (absolute path, within the size limit).
pub fn read_local(path: &str, what: &str) -> std::result::Result<String, DocsError> {
    use std::io::Read;
    if !kb_files::pathlib::is_absolute(path) {
        return Err(file_error(format!("{what}: give an absolute path (got {}).", pytext::repr(path))));
    }
    let p = Path::new(path);
    if !p.is_file() {
        return Err(file_error(format!("{what}: {path} is not a file.")));
    }
    let mut raw = Vec::new();
    let read = std::fs::File::open(p).and_then(|f| f.take(MAX_BYTES as u64 + 1).read_to_end(&mut raw));
    if let Err(e) = read {
        return Err(file_error(format!("{what}: {path} could not be read ({}).", util::strerror(&e))));
    }
    if raw.len() > MAX_BYTES {
        check_size(what, &util::decode_ignore(&raw))?;
    }
    String::from_utf8(raw).map_err(|_| file_error(format!("{what}: {path} is not UTF-8 text.")))
}

/// Write a diagram's `.drawio` source to a local path (a folder gets `<name>.drawio` inside it).
///
/// Returns `{path, id, label, version, markdown}`; send `version` back as `base_version` when saving.
pub async fn export_to_file(
    session: &Session,
    diagram_id: &str,
    path: &str,
    version: Option<i32>,
) -> Result<Map<String, Value>> {
    let d = get_row(session, diagram_id, false).await?;
    let v = version_row(session, &d.id, version, d.version).await?;
    if !kb_files::pathlib::is_absolute(path) {
        return Err(file_error(format!("Give an absolute path (got {}).", pytext::repr(path))).into());
    }
    let mut target = util::path_str(path);
    let as_path = Path::new(&target).to_path_buf();
    // a folder, or a path without an extension that does not exist yet (it was written as a file named "out", issue
    // #267), gets '<name>.drawio' inside it
    if as_path.is_dir()
        || path.ends_with('/')
        || path.ends_with('\\')
        || (!as_path.exists() && kb_files::pathlib::suffix(path).is_empty())
    {
        let stem = util::file_stem(&d.label);
        let stem = if stem.is_empty() { "diagram".to_string() } else { stem };
        target = util::path_str(&format!("{target}/{stem}.drawio"));
    }
    let target_path = Path::new(&target);
    let written = (|| -> std::io::Result<()> {
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // a page the editor stored compressed is written out as plain XML, so it can be edited as text
        std::fs::write(target_path, diagram_model::uncompressed(&v.source))
    })();
    if let Err(e) = written {
        return Err(file_error(format!("{target} could not be written ({}).", util::strerror(&e))).into());
    }
    let mut out = Map::new();
    out.insert("path".into(), json!(target));
    out.insert("id".into(), json!(d.id));
    out.insert("label".into(), json!(d.label));
    out.insert("version".into(), json!(d.version));
    out.insert("markdown".into(), json!(format!("[{}](diagram:{})", d.label, d.id)));
    Ok(out)
}

/// The SVG to store and who drew it: `(svg, preview_kind)`.
///
/// The agent's own export wins; then the editor itself in a hidden browser (exact), when the desktop app or a
/// browser is available; otherwise the server draws a plain one.
pub async fn preview(session: &Session, source: &str, svg_path: Option<&str>) -> Result<(String, &'static str)> {
    if let Some(svg_path) = svg_path.filter(|p| !p.is_empty()) {
        return Ok((read_local(svg_path, "svg_path")?, "agent"));
    }
    let settings = get_settings(session, None).await?;
    let mode = settings["mode"].as_str().unwrap_or_default();
    if diagram_export::enabled(mode) {
        let exact = match settings["effective_url"].as_str().filter(|u| !u.is_empty()) {
            Some(url) => diagram_export::export_svg(source, url, None).await,
            None => None,
        };
        if let Some(exact) = exact.filter(|e| !e.is_empty()) {
            return Ok((exact, "editor"));
        }
    }
    Ok((diagram_model::render_svg(source)?, "basic"))
}

/// Create a diagram from a local `.drawio` file.
pub async fn create_from_file(
    session: &Session,
    project_id: &str,
    label: &str,
    path: &str,
    svg_path: Option<&str>,
    summary: Option<&str>,
) -> Result<Map<String, Value>> {
    let source = read_local(path, "path")?;
    validate_source(&source)?;
    let (svg, kind) = preview(session, &source, svg_path).await?;
    let mut out = create_diagram(
        session,
        project_id,
        NewDiagram {
            label: Some(label.to_string()),
            source,
            svg,
            summary: summary.map(str::to_string),
            item_kind: None,
            item_id: None,
            preview_kind: kind.to_string(),
        },
    )
    .await?;
    let markdown = format!("[{}](diagram:{})", out["label"].as_str().unwrap_or(""), out["id"].as_str().unwrap_or(""));
    out.insert("markdown".into(), json!(markdown));
    Ok(out)
}

/// Save a local `.drawio` file as a new version of a diagram (`base_version` guards against overwrites).
pub async fn save_from_file(
    session: &Session,
    diagram_id: &str,
    path: &str,
    base_version: i32,
    svg_path: Option<&str>,
    label: Option<&str>,
) -> Result<Map<String, Value>> {
    let d = get_row(session, diagram_id, false).await?;
    if base_version != d.version {
        // answer the conflict before reading the file
        return update_diagram(
            session,
            diagram_id,
            DiagramChange { base_version, preview_kind: "editor".into(), ..Default::default() },
        )
        .await;
    }
    let source = read_local(path, "path")?;
    validate_source(&source)?;
    let (svg, kind) = preview(session, &source, svg_path).await?;
    update_diagram(
        session,
        diagram_id,
        DiagramChange {
            base_version,
            source,
            svg,
            label: label.map(str::to_string),
            summary: None,
            note: Some("Saved by an AI agent".to_string()),
            preview_kind: kind.to_string(),
        },
    )
    .await
}

/// A project's diagrams in brief: `[{id, label, version, updated_by, updated_at, summary}]`.
pub async fn list_for_agent(session: &Session, project_id: &str) -> Result<Vec<Value>> {
    let keys = ["id", "label", "version", "updated_by", "updated_at", "summary"];
    Ok(list_diagrams(session, project_id, false)
        .await?
        .into_iter()
        .map(|d| Value::Object(keys.iter().map(|k| (k.to_string(), d[*k].clone())).collect()))
        .collect())
}
