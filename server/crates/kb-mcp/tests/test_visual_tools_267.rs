//! `tests/test_visual_tools_267.py`, the tests that go through the Docs tools: canvas, draw.io and Sketch for any AI
//! (issue #267): the guides reach outside agents through docs_read, a diagram reads as a model, a save says what will
//! look broken, an agent can see a PNG of what it drew, and an agent changes a frame directly.
//!
//! No draw.io editor is reachable in a test: the servers start with the export switched off.
//!
//! Not ported here:
//! - service tests: `test_the_hidden_browser_loads_only_the_page_and_public_hosts` (`screenshots::allowed`),
//!   `test_the_plain_preview_draws_a_links_bends_and_orthogonal_elbows` and
//!   `test_a_chip_a_tab_or_a_frame_behind_steps_is_not_taken_for_an_overlap` (`diagram_model`) are in `kb-draw`'s tests.
//! - waiting for the AI port: `test_each_role_that_draws_is_pointed_at_the_right_tool` (the built-in packs),
//!   `test_an_ai_run_looks_only_at_files_in_its_own_folder` and `test_an_ai_run_writes_a_picture_only_in_its_own_folder`
//!   (they enter an AI run: a team, its run and its working folder), the skill-folder half of
//!   `test_the_diagram_and_sketch_guides_are_skills_and_the_same_text_through_docs_read` (`board_skills.plugin_dir()`),
//!   the plugin catalogue half of `test_flow_is_suggested_and_the_draw_io_guide_says_how_its_files_reach_the_board`.

mod common;

use std::io::{Read, Write};

use common::{call, call_err};
use serde_json::{Value, json};
use testkit::Options;

const FLOW: &str = "<mxfile><diagram name=\"Sign-up\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>
<mxCell id=\"form\" value=\"Fill in the form\" style=\"rounded=1;html=1;\" vertex=\"1\" parent=\"1\">
<mxGeometry x=\"40\" y=\"40\" width=\"160\" height=\"60\" as=\"geometry\"/></mxCell>
<mxCell id=\"valid\" value=\"Email valid?\" style=\"rhombus;html=1;\" vertex=\"1\" parent=\"1\">
<mxGeometry x=\"60\" y=\"180\" width=\"120\" height=\"80\" as=\"geometry\"/></mxCell>
<mxCell id=\"lane\" value=\"Server\" style=\"swimlane;html=1;\" vertex=\"1\" parent=\"1\">
<mxGeometry x=\"300\" y=\"0\" width=\"300\" height=\"300\" as=\"geometry\"/></mxCell>
<mxCell id=\"send\" value=\"Send the email\" style=\"rounded=1;html=1;\" vertex=\"1\" parent=\"lane\">
<mxGeometry x=\"40\" y=\"60\" width=\"160\" height=\"60\" as=\"geometry\"/></mxCell>
<mxCell id=\"e1\" edge=\"1\" source=\"form\" target=\"valid\" parent=\"1\"><mxGeometry relative=\"1\" as=\"geometry\"/></mxCell>
<mxCell id=\"e2\" value=\"yes\" edge=\"1\" source=\"valid\" target=\"send\" parent=\"1\"><mxGeometry relative=\"1\" as=\"geometry\"/></mxCell>
</root></mxGraphModel></diagram></mxfile>";

const FRAME: &str = "<!doctype html><meta name='viewport' content='width=device-width'><h1>Create your account</h1><button>Create</button>";

const NARROW: &str = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>
<mxCell id=\"a\" value=\"\" style=\"rounded=0;html=1;fillColor=#ff0000;strokeColor=#ff0000;\" vertex=\"1\" parent=\"1\">
<mxGeometry x=\"40\" y=\"40\" width=\"160\" height=\"60\" as=\"geometry\"/></mxCell>
<mxCell id=\"b\" value=\"\" style=\"rounded=0;html=1;\" vertex=\"1\" parent=\"1\">
<mxGeometry x=\"40\" y=\"200\" width=\"160\" height=\"60\" as=\"geometry\"/></mxCell>
</root></mxGraphModel>";

fn options(no_browser: bool) -> Options {
    let mut env = vec![("KANBAN_DIAGRAM_EXPORT".to_string(), "off".to_string())];
    if no_browser {
        env.push(("KANBAN_CHROME_PATH".to_string(), "/no/such/chrome".to_string()));
        env.push(("KANBAN_EXPORT_CMD".to_string(), String::new()));
    }
    Options { env, ..Options::default() }
}

fn folder() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("kbvisual").tempdir().expect("a folder")
}

async fn write(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_write", arguments).await
}

async fn read(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_read", arguments).await
}

async fn fail(mcp: &testkit::Mcp, action: &str, rest: Value) -> String {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    common::call_err(mcp, "docs_read", arguments).await
}

fn png_size(path: &str) -> (i64, i64) {
    let data = std::fs::read(path).expect("a PNG");
    assert_eq!(&data[..8], b"\x89PNG\r\n\x1a\n");
    (
        i64::from(u32::from_be_bytes([data[16], data[17], data[18], data[19]])),
        i64::from(u32::from_be_bytes([data[20], data[21], data[22], data[23]])),
    )
}

/// `_diagram(env, tmp_path, source)`: a project and a diagram made from a file.
async fn diagram(s: &testkit::Server, dir: &std::path::Path, source: &str, pid: Option<&Value>) -> (Value, Value) {
    let c = s.client();
    let pid = match pid {
        Some(pid) => pid.clone(),
        None => {
            let made = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
            made.assert_status(201);
            made.json()["id"].clone()
        }
    };
    let f = dir.join("flow.drawio");
    std::fs::write(&f, source).expect("a file");
    let diagram = write(
        &s.mcp(),
        "diagram_create",
        json!({"project_id": pid, "title": "Sign-up flow", "path": f.to_string_lossy()}),
    )
    .await;
    (pid, diagram)
}

#[tokio::test]
async fn test_the_diagram_and_sketch_guides_are_skills_and_the_same_text_through_docs_read() {
    let s = common::start().await;
    let guide = read(&s.mcp(), "diagram_guide", json!({})).await;
    let text = guide["guide"].as_str().expect("text");
    // what the guide must teach (the issue's list) and the choice of tool at its top
    for needle in [
        "## Which tool",
        "**Flowchart**",
        "**Swimlane flowchart**",
        "**Sequence**",
        "**State machine**",
        "## 2. Layout on a grid",
        "## 3. Style from one palette",
        "## 4. Labels",
        "## 5. Groups, containers and lanes",
        "## 7. Changing an existing diagram",
        "change **only those cells**",
        "docs_read(action='picture'",
        "## 9. Hand it in",
    ] {
        assert!(text.contains(needle), "{needle}");
    }
    // the Sketch decision is written down, with its reason
    let sketches = guide["sketches"].as_str().expect("text");
    assert!(sketches.contains("You read Sketches; you do not draw them"));
    assert!(sketches.contains("fake hand-drawn look"));
    // (the skill files in the plugin folder are the AI port's: they are these texts with a header)
    assert_eq!(guide["guide"], kb_draw::visual_guides::DRAWIO);
    assert_eq!(guide["sketches"], kb_draw::visual_guides::SKETCH.to_string() + "");
}

#[tokio::test]
async fn test_the_instructions_say_which_tool_and_where_the_guides_are() {
    let s = common::start_with(Options {
        env: vec![("KANBAN_MCP_IDEA_TOOLS".to_string(), "1".to_string())],
        ..Options::default()
    })
    .await;
    let reply = s.mcp().initialize().await;
    let text = reply["instructions"].as_str().expect("instructions");
    assert!(text.chars().count() < 10_000);
    for needle in [
        "Which drawing",
        "never draw one",
        "drawio-diagrams",
        "docs_read(diagram_guide)",
        "docs_read(picture)",
        "the flow as a Diagram, the screens on a Canvas",
    ] {
        assert!(text.contains(needle), "{needle}");
    }
    assert!(!text.contains(kb_draw::visual_guides::DRAWIO));
}

#[tokio::test]
async fn test_a_diagram_reads_as_a_model_without_a_file() {
    let s = common::start_with(options(false)).await;
    let dir = folder();
    let (_, made) = diagram(&s, dir.path(), FLOW, None).await;
    let got = read(&s.mcp(), "diagram", json!({"diagram_id": made["id"]})).await;
    assert!(got.get("path").is_none() && got["version"] == 1);
    let m = &got["model"];
    assert!(m["page"] == "Sign-up" && m["problems"] == json!([]));
    let shape =
        |id: &str| m["shapes"].as_array().expect("shapes").iter().find(|s| s["id"] == id).expect("a shape").clone();
    assert!(shape("valid")["shape"] == "diamond" && shape("valid")["label"] == "Email valid?");
    assert!(shape("send")["in"] == "lane" && shape("lane")["container"] == true);
    assert_eq!((&shape("form")["x"], &shape("form")["w"]), (&json!(40.0), &json!(160.0)));
    let link = m["links"].as_array().expect("links").iter().find(|e| e["id"] == "e2").expect("a link").clone();
    assert_eq!((&link["from"], &link["to"], &link["label"]), (&json!("valid"), &json!("send"), &json!("yes")));
}

#[tokio::test]
async fn test_a_save_says_what_will_look_broken() {
    let s = common::start_with(options(false)).await;
    let dir = folder();
    let (_, made) = diagram(&s, dir.path(), FLOW, None).await;
    let f = dir.path().join("broken.drawio");
    std::fs::write(
        &f,
        FLOW.replace("target=\"send\"", "target=\"nowhere\"").replace("x=\"60\" y=\"180\"", "x=\"60\" y=\"60\""),
    )
    .expect("a file");
    let saved = write(
        &s.mcp(),
        "diagram_save",
        json!({"diagram_id": made["id"], "path": f.to_string_lossy(), "base_version": 1}),
    )
    .await;
    assert_eq!(saved["version"], 2);
    let joined: Vec<&str> = saved["problems"].as_array().expect("problems").iter().filter_map(Value::as_str).collect();
    let joined = joined.join(" ");
    assert!(joined.contains("'nowhere', which is not a shape"));
    assert!(joined.contains("'form' and 'valid' overlap"));
    assert!(saved["fix"].as_str().expect("text").contains("save again"));
}

/// `urllib.parse.quote(text)`.
fn quote(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"_.-~/".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[tokio::test]
async fn test_a_compressed_page_is_written_out_as_plain_xml_and_a_bare_name_is_a_folder() {
    use base64::Engine;
    let s = common::start_with(options(false)).await;
    let dir = folder();
    let inner =
        FLOW.split_once("<diagram name=\"Sign-up\">").expect("a page").1.rsplit_once("</diagram>").expect("a page").0;
    let mut deflate = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(9));
    deflate.write_all(quote(inner).as_bytes()).expect("deflate");
    let packed = base64::engine::general_purpose::STANDARD.encode(deflate.finish().expect("deflate"));
    let (_, made) =
        diagram(&s, dir.path(), &format!("<mxfile><diagram name=\"Sign-up\">{packed}</diagram></mxfile>"), None).await;
    let out_dir = dir.path().join("out");
    let out = read(&s.mcp(), "diagram", json!({"diagram_id": made["id"], "path": out_dir.to_string_lossy()})).await;
    assert_eq!(out["path"], out_dir.join("Sign-up-flow.drawio").to_string_lossy().as_ref());
    let text = std::fs::read_to_string(out["path"].as_str().expect("a path")).expect("the file");
    assert!(text.contains("<mxGraphModel") && text.contains("id=\"valid\""));
    let ids: Vec<&str> =
        out["model"]["shapes"].as_array().expect("shapes").iter().filter_map(|s| s["id"].as_str()).collect();
    for id in ["form", "valid", "send"] {
        assert!(ids.contains(&id), "{id}");
    }
}

#[tokio::test]
async fn test_without_a_browser_a_picture_is_a_wireframe_and_says_so() {
    let s = common::start_with(options(true)).await;
    let dir = folder();
    let (_, made) = diagram(&s, dir.path(), FLOW, None).await;
    let pics = dir.path().join("pics");
    let pic = read(&s.mcp(), "picture", json!({"diagram_id": made["id"], "path": pics.to_string_lossy()})).await;
    assert!(pic["drawn_by"] == "wireframe" && pic["note"].as_str().expect("text").contains("No browser"));
    assert_eq!(pic["path"], pics.join("Sign-up-flow.png").to_string_lossy().as_ref());
    assert_eq!(
        png_size(pic["path"].as_str().expect("a path")),
        (pic["width"].as_i64().expect("w"), pic["height"].as_i64().expect("h"))
    );
    // a copy on the board, ready for a comment
    let markdown = pic["markdown"].as_str().expect("text");
    let stored = markdown.split_once("](/uploads/").expect("a link").1.trim_end_matches(')');
    assert_eq!(
        std::fs::read(s.uploads_dir().join(stored)).expect("the copy"),
        std::fs::read(pic["path"].as_str().expect("a path")).expect("the picture")
    );
    let frame = dir.path().join("canvas/01-form");
    std::fs::create_dir_all(&frame).expect("a folder");
    std::fs::write(frame.join("index.html"), FRAME).expect("a file");
    std::fs::write(frame.join("frame.json"), "{\"size\": \"phone\"}").expect("a file");
    let local = read(&s.mcp(), "picture", json!({"path": frame.to_string_lossy()})).await;
    // beside the folder, never inside it (it would become a file of the frame)
    assert_eq!(local["path"], dir.path().join("canvas/01-form.png").to_string_lossy().as_ref());
    assert_eq!(local["drawn_by"], "wireframe");
}

#[tokio::test]
async fn test_a_picture_call_that_names_nothing_or_two_things_says_what_to_give() {
    let s = common::start_with(options(false)).await;
    let mcp = s.mcp();
    assert!(fail(&mcp, "picture", json!({})).await.contains("Give diagram_id, canvas_id"));
    assert!(fail(&mcp, "picture", json!({"diagram_id": "dg_1", "sketch_id": "sk_1"})).await.contains("Give one of"));
    assert!(
        fail(&mcp, "picture", json!({"path": "/no/such/frame.html"}))
            .await
            .contains("does not exist: write the file first")
    );
    let dir = folder();
    let other = dir.path().join("test_visual_tools_267.rs");
    std::fs::write(&other, "fn main() {}").expect("a file");
    assert!(
        fail(&mcp, "picture", json!({"path": other.to_string_lossy()}))
            .await
            .contains("frame folder or an .html, .svg or .drawio")
    );
}

#[tokio::test]
async fn test_with_a_browser_a_frame_and_a_diagram_are_drawn_for_real() {
    if kb_draw::chrome::find_chrome().is_none() {
        return;
    }
    let s = common::start_with(options(false)).await;
    let (mcp, c) = (s.mcp(), s.client());
    let dir = folder();
    let (pid, _) = diagram(&s, dir.path(), FLOW, None).await;
    let ticket =
        call(&mcp, "manage_ticket", json!({"action": "create", "project_id": pid, "title": "Sign-up", "type": "task"}))
            .await;
    let folder_of_frames = dir.path().join("canvas/01-form");
    std::fs::create_dir_all(&folder_of_frames).expect("a folder");
    std::fs::write(folder_of_frames.join("index.html"), FRAME).expect("a file");
    let made = write(
        &mcp,
        "canvas_create",
        json!({"path": dir.path().join("canvas").to_string_lossy(), "owner_kind": "ticket", "owner_id": ticket["id"], "title": "Sign-up screens"}),
    )
    .await;
    let pic = read(
        &mcp,
        "picture",
        json!({"canvas_id": made["id"], "board_id": made["boards"][0]["id"], "width": 390, "path": dir.path().join("shots").to_string_lossy()}),
    )
    .await;
    assert!(pic["drawn_by"] == "browser" && pic["width"] == 390);
    let dg = diagram(&s, dir.path(), FLOW, Some(&pid)).await.1;
    let drawn = read(&mcp, "picture", json!({"diagram_id": dg["id"]})).await;
    assert!(drawn["drawn_by"] == "browser" && drawn["width"].as_i64().expect("a width") > 300);
    let _ = c;
}

/// One pixel of an 8-bit RGB or RGBA PNG (enough to tell where a shape was drawn).
fn pixel(png: &[u8], x: usize, y: usize) -> Vec<u8> {
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]) as usize;
    let bpp = match png[25] {
        2 => 3,
        6 => 4,
        other => panic!("colour type {other}"),
    };
    let mut data = Vec::new();
    let mut i = 8;
    while i < png.len() {
        let n = u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]) as usize;
        if &png[i + 4..i + 8] == b"IDAT" {
            data.extend_from_slice(&png[i + 8..i + 8 + n]);
        }
        i += 12 + n;
    }
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(&data[..]).read_to_end(&mut raw).expect("inflate");
    let stride = w * bpp;
    let mut prev = vec![0u8; stride];
    for r in 0..=y {
        let start = r * (stride + 1);
        let kind = raw[start];
        let mut line = raw[start + 1..start + 1 + stride].to_vec();
        for k in 0..stride {
            let a = if k >= bpp { line[k - bpp] } else { 0 };
            let b = prev[k];
            let c = if k >= bpp { prev[k - bpp] } else { 0 };
            line[k] = match kind {
                1 => line[k].wrapping_add(a),
                2 => line[k].wrapping_add(b),
                3 => line[k].wrapping_add(((u16::from(a) + u16::from(b)) / 2) as u8),
                4 => {
                    let (pa, pb, pc) = (
                        (i16::from(b) - i16::from(c)).abs(),
                        (i16::from(a) - i16::from(c)).abs(),
                        (i16::from(a) + i16::from(b) - 2 * i16::from(c)).abs(),
                    );
                    let pick = if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    };
                    line[k].wrapping_add(pick)
                }
                _ => line[k],
            };
        }
        prev = line;
    }
    prev[x * bpp..x * bpp + 3].to_vec()
}

#[tokio::test]
async fn test_a_narrow_diagram_is_drawn_at_its_own_size_not_as_a_zoomed_phone_page() {
    if kb_draw::chrome::find_chrome().is_none() {
        return;
    }
    // a live Dev run looked at a 480 px wide diagram and saw only its top left corner, twice as large (#267)
    let s = common::start_with(options(false)).await;
    let dir = folder();
    let f = dir.path().join("narrow.drawio");
    std::fs::write(&f, NARROW).expect("a file");
    let pic = read(&s.mcp(), "picture", json!({"path": f.to_string_lossy()})).await;
    assert_eq!(pic["drawn_by"], "browser");
    let png = std::fs::read(pic["path"].as_str().expect("a path")).expect("a PNG");
    let expected = kb_draw::screenshots::svg_size(&kb_draw::diagram_model::render_svg(NARROW).expect("svg"));
    assert_eq!((pic["width"].as_i64().expect("w"), pic["height"].as_i64().expect("h")), expected);
    // inside the red box (it starts at 20, 20 in the picture)
    let red = pixel(&png, 100, 50);
    assert!(red[0] > 200 && red[1] < 80, "{red:?}");
    // between the two boxes: white at scale 1, red when the page was zoomed
    assert!(*pixel(&png, 190, 150).iter().min().expect("a pixel") > 220);
}

#[tokio::test]
async fn test_flow_is_suggested_and_the_draw_io_guide_says_how_its_files_reach_the_board() {
    // the plugin catalogue half waits for the AI port; the guide's half is here
    for needle in ["**With Flow.**", "flow.py build", "flow:author", "flow:edit-drawio", "node-<id>"] {
        assert!(kb_draw::visual_guides::DRAWIO.contains(needle), "{needle}");
    }
}

#[tokio::test]
async fn test_an_agent_changes_a_frame_directly_and_a_locked_frame_is_left_alone() {
    // AI v2: no proposals. canvas_update puts the changed files in the frame; what it leaves out stays; a frame a
    // person is editing is refused with their name.
    let s = common::start_with(options(false)).await;
    let (mcp, c) = (s.mcp(), s.client());
    let dir = folder();
    let made_project = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
    let pid = made_project.json()["id"].clone();
    c.post(&format!("/projects/{}/members", pid.as_str().expect("an id")), json!({"name": "An"})).await;
    let ticket =
        call(&mcp, "manage_ticket", json!({"action": "create", "project_id": pid, "title": "Sign-up", "type": "task"}))
            .await;
    let folder_of_frames = dir.path().join("canvas/01-form");
    std::fs::create_dir_all(&folder_of_frames).expect("a folder");
    std::fs::write(folder_of_frames.join("index.html"), FRAME).expect("a file");
    std::fs::write(folder_of_frames.join("style.css"), "h1 { color: green }").expect("a file");
    let made = write(
        &mcp,
        "canvas_create",
        json!({"path": dir.path().join("canvas").to_string_lossy(), "owner_kind": "ticket", "owner_id": ticket["id"], "title": "Sign-up screens"}),
    )
    .await;
    let (cid, bid) = (made["id"].clone(), made["boards"][0]["id"].clone());
    let before = read(
        &mcp,
        "canvas",
        json!({"canvas_id": cid, "board_id": bid, "path": dir.path().join("edit").to_string_lossy()}),
    )
    .await;
    let rev = before["board"]["content_rev"].as_i64().expect("a revision");
    // only the changed file is handed in: the stylesheet stays
    let change = dir.path().join("change");
    std::fs::create_dir(&change).expect("a folder");
    std::fs::write(change.join("index.html"), FRAME.replace("Create your account", "Join")).expect("a file");
    let out = write(
        &mcp,
        "canvas_update",
        json!({"canvas_id": cid, "board_id": bid, "path": change.to_string_lossy(), "note": "Shorter title."}),
    )
    .await;
    assert!(out["board_id"] == bid && out["files"] == json!(["index.html"]));
    assert!(out["content_rev"].as_i64().expect("a revision") > rev && out["note"] == "Shorter title.");
    let after = read(
        &mcp,
        "canvas",
        json!({"canvas_id": cid, "board_id": bid, "path": dir.path().join("after").to_string_lossy()}),
    )
    .await;
    let index = std::fs::read_to_string(dir.path().join("after/index.html")).expect("a file");
    assert!(index.contains("Join") && !index.contains("Create your account"));
    assert_eq!(std::fs::read_to_string(dir.path().join("after/style.css")).expect("a file"), "h1 { color: green }");
    assert_eq!(after["board"]["content_rev"], out["content_rev"]);
    // a person holds the frame: the change is refused and nothing moves
    let lock = c
        .header("x-actor", "An")
        .post_empty(&format!("/canvases/{}/boards/{}/lock", cid.as_str().expect("an id"), bid.as_str().expect("an id")))
        .await;
    lock.assert_status(200);
    std::fs::write(change.join("index.html"), FRAME.replace("Create your account", "Other")).expect("a file");
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "canvas_update", "canvas_id": cid, "board_id": bid, "path": change.to_string_lossy()}),
    )
    .await;
    assert!(refused.contains("An"), "{refused}");
    let still = read(&mcp, "canvas", json!({"canvas_id": cid, "board_id": bid})).await;
    assert_eq!(still["board"]["content_rev"], out["content_rev"]);
    // an empty folder changes nothing
    s.client()
        .header("x-actor", "An")
        .delete(&format!("/canvases/{}/boards/{}/lock", cid.as_str().expect("an id"), bid.as_str().expect("an id")))
        .await;
    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).expect("a folder");
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "canvas_update", "canvas_id": cid, "board_id": bid, "path": empty.to_string_lossy()}),
    )
    .await;
    assert!(refused.contains("no files"), "{refused}");
}
