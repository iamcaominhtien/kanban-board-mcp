//! A differential check of every route of `api/canvases.rs` that this crate serves: one request script, the status and
//! the exact JSON (ids and times numbered by first appearance) of the success case and of every error branch, compared
//! with the snapshot `contract/golden/canvas_routes.json` that the Python server wrote.
//!
//! Record the snapshot from the Python reference:
//! `KB_RECORD_ROUTES=1 PARITY_TARGET=python cargo test -p kb-draw --test canvas_routes`, then run the test on both
//! targets. A label the server cannot answer yet (the Docs steps, while the Docs area is not wired in) is skipped.

mod common;

use std::collections::HashMap;
use std::io::Write;

use common::hash::sha256_hex;
use common::{FilePart, Reply, form, member, pid, png, raw_get};
use regex::Regex;
use serde_json::{Map, Value, json};
use testkit::{Client, Server, Target, skip_unless_available, target};

const SNAPSHOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/canvas_routes.json");

const PAGE: &str = "<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in</h1><label>Email</label>\
    <input type=email placeholder=you@example.com><button>Continue</button></body></html>";

/// What the script saw, label by label.
#[derive(Default)]
struct Rec {
    out: Map<String, Value>,
    ids: HashMap<String, usize>,
}

impl Rec {
    /// Ids (`cv_`, `b_`, `p_`, `n_`, `a_`, `t_`, `sk_`, `nt_`) numbered by first appearance, volatile numbers masked.
    fn norm(&mut self, value: &Value) -> Value {
        static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"\b(cv|b|p|n|a|t|sk|nt)_[0-9a-f]{8,12}\b").expect("static pattern"));
        let value = testkit::normalize(value);
        self.walk(&value, re)
    }

    fn walk(&mut self, value: &Value, re: &Regex) -> Value {
        match value {
            Value::String(s) => {
                let ids = &mut self.ids;
                Value::String(
                    re.replace_all(s, |c: &regex::Captures| {
                        let next = ids.len() + 1;
                        let n = *ids.entry(c[0].to_string()).or_insert(next);
                        format!("<{}:{n}>", &c[1])
                    })
                    .into_owned(),
                )
            }
            Value::Array(a) => Value::Array(a.iter().map(|v| self.walk(v, re)).collect()),
            Value::Object(o) => {
                let mut out = Map::new();
                for (k, v) in o {
                    let masked =
                        matches!(k.as_str(), "expires_in" | "idle_seconds" | "started_seconds_ago" | "request_id");
                    if k == "request_id" {
                        continue;
                    }
                    let key = match self.walk(&Value::String(k.clone()), re) {
                        Value::String(s) => s,
                        _ => k.clone(),
                    };
                    out.insert(key, if masked { json!("<n>") } else { self.walk(v, re) });
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }

    /// A JSON answer. A 422 list of FastAPI is recorded as a validation failure only: its entries (the wording, the
    /// `input`, how many fields it names) are not part of the contract.
    fn json(&mut self, label: &str, status: u16, body: Value) {
        let body = match &body {
            Value::Object(o) if status == 422 && o.get("detail").is_some_and(Value::is_array) => {
                json!({"detail": "validation"})
            }
            _ => body,
        };
        let body = self.norm(&body);
        self.out.insert(label.into(), json!({"status": status, "body": body}));
    }

    fn resp(&mut self, label: &str, r: &testkit::Resp) {
        let body = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        self.json(label, r.status, body);
    }

    fn reply(&mut self, label: &str, r: &Reply) {
        let body = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        self.json(label, r.status, body);
    }

    /// A file answer: the status, the headers that matter and what the body is.
    fn file(&mut self, label: &str, r: &Reply, headers: &[&str]) {
        let mut h = Map::new();
        for name in headers {
            h.insert((*name).into(), json!(r.header(name)));
        }
        let body = if r.body.starts_with(b"PK") {
            let mut z = zip::ZipArchive::new(std::io::Cursor::new(r.body.clone())).expect("zip");
            let mut files = Map::new();
            for i in 0..z.len() {
                let mut f = z.by_index(i).expect("entry");
                let mut data = Vec::new();
                std::io::Read::read_to_end(&mut f, &mut data).expect("read");
                let name = f.name().to_string();
                let shown = if name.ends_with(".json") {
                    self.norm(&serde_json::from_slice(&data).expect("json"))
                } else {
                    json!(sha256_hex(&data))
                };
                files.insert(name, shown);
            }
            let sorted: std::collections::BTreeMap<String, Value> = files.into_iter().collect();
            json!({"zip": sorted})
        } else if r.header("content-type").starts_with("image/png") {
            json!({"sha256": sha256_hex(&r.body), "len": r.body.len()})
        } else if r.status == 200 {
            json!({"text": r.text()})
        } else {
            let body: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
            if r.status == 422 && body["detail"].is_array() {
                json!({"detail": "validation"})
            } else {
                self.norm(&body)
            }
        };
        self.out.insert(label.into(), json!({"status": r.status, "headers": h, "body": body}));
    }
}

fn part(field: &str, name: &str, content_type: &str, data: &[u8]) -> FilePart {
    (field.into(), name.into(), content_type.into(), data.to_vec())
}

fn html(name: &str, text: &str) -> FilePart {
    part("files", name, "text/html", text.as_bytes())
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_else(|| panic!("a string, got {v}")).to_string()
}

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in entries {
        z.start_file(*name, options).expect("entry");
        z.write_all(data).expect("data");
    }
    z.finish().expect("zip").into_inner()
}

async fn urlform(srv: &Server, method: &str, path: &str, fields: &[(&str, &str)], headers: &[(&str, &str)]) -> Reply {
    let http = reqwest::Client::builder().no_proxy().build().expect("client");
    let mut rb = http
        .request(reqwest::Method::from_bytes(method.as_bytes()).expect("method"), format!("{}{path}", srv.base_url()))
        .form(&fields.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>());
    for (n, v) in headers {
        rb = rb.header(*n, *v);
    }
    let r = rb.send().await.expect("request");
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    let body = r.bytes().await.expect("body").to_vec();
    Reply { status, headers, body }
}

/// The comment routes (the last of `api/canvases.py`): who the picker offers, the threads, replies, resolve / reopen,
/// edit and delete, every error branch, what a mention sends to a person (`GET /notifications`) and to an AI team.
/// Only branches that need no AI code are exercised: a team that would really be asked (a ready team on a Docs page or
/// on its ticket) calls the AI port, which this crate reaches through a hook.
async fn comments(srv: &Server, c: &Client, an: &Client, vi: &Client, pid: &str, rec: &mut Rec) {
    let base = json!({"owner_kind": "doc", "owner_id": "page-1", "title": "Login redesign", "project_id": pid});
    let cm = c.post("/canvases", base).await.json();
    let (cmid, cmb) = (s(&cm["id"]), s(&cm["doc"]["boards"][0]["id"]));
    let page_tab = s(&cm["doc"]["pages"][0]["id"]);
    let idea =
        c.post("/canvases", json!({"owner_kind": "idea", "owner_id": "idea-ai", "project_id": pid})).await.json();
    let idea_id = s(&idea["id"]);
    let ticket =
        c.post("/canvases", json!({"owner_kind": "ticket", "owner_id": "tk-missing", "project_id": pid})).await.json();
    let ticket_id = s(&ticket["id"]);
    let free = c.post("/canvases", json!({"owner_kind": "idea", "owner_id": "idea-free-2"})).await.json();
    let free_id = s(&free["id"]);
    common::member(c, pid, "Hoa Tran", "member").await;
    common::member(c, pid, "Ann", "member").await;
    common::ai_member(srv, pid, "Designer AI", true, false).await;
    common::ai_member(srv, pid, "Paused AI", true, true).await;
    common::ai_member(srv, pid, "Ghost AI", false, false).await;
    let gone = common::ai_member(srv, pid, "Gone AI", false, false).await;
    {
        use sqlx::Connection;
        let url = format!("sqlite://{}", srv.db_path().display());
        let mut conn = sqlx::SqliteConnection::connect(&url).await.expect("open the server's database");
        sqlx::query("UPDATE member SET kind = 'ai_removed' WHERE id = ?")
            .bind(gone)
            .execute(&mut conn)
            .await
            .expect("remove");
    }
    let people = c.get(&format!("/projects/{pid}/members")).await.json();
    let id_of = |name: &str| -> String {
        s(&people.as_array().expect("members").iter().find(|m| m["name"] == name).expect("member")["id"])
    };
    let (hoa, ann) = (id_of("Hoa Tran"), id_of("Ann"));
    let designer = srv.client().header("x-actor", "Designer AI");
    let hoa_client = srv.client().header("x-actor", "Hoa Tran");

    // GET /canvases/{canvas_id}/members
    rec.resp("cm_members_doc", &c.get(&format!("/canvases/{cmid}/members")).await);
    rec.resp("cm_members_idea", &c.get(&format!("/canvases/{idea_id}/members")).await);
    rec.resp("cm_members_ticket", &c.get(&format!("/canvases/{ticket_id}/members")).await);
    rec.resp("cm_members_no_project", &c.get(&format!("/canvases/{free_id}/members")).await);
    rec.resp("cm_members_viewer", &vi.get(&format!("/canvases/{cmid}/members")).await);
    rec.resp("cm_members_unknown", &c.get("/canvases/cv_00000000/members").await);

    // POST /canvases/{canvas_id}/threads
    let path = format!("/canvases/{cmid}/threads");
    let t1 = c
        .post(
            &path,
            json!({"body": "  Logo too small  ", "board_id": cmb, "x": 0.7, "y": 0.4,
                   "anchor": {"sel": " .logo ", "text": " Sign   in ", "ox": 2, "oy": "0.25", "w": 390.5}}),
        )
        .await;
    rec.resp("cm_thread_frame_anchor", &t1);
    let t1 = t1.json();
    let t1_id = s(&t1["id"]);
    let t2 = c.post(&path, json!({"body": "Plane note", "x": 120, "y": 80})).await;
    rec.resp("cm_thread_plane", &t2);
    let t2 = t2.json();
    rec.resp(
        "cm_thread_plane_page",
        &c.post(&path, json!({"body": "On a tab", "x": 5, "y": 6, "page": page_tab})).await,
    );
    rec.resp("cm_thread_plane_unknown_page", &c.post(&path, json!({"body": "Odd tab", "page": "p_deadbeef"})).await);
    rec.resp("cm_thread_clamped", &c.post(&path, json!({"body": "Clamped", "board_id": cmb, "x": 9, "y": -3})).await);
    rec.resp(
        "cm_thread_anchor_unusable",
        &c.post(&path, json!({"body": "No anchor", "board_id": cmb, "anchor": {"sel": " ", "text": ""}})).await,
    );
    rec.resp(
        "cm_thread_anchor_on_plane",
        &c.post(&path, json!({"body": "Plane anchor", "anchor": {"sel": "a"}})).await,
    );
    rec.resp("cm_thread_empty_board_id_is_plane", &c.post(&path, json!({"body": "Empty id", "board_id": ""})).await);
    rec.resp("cm_thread_unknown_board", &c.post(&path, json!({"body": "x", "board_id": "b_deadbeef"})).await);
    rec.resp("cm_thread_empty_body", &c.post(&path, json!({"body": "  "})).await);
    rec.resp("cm_thread_missing_body", &c.post(&path, json!({"x": 1})).await);
    rec.resp("cm_thread_bad_x", &c.post(&path, json!({"body": "x", "x": "left"})).await);
    rec.resp("cm_thread_bad_anchor", &c.post(&path, json!({"body": "x", "anchor": "str"})).await);
    rec.resp("cm_thread_long_body", &c.post(&path, json!({"body": "w".repeat(4100)})).await);
    rec.resp("cm_thread_viewer", &vi.post(&path, json!({"body": "hi"})).await);
    rec.resp("cm_thread_unknown_canvas", &c.post("/canvases/cv_00000000/threads", json!({"body": "hi"})).await);
    // a mention of a person: typed, picked, and both for the same member; the author is never told
    let typed = c.post(&path, json!({"body": "Hello @Hoa Tran, and @ann too"})).await;
    rec.resp("cm_thread_mention_typed", &typed);
    let picked =
        c.post(&path, json!({"body": format!("@[Hoa Tran](member:{hoa}) and @[Ann](member:{ann}) @Ann")})).await;
    rec.resp("cm_thread_mention_picked", &picked);
    rec.resp("cm_thread_mention_self", &hoa_client.post(&path, json!({"body": "Note to @Hoa Tran myself"})).await);
    rec.resp("cm_thread_mention_viewer_unknown", &c.post(&path, json!({"body": "@Vi hello @Nobody"})).await);
    // a mention of an AI team: delivered only when it can be asked, so only the branches that need no AI code
    rec.resp(
        "cm_thread_ai_on_idea",
        &c.post(&format!("/canvases/{idea_id}/threads"), json!({"body": "@Designer AI look"})).await,
    );
    rec.resp(
        "cm_thread_ai_not_on_ticket",
        &c.post(&format!("/canvases/{ticket_id}/threads"), json!({"body": "@Designer AI @Paused AI @Ghost AI"})).await,
    );
    rec.resp("cm_thread_ai_paused_on_page", &c.post(&path, json!({"body": "@Paused AI and @Ghost AI please"})).await);
    rec.resp("cm_thread_ai_removed_is_nobody", &c.post(&path, json!({"body": "@Gone AI"})).await);
    rec.resp(
        "cm_thread_by_ai_is_not_delivered",
        &designer.post(&path, json!({"body": "I am @Designer AI, @Paused AI"})).await,
    );
    rec.resp("cm_thread_no_project", &c.post(&format!("/canvases/{free_id}/threads"), json!({"body": "@Ann"})).await);

    // GET /canvases/{canvas_id}/threads
    rec.resp("cm_threads_all", &c.get(&path).await);
    rec.resp("cm_threads_open", &c.get_query(&path, &[("state", "open")]).await);
    rec.resp("cm_threads_resolved_none", &c.get_query(&path, &[("state", "resolved")]).await);
    rec.resp("cm_threads_other_state_is_all", &c.get_query(&path, &[("state", "bogus")]).await);
    rec.resp("cm_threads_viewer", &vi.get(&path).await);
    rec.resp("cm_threads_unknown", &c.get("/canvases/cv_00000000/threads").await);

    // POST /canvases/threads/{thread_id}/replies
    let replies = format!("/canvases/threads/{t1_id}/replies");
    let reply = c.post(&replies, json!({"body": "It matches the brand sheet"})).await;
    rec.resp("cm_reply", &reply);
    let reply_id = s(&reply.json()["comments"][1]["id"]);
    rec.resp("cm_reply_mention", &c.post(&replies, json!({"body": "cc @Hoa Tran"})).await);
    rec.resp("cm_reply_ai_mention_on_idea", &{
        let t = c.post(&format!("/canvases/{idea_id}/threads"), json!({"body": "plain"})).await.json();
        c.post(&format!("/canvases/threads/{}/replies", s(&t["id"])), json!({"body": "@Designer AI again"})).await
    });
    rec.resp("cm_reply_empty", &c.post(&replies, json!({"body": ""})).await);
    rec.resp("cm_reply_missing_body", &c.post(&replies, json!({})).await);
    rec.resp("cm_reply_viewer", &vi.post(&replies, json!({"body": "hi"})).await);
    rec.resp("cm_reply_unknown", &c.post("/canvases/threads/nope/replies", json!({"body": "hi"})).await);
    rec.resp("cm_reply_by_ai", &designer.post(&replies, json!({"body": "Button is 36 px"})).await);

    // POST /canvases/threads/{thread_id}/resolve and /reopen
    let t2_id = s(&t2["id"]);
    rec.resp("cm_resolve_ai_on_a_persons", &designer.post_empty(&format!("/canvases/threads/{t1_id}/resolve")).await);
    rec.resp("cm_resolve", &c.post_empty(&format!("/canvases/threads/{t1_id}/resolve")).await);
    rec.resp("cm_resolve_again", &an.post_empty(&format!("/canvases/threads/{t1_id}/resolve")).await);
    rec.resp("cm_resolve_viewer", &vi.post_empty(&format!("/canvases/threads/{t2_id}/resolve")).await);
    rec.resp("cm_resolve_unknown", &c.post_empty("/canvases/threads/nope/resolve").await);
    rec.resp("cm_threads_resolved", &c.get_query(&path, &[("state", "resolved")]).await);
    let open_comments = c.get(&format!("/canvases/{cmid}")).await.json()["open_comments"].clone();
    rec.json("cm_canvas_open_comments", 200, json!({"open_comments": open_comments}));
    rec.resp("cm_reopen", &c.post_empty(&format!("/canvases/threads/{t1_id}/reopen")).await);
    rec.resp("cm_reopen_open_one", &c.post_empty(&format!("/canvases/threads/{t1_id}/reopen")).await);
    rec.resp("cm_reopen_viewer", &vi.post_empty(&format!("/canvases/threads/{t1_id}/reopen")).await);
    rec.resp("cm_reopen_unknown", &c.post_empty("/canvases/threads/nope/reopen").await);
    let ai_thread = designer.post(&path, json!({"body": "Mine", "board_id": cmb})).await.json();
    rec.resp(
        "cm_resolve_ai_own",
        &designer.post_empty(&format!("/canvases/threads/{}/resolve", s(&ai_thread["id"]))).await,
    );

    // PATCH /canvases/comments/{comment_id}
    let first = s(&t1["comments"][0]["id"]);
    rec.resp(
        "cm_edit",
        &c.patch(&format!("/canvases/comments/{first}"), json!({"body": "  Logo is fine now  "})).await,
    );
    rec.resp("cm_edit_mention", &c.patch(&format!("/canvases/comments/{first}"), json!({"body": "ask @Ann"})).await);
    rec.resp("cm_edit_empty", &c.patch(&format!("/canvases/comments/{first}"), json!({"body": " "})).await);
    rec.resp("cm_edit_missing_body", &c.patch(&format!("/canvases/comments/{first}"), json!({})).await);
    rec.resp("cm_edit_not_yours", &an.patch(&format!("/canvases/comments/{first}"), json!({"body": "mine now"})).await);
    rec.resp("cm_edit_viewer", &vi.patch(&format!("/canvases/comments/{first}"), json!({"body": "mine now"})).await);
    rec.resp("cm_edit_unknown", &c.patch("/canvases/comments/nope", json!({"body": "x"})).await);

    // DELETE /canvases/comments/{comment_id}
    rec.resp("cm_delete_not_yours", &an.delete(&format!("/canvases/comments/{reply_id}")).await);
    rec.resp("cm_delete_viewer", &vi.delete(&format!("/canvases/comments/{reply_id}")).await);
    rec.resp("cm_delete_unknown", &c.delete("/canvases/comments/nope").await);
    rec.resp("cm_delete_reply", &c.delete(&format!("/canvases/comments/{reply_id}")).await);
    rec.resp("cm_delete_opening_comment", &c.delete(&format!("/canvases/comments/{first}")).await);
    rec.resp("cm_delete_gone", &c.delete(&format!("/canvases/comments/{first}")).await);
    rec.resp("cm_threads_after", &c.get(&path).await);

    // what the mentions sent: the person's own Needs you rows, and the event log
    rec.resp("cm_notifications_hoa", &hoa_client.get("/notifications").await);
    rec.resp("cm_notifications_ann", &srv.client().header("x-actor", "Ann").get("/notifications").await);
    rec.resp("cm_notifications_author", &c.get("/notifications").await);
    rec.resp("cm_notification_log", &c.get_query("/notifications/log", &[("since", "0")]).await);
}

async fn script(srv: &Server) -> Map<String, Value> {
    let c = srv.client();
    let an = srv.client().header("x-actor", "An");
    let vi = srv.client().header("x-actor", "Vi");
    let pid = pid(&c).await;
    member(&c, &pid, "An", "member").await;
    member(&c, &pid, "Vi", "viewer").await;
    let mut rec = Rec::default();
    let q = [("owner_kind", "doc"), ("owner_id", "page-1")];

    // GET /canvases
    rec.resp("list_empty", &c.get_query("/canvases", &q).await);
    rec.resp("list_missing_params", &c.get("/canvases").await);

    // POST /canvases
    let base = json!({"owner_kind": "doc", "owner_id": "page-1", "title": "Login redesign", "project_id": pid});
    let r = c.post("/canvases", base.clone()).await;
    rec.resp("create", &r);
    let cv = r.json();
    let cid = s(&cv["id"]);
    let b1 = s(&cv["doc"]["boards"][0]["id"]);
    let page1 = s(&cv["doc"]["pages"][0]["id"]);
    rec.resp(
        "create_none_phone",
        &c.post(
            "/canvases",
            json!({"owner_kind": "doc", "owner_id": "page-2", "project_id": pid, "start": "none", "size": "phone"}),
        )
        .await,
    );
    rec.resp(
        "create_bad_size_is_desktop",
        &c.post(
            "/canvases",
            json!({"owner_kind": "doc", "owner_id": "page-3", "project_id": pid, "size": "huge", "title": "[x]  y"}),
        )
        .await,
    );
    rec.resp("create_bad_owner_kind", &c.post("/canvases", json!({"owner_kind": "bogus", "owner_id": "x"})).await);
    rec.resp("create_blank_owner_id", &c.post("/canvases", json!({"owner_kind": "doc", "owner_id": "  "})).await);
    rec.resp(
        "create_unknown_project",
        &c.post("/canvases", json!({"owner_kind": "doc", "owner_id": "x", "project_id": "nope"})).await,
    );
    rec.resp("create_missing_fields", &c.post("/canvases", json!({"title": "x"})).await);
    rec.resp("create_viewer", &vi.post("/canvases", base.clone()).await);
    rec.resp("create_free_idea", &c.post("/canvases", json!({"owner_kind": "idea", "owner_id": "idea-free"})).await);
    rec.resp("list_one", &c.get_query("/canvases", &q).await);

    // GET /canvases/{canvas_id}
    rec.resp("get", &c.get(&format!("/canvases/{cid}")).await);
    rec.resp("get_unknown", &c.get("/canvases/cv_00000000").await);
    rec.resp("get_bad_shape", &c.get("/canvases/nope").await);
    rec.resp("get_viewer", &vi.get(&format!("/canvases/{cid}")).await);

    // PATCH /canvases/{canvas_id}
    let up = c
        .patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": 1, "title": "Renamed [x]", "upsert": {
                "notes": [{"x": 10, "y": 20.5, "text": "Copy\u{0}", "color": "green", "page": page1}],
                "labels": [{"x": 0, "y": -60, "text": "Step 2", "size": 200, "page": page1}],
                "pages": [{"name": "Second"}],
                "boards": [{"id": b1, "rev": 1, "x": 500, "name": "  Moved  ", "w": 5000, "h": 10, "order": "3", "fit": 1}]}}),
        )
        .await;
    rec.resp("patch_save", &up);
    let doc = up.json()["doc"].clone();
    let note = doc["notes"][0].clone();
    let rev = up.json()["rev"].clone();
    rec.resp("patch_arrow", &c.patch(&format!("/canvases/{cid}"), json!({"base_rev": rev, "upsert": {"arrows": [{"from": b1, "to": note["id"], "label": "after", "page": page1}]}})).await);
    rec.resp(
        "patch_arrow_same_end",
        &c.patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": rev, "upsert": {"arrows": [{"from": b1, "to": b1, "page": page1}]}}),
        )
        .await,
    );
    rec.resp(
        "patch_conflict",
        &c.patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": 1, "upsert": {"notes": [{"id": note["id"], "rev": 1, "x": 5}]}}),
        )
        .await,
    );
    rec.resp(
        "patch_force",
        &c.patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": 1, "force": true, "upsert": {"notes": [{"id": note["id"], "rev": 1, "x": 5}]}}),
        )
        .await,
    );
    rec.resp(
        "patch_unknown_list",
        &c.patch(&format!("/canvases/{cid}"), json!({"base_rev": 1, "upsert": {"bogus": [{"x": 1}]}})).await,
    );
    rec.resp(
        "patch_add_board",
        &c.patch(&format!("/canvases/{cid}"), json!({"base_rev": 1, "upsert": {"boards": [{"name": "x"}]}})).await,
    );
    rec.resp("patch_missing_base_rev", &c.patch(&format!("/canvases/{cid}"), json!({})).await);
    rec.resp(
        "patch_bad_upsert",
        &c.patch(&format!("/canvases/{cid}"), json!({"base_rev": 1, "upsert": {"notes": "x"}})).await,
    );
    rec.resp("patch_no_change", &c.patch(&format!("/canvases/{cid}"), json!({"base_rev": 1})).await);
    rec.resp(
        "patch_checkpoint",
        &c.patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": 1, "checkpoint": true, "name": "Review", "note": "First"}),
        )
        .await,
    );
    rec.resp(
        "patch_remove",
        &c.patch(
            &format!("/canvases/{cid}"),
            json!({"base_rev": 1, "remove": [note["id"], "zz_unknown", "n_00000000"]}),
        )
        .await,
    );
    rec.resp("patch_viewer", &vi.patch(&format!("/canvases/{cid}"), json!({"base_rev": 1})).await);
    rec.resp("patch_unknown_canvas", &c.patch("/canvases/cv_00000000", json!({"base_rev": 1})).await);

    // frames: POST /canvases/{canvas_id}/boards
    let boards = format!("/canvases/{cid}/boards");
    let r = form(
        srv,
        "POST",
        &boards,
        &[("kind", "html"), ("name", "Sign in"), ("x", "2000.5"), ("y", "10")],
        vec![html("index.html", PAGE), part("files", "css/a.css", "text/css", b"a{}")],
        &[],
    )
    .await;
    rec.reply("board_html", &r);
    let hb = r.json()["board"].clone();
    let (hbid, hrev) = (s(&hb["id"]), hb["content"]["rev"].as_i64().expect("rev"));
    let r = form(
        srv,
        "POST",
        &boards,
        &[("kind", "image"), ("size", "tablet")],
        vec![part("files", "shot.png", "image/png", &png(800, 600, 0))],
        &[],
    )
    .await;
    rec.reply("board_image", &r);
    let ibid = s(&r.json()["board"]["id"]);
    let r = form(
        srv,
        "POST",
        &boards,
        &[("kind", "image")],
        vec![part("files", "shot.png", "image/png", &png(3000, 200, 0))],
        &[],
    )
    .await;
    rec.reply("board_image_size_from_picture", &r);
    rec.reply(
        "board_empty_urlencoded",
        &urlform(
            srv,
            "POST",
            &boards,
            &[("kind", "empty"), ("name", ""), ("page", "p_unknown"), ("size", "phone")],
            &[],
        )
        .await,
    );
    rec.reply("board_default_kind", &urlform(srv, "POST", &boards, &[], &[]).await);
    rec.reply("board_bad_kind", &urlform(srv, "POST", &boards, &[("kind", "video")], &[]).await);
    rec.reply("board_html_no_files", &urlform(srv, "POST", &boards, &[("kind", "html")], &[]).await);
    rec.reply(
        "board_html_no_page",
        &form(srv, "POST", &boards, &[("kind", "html")], vec![part("files", "a.css", "text/css", b"a{}")], &[]).await,
    );
    rec.reply(
        "board_html_bad_entry",
        &form(srv, "POST", &boards, &[("kind", "html"), ("entry", "nope.html")], vec![html("index.html", PAGE)], &[])
            .await,
    );
    rec.reply(
        "board_html_entry_and_paths",
        &form(
            srv,
            "POST",
            &boards,
            &[("kind", "html"), ("entry", "site/b.html"), ("paths", "site/a.html"), ("paths", "site/b.html")],
            vec![html("x", "<title>A</title>"), html("y", "<title>B</title>")],
            &[],
        )
        .await,
    );
    rec.reply(
        "board_html_folder_clash",
        &form(
            srv,
            "POST",
            &boards,
            &[("kind", "html")],
            vec![
                html("index.html", PAGE),
                part("files", "a.css", "text/css", b"a{}"),
                part("files", "a.css/b.html", "text/html", b"<p>"),
            ],
            &[],
        )
        .await,
    );
    rec.reply(
        "board_html_bad_path",
        &form(
            srv,
            "POST",
            &boards,
            &[("kind", "html")],
            vec![html("index.html", PAGE), part("files", "../evil.html", "text/html", b"<p>")],
            &[],
        )
        .await,
    );
    rec.reply(
        "board_image_two_files",
        &form(
            srv,
            "POST",
            &boards,
            &[("kind", "image")],
            vec![
                part("files", "a.png", "image/png", &png(8, 6, 0)),
                part("files", "b.png", "image/png", &png(8, 6, 0)),
            ],
            &[],
        )
        .await,
    );
    rec.reply(
        "board_image_not_a_picture",
        &form(srv, "POST", &boards, &[("kind", "image")], vec![part("files", "a.png", "image/png", b"nope")], &[])
            .await,
    );
    rec.reply(
        "board_sketch_unknown",
        &urlform(srv, "POST", &boards, &[("kind", "sketch"), ("ref", "sk_00000000")], &[]).await,
    );
    rec.reply(
        "board_diagram_unknown",
        &urlform(srv, "POST", &boards, &[("kind", "diagram"), ("ref", "dg_00000000")], &[]).await,
    );
    rec.reply("board_bad_float", &urlform(srv, "POST", &boards, &[("kind", "empty"), ("x", "abc")], &[]).await);
    rec.reply("board_viewer", &urlform(srv, "POST", &boards, &[("kind", "empty")], &[("x-actor", "Vi")]).await);
    rec.reply(
        "board_unknown_canvas",
        &urlform(srv, "POST", "/canvases/cv_00000000/boards", &[("kind", "empty")], &[]).await,
    );

    // POST /canvases/{canvas_id}/import
    let zipped = zip_of(&[
        ("dist/index.html", b"<title>Built</title><h1>B</h1>"),
        ("dist/a.css", b"a{}"),
        ("../evil.html", b"x"),
    ]);
    rec.reply(
        "import",
        &form(
            srv,
            "POST",
            &format!("/canvases/{cid}/import"),
            &[],
            vec![
                part("files", "site.zip", "application/zip", &zipped),
                html("login.html", PAGE),
                html("index.html", PAGE),
                part("files", "shot.png", "image/png", &png(8, 6, 0)),
                part("files", "notes.pdf", "application/pdf", b"%PDF"),
                part("files", "x.zip", "application/zip", b"not a zip"),
                part("files", "empty.zip", "application/zip", &zip_of(&[])),
            ],
            &[],
        )
        .await,
    );
    rec.reply(
        "import_no_files",
        &urlform(srv, "POST", &format!("/canvases/{cid}/import"), &[("page", "p_x")], &[]).await,
    );
    rec.reply(
        "import_unknown_canvas",
        &form(srv, "POST", "/canvases/cv_00000000/import", &[], vec![html("a.html", PAGE)], &[]).await,
    );

    // duplicate, source, content, replace
    rec.resp("duplicate", &c.post_empty(&format!("/canvases/{cid}/boards/{hbid}/duplicate")).await);
    rec.resp("duplicate_unknown_board", &c.post_empty(&format!("/canvases/{cid}/boards/b_00000000/duplicate")).await);
    rec.resp("duplicate_viewer", &vi.post_empty(&format!("/canvases/{cid}/boards/{hbid}/duplicate")).await);
    rec.resp("source", &c.get(&format!("/canvases/{cid}/boards/{hbid}/source")).await);
    rec.resp("source_image_board", &c.get(&format!("/canvases/{cid}/boards/{ibid}/source")).await);
    rec.resp("source_empty_board", &c.get(&format!("/canvases/{cid}/boards/{b1}/source")).await);
    rec.resp("source_unknown_board", &c.get(&format!("/canvases/{cid}/boards/b_00000000/source")).await);
    rec.resp("source_bad_board_id", &c.get(&format!("/canvases/{cid}/boards/zzz/source")).await);
    let content = format!("/canvases/{cid}/boards/{hbid}/content");
    rec.resp("content_locked_by_other", &{
        an.post_empty(&format!("/canvases/{cid}/boards/{hbid}/lock")).await;
        c.put(&content, json!({"files": [{"path": "index.html", "text": "<h1>no</h1>"}]})).await
    });
    rec.resp("unlock_other", &an.delete(&format!("/canvases/{cid}/boards/{hbid}/lock")).await);
    rec.resp("content_save", &c.put(&content, json!({"files": [{"path": "index.html", "text": "<title>New</title><h1>New</h1>"}], "base_content_rev": hrev})).await);
    rec.resp(
        "content_conflict",
        &c.put(&content, json!({"files": [{"path": "index.html", "text": "<h1>x</h1>"}], "base_content_rev": hrev}))
            .await,
    );
    rec.resp("content_keep_lock", &c.put(&content, json!({"files": [{"path": "index.html", "text": "<h1>keep</h1>"}], "release": false, "entry": "index.html"})).await);
    rec.resp("content_no_page", &c.put(&content, json!({"files": [{"path": "a.css", "text": "a{}"}]})).await);
    rec.resp(
        "content_bad_entry",
        &c.put(&content, json!({"files": [{"path": "index.html", "text": "<h1>x</h1>"}], "entry": "zzz.html"})).await,
    );
    rec.resp(
        "content_image_board",
        &c.put(
            &format!("/canvases/{cid}/boards/{ibid}/content"),
            json!({"files": [{"path": "index.html", "text": "x"}]}),
        )
        .await,
    );
    rec.resp("content_viewer", &vi.put(&content, json!({"files": [{"path": "index.html", "text": "x"}]})).await);
    rec.resp("content_missing_files", &c.put(&content, json!({})).await);
    rec.resp(
        "content_unknown_board",
        &c.put(&format!("/canvases/{cid}/boards/b_00000000/content"), json!({"files": []})).await,
    );
    let replace = format!("/canvases/{cid}/boards/{hbid}/replace");
    rec.reply("replace_html", &form(srv, "POST", &replace, &[], vec![html("whatever.html", "<h1>R</h1>")], &[]).await);
    rec.reply(
        "replace_zip",
        &form(
            srv,
            "POST",
            &replace,
            &[("entry", "index.html")],
            vec![part("files", "d.zip", "application/zip", &zip_of(&[("d/index.html", b"<h1>Z</h1>")]))],
            &[],
        )
        .await,
    );
    rec.reply(
        "replace_conflict",
        &form(srv, "POST", &replace, &[("base_content_rev", "1")], vec![html("a.html", "<h1>C</h1>")], &[]).await,
    );
    rec.reply(
        "replace_bad_rev",
        &form(srv, "POST", &replace, &[("base_content_rev", "x")], vec![html("a.html", "<h1>C</h1>")], &[]).await,
    );
    rec.reply("replace_no_files", &urlform(srv, "POST", &replace, &[], &[]).await);

    // locks
    let lock = format!("/canvases/{cid}/boards/{hbid}/lock");
    rec.resp("lock", &c.post_empty(&lock).await);
    rec.resp("lock_again", &c.post_empty(&lock).await);
    rec.resp("lock_other", &an.post_empty(&lock).await);
    rec.resp("lock_image_board", &c.post_empty(&format!("/canvases/{cid}/boards/{ibid}/lock")).await);
    rec.resp("lock_viewer", &vi.post_empty(&lock).await);
    rec.resp("heartbeat", &c.post_empty(&format!("/canvases/{cid}/boards/{hbid}/heartbeat")).await);
    rec.resp("heartbeat_other", &an.post_empty(&format!("/canvases/{cid}/boards/{hbid}/heartbeat")).await);
    rec.resp("heartbeat_unknown_canvas", &c.post_empty("/canvases/cv_00000000/boards/b_00000000/heartbeat").await);
    rec.resp("unlock_not_holder", &an.delete(&lock).await);
    rec.resp("unlock", &c.delete(&lock).await);
    rec.resp("unlock_again", &c.delete(&lock).await);

    // files, snapshot, overview, download
    let now = c.get(&format!("/canvases/{cid}")).await.json();
    let hb_now = now["doc"]["boards"]
        .as_array()
        .expect("boards")
        .iter()
        .find(|b| b["id"] == json!(hbid))
        .expect("board")
        .clone();
    let rev_now = hb_now["content"]["rev"].as_i64().expect("rev");
    let frame = [
        "content-type",
        "x-content-type-options",
        "access-control-allow-origin",
        "cache-control",
        "content-security-policy",
    ];
    let file = |rev: i64, path: &str| format!("/canvases/{cid}/boards/{hbid}/r/{rev}/{path}");
    rec.file("file_html", &raw_get(srv, &file(rev_now, "index.html"), &[]).await, &frame);
    rec.file("file_old_revision", &raw_get(srv, &file(hrev, "css/a.css"), &[]).await, &frame);
    rec.file("file_missing", &raw_get(srv, &file(rev_now, "nope.html"), &[]).await, &["content-type"]);
    rec.file("file_unknown_revision", &raw_get(srv, &file(9999, "index.html"), &[]).await, &["content-type"]);
    rec.file(
        "file_bad_board",
        &raw_get(srv, &format!("/canvases/{cid}/boards/zzz/r/1/index.html"), &[]).await,
        &["content-type"],
    );
    rec.file(
        "file_bad_revision",
        &raw_get(srv, &format!("/canvases/{cid}/boards/{hbid}/r/x/index.html"), &[]).await,
        &[],
    );
    let snap = format!("/canvases/{cid}/boards/{hbid}/snapshot.png");
    rec.file("snapshot", &raw_get(srv, &snap, &[]).await, &["content-type", "cache-control"]);
    rec.file(
        "snapshot_old_revision",
        &raw_get(srv, &format!("{snap}?rev={hrev}"), &[]).await,
        &["content-type", "cache-control"],
    );
    rec.file(
        "snapshot_empty_board",
        &raw_get(srv, &format!("/canvases/{cid}/boards/{b1}/snapshot.png"), &[]).await,
        &["content-type"],
    );
    rec.file(
        "snapshot_unknown_board",
        &raw_get(srv, &format!("/canvases/{cid}/boards/b_00000000/snapshot.png"), &[]).await,
        &["content-type"],
    );
    rec.file("snapshot_bad_rev", &raw_get(srv, &format!("{snap}?rev=x"), &[]).await, &[]);
    let overview = format!("/canvases/{cid}/overview.png");
    rec.file("overview", &raw_get(srv, &overview, &[]).await, &["content-type", "cache-control"]);
    rec.file("overview_page", &raw_get(srv, &format!("{overview}?page={page1}"), &[]).await, &["content-type"]);
    rec.file(
        "overview_unknown_canvas",
        &raw_get(srv, "/canvases/cv_00000000/overview.png", &[]).await,
        &["content-type"],
    );
    let download = format!("/canvases/{cid}/download");
    let disposition = ["content-type", "content-disposition", "access-control-expose-headers"];
    rec.file("download", &raw_get(srv, &download, &[]).await, &disposition);
    rec.file("download_board", &raw_get(srv, &format!("{download}?board_id={hbid}"), &[]).await, &disposition);
    rec.file(
        "download_unknown_board",
        &raw_get(srv, &format!("{download}?board_id=b_00000000"), &[]).await,
        &["content-type"],
    );
    rec.file("download_version", &raw_get(srv, &format!("{download}?version=1"), &[]).await, &disposition);
    rec.file(
        "download_unknown_version",
        &raw_get(srv, &format!("{download}?version=99"), &[]).await,
        &["content-type"],
    );
    rec.file("download_bad_version", &raw_get(srv, &format!("{download}?version=x"), &[]).await, &[]);

    // versions
    rec.resp("versions", &c.get(&format!("/canvases/{cid}/versions")).await);
    rec.resp(
        "version_make",
        &c.post(&format!("/canvases/{cid}/versions"), json!({"name": "Named", "note": "n"})).await,
    );
    rec.resp("version_make_viewer", &vi.post(&format!("/canvases/{cid}/versions"), json!({})).await);
    rec.resp("version_get", &c.get(&format!("/canvases/{cid}/versions/1")).await);
    rec.resp("version_unknown", &c.get(&format!("/canvases/{cid}/versions/99")).await);
    rec.resp("version_bad_number", &c.get(&format!("/canvases/{cid}/versions/x")).await);
    rec.resp("version_name", &c.patch(&format!("/canvases/{cid}/versions/1"), json!({"name": " First "})).await);
    rec.resp("version_unname", &c.patch(&format!("/canvases/{cid}/versions/1"), json!({"name": ""})).await);
    rec.resp("version_name_unknown", &c.patch(&format!("/canvases/{cid}/versions/99"), json!({"name": "x"})).await);
    rec.resp("compare", &c.get_query(&format!("/canvases/{cid}/compare"), &[("a", "1"), ("b", "3")]).await);
    rec.resp("compare_unknown", &c.get_query(&format!("/canvases/{cid}/compare"), &[("a", "1"), ("b", "99")]).await);
    rec.resp("compare_missing", &c.get(&format!("/canvases/{cid}/compare")).await);
    rec.resp(
        "source_diff",
        &c.get_query(&format!("/canvases/{cid}/boards/{hbid}/source-diff"), &[("a", "1"), ("b", "3")]).await,
    );
    rec.resp(
        "source_diff_unknown_board",
        &c.get_query(&format!("/canvases/{cid}/boards/b_00000000/source-diff"), &[("a", "1"), ("b", "3")]).await,
    );
    rec.resp(
        "source_diff_unknown_version",
        &c.get_query(&format!("/canvases/{cid}/boards/{hbid}/source-diff"), &[("a", "1"), ("b", "99")]).await,
    );
    rec.resp("restore_locked", &{
        an.post_empty(&lock).await;
        c.post_empty(&format!("/canvases/{cid}/versions/1/restore")).await
    });
    an.delete(&lock).await;
    rec.resp("restore_viewer", &vi.post_empty(&format!("/canvases/{cid}/versions/1/restore")).await);
    rec.resp("restore_unknown", &c.post_empty(&format!("/canvases/{cid}/versions/99/restore")).await);
    rec.resp("restore", &c.post_empty(&format!("/canvases/{cid}/versions/2/restore")).await);

    // copy, unlink, restore, move to Docs
    rec.resp("copy", &c.post_empty(&format!("/canvases/{cid}/copy")).await);
    rec.resp("copy_title", &c.post_empty(&format!("/canvases/{cid}/copy?title=Mine%20%5Bx%5D")).await);
    rec.resp("copy_viewer", &vi.post_empty(&format!("/canvases/{cid}/copy")).await);
    rec.resp("copy_unknown", &c.post_empty("/canvases/cv_00000000/copy").await);
    let free = c.post("/canvases", json!({"owner_kind": "idea", "owner_id": "idea-9"})).await.json();
    rec.resp(
        "move_to_docs_no_project",
        &c.post(&format!("/canvases/{}/move-to-docs", s(&free["id"])), json!({})).await,
    );
    rec.resp("move_to_docs_viewer", &vi.post(&format!("/canvases/{cid}/move-to-docs"), json!({})).await);
    rec.resp("move_to_docs_missing_body", &c.post_empty(&format!("/canvases/{cid}/move-to-docs")).await);
    rec.resp("move_to_docs_unknown", &c.post("/canvases/cv_00000000/move-to-docs", json!({})).await);
    rec.resp("delete_viewer", &vi.delete(&format!("/canvases/{cid}")).await);
    rec.resp("delete", &c.delete(&format!("/canvases/{cid}")).await);
    rec.resp("delete_again", &c.delete(&format!("/canvases/{cid}")).await);
    rec.resp("get_deleted", &c.get(&format!("/canvases/{cid}")).await);
    rec.resp("restore_canvas_viewer", &vi.post_empty(&format!("/canvases/{cid}/restore")).await);
    rec.resp("restore_canvas", &c.post_empty(&format!("/canvases/{cid}/restore")).await);
    rec.resp("restore_canvas_unknown", &c.post_empty("/canvases/cv_00000000/restore").await);
    comments(srv, &c, &an, &vi, &pid, &mut rec).await;
    // the Docs steps come last: where the Docs area is not wired in they are skipped and nothing above depends on them
    if c.post("/canvases/pages", json!({"project_id": pid, "title": "Probe"})).await.status == 201 {
        let r = c.post("/canvases/pages", json!({"project_id": pid, "title": "Settings flow"})).await;
        rec.resp("docs_page_canvas", &r);
        let own =
            c.post("/canvases", json!({"owner_kind": "doc", "owner_id": "page-9", "project_id": pid})).await.json();
        let oid = s(&own["id"]);
        rec.resp(
            "move_to_docs",
            &c.post(&format!("/canvases/{oid}/move-to-docs"), json!({"title": "Login flow"})).await,
        );
        rec.resp("move_to_docs_again", &c.post(&format!("/canvases/{oid}/move-to-docs"), json!({})).await);
        rec.resp("pages_unknown_project", &c.post("/canvases/pages", json!({"project_id": "nope"})).await);
    }
    rec.out
}

#[tokio::test]
async fn every_route_answers_as_the_python_server_does() {
    if !skip_unless_available("every_route_answers_as_the_python_server_does") {
        return;
    }
    let srv = Server::start().await;
    let got = script(&srv).await;
    if std::env::var("KB_RECORD_ROUTES").is_ok() && target() == Target::Python {
        std::fs::write(SNAPSHOT, serde_json::to_string_pretty(&Value::Object(got.clone())).expect("json"))
            .expect("write the snapshot");
        return;
    }
    let want: Map<String, Value> =
        serde_json::from_slice(&std::fs::read(SNAPSHOT).expect("record the snapshot from the Python server first"))
            .expect("snapshot json");
    let mut bad = Vec::new();
    let mut skipped = Vec::new();
    for (label, expected) in &want {
        match got.get(label) {
            Some(actual) if actual == expected => {}
            Some(actual) => bad.push(format!("{label}\n  got  {actual}\n  want {expected}")),
            None => skipped.push(label.clone()),
        }
    }
    for label in got.keys().filter(|l| !want.contains_key(*l)) {
        bad.push(format!("{label}: not in the snapshot"));
    }
    if !skipped.is_empty() {
        eprintln!("SKIPPED labels this server cannot answer yet: {skipped:?}");
    }
    assert!(
        bad.is_empty(),
        "{} routes differ:\n{}",
        bad.len(),
        bad.iter().take(25).cloned().collect::<Vec<_>>().join("\n")
    );
    let _: Option<Client> = None;
}
