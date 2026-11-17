//! Uploads of pictures, videos and files placed in a page (design "Embeds", frames 13-18, 43-47 and 74).
//!
//! The limits are the project's Docs settings (`uploads.imageMb/videoMb/fileMb`). Programs and scripts are refused
//! by their extension and by their first bytes; every upload is checked for a virus: with clamd when
//! `KANBAN_CLAMD` names one (a unix socket path, or `host:port`), and always for the EICAR test string, so the rule
//! can be tested without a scanner. A file is streamed to a temporary file in the private folder, checked, then
//! moved into the uploads folder under the same kind of name as a ticket attachment.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::multipart::Multipart;
use kb_db::Session;
use kb_doctext::docs_text::DocsError;
use kb_files::{pathlib, uploads};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::html::human_size;
use crate::docs::{project, space};
use crate::{Result, docs_err};

/// The environment variable naming the clamd to scan with (`/run/clamav/clamd.ctl` or `127.0.0.1:3310`).
pub const CLAMD_ENV_VAR: &str = "KANBAN_CLAMD";

/// The EICAR anti-virus test file, built from two halves so this source file is not itself flagged.
fn eicar() -> Vec<u8> {
    let mut s = br"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD".to_vec();
    s.extend_from_slice(b"-ANTIVIRUS-TEST-FILE!$H+H*");
    s
}

/// What an upload is placed as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadKind {
    /// A picture (`image` block).
    Image,
    /// A video file (`video` block).
    Video,
    /// Any other file (`fileCard` block).
    File,
}

impl UploadKind {
    /// The kind named by the `kind` field of the form, `None` for any other word.
    pub fn parse(word: &str) -> Option<Self> {
        match word.trim() {
            "image" => Some(Self::Image),
            "video" => Some(Self::Video),
            "file" => Some(Self::File),
            _ => None,
        }
    }

    /// The word of the answer.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::File => "file",
        }
    }

    /// The key of `uploads` in the Docs settings.
    fn setting(self) -> &'static str {
        match self {
            Self::Image => "imageMb",
            Self::Video => "videoMb",
            Self::File => "fileMb",
        }
    }
}

/// Upload limits of a project, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Pictures.
    pub image: u64,
    /// Videos.
    pub video: u64,
    /// Other files.
    pub file: u64,
}

impl Limits {
    /// The limits of the project's Docs settings (a missing or bad value is its default).
    pub fn of(settings: &Map<String, Value>) -> Self {
        let defaults = space::defaults();
        let mb = |kind: UploadKind| -> u64 {
            let read =
                |m: &Map<String, Value>| m.get("uploads").and_then(|u| u.get(kind.setting())).and_then(Value::as_u64);
            read(settings).or_else(|| read(&defaults)).unwrap_or(100)
        };
        Self {
            image: mb(UploadKind::Image) * 1024 * 1024,
            video: mb(UploadKind::Video) * 1024 * 1024,
            file: mb(UploadKind::File) * 1024 * 1024,
        }
    }

    /// The limit of one kind.
    pub fn of_kind(&self, kind: UploadKind) -> u64 {
        match kind {
            UploadKind::Image => self.image,
            UploadKind::Video => self.video,
            UploadKind::File => self.file,
        }
    }

    /// The largest of the three (what a file is read up to while its kind is not known yet).
    fn largest(&self) -> u64 {
        self.image.max(self.video).max(self.file)
    }
}

/// Extensions of programs, installers and scripts that are never stored.
pub const REFUSED_EXTENSIONS: &[&str] = &[
    ".exe",
    ".msi",
    ".msp",
    ".msix",
    ".appx",
    ".bat",
    ".cmd",
    ".com",
    ".scr",
    ".pif",
    ".cpl",
    ".dll",
    ".sys",
    ".ps1",
    ".psm1",
    ".psd1",
    ".sh",
    ".bash",
    ".zsh",
    ".csh",
    ".ksh",
    ".fish",
    ".command",
    ".js",
    ".mjs",
    ".cjs",
    ".jse",
    ".vbs",
    ".vbe",
    ".wsf",
    ".wsh",
    ".hta",
    ".msc",
    ".jar",
    ".app",
    ".dmg",
    ".pkg",
    ".apk",
    ".aab",
    ".xapk",
    ".ipa",
    ".deb",
    ".rpm",
    ".appimage",
    ".run",
    ".bin",
    ".elf",
    ".so",
    ".dylib",
    ".lnk",
    ".reg",
    ".gadget",
    ".application",
    ".scf",
    ".inf",
    ".vb",
    ".ws",
];

/// Video files a video block plays, and their types.
const VIDEO_TYPES: &[(&str, &str)] = &[
    (".mp4", "video/mp4"),
    (".m4v", "video/mp4"),
    (".webm", "video/webm"),
    (".mov", "video/quicktime"),
    (".ogv", "video/ogg"),
];

/// Whether a file name ends in a program or script extension (trailing dots and spaces, which Windows drops, do
/// not hide it).
pub fn is_refused_name(filename: &str) -> bool {
    let name = pathlib::name(filename).trim_end_matches(['.', ' ']).to_string();
    let ext = pathlib::suffix(&name).to_ascii_lowercase();
    REFUSED_EXTENSIONS.contains(&ext.as_str())
}

/// Whether the first bytes of a file are those of a program: a Windows program (`MZ` with a PE header, or `MZ` and
/// binary bytes), ELF, Mach-O (also universal), or a script starting with `#!`.
pub fn is_program(head: &[u8]) -> bool {
    if head.starts_with(b"#!") || head.starts_with(b"\x7fELF") {
        return true;
    }
    const MACHO: &[[u8; 4]] =
        &[[0xFE, 0xED, 0xFA, 0xCE], [0xFE, 0xED, 0xFA, 0xCF], [0xCE, 0xFA, 0xED, 0xFE], [0xCF, 0xFA, 0xED, 0xFE]];
    if MACHO.iter().any(|m| head.starts_with(m)) {
        return true;
    }
    // CA FE BA BE: a universal Mach-O program (also a Java class file, which is refused as well)
    if head.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]) {
        return true;
    }
    if head.starts_with(b"MZ") {
        if head.len() >= 0x40 {
            let offset = u32::from_le_bytes([head[0x3C], head[0x3D], head[0x3E], head[0x3F]]) as usize;
            if head.get(offset..offset + 4) == Some(b"PE\0\0") {
                return true;
            }
        }
        // a text file can start with "MZ"; a program has NUL bytes in its header
        return head.iter().take(0x40).any(|b| *b == 0);
    }
    false
}

/// Finds the EICAR test string in a file as it streams past (the string can straddle two chunks).
#[derive(Debug, Default)]
pub struct EicarFinder {
    /// The last bytes seen, one fewer than the string.
    tail: Vec<u8>,
    /// Whether the string was found.
    pub found: bool,
}

impl EicarFinder {
    /// Looks at the next chunk of the file.
    pub fn feed(&mut self, chunk: &[u8]) {
        if self.found {
            return;
        }
        let needle = eicar();
        let mut window = std::mem::take(&mut self.tail);
        window.extend_from_slice(chunk);
        if window.windows(needle.len()).any(|w| w == needle.as_slice()) {
            self.found = true;
            return;
        }
        let keep = needle.len() - 1;
        self.tail = window[window.len().saturating_sub(keep)..].to_vec();
    }
}

/// The type an upload is answered with: the board's table, the video table, what the browser sent, else
/// `application/octet-stream`.
fn mime_of(filename: &str, sent: Option<&str>) -> String {
    let ext = pathlib::suffix(filename).to_ascii_lowercase();
    uploads::mime_by_extension(&ext)
        .or_else(|| VIDEO_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m))
        .map(str::to_string)
        .or_else(|| sent.filter(|s| !s.is_empty() && s.len() < 200).map(str::to_string))
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

/// The `file` part of the form, written to a temporary file.
struct Received {
    /// The name the browser sent.
    filename: String,
    /// The type the browser sent.
    content_type: Option<String>,
    /// The temporary file (it holds at most the limit and one byte).
    temp: PathBuf,
    /// How many bytes the part held.
    total: u64,
    /// The first bytes of the file.
    head: Vec<u8>,
    /// Whether the EICAR string was seen.
    eicar: bool,
}

/// How many first bytes are kept to recognise a program.
const HEAD_BYTES: usize = 4096;

/// Stores an upload for a page of the project's Docs and answers `{src, name, size, mime, kind}`.
///
/// # Errors
/// The project errors (404, 403; the actor needs to edit the Docs); 422 `invalid_kind` or `missing_file`; 413
/// `too_large` (with `limit_mb` and `size_bytes`); 415 `type_not_allowed`; 422 `virus_found` (with `virus`); 503
/// `scan_failed` when clamd is set and cannot answer; 400 `bad_form` for a body that is not a form.
pub async fn receive(session: &Session, project_id: &str, mut form: Multipart) -> Result<Value> {
    let project = project(session, project_id, true).await?;
    let limits = Limits::of(&space::read(&project));
    let mut kind_word: Option<String> = None;
    let mut received: Option<Received> = None;
    let mut temp_path: Option<PathBuf> = None;
    let outcome = async {
        while let Some(mut field) = form.next_field().await.map_err(|_| bad_form())? {
            let name = field.name().unwrap_or("").to_string();
            if name == "file" && field.file_name().is_some() && received.is_none() {
                let cap =
                    kind_word.as_deref().and_then(UploadKind::parse).map_or(limits.largest(), |k| limits.of_kind(k));
                let temp = uploads::get_private_dir().join(format!(".docs-upload-{}.part", kb_base::time::uuid4_hex()));
                let mut got = Received {
                    filename: field.file_name().unwrap_or("").to_string(),
                    content_type: field.content_type().map(str::to_string),
                    temp: temp.clone(),
                    total: 0,
                    head: Vec::new(),
                    eicar: false,
                };
                // recorded before the first write, so a failure below still removes the file
                temp_path = Some(temp.clone());
                let mut out = tokio::fs::File::create(&temp).await.map_err(io_error)?;
                let mut finder = EicarFinder::default();
                while let Some(chunk) = field.chunk().await.map_err(|_| bad_form())? {
                    let room = (cap + 1).saturating_sub(got.total) as usize;
                    let keep = &chunk[..chunk.len().min(room)];
                    if !keep.is_empty() {
                        out.write_all(keep).await.map_err(io_error)?;
                        finder.feed(keep);
                        if got.head.len() < HEAD_BYTES {
                            let more = (HEAD_BYTES - got.head.len()).min(keep.len());
                            got.head.extend_from_slice(&keep[..more]);
                        }
                    }
                    got.total += chunk.len() as u64;
                }
                out.flush().await.map_err(io_error)?;
                got.eicar = finder.found;
                received = Some(got);
            } else if name == "kind" {
                kind_word = Some(field.text().await.map_err(|_| bad_form())?);
            }
        }
        let Some(kind) = kind_word.as_deref().and_then(UploadKind::parse) else {
            return docs_err(422, "invalid_kind", "kind must be image, video or file");
        };
        let Some(file) = received.as_ref().filter(|r| !r.filename.is_empty()) else {
            return docs_err(422, "missing_file", "Choose a file to upload");
        };
        check(file, kind, &limits)?;
        scan(&file.temp).await?;
        let stored = uploads::build_upload_filename(&file.filename);
        let destination = uploads::get_uploads_dir(true).join(&stored);
        tokio::fs::rename(&file.temp, &destination).await.map_err(io_error)?;
        let name: String = pathlib::name(&file.filename).chars().take(200).collect();
        Ok(json!({
            "src": format!("/uploads/{stored}"),
            "name": name,
            "size": file.total,
            "mime": mime_of(&file.filename, file.content_type.as_deref()),
            "kind": kind.as_str(),
        }))
    }
    .await;
    if let Some(temp) = &temp_path {
        if outcome.is_err() {
            let _ = tokio::fs::remove_file(temp).await;
        }
    }
    outcome
}

/// The size, type and EICAR checks of a received file.
fn check(file: &Received, kind: UploadKind, limits: &Limits) -> Result<()> {
    let limit = limits.of_kind(kind);
    if file.total > limit {
        let what = match kind {
            UploadKind::Image => "An image",
            UploadKind::Video => "A video",
            UploadKind::File => "A file",
        };
        return Err(DocsError::new(
            413,
            "too_large",
            format!("This file is {}. {what} can be {} at most.", human_size(file.total), human_size(limit)),
        )
        .with("limit_mb", limit / (1024 * 1024))
        .with("size_bytes", file.total)
        .into());
    }
    if is_refused_name(&file.filename) || is_program(&file.head) {
        return docs_err(
            415,
            "type_not_allowed",
            "Programs and scripts (.exe, .bat, .sh, .js and similar) cannot be attached.",
        );
    }
    let ext = pathlib::suffix(&file.filename).to_ascii_lowercase();
    match kind {
        UploadKind::Image if !uploads::is_supported_image(&ext) => {
            return docs_err(415, "type_not_allowed", "This is not a picture. Use PNG, JPEG, GIF, WebP or SVG.");
        }
        UploadKind::Video if !VIDEO_TYPES.iter().any(|(e, _)| *e == ext) => {
            return docs_err(
                415,
                "type_not_allowed",
                "This is not a video the browser can play. Use MP4, WebM or MOV.",
            );
        }
        _ => {}
    }
    if file.eicar {
        return virus("Eicar-Test-Signature");
    }
    Ok(())
}

/// 422 `virus_found`.
fn virus<T>(name: &str) -> Result<T> {
    Err(DocsError::new(422, "virus_found", format!("Not added. The scan found a virus in this file ({name})."))
        .with("virus", name)
        .into())
}

fn bad_form() -> crate::Error {
    DocsError::new(400, "bad_form", "There was an error parsing the body").into()
}

fn io_error(e: std::io::Error) -> crate::Error {
    crate::Error::Other(format!("could not store the upload: {e}"))
}

/// Scans a stored file with clamd when `KANBAN_CLAMD` is set; without it, passes.
async fn scan(path: &Path) -> Result<()> {
    let Some(target) = std::env::var(CLAMD_ENV_VAR).ok().filter(|v| !v.trim().is_empty()) else {
        return Ok(());
    };
    let failed = |why: String| -> crate::Error {
        tracing::warn!(target: "docs", "virus scan failed: {why}");
        DocsError::new(503, "scan_failed", "The virus scan could not run, so the file was not added. Try again later.")
            .into()
    };
    let reply = tokio::time::timeout(Duration::from_secs(120), clamd_scan(target.trim(), path))
        .await
        .map_err(|_| failed("clamd did not answer in time".into()))?
        .map_err(|e| failed(e.to_string()))?;
    match parse_clamd_reply(&reply) {
        ClamdVerdict::Clean => Ok(()),
        ClamdVerdict::Found(name) => virus(&name),
        ClamdVerdict::Error(why) => Err(failed(why)),
    }
}

/// What clamd said about a stream.
#[derive(Debug, PartialEq, Eq)]
pub enum ClamdVerdict {
    /// `stream: OK`.
    Clean,
    /// `stream: <name> FOUND`.
    Found(String),
    /// Anything else (`INSTREAM size limit exceeded. ERROR`).
    Error(String),
}

/// Reads clamd's answer to `INSTREAM`.
pub fn parse_clamd_reply(reply: &str) -> ClamdVerdict {
    let reply = reply.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    let body = reply.strip_prefix("stream:").map(str::trim).unwrap_or(reply);
    if body == "OK" {
        ClamdVerdict::Clean
    } else if let Some(name) = body.strip_suffix("FOUND") {
        ClamdVerdict::Found(name.trim().to_string())
    } else {
        ClamdVerdict::Error(reply.to_string())
    }
}

/// Sends a file to clamd with `zINSTREAM` and returns its answer.
async fn clamd_scan(target: &str, path: &Path) -> std::io::Result<String> {
    #[cfg(unix)]
    if target.starts_with('/') {
        let stream = tokio::net::UnixStream::connect(target).await?;
        return instream(stream, path).await;
    }
    let stream = tokio::net::TcpStream::connect(target).await?;
    instream(stream, path).await
}

/// The `INSTREAM` exchange: chunks of a 4-byte big-endian length and the bytes, then a zero length.
async fn instream<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, path: &Path) -> std::io::Result<String> {
    stream.write_all(b"zINSTREAM\0").await?;
    let mut file = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let len = u32::try_from(n).expect("a chunk is 64 KB at most");
        stream.write_all(&len.to_be_bytes()).await?;
        stream.write_all(&buf[..n]).await?;
    }
    stream.write_all(&0u32.to_be_bytes()).await?;
    stream.flush().await?;
    let mut reply = Vec::new();
    let mut byte = [0u8; 1];
    while reply.len() < 4096 {
        if stream.read(&mut byte).await? == 0 || byte[0] == 0 {
            break;
        }
        reply.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&reply).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_and_scripts_are_refused_by_name() {
        for name in [
            "setup.exe",
            "run.BAT",
            "x.sh",
            "app.js",
            "a.ps1",
            "tool.jar",
            "pkg.deb",
            "i.msi",
            "doc.pdf.exe",
            "x.exe. ",
            "m.vbs",
            "z.dmg",
            "a.apk",
            "b.rpm",
        ] {
            assert!(is_refused_name(name), "{name}");
        }
        for name in [
            "sprint-plan.pdf",
            "notes.docx",
            "budget.xlsx",
            "photo.png",
            "demo.mp4",
            "archive.zip",
            "script.py",
            "README",
        ] {
            assert!(!is_refused_name(name), "{name}");
        }
    }

    #[test]
    fn programs_are_refused_by_their_first_bytes() {
        let mut pe = vec![0u8; 0x100];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3C] = 0x80;
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        assert!(is_program(&pe));
        assert!(is_program(b"\x7fELF\x02\x01\x01"));
        assert!(is_program(&[0xCF, 0xFA, 0xED, 0xFE, 7, 0, 0, 1]));
        assert!(is_program(&[0xFE, 0xED, 0xFA, 0xCE]));
        assert!(is_program(&[0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 2]));
        assert!(is_program(b"#!/bin/sh\nrm -rf /\n"));
        // text that happens to start with MZ, a PNG and a PDF pass
        assert!(!is_program(b"MZ,Mozambique,Maputo\nZA,South Africa,Pretoria\n"));
        assert!(!is_program(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"));
        assert!(!is_program(b"%PDF-1.7\n"));
        assert!(!is_program(b""));
    }

    #[test]
    fn the_eicar_string_is_found_across_chunks() {
        let test = eicar();
        let mut whole = EicarFinder::default();
        whole.feed(&test);
        assert!(whole.found);

        let mut data = b"some bytes before ".to_vec();
        data.extend_from_slice(&test);
        data.extend_from_slice(b" and after");
        let mut split = EicarFinder::default();
        for chunk in data.chunks(7) {
            split.feed(chunk);
        }
        assert!(split.found);

        let mut clean = EicarFinder::default();
        clean.feed(&test[..test.len() - 1]);
        clean.feed(b"!");
        assert!(!clean.found);
    }

    #[test]
    fn limits_come_from_the_settings_with_defaults() {
        let defaults = Limits::of(&space::defaults());
        assert_eq!(defaults, Limits { image: 10 << 20, video: 200 << 20, file: 100 << 20 });
        let mut settings = space::defaults();
        settings.insert("uploads".into(), json!({"fileMb": 1}));
        let limits = Limits::of(&settings);
        assert_eq!((limits.image, limits.video, limits.file), (10 << 20, 200 << 20, 1 << 20));
        assert_eq!(limits.largest(), 200 << 20);
    }

    #[test]
    fn clamd_replies_are_read() {
        assert_eq!(parse_clamd_reply("stream: OK\0"), ClamdVerdict::Clean);
        assert_eq!(
            parse_clamd_reply("stream: Eicar-Test-Signature FOUND\0"),
            ClamdVerdict::Found("Eicar-Test-Signature".into())
        );
        assert!(matches!(parse_clamd_reply("INSTREAM size limit exceeded. ERROR"), ClamdVerdict::Error(_)));
    }

    #[test]
    fn kinds_and_types() {
        assert_eq!(UploadKind::parse("video"), Some(UploadKind::Video));
        assert_eq!(UploadKind::parse("program"), None);
        assert_eq!(mime_of("demo.mov", None), "video/quicktime");
        assert_eq!(mime_of("a.pdf", Some("x/y")), "application/pdf");
        assert_eq!(mime_of("a.unknown", Some("application/x-thing")), "application/x-thing");
        assert_eq!(mime_of("a.unknown", None), "application/octet-stream");
    }
}
