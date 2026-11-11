//! `FileResponse` of Starlette, for every route that answers with a file: the content type (with the charset
//! Starlette adds to text types), `Content-Length`, `Last-Modified`, `ETag`, `Accept-Ranges`, the
//! `Content-Disposition` of a download, and `Range` / `If-Range` requests (206, 400, 416, `multipart/byteranges`).
//! Headers are produced in Starlette's order and with its exact spelling; a header value is sent as latin-1 bytes,
//! as Starlette encodes it.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures::StreamExt;
use md5::{Digest, Md5};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::mimetypes;

/// The size of the chunks a file is read in (`FileResponse.chunk_size`).
const CHUNK_SIZE: usize = 64 * 1024;

/// `urllib.parse.quote(text, safe=safe)`: everything but letters, digits and `_.-~` (and the characters of `safe`) as
/// `%XX` of its UTF-8 bytes.
pub fn quote(text: &str, safe: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let c = char::from(byte);
        if byte.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '~') || (byte.is_ascii() && safe.contains(c)) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A header value as Starlette sends it: `value.encode("latin-1")`.
fn latin1(value: &str) -> Vec<u8> {
    value.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect()
}

fn build(status: u16, headers: &[(String, Vec<u8>)], body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_bytes(value)) {
            response.headers_mut().append(name, value);
        }
    }
    response
}

fn has(headers: &[(String, Vec<u8>)], name: &str) -> bool {
    headers.iter().any(|(n, _)| n == name)
}

/// `headers.setdefault(name, value)`.
fn set_default(headers: &mut Vec<(String, Vec<u8>)>, name: &str, value: Vec<u8>) {
    if !has(headers, name) {
        headers.push((name.to_string(), value));
    }
}

/// `headers[name] = value`: replaces the header in place, or adds it.
fn set(headers: &mut Vec<(String, Vec<u8>)>, name: &str, value: Vec<u8>) {
    match headers.iter().position(|(n, _)| n == name) {
        Some(i) => headers[i].1 = value,
        None => headers.push((name.to_string(), value)),
    }
}

/// `PlainTextResponse(content, status_code, headers)`.
fn plain_text(status: u16, content: &str, extra: &[(&str, String)]) -> Response {
    let mut headers: Vec<(String, Vec<u8>)> =
        extra.iter().map(|(name, value)| (name.to_ascii_lowercase(), latin1(value))).collect();
    headers.push(("content-length".into(), content.len().to_string().into_bytes()));
    headers.push(("content-type".into(), b"text/plain; charset=utf-8".to_vec()));
    build(status, &headers, Body::from(content.to_string()))
}

/// The plain `500 Internal Server Error` an unhandled exception gets.
pub fn internal_server_error() -> Response {
    plain_text(500, "Internal Server Error", &[])
}

/// `RedirectResponse(url)`: 307 with the location quoted as Starlette quotes it.
pub fn redirect(url: &str) -> Response {
    let location = quote(url, ":/%#?=@[]!$&'()*+,;");
    let headers = vec![("location".to_string(), latin1(&location)), ("content-length".to_string(), b"0".to_vec())];
    build(307, &headers, Body::empty())
}

/// `email.utils.formatdate(timeval, usegmt=True)` for a float timestamp, rounded to the microsecond as
/// `datetime.fromtimestamp` does.
fn http_date(timestamp: f64) -> String {
    let mut seconds = timestamp.floor();
    let fraction = timestamp - seconds;
    if (fraction * 1e6).round_ties_even() >= 1e6 {
        seconds += 1.0;
    }
    let date = chrono::DateTime::from_timestamp(seconds as i64, 0).unwrap_or_default();
    date.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// What Python reports as `st_mtime` (`sec + nsec * 1e-9` as a double).
fn st_mtime(meta: &std::fs::Metadata) -> f64 {
    match meta.modified().map(|t| t.duration_since(UNIX_EPOCH)) {
        Ok(Ok(since)) => since.as_secs() as f64 + f64::from(since.subsec_nanos()) * 1e-9,
        Ok(Err(before)) => -(before.duration().as_secs() as f64) - f64::from(before.duration().subsec_nanos()) * 1e-9,
        Err(_) => 0.0,
    }
}

/// Python's `repr(float)` of a timestamp (always with a fraction digit).
fn float_repr(value: f64) -> String {
    format!("{value:?}")
}

/// `int(text)` of Python for the part of a range: optional sign, digits with single underscores between them.
fn py_int(text: &str) -> Option<i128> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if digits.is_empty() || digits.starts_with('_') || digits.ends_with('_') || digits.contains("__") {
        return None;
    }
    let mut value: i128 = 0;
    for c in digits.chars() {
        if c == '_' {
            continue;
        }
        value = value.checked_mul(10)?.checked_add(i128::from(c.to_digit(10)?))?;
    }
    Some(if negative { -value } else { value })
}

enum RangeError {
    Malformed(&'static str),
    NotSatisfiable,
}

/// `FileResponse._parse_ranges`: the `(start, end)` pairs of a `Range` header's value, what cannot be read skipped.
fn parse_ranges(range: &str, size: i128) -> Vec<(i128, i128)> {
    let mut ranges = Vec::new();
    for part in range.split(',') {
        let part = part.trim();
        if part.is_empty() || part == "-" {
            continue;
        }
        let Some((start_text, end_text)) = part.split_once('-') else { continue };
        let (start_text, end_text) = (start_text.trim(), end_text.trim());
        let start = if start_text.is_empty() {
            match py_int(end_text) {
                Some(n) => size - n,
                None => continue,
            }
        } else {
            match py_int(start_text) {
                Some(n) => n,
                None => continue,
            }
        };
        let end = if !start_text.is_empty() && !end_text.is_empty() {
            match py_int(end_text) {
                Some(n) if n < size => n + 1,
                Some(_) => size,
                None => continue,
            }
        } else {
            size
        };
        ranges.push((start, end));
    }
    ranges
}

/// `FileResponse._parse_range_header`.
fn parse_range_header(header: &str, size: i128) -> Result<Vec<(i128, i128)>, RangeError> {
    let Some((units, range)) = header.split_once('=') else { return Err(RangeError::Malformed("Malformed range header.")) };
    if units.trim().to_lowercase() != "bytes" {
        return Err(RangeError::Malformed("Only support bytes range"));
    }
    let mut ranges = parse_ranges(range, size);
    if ranges.is_empty() {
        return Err(RangeError::Malformed("Range header: range must be requested"));
    }
    if ranges.iter().any(|(start, _)| !(0 <= *start && *start < size)) {
        return Err(RangeError::NotSatisfiable);
    }
    if ranges.iter().any(|(start, end)| start > end) {
        return Err(RangeError::Malformed("Range header: start must be less than end"));
    }
    if ranges.len() == 1 {
        return Ok(ranges);
    }
    // overlapping ranges are merged
    ranges.sort_unstable();
    let mut merged: Vec<(i128, i128)> = vec![ranges[0]];
    for (start, end) in ranges.into_iter().skip(1) {
        let last = merged.len() - 1;
        let (last_start, last_end) = merged[last];
        if start <= last_end {
            merged[last] = (last_start, last_end.max(end));
        } else {
            merged.push((start, end));
        }
    }
    Ok(merged)
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).map(|value| value.as_bytes().iter().map(|b| char::from(*b)).collect())
}

/// `secrets.token_hex(13)`.
fn token_hex() -> String {
    kb_base::time::uuid4_hex().chars().take(26).collect()
}

async fn open_at(path: &Path, start: u64, length: u64) -> std::io::Result<tokio::io::Take<tokio::fs::File>> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    Ok(file.take(length))
}

/// A file as a response: build it with the options of Starlette's `FileResponse(path, status_code, headers,
/// media_type, filename, content_disposition_type)`, then `respond` to the request it answers.
#[derive(Debug, Clone)]
pub struct FileResponse {
    path: PathBuf,
    status: u16,
    headers: Vec<(String, Vec<u8>)>,
    media_type: Option<String>,
    filename: Option<String>,
    content_disposition_type: String,
}

impl FileResponse {
    /// `FileResponse(path)`: status 200, the content type guessed from the file's name.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            status: 200,
            headers: Vec::new(),
            media_type: None,
            filename: None,
            content_disposition_type: "attachment".to_string(),
        }
    }

    /// `status_code=`.
    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    /// One entry of `headers=` (names are lower-cased; a later entry of the same name replaces an earlier one).
    pub fn header(mut self, name: &str, value: &str) -> Self {
        set(&mut self.headers, &name.to_ascii_lowercase(), latin1(value));
        self
    }

    /// `media_type=`.
    pub fn media_type(mut self, media_type: &str) -> Self {
        self.media_type = Some(media_type.to_string());
        self
    }

    /// `filename=`: the name of the download (and the file name the content type is guessed from).
    pub fn filename(mut self, filename: &str) -> Self {
        self.filename = Some(filename.to_string());
        self
    }

    /// `content_disposition_type=` (`attachment` by default).
    pub fn content_disposition_type(mut self, kind: &str) -> Self {
        self.content_disposition_type = kind.to_string();
        self
    }

    /// Answer the request that has `method` and `request_headers`: the whole file, the part asked for with `Range`,
    /// or only the headers for `HEAD`. A file that is gone (or is not a file) is the 500 Starlette answers with.
    pub async fn respond(self, method: &Method, request_headers: &HeaderMap) -> Response {
        // `FileResponse.__init__`
        let mut headers = self.headers;
        let media_type = match &self.media_type {
            Some(media_type) => media_type.clone(),
            None => {
                let guess_from = self.filename.clone().unwrap_or_else(|| self.path.to_string_lossy().into_owned());
                mimetypes::guess_type(&guess_from).unwrap_or("text/plain").to_string()
            }
        };
        if !has(&headers, "content-type") {
            let mut content_type = media_type;
            if content_type.starts_with("text/") && !content_type.to_lowercase().contains("charset=") {
                content_type.push_str("; charset=utf-8");
            }
            headers.push(("content-type".into(), latin1(&content_type)));
        }
        set_default(&mut headers, "accept-ranges", b"bytes".to_vec());
        if let Some(filename) = &self.filename {
            let quoted = quote(filename, "/");
            let disposition = if quoted != *filename {
                format!("{}; filename*=utf-8''{quoted}", self.content_disposition_type)
            } else {
                format!("{}; filename=\"{filename}\"", self.content_disposition_type)
            };
            set_default(&mut headers, "content-disposition", latin1(&disposition));
        }

        // `FileResponse.__call__`: the file is looked at when the response is sent
        let meta = match tokio::fs::metadata(&self.path).await {
            Ok(meta) if meta.is_file() => meta,
            _ => return internal_server_error(),
        };
        let size = meta.len();
        let mtime = st_mtime(&meta);
        let etag_base = format!("{}-{size}", float_repr(mtime));
        let etag = format!("\"{}\"", md5_hex(etag_base.as_bytes()));
        set_default(&mut headers, "content-length", size.to_string().into_bytes());
        let last_modified = http_date(mtime);
        set_default(&mut headers, "last-modified", last_modified.clone().into_bytes());
        set_default(&mut headers, "etag", etag.clone().into_bytes());

        let header_only = method == Method::HEAD;
        let range = header_text(request_headers, "range");
        let if_range = header_text(request_headers, "if-range");
        let use_range = match (&range, &if_range) {
            (None, _) => false,
            (Some(_), None) => true,
            // `_should_use_range`: only when the validator is the one this response carries
            (Some(_), Some(validator)) => *validator == last_modified || *validator == etag,
        };
        let Some(range) = range.filter(|_| use_range) else {
            let body = if header_only {
                Body::empty()
            } else {
                match tokio::fs::File::open(&self.path).await {
                    Ok(file) => Body::from_stream(ReaderStream::with_capacity(file, CHUNK_SIZE)),
                    Err(_) => return internal_server_error(),
                }
            };
            return build(self.status, &headers, body);
        };

        let ranges = match parse_range_header(&range, i128::from(size)) {
            Ok(ranges) => ranges,
            Err(RangeError::Malformed(content)) => return plain_text(400, content, &[]),
            Err(RangeError::NotSatisfiable) => {
                return plain_text(416, "", &[("Content-Range", format!("bytes */{size}"))]);
            }
        };
        let bounds: Vec<(u64, u64)> =
            ranges.iter().map(|(start, end)| (u64::try_from(*start).unwrap_or(0), u64::try_from(*end).unwrap_or(0))).collect();
        if let [(start, end)] = bounds[..] {
            set(&mut headers, "content-range", format!("bytes {start}-{}/{size}", end - 1).into_bytes());
            set(&mut headers, "content-length", (end - start).to_string().into_bytes());
            let body = if header_only {
                Body::empty()
            } else {
                match open_at(&self.path, start, end - start).await {
                    Ok(reader) => Body::from_stream(ReaderStream::with_capacity(reader, CHUNK_SIZE)),
                    Err(_) => return internal_server_error(),
                }
            };
            return build(206, &headers, body);
        }

        // several ranges: `multipart/byteranges`
        let boundary = token_hex();
        let content_type = headers
            .iter()
            .find(|(name, _)| name == "content-type")
            .map(|(_, value)| value.iter().map(|b| char::from(*b)).collect::<String>())
            .unwrap_or_default();
        let part_head = |start: u64, end: u64| {
            format!("--{boundary}\r\nContent-Type: {content_type}\r\nContent-Range: bytes {start}-{}/{size}\r\n\r\n", end - 1)
        };
        let content_length: u64 = bounds
            .iter()
            .map(|(start, end)| part_head(*start, *end).len() as u64 + (end - start) + 2)
            .sum::<u64>()
            + 4
            + boundary.len() as u64;
        set(&mut headers, "content-type", format!("multipart/byteranges; boundary={boundary}").into_bytes());
        set(&mut headers, "content-length", content_length.to_string().into_bytes());
        if header_only {
            return build(206, &headers, Body::empty());
        }
        let mut parts: Vec<futures::stream::BoxStream<'static, std::io::Result<Bytes>>> = Vec::new();
        for (start, end) in bounds {
            let head = Bytes::from(part_head(start, end));
            parts.push(futures::stream::once(async move { Ok(head) }).boxed());
            let path = self.path.clone();
            let data = futures::stream::once(async move {
                match open_at(&path, start, end - start).await {
                    Ok(reader) => ReaderStream::with_capacity(reader, CHUNK_SIZE).boxed(),
                    Err(err) => futures::stream::once(async move { Err(err) }).boxed(),
                }
            })
            .flatten()
            .boxed();
            parts.push(data);
            parts.push(futures::stream::once(async { Ok(Bytes::from_static(b"\r\n")) }).boxed());
        }
        let closing = Bytes::from(format!("--{boundary}--"));
        parts.push(futures::stream::once(async move { Ok(closing) }).boxed());
        build(206, &headers, Body::from_stream(futures::stream::iter(parts).flatten()))
    }
}

fn md5_hex(data: &[u8]) -> String {
    Md5::digest(data).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `FileResponse(path)` answered to the request with `method` and `request_headers`: the file as it is, its content
/// type guessed from its name. For any other option, build a `FileResponse`.
pub async fn file_response(path: impl Into<PathBuf>, method: &Method, request_headers: &HeaderMap) -> Response {
    FileResponse::new(path).respond(method, request_headers).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_leaves_the_safe_characters_and_encodes_the_rest_as_utf8() {
        assert_eq!(quote("report-1_a.v2~.pdf", "/"), "report-1_a.v2~.pdf");
        assert_eq!(quote("a b.txt", "/"), "a%20b.txt");
        assert_eq!(quote("Tiến.txt", "/"), "Ti%E1%BA%BFn.txt");
        assert_eq!(quote("a\"b", "/"), "a%22b");
        assert_eq!(quote("/drawio/", ":/%#?=@[]!$&'()*+,;"), "/drawio/");
    }

    #[test]
    fn the_http_date_is_rfc_5322_in_gmt() {
        assert_eq!(http_date(0.0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1_700_000_000.4), "Tue, 14 Nov 2023 22:13:20 GMT");
        // a fraction that rounds up to the next microsecond second moves the second
        assert_eq!(http_date(1_700_000_000.999_999_9), "Tue, 14 Nov 2023 22:13:21 GMT");
    }

    #[test]
    fn a_float_is_written_as_python_writes_it() {
        assert_eq!(float_repr(1_731_335_281.0), "1731335281.0");
        assert_eq!(float_repr(1_731_335_281.123_456_7), "1731335281.1234567");
    }

    #[test]
    fn range_headers_are_read_as_starlette_reads_them() {
        let ok = |h: &str, size: i128| parse_range_header(h, size).ok();
        assert_eq!(ok("bytes=0-4", 10), Some(vec![(0, 5)]));
        assert_eq!(ok("bytes=5-", 10), Some(vec![(5, 10)]));
        assert_eq!(ok("bytes=-3", 10), Some(vec![(7, 10)]));
        assert_eq!(ok("bytes=0-100", 10), Some(vec![(0, 10)]));
        assert_eq!(ok("bytes=0-1,5-6", 10), Some(vec![(0, 2), (5, 7)]));
        assert_eq!(ok("bytes=0-4,3-8", 10), Some(vec![(0, 9)]));
        assert_eq!(ok("bytes=0-1,x,1_0-", 10).map(|r| r.len()), None);
        assert!(matches!(parse_range_header("bytes=10-", 10), Err(RangeError::NotSatisfiable)));
        assert!(matches!(parse_range_header("bytes=-11", 10), Err(RangeError::NotSatisfiable)));
        assert!(matches!(parse_range_header("items=0-1", 10), Err(RangeError::Malformed("Only support bytes range"))));
        assert!(matches!(parse_range_header("0-1", 10), Err(RangeError::Malformed("Malformed range header."))));
        assert!(matches!(
            parse_range_header("bytes=5-2", 10),
            Err(RangeError::Malformed("Range header: start must be less than end"))
        ));
        assert!(matches!(
            parse_range_header("bytes=x-y", 10),
            Err(RangeError::Malformed("Range header: range must be requested"))
        ));
    }
}
