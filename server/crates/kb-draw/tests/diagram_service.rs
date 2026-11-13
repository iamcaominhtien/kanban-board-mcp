//! The service functions of `diagrams` and `sketches` that no HTTP route of this crate reaches: the version pins the
//! Docs pages keep (`test_docs_versions_pin_diagrams_and_restore_brings_them_back` of `test_diagrams.py`, whose Docs
//! routes are not served by Rust yet) and the file functions of the sketch tools. On a database of their own.

mod common;

use common::service::{project, run};
use common::{EMPTY, SOURCE, SVG, png};
use kb_db::entities::docs_page;
use kb_db::sea_orm::ActiveModelTrait;
use kb_db::sea_orm::ActiveValue::Set;
use kb_draw::diagrams::{self, DiagramChange, NewDiagram};
use kb_draw::{Error, sketches};
use serde_json::{Value, json};

async fn new_diagram(pid: &str, source: &str) -> String {
    let session = kb_db::session();
    let out = diagrams::create_diagram(
        &session,
        pid,
        NewDiagram {
            label: Some("Auth flow".into()),
            source: source.into(),
            svg: SVG.into(),
            preview_kind: "editor".into(),
            ..Default::default()
        },
    )
    .await
    .expect("create");
    out["id"].as_str().expect("id").to_string()
}

#[test]
fn test_docs_versions_pin_diagrams_and_restore_brings_them_back() {
    run(async {
        let pid = project("pins", "PIN").await;
        let id = new_diagram(&pid, SOURCE).await;
        let session = kb_db::session();
        let markdown = format!("# API\n\n[Auth flow](diagram:{id})\n");
        // a page published with the diagram pins its version
        let pins = diagrams::pin_versions(&session, &markdown).await.expect("pins");
        assert_eq!(pins, format!("{{\"{id}\": 1}}"));
        assert_eq!(diagrams::parse_pins(Some(&pins)).get(&id), Some(&json!(1)));

        let change = DiagramChange {
            base_version: 1,
            source: EMPTY.into(),
            svg: SVG.into(),
            label: Some("Auth v2".into()),
            preview_kind: "editor".into(),
            ..Default::default()
        };
        diagrams::update_diagram(&session, &id, change).await.expect("update");
        assert_eq!(diagrams::pin_versions(&session, &markdown).await.expect("pins"), format!("{{\"{id}\": 2}}"));
        // an older version still shows the diagram version it used
        let old = diagrams::get_diagram(&session, &id, Some(1), true).await.expect("get");
        assert_eq!(old["source"], SOURCE);

        // unlinking the diagram, then restoring a page that pinned version 1, links it again at that content
        diagrams::delete_diagram(&session, &id).await.expect("delete");
        assert_eq!(diagrams::pin_versions(&session, &markdown).await.expect("pins"), "{}");
        let pinned = diagrams::parse_pins(Some(&pins));
        diagrams::restore_pins(&session, &pinned).await.expect("restore pins");
        session.commit().await.expect("commit");
        let now = diagrams::get_diagram(&session, &id, None, true).await.expect("get");
        assert_eq!((now["source"].clone(), now["version"].clone()), (json!(SOURCE), json!(3)));
        let versions = diagrams::list_versions(&session, &id).await.expect("versions");
        assert_eq!(versions[0]["note"], "Restored from v1");
        assert_eq!(diagrams::pin_versions(&session, &markdown).await.expect("pins"), format!("{{\"{id}\": 3}}"));

        // a pin at the current version only links the diagram again; one that does not exist is skipped
        diagrams::delete_diagram(&session, &id).await.expect("delete");
        let mut again = serde_json::Map::new();
        again.insert(id.clone(), json!(3));
        again.insert("dg_00000000".into(), json!(1));
        diagrams::restore_pins(&session, &again).await.expect("restore pins");
        session.commit().await.expect("commit");
        let now = diagrams::get_diagram(&session, &id, None, false).await.expect("get");
        assert_eq!(now["version"], 3);
        assert_eq!(now["deleted_at"], Value::Null);
        // a pin to a version that is gone changes nothing but the link
        let mut gone = serde_json::Map::new();
        gone.insert(id.clone(), json!(9));
        diagrams::restore_pins(&session, &gone).await.expect("restore pins");
        session.commit().await.expect("commit");
        assert_eq!(diagrams::get_diagram(&session, &id, None, false).await.expect("get")["version"], 3);
    });
}

#[test]
fn pins_are_read_leniently() {
    let got = diagrams::parse_pins(Some("{\"a\": 1, \"b\": \"2\", \"c\": true, \"d\": 1.5, \"e\": null}"));
    assert_eq!(Value::Object(got), json!({"a": 1, "c": true}));
    assert!(diagrams::parse_pins(None).is_empty());
    assert!(diagrams::parse_pins(Some("")).is_empty());
    assert!(diagrams::parse_pins(Some("[1]")).is_empty());
    assert!(diagrams::parse_pins(Some("nope")).is_empty());
}

fn doc_page(project_id: &str, slug: &str) -> docs_page::ActiveModel {
    let mut row = docs_page::new();
    row.project_id = Set(project_id.into());
    row.title = Set("Page".into());
    row.slug = Set(slug.into());
    row
}

#[test]
fn the_file_functions_of_the_sketch_tools() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let picture = tmp.path().join("shot.png");
    std::fs::write(&picture, png(30, 20, 0)).expect("png");
    let second = tmp.path().join("second.png");
    std::fs::write(&second, png(10, 10, 0)).expect("png");
    run(async {
        let pid = project("sketch files", "SKF").await;
        let session = kb_db::session();
        let page = doc_page(&pid, "page").insert(&session).await.expect("page");
        session.commit().await.expect("commit");
        let path = picture.to_string_lossy().into_owned();

        // a picture alone becomes one picture layer on a white page (three layers: page, picture, marks)
        let made = sketches::create_from_files(&session, "doc", &page.id, "Shot", &path, None).await.expect("create");
        let id = made["id"].as_str().expect("id").to_string();
        assert_eq!(
            (made["width"].clone(), made["height"].clone(), made["layer_count"].clone()),
            (json!(30), json!(20), json!(3))
        );
        assert_eq!(made["project_id"], json!(pid));
        let stored = std::fs::read(sketches::source_path(&id)).expect("source file");
        let doc: Value = serde_json::from_slice(&stored).expect("json");
        assert_eq!(doc["activeLayer"], "l3");
        assert!(doc["layers"][1]["png"].as_str().expect("data url").len() > 30);
        assert_eq!(stored, sketches::flat_source(&png(30, 20, 0)).expect("flat source"));

        let listed = sketches::list_for_agent(&session, &pid).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["markdown"], json!(format!("![Shot](sketch:{id})")));
        assert_eq!(listed[0]["layers"], 3);

        // exported to a folder, then to a named picture
        let out = format!("{}/", tmp.path().join("out").display());
        let got = sketches::export_to_files(&session, &id, &out).await.expect("export");
        assert!(got["png_path"].as_str().expect("png").ends_with("/out/Shot.png"));
        assert!(got["source_path"].as_str().expect("source").ends_with("/out/Shot.sketch.json"));
        assert_eq!(std::fs::read(tmp.path().join("out/Shot.png")).expect("png"), png(30, 20, 0));
        assert_eq!(std::fs::read(tmp.path().join("out/Shot.sketch.json")).expect("source"), stored);
        let named = tmp.path().join("named.PNG");
        let got = sketches::export_to_files(&session, &id, &named.to_string_lossy()).await.expect("export");
        assert!(got["source_path"].as_str().expect("source").ends_with("/named.sketch.json"));
        assert_eq!(got["markdown"], json!(format!("![Shot](sketch:{id})")));

        // saved as a new version; a stale one is refused before its files are read
        let saved = sketches::save_from_files(&session, &id, &second.to_string_lossy(), 1, None, Some("Shot 2"))
            .await
            .expect("save");
        assert_eq!(
            (saved["version"].clone(), saved["title"].clone(), saved["width"].clone()),
            (json!(2), json!("Shot 2"), json!(10))
        );
        match sketches::save_from_files(&session, &id, "/no/such/file.png", 1, None, None).await {
            Err(Error::Docs(e)) => assert_eq!((e.status, e.code.as_str()), (409, "sketch_conflict")),
            other => panic!("expected the conflict, got {other:?}"),
        }

        // the errors, in the words of the Python code
        let err = |r: Result<_, Error>| match r {
            Err(Error::Docs(e)) => (e.status, e.code, e.message),
            other => panic!("expected a DocsError, got {other:?}"),
        };
        let r: Result<serde_json::Map<String, Value>, Error> =
            sketches::create_from_files(&session, "idea", &page.id, "x", &path, None).await;
        assert_eq!(err(r), (422, "invalid_owner".into(), "owner_kind must be 'ticket' or 'doc'.".into()));
        let r = sketches::create_from_files(&session, "doc", "nope", "x", &path, None).await;
        assert_eq!(err(r), (404, "owner_not_found".into(), "No Docs page with id 'nope'.".into()));
        let r = sketches::create_from_files(&session, "ticket", "nope", "x", &path, None).await;
        assert_eq!(err(r), (404, "owner_not_found".into(), "No ticket with id 'nope'.".into()));
        let r = sketches::create_from_files(&session, "doc", &page.id, "x", "rel.png", None).await;
        assert_eq!(
            err(r),
            (422, "invalid_file".into(), "Give an absolute path for the picture (got 'rel.png').".into())
        );
        let r = sketches::create_from_files(&session, "doc", &page.id, "x", "/no/such.png", None).await;
        assert_eq!(err(r), (422, "invalid_file".into(), "The picture is not a file: /no/such.png.".into()));
        let r = sketches::create_from_files(&session, "doc", &page.id, "x", &path, Some("/no/such.json")).await;
        assert_eq!(err(r), (422, "invalid_file".into(), "The source is not a file: /no/such.json.".into()));
        let r = sketches::export_to_files(&session, "sk_00000000", &out).await;
        assert_eq!(err(r).1, "sketch_not_found");
    });
}

#[test]
fn the_editor_settings_follow_the_python_rules() {
    run(async {
        let session = kb_db::session();
        // not an admin of any project, not the board's own user: refused (the actor is the default one here, so the
        // admin path is the one covered over HTTP; this checks what a plain call does with a bad address)
        let r = diagrams::set_settings(&session, "self-hosted", Some("ftp://x"), None).await;
        match r {
            Err(Error::Docs(e)) => assert_eq!((e.status, e.code.as_str()), (422, "invalid_url")),
            other => panic!("{other:?}"),
        }
        let out =
            diagrams::set_settings(&session, "self-hosted", Some(" http://draw.local:8080/ "), Some("http://board:1"))
                .await
                .expect("set");
        assert_eq!(out["url"], "http://draw.local:8080/");
        assert_eq!(out["effective_url"], "http://draw.local:8080");
        let out = diagrams::set_settings(&session, "self-hosted", None, None).await.expect("set");
        assert_eq!(
            (out["mode"].clone(), out["effective_url"].clone()),
            (json!("self-hosted"), json!("http://localhost:8080"))
        );
    });
}
