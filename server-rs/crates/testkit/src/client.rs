//! HTTP client, response wrapper and SSE reader.

use bytes::Bytes;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::time::Duration;

/// A reply: status, headers and the whole body.
pub struct Resp {
    /// HTTP status code.
    pub status: u16,
    /// Reply headers.
    pub headers: HeaderMap,
    /// Reply body.
    pub body: Bytes,
    method: String,
    path: String,
}

impl Resp {
    /// The body parsed as JSON; panics with the body text when it is not JSON.
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| {
            panic!(
                "{} {} -> {}: body is not JSON ({e}): {}",
                self.method,
                self.path,
                self.status,
                self.text()
            )
        })
    }

    /// The body as text (lossy UTF-8).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// `json()["detail"]` (Null when absent).
    pub fn detail(&self) -> Value {
        self.json().get("detail").cloned().unwrap_or(Value::Null)
    }

    /// Panics, showing method, path, status and body, unless the status is `expected`.
    pub fn assert_status(&self, expected: u16) -> &Resp {
        assert!(
            self.status == expected,
            "{} {}: expected status {expected}, got {}: {}",
            self.method,
            self.path,
            self.status,
            self.text()
        );
        self
    }
}

/// A client of one server (reqwest underneath, never through a proxy).
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    headers: Vec<(String, String)>,
}

impl Client {
    pub(crate) fn new(base: &str, headers: Vec<(String, String)>) -> Client {
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("reqwest client");
        Client {
            http,
            base: base.to_string(),
            headers,
        }
    }

    /// A client that sends this header on every request (e.g. the actor header).
    pub fn header(mut self, name: &str, value: &str) -> Client {
        self.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub(crate) fn header_map(&self) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (n, v) in &self.headers {
            map.insert(
                HeaderName::from_bytes(n.as_bytes()).expect("header name"),
                HeaderValue::from_str(v).expect("header value"),
            );
        }
        map
    }

    fn builder(&self, method: &str, path: &str) -> reqwest::RequestBuilder {
        let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).expect("http method");
        self.http
            .request(m, format!("{}{}", self.base, path))
            .headers(self.header_map())
    }

    async fn send(&self, method: &str, path: &str, rb: reqwest::RequestBuilder) -> Resp {
        let r = rb
            .send()
            .await
            .unwrap_or_else(|e| panic!("{method} {path}: request failed: {e}"));
        let status = r.status().as_u16();
        let headers = r.headers().clone();
        let body = r
            .bytes()
            .await
            .unwrap_or_else(|e| panic!("{method} {path}: reading the body failed: {e}"));
        Resp {
            status,
            headers,
            body,
            method: method.to_uppercase(),
            path: path.to_string(),
        }
    }

    async fn json_call(&self, method: &str, path: &str, body: Option<Value>) -> Resp {
        let mut rb = self.builder(method, path);
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        self.send(method, path, rb).await
    }

    /// GET; the path may include a query string.
    pub async fn get(&self, path: &str) -> Resp {
        self.json_call("GET", path, None).await
    }

    /// GET with query parameters (percent-encoded by the client).
    pub async fn get_query(&self, path: &str, query: &[(&str, &str)]) -> Resp {
        let rb = self.builder("GET", path).query(query);
        self.send("GET", path, rb).await
    }

    /// POST a JSON body.
    pub async fn post(&self, path: &str, body: Value) -> Resp {
        self.json_call("POST", path, Some(body)).await
    }

    /// POST without a body.
    pub async fn post_empty(&self, path: &str) -> Resp {
        self.json_call("POST", path, None).await
    }

    /// PUT a JSON body.
    pub async fn put(&self, path: &str, body: Value) -> Resp {
        self.json_call("PUT", path, Some(body)).await
    }

    /// PATCH a JSON body.
    pub async fn patch(&self, path: &str, body: Value) -> Resp {
        self.json_call("PATCH", path, Some(body)).await
    }

    /// DELETE without a body.
    pub async fn delete(&self, path: &str) -> Resp {
        self.json_call("DELETE", path, None).await
    }

    /// DELETE with a JSON body.
    pub async fn delete_json(&self, path: &str, body: Value) -> Resp {
        self.json_call("DELETE", path, Some(body)).await
    }

    /// POST a multipart form: one file part plus text fields.
    pub async fn upload(
        &self,
        path: &str,
        field: &str,
        filename: &str,
        content_type: &str,
        bytes: Vec<u8>,
        extra_fields: &[(&str, &str)],
    ) -> Resp {
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.to_string())
            .mime_str(content_type)
            .expect("content type");
        let mut form = reqwest::multipart::Form::new().part(field.to_string(), part);
        for (k, v) in extra_fields {
            form = form.text(k.to_string(), v.to_string());
        }
        let rb = self.builder("POST", path).multipart(form);
        self.send("POST", path, rb).await
    }

    /// Any method, extra headers (they win over the client's), raw body.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Resp {
        let mut rb = self.builder(method, path);
        for (n, v) in headers {
            rb = rb.header(*n, *v);
        }
        if let Some(b) = body {
            rb = rb.body(b);
        }
        self.send(method, path, rb).await
    }

    /// Open `GET /events` (SSE).
    pub async fn events(&self) -> Events {
        let r = self
            .http
            .get(format!("{}/events", self.base))
            .headers(self.header_map())
            .header("accept", "text/event-stream")
            .send()
            .await
            .expect("GET /events");
        assert_eq!(r.status().as_u16(), 200, "GET /events");
        Events {
            stream: Box::pin(r.bytes_stream()),
            buf: String::new(),
        }
    }
}

/// A Server-Sent Events stream.
pub struct Events {
    stream: std::pin::Pin<Box<dyn futures::Stream<Item = reqwest::Result<Bytes>> + Send>>,
    buf: String,
}

impl Events {
    /// The next `data:` payload, or `None` on timeout or end of stream. Comment lines (`: connected`, `: ping`)
    /// are skipped.
    pub async fn next(&mut self, timeout: Duration) -> Option<String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            while let Some(pos) = self.buf.find("\n\n") {
                let block: String = self.buf.drain(..pos + 2).collect();
                let data: Vec<&str> = block
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:"))
                    .map(|d| d.strip_prefix(' ').unwrap_or(d))
                    .collect();
                if !data.is_empty() {
                    return Some(data.join("\n"));
                }
            }
            match tokio::time::timeout_at(deadline, self.stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    self.buf
                        .push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
                }
                _ => return None,
            }
        }
    }
}
