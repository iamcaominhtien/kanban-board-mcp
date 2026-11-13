//! `kanban-db` (`dbkit/cli.py`): the same arguments, the same words and the same exit codes. The Python script has no
//! pytest file; this runs one story with the Rust command line (in this process) and, when the Python server's
//! virtualenv is there, the same story with `python -m dbkit.cli` on files of its own, and compares every line.

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::{board, sqlite_exec};
use kb_dbkit::cli::{self, Out};

/// A writer a test can read back.
#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("buffer").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Buffer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("buffer")).into_owned()
    }
}

/// (exit code, standard output, standard error) of one command.
type Ran = (i32, String, String);

async fn rust(args: &[String]) -> Ran {
    let (out, err) = (Buffer::default(), Buffer::default());
    let code = cli::run(args.to_vec(), Out::to(Box::new(out.clone()), Box::new(err.clone()))).await;
    (code, out.text(), err.text())
}

fn server_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server")
}

fn python(args: &[String], home: &Path) -> Ran {
    let server = server_dir();
    let mut command = std::process::Command::new(server.join(".venv/bin/python"));
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("KANBAN_") {
            command.env_remove(name);
        }
    }
    let done = command
        .args(["-m", "dbkit.cli"])
        .args(args)
        .current_dir(&server)
        .env("KANBAN_CONFIG_DIR", home.join("config"))
        .env("KANBAN_DB_PATH", home.join("data").join("kanban.db"))
        .env("KANBAN_LOG_DIR", home.join("logs"))
        .env("KANBAN_AI_KEY_FILE", home.join("key"))
        .env("COLUMNS", "80")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("python -m dbkit.cli");
    (
        done.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&done.stdout).into_owned(),
        String::from_utf8_lossy(&done.stderr).into_owned(),
    )
}

/// What differs between two runs for reasons that are not the script's: the folder, the version of the SQLite each
/// program is built with, and how long the copy took.
fn normalized(text: &str, dir: &Path) -> String {
    let text = text.replace(&dir.to_string_lossy().into_owned(), "<dir>");
    text.lines()
        .map(|line| {
            let mut line = line.to_string();
            if let Some(at) = line.find("SQLite 3.") {
                let end = line[at + 7..].find([',', ' ']).map(|n| at + 7 + n).unwrap_or(line.len());
                line.replace_range(at..end, "SQLite 3.X");
            }
            if line.starts_with("copied    ") {
                if let Some(at) = line.rfind(" rows, ") {
                    line.truncate(at);
                    line.push_str(" rows, N min N s");
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The story: every command with the files it names (`{dir}` is the folder of the run).
fn story() -> Vec<Vec<&'static str>> {
    let (src, dst) = ("sqlite:///{dir}/source.db", "sqlite:///{dir}/copy.db");
    vec![
        vec!["test", src],
        vec!["test", "sqlite:///{dir}/new/board.db"],
        vec!["test", "redis://localhost/0"],
        vec!["test", "postgresql://u:p@127.0.0.1:1/x"],
        vec!["migrate", "--from", src, "--to", dst, "--dry-run"],
        vec!["migrate", "--from", src, "--to", dst, "--verify"],
        vec!["migrate", "--from", src, "--to", dst],
        vec!["migrate", "--from", src, "--to", dst, "--empty-first", "--yes-empty", "wrong"],
        vec!["migrate", "--from", src, "--to", dst, "--empty-first", "--yes-empty", "{dir}/copy.db"],
        vec!["migrate", "--from", src, "--to", src],
        vec!["migrate", "--from", "sqlite:///{dir}/nothing.db", "--to", "sqlite:///{dir}/other.db"],
        vec!["migrate", "--from", src, "--to", "postgresql://u:p@127.0.0.1:1/x"],
        vec!["TRIGGER"],
        vec!["migrate", "--from", src, "--to", dst, "--resume", "--verify"],
        vec!["use", dst],
        vec!["use", "sqlite:///{dir}/foreign.db"],
        vec!["use", "mongodb://h/db"],
        vec!["migrate", "--from", src],
        vec![],
    ]
}

fn words(command: &[&str], dir: &Path) -> Vec<String> {
    command.iter().map(|word| word.replace("{dir}", &dir.to_string_lossy())).collect()
}

async fn prepare(dir: &Path) {
    std::fs::create_dir_all(dir).expect("folder");
    board(&dir.join("source.db")).await;
    sqlite_exec(&dir.join("foreign.db"), "CREATE TABLE notes (x)", &[]).await;
}

async fn add_trigger(dir: &Path) {
    sqlite_exec(
        &dir.join("copy.db"),
        "CREATE TRIGGER too_small BEFORE INSERT ON project WHEN 1 \
         BEGIN SELECT RAISE(ABORT, 'Data too long for column ''name'' at row 1'); END",
        &[],
    )
    .await;
}

#[tokio::test]
#[allow(unsafe_code)]
async fn test_the_command_line_says_what_the_python_script_said() {
    let tmp = tempfile::tempdir().expect("tmp");
    let tmp_path = tmp.path().canonicalize().expect("tmp");
    let home = tmp_path.join("home");
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", home.join("config"));
        std::env::set_var("KANBAN_AI_KEY_FILE", home.join("key"));
        std::env::remove_var("KANBAN_DATABASE_URL");
        std::env::remove_var("KANBAN_DB_PASSWORD");
    }
    let dir = tmp_path.join("rust");
    prepare(&dir).await;
    let mut ran: Vec<Ran> = Vec::new();
    for command in story() {
        if command == ["TRIGGER"] {
            add_trigger(&dir).await;
            continue;
        }
        let (code, out, err) = rust(&words(&command, &dir)).await;
        ran.push((code, normalized(&out, &dir), normalized(&err, &dir)));
    }

    // what the story must say, whatever it is compared with
    let codes: Vec<i32> = ran.iter().map(|r| r.0).collect();
    assert_eq!(codes, [0, 0, 2, 2, 0, 0, 3, 3, 0, 2, 2, 2, 4, 0, 3, 2, 2, 2]);
    assert_eq!(
        ran[0].1,
        "ok    A file on this computer · <dir>/source.db\nnote  Already holds a Kanban board · 95 tables, 4 tickets\n      Use it as it is (Use this database), or empty it in the next step to copy your data in."
    );
    assert_eq!(
        ran[2].1,
        "Redis and MongoDB cannot hold the board: it is relational (tables that refer to each other). \
         Use SQLite, PostgreSQL or MySQL/MariaDB."
    );
    assert_eq!(
        ran[4].1,
        "Source   SQLite, 77 tables · about 1,000 rows, schema at head\n\
         Target   SQLite 3.X, empty\n\
         ok  target can create tables\n\
         ok  copy order resolved from foreign keys (77 tables)\n\
         note  Docs search is rebuilt\n\
         Dry run: nothing was written.  Exit 0"
    );
    let copied: Vec<&str> = ran[5].1.lines().collect();
    assert_eq!(copied[5], "ai_account                4 / 4");
    assert_eq!(
        copied[copied.len() - 8..],
        [
            "copied    77 tables, 1,408 rows, N min N s",
            "ok  Row counts · equal in all 77 tables",
            "ok  Content · 804 rows read back and compared (500 at random per big table)",
            "ok  Links between rows · the same 52 kinds of link on both sides (70 row(s) already pointed at a deleted row in the source and still do)",
            "ok  Counters · the next ticket number carries on from prefix 0 plain-2,147,483,648",
            "ok  Docs search · 3 of 1 pages indexed",
            "verified  counts, samples, links, counters",
            "Next: point the app at it with \"kanban-db use <dir>/copy.db\" or from Settings.  Exit 0",
        ]
    );
    assert!(ran[6].1.ends_with(
        "The target is not empty (95 tables).\n\
         Pass --empty-first to delete what it holds, or --resume to go on with an interrupted copy."
    ));
    assert!(ran[7].1.ends_with("Not confirmed; nothing was written."));
    assert_eq!(ran[9].1, "The source and the target are the same database.");
    assert_eq!(ran[10].1, "The source does not hold a Kanban board.");
    assert_eq!(ran[11].1, "FAIL  Cannot reach the server · 127.0.0.1:1");
    assert!(ran[12].1.ends_with(
        "\nThe copy stopped at table project, row 1 of 4.\n\
         error      Data too long for column 'name' at row 1\n\
         column     project.name  (VARCHAR → VARCHAR)\n\
         value      70,000 characters\n\
         30 of 77 tables are done. Fix the target, then run again with --resume."
    ));
    assert_eq!(
        ran[13].1,
        "The app now uses SQLite at <dir>/copy.db.\n\
         A running board and its MCP processes switch within a few seconds; nothing needs a restart."
    );
    assert_eq!(ran[14].1, "That database holds something that is not a Kanban board.");
    assert!(ran[16].2.ends_with("kanban-db migrate: error: the following arguments are required: --to"));
    assert!(ran[17].2.ends_with("kanban-db: error: the following arguments are required: cmd"));
    let config = std::fs::read_to_string(home.join("config").join("config.json")).expect("the saved choice");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&config).expect("json")["database"],
        serde_json::json!({"engine": "sqlite"})
    );

    // the same story by the Python script
    if !server_dir().join(".venv/bin/python").is_file() {
        println!("SKIPPED the comparison with python -m dbkit.cli: the Python virtualenv is not there");
        return;
    }
    let dir = tmp_path.join("python");
    let python_home = tmp_path.join("python-home");
    prepare(&dir).await;
    let mut at = 0;
    for command in story() {
        if command == ["TRIGGER"] {
            add_trigger(&dir).await;
            continue;
        }
        let args = words(&command, &dir);
        let home = python_home.clone();
        let run_args = args.clone();
        let (code, out, err) = tokio::task::spawn_blocking(move || python(&run_args, &home)).await.expect("python");
        // the Python script also logged each migration it ran to make a new SQLite file
        let err = if err.contains("INFO  [alembic") { String::new() } else { normalized(&err, &dir) };
        let said = (code, normalized(&out, &dir), err);
        assert_eq!(ran[at], said, "kanban-db {}", command.join(" "));
        at += 1;
    }
    assert_eq!(at, ran.len());
}
