//! The modules of `kb-ai-know` against the vectors the Python modules gave (`contract/golden/ai_know.json`, made by
//! `gen_ai_know.py`): the ready-made packs and roles with every assembled instruction (SHA-256 and length), the files of
//! the board's plugin folder, the memory's path and similarity checks, the knowledge base's query parser, summaries,
//! keywords and BM25 ranking over a corpus, the block of a run's system prompt, text read from PDFs, and the plugin
//! folder builder, `on_for`, the catalogue and `to_dict` over tables of cases.

mod common;

use std::collections::HashSet;
use std::path::Path;

use kb_ai_know::board_skills::{self, Roles};
use kb_ai_know::kb::{self, AddOpts};
use kb_ai_know::knowledge::{self, BlockOpts};
use kb_ai_know::memory::{self, WriteOpts};
use kb_ai_know::plugins::{self, Built};
use kb_ai_know::{packs, roles};
use kb_base::pyjson;
use kb_db::database;
use kb_db::entities::{ai_plugin, ai_team};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::TryIntoModel;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    common::golden("ai_know.json")
}

/// `json.dumps(value, ensure_ascii=False)` of a value, as {sha256, chars, bytes}.
fn jdigest(value: &Value) -> (String, usize, usize) {
    common::digest(&pyjson::Dumps::new().ensure_ascii(false).dump(value))
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().expect("a list").iter().map(|x| x.as_str().expect("text").to_string()).collect()
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

// ---------------------------------------------------------------------------------------------------------------
// packs and roles
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_ready_made_packs_are_the_ones_python_presents() {
    let g = golden();
    let p = &g["packs"];
    assert_eq!(json!(packs::BUILTIN_VERSION), p["builtin_version"]);
    assert_eq!(packs::FORMAT, p["format"]);
    let want = p["builtin"].as_array().expect("packs");
    assert_eq!(packs::BUILTIN.len(), want.len());
    for (pack, w) in packs::BUILTIN.iter().zip(want) {
        let key = w["key"].as_str().expect("key");
        assert_eq!(pack.get("key").and_then(Value::as_str), Some(key));
        let fields: Vec<&String> = pack.keys().collect();
        assert_eq!(fields.iter().map(|s| s.as_str()).collect::<Vec<_>>(), strs(&w["fields"]), "{key}: field order");
        let persona = pack.get("persona").and_then(Value::as_str).expect("persona");
        assert_eq!(common::digest(persona), common::digest_of(&w["persona"]), "{key}: persona");
        assert_eq!(common::digest(&packs::rules(key)), common::digest_of(&w["rules"]), "{key}: rules");
        assert_eq!(jdigest(&Value::Object(pack.clone())), common::digest_of(&w["whole"]), "{key}: whole pack");
        let mut rest = pack.clone();
        rest.shift_remove("persona");
        assert_eq!(jdigest(&Value::Object(rest)), common::digest_of(&w["rest"]), "{key}: pack without persona");
        assert_eq!(packs::builtin(key).as_ref(), Some(pack));
    }
    assert_eq!(packs::BUILTIN_KEYS.iter().map(String::as_str).collect::<Vec<_>>(), {
        want.iter().map(|w| w["key"].as_str().expect("key")).collect::<Vec<_>>()
    });
}

#[test]
fn role_names_and_exports() {
    let g = golden();
    for case in g["packs"]["role_names"].as_array().expect("cases") {
        let k = opt(&case[0]);
        assert_eq!(packs::role_name(k), case[1].as_str().expect("name"), "{k:?}");
    }
    for (key, want) in g["packs"]["export"].as_object().expect("exports") {
        let mut pack = packs::builtin(key).expect("a ready-made pack");
        pack.insert("id".into(), json!(format!("builtin:{key}")));
        pack.insert("version".into(), json!(11));
        assert_eq!(jdigest(&packs::export(&pack)), common::digest_of(want), "{key}");
    }
}

#[test]
fn clean_checks_a_pack_as_python_does() {
    let g = golden();
    for case in g["packs"]["clean"].as_array().expect("cases") {
        let body = case["body"].as_object().expect("a body");
        match (packs::clean(body), case.get("error")) {
            (Ok(out), None) => {
                assert_eq!(Value::Object(out.clone()), case["out"], "{body:?}");
                let keys: Vec<&String> = out.keys().collect();
                let want: Vec<&String> = case["out"].as_object().expect("out").keys().collect();
                assert_eq!(keys, want, "{body:?}: key order");
            }
            (Err(err), Some(want)) => assert_eq!(err.to_string(), want.as_str().expect("text"), "{body:?}"),
            (got, want) => panic!("{body:?}: got {got:?}, python {want:?}"),
        }
    }
}

#[test]
fn roles_are_made_from_packs_as_python_makes_them() {
    let g = golden();
    for (key, want) in g["packs"]["role_from_pack"].as_object().expect("roles") {
        let pack = packs::builtin(key).expect("pack");
        assert_eq!(jdigest(&Value::Object(roles::role_from_pack(&pack))), common::digest_of(want), "{key}");
    }
    let catalogue: Vec<Value> = roles::catalogue().into_iter().map(Value::Object).collect();
    assert_eq!(jdigest(&Value::Array(catalogue)), common::digest_of(&g["packs"]["catalogue"]));
    let team_packs: Vec<Value> = roles::team_packs().into_iter().map(Value::Object).collect();
    assert_eq!(jdigest(&Value::Array(team_packs)), common::digest_of(&g["packs"]["team_packs"]));
    for (key, want) in g["packs"]["team_pack_roles"].as_object().expect("team packs") {
        let tp = roles::team_pack(key).expect("a team pack");
        assert_eq!(tp["roles"], *want, "{key}");
    }
    assert_eq!(
        roles::TEAM_PACKS.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        g["packs"]["team_pack_roles"].as_object().expect("team packs").keys().map(String::as_str).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn every_team_pack_gives_python_s_roles_agents_and_markdown() {
    let g = golden();
    for (key, want) in g["roles"].as_object().expect("cases") {
        if key == "configs" || key.starts_with("odd_") {
            continue;
        }
        let pack_key = if key == "None" { None } else { Some(key.as_str()) };
        let rs = roles::roles_for(None, "p", pack_key, &Map::new()).await.expect("roles");
        assert_eq!(rs.iter().filter_map(|r| r["key"].as_str()).collect::<Vec<_>>(), strs(&want["keys"]), "{key}");
        let as_value: Vec<Value> = rs.iter().cloned().map(Value::Object).collect();
        assert_eq!(jdigest(&Value::Array(as_value.clone())), common::digest_of(&want["roles"]), "{key}: roles");
        assert_eq!(
            jdigest(&Value::Object(roles::agents_json(&rs, "Report on the board."))),
            common::digest_of(&want["agents"]),
            "{key}: agents"
        );
        assert_eq!(
            jdigest(&Value::Object(roles::agents_json(&rs, ""))),
            common::digest_of(&want["agents_plain"]),
            "{key}: agents without rules"
        );
        for (r, w) in rs.iter().zip(want["markdown"].as_array().expect("markdown")) {
            assert_eq!(common::digest(&roles::agent_markdown(r, "")), common::digest_of(w), "{key}: {}", w["key"]);
        }
        for (r, w) in rs.iter().zip(want["markdown_rules"].as_array().expect("markdown")) {
            assert_eq!(
                common::digest(&roles::agent_markdown(r, "Rules.")),
                common::digest_of(w),
                "{key}: {}",
                w["key"]
            );
        }
        assert_eq!(jdigest(&Value::Array(roles::public(&rs))), common::digest_of(&want["public"]), "{key}: public");
    }
}

#[tokio::test]
async fn a_team_s_roles_follow_its_config_overrides() {
    let g = golden();
    for case in g["roles"]["configs"].as_array().expect("cases") {
        let config = match &case["config"] {
            Value::Object(m) => m.clone(),
            other => panic!("config {other}"),
        };
        let rs = roles::roles_for(None, "p", opt(&case["pack"]), &config).await.expect("roles");
        assert_eq!(rs.iter().filter_map(|r| r["key"].as_str()).collect::<Vec<_>>(), strs(&case["keys"]), "{case}");
        let as_value: Vec<Value> = rs.iter().cloned().map(Value::Object).collect();
        assert_eq!(jdigest(&Value::Array(as_value)), common::digest_of(&case["roles"]), "{}", case["pack"]);
        assert_eq!(
            jdigest(&Value::Object(roles::agents_json(&rs, "R"))),
            common::digest_of(&case["agents"]),
            "{}",
            case["pack"]
        );
    }
    let odd: roles::Role = json!({"key": "x", "prompt": "", "model": "opus", "tools": ["Read"], "description": ""})
        .as_object()
        .expect("a role")
        .clone();
    assert_eq!(
        jdigest(&Value::Object(roles::agents_json(std::slice::from_ref(&odd), "Board."))),
        common::digest_of(&g["roles"]["odd_agents"])
    );
    assert_eq!(common::digest(&roles::agent_markdown(&odd, "")), common::digest_of(&g["roles"]["odd_markdown"]));
    let unicode: roles::Role =
        json!({"key": "u", "description": "Hỏi “đáp”", "prompt": "P", "model": "m", "tools": ["A", "B"]})
            .as_object()
            .expect("a role")
            .clone();
    assert_eq!(
        common::digest(&roles::agent_markdown(&unicode, "R")),
        common::digest_of(&g["roles"]["odd_markdown_unicode"])
    );
}

// ---------------------------------------------------------------------------------------------------------------
// board skills
// ---------------------------------------------------------------------------------------------------------------

fn files_of(root: &Path) -> Vec<(String, String, usize)> {
    let mut out = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String, usize)>) {
        for entry in std::fs::read_dir(dir).expect("folder") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                let data = std::fs::read(&path).expect("file");
                let rel = path.strip_prefix(root).expect("below root").to_string_lossy().into_owned();
                out.push((rel, common::sha256_hex(&data), data.len()));
            }
        }
    }
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.split('/').cmp(b.0.split('/')));
    out
}

fn golden_files(v: &Value) -> Vec<(String, String, usize)> {
    v.as_array()
        .expect("files")
        .iter()
        .map(|f| {
            (
                f[0].as_str().expect("path").to_string(),
                f[1].as_str().expect("sha").to_string(),
                f[2].as_u64().expect("size") as usize,
            )
        })
        .collect()
}

#[tokio::test]
async fn the_board_skills_and_the_plugin_folder_are_python_s() {
    let _guard = common::init().await;
    let g = golden();
    let b = &g["board_skills"];
    let skills = board_skills::skills();
    let want = b["skills"].as_array().expect("skills");
    assert_eq!(skills.len(), want.len());
    for ((name, text), w) in skills.iter().zip(want) {
        assert_eq!(name, w[0].as_str().expect("name"));
        assert_eq!(common::digest(text), common::digest_of(&w[1]), "{name}");
    }
    assert_eq!(Value::Array(board_skills::catalog()), b["catalog"]);
    assert_eq!(board_skills::ALWAYS_ON, b["always_on"]);
    for (name, roles) in b["craft_roles"].as_object().expect("craft") {
        let mut got: Vec<&str> = board_skills::CRAFT_ROLES.iter().find(|(n, _)| n == name).expect("listed").1.to_vec();
        got.sort_unstable();
        assert_eq!(json!(got), *roles, "{name}");
    }
    assert_eq!(board_skills::CRAFT_ROLES.len(), b["craft_roles"].as_object().expect("craft").len());

    let full = std::path::PathBuf::from(board_skills::plugin_dir(None).expect("plugin folder"));
    assert_eq!(full.file_name().and_then(|n| n.to_str()), b["full"]["folder"].as_str());
    assert_eq!(full.parent(), kb_db::database::get_db_path().parent(), "beside the database");
    assert_eq!(files_of(&full), golden_files(&b["full"]["files"]));
    for case in b["picked"].as_array().expect("picked") {
        let names = strs(&case["names"]);
        let root = std::path::PathBuf::from(board_skills::plugin_dir(Some(&names)).expect("plugin folder"));
        assert_eq!(root.file_name().and_then(|n| n.to_str()), case["folder"].as_str(), "{names:?}");
        assert_eq!(files_of(&root), golden_files(&case["files"]), "{names:?}");
    }
    // written again over itself: nothing changes
    let again = std::path::PathBuf::from(board_skills::plugin_dir(None).expect("plugin folder"));
    assert_eq!(again, full);
    assert_eq!(files_of(&again), golden_files(&b["full"]["files"]));
}

#[test]
fn enabled_for_gives_python_s_answers() {
    let g = golden();
    for case in g["board_skills"]["enabled_for"].as_array().expect("cases") {
        let ops = match &case["ops"] {
            Value::Object(m) => m.clone(),
            other => panic!("ops {other}"),
        };
        let role = match case["role_kind"].as_str().expect("kind") {
            "set" => Roles::Many(strs(&case["role"]).into_iter().collect::<HashSet<_>>()),
            "str" => Roles::One(case["role"].as_str().expect("role").to_string()),
            _ => Roles::Unset,
        };
        let got = board_skills::enabled_for(&ops, opt(&case["member"]), role);
        assert_eq!(got, strs(&case["out"]), "{case}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn memory_finds_paths_compares_words_and_cleans_notes_as_python_does() {
    let g = golden();
    let m = &g["memory"];
    for case in m["paths_in"].as_array().expect("cases") {
        let text = case[0].as_str().expect("text");
        assert_eq!(memory::paths_in(text), strs(&case[1]), "{text:?}");
    }
    for case in m["similarity"].as_array().expect("cases") {
        let (a, b) = (case[0].as_str().expect("a"), case[1].as_str().expect("b"));
        assert_eq!(json!(memory::similarity(a, b)), case[2], "{a:?} / {b:?}");
    }
    for case in m["negation"].as_array().expect("cases") {
        let text = case[0].as_str().expect("text");
        assert_eq!(memory::negates(text), case[1].as_bool().expect("bool"), "{text:?}");
    }
    for case in m["clean"].as_array().expect("cases") {
        assert_eq!(memory::clean(opt(&case[0])), case[1].as_str().expect("text"));
    }
    for case in m["neg"].as_array().expect("cases") {
        let got: Vec<u32> = memory::neg(opt(&case[0]));
        let want: Vec<u32> =
            case[1].as_array().expect("codes").iter().map(|c| c.as_u64().expect("code") as u32).collect();
        assert_eq!(got, want, "{}", case[0]);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// the knowledge base
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_query_parser_summaries_and_keywords_are_python_s() {
    let g = golden();
    let k = &g["kb"];
    for case in k["keywords_of"].as_array().expect("cases") {
        assert_eq!(kb::keywords_of(case[0].as_str().expect("text"), 12), strs(&case[1]), "{}", case[0]);
    }
    for case in k["keywords_of_limit"].as_array().expect("cases") {
        assert_eq!(kb::keywords_of(case[0].as_str().expect("text"), 3), strs(&case[1]), "{}", case[0]);
    }
    for case in k["summary_of"].as_array().expect("cases") {
        assert_eq!(kb::summary_of(case[0].as_str().expect("text")), case[1].as_str().expect("text"), "{}", case[0]);
    }
    for case in k["fts_query"].as_array().expect("cases") {
        assert_eq!(kb::fts_query(case[0].as_str().expect("q")).as_deref(), opt(&case[1]), "{}", case[0]);
    }
    for case in k["known_suffix"].as_array().expect("cases") {
        assert_eq!(kb::known_suffix(opt(&case[0]).unwrap_or("")), case[1].as_str().expect("suffix"), "{}", case[0]);
    }
}

#[tokio::test]
async fn bm25_ranking_snippets_stores_and_reads_over_a_corpus_are_python_s() {
    let _guard = common::init().await;
    let g = golden();
    let k = &g["kb"];
    let mut session = database::session();
    let mut titles: std::collections::HashMap<String, String> = Default::default();
    let mut added = Vec::new();
    for c in k["corpus"].as_array().expect("corpus") {
        let project = c.get("project").and_then(Value::as_str).unwrap_or("P1");
        let store = c["store"].as_str().expect("store");
        let doc = kb::add(
            &session,
            AddOpts {
                project_id: if store == "project" { Some(project) } else { None },
                store,
                title: c["title"].as_str().expect("title"),
                kind: c["kind"].as_str().expect("kind"),
                body: c["body"].as_str().expect("body"),
                by: c["by"].as_str().expect("by"),
                source_name: opt(&c["source_name"]),
                upload_url: None,
                private: c["private"].as_bool().expect("private"),
            },
        )
        .await
        .expect("added");
        titles.insert(doc.id.clone(), doc.title.clone());
        added.push(doc);
    }
    for (doc, want) in added.iter().zip(k["docs"].as_array().expect("docs")) {
        assert_eq!(doc.title, want["title"].as_str().expect("title"));
        assert_eq!(doc.summary.as_deref(), opt(&want["summary"]), "{}", doc.title);
        assert_eq!(serde_json::from_str::<Value>(&doc.keywords).expect("keywords"), want["keywords"], "{}", doc.title);
        assert_eq!(serde_json::from_str::<Value>(&doc.answers).expect("answers"), want["answers"], "{}", doc.title);
        assert_eq!(doc.described_by.as_deref(), opt(&want["described_by"]));
        assert_eq!(json!(doc.tokens), want["tokens"], "{}", doc.title);
    }
    let by_title = |t: &str| added.iter().find(|d| d.title == t).expect("a document").clone();
    let title_of = |id: &str| titles.get(id).cloned().unwrap_or_default();

    let mut shared_on = false;
    for case in k["searches"].as_array().expect("searches") {
        let shared = case["shared"].as_bool().expect("shared");
        if shared && !shared_on {
            session.commit().await.expect("commit");
            common::set_ops("P1", json!({"knowledge_shared": true})).await;
            // a new session: the old one reads the snapshot it opened before the switch
            session = database::session();
            shared_on = true;
        }
        let person = opt(&case["person"]);
        if let Some(toc) = case.get("toc") {
            let got = kb::table_of_contents(&session, "P1", person).await.expect("toc");
            let got: Vec<Value> =
                got.iter().map(|r| json!([title_of(r["id"].as_str().expect("id")), r["store"]])).collect();
            assert_eq!(Value::Array(got), *toc, "{case}");
            continue;
        }
        if let Some(want) = case.get("shared_store") {
            let got = kb::shared_store(&session, person).await.expect("shared store");
            let got: Vec<Value> = got.iter().map(|r| r["title"].clone()).collect();
            assert_eq!(Value::Array(got), *want, "{case}");
            continue;
        }
        let limit = case.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
        let got = kb::search(&session, "P1", case["q"].as_str().expect("q"), person, limit).await.expect("search");
        let got: Vec<Value> = got
            .iter()
            .map(|r| {
                let title = title_of(r["id"].as_str().expect("id"));
                if case.get("limit").is_some() {
                    json!({"title": title, "score": r["score"]})
                } else {
                    json!({"title": title, "store": r["store"], "kind": r["kind"], "summary": r["summary"], "snippet": r["snippet"], "score": r["score"]})
                }
            })
            .collect();
        assert_eq!(Value::Array(got), case["hits"], "shared={shared} q={} person={person:?}", case["q"]);
    }

    for case in k["reads"].as_array().expect("reads") {
        let doc = by_title(case["title"].as_str().expect("title"));
        let got = kb::read(
            &session,
            "P1",
            &doc.id,
            opt(&case["person"]),
            case["start"].as_i64().expect("start"),
            case["length"].as_i64().expect("length"),
        )
        .await;
        match (got, case.get("error")) {
            (Ok(mut out), None) => {
                out["id"] = json!("<id>");
                assert_eq!(out, case["out"], "{case}");
            }
            (Err(err), Some(want)) => assert_eq!(err.to_string(), want.as_str().expect("text"), "{case}"),
            (got, want) => panic!("{case}: got {got:?}, python {want:?}"),
        }
    }
    let d = kb::to_dict(&added[0]);
    assert_eq!(d.keys().map(String::as_str).collect::<Vec<_>>(), strs(&k["to_dict_keys"]));
    session.commit().await.expect("commit");
}

#[test]
fn pdf_text_matches_pypdf_on_the_fixtures_and_stays_near_it_on_the_repository_s_pdfs() {
    let g = golden();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures");
    for (name, want) in g["pdf"]["fixtures"].as_object().expect("fixtures") {
        let got = kb::pdf_text(fixtures.join(name).to_str().expect("path"));
        assert_eq!(common::digest(&got), common::digest_of(want), "{name}");
    }
    // The repository's slide PDFs: pdf-extract is not pypdf. Spaces and line breaks differ (pypdf puts spaces inside
    // Vietnamese words), so the text is compared without whitespace: it is identical for every file but one, where pypdf
    // reads a bullet as the character U+007F and pdf-extract as U+2022 (89 characters of 20,760).
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut checked = 0;
    for (name, want) in g["pdf"]["repo"].as_object().expect("repo") {
        let path = repo.join(name);
        if !path.is_file() {
            continue;
        }
        checked += 1;
        let got = kb::pdf_text(path.to_str().expect("path"));
        let squeezed: String = kb_base::pytext::split(&got).concat();
        let (sha, chars, _bytes) = common::digest_of(&want["nospace"]);
        if name.ends_with("docs-ai-demo.pdf") {
            assert_eq!(squeezed.chars().count(), chars, "{name}: the same number of characters");
            let differing = squeezed.chars().filter(|c| *c == '\u{2022}').count();
            assert!((60..=120).contains(&differing), "{name}: bullets read as U+2022: {differing}");
            continue;
        }
        assert_eq!(common::digest(&squeezed).0, sha, "{name}: text without whitespace");
    }
    assert!(checked == 0 || checked >= 10, "the repository's PDFs were found: {checked}");
}

// ---------------------------------------------------------------------------------------------------------------
// knowledge
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_system_prompt_block_and_the_digest_are_python_s() {
    let _guard = common::init().await;
    let g = golden();
    let k = &g["knowledge"];
    let session = database::session();
    knowledge::set_instructions(&session, "KP", "  Tests: uv run pytest.  ", "An").await.expect("instructions");
    knowledge::set_instructions(&session, "KP", "Second text.", "An").await.expect("instructions");
    for i in 0..3 {
        knowledge::add_lesson(
            &session,
            "KP",
            &format!("Lesson {i}: use the tokens   always."),
            "An",
            Default::default(),
        )
        .await
        .expect("lesson");
    }
    knowledge::add_lesson(
        &session,
        "KP",
        "Proposed only.",
        "model",
        knowledge::LessonOpts { state: "proposed", ..Default::default() },
    )
    .await
    .expect("lesson");
    for (i, r) in knowledge::lessons(&session, "KP", Some("kept")).await.expect("lessons").into_iter().enumerate() {
        let mut active = kb_db::entities::ai_lesson::ActiveModel::from(r);
        active.uses = Set(i as i32);
        kb_db::sea_orm::ActiveModelTrait::update(active, &session).await.expect("uses");
    }
    session.commit().await.expect("commit");
    let write =
        |scope: &'static str, key: &'static str, text: &'static str, by: &'static str, kind: Option<&'static str>| {
            let session = &session;
            async move {
                memory::write(session, "KP", scope, key, text, by, WriteOpts { kind, ..Default::default() })
                    .await
                    .expect("note");
            }
        };
    write("role", "dev", "Run npm test first.", "Dev An", None).await;
    write("role", "dev", "A person said: use tabs.", "An", Some("feedback")).await;
    write("ticket", "KP-1", "The bug needs two tabs.", "Dev An", None).await;
    write("member", "mem_1", "Own member note.", "Dev An", None).await;

    let lesson_ids: Vec<(String, String)> = knowledge::lessons(&session, "KP", None)
        .await
        .expect("lessons")
        .into_iter()
        .map(|r| (r.id.clone(), format!("<lesson:{}>", r.text.chars().take(8).collect::<String>())))
        .collect();
    let note_ids: Vec<(String, String)> = memory::notes(&session, "KP", None, None)
        .await
        .expect("notes")
        .into_iter()
        .map(|n| (n.id.clone(), format!("<note:{}>", n.text.chars().take(8).collect::<String>())))
        .collect();
    for case in k["blocks"].as_array().expect("blocks") {
        let a = &case["args"];
        let (block, used) = knowledge::block_for(
            &session,
            "KP",
            BlockOpts {
                role: opt(&a["role"]),
                member_id: opt(&a["member_id"]),
                ticket_id: opt(&a["ticket_id"]),
                record_use: false,
                notes_on: a["notes_on"].as_bool().expect("notes_on"),
            },
        )
        .await
        .expect("block");
        let mut block = block;
        let mut used_text = serde_json::to_string(&used).expect("json");
        for (id, label) in lesson_ids.iter().chain(note_ids.iter()) {
            block = block.replace(id.as_str(), label);
            used_text = used_text.replace(id.as_str(), label);
        }
        assert_eq!(block, case["block"].as_str().expect("block"), "{a}");
        assert_eq!(serde_json::from_str::<Value>(&used_text).expect("used"), case["used"], "{a}");
    }
    assert_eq!(
        knowledge::prompt_block(&session, "KP", false).await.expect("block"),
        k["prompt_block"].as_str().expect("text")
    );
    common::set_ops("KP", json!({"lessons_in_prompt": 2})).await;
    let (_block, used) = knowledge::block_for(&session, "KP", BlockOpts::default()).await.expect("block");
    let texts: Vec<Value> = used["lessons"].as_array().expect("lessons").iter().map(|l| l["text"].clone()).collect();
    assert_eq!(json!({"lessons": texts, "tokens": used["tokens"]}), k["capped"]);
    let row = knowledge::get(&session, "KP").await.expect("row");
    let history: Vec<Value> =
        serde_json::from_str::<Vec<Value>>(&row.history).expect("history").iter().map(|h| h["text"].clone()).collect();
    assert_eq!(Value::Array(history), k["history"]);

    let records = k["digest_records"].as_array().expect("records");
    for case in k["digest"].as_array().expect("cases") {
        let limit = case["limit"].as_u64().expect("limit") as usize;
        let got = knowledge::digest(records, if limit == 0 { 12000 } else { limit });
        assert_eq!(got, case["out"].as_str().expect("text"), "limit {limit}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_plugin_catalogue_is_python_s() {
    let g = golden();
    let p = &g["plugins"];
    let want = p["catalogue"].as_array().expect("catalogue");
    assert_eq!(plugins::CATALOGUE.len(), want.len());
    for (entry, w) in plugins::CATALOGUE.iter().zip(want) {
        let key = w["key"].as_str().expect("key");
        assert_eq!(entry.get("key").and_then(Value::as_str), Some(key));
        assert_eq!(entry.keys().map(String::as_str).collect::<Vec<_>>(), strs(&w["keys"]), "{key}: key order");
        assert_eq!(jdigest(&Value::Object(entry.clone())), common::digest_of(&w["whole"]), "{key}");
    }
    let all: Vec<Value> = plugins::CATALOGUE.iter().cloned().map(Value::Object).collect();
    assert_eq!(jdigest(&Value::Array(all)), common::digest_of(&p["catalogue_all"]));
    for case in p["source_name"].as_array().expect("cases") {
        let source = case[0].as_str().expect("source");
        assert_eq!(plugins::source_name(source), case[1].as_str().expect("name"), "{source:?}");
    }
}

#[cfg(unix)]
#[test]
fn building_a_plugin_folder_validates_and_copies_as_python_does() {
    let g = golden();
    for case in g["plugins"]["build"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let tmp = tempfile::tempdir().expect("temp");
        let checkout = tmp.path().join("checkout");
        std::fs::create_dir_all(&checkout).expect("checkout");
        for (rel, text) in case["layout"].as_object().expect("layout") {
            let path = checkout.join(rel);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            std::fs::write(path, text.as_str().expect("text")).expect("file");
        }
        for (rel, target) in case["links"].as_object().expect("links") {
            let path = checkout.join(rel);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            std::os::unix::fs::symlink(target.as_str().expect("target"), path).expect("link");
        }
        let into = tmp.path().join("built");
        let skills: Option<Vec<String>> = case["skills"].as_array().map(|_| strs(&case["skills"]));
        let got = plugins::build(&checkout, opt(&case["plugin"]), skills.as_deref(), &into, opt(&case["name_hint"]));
        match (got, case.get("info")) {
            (Ok(Built::Plugin(info)), Some(want)) => {
                let got = json!({
                    "name": info.name, "version": info.version, "description": info.description, "skills": info.skills,
                    "hooks": info.hooks, "mcp": info.mcp, "size_bytes": info.size_bytes,
                });
                assert_eq!(&got, want, "{id}");
                assert_eq!(files_of(&into), golden_files(&case["built"]), "{id}");
            }
            (Ok(Built::Choices(choices)), Some(want)) => {
                assert_eq!(want["choices"], Value::Array(choices), "{id}");
            }
            (Err(err), None) => {
                let text = err.to_string().replace(checkout.to_str().expect("path"), "<checkout>");
                assert_eq!(Some(text.as_str()), case["error"].as_str(), "{id}");
            }
            (got, _) => panic!("{id}: got {got:?}, python {case}"),
        }
    }
}

fn team_of(id: &str, config: &str) -> ai_team::Model {
    let mut t = ai_team::new();
    t.id = Set(id.to_string());
    t.project_id = Set("p".to_string());
    t.config = Set(config.to_string());
    t.try_into_model().expect("every column has a value")
}

fn plugin_of(edit: impl FnOnce(&mut ai_plugin::ActiveModel)) -> ai_plugin::Model {
    let mut row = ai_plugin::new();
    row.project_id = Set(Some("p".to_string()));
    row.name = Set("n".to_string());
    row.source = Set("s".to_string());
    edit(&mut row);
    row.try_into_model().expect("every column has a value")
}

#[test]
fn on_for_and_role_of_follow_python_over_a_table() {
    let g = golden();
    let p = &g["plugins"]["on_for"];
    let teams: std::collections::BTreeMap<String, ai_team::Model> = p["teams"]
        .as_object()
        .expect("teams")
        .iter()
        .map(|(k, t)| (k.clone(), team_of(t["id"].as_str().expect("id"), t["config"].as_str().expect("config"))))
        .collect();
    let rows: std::collections::BTreeMap<String, ai_plugin::Model> = p["rows"]
        .as_object()
        .expect("rows")
        .iter()
        .map(|(k, r)| {
            (
                k.clone(),
                plugin_of(|row| {
                    row.default_on = Set(r["default_on"].as_bool().expect("bool"));
                    row.roles = Set(r["roles"].as_str().expect("roles").to_string());
                    row.members = Set(r["members"].as_str().expect("members").to_string());
                }),
            )
        })
        .collect();
    for case in p["cases"].as_array().expect("cases") {
        let row = &rows[case["row"].as_str().expect("row")];
        let team = &teams[case["team"].as_str().expect("team")];
        let keys: Option<HashSet<String>> =
            case["role_keys"].as_array().map(|_| strs(&case["role_keys"]).into_iter().collect());
        assert_eq!(plugins::on_for(row, team, keys.as_ref()), case["out"].as_bool().expect("bool"), "{case}");
    }
    for case in g["plugins"]["role_of"].as_array().expect("cases") {
        let team = &teams[case[0].as_str().expect("team")];
        assert_eq!(plugins::role_of(team).as_deref(), opt(&case[1]), "{}", case[0]);
    }
}

#[test]
fn the_catalogue_entry_of_an_installed_plugin_and_its_dict_follow_python() {
    let g = golden();
    for case in g["plugins"]["catalogue_entry_for"].as_array().expect("cases") {
        let row = plugin_of(|r| {
            r.source = Set(case["source"].as_str().expect("source").to_string());
            r.plugin = Set(opt(&case["plugin"]).map(str::to_string));
            let skills = &case["skills"];
            r.skills = Set(match skills {
                Value::String(s) => s.clone(),
                other => pyjson::dumps(other),
            });
        });
        let key =
            plugins::catalogue_entry_for(&row).and_then(|e| e.get("key").and_then(Value::as_str).map(str::to_string));
        assert_eq!(key.as_deref(), opt(&case["key"]), "{case}");
    }
    for case in g["plugins"]["to_dict"].as_array().expect("cases") {
        let r = &case["row"];
        let row = plugin_of(|row| {
            row.members = Set(r["members"].as_str().expect("members").to_string());
            row.roles = Set(r["roles"].as_str().expect("roles").to_string());
            row.skills = Set(r["skills"].as_str().expect("skills").to_string());
            row.previous = Set(opt(&r["previous"]).map(str::to_string));
            row.hooks = Set(r["hooks"].as_i64().expect("hooks") as i32);
            row.mcp = Set(r["mcp"].as_i64().expect("mcp") as i32);
            row.size_bytes = Set(r["size_bytes"].as_i64().expect("size") as i32);
            row.pinned = Set(r["pinned"].as_bool().expect("pinned"));
            row.default_on = Set(r["default_on"].as_bool().expect("default_on"));
        });
        let used = if case["used"].is_null() { None } else { Some(&case["used"]) };
        let mut got = plugins::to_dict(&row, used);
        for k in ["id", "installed_at", "updated_at"] {
            got.as_object_mut().expect("object").shift_remove(k);
        }
        assert_eq!(got, case["out"], "{case}");
        assert_eq!(pyjson::dumps(&got), pyjson::dumps(&case["out"]), "{case}: key order");
    }
}
