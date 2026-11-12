//! `tests/test_wave5_fields.py`, the board's part (AL-1): the lane counts. The other tests of the file are about
//! ideas (IP-8, IW-4, ICT-9) and are ported with the Idea Space.

mod common;

use std::collections::BTreeMap;

use common::{exec, id};
use serde_json::json;
use testkit::{Server, skip_unless_available};

// --- AL-1 --------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_lane_counts_are_the_lane_badges() {
    if !skip_unless_available("test_lane_counts_are_the_lane_badges") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = c.post("/projects", json!({"name": "Test Project", "prefix": "TST", "color": "#123456"})).await.json();
    let pid = id(&p);
    let mut ids = Vec::new();
    for status in ["todo", "todo", "in-progress", "done", "wont_do"] {
        let r = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "T", "status": status})).await;
        assert_eq!(r.status, 201, "{}", r.text());
        ids.push(id(&r.json()));
    }
    // a pending ticket is not in the lane's count (the badge leaves it out)
    exec(&s, "UPDATE ticket SET pending = 1 WHERE id = ?", &[json!(ids[0])]).await;
    let lanes = c.get(&format!("/projects/{pid}/tickets/counts")).await.json()["lanes"].clone();
    let empty = c.get("/projects/nope/tickets/counts").await.json();
    let by_status: BTreeMap<String, i64> = lanes
        .as_array()
        .expect("lanes")
        .iter()
        .map(|x| (x["status"].as_str().expect("status").to_string(), x["count"].as_i64().expect("count")))
        .collect();
    let expected: BTreeMap<String, i64> =
        [("todo", 1), ("in-progress", 1), ("done", 1)].into_iter().map(|(k, n)| (k.to_string(), n)).collect();
    assert_eq!(by_status, expected);
    assert_eq!(empty, json!({"lanes": []}));
}
