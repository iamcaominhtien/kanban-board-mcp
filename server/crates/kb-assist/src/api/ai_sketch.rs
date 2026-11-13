//! `api/ai_sketch.py`: AI in the sketch editor (AI v2): a question about the drawing is one assistant turn with the
//! `sketch-ask` skill on the sketch's chat; the picture of the canvas and the attached files are saved for the turn
//! and read by the assistant. It answers in words and with ideas to add as labels; it does not draw shapes for the
//! person.

use axum::Json;
use axum::extract::DefaultBodyLimit;
use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::http::{HeaderMap, Method};
use axum::response::{IntoResponse, Response};
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, Routes, pyjson, pytext};
use kb_db::entities::{ai_chat, ai_run, project};
use kb_db::sea_orm::EntityTrait;
use kb_files::FileResponse;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::api::{Res, assist_error, assist_failure, by};
use crate::assistant::chat::{self as svc_chat, SendOpts};
use crate::assistant::errors::AssistError;
use crate::assistant::{drafts as svc_drafts, engine, settings as svc_settings};

const MAX_PROMPT: usize = 2000;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 200 * 1024;
const MAX_IMAGES: usize = 4;
const MAX_TEXT_FILES: usize = 3;
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const NEVER_SENT: [&str; 1] = ["Other sketches, hidden layers' names and files outside the board"];

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/ai/sketch/state", get_sketch_ai_state)
        .post("/ai/sketch/preview", post_sketch_ai_preview)
        .add(
            "POST",
            "/ai/sketch/chats/{chat_id}/messages",
            axum::routing::post(post_sketch_ai_message).layer(DefaultBodyLimit::disable()),
        )
        .get("/ai/sketch/chats/{chat_id}/files/{turn_id}/{file}", get_sketch_ai_file)
        .post("/ai/sketch/drafts/{draft_id}/accept", post_sketch_ai_accept)
        .post("/ai/sketch/drafts/{draft_id}/idea", post_sketch_ai_idea)
}

#[derive(Debug, Deserialize)]
struct StateQuery {
    #[allow(dead_code)]
    owner_kind: String,
    #[allow(dead_code)]
    owner_id: String,
    project_id: Option<String>,
    #[allow(dead_code)]
    sketch_id: Option<String>,
}

/// Whether the person may use AI in the sketch editor, and the limits of a message.
async fn get_sketch_ai_state(Query(query): Query<StateQuery>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let mut availability = json!({"code": "ok"});
    if !svc_settings::feature_on(&session, "sketch").await? {
        availability = json!({"code": "feature_off", "message": "Sketch AI is off in Settings \u{203a} AI."});
    } else {
        let project_id = query.project_id.as_deref().filter(|p| !p.is_empty());
        let found = match project_id {
            Some(id) => project::Entity::find_by_id(id).one(&session).await?.is_some(),
            None => false,
        };
        match project_id {
            Some(id) if found => {
                let info = engine::ready(id, "chat").await?;
                if info.get("state").and_then(Value::as_str) != Some("ready") {
                    availability = json!({"code": "not_configured", "message": info.get("message").cloned().unwrap_or(Value::Null)});
                }
            }
            _ => {
                availability =
                    json!({"code": "not_shared", "message": "Put the sketch in a project to ask the AI about it."});
            }
        }
    }
    Ok(Json(json!({
        "availability": availability,
        "member_id": null,
        "estimates": null,
        "limits": {
            "max_ops": 0,
            "max_points": 0,
            "max_text": 200,
            "max_prompt": MAX_PROMPT,
            "max_image_bytes": MAX_IMAGE_BYTES,
            "attachments": {
                "max_images": MAX_IMAGES,
                "max_image_bytes": MAX_FILE_BYTES,
                "max_text_files": MAX_TEXT_FILES,
                "max_text_bytes": MAX_TEXT_BYTES,
                "image_types": IMAGE_TYPES,
            },
        },
        "never_sent": NEVER_SENT,
    })))
}

/// One message as the editor would send it, without the picture and files themselves (only their sizes).
#[derive(Debug, Deserialize)]
struct PreviewBody {
    #[allow(dead_code)]
    owner_kind: String,
    #[allow(dead_code)]
    owner_id: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    #[allow(dead_code)]
    project_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    sketch_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    chat_id: Option<String>,
    #[serde(default = "one")]
    #[allow(dead_code)]
    width: i64,
    #[serde(default = "one")]
    #[allow(dead_code)]
    height: i64,
    #[serde(default = "yes")]
    with_image: bool,
    #[serde(default)]
    image_width: i64,
    #[serde(default)]
    image_height: i64,
    #[serde(default)]
    image_bytes: i64,
    #[serde(default)]
    attachments: Vec<Map<String, Value>>,
}

fn one() -> i64 {
    1
}

fn yes() -> bool {
    true
}

/// `int(value or 0)`.
fn int_of(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => pytext::strip(s).parse().unwrap_or(0),
        Some(Value::Bool(true)) => 1,
        _ => 0,
    }
}

/// "What will be sent": the question, the picture, the attachments. Sends nothing.
async fn post_sketch_ai_preview(Body(body): Body<PreviewBody>) -> Json<Value> {
    let mut pieces: Vec<Value> = Vec::new();
    let chars = |s: &str| s.chars().count() as i64;
    if !pytext::strip(&body.prompt).is_empty() {
        pieces.push(json!({
            "kind": "question",
            "label": "Your question",
            "chars": chars(&body.prompt),
            "tokens": chars(&body.prompt) / 4 + 1,
            "preview": body.prompt.chars().take(200).collect::<String>(),
        }));
    }
    if !body.title.is_empty() {
        pieces.push(json!({
            "kind": "title",
            "label": "The sketch's title",
            "chars": chars(&body.title),
            "tokens": chars(&body.title) / 4 + 1,
            "preview": body.title,
        }));
    }
    if body.with_image && body.image_bytes != 0 {
        pieces.push(json!({
            "kind": "picture",
            "label": format!("The drawing ({}\u{d7}{})", body.image_width, body.image_height),
            "chars": 0,
            "tokens": 1500,
            "preview": "",
        }));
    }
    for a in &body.attachments {
        let name = match a.get("name") {
            Some(n) if pyjson::truthy(n) => pyjson::py_str(n),
            _ => "file".to_string(),
        };
        let n = int_of(a.get("chars"));
        pieces.push(json!({"kind": "attachment", "label": name, "chars": n, "tokens": n.div_euclid(4), "preview": ""}));
    }
    let tokens: i64 = pieces.iter().map(|p| p["tokens"].as_i64().unwrap_or(0)).sum();
    Json(json!({
        "pieces": pieces,
        "tokens": tokens,
        "estimate": null,
        "draw_estimate": null,
        "never_sent": NEVER_SENT,
        "injections": [],
    }))
}

/// What a multipart form of `post_sketch_ai_message` holds.
#[derive(Default)]
struct SketchForm {
    fields: Vec<(String, String)>,
    image: Option<(String, Vec<u8>)>,
    files: Vec<(String, Vec<u8>)>,
    /// The first file or image that was longer than `MAX_FILE_BYTES + 1` bytes was cut there.
    parse_failed: bool,
}

impl SketchForm {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// Read the multipart body: files up to `MAX_FILE_BYTES + 1` bytes each (`UploadFile.read(limit + 1)` of the
/// handler is as far as it looks), the text fields whole.
async fn read_form(multipart: Result<Multipart, MultipartRejection>) -> SketchForm {
    let mut form = SketchForm::default();
    let Ok(mut multipart) = multipart else { return form };
    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                form.parse_failed = true;
                break;
            }
        };
        let name = field.name().unwrap_or("").to_string();
        if let Some(filename) = field.file_name().map(str::to_string) {
            let mut data: Vec<u8> = Vec::new();
            let limit = MAX_FILE_BYTES + 1;
            loop {
                match field.chunk().await {
                    Ok(Some(chunk)) => {
                        let room = limit.saturating_sub(data.len());
                        data.extend_from_slice(&chunk[..chunk.len().min(room)]);
                    }
                    Ok(None) => break,
                    Err(_) => {
                        form.parse_failed = true;
                        break;
                    }
                }
            }
            match name.as_str() {
                "image" => form.image = Some((filename, data)),
                "files" => form.files.push((filename, data)),
                _ => {}
            }
        } else {
            match field.text().await {
                Ok(text) => form.fields.push((name, text)),
                Err(_) => form.parse_failed = true,
            }
        }
        if form.parse_failed {
            break;
        }
    }
    form
}

/// A form field that is an `int` (`Annotated[int, Form()]`).
fn form_int(form: &SketchForm, name: &str, errors: &mut Vec<Value>) -> i64 {
    match form.field(name) {
        None => {
            errors.push(json!({"type": "missing", "loc": ["body", name], "msg": "Field required"}));
            0
        }
        Some(text) => match pytext::strip(text).parse::<i64>() {
            Ok(n) => n,
            Err(_) => {
                errors.push(json!({
                    "type": "int_parsing",
                    "loc": ["body", name],
                    "msg": "Input should be a valid integer, unable to parse string as an integer",
                }));
                0
            }
        },
    }
}

/// `UploadFile.read(limit + 1)` and the refusal of what is longer than `limit`.
fn read_limited(data: &[u8], limit: usize, what: &str) -> Result<Vec<u8>, AssistError> {
    if data.len() > limit {
        return Err(AssistError::new("too_large", format!("{what} is too large (at most {} KB).", limit / 1024)));
    }
    Ok(data.to_vec())
}

/// Ask in the sketch chat. `image` is the flattened picture of the canvas as it is now; `files` are pictures and text
/// files the person attached. The answer is written in the background.
async fn post_sketch_ai_message(
    Path(chat_id): Path<String>,
    multipart: Result<Multipart, MultipartRejection>,
) -> Res<Json<Value>> {
    let form = read_form(multipart).await;
    if form.parse_failed {
        return Err(ApiError::bad_request("There was an error parsing the body").into());
    }
    let mut errors: Vec<Value> = Vec::new();
    let text = match form.field("text") {
        Some(t) => t.to_string(),
        None => {
            errors.push(json!({"type": "missing", "loc": ["body", "text"], "msg": "Field required"}));
            String::new()
        }
    };
    let width = form_int(&form, "width", &mut errors);
    let height = form_int(&form, "height", &mut errors);
    let with_image = match form.field("with_image") {
        None => true,
        Some(v) => match v.to_lowercase().as_str() {
            "1" | "true" | "t" | "yes" | "y" | "on" => true,
            "0" | "false" | "f" | "no" | "n" | "off" => false,
            _ => {
                errors.push(json!({
                    "type": "bool_parsing",
                    "loc": ["body", "with_image"],
                    "msg": "Input should be a valid boolean, unable to interpret input",
                }));
                true
            }
        },
    };
    if !errors.is_empty() {
        return Err(ApiError::new(axum::http::StatusCode::UNPROCESSABLE_ENTITY, Value::Array(errors)).into());
    }
    let title = form.field("title").unwrap_or("").to_string();
    if pytext::strip(&text).chars().count() > MAX_PROMPT {
        return Err(assist_error(&AssistError::new(
            "invalid",
            format!("Keep the message under {MAX_PROMPT} characters."),
        )));
    }
    if form.files.len() > MAX_IMAGES + MAX_TEXT_FILES {
        return Err(assist_error(&AssistError::new(
            "invalid",
            format!("At most {} files can be attached to one message.", MAX_IMAGES + MAX_TEXT_FILES),
        )));
    }
    let mut saved: Vec<(String, Vec<u8>)> = Vec::new();
    if let (Some((_, data)), true) = (&form.image, with_image) {
        let data = read_limited(data, MAX_IMAGE_BYTES, "The picture of the drawing").map_err(|e| assist_error(&e))?;
        saved.push(("canvas.png".to_string(), data));
    }
    for (name, data) in &form.files {
        let shown = if name.is_empty() { "file" } else { name.as_str() };
        let what = if name.is_empty() { "A file" } else { name.as_str() };
        let data = read_limited(data, MAX_FILE_BYTES, what).map_err(|e| assist_error(&e))?;
        saved.push((shown.to_string(), data));
    }
    let mut extra = Map::new();
    extra.insert("title".into(), json!(title));
    extra.insert("canvas".into(), json!({"w": width, "h": height, "title": title}));
    let opts =
        SendOpts { files: saved, skill: Some("sketch-ask".to_string()), extra: Some(extra), ..Default::default() };
    let session = kb_db::session();
    let out = svc_chat::send(&session, &chat_id, &by(), &text, opts).await.map_err(assist_failure)?;
    Ok(Json(Value::Object(out)))
}

/// `Path.suffix`.
fn suffix(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i..].to_string(),
        _ => String::new(),
    }
}

/// A picture or file kept with the person's own chat turn (anyone else gets 404).
async fn get_sketch_ai_file(
    method: Method,
    headers: HeaderMap,
    Path((chat_id, turn_id, file)): Path<(String, String, String)>,
) -> Response {
    match sketch_file(&method, &headers, &chat_id, &turn_id, &file).await {
        Ok(response) => response,
        Err(failure) => failure.into_response(),
    }
}

async fn sketch_file(method: &Method, headers: &HeaderMap, chat_id: &str, turn_id: &str, file: &str) -> Res<Response> {
    let not_found = || assist_error(&AssistError::new("not_found", "File not found."));
    let session = kb_db::session();
    let chat = ai_chat::Entity::find_by_id(chat_id).one(&session).await?;
    let run = ai_run::Entity::find_by_id(turn_id).one(&session).await?;
    let (Some(chat), Some(run)) = (chat, run) else { return Err(not_found()) };
    if chat.owner != by() || run.target.as_deref() != Some(format!("chat:{chat_id}").as_str()) {
        return Err(not_found());
    }
    let folder = kb_ai_run::launch::run_dir(&run.id, false).map_err(|_| not_found())?;
    // the file is picked from what the run's folder holds, never built from the request
    let wanted = match file.rsplit('/').next().unwrap_or("") {
        "." => "",
        other => other,
    };
    let mut found: Option<std::path::PathBuf> = None;
    if folder.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&folder) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.file_name().and_then(|n| n.to_str()) == Some(wanted) && p.is_file() {
                    found = Some(p);
                    break;
                }
            }
        }
    }
    let Some(path) = found else { return Err(not_found()) };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let ext = suffix(&name).to_lowercase();
    if [".md", ".log", ".json"].contains(&ext.as_str()) {
        return Err(not_found());
    }
    let image = [".png", ".jpg", ".jpeg", ".webp", ".gif"].contains(&ext.as_str());
    let mut response = FileResponse::new(&path)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=3600")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .content_disposition_type(if image { "inline" } else { "attachment" });
    if !image {
        response = response.filename(&name);
    }
    Ok(response.respond(method, headers).await)
}

/// Close the proposal of an answer (the assistant no longer draws shapes; there is nothing to place).
async fn post_sketch_ai_accept(Path(draft_id): Path<String>) -> Res<Json<Value>> {
    svc_drafts::get(&draft_id).map_err(|e| assist_error(&e))?;
    let actor = by();
    let draft = svc_drafts::edit(&draft_id, |draft| {
        if draft.get("status").and_then(Value::as_str) == Some("open") {
            draft.insert("status".into(), json!("applied"));
            draft.insert("applied_by".into(), json!(actor));
        }
        draft.clone()
    })
    .map_err(|e| assist_error(&e))?;
    Ok(Json(Value::Object(draft)))
}

/// Which idea of an answer was added as a label.
#[derive(Debug, Deserialize)]
struct IdeaBody {
    index: i64,
}

/// The person added idea number `index` of the answer as a text label; the proposal remembers it.
async fn post_sketch_ai_idea(Path(draft_id): Path<String>, Body(body): Body<IdeaBody>) -> Res<Json<Value>> {
    svc_drafts::get(&draft_id).map_err(|e| assist_error(&e))?;
    let outcome = svc_drafts::edit(&draft_id, |draft| -> Result<Map<String, Value>, AssistError> {
        let result = draft
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .and_then(|p| p.get_mut("result"))
            .and_then(Value::as_object_mut);
        let ideas = result.as_ref().and_then(|r| r.get("ideas")).and_then(Value::as_array).map_or(0, Vec::len) as i64;
        if !(0 <= body.index && body.index < ideas) {
            return Err(AssistError::new("invalid", "That idea is not in the answer."));
        }
        if let Some(result) = result {
            let mut added: Vec<i64> = result
                .get("added")
                .and_then(Value::as_array)
                .map_or_else(Vec::new, |a| a.iter().filter_map(Value::as_i64).collect());
            added.push(body.index);
            added.sort_unstable();
            added.dedup();
            result.insert("added".into(), json!(added));
        }
        Ok(draft.clone())
    })
    .map_err(|e| assist_error(&e))?;
    let draft = outcome.map_err(|e| assist_error(&e))?;
    Ok(Json(Value::Object(draft)))
}
