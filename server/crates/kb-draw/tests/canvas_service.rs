//! The tests of `tests/test_canvases.py` that call service functions directly: they run in-process, in the Rust modules.

mod common;

use kb_draw::canvases;

#[test]
fn test_refs_in_reads_both_forms_and_one_board_or_page() {
    let text = "![Login](canvas:cv_8f3a1c2d)\n![Wrong](canvas:cv_8f3a1c2d#b_0a1b2c3d)\n\
                see [Other](canvas:cv_11112222) and ![x](sketch:sk_8f2a1c3d)";
    assert_eq!(canvases::refs_in(text), vec!["cv_8f3a1c2d", "cv_11112222"]);
}

#[test]
fn test_an_id_that_becomes_a_folder_name_must_have_the_shape_the_server_makes() {
    common::service::run(async {
        for bad in ["..", "../x", "b_../..", "cv_12345678/../x", "", "B_0A1B2C3D"] {
            let err = canvases::board_dir("cv_12345678", bad, 1).expect_err(bad);
            assert!(
                matches!(err, kb_draw::Error::Docs(ref e) if e.status == 404 && e.code == "board_not_found"),
                "{bad}"
            );
        }
        let err = canvases::canvas_dir("../../etc").expect_err("a path is not a canvas id");
        assert!(matches!(err, kb_draw::Error::Docs(ref e) if e.status == 404 && e.code == "canvas_not_found"));
        let dir = canvases::board_dir("cv_12345678", "b_0a1b2c3d", 3).expect("a well-formed id");
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("r3"));
    });
}

#[test]
fn test_a_new_canvas_keeps_its_name_as_typed_and_the_markdown_drops_the_brackets() {
    assert_eq!(canvases::canvas_name(Some("  \n "), "Canvas"), "Canvas");
    assert_eq!(canvases::canvas_name(Some("[docs]  Login canvas"), "Canvas"), "[docs] Login canvas");
    assert_eq!(
        canvases::embed_line("cv_8f3a1c2d", "[docs] Login canvas", None),
        "![docs  Login canvas](canvas:cv_8f3a1c2d)"
    );
}

#[test]
fn test_two_writes_at_once_never_share_a_revision_in_process() {
    // the per-canvas lock of `serial`: a second writer waits for the first
    common::service::run(async {
        let first = canvases::serial("cv_aaaaaaaa").await;
        let waiting = tokio::time::timeout(std::time::Duration::from_millis(50), canvases::serial("cv_aaaaaaaa")).await;
        assert!(waiting.is_err(), "the second write must wait");
        let other = tokio::time::timeout(std::time::Duration::from_millis(50), canvases::serial("cv_bbbbbbbb")).await;
        assert!(other.is_ok(), "another canvas is not held up");
        drop(first);
        let after = tokio::time::timeout(std::time::Duration::from_millis(500), canvases::serial("cv_aaaaaaaa")).await;
        assert!(after.is_ok());
    });
}
