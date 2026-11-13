//! `tests/test_visual_tools_267.py`: Canvas, draw.io and Sketch for any AI (issue #267): the guides reach internal runs
//! as skills and outside agents through docs_read with the same text, a diagram reads as a model, and an agent can see
//! a PNG of what it drew.
//!
//! The tests that call the services in-process are ported here as in-process tests of the Rust modules (`visual_guides`,
//! `screenshots`, `diagram_model`), with the Python assertions. The parts that go through the MCP tools (`docs_read`,
//! `docs_write`), the AI team's skills or the run guard wait for the MCP / AI ports and are left out:
//!
//! * `test_the_diagram_and_sketch_guides_are_skills_and_the_same_text_through_docs_read`: the guide's needles run here;
//!   the skill files of the board's plugin (`board_skills`) wait for the skills port.
//! * `test_the_instructions_say_which_tool_and_where_the_guides_are` (MCP instructions),
//!   `test_each_role_that_draws_is_pointed_at_the_right_tool` (`ai.packs`).
//! * `test_a_diagram_reads_as_a_model_without_a_file`, `test_a_save_says_what_will_look_broken`,
//!   `test_a_compressed_page_is_written_out_as_plain_xml_and_a_bare_name_is_a_folder` (`docs_read` / `docs_write`
//!   diagram actions; the model, the problems and the plain XML are checked in `diagram_model_golden.rs`).
//! * `test_without_a_browser_a_picture_is_a_wireframe_and_says_so`,
//!   `test_a_picture_call_that_names_nothing_or_two_things_says_what_to_give`,
//!   `test_an_ai_run_looks_only_at_files_in_its_own_folder`, `test_an_ai_run_writes_a_picture_only_in_its_own_folder`
//!   (`docs_read(picture)` and `ai.guard`).
//! * `test_an_agent_changes_a_frame_directly_and_a_locked_frame_is_left_alone` (`docs_write(canvas_update)`).
//! * `test_flow_is_suggested_and_the_draw_io_guide_says_how_its_files_reach_the_board`: the guide's needles run here;
//!   the plugin catalogue (`ai.plugins`) waits for the AI port.
//!
//! The browser tests find Chrome as `find_chrome` does (`KANBAN_CHROME_PATH`, the usual names, then the Playwright
//! folder `/opt/pw-browsers/`) and print `SKIPPED` when there is none.

mod common;

use std::io::Read;
use std::path::PathBuf;

use kb_draw::{canvas_design, diagram_model, screenshots, visual_guides};

const FLOW: &str = r#"<mxfile><diagram name="Sign-up"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="form" value="Fill in the form" style="rounded=1;html=1;" vertex="1" parent="1">
<mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="valid" value="Email valid?" style="rhombus;html=1;" vertex="1" parent="1">
<mxGeometry x="60" y="180" width="120" height="80" as="geometry"/></mxCell>
<mxCell id="lane" value="Server" style="swimlane;html=1;" vertex="1" parent="1">
<mxGeometry x="300" y="0" width="300" height="300" as="geometry"/></mxCell>
<mxCell id="send" value="Send the email" style="rounded=1;html=1;" vertex="1" parent="lane">
<mxGeometry x="40" y="60" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" source="form" target="valid" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" value="yes" edge="1" source="valid" target="send" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>"#;

const FRAME: &str = "<!doctype html><meta name='viewport' content='width=device-width'><h1>Create your account</h1><button>Create</button>";

/// Chrome for the tests: `find_chrome`, else the Playwright folder of the container.
fn chrome_for_tests() -> Option<String> {
    if let Some(found) = screenshots::available().and_then(|_| kb_draw::chrome::find_chrome()) {
        return Some(found);
    }
    let base = PathBuf::from("/opt/pw-browsers");
    for entry in std::fs::read_dir(&base).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("chromium") {
            continue;
        }
        for rel in ["chrome-linux64/chrome", "chrome-linux/chrome"] {
            let candidate = entry.path().join(rel);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[allow(unsafe_code)]
fn use_chrome(path: &str) {
    // the browser tests of this binary all set the same value, before they start a browser
    unsafe {
        std::env::set_var(kb_draw::chrome::CHROME_ENV, path);
        std::env::remove_var(kb_draw::chrome::EXPORT_CMD_ENV);
    }
}

// --- the guides ------------------------------------------------------------------------------------------------

#[test]
fn test_the_diagram_and_sketch_guides_are_skills_and_the_same_text_through_docs_read() {
    // docs_read(action="diagram_guide") is this
    let guide = visual_guides::diagram_guide();
    let (drawio, sketches) = (guide["guide"].as_str().expect("guide"), guide["sketches"].as_str().expect("sketches"));
    assert_eq!(drawio, visual_guides::DRAWIO);
    assert_eq!(sketches, visual_guides::SKETCH);
    // the skill files are the header + the text (the skills port compares them with the board's plugin folder)
    assert!(visual_guides::DRAWIO_HEADER.starts_with("---\nname: drawio-diagrams\n"));
    assert!(visual_guides::SKETCH_HEADER.starts_with("---\nname: sketches\n"));
    assert!(canvas_design::SKILL_HEADER.starts_with("---\nname: canvas-design\n"));
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
        assert!(drawio.contains(needle), "{needle}");
    }
    // the Sketch decision is written down, with its reason
    assert!(sketches.contains("You read Sketches; you do not draw them"));
    assert!(sketches.contains("fake hand-drawn look"));
}

#[test]
fn test_flow_is_suggested_and_the_draw_io_guide_says_how_its_files_reach_the_board() {
    // the plugin catalogue (`ai.plugins.CATALOGUE`) is part of the AI port; the guide's half runs here
    for needle in ["**With Flow.**", "flow.py build", "flow:author", "flow:edit-drawio", "node-<id>"] {
        assert!(visual_guides::DRAWIO.contains(needle), "{needle}");
    }
}

// --- looking at what you drew ----------------------------------------------------------------------------------

#[test]
fn test_the_hidden_browser_loads_only_the_page_and_public_hosts() {
    let origin = "http://127.0.0.1:5123";
    assert!(screenshots::allowed(&format!("{origin}/tokens.css"), origin));
    assert!(screenshots::allowed("https://fonts.googleapis.com/css2", origin));
    assert!(screenshots::allowed("data:image/png;base64,AA", origin));
    for bad in [
        "file:///etc/passwd",
        "http://127.0.0.1:8010/api/projects",
        "http://localhost:3000/",
        "http://192.168.1.10/",
        "http://[::1]:8010/",
        "http://nas.local/",
    ] {
        assert!(!screenshots::allowed(bad, origin), "{bad}");
    }
}

fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    (
        u32::from_be_bytes(png[16..20].try_into().expect("width")),
        u32::from_be_bytes(png[20..24].try_into().expect("height")),
    )
}

#[tokio::test]
async fn test_with_a_browser_a_frame_and_a_diagram_are_drawn_for_real() {
    let Some(chrome) = chrome_for_tests() else {
        eprintln!("SKIPPED test_with_a_browser_a_frame_and_a_diagram_are_drawn_for_real: no Chrome or Chromium here");
        return;
    };
    use_chrome(&chrome);
    // a frame at the phone width the agent asked for
    let folder = tempfile::tempdir().expect("temporary folder");
    std::fs::write(folder.path().join("index.html"), FRAME).expect("frame");
    let shot = screenshots::page_png(folder.path(), "index.html", 390, None).await.expect("a picture of the frame");
    assert_eq!(png_size(&shot).0, 390);
    // a diagram, drawn from its own SVG
    let svg = diagram_model::render_svg(FLOW).expect("svg");
    let (w, h) = screenshots::svg_size(&svg);
    let drawn = screenshots::svg_png(&svg, None).await.expect("a picture of the diagram");
    assert_eq!(png_size(&drawn), (w as u32, h as u32));
    assert!(png_size(&drawn).0 > 300);
    assert_eq!(diagram_model::model(FLOW, 300).expect("model")["problems"], serde_json::json!([]));
}

/// One pixel of an 8-bit RGB or RGBA PNG (enough to tell where a shape was drawn).
fn pixel(png: &[u8], x: usize, y: usize) -> Vec<u8> {
    let w = u32::from_be_bytes(png[16..20].try_into().expect("width")) as usize;
    let bpp = match png[25] {
        2 => 3,
        6 => 4,
        other => panic!("colour type {other}"),
    };
    let (mut data, mut i) = (Vec::new(), 8);
    while i < png.len() {
        let n = u32::from_be_bytes(png[i..i + 4].try_into().expect("length")) as usize;
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
                        (i32::from(b) - i32::from(c)).abs(),
                        (i32::from(a) - i32::from(c)).abs(),
                        (i32::from(a) + i32::from(b) - 2 * i32::from(c)).abs(),
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

const NARROW: &str = r##"<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="" style="rounded=0;html=1;fillColor=#ff0000;strokeColor=#ff0000;" vertex="1" parent="1">
<mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="b" value="" style="rounded=0;html=1;" vertex="1" parent="1">
<mxGeometry x="40" y="200" width="160" height="60" as="geometry"/></mxCell>
</root></mxGraphModel>"##;

#[tokio::test]
async fn test_a_narrow_diagram_is_drawn_at_its_own_size_not_as_a_zoomed_phone_page() {
    // a live Dev run looked at a 480 px wide diagram and saw only its top left corner, twice as large (#267)
    let Some(chrome) = chrome_for_tests() else {
        eprintln!(
            "SKIPPED test_a_narrow_diagram_is_drawn_at_its_own_size_not_as_a_zoomed_phone_page: no Chrome or Chromium here"
        );
        return;
    };
    use_chrome(&chrome);
    let svg = diagram_model::render_svg(NARROW).expect("svg");
    let png = screenshots::svg_png(&svg, None).await.expect("a picture");
    let (w, h) = screenshots::svg_size(&svg);
    assert_eq!(png_size(&png), (w as u32, h as u32));
    // inside the red box (it starts at 20, 20 in the picture)
    let red = pixel(&png, 100, 50);
    assert!(red[0] > 200 && red[1] < 80, "{red:?}");
    // between the two boxes: white at scale 1, red when the page was zoomed
    assert!(pixel(&png, 190, 150).iter().min().copied().unwrap_or(0) > 220);
}

#[test]
fn test_the_plain_preview_draws_a_links_bends_and_orthogonal_elbows() {
    let looped = FLOW.replace(
        r#"<mxCell id="e1" edge="1" source="form" target="valid" parent="1"><mxGeometry relative="1" as="geometry"/>"#,
        concat!(
            r#"<mxCell id="e1" edge="1" source="valid" target="form" parent="1" style="edgeStyle=orthogonalEdgeStyle;">"#,
            r#"<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="260" y="220"/>"#,
            r#"<mxPoint x="260" y="70"/></Array></mxGeometry>"#
        ),
    );
    assert_ne!(looped, FLOW);
    let svg = diagram_model::render_svg(&looped).expect("svg");
    let first: Vec<&str> = svg
        .split("<polyline points=\"")
        .nth(1)
        .expect("a link")
        .split('"')
        .next()
        .expect("points")
        .split(' ')
        .collect();
    // out of the decision, around through x = 260 (240 in the picture, whose left edge is page x 20), into the form
    assert!(first.len() >= 4);
    let mut xs: Vec<i64> = first[1..first.len() - 1]
        .iter()
        .map(|p| p.split(',').next().expect("x").parse::<f64>().expect("number").round_ties_even() as i64)
        .collect();
    xs.sort_unstable();
    xs.dedup();
    assert_eq!(xs, vec![240]);
    // an orthogonal link without bends is an elbow between facing sides, not a diagonal
    let elbow =
        FLOW.replace(r#"value="yes" edge="1""#, r#"value="yes" style="edgeStyle=orthogonalEdgeStyle;" edge="1""#);
    let svg = diagram_model::render_svg(&elbow).expect("svg");
    let points = svg.split("<polyline points=\"").nth(2).expect("the second link");
    let pts: Vec<(f64, f64)> = points
        .split('"')
        .next()
        .expect("points")
        .split(' ')
        .map(|p| {
            let (x, y) = p.split_once(',').expect("a point");
            (x.parse().expect("x"), y.parse().expect("y"))
        })
        .collect();
    assert!(pts.windows(2).all(|w| w[0].0 == w[1].0 || w[0].1 == w[1].1), "{pts:?}");
}

fn cells(boxes: &[(&str, i64, i64, i64, i64)]) -> String {
    let cells: String = boxes
        .iter()
        .map(|(i, x, y, w, h)| {
            format!(
                "<mxCell id=\"{i}\" value=\"{i}\" style=\"rounded=1;\" vertex=\"1\" parent=\"1\">\
                 <mxGeometry x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" as=\"geometry\"/></mxCell>"
            )
        })
        .collect();
    format!(
        "<mxfile><diagram name=\"P\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>{cells}</root></mxGraphModel></diagram></mxfile>"
    )
}

fn problems(source: &str) -> Vec<String> {
    diagram_model::problems(&diagram_model::Drawing::new(source).expect("a drawing")).expect("problems")
}

#[test]
fn test_a_chip_a_tab_or_a_frame_behind_steps_is_not_taken_for_an_overlap() {
    // as Flow draws them: a number chip on a step's corner, a lane frame behind its steps with its name tab, an icon
    // on a disc; only two shapes of about the same size that partly cover each other look broken
    let drawn = cells(&[
        ("node-load", 284, 164, 140, 100),
        ("badge-load", 278, 154, 22, 20),
        ("frame-lane", 0, 0, 900, 300),
        ("tab-lane", 0, 0, 120, 300),
        ("disc", 500, 120, 56, 56),
        ("icon", 512, 132, 32, 32),
        ("node-next", 600, 164, 140, 100),
    ]);
    assert_eq!(problems(&drawn), Vec::<String>::new());
    let clash = cells(&[("a", 0, 0, 140, 100), ("b", 60, 40, 140, 100)]);
    assert_eq!(problems(&clash), vec!["Shapes 'a' and 'b' overlap: move one so they are at least 40 px apart."]);
    let same = cells(&[("a", 0, 0, 140, 100), ("b", 0, 0, 140, 100)]);
    assert_eq!(problems(&same).len(), 1);
}
