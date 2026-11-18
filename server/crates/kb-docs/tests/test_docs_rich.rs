//! Rich Docs (format 1) through the HTTP API: pages as rich JSON with block ids, the conversion of Markdown pages,
//! page and project settings, templates, public links, highlights and AI suggestions.

mod common;

use common::{exec, id, member, pid, scalar};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

fn as_(c: &Client, name: &str) -> Client {
    c.clone().header("x-actor", name)
}

fn doc(blocks: Value) -> Value {
    json!({"type": "doc", "content": blocks})
}

fn para(id: &str, text: &str) -> Value {
    json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [{"type": "text", "text": text}]})
}

/// A page published once from rich content: (pid, page id).
async fn rich_page(c: &Client, content: Value) -> (String, String) {
    let pid = pid(c).await;
    let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "Rich"})).await.json();
    let page_id = id(&page);
    let r = c.put(&format!("/docs/pages/{page_id}/draft"), json!({"content": content})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    let r = c.post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": 0})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    (pid, page_id)
}

#[tokio::test]
async fn a_rich_page_keeps_its_ids_and_attributes_and_projects_markdown() {
    if !skip_unless_available("a_rich_page_keeps_its_ids_and_attributes_and_projects_markdown") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let mut centred = para("b-00000a", "Centred");
    centred["attrs"]["textAlign"] = json!("center");
    let (_, page_id) = rich_page(&c, doc(json!([centred, para("b-00000b", "Second [[Other]] line")]))).await;
    let page = c.get(&format!("/docs/pages/{page_id}")).await.json();
    assert_eq!(page["format"], "rich");
    assert_eq!(page["version"], 1);
    assert_eq!(page["content"]["content"][0]["attrs"]["blockId"], "b-00000a");
    assert_eq!(page["content"]["content"][0]["attrs"]["textAlign"], "center");
    assert!(page["markdown"].as_str().unwrap().contains("Centred"));
    assert_eq!(page["settings"], json!({}));
    // a block without an id gets one
    let r = c
        .put(
            &format!("/docs/pages/{page_id}/draft"),
            json!({"content": doc(json!([{"type": "paragraph", "content": [{"type": "text", "text": "x"}]}]))}),
        )
        .await
        .json();
    let new_id = r["draft"]["content"]["content"][0]["attrs"]["blockId"].as_str().unwrap().to_string();
    assert!(new_id.starts_with("b-") && new_id.len() == 8, "{new_id}");
    // something that is not a page is refused
    let r = c
        .put(
            &format!("/docs/pages/{page_id}/draft"),
            json!({"content": {"type": "doc", "content": [{"type": "nope"}]}}),
        )
        .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json()["detail"]["code"], "invalid_content");
    // old clients still send Markdown, which becomes a rich page
    let r = c.put(&format!("/docs/pages/{page_id}/draft"), json!({"markdown": "## Hi\n\nText\n"})).await.json();
    assert_eq!(r["draft"]["format"], "rich");
    assert_eq!(r["draft"]["content"]["content"][0]["type"], "heading");
}

#[tokio::test]
async fn markdown_pages_are_converted_with_a_version_of_their_own() {
    if !skip_unless_available("markdown_pages_are_converted_with_a_version_of_their_own") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "Old"})).await.json();
    let page_id = id(&page);
    // a page as an older app left it: one Markdown version, a Markdown draft
    let now = "2026-01-01T00:00:00+00:00";
    exec(&s, "DELETE FROM docs_draft WHERE page_id = ?", &[json!(page_id)]).await;
    exec(
        &s,
        "INSERT INTO docs_version (id, page_id, version, title, markdown, author, created_at, diagram_versions, with_ai, format) \
         VALUES ('v1', ?, 1, 'Old', ?, 'user', ?, '{}', 0, 'md')",
        &[json!(page_id), json!("## Plan\n\nSee [[Other]] and KAN-1.\n"), json!(now)],
    )
    .await;
    exec(&s, "UPDATE docs_page SET version = 1, status = 'published' WHERE id = ?", &[json!(page_id)]).await;
    let before = c.get(&format!("/docs/pages/{page_id}")).await.json();
    assert_eq!(before["format"], "md");
    // the conversion runs at start and every few minutes; this runs it now
    let r = c.post("/docs/convert", json!({})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    let page = c.get(&format!("/docs/pages/{page_id}")).await.json();
    assert_eq!(page["convert_state"], "done", "{page:?}");
    assert_eq!(page["format"], "rich");
    assert_eq!(page["version"], 2);
    let versions = c.get(&format!("/docs/pages/{page_id}/versions")).await.json();
    assert_eq!(versions[0]["note"], "Converted from Markdown");
    assert_eq!(versions[0]["author"], "Kanban Board");
    let old = c.get(&format!("/docs/pages/{page_id}/versions/1")).await.json();
    assert_eq!(old["format"], "md");
    assert_eq!(old["content"], Value::Null);
    let links: i64 = scalar(&s, "SELECT COUNT(*) FROM docs_link WHERE source_page_id = ?", &[json!(page_id)])
        .await
        .as_i64()
        .unwrap();
    assert!(links >= 1);
}

#[tokio::test]
async fn page_and_project_settings() {
    if !skip_unless_available("page_and_project_settings") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, page_id) = rich_page(&c, doc(json!([para("b-000001", "x")]))).await;
    let r = c
        .patch(
            &format!("/docs/pages/{page_id}/settings"),
            json!({"settings": {"width": "wide", "background": "sepia"}}),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["settings"], json!({"width": "wide", "background": "sepia"}));
    let r = c.patch(&format!("/docs/pages/{page_id}/settings"), json!({"settings": {"width": null}})).await.json();
    assert_eq!(r["settings"], json!({"background": "sepia"}));
    let r = c.patch(&format!("/docs/pages/{page_id}/settings"), json!({"settings": {"width": "huge"}})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json()["detail"]["code"], "invalid_settings");

    let space = c.get(&format!("/projects/{pid}/docs/settings")).await.json();
    assert_eq!(space["highlights"], "on");
    member(&c, &pid, "Mia", "member").await;
    let r = as_(&c, "Mia")
        .patch(&format!("/projects/{pid}/docs/settings"), json!({"settings": {"highlights": "off"}}))
        .await;
    assert_eq!(r.status, 403);
    let r =
        c.patch(&format!("/projects/{pid}/docs/settings"), json!({"settings": {"newPage": {"width": "narrow"}}})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    assert_eq!(r.json()["newPage"]["width"], "narrow");
    assert_eq!(r.json()["newPage"]["background"], "white");
    // a new page starts with the project's style
    let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "Styled"})).await.json();
    assert_eq!(page["settings"], json!({"width": "narrow"}));
}

#[tokio::test]
async fn templates_are_saved_listed_and_used() {
    if !skip_unless_available("templates_are_saved_listed_and_used") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let mut h = json!({"type": "heading", "attrs": {"blockId": "b-000001", "level": 2}, "content": [{"type": "text", "text": "Goal"}]});
    h["attrs"]["level"] = json!(2);
    let (pid, page_id) = rich_page(&c, doc(json!([h, para("b-000002", "Secret words")]))).await;
    c.patch(&format!("/docs/pages/{page_id}/settings"), json!({"settings": {"bodyFont": "lora"}})).await;
    let gallery = c.get(&format!("/projects/{pid}/docs/gallery")).await.json();
    let ids: Vec<&str> = gallery["builtin"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"blog-post") && ids.contains(&"requirements"), "{ids:?}");
    let r = c
        .post(
            &format!("/projects/{pid}/docs/gallery"),
            json!({"page_id": page_id, "name": "Plan", "keeps": "structure"}),
        )
        .await;
    assert_eq!(r.status, 201, "{:?}", r.json());
    let tpl = r.json();
    let r = c.post(&format!("/projects/{pid}/docs/gallery"), json!({"page_id": page_id, "name": "Plan"})).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.json()["detail"]["code"], "name_taken");
    let page = c
        .post(&format!("/projects/{pid}/docs/pages/from-template"), json!({"title": "From it", "template": tpl["id"]}))
        .await
        .json();
    let text = page["draft"]["markdown"].as_str().unwrap();
    assert!(text.contains("Goal") && !text.contains("Secret"), "{text}");
    assert_eq!(page["settings"]["bodyFont"], "lora");
    let page = c
        .post(
            &format!("/projects/{pid}/docs/pages/from-template"),
            json!({"title": "Chapter", "template": "book-chapter"}),
        )
        .await
        .json();
    assert_eq!(page["draft"]["content"]["content"][0]["attrs"]["dropCap"], 3);
    let page = c
        .post(&format!("/projects/{pid}/docs/pages/from-template"), json!({"title": "Post", "template": "blog-post"}))
        .await
        .json();
    // a blog post opens with a large first letter, after its first heading
    assert_eq!(page["draft"]["content"]["content"][1]["attrs"]["dropCap"], 3);
    let r = c.delete(&format!("/docs/templates/{}", tpl["id"].as_str().unwrap())).await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn public_links_show_the_published_page_and_stop_when_off() {
    if !skip_unless_available("public_links_show_the_published_page_and_stop_when_off") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, page_id) = rich_page(&c, doc(json!([para("b-000001", "Hello world")]))).await;
    let r = c.put(&format!("/docs/pages/{page_id}/public-link"), json!({"on": true})).await.json();
    let token = r["link"]["token"].as_str().unwrap().to_string();
    let public = c.get(&format!("/docs/public/{token}")).await;
    assert_eq!(public.status, 200);
    assert_eq!(public.json()["content"]["content"][0]["content"][0]["text"], "Hello world");
    assert_eq!(public.json()["author"], Value::Null);
    // an admin switches public links off for the project: the link stops
    c.patch(&format!("/projects/{pid}/docs/settings"), json!({"settings": {"allowPublicLinks": false}})).await;
    assert_eq!(c.get(&format!("/docs/public/{token}")).await.status, 404);
    c.patch(&format!("/projects/{pid}/docs/settings"), json!({"settings": {"allowPublicLinks": true}})).await;
    c.put(&format!("/docs/pages/{page_id}/public-link"), json!({"on": false})).await;
    let gone = c.get(&format!("/docs/public/{token}")).await;
    assert_eq!(gone.status, 404);
    assert_eq!(gone.json()["detail"]["code"], "public_link_not_found");
    assert_eq!(c.get("/docs/public/not-a-token").await.status, 404);
}

#[tokio::test]
async fn highlights_follow_their_words_and_respect_roles() {
    if !skip_unless_available("highlights_follow_their_words_and_respect_roles") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, page_id) = rich_page(&c, doc(json!([para("b-000001", "The ferry left at dawn.")]))).await;
    member(&c, &pid, "Vera", "viewer").await;
    member(&c, &pid, "Mia", "member").await;
    let body = json!({"block_id": "b-000001", "start": 4, "end": 9, "quote": "ferry", "color": "yellow"});
    let r = as_(&c, "Vera").post(&format!("/docs/pages/{page_id}/highlights"), body.clone()).await;
    assert_eq!(r.status, 403);
    let r = as_(&c, "Mia").post(&format!("/docs/pages/{page_id}/highlights"), body.clone()).await;
    assert_eq!(r.status, 201, "{:?}", r.json());
    let hid = id(&r.json());
    let list = as_(&c, "Vera").get(&format!("/docs/pages/{page_id}/highlights")).await.json();
    assert_eq!(list["highlights"][0]["quote"], "ferry");
    assert_eq!(list["can_add"], false);
    // anyone who may comment links the first thread written on someone else's highlight, but changes nothing else
    member(&c, &pid, "Lu", "member").await;
    let r = as_(&c, "Lu").patch(&format!("/docs/highlights/{hid}"), json!({"color": "blue"})).await;
    assert_eq!(r.status, 403);
    let r = as_(&c, "Lu").patch(&format!("/docs/highlights/{hid}"), json!({"thread_id": "t-1"})).await;
    assert_eq!(r.json()["thread_id"], "t-1", "{:?}", r.json());
    let r = as_(&c, "Vera").patch(&format!("/docs/highlights/{hid}"), json!({"thread_id": "t-2"})).await;
    assert_eq!(r.status, 403);
    // clearing everybody's is for admins
    assert_eq!(as_(&c, "Mia").get(&format!("/docs/pages/{page_id}/highlights")).await.json()["can_clear"], false);
    assert_eq!(c.get(&format!("/docs/pages/{page_id}/highlights")).await.json()["can_clear"], true);
    let r = as_(&c, "Mia").post(&format!("/docs/pages/{page_id}/highlights/clear"), json!({"scope": "all"})).await;
    assert_eq!(r.status, 403);
    // no version for a highlight
    assert_eq!(c.get(&format!("/docs/pages/{page_id}")).await.json()["version"], 1);
    // the words move inside the block: the highlight follows them
    c.put(
        &format!("/docs/pages/{page_id}/draft"),
        json!({"content": doc(json!([para("b-000001", "At dawn the ferry left.")]))}),
    )
    .await;
    c.post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": 1})).await;
    let h = &c.get(&format!("/docs/pages/{page_id}/highlights")).await.json()["highlights"][0];
    assert_eq!((h["state"].clone(), h["start"].clone()), (json!("moved"), json!(12)));
    // the words are gone: Passage changed
    c.put(&format!("/docs/pages/{page_id}/draft"), json!({"content": doc(json!([para("b-000001", "Nothing left.")]))}))
        .await;
    c.post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": 2})).await;
    let h = &c.get(&format!("/docs/pages/{page_id}/highlights")).await.json()["highlights"][0];
    assert_eq!(h["state"], "changed");
    // remove and undo
    assert_eq!(as_(&c, "Mia").delete(&format!("/docs/highlights/{hid}")).await.status, 200);
    assert_eq!(c.get(&format!("/docs/pages/{page_id}/highlights")).await.json()["highlights"], json!([]));
    let r =
        as_(&c, "Mia").post(&format!("/docs/pages/{page_id}/highlights/restore"), json!({"ids": [hid]})).await.json();
    assert_eq!(r["highlights"].as_array().unwrap().len(), 1);
    // switched off for the page: no new ones
    c.patch(&format!("/docs/pages/{page_id}/settings"), json!({"settings": {"highlights": "off"}})).await;
    let r = as_(&c, "Mia").post(&format!("/docs/pages/{page_id}/highlights"), body).await;
    assert_eq!(r.status, 409);
}

#[tokio::test]
async fn a_highlight_added_to_the_page_becomes_page_text_on_publish() {
    if !skip_unless_available("a_highlight_added_to_the_page_becomes_page_text_on_publish") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, page_id) = rich_page(&c, doc(json!([para("b-000001", "The ferry left at dawn.")]))).await;
    member(&c, &pid, "Vera", "viewer").await;
    member(&c, &pid, "Mia", "member").await;
    let body = json!({"block_id": "b-000001", "start": 4, "end": 9, "quote": "ferry", "color": "pink"});
    let hid = id(&as_(&c, "Mia").post(&format!("/docs/pages/{page_id}/highlights"), body.clone()).await.json());
    // people who can only read do not get it
    let r = as_(&c, "Vera").post(&format!("/docs/highlights/{hid}/to-page"), json!({})).await;
    assert_eq!(r.status, 403);
    // an editor: the words get a highlight mark in their draft, the shared one is "becoming" page text
    let r = as_(&c, "Mia").post(&format!("/docs/highlights/{hid}/to-page"), json!({})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    assert_eq!(r.json()["state"], "becoming");
    let draft = as_(&c, "Mia").get(&format!("/docs/pages/{page_id}")).await.json()["draft"]["content"].clone();
    let texts = &draft["content"][0]["content"];
    assert_eq!(texts[1]["text"], "ferry");
    assert_eq!(texts[1]["marks"], json!([{"type": "highlight", "attrs": {"color": "pink"}}]));
    assert_eq!((texts[0]["text"].clone(), texts[2]["text"].clone()), (json!("The "), json!(" left at dawn.")));
    // discarding the draft makes it a plain shared highlight again
    as_(&c, "Mia").delete(&format!("/docs/pages/{page_id}/draft")).await;
    let list = c.get(&format!("/docs/pages/{page_id}/highlights")).await.json();
    assert_eq!(list["highlights"][0]["state"], "ok");
    // added again and published: the page text carries it and the shared highlight goes
    as_(&c, "Mia").post(&format!("/docs/highlights/{hid}/to-page"), json!({})).await.assert_status(200);
    let r = as_(&c, "Mia").post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": 1})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    let list = c.get(&format!("/docs/pages/{page_id}/highlights")).await.json();
    assert_eq!(list["highlights"], json!([]));
    // it is reported as removed, with who made it and who removed it ("removed while you read")
    assert_eq!(list["removed"][0]["id"], json!(hid));
    assert_eq!((list["removed"][0]["author"].clone(), list["removed"][0]["by"].clone()), (json!("Mia"), json!("Mia")));
    // words that are gone cannot be added
    let other = id(&as_(&c, "Mia")
        .post(
            &format!("/docs/pages/{page_id}/highlights"),
            json!({"block_id": "b-000001", "start": 0, "end": 3, "quote": "The", "color": "blue"}),
        )
        .await
        .json());
    c.put(&format!("/docs/pages/{page_id}/draft"), json!({"content": doc(json!([para("b-000001", "Nothing here.")]))}))
        .await;
    let r = c.post(&format!("/docs/highlights/{other}/to-page"), json!({})).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.json()["detail"]["code"], "passage_changed");
}

#[tokio::test]
async fn the_recycle_bin_shows_a_page_icon_only_when_the_page_has_one() {
    if !skip_unless_available("the_recycle_bin_shows_a_page_icon_only_when_the_page_has_one") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, with_icon) = rich_page(&c, doc(json!([para("b-000001", "Hello")]))).await;
    c.patch(&format!("/docs/pages/{with_icon}/settings"), json!({"settings": {"icon": "📘"}})).await;
    let plain = id(&c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "Plain"})).await.json());
    assert_eq!(c.delete(&format!("/docs/pages/{with_icon}")).await.status, 200);
    assert_eq!(c.delete(&format!("/docs/pages/{plain}")).await.status, 200);
    let bin = c.get(&format!("/projects/{pid}/docs/recycle-bin")).await.json();
    let row = |page: &str| bin.as_array().unwrap().iter().find(|r| r["id"] == page).cloned().unwrap();
    assert_eq!(row(&with_icon)["icon"], "📘");
    // a page without an icon answers as before: no key at all
    assert!(row(&plain).get("icon").is_none());
}
