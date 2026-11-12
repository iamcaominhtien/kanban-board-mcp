//! kanban-db: move the board's data between SQLite, PostgreSQL and MySQL/MariaDB from a terminal (design D3).
//!
//! ```text
//! kanban-db test postgresql://kanban@db.internal/kanban
//! kanban-db migrate --from sqlite:///~/kanban-data/kanban.db --to postgresql://kanban@db.internal/kanban --dry-run
//! kanban-db migrate --from sqlite:///~/kanban-data/kanban.db --to postgresql://kanban@db.internal/kanban --verify
//! kanban-db use postgresql://kanban@db.internal/kanban
//! ```
//!
//! The same copy code as App settings › Storage & backup. KANBAN_DB_PASSWORD gives the target's password, so it is
//! not in your shell history (KANBAN_DB_FROM_PASSWORD the source's).
//!
//! Exit codes: 0 done · 1 verify failed · 2 cannot connect · 3 target not empty · 4 stopped (resume it).

use std::io::{IsTerminal, Write};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use kb_base::pytext;
use kb_db::targets::{self, Target, TargetError};
use serde_json::Value;

use crate::move_db::raw::{self, Direct};
use crate::move_db::{self, Event, Mover, Progress, TableState, app_tables, commas, summary_line};
use crate::probe;

pub const EXIT_OK: i32 = 0;
pub const EXIT_VERIFY: i32 = 1;
pub const EXIT_CONNECT: i32 = 2;
pub const EXIT_NOT_EMPTY: i32 = 3;
pub const EXIT_STOPPED: i32 = 4;
const GREEN: &str = "\x1b[32m";
const AMBER: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

const USAGE: &str = "usage: kanban-db [-h] {test,migrate,use} ...\n";
const HELP: &str = "usage: kanban-db [-h] {test,migrate,use} ...

kanban-db: move the board's data between SQLite, PostgreSQL and MySQL/MariaDB
from a terminal (design D3).

positional arguments:
  {test,migrate,use}
    test              Test a database: reach, sign in, version, rights, empty?
    migrate           Copy the board from one database to another
    use               Point the app at a database (saved in ~/.kanban-
                      board/config.json)

options:
  -h, --help          show this help message and exit
";
const MIGRATE_USAGE: &str = "usage: kanban-db migrate [-h] --from SOURCE --to TARGET [--dry-run] [--verify]
                         [--resume] [--empty-first] [--yes-empty NAME]
";
const MIGRATE_HELP: &str = "
options:
  -h, --help        show this help message and exit
  --from SOURCE     The database to read
  --to TARGET       The database to write (empty)
  --dry-run         Check both ends and print the plan; write nothing
  --verify          Compare counts, samples, links and counters after
  --resume          Continue an interrupted copy
  --empty-first     Delete what the target holds first
  --yes-empty NAME  Confirm --empty-first without a prompt
";

/// Where the command line writes: the terminal, or a buffer a test reads.
#[derive(Clone)]
pub struct Out {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
    err: Arc<Mutex<Box<dyn Write + Send>>>,
    tty: bool,
}

impl Out {
    /// The process's own standard output and error.
    pub fn stdio() -> Out {
        Out {
            out: Arc::new(Mutex::new(Box::new(std::io::stdout()))),
            err: Arc::new(Mutex::new(Box::new(std::io::stderr()))),
            tty: std::io::stdout().is_terminal(),
        }
    }

    /// Two writers of the caller's (not a terminal: no colors, no progress line).
    pub fn to(out: Box<dyn Write + Send>, err: Box<dyn Write + Send>) -> Out {
        Out { out: Arc::new(Mutex::new(out)), err: Arc::new(Mutex::new(err)), tty: false }
    }

    fn write(&self, text: &str) {
        let mut out = self.out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }

    /// `print(text)`.
    fn print(&self, text: impl AsRef<str>) {
        self.write(&format!("{}\n", text.as_ref()));
    }

    fn error(&self, text: impl AsRef<str>) {
        let mut err = self.err.lock().unwrap_or_else(|e| e.into_inner());
        let _ = err.write_all(text.as_ref().as_bytes());
        let _ = err.flush();
    }

    fn color(&self, code: &str, text: impl AsRef<str>) -> String {
        if self.tty { format!("{code}{}{RESET}", text.as_ref()) } else { text.as_ref().to_string() }
    }
}

fn target_of(url: &str, env: &str) -> Result<Target, TargetError> {
    let mut target = targets::from_url(url)?;
    let password = std::env::var(env).unwrap_or_default();
    if !target.is_sqlite() && target.password.as_deref().is_none_or(str::is_empty) && !password.is_empty() {
        target = target.with_password(Some(password));
    }
    Ok(target)
}

fn line(out: &Out, label: &str, value: &str) {
    out.print(format!("{label:<9}{value}"));
}

/// What a command ends with besides its exit code.
enum Fail {
    Target(TargetError),
    /// An exception the Python script did not catch: it ended with a traceback and exit code 1.
    Crash(String),
}

impl From<TargetError> for Fail {
    fn from(err: TargetError) -> Self {
        Fail::Target(err)
    }
}

impl From<kb_db::sea_orm::DbErr> for Fail {
    fn from(err: kb_db::sea_orm::DbErr) -> Self {
        Fail::Crash(err.to_string())
    }
}

impl From<move_db::Error> for Fail {
    fn from(err: move_db::Error) -> Self {
        Fail::Crash(err.to_string())
    }
}

async fn test(out: &Out, url: &str) -> Result<i32, Fail> {
    let report = probe::test(&target_of(url, targets::ENV_PASSWORD)?).await?;
    for f in &report.findings {
        let mark = match f.level.as_str() {
            "ok" => out.color(GREEN, "ok  "),
            "warn" => out.color(AMBER, "note"),
            "info" => out.color(DIM, "info"),
            _ => out.color(RED, "FAIL"),
        };
        out.print(format!("{mark}  {}", f.title));
        if matches!(f.level.as_str(), "warn" | "error") && !f.detail.is_empty() {
            out.print(format!("      {}", f.detail));
        }
        if !f.fix.is_empty() {
            for fix_line in pytext::splitlines(&f.fix) {
                out.print(format!("      {}", out.color(DIM, fix_line)));
            }
        }
    }
    Ok(if report.ok() { EXIT_OK } else { EXIT_CONNECT })
}

/// The table an interrupted copy stopped in: tables are copied in order and each one completely or not at all.
async fn first_unfinished(m: &mut Mover) -> Result<Option<&'static str>, move_db::Error> {
    let mut conn = Direct::connect(&m.dst().await?).await?;
    let mut found = None;
    for (t, state) in app_tables().iter().zip(m.tables()) {
        let n = match raw::count(&mut conn, t.name).await {
            Ok(n) => n,
            Err(err) => {
                conn.close().await;
                return Err(err.into());
            }
        };
        if n != state.rows {
            found = Some(t.name);
            break;
        }
    }
    conn.close().await;
    Ok(found)
}

/// The arguments of `migrate`.
#[derive(Debug, Default, Clone, PartialEq)]
struct Migrate {
    source: String,
    target: String,
    dry_run: bool,
    verify: bool,
    resume: bool,
    empty_first: bool,
    yes_empty: Option<String>,
}

async fn migrate(out: &Out, args: &Migrate) -> Result<i32, Fail> {
    let source = target_of(&args.source, "KANBAN_DB_FROM_PASSWORD")?;
    let target = target_of(&args.target, targets::ENV_PASSWORD)?;
    let report = probe::test(&target).await?;
    if !report.ok() {
        for f in &report.findings {
            if f.level == "error" {
                out.print(out.color(RED, format!("FAIL  {}", f.title)));
                if !f.fix.is_empty() {
                    out.print(format!("      {}", f.fix));
                }
            }
        }
        return Ok(EXIT_CONNECT);
    }
    let started = Instant::now();
    let tables: Arc<Mutex<Option<Arc<Mutex<Vec<TableState>>>>>> = Arc::new(Mutex::new(None));
    let last = Arc::new(Mutex::new(None::<Instant>));
    let progress: Progress = {
        let (out, tables, last) = (out.clone(), tables.clone(), last.clone());
        Arc::new(move |event| {
            let (out, tables, last) = (out.clone(), tables.clone(), last.clone());
            Box::pin(async move {
                match event {
                    Event::TableDone { table, .. } => {
                        let rows = tables
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .as_ref()
                            .and_then(|t| {
                                t.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|s| s.name == table).map(|s| s.rows)
                            })
                            .unwrap_or(0);
                        out.print(format!("{table:<26}{} / {}", commas(rows), commas(rows)));
                    }
                    Event::Rows { table, copied, rows } => {
                        let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
                        if out.tty && last.is_none_or(|at| at.elapsed().as_secs_f64() > 0.5) {
                            *last = Some(Instant::now());
                            out.write(&format!("{table:<26}{} / {}\r", commas(copied), commas(rows)));
                        }
                    }
                    Event::Table { .. } => {}
                }
            })
        })
    };
    let mut m = match Mover::new(source, target.clone(), Some(progress)).await {
        Ok(m) => m,
        Err(move_db::Error::Move(exc)) => {
            out.print(out.color(RED, &exc.message));
            return Ok(EXIT_CONNECT);
        }
        Err(other) => return Err(other.into()),
    };
    *tables.lock().unwrap_or_else(|e| e.into_inner()) = Some(m.tables_handle());
    let outcome = async {
        m.open().await?;
        copy(out, args, &mut m, &target, &report, started).await
    }
    .await;
    m.close().await;
    if let Some(code) = outcome? {
        return Ok(code);
    }
    let shown = if target.is_sqlite() {
        target.display()
    } else {
        format!("{}://{}@{}/{}", target.engine, target.user, target.host, target.name)
    };
    out.print(format!("Next: point the app at it with \"kanban-db use {shown}\" or from Settings.  Exit 0"));
    Ok(EXIT_OK)
}

/// What `migrate` does with both ends open; `Some(code)` when it ends before the last line.
async fn copy(
    out: &Out,
    args: &Migrate,
    m: &mut Mover,
    target: &Target,
    report: &probe::Report,
    started: Instant,
) -> Result<Option<i32>, Fail> {
    let plan = match m.plan().await {
        Ok(plan) => plan,
        Err(move_db::Error::Move(exc)) => {
            out.print(out.color(RED, &exc.message));
            return Ok(Some(EXIT_CONNECT));
        }
        Err(other) => return Err(other.into()),
    };
    let label = plan.source.get("label").and_then(Value::as_str).unwrap_or("");
    line(out, "Source", &format!("{label}, {}, schema at head", summary_line(&plan)));
    line(out, "Target", &format!("{}, {}", report.version, report.state));
    if report.state != "empty" && !(args.resume || args.empty_first) {
        out.print(out.color(RED, format!("The target is not empty ({} tables).", report.tables)));
        out.print("Pass --empty-first to delete what it holds, or --resume to go on with an interrupted copy.");
        return Ok(Some(EXIT_NOT_EMPTY));
    }
    out.print(format!("{}  target can create tables", out.color(GREEN, "ok")));
    out.print(format!(
        "{}  copy order resolved from foreign keys ({} tables)",
        out.color(GREEN, "ok"),
        plan.tables.len()
    ));
    for p in &plan.problems {
        out.print(format!("{}  {}", out.color(AMBER, "note"), p["title"].as_str().unwrap_or("")));
    }
    for n in &plan.notes {
        out.print(format!("{}  {}", out.color(DIM, "note"), n["title"].as_str().unwrap_or("")));
    }
    if args.dry_run {
        out.print("Dry run: nothing was written.  Exit 0");
        return Ok(Some(EXIT_OK));
    }
    if args.empty_first && report.state != "empty" {
        let name = if target.name.is_empty() { target.path.clone() } else { target.name.clone() };
        let typed = match args.yes_empty.clone().filter(|y| !y.is_empty()) {
            Some(typed) => typed,
            None => {
                out.write(&format!("Type {name} to delete every table in it: "));
                let mut typed = String::new();
                match std::io::stdin().read_line(&mut typed) {
                    Ok(n) if n > 0 => pytext::strip(&typed).to_string(),
                    _ => return Err(Fail::Crash("EOFError: EOF when reading a line".into())),
                }
            }
        };
        if typed != name {
            out.print("Not confirmed; nothing was written.");
            return Ok(Some(EXIT_NOT_EMPTY));
        }
    }
    let copied = async {
        m.prepare_target(args.empty_first, args.resume).await?;
        let mut start_at = None;
        if args.resume {
            start_at = first_unfinished(m).await?;
            if let Some(start_at) = start_at {
                out.print(format!("Resuming from {start_at}"));
            }
        }
        m.copy(start_at, None).await
    }
    .await;
    match copied {
        Ok(()) => {}
        Err(move_db::Error::Move(exc)) => {
            out.print(out.color(RED, &exc.message));
            return Ok(Some(if exc.code == "target_not_empty" { EXIT_NOT_EMPTY } else { EXIT_CONNECT }));
        }
        Err(move_db::Error::Stopped(s)) => {
            out.print("");
            out.print(out.color(
                RED,
                format!("The copy stopped at table {}, row {} of {}.", s.table, commas(s.row), commas(s.total)),
            ));
            out.print(format!("error      {}", s.error));
            if let Some(column) = &s.column {
                out.print(format!(
                    "column     {}.{column}  ({} → {})",
                    s.table,
                    s.source_type.as_deref().unwrap_or("None"),
                    s.target_type.as_deref().unwrap_or("None")
                ));
            }
            if let Some(length) = s.value_length {
                out.print(format!("value      {} characters", commas(length as i64)));
            }
            out.print(format!(
                "{} of {} tables are done. Fix the target, then run again with --resume.",
                s.tables_done, s.tables_total
            ));
            return Ok(Some(EXIT_STOPPED));
        }
        Err(other) => return Err(other.into()),
    }
    let took = started.elapsed().as_secs_f64();
    let tables = m.tables();
    let rows: i64 = tables.iter().map(|s| s.rows).sum();
    out.print(format!(
        "copied    {} tables, {} rows, {} min {} s",
        tables.len(),
        commas(rows),
        (took / 60.0).floor() as i64,
        (took % 60.0).floor() as i64
    ));
    if args.verify {
        let result = m.verify(None).await?;
        for c in result["checks"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let mark = if c["ok"] == Value::Bool(true) { out.color(GREEN, "ok") } else { out.color(RED, "FAIL") };
            out.print(format!("{mark}  {}", c["title"].as_str().unwrap_or("")));
        }
        if result["ok"] != Value::Bool(true) {
            return Ok(Some(EXIT_VERIFY));
        }
        out.print("verified  counts, samples, links, counters");
    }
    Ok(None)
}

async fn use_database(out: &Out, url: &str) -> Result<i32, Fail> {
    let target = target_of(url, targets::ENV_PASSWORD)?;
    let report = probe::test(&target).await?;
    if !report.ok() {
        out.print(out.color(RED, "The database did not pass the test:"));
        for f in &report.findings {
            if f.level == "error" {
                out.print(format!("  {}", f.title));
            }
        }
        return Ok(EXIT_CONNECT);
    }
    if !matches!(report.state.as_str(), "board" | "empty") {
        out.print(out.color(RED, "That database holds something that is not a Kanban board."));
        return Ok(EXIT_NOT_EMPTY);
    }
    targets::save_choice(&target).map_err(|err| Fail::Crash(err.to_string()))?;
    out.print(format!("The app now uses {} at {}.", target.label(), target.display()));
    out.print("A running board and its MCP processes switch within a few seconds; nothing needs a restart.");
    if !std::env::var(targets::ENV_URL).unwrap_or_default().is_empty() {
        out.print(out.color(AMBER, format!("Note: {} is set here and wins over this setting.", targets::ENV_URL)));
    }
    Ok(EXIT_OK)
}

/// What the command line asks for.
#[derive(Debug, Clone, PartialEq)]
enum Command {
    Test(String),
    Migrate(Migrate),
    Use(String),
}

/// How parsing ends when it does not give a command: text for standard output (help) or standard error, and the
/// exit code.
#[derive(Debug, Clone, PartialEq)]
struct Exit {
    out: String,
    err: String,
    code: i32,
}

fn usage_error(usage: &str, prog: &str, message: &str) -> Exit {
    Exit { out: String::new(), err: format!("{usage}{prog}: error: {message}\n"), code: 2 }
}

fn help(text: String) -> Exit {
    Exit { out: text, err: String::new(), code: 0 }
}

const MIGRATE_OPTIONS: [(&str, bool); 7] = [
    ("--from", true),
    ("--to", true),
    ("--dry-run", false),
    ("--verify", false),
    ("--resume", false),
    ("--empty-first", false),
    ("--yes-empty", true),
];

/// `parser.parse_args(argv)`, for the three commands of this script.
fn parse(args: &[String]) -> Result<Command, Exit> {
    let Some(cmd) = args.first() else {
        return Err(usage_error(USAGE, "kanban-db", "the following arguments are required: cmd"));
    };
    if cmd == "-h" || cmd == "--help" {
        return Err(help(HELP.to_string()));
    }
    let rest = &args[1..];
    match cmd.as_str() {
        "test" | "use" => {
            let usage = format!("usage: kanban-db {cmd} [-h] url\n");
            if rest.iter().any(|a| a == "-h" || a == "--help") {
                return Err(help(format!(
                    "{usage}\npositional arguments:\n  url\n\noptions:\n  -h, --help  show this help message and exit\n"
                )));
            }
            let (flags, positional): (Vec<&String>, Vec<&String>) =
                rest.iter().partition(|a| a.starts_with('-') && a.len() > 1);
            let Some(url) = positional.first() else {
                return Err(usage_error(
                    &usage,
                    &format!("kanban-db {cmd}"),
                    "the following arguments are required: url",
                ));
            };
            let extra: Vec<&str> = flags.iter().chain(positional.iter().skip(1)).map(|a| a.as_str()).collect();
            if !extra.is_empty() {
                // in the order they were typed
                let typed: Vec<&str> =
                    rest.iter().map(String::as_str).filter(|a| extra.contains(a) && *a != url.as_str()).collect();
                return Err(usage_error(
                    USAGE,
                    "kanban-db",
                    &format!("unrecognized arguments: {}", typed.join(" ")),
                ));
            }
            Ok(if cmd == "test" { Command::Test((*url).clone()) } else { Command::Use((*url).clone()) })
        }
        "migrate" => parse_migrate(rest).map(Command::Migrate),
        other => Err(usage_error(
            USAGE,
            "kanban-db",
            &format!("argument cmd: invalid choice: {} (choose from 'test', 'migrate', 'use')", pytext::repr(other)),
        )),
    }
}

fn parse_migrate(rest: &[String]) -> Result<Migrate, Exit> {
    let prog = "kanban-db migrate";
    let mut found = Migrate::default();
    let (mut source, mut target) = (None, None);
    let mut unknown: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let arg = rest[i].as_str();
        i += 1;
        if arg == "-h" || arg == "--help" {
            return Err(help(format!("{MIGRATE_USAGE}{MIGRATE_HELP}")));
        }
        if !arg.starts_with("--") {
            unknown.push(arg);
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (arg, None),
        };
        // an option may be shortened as long as it still names one option
        let matches: Vec<&(&str, bool)> = match MIGRATE_OPTIONS.iter().find(|(option, _)| *option == name) {
            Some(exact) => vec![exact],
            None => MIGRATE_OPTIONS.iter().filter(|(option, _)| option.starts_with(name)).collect(),
        };
        let (option, takes_value) = match matches.as_slice() {
            [] => {
                unknown.push(arg);
                continue;
            }
            [one] => **one,
            many => {
                let names: Vec<&str> = many.iter().map(|(option, _)| *option).collect();
                return Err(usage_error(
                    MIGRATE_USAGE,
                    prog,
                    &format!("ambiguous option: {name} could match {}", names.join(", ")),
                ));
            }
        };
        let value = if takes_value {
            match inline {
                Some(value) => Some(value),
                None => match rest.get(i).filter(|next| !next.starts_with('-') || next.len() == 1) {
                    Some(next) => {
                        i += 1;
                        Some(next.clone())
                    }
                    None => {
                        return Err(usage_error(
                            MIGRATE_USAGE,
                            prog,
                            &format!("argument {option}: expected one argument"),
                        ));
                    }
                },
            }
        } else {
            if inline.is_some() {
                return Err(usage_error(
                    MIGRATE_USAGE,
                    prog,
                    &format!("argument {option}: ignored explicit argument {}", pytext::repr(&inline.unwrap_or_default())),
                ));
            }
            None
        };
        match option {
            "--from" => source = value,
            "--to" => target = value,
            "--dry-run" => found.dry_run = true,
            "--verify" => found.verify = true,
            "--resume" => found.resume = true,
            "--empty-first" => found.empty_first = true,
            _ => found.yes_empty = value,
        }
    }
    let missing: Vec<&str> =
        [("--from", source.is_none()), ("--to", target.is_none())].iter().filter(|(_, m)| *m).map(|(n, _)| *n).collect();
    if !missing.is_empty() {
        return Err(usage_error(
            MIGRATE_USAGE,
            prog,
            &format!("the following arguments are required: {}", missing.join(", ")),
        ));
    }
    if !unknown.is_empty() {
        return Err(usage_error(USAGE, "kanban-db", &format!("unrecognized arguments: {}", unknown.join(" "))));
    }
    found.source = source.unwrap_or_default();
    found.target = target.unwrap_or_default();
    Ok(found)
}

/// Run the command line, writing to `out`. `args` are the words after the program's name.
pub async fn run(args: Vec<String>, out: Out) -> i32 {
    let command = match parse(&args) {
        Ok(command) => command,
        Err(exit) => {
            out.write(&exit.out);
            out.error(&exit.err);
            return exit.code;
        }
    };
    let done = match &command {
        Command::Test(url) => test(&out, url).await,
        Command::Migrate(args) => migrate(&out, args).await,
        Command::Use(url) => use_database(&out, url).await,
    };
    match done {
        Ok(code) => code,
        Err(Fail::Target(exc)) => {
            out.print(out.color(RED, &exc.0));
            EXIT_CONNECT
        }
        Err(Fail::Crash(message)) => {
            out.error(format!("{message}\n"));
            1
        }
    }
}

/// Run the command line (`python -m dbkit.cli ...`): `args` are the words after the program's name; the result is
/// the exit code.
pub async fn main(args: Vec<String>) -> i32 {
    run(args, Out::stdio()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn the_arguments_are_read_as_argparse_read_them() {
        assert_eq!(parse(&words("test sqlite:///x.db")), Ok(Command::Test("sqlite:///x.db".into())));
        assert_eq!(parse(&words("use mysql://h/db")), Ok(Command::Use("mysql://h/db".into())));
        assert_eq!(
            parse(&words("migrate --fr a --to=b --dry --ver --yes-empty n")),
            Ok(Command::Migrate(Migrate {
                source: "a".into(),
                target: "b".into(),
                dry_run: true,
                verify: true,
                yes_empty: Some("n".into()),
                ..Migrate::default()
            }))
        );
        let err = |text: &str| parse(&words(text)).unwrap_err();
        assert_eq!(err("").err, "usage: kanban-db [-h] {test,migrate,use} ...\nkanban-db: error: the following arguments are required: cmd\n");
        assert_eq!(err("").code, 2);
        assert_eq!(
            err("bogus").err,
            "usage: kanban-db [-h] {test,migrate,use} ...\n\
             kanban-db: error: argument cmd: invalid choice: 'bogus' (choose from 'test', 'migrate', 'use')\n"
        );
        assert_eq!(
            err("test").err,
            "usage: kanban-db test [-h] url\nkanban-db test: error: the following arguments are required: url\n"
        );
        assert_eq!(
            err("test a b").err,
            "usage: kanban-db [-h] {test,migrate,use} ...\nkanban-db: error: unrecognized arguments: b\n"
        );
        assert_eq!(
            err("migrate --from x").err,
            format!("{MIGRATE_USAGE}kanban-db migrate: error: the following arguments are required: --to\n")
        );
        assert_eq!(
            err("migrate --from a --to b --bogus").err,
            "usage: kanban-db [-h] {test,migrate,use} ...\nkanban-db: error: unrecognized arguments: --bogus\n"
        );
        assert_eq!(
            err("migrate --from a --to b --yes-empty").err,
            format!("{MIGRATE_USAGE}kanban-db migrate: error: argument --yes-empty: expected one argument\n")
        );
        assert_eq!(
            err("migrate --fr a --to b --dry --ver extra").err,
            "usage: kanban-db [-h] {test,migrate,use} ...\nkanban-db: error: unrecognized arguments: extra\n"
        );
        assert_eq!((err("-h").out.as_str(), err("-h").code), (HELP, 0));
        assert!(err("migrate -h").out.ends_with("--yes-empty NAME  Confirm --empty-first without a prompt\n"));
        assert_eq!(
            err("use -h").out,
            "usage: kanban-db use [-h] url\n\npositional arguments:\n  url\n\noptions:\n  -h, --help  show this help message and exit\n"
        );
    }
}
