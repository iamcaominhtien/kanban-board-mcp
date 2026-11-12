//! The pure parts of `worktrees`, `github` and `project_env` against the vectors the Python modules gave
//! (`contract/golden/ai_work.json`, made by `gen_ai_work.py`): branch names and paths, remotes, outputs, the texts of
//! notes and tasks, the pull request state read from `gh pr view` JSON, CI roll-ups, the base branch check, and the PATH
//! helpers. The calls that go through `gh` run a fake `gh` that answers what the vector says.

mod common;

use std::collections::HashSet;
use std::collections::HashMap;

use kb_ai_work::{github, project_env, worktrees};
use kb_db::database;
use kb_db::entities::{ai_watched_pr, ai_worktree};
use kb_db::sea_orm::ActiveModelTrait;
use serde_json::{Value, json};

fn g() -> Value {
    common::golden("ai_work.json")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("a text")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().expect("a list").iter().map(|x| s(x).to_string()).collect()
}

#[test]
fn slug_gives_what_python_gives() {
    let g = g();
    for case in g["slug"].as_array().expect("cases") {
        assert_eq!(worktrees::slug_default(s(&case[0])), s(&case[1]), "{}", case[0]);
    }
    for case in g["slug_limit"].as_array().expect("cases") {
        assert_eq!(worktrees::slug(s(&case[0]), case[1].as_u64().expect("limit") as usize), s(&case[2]), "{case}");
    }
}

#[test]
fn path_for_gives_what_python_gives() {
    for case in g()["path_for"].as_array().expect("cases") {
        assert_eq!(worktrees::path_for(s(&case[0]), s(&case[1])), s(&case[2]), "{case}");
    }
}

#[test]
fn only_a_github_host_is_github() {
    for case in g()["is_github"].as_array().expect("cases") {
        assert_eq!(worktrees::is_github(case[0].as_str()), case[1].as_bool().expect("bool"), "{}", case[0]);
    }
    // the Python test's own examples
    assert!(worktrees::is_github(Some("https://github.com/o/r.git")));
    assert!(worktrees::is_github(Some("git@github.com:o/r.git")));
    assert!(worktrees::is_github(Some("ssh://git@github.com/o/r.git")));
    assert!(!worktrees::is_github(Some("https://gitlab.com/github.com/r.git")));
    assert!(!worktrees::is_github(Some("https://notgithub.com/o/r")) && !worktrees::is_github(None));
}

#[test]
fn outputs_are_told_from_code() {
    let g = g();
    for case in g["is_output"].as_array().expect("cases") {
        assert_eq!(worktrees::is_output(s(&case[0])), case[1].as_bool().expect("bool"), "{}", case[0]);
    }
    for case in g["outputs_in"].as_array().expect("cases") {
        assert_eq!(worktrees::outputs_in(&strings(&case[0])), strings(&case[1]), "{case}");
    }
}

#[test]
fn the_note_about_outputs_reads_as_python_writes_it() {
    for case in g()["note_for"].as_array().expect("cases") {
        let r = &case[0];
        let moved = strings(&r["moved"]);
        let left = r.get("left").map(strings).unwrap_or_default();
        let got = worktrees::note_text(&moved, &left, r["to"].as_str(), r["reason"].as_str(), s(&case[1]));
        assert_eq!(got.as_deref(), case[2].as_str(), "{case}");
    }
}

#[test]
fn sizes_round_as_python_rounds() {
    for case in g()["size_round"].as_array().expect("cases") {
        assert_eq!(worktrees::mb_of(case[0].as_u64().expect("bytes")), case[1].as_f64().expect("mb"), "{case}");
    }
}

#[test]
fn the_ci_roll_up_gives_what_python_gives() {
    for case in g()["rollup"].as_array().expect("cases") {
        let (ci, failing) = github::rollup(case[0].as_array().expect("checks"));
        assert_eq!(ci, s(&case[1]), "{case}");
        assert_eq!(Value::Array(failing), case[2], "{case}");
    }
}

#[test]
fn a_pull_request_is_read_as_python_reads_it() {
    for case in g()["poll"].as_array().expect("cases") {
        let seen: HashSet<String> = strings(&case["seen"]).into_iter().collect();
        let got = github::shape_poll(&case["data"], &seen).expect("an object").to_value();
        common::assert_same(&case["data"].to_string(), &got, &case["poll"]);
    }
}

#[tokio::test]
async fn poll_reads_what_gh_prints_and_says_when_it_cannot() {
    let _guard = common::init().await;
    let row = {
        let mut r = ai_watched_pr::new();
        r.ticket_id = kb_db::sea_orm::ActiveValue::Set("T-1".into());
        r.project_id = kb_db::sea_orm::ActiveValue::Set("p".into());
        r.number = kb_db::sea_orm::ActiveValue::Set(7);
        r.branch = kb_db::sea_orm::ActiveValue::Set("b".into());
        r.repo = kb_db::sea_orm::ActiveValue::Set(common::folder().to_string_lossy().into_owned());
        kb_db::sea_orm::TryIntoModel::try_into_model(r).expect("a row")
    };
    for case in g()["poll"].as_array().expect("cases") {
        common::fake_gh_reset();
        common::fake_gh_set("pr_view", &case["data"].to_string(), "", 0);
        let mut seeded = row.clone();
        seeded.seen_comments = case["seen"].to_string();
        let got = github::poll(&seeded).await.expect("a poll").to_value();
        common::assert_same(&case["data"].to_string(), &got, &case["poll"]);
    }
    common::fake_gh_reset();
    common::fake_gh_set("pr_view", "", &format!("{}\n", "boom ".repeat(100)), 1);
    let got = github::poll(&row).await.expect("a poll").to_value();
    let want = format!("{}", "boom ".repeat(100).trim().chars().take(200).collect::<String>());
    assert_eq!(got, json!({"error": want}));
    common::fake_gh_set("pr_view", "not json", "", 0);
    assert_eq!(github::poll(&row).await.expect("a poll").to_value(), json!({"error": "gh answered something that is not JSON"}));
    // a gh that does not exist says so as Python's FileNotFoundError does
    common::fake_gh_reset();
    let calls = common::fake_gh_calls();
    assert!(calls.is_empty());
    let (code, text) = github::gh(&["pr", "view"], "/definitely/not/a/folder", 5.0).await;
    assert_eq!(code, 1);
    assert_eq!(text, "[Errno 2] No such file or directory: '/definitely/not/a/folder'");
}

#[tokio::test]
async fn a_gh_that_is_too_slow_is_killed_and_reported() {
    let _guard = common::init().await;
    common::fake_gh_reset();
    common::fake_gh_set("pr_view", "late", "", 0);
    common::fake_gh_sleep("pr_view", 5);
    let started = std::time::Instant::now();
    let (code, text) = github::gh(&["pr", "view"], &common::folder().to_string_lossy(), 1.0).await;
    assert!(started.elapsed().as_secs() < 4, "the child was waited for too long");
    assert_eq!(code, 1);
    assert_eq!(text, "Command '['gh', 'pr', 'view']' timed out after 1 seconds");
}

#[tokio::test]
async fn the_base_branch_check_gives_what_python_gives() {
    let _guard = common::init().await;
    let row = {
        let mut r = ai_watched_pr::new();
        r.ticket_id = kb_db::sea_orm::ActiveValue::Set("T-1".into());
        r.project_id = kb_db::sea_orm::ActiveValue::Set("p".into());
        r.number = kb_db::sea_orm::ActiveValue::Set(7);
        r.branch = kb_db::sea_orm::ActiveValue::Set("b".into());
        r.repo = kb_db::sea_orm::ActiveValue::Set(common::folder().to_string_lossy().into_owned());
        kb_db::sea_orm::TryIntoModel::try_into_model(r).expect("a row")
    };
    for case in g()["base_is_red"].as_array().expect("cases") {
        common::fake_gh_reset();
        match case.get("runs") {
            Some(runs) => common::fake_gh_set("run_list", &runs.to_string(), "", 0),
            None => {
                let gh = case["gh"].as_array().expect("gh");
                common::fake_gh_set("run_list", s(&gh[1]), "", gh[0].as_i64().expect("code") as i32);
            }
        }
        let got = github::base_is_red(&row, case["base"].as_str(), &case["check"]).await;
        let want = case["out"].as_bool();
        assert_eq!(got, want, "{case}");
    }
    // the arguments gh is given
    common::fake_gh_reset();
    common::fake_gh_set("run_list", "[]", "", 0);
    github::base_is_red(&row, Some("main"), &json!({"workflowName": "CI"})).await;
    let calls = common::fake_gh_calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].ends_with("|run list --branch main --limit 20 --json conclusion,status,workflowName"), "{}", calls[0]);
}

#[tokio::test]
async fn the_failing_log_is_read_as_python_reads_it() {
    let _guard = common::init().await;
    let row = {
        let mut r = ai_watched_pr::new();
        r.ticket_id = kb_db::sea_orm::ActiveValue::Set("T-1".into());
        r.project_id = kb_db::sea_orm::ActiveValue::Set("p".into());
        r.number = kb_db::sea_orm::ActiveValue::Set(7);
        r.branch = kb_db::sea_orm::ActiveValue::Set("b".into());
        r.repo = kb_db::sea_orm::ActiveValue::Set(common::folder().to_string_lossy().into_owned());
        kb_db::sea_orm::TryIntoModel::try_into_model(r).expect("a row")
    };
    for case in g()["failure_log"].as_array().expect("cases") {
        common::fake_gh_reset();
        // the generator did not keep a text over 100 characters: it is a run of one letter, `len` long
        let gh = case["gh"].as_array().expect("gh");
        let len = gh[2].as_u64().expect("length") as usize;
        let reply = match gh[1].as_str() {
            Some(t) => t.to_string(),
            None => case["out"].as_str().map(|o| o.chars().next().map_or(String::new(), |c| c.to_string().repeat(len))).unwrap_or_default(),
        };
        common::fake_gh_set("run_view", &reply, "", gh[0].as_i64().expect("code") as i32);
        let got = github::failure_log(&row, &json!({"detailsUrl": case["url"], "name": case["name"]})).await;
        assert_eq!(got, s(&case["out"]), "{case}");
        let calls = common::fake_gh_calls();
        assert_eq!(calls.len(), case["calls"].as_array().expect("calls").len(), "{case}");
        for (got, want) in calls.iter().zip(case["calls"].as_array().expect("calls")) {
            assert!(got.ends_with(&format!("|{}", strings(&want[0]).join(" "))), "{got}");
        }
    }
}

#[test]
fn what_the_dev_is_told_reads_as_python_writes_it() {
    let g = g();
    assert_eq!(github::AI_MARK, s(&g["ai_mark"]));
    assert_eq!(github::AUTO_PER_DAY as u64, g["auto_per_day"].as_u64().expect("number"));
    for case in g["fence"].as_array().expect("cases") {
        assert_eq!(github::fence(s(&case[0]), s(&case[1])), s(&case[2]), "{case}");
    }
    for case in g["ci_task"].as_array().expect("cases") {
        let check = case["check"].as_str().unwrap_or("None");
        let got = github::ci_task(case["number"].as_i64().expect("number") as i32, check, s(&case["base"]), s(&case["log"]), s(&case["branch"]));
        assert_eq!(got, s(&case["text"]));
    }
    for case in g["review_task"].as_array().expect("cases") {
        let got = github::review_task(case["number"].as_i64().expect("number") as i32, s(&case["comments"]), s(&case["branch"]));
        assert_eq!(got, s(&case["text"]));
    }
}

#[tokio::test]
async fn the_cards_and_signals_of_watched_pull_requests_read_as_python_writes_them() {
    let _guard = common::init().await;
    let db = &g()["db"];
    let session = database::session();
    let mut models = Vec::new();
    for row in db["rows"].as_array().expect("rows") {
        let model: ai_watched_pr::Model = serde_json::from_value(row.clone()).expect("a watched pull request");
        ai_watched_pr::ActiveModel::from(model.clone()).insert(&session).await.expect("insert");
        models.push(model);
    }
    session.commit().await.expect("commit");
    for project in ["p1", "p2", "p3"] {
        let got = Value::Array(github::signals(&session, project).await.expect("signals"));
        common::assert_same(project, &got, &db[format!("signals_{project}")]);
    }
    for (model, want) in models.iter().zip(db["to_dict"].as_array().expect("dicts")) {
        common::assert_same(&model.ticket_id, &github::to_dict(model), want);
    }
    // the worktree rows
    let rows: Vec<ai_worktree::Model> = db["worktree_rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|r| serde_json::from_value(r.clone()).expect("a worktree"))
        .collect();
    let want = db["worktree_dict"].as_array().expect("dicts");
    common::assert_same("no live", &worktrees::to_dict(&rows[0], None), &want[0]);
    let live = json!({"exists": true, "uncommitted": [], "size_mb": 0.5, "ahead": 2, "outputs": []});
    common::assert_same("live", &worktrees::to_dict(&rows[0], Some(live)), &want[1]);
    common::assert_same("empty live and empty conflict files", &worktrees::to_dict(&rows[1], Some(json!({}))), &want[2]);
}

#[tokio::test]
async fn a_project_keeps_the_folders_it_names_for_its_commands() {
    let _guard = common::init().await;
    for case in g()["env_extra"].as_array().expect("cases") {
        let settings = match &case[0] {
            Value::Null => None,
            ops => Some(common::settings_model("p", Some(&ops.to_string()))),
        };
        assert_eq!(project_env::extra(settings.as_ref()), strings(&case[1]), "{}", case[0]);
    }
}

fn with_home(text: &str) -> String {
    text.replace("$HOME", &std::env::var("HOME").expect("HOME"))
}

#[tokio::test]
async fn the_path_of_a_project_is_made_as_python_makes_it() {
    let _guard = common::init().await;
    for case in g()["with_path"].as_array().expect("cases") {
        let base: HashMap<String, String> =
            case[0].as_object().expect("env").iter().map(|(k, v)| (k.clone(), s(v).to_string())).collect();
        let folders: Option<Vec<String>> = case[1].as_array().map(|_| strings(&case[1]));
        let got = project_env::with_path(Some(&base), folders.as_deref());
        let want: HashMap<String, String> =
            case[2].as_object().expect("env").iter().map(|(k, v)| (k.clone(), with_home(s(v)))).collect();
        assert_eq!(got, want, "{case}");
    }
    // the default base is this process's environment
    let own = project_env::with_path(None, Some(&["/opt/kb".to_string()]));
    assert!(own["PATH"].starts_with("/opt/kb:"));
    assert_eq!(own["HOME"], std::env::var("HOME").expect("HOME"));
}

#[test]
fn the_programs_of_a_command_are_found_as_python_finds_them() {
    let g = g();
    for case in g["programs"].as_array().expect("cases") {
        assert_eq!(project_env::programs(case[0].as_str().unwrap_or("")), strings(&case[1]), "{}", case[0]);
    }
    for case in g["version_key"].as_array().expect("cases") {
        let want: Vec<u64> = case[1].as_array().expect("key").iter().map(|n| n.as_u64().unwrap_or(u64::MAX)).collect();
        assert_eq!(project_env::version_key(s(&case[0])), want, "{}", case[0]);
    }
}

#[tokio::test]
async fn tools_are_found_in_the_usual_folders_and_the_newest_node_wins() {
    let _guard = common::init().await;
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    // the tree the generator built, in this process's HOME
    let bins: [(&str, &[&str]); 7] = [
        (".local/bin", &["kbtool-one"]),
        (".cargo/bin", &["kbtool-two", "kbtool-dup"]),
        (".volta/bin", &["kbtool-dup"]),
        (".nvm/versions/node/v18.0.0/bin", &["kbnode"]),
        (".nvm/versions/node/v20.11.1/bin", &["kbnode", "kbnode-new"]),
        (".nvm/versions/node/v9.1.2/bin", &["kbnode-old"]),
        (".local/share/fnm/node-versions/v22.1.0/installation/bin", &["kbfnm"]),
    ];
    for (rel, names) in bins {
        let dir = home.join(rel);
        std::fs::create_dir_all(&dir).expect("folder");
        for n in names {
            let f = dir.join(n);
            std::fs::write(&f, "#!/bin/sh\n").expect("tool");
            common::make_executable(&f);
        }
    }
    std::fs::create_dir_all(home.join(".bun/bin")).expect("folder");
    std::fs::write(home.join(".bun/bin/kbtool-noexec"), "x").expect("file");
    std::fs::create_dir_all(home.join(".deno/bin/kbtool-dir")).expect("folder");
    std::fs::create_dir_all(home.join(".npm-global")).expect("folder");
    let on_path = home.join("onpath");
    std::fs::create_dir_all(&on_path).expect("folder");
    std::fs::write(on_path.join("kbtool-here"), "#!/bin/sh\n").expect("tool");
    common::make_executable(&on_path.join("kbtool-here"));

    let g = g();
    for case in g["find"].as_array().expect("cases") {
        let got = project_env::find(s(&case[0]), &with_home(s(&case[1])));
        let want = case[2].as_str().map(with_home);
        assert_eq!(got, want, "{case}");
    }
    for case in g["missing_folders"].as_array().expect("cases") {
        let got = project_env::missing_folders(&strings(&case[0]), &with_home(s(&case[1])));
        let want: Vec<Value> = case[2]
            .as_array()
            .expect("folders")
            .iter()
            .map(|f| json!({"path": with_home(s(&f["path"])), "program": f["program"]}))
            .collect();
        assert_eq!(got, want, "{case}");
    }
    let home_text = home.to_string_lossy().into_owned();
    let got: Vec<String> = project_env::candidates()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| p.starts_with(&home_text))
        .collect();
    let want: Vec<String> = strings(&g["candidates"]).iter().map(|c| with_home(c)).collect();
    assert_eq!(got, want);
}

/// Replace this test's folder with the placeholder the generator wrote.
fn scrub(value: &Value, root: &std::path::Path) -> Value {
    serde_json::from_str(&value.to_string().replace(&root.to_string_lossy().replace('\\', "\\\\"), "$ROOT")).expect("json")
}

#[tokio::test]
async fn what_git_says_about_a_worktree_is_read_as_python_reads_it() {
    let _guard = common::init().await;
    let want = &g()["git"];
    // the repository and its worktrees as the generator made them
    let root = common::folder().join("gitcase");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("repo folder");
    common::write_files(&repo, &[("calc.py", "def add(a, b):\n    return a - b\n")]);
    common::git(&repo, &["init", "-q", "-b", "main"]);
    common::git(&repo, &["add", "-A"]);
    common::git(&repo, &["commit", "-q", "-m", "first"]);
    let mut trees = HashMap::new();
    for tid in ["T-A", "T-B", "T-C"] {
        let path = root.join("repo.worktrees").join(tid);
        common::git(&repo, &["worktree", "add", "-b", &format!("ai/{tid}-x"), &path.to_string_lossy(), "main"]);
        trees.insert(tid, path);
    }
    let b = &trees["T-B"];
    common::write_files(
        b,
        &[("calc.py", "def add(a, b):\n    return a + b\n"), ("staged.txt", "staged\n")],
    );
    common::git(b, &["add", "staged.txt"]);
    common::write_files(b, &[("feature.py", "x = 1\n"), ("qa/step.txt", "step\n"), ("src/new.py", "y = 2\n"), ("run.log", "log\n")]);
    std::fs::write(b.join("shot.png"), [0x89u8, b'P', b'N', b'G'].repeat(300_000)).expect("png");
    let c = &trees["T-C"];
    common::write_files(c, &[("later.py", "z = 3\n")]);
    common::git(c, &["add", "-A"]);
    common::git(c, &["commit", "-q", "-m", "ahead"]);
    for _ in 0..12 {
        common::write_files(c, &[("m.py", &"m\n".repeat(5))]);
        common::git(c, &["add", "-A"]);
    }
    common::git(c, &["commit", "-q", "-m", "ahead again"]);
    for i in 0..35 {
        common::write_files(c, &[(&format!("u{i:02}.py"), "u\n")]);
    }
    common::write_files(c, &[(".git-note-not-a-dir", "n\n")]);

    let session = database::session();
    let root_text = root.to_string_lossy().into_owned();
    let mut rows = Vec::new();
    for row in want["rows"].as_array().expect("rows") {
        let text = row.to_string().replace("$ROOT", &root_text);
        let model: ai_worktree::Model = serde_json::from_str(&text).expect("a worktree row");
        // each test file shares one database: the ticket ids are the same for every run of this test
        ai_worktree::ActiveModel::from(model.clone()).insert(&session).await.expect("insert");
        rows.push(model);
    }
    session.commit().await.expect("commit");
    for row in &rows {
        let live = worktrees::status(row).await.expect("status").to_value();
        common::assert_same(&format!("status {}", row.ticket_id), &scrub(&live, &root), &want["status"][&row.ticket_id]);
        let brief = worktrees::brief(&session, &row.ticket_id).await.expect("brief").unwrap_or(Value::Null);
        common::assert_same(&format!("brief {}", row.ticket_id), &scrub(&brief, &root), &want["brief"][&row.ticket_id]);
    }
    assert_eq!(worktrees::brief(&session, "T-none").await.expect("brief"), None);
    for (key, project) in [("list_p1", "p1"), ("list_p2", "p2"), ("list_p3", "p3")] {
        let listed = Value::Array(worktrees::list_for_project(&session, project).await.expect("list"));
        common::assert_same(key, &scrub(&listed, &root), &want[key]);
    }
    // the hand-over route guessed from the remote
    assert_eq!(worktrees::guess_route(&repo.to_string_lossy()).await.expect("route"), want["guess"]["none"]);
    common::git(&repo, &["remote", "add", "origin", "https://gitlab.example.com/a/b.git"]);
    assert_eq!(worktrees::guess_route(&repo.to_string_lossy()).await.expect("route"), want["guess"]["gitlab"]);
}
