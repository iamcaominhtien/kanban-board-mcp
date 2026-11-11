//! The route tests of `tests/test_logs.py` (`GET /logs/export`, `POST /logs/client`), with one check per branch of
//! `api/logs.py` that both servers answer the same. The `app_logging` unit tests of that file are in `kb-log`.
//!
//! The Python tests pointed `KANBAN_LOG_DIR` at a temporary folder in process; here the server's own log folder
//! (`Server::log_dir`) is written to, and what the server logs is read from it.

mod common;

use std::time::Duration;

use serde_json::json;
use testkit::{Resp, Server, skip_unless_available};

const SAMPLE: [&str; 7] = [
    "2026-10-12T10:00:00.000+00:00 INFO a started\n",
    "2026-10-12T10:05:00.000+00:00 ERROR a boom\n",
    "Traceback (most recent call last):\n",
    "  File \"x.py\", line 1\n",
    "ValueError: bad\n",
    "2026-10-12T10:10:00.000+00:00 WARNING b careful\n",
    "2026-10-12T11:00:00.000+00:00 INFO a later\n",
];

/// `_write`: the server's log file holds exactly these lines.
fn write_log(s: &Server, lines: &[&str]) {
    std::fs::create_dir_all(s.log_dir()).unwrap();
    std::fs::write(s.log_dir().join("kanban.log"), lines.concat()).unwrap();
}

fn header(r: &Resp, name: &str) -> String {
    r.headers.get(name).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default()
}

/// The records of an export, after its header.
fn records(r: &Resp) -> String {
    let text = r.text();
    let (_, body) = text.split_once("\n\n").unwrap_or(("", ""));
    body.to_string()
}

/// A server with a log of its own: what it has logged so far (its start) is replaced by the sample.
async fn start() -> Server {
    let s = Server::start().await;
    write_log(&s, &SAMPLE);
    s
}

/// What the server has written to its log file, once `needle` is in it.
async fn log_with(s: &Server, needle: &str) -> String {
    for _ in 0..100 {
        let text = std::fs::read_to_string(s.log_dir().join("kanban.log")).unwrap_or_default();
        if text.contains(needle) {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    std::fs::read_to_string(s.log_dir().join("kanban.log")).unwrap_or_default()
}

#[tokio::test]
async fn test_export_endpoint_filters_by_range() {
    if !skip_unless_available("test_export_endpoint_filters_by_range") {
        return;
    }
    let s = start().await;
    let res = s.client().get("/logs/export?since=2026-10-12T10:03:00Z&until=2026-10-12T10:30:00Z&level=INFO").await;
    assert_eq!(res.status, 200);
    assert!(header(&res, "content-disposition").contains("attachment"));
    let text = res.text();
    assert!(text.contains("boom") && text.contains("careful"));
    assert!(!text.contains("started") && !text.contains("later"));

    // the header, and the records with their traceback, exactly
    assert_eq!(header(&res, "content-type"), "text/plain; charset=utf-8");
    let disposition = header(&res, "content-disposition");
    let stamp = disposition.strip_prefix("attachment; filename=kanban-log-").and_then(|d| d.strip_suffix(".log"));
    let stamp = stamp.unwrap_or_else(|| panic!("{disposition}"));
    assert!(stamp.len() == 15 && stamp.as_bytes()[8] == b'-' && stamp.chars().all(|c| c.is_ascii_digit() || c == '-'));
    let lines: Vec<&str> = text.lines().take(8).collect();
    assert_eq!(lines[0], "# Kanban Board MCP log export");
    assert!(lines[1].starts_with("# Exported: 20") && lines[1].len() == "# Exported: 2026-10-12T10:03:00+00:00".len());
    assert_eq!(lines[2], "# Range: 2026-10-12T10:03:00Z -> 2026-10-12T10:30:00Z  (level >= INFO)");
    assert!(lines[3].starts_with("# Version: ") && lines[3].len() > "# Version: ".len());
    assert!(lines[4].starts_with("# Platform: "));
    assert!(lines[5].starts_with("# Database: ") && lines[5].ends_with("kanban.db"));
    assert!(lines[6].starts_with("# Log file: ") && lines[6].ends_with("kanban.log"));
    assert_eq!(lines[7], "");
    assert_eq!(records(&res), SAMPLE[1..6].concat());
}

#[tokio::test]
async fn test_export_endpoint_empty_range() {
    if !skip_unless_available("test_export_endpoint_empty_range") {
        return;
    }
    let s = start().await;
    let res = s.client().get("/logs/export?since=2030-01-01T00:00:00Z").await;
    assert!(res.text().contains("no log entries"));
    assert_eq!(records(&res), "# (no log entries in this range)\n");
    assert!(res.text().contains("# Range: 2030-01-01T00:00:00Z -> now  (level >= INFO)\n"));
}

#[tokio::test]
async fn test_export_endpoint_validates_input() {
    if !skip_unless_available("test_export_endpoint_validates_input") {
        return;
    }
    let s = start().await;
    let c = s.client();
    assert_eq!(c.get("/logs/export?since=nope").await.status, 400);
    assert_eq!(c.get("/logs/export?level=LOUD").await.status, 400);
    let res = c.get("/logs/export?since=2026-10-13T00:00:00Z&until=2026-10-12T00:00:00Z").await;
    assert_eq!(res.status, 400);

    for (query, detail) in [
        ("since=nope", "Invalid 'since': expected an ISO-8601 date-time"),
        ("until=2026-13-45", "Invalid 'until': expected an ISO-8601 date-time"),
        ("since=2026-10-12T10:00:00Z&until=yesterday", "Invalid 'until': expected an ISO-8601 date-time"),
        ("level=LOUD", "Unknown level: LOUD"),
        ("level=loud", "Unknown level: LOUD"),
        ("level=", "Unknown level: "),
        ("since=2026-10-13T00:00:00Z&until=2026-10-12T00:00:00Z", "'since' must not be after 'until'"),
        ("since=2026-10-12T12:00:00%2B02:00&until=2026-10-12T09:59:59Z", "'since' must not be after 'until'"),
    ] {
        let res = c.get(&format!("/logs/export?{query}")).await;
        assert_eq!((res.status, res.json()), (400, json!({"detail": detail})), "{query}");
    }
}

#[tokio::test]
async fn test_export_endpoint_reads_times_and_levels_as_the_python_one() {
    if !skip_unless_available("test_export_endpoint_reads_times_and_levels_as_the_python_one") {
        return;
    }
    let s = start().await;
    let c = s.client();
    // an empty bound is no bound; an offset is an offset; the level is any case
    let res = c.get("/logs/export?since=&until=").await;
    assert_eq!(records(&res), SAMPLE.concat());
    assert!(res.text().contains("# Range: beginning -> now  (level >= INFO)\n"));
    let res = c.get("/logs/export?since=2026-10-12T12:03:00%2B02:00&until=%202026-10-12T10:30:00Z%20").await;
    assert_eq!(records(&res), SAMPLE[1..6].concat());
    let res = c.get("/logs/export?level=error").await;
    assert_eq!(records(&res), SAMPLE[1..5].concat());
    assert!(res.text().contains("(level >= ERROR)\n"));
    let res = c.get("/logs/export?level=Warning&until=2026-10-12T10:10:00.000Z").await;
    assert_eq!(records(&res), SAMPLE[1..6].concat());
    // the bounds are inclusive
    let res = c.get("/logs/export?since=2026-10-12T10:05:00Z&until=2026-10-12T10:05:00Z").await;
    assert_eq!(records(&res), SAMPLE[1..5].concat());
    // the log of the stdio MCP process is merged in time order
    std::fs::write(
        s.log_dir().join("kanban-mcp-stdio.log"),
        "2026-10-12T10:07:00.000+00:00 ERROR stdio:mcp tool failed\n",
    )
    .unwrap();
    let res = c.get("/logs/export?since=2026-10-12T10:00:00Z&until=2026-10-12T10:59:00Z").await;
    let merged: Vec<&str> = SAMPLE[0..5]
        .iter()
        .copied()
        .chain(["2026-10-12T10:07:00.000+00:00 ERROR stdio:mcp tool failed\n"])
        .chain(SAMPLE[5..6].iter().copied())
        .collect();
    assert_eq!(records(&res), merged.concat());
    // an older file of the rotation comes first
    std::fs::write(s.log_dir().join("kanban.log.1"), "2026-10-11T09:00:00.000+00:00 INFO old entry\n").unwrap();
    let res = c.get("/logs/export").await;
    assert!(records(&res).starts_with("2026-10-11T09:00:00.000+00:00 INFO old entry\n2026-10-12T10:00:00"));
}

#[tokio::test]
async fn test_client_log_is_recorded_and_validated() {
    if !skip_unless_available("test_client_log_is_recorded_and_validated") {
        return;
    }
    let s = start().await;
    let c = s.client();
    let res =
        c.post("/logs/client", json!({"level": "error", "message": "TypeError: x", "stack": "at f (a.js:1)"})).await;
    assert_eq!(res.status, 204);
    assert!(res.body.is_empty());
    let text = log_with(&s, "at f (a.js:1)").await;
    assert!(text.contains("TypeError: x") && text.contains("at f (a.js:1)"), "{text}");
    assert!(text.contains(" ERROR ui TypeError: x\n"), "{text}");

    // a warning with the page it came from
    let res = c.post("/logs/client", json!({"level": "warning", "message": "slow", "url": "http://x/y"})).await;
    assert_eq!(res.status, 204);
    let text = log_with(&s, "slow").await;
    assert!(text.contains(" WARNING ui slow (at http://x/y)\n"), "{text}");
    // the level defaults to error; an empty stack or url adds nothing
    let res = c.post("/logs/client", json!({"message": "plain", "stack": "", "url": null})).await;
    assert_eq!(res.status, 204);
    assert!(log_with(&s, "plain").await.contains(" ERROR ui plain\n"));

    let res = c.post("/logs/client", json!({"level": "info", "message": "m"})).await;
    assert_eq!(res.status, 422);
    assert_eq!(res.detail()[0]["loc"], json!(["body", "level"]));
    let res = c.post("/logs/client", json!({"message": "x".repeat(3000)})).await;
    assert_eq!(res.status, 422);
    assert_eq!(res.detail()[0]["loc"], json!(["body", "message"]));
    // 2000 characters are fine, whatever their bytes
    assert_eq!(c.post("/logs/client", json!({"message": "é".repeat(2000)})).await.status, 204);
    assert_eq!(c.post("/logs/client", json!({"message": "é".repeat(2001)})).await.status, 422);
    assert_eq!(c.post("/logs/client", json!({"message": "m", "stack": "s".repeat(8001)})).await.status, 422);
    assert_eq!(c.post("/logs/client", json!({"message": "m", "url": "u".repeat(501)})).await.status, 422);
    assert_eq!(c.post("/logs/client", json!({"level": "error"})).await.status, 422);
    assert_eq!(c.post("/logs/client", json!({"message": 3})).await.status, 422);
}

#[tokio::test]
async fn test_client_log_is_rate_limited() {
    if !skip_unless_available("test_client_log_is_rate_limited") {
        return;
    }
    let s = start().await;
    let c = s.client();
    let mut codes = Vec::new();
    let mut last = None;
    for _ in 0..62 {
        let r = c.post("/logs/client", json!({"message": "m"})).await;
        codes.push(r.status);
        last = Some(r);
    }
    assert_eq!(codes[..60], [204u16; 60]);
    assert_eq!(codes[60..], [429, 429]);
    assert_eq!(last.unwrap().json(), json!({"detail": "Too many client log entries"}));
    // a refused entry is not counted, and an invalid one does not count either
    assert_eq!(c.post("/logs/client", json!({"level": "info", "message": "m"})).await.status, 422);
}
