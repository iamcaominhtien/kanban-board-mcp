//! Helpers the ported tests of the app shell share.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::Path;

use reqwest::header::HeaderMap;
use testkit::Server;

/// A reply that was not followed anywhere: status, headers (lower-case names, text values) and body.
pub struct Reply {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    /// A header as text (`None` when absent).
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.get(name).map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect())
    }

    /// The raw bytes of a header.
    pub fn header_bytes(&self, name: &str) -> Option<Vec<u8>> {
        self.headers.get(name).map(|v| v.as_bytes().to_vec())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    /// Every header as a sorted map of lower-case name to text, for a readable failure message.
    pub fn header_map(&self) -> BTreeMap<String, String> {
        self.headers
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.as_bytes().iter().map(|b| char::from(*b)).collect()))
            .collect()
    }
}

/// A client that never follows a redirect and never uses a proxy.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("client")
}

/// One request to `server`; `path` is sent as written (percent escapes stay).
pub async fn send(server: &Server, method: &str, path: &str, headers: &[(&str, &str)], body: Option<Vec<u8>>) -> Reply {
    let url = format!("{}{}", server.base_url(), path);
    let method = reqwest::Method::from_bytes(method.as_bytes()).expect("method");
    let mut builder = client().request(method, url);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    if let Some(body) = body {
        builder = builder.body(body);
    }
    let response = builder.send().await.unwrap_or_else(|e| panic!("request {path} failed: {e}"));
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("body").to_vec();
    Reply { status, headers, body }
}

/// `GET path`.
pub async fn get(server: &Server, path: &str) -> Reply {
    send(server, "GET", path, &[], None).await
}

/// Write a file (and the folders above it) and return its path.
pub fn put_file(folder: &Path, relative: &str, content: &[u8]) -> std::path::PathBuf {
    let path = folder.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create folder");
    }
    std::fs::write(&path, content).expect("write file");
    path
}

/// The modification time every fixture file gets, so `Last-Modified` and `ETag` are the same on every run:
/// 1700000000.123456789 seconds after the epoch.
pub const FIXED_MTIME: (u64, u32) = (1_700_000_000, 123_456_789);

/// `Last-Modified` of a file with `FIXED_MTIME`.
pub const LAST_MODIFIED: &str = "Tue, 14 Nov 2023 22:13:20 GMT";

/// `ETag` of a file with `FIXED_MTIME` and `size` bytes: what Starlette's `FileResponse` sends, md5 of
/// `"1700000000.1234567-<size>"` (computed with Python for the sizes the tests use).
pub fn etag(size: usize) -> &'static str {
    match size {
        1 => "\"ee9f0ac3350dee4c8178dfc9d6b04199\"",
        2 => "\"7019df3718d35ed47ade2e7ddddd1df9\"",
        3 => "\"b468df4689a28e81a3ff28b15326a252\"",
        4 => "\"05d727554bc965ec3c4663c8c5d98946\"",
        5 => "\"3a6fff042766bf338f435c6dca9ad08f\"",
        6 => "\"a3867c01e46d72bfacaf5aa4194da557\"",
        7 => "\"ed8a2ab5a29823dd005f97bbb59c219e\"",
        8 => "\"18aac9bec9ff7e23985c284c3d4fb42d\"",
        10 => "\"1a41016df9725f6a5a8cb86efe6ddd1d\"",
        13 => "\"03f3cff788784671eb772e6c809c36ec\"",
        14 => "\"6090062238d8e72c62939e0b948da6a3\"",
        16 => "\"108959cbd1795c44bf8c6f27d35940fc\"",
        18 => "\"164c84cca00e21725def8133088fe0d7\"",
        17 => "\"6f3221339ec5ad7ddd70f50c930d5152\"",
        19 => "\"7bf4c34c8727c9c0d89b9d598ea0e74d\"",
        24 => "\"03dba5c555e9b5ed1fda6c5478e70d83\"",
        other => panic!("no ETag known for {other} bytes"),
    }
}

/// Like `put_file`, with `FIXED_MTIME` as the modification time.
pub fn put_fixed(folder: &Path, relative: &str, content: &[u8]) -> std::path::PathBuf {
    let path = put_file(folder, relative, content);
    let mtime = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::new(FIXED_MTIME.0, FIXED_MTIME.1);
    std::fs::File::options().write(true).open(&path).expect("open file").set_modified(mtime).expect("set mtime");
    path
}

/// The headers of a reply except `date` and `server`, as a sorted map.
pub fn contract_headers(reply: &Reply) -> BTreeMap<String, String> {
    let mut headers = reply.header_map();
    headers.remove("date");
    headers.remove("server");
    headers
}

/// Assert the reply has exactly these headers (besides `date` and `server`), whatever their order.
pub fn assert_headers(reply: &Reply, label: &str, expected: &[(&str, &str)]) {
    let expected: BTreeMap<String, String> = expected.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    assert_eq!(contract_headers(reply), expected, "headers of {label}");
}

/// Assert status, and the JSON `detail` of an error answer.
pub fn assert_detail(reply: &Reply, label: &str, status: u16, detail: &str) {
    assert_eq!(reply.status, status, "{label}: {}", reply.text());
    assert_eq!(reply.json(), serde_json::json!({"detail": detail}), "{label}");
}

/// The canonical form of a path (what the server reports for a file: links resolved).
pub fn canonical(path: &Path) -> String {
    std::fs::canonicalize(path).expect("canonical path").to_string_lossy().into_owned()
}
