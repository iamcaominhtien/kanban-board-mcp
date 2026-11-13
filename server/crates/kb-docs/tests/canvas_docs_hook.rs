//! `kb_docs::hooks::register()` and what the canvases do through it (`services/canvases.py` lines 419-477 and
//! 2101-2192): a canvas that is a Docs page is made with `docs.create_page` and published with its embed line, follows
//! the space's edit policy, and keeps the page index in step with its boards. The REST tests need the app to
//! register the hook; this one does it itself, in one process with its own database.

use kb_base::{activity, ctx};
use kb_db::database;
use kb_db::entities::{canvas, docs_page, docs_version, member, project};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use kb_docs::docs_search::{self, SearchParams};
use kb_draw::canvases::docs::create_docs_canvas;
use kb_draw::canvases::rows::{member_role, reindex};
use kb_draw::canvases::{embed_line, read_doc, write_doc};
use serde_json::Value;

#[tokio::test]
#[allow(unsafe_code)]
async fn a_canvas_page_goes_through_the_registered_docs_hook() {
    let dir = tempfile::tempdir().expect("temporary folder");
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("workspace"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("database setup");
    database::init_db().await.expect("schema");
    ctx::scope(scenario()).await;
}

async fn scenario() {
    let session = database::session();
    let mut row = project::new();
    row.name = Set("Canvases".into());
    row.prefix = Set("CNV".into());
    row.color = Set("#123456".into());
    row.docs_edit_policy = Set("admins".into());
    let pid = row.insert(&session).await.expect("project").id;
    let mut person = member::new();
    person.project_id = Set(pid.clone());
    person.name = Set("Vy".into());
    person.color = Set("#3B82F6".into());
    person.role = Set("member".into());
    person.insert(&session).await.expect("member");
    session.commit().await.expect("commit");

    // before the hook is registered a canvas cannot be a Docs page
    let failed = create_docs_canvas(&database::session(), &pid, "Flow", None).await;
    assert!(matches!(&failed, Err(kb_draw::Error::Value(m)) if m == "The Docs area is not available."), "{failed:?}");

    kb_docs::hooks::register();

    // docs.create_page + kind = canvas + docs.publish_page(embed line, note "Canvas")
    let out = create_docs_canvas(&database::session(), &pid, "Flow", None).await.expect("canvas page");
    let page_id = out["page"]["id"].as_str().expect("page id").to_string();
    let canvas_id = out["canvas"]["id"].as_str().expect("canvas id").to_string();
    assert_eq!(out["page"]["kind"], "canvas");
    let s = database::session();
    let page = docs_page::Entity::find_by_id(page_id.as_str()).one(&s).await.expect("page").expect("page row");
    assert_eq!((page.kind.as_str(), page.version, page.status.as_str()), ("canvas", 1, "published"));
    let version = docs_version::Entity::find()
        .filter(docs_version::Column::PageId.eq(page_id.as_str()))
        .one(&s)
        .await
        .expect("version")
        .expect("version row");
    assert_eq!(version.markdown, embed_line(&canvas_id, "Flow", None));
    assert_eq!(version.note.as_deref(), Some("Canvas"));
    let row = canvas::Entity::find_by_id(canvas_id.as_str()).one(&s).await.expect("canvas").expect("canvas row");
    assert_eq!(row.page_id.as_deref(), Some(page_id.as_str()));

    // the canvas follows the space's edit policy: admins only. Vy is a member, the board's user an admin.
    let as_vy = activity::set_actor(Some("Vy"));
    let denied = member_role(&database::session(), &row).await;
    match denied {
        Err(kb_draw::Error::Docs(e)) => assert_eq!((e.status, e.code.as_str()), (403, "read_only")),
        other => panic!("{other:?}"),
    }
    ctx::reset(as_vy);
    assert_eq!(member_role(&database::session(), &row).await.expect("admin edits"), "admin");

    // boards are sections of the page: after the file changes, `reindex` (through the hook) puts them in the index
    let mut doc = read_doc(&canvas_id).expect("canvas file");
    let boards = doc.get_mut("boards").and_then(Value::as_array_mut).expect("boards");
    boards[0]["name"] = Value::String("Zebra crossing".into());
    write_doc(&canvas_id, &doc).expect("write");
    reindex(&database::session(), &row).await.expect("reindex");
    let found =
        docs_search::search(&database::session(), &pid, "zebra", &SearchParams::default()).await.expect("search");
    let ids: Vec<&str> =
        found["pages"].as_array().expect("pages").iter().filter_map(|p| p["page_id"].as_str()).collect();
    assert_eq!(ids, [page_id.as_str()]);
}
