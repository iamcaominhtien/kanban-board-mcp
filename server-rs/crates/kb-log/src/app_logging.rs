//! Persistent application log: rotating file setup and time-range export.
//!
//! Log lines look like `2026-10-12T10:15:30.123+07:00 ERROR logger.name message`; a
//! traceback or any other line that does not start with a timestamp belongs to the
//! record above it, so a range export never cuts a stack trace in half.

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use chrono::{DateTime, FixedOffset, Local, NaiveDateTime, Offset, TimeZone, Utc};
use kb_base::time::{Parsed, iso_millis, parse_iso};
use regex::Regex;
use tracing_subscriber::Layer as _;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;

use crate::layer::{FileLayer, LogWriter};

/// File of the server process.
pub const LOG_FILE_NAME: &str = "kanban.log";
/// Each kind of process writes its own file: several processes rotating one file corrupt it
/// (and fail outright on Windows). Export merges them back into one timeline.
pub const STDIO_LOG_FILE_NAME: &str = "kanban-mcp-stdio.log";
const LOG_FILE_NAMES: [&str; 2] = [LOG_FILE_NAME, STDIO_LOG_FILE_NAME];
/// Size at which the active file is rotated.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Number of rotated files kept (`kanban.log.1` ... `.5`).
pub const BACKUP_COUNT: u32 = 5;

/// Level names with their numeric values, as Python's `logging` has them.
pub const LEVELS: [(&str, u32); 5] = [
    ("DEBUG", 10),
    ("INFO", 20),
    ("WARNING", 30),
    ("ERROR", 40),
    ("CRITICAL", 50),
];

/// `LEVELS.get(name)`: the numeric value of an exact (upper case) level name.
pub fn level_value(name: &str) -> Option<u32> {
    LEVELS.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

static RECORD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d{4}-\d{2}-\d{2}T\S+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) ")
        .expect("the record pattern is valid")
});
static NEWLINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\r\n|\r|\n").expect("the newline pattern is valid"));

/// Whether a line starts a record of its own (`2026-... LEVEL `).
pub fn is_record_start(line: &str) -> bool {
    RECORD_RE.is_match(line)
}

/// A log level, with the names Python prints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// `DEBUG` (also tracing's TRACE).
    Debug,
    /// `INFO`.
    Info,
    /// `WARNING` (tracing's WARN).
    Warning,
    /// `ERROR`.
    Error,
    /// `CRITICAL`: uncaught exceptions.
    Critical,
}

impl Level {
    /// The name written to the log.
    pub fn name(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warning => "WARNING",
            Level::Error => "ERROR",
            Level::Critical => "CRITICAL",
        }
    }

    /// TRACE and DEBUG are DEBUG, WARN is WARNING.
    pub fn from_tracing(level: &tracing::Level) -> Self {
        match *level {
            tracing::Level::ERROR => Level::Error,
            tracing::Level::WARN => Level::Warning,
            tracing::Level::INFO => Level::Info,
            _ => Level::Debug,
        }
    }
}

/// A `RotatingFileHandler` that keeps logging when another process holds the file during rollover
/// (`_SafeRotatingFileHandler`).
pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    backup_count: u32,
    file: Option<File>,
}

impl RotatingFile {
    /// Open `path` for appending; the folder must exist.
    pub fn open(path: &Path, max_bytes: u64, backup_count: u32) -> std::io::Result<Self> {
        let mut rotating = Self {
            path: path.to_path_buf(),
            max_bytes,
            backup_count,
            file: None,
        };
        rotating.file = Some(rotating.open_file()?);
        Ok(rotating)
    }

    fn open_file(&self) -> std::io::Result<File> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
    }

    fn numbered(&self, i: u32) -> PathBuf {
        PathBuf::from(format!("{}.{i}", self.path.display()))
    }

    /// `shouldRollover`: the file would reach `max_bytes` with this message (and its newline).
    fn should_rollover(&self, message: &str) -> bool {
        let Some(file) = &self.file else { return false };
        if self.max_bytes == 0 {
            return false;
        }
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        size + message.chars().count() as u64 + 1 >= self.max_bytes
    }

    /// `doRollover`: the rename chain `.4` -> `.5` ... file -> `.1`, newest is `.1`.
    fn rotate_files(&self) -> std::io::Result<()> {
        if self.backup_count == 0 {
            return Ok(());
        }
        for i in (1..self.backup_count).rev() {
            let (source, dest) = (self.numbered(i), self.numbered(i + 1));
            if source.exists() {
                if dest.exists() {
                    fs::remove_file(&dest)?;
                }
                fs::rename(&source, &dest)?;
            }
        }
        let dest = self.numbered(1);
        if dest.exists() {
            fs::remove_file(&dest)?;
        }
        if self.path.exists() {
            fs::rename(&self.path, &dest)?;
        }
        Ok(())
    }

    fn do_rollover(&mut self) {
        self.file = None;
        // A failed rotation (Windows refusing to rename an open file, another process holding it) is ignored;
        // the file is reopened and logging goes on.
        let _ = self.rotate_files();
        self.file = self.open_file().ok();
    }

    /// Write one record (`message` has no line terminator), rotating first when it would not fit.
    pub fn emit(&mut self, message: &str) {
        if self.file.is_none() {
            self.file = self.open_file().ok();
        }
        if self.should_rollover(message) {
            self.do_rollover();
        }
        if let Some(file) = &mut self.file {
            let _ = file.write_all(format!("{message}\n").as_bytes());
        }
    }
}

/// Format a record: `<time> <LEVEL> <name> <message>`. A later line that reads like a record of its own is indented.
///
/// Logged values can come from a request (an id, a client error message). Without this, one
/// holding a newline and a timestamp would add a fake record to the log and to its export.
pub fn format_record(
    time: DateTime<FixedOffset>,
    level: Level,
    name: &str,
    message: &str,
) -> String {
    let text = format!("{} {} {name} {message}", iso_millis(&time), level.name());
    // The reader reads with universal newlines, so \r and \r\n end a line as well
    let mut lines = NEWLINE_RE.split(&text);
    let mut out = String::from(lines.next().unwrap_or(""));
    for line in lines {
        out.push('\n');
        if RECORD_RE.is_match(line) {
            out.push_str("  ");
        }
        out.push_str(line);
    }
    out
}

/// The folder for the log files from the value of `KANBAN_LOG_DIR`, else `~/.kanban-board/logs`.
pub fn log_dir_from(env: Option<&str>) -> PathBuf {
    match env.map(str::trim) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => kb_base::config::home_dir()
            .join(".kanban-board")
            .join("logs"),
    }
}

/// Return the folder holding the log files (`KANBAN_LOG_DIR`, else `~/.kanban-board/logs`).
///
/// It is deliberately independent of the data folder so the log survives moving or
/// importing data, and is still writable when the database cannot be opened.
pub fn get_log_dir() -> PathBuf {
    log_dir_from(std::env::var("KANBAN_LOG_DIR").ok().as_deref())
}

/// Return the path of the active log file.
pub fn get_log_path() -> PathBuf {
    get_log_dir().join(LOG_FILE_NAME)
}

static WRITER: OnceLock<Arc<LogWriter>> = OnceLock::new();
static SETUP: Mutex<()> = Mutex::new(());

/// Send every `tracing` event (and uncaught panics) to the log file in `dir`.
///
/// Safe to call more than once. A log folder that cannot be written is not fatal: the app keeps running without a
/// file log (the result is false). Never writes to stdout, which carries the protocol of the stdio MCP process.
pub fn setup_logging_in(dir: &Path, stdio: bool) -> bool {
    let _guard = SETUP.lock().unwrap_or_else(|e| e.into_inner());
    if WRITER.get().is_some() {
        return true;
    }
    let name = if stdio {
        STDIO_LOG_FILE_NAME
    } else {
        LOG_FILE_NAME
    };
    let prefix = if stdio { "stdio:" } else { "" };
    let writer =
        match fs::create_dir_all(dir).and_then(|()| LogWriter::open(&dir.join(name), prefix)) {
            Ok(writer) => Arc::new(writer),
            Err(_) => return false,
        };
    let _ = WRITER.set(Arc::clone(&writer));
    // Root level INFO. Another global subscriber already installed is left alone (the panic hook still logs).
    let _ = tracing_subscriber::registry()
        .with(FileLayer::new(writer).with_filter(LevelFilter::INFO))
        .try_init();
    install_panic_hook();
    true
}

/// `setup_logging(stdio)`: [`setup_logging_in`] the folder of [`get_log_dir`].
pub fn setup_logging(stdio: bool) -> bool {
    setup_logging_in(&get_log_dir(), stdio)
}

/// Log at CRITICAL (Python's `logger.critical`, which `tracing` has no level for) once [`setup_logging`] succeeded.
pub fn critical(target: &str, message: &str) {
    if let Some(writer) = WRITER.get() {
        writer.log(Level::Critical, target, message);
    }
}

/// `sys.excepthook` / `threading.excepthook`: log the panic as `uncaught` at CRITICAL, then call the previous hook.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let text = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Box<dyn Any>".to_string());
        let location = info
            .location()
            .map(|l| format!(" at {}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let thread = std::thread::current();
        let head = match thread.name() {
            Some("main") | None => "Uncaught exception".to_string(),
            Some(name) => format!("Uncaught exception in thread {name}"),
        };
        critical("uncaught", &format!("{head}: {text}{location}"));
        previous(info);
    }));
}

/// Return existing files of one log in `dir`, oldest first (`<name>.5` ... `<name>`).
pub fn log_files_in(dir: &Path, name: &str) -> Vec<PathBuf> {
    let base = dir.join(name);
    let mut files: Vec<PathBuf> = (1..=BACKUP_COUNT)
        .rev()
        .map(|i| PathBuf::from(format!("{}.{i}", base.display())))
        .collect();
    files.push(base);
    files.into_iter().filter(|f| f.is_file()).collect()
}

/// `_log_files` in the folder of [`get_log_dir`].
pub fn log_files(name: &str) -> Vec<PathBuf> {
    log_files_in(&get_log_dir(), name)
}

/// Treat a naive datetime as local time.
pub fn aware_naive(dt: NaiveDateTime) -> DateTime<FixedOffset> {
    match Local.from_local_datetime(&dt).earliest() {
        Some(local) => local.fixed_offset(),
        None => Utc.fix().from_utc_datetime(&dt),
    }
}

/// `aware(dt)`: an aware time stays, a naive one is local time.
pub fn aware(dt: Parsed) -> DateTime<FixedOffset> {
    match dt {
        Parsed::Aware(dt) => dt,
        Parsed::Naive(dt) => aware_naive(dt),
    }
}

/// Records of one file: `(time, record)` that pass the filters.
fn read_file(
    path: &Path,
    since: Option<DateTime<FixedOffset>>,
    until: Option<DateTime<FixedOffset>>,
    threshold: u32,
) -> Vec<(DateTime<FixedOffset>, String)> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    // Python's text mode: invalid UTF-8 replaced, \r\n and \r read as \n
    let text = String::from_utf8_lossy(&bytes)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut out = Vec::new();
    let mut record = String::new();
    let mut have_record = false;
    let mut ts: Option<DateTime<FixedOffset>> = None;
    let mut keep = false;
    for line in text.split_inclusive('\n') {
        if let Some(caps) = RECORD_RE.captures(line) {
            if keep && let Some(t) = ts {
                out.push((t, std::mem::take(&mut record)));
            }
            record = line.to_string();
            have_record = true;
            let Some(parsed) = parse_iso(&caps[1]) else {
                ts = None;
                keep = false;
                continue;
            };
            let t = aware(parsed);
            ts = Some(t);
            keep = level_value(&caps[2]).is_some_and(|v| v >= threshold)
                && since.is_none_or(|s| t >= s)
                && until.is_none_or(|u| t <= u);
        } else if have_record {
            record.push_str(line);
        }
    }
    if keep && let Some(t) = ts {
        out.push((t, record));
    }
    out
}

type Stream = Box<dyn Iterator<Item = (DateTime<FixedOffset>, String)> + Send>;

/// `_read_log`: records of one log in `dir`, oldest first, read one file at a time.
fn read_log(
    dir: &Path,
    name: &str,
    since: Option<DateTime<FixedOffset>>,
    until: Option<DateTime<FixedOffset>>,
    threshold: u32,
) -> Stream {
    let files = log_files_in(dir, name);
    Box::new(
        files
            .into_iter()
            .flat_map(move |path| read_file(&path, since, until, threshold)),
    )
}

/// Error of [`iter_records`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogError {
    /// `min_level` is not a level name (`ValueError("Unknown level: ...")`).
    UnknownLevel(String),
}

impl std::fmt::Display for LogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogError::UnknownLevel(level) => write!(f, "Unknown level: {level}"),
        }
    }
}

impl std::error::Error for LogError {}

/// The merged records, like `heapq.merge`: smallest time first, a tie goes to the earlier stream.
pub struct RecordIter {
    streams: Vec<std::iter::Peekable<Stream>>,
}

impl Iterator for RecordIter {
    type Item = String;

    fn next(&mut self) -> Option<String> {
        let mut best: Option<(usize, DateTime<FixedOffset>)> = None;
        for (i, stream) in self.streams.iter_mut().enumerate() {
            if let Some((t, _)) = stream.peek()
                && best.is_none_or(|(_, b)| *t < b)
            {
                best = Some((i, *t));
            }
        }
        let (i, _) = best?;
        self.streams[i].next().map(|(_, text)| text)
    }
}

/// Yield log records (each possibly multi-line) within [since, until] at or above `min_level` from the files in `dir`.
///
/// Records of the server and the stdio MCP process are merged in time order. `since` and `until` are inclusive,
/// `None` means no bound (turn a naive time into local time with [`aware`] first).
///
/// # Errors
/// [`LogError::UnknownLevel`] if `min_level` is not a known level name.
pub fn iter_records_in(
    dir: &Path,
    since: Option<DateTime<FixedOffset>>,
    until: Option<DateTime<FixedOffset>>,
    min_level: &str,
) -> Result<RecordIter, LogError> {
    let threshold = level_value(&min_level.to_uppercase())
        .ok_or_else(|| LogError::UnknownLevel(min_level.to_string()))?;
    let streams = LOG_FILE_NAMES
        .iter()
        .map(|name| read_log(dir, name, since, until, threshold).peekable())
        .collect();
    Ok(RecordIter { streams })
}

/// [`iter_records_in`] the folder of [`get_log_dir`].
///
/// # Errors
/// [`LogError::UnknownLevel`] if `min_level` is not a known level name.
pub fn iter_records(
    since: Option<DateTime<FixedOffset>>,
    until: Option<DateTime<FixedOffset>>,
    min_level: &str,
) -> Result<RecordIter, LogError> {
    iter_records_in(&get_log_dir(), since, until, min_level)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn utc(h: u32, m: u32) -> DateTime<FixedOffset> {
        Utc.fix().with_ymd_and_hms(2026, 10, 12, h, m, 0).unwrap()
    }

    const SAMPLE: [&str; 7] = [
        "2026-10-12T10:00:00.000+00:00 INFO a started\n",
        "2026-10-12T10:05:00.000+00:00 ERROR a boom\n",
        "Traceback (most recent call last):\n",
        "  File \"x.py\", line 1\n",
        "ValueError: bad\n",
        "2026-10-12T10:10:00.000+00:00 WARNING b careful\n",
        "2026-10-12T11:00:00.000+00:00 INFO a later\n",
    ];

    fn write(dir: &Path, name: &str, lines: &[&str]) {
        fs::write(dir.join(name), lines.concat()).unwrap();
    }

    fn all(dir: &Path, level: &str) -> Vec<String> {
        iter_records_in(dir, None, None, level).unwrap().collect()
    }

    #[test]
    fn line_format() {
        let time = FixedOffset::east_opt(7 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 10, 12, 10, 15, 30)
            .unwrap()
            + chrono::Duration::milliseconds(123);
        assert_eq!(
            format_record(time, Level::Error, "kanban.http", "message"),
            "2026-10-12T10:15:30.123+07:00 ERROR kanban.http message"
        );
        let local = format_record(
            Local::now().fixed_offset(),
            Level::Warning,
            "t",
            "hello world",
        );
        let re = Regex::new(
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} WARNING t hello world$",
        )
        .unwrap();
        assert!(re.is_match(&local), "{local}");
    }

    #[test]
    fn level_names_and_mapping() {
        assert_eq!(Level::from_tracing(&tracing::Level::TRACE).name(), "DEBUG");
        assert_eq!(Level::from_tracing(&tracing::Level::DEBUG).name(), "DEBUG");
        assert_eq!(Level::from_tracing(&tracing::Level::INFO).name(), "INFO");
        assert_eq!(Level::from_tracing(&tracing::Level::WARN).name(), "WARNING");
        assert_eq!(Level::from_tracing(&tracing::Level::ERROR).name(), "ERROR");
        assert_eq!(Level::Critical.name(), "CRITICAL");
    }

    #[test]
    fn a_logged_value_cannot_add_a_fake_record() {
        let forged = "abc\n2026-01-01T00:00:00.000+00:00 CRITICAL admin password changed";
        let text = format_record(utc(1, 0), Level::Warning, "t", &format!("run {forged}"));
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(
            lines[1],
            "  2026-01-01T00:00:00.000+00:00 CRITICAL admin password changed"
        );
        assert_eq!(lines.iter().filter(|l| is_record_start(l)).count(), 1);
        assert!(is_record_start(lines[0]));
    }

    #[test]
    fn a_carriage_return_cannot_add_a_fake_record_either() {
        for newline in ["\r", "\r\n"] {
            let dir = tempfile::tempdir().unwrap();
            let forged = format!(
                "abc{newline}2026-01-01T00:00:00.000+00:00 CRITICAL admin password changed"
            );
            let writer = LogWriter::open(&dir.path().join(LOG_FILE_NAME), "").unwrap();
            writer.log(Level::Warning, "t", &format!("run {forged}"));
            let records = all(dir.path(), "DEBUG");
            assert_eq!(records.len(), 1, "{records:?}");
            assert!(records[0].contains("admin password changed"));
        }
    }

    #[test]
    fn a_traceback_stays_as_it_is() {
        let text = format_record(
            utc(1, 0),
            Level::Error,
            "t",
            "failed\nTraceback (most recent call last):\n  File \"x\"",
        );
        assert!(text.contains("\nTraceback (most recent call last):\n  File \"x\""));
    }

    #[test]
    fn range_filter_keeps_traceback_with_its_record() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), LOG_FILE_NAME, &SAMPLE);
        let out = iter_records_in(dir.path(), Some(utc(10, 3)), Some(utc(10, 30)), "DEBUG")
            .unwrap()
            .collect::<String>();
        assert!(out.contains("boom") && out.contains("ValueError: bad") && out.contains("careful"));
        assert!(!out.contains("started") && !out.contains("later"));
    }

    #[test]
    fn bounds_are_inclusive() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), LOG_FILE_NAME, &SAMPLE);
        let out = iter_records_in(dir.path(), Some(utc(10, 5)), Some(utc(10, 10)), "DEBUG")
            .unwrap()
            .collect::<Vec<_>>();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn level_filter() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), LOG_FILE_NAME, &SAMPLE);
        let out = all(dir.path(), "error").concat();
        assert!(out.contains("boom") && out.contains("ValueError"));
        assert!(!out.contains("careful") && !out.contains("started"));
    }

    #[test]
    fn rotated_files_are_read_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "kanban.log.1",
            &["2026-10-11T09:00:00.000+00:00 INFO old entry\n"],
        );
        write(dir.path(), LOG_FILE_NAME, &SAMPLE);
        let out = all(dir.path(), "DEBUG");
        assert!(out[0].contains("old entry"));
    }

    #[test]
    fn unknown_level_raises() {
        let dir = tempfile::tempdir().unwrap();
        let err = iter_records_in(dir.path(), None, None, "LOUD")
            .err()
            .unwrap();
        assert_eq!(err.to_string(), "Unknown level: LOUD");
    }

    #[test]
    fn stdio_and_server_logs_merge_in_time_order() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), LOG_FILE_NAME, &SAMPLE);
        write(
            dir.path(),
            STDIO_LOG_FILE_NAME,
            &["2026-10-12T10:07:00.000+00:00 ERROR stdio:mcp tool failed\n"],
        );
        let out = all(dir.path(), "DEBUG");
        assert_eq!(out.len(), 5);
        assert!(out[2].contains("tool failed") && out[3].contains("careful"));
    }

    #[test]
    fn equal_times_keep_server_before_stdio() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            LOG_FILE_NAME,
            &["2026-10-12T10:00:00.000+00:00 INFO a server\n"],
        );
        write(
            dir.path(),
            STDIO_LOG_FILE_NAME,
            &["2026-10-12T10:00:00.000+00:00 INFO stdio:a stdio\n"],
        );
        let out = all(dir.path(), "DEBUG");
        assert!(out[0].contains("server") && out[1].contains("stdio"));
    }

    #[test]
    fn different_offsets_compare_as_instants() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            LOG_FILE_NAME,
            &["2026-10-12T17:00:00.000+07:00 INFO a first\n"],
        );
        write(
            dir.path(),
            STDIO_LOG_FILE_NAME,
            &[
                "2026-10-12T09:30:00.000+00:00 INFO b second\n",
                "2026-10-12T10:30:00.000+00:00 INFO b third\n",
            ],
        );
        let out = all(dir.path(), "DEBUG");
        // 17:00+07:00 is 10:00Z: after 09:30Z, before 10:30Z
        assert!(out[0].contains("second") && out[1].contains("first") && out[2].contains("third"));
    }

    #[test]
    fn invalid_utf8_and_cr_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes =
            b"2026-10-12T10:00:00.000+00:00 INFO a bad \xff byte\r\ncontinued\rmore\n".to_vec();
        bytes.extend_from_slice(b"2026-10-12T10:01:00.000+00:00 INFO a next\n");
        fs::write(dir.path().join(LOG_FILE_NAME), bytes).unwrap();
        let out = all(dir.path(), "DEBUG");
        assert_eq!(out.len(), 2);
        assert_eq!(
            out[0],
            "2026-10-12T10:00:00.000+00:00 INFO a bad \u{fffd} byte\ncontinued\nmore\n"
        );
    }

    #[test]
    fn unparsable_time_drops_the_record_and_lines_before_any_record_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            LOG_FILE_NAME,
            &[
                "stray\n",
                "2026-13-45T99:00:00 INFO a bad time\n",
                "tail\n",
                "2026-10-12T10:00:00+00:00 INFO a ok\n",
            ],
        );
        let out = all(dir.path(), "DEBUG");
        assert_eq!(
            out,
            vec!["2026-10-12T10:00:00+00:00 INFO a ok\n".to_string()]
        );
    }

    #[test]
    fn naive_times_are_local() {
        let naive = NaiveDate::from_ymd_opt(2026, 10, 12)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let local = aware_naive(naive);
        assert_eq!(local.naive_local(), naive);
        assert_eq!(aware(Parsed::Aware(utc(1, 0))), utc(1, 0));
    }

    #[test]
    fn log_dir_from_env_value() {
        assert_eq!(log_dir_from(Some("  /x/y ")), PathBuf::from("/x/y"));
        assert!(log_dir_from(Some("  ")).ends_with(".kanban-board/logs"));
        assert!(log_dir_from(None).ends_with(".kanban-board/logs"));
    }

    #[test]
    fn rotation_names_and_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.log");
        let mut file = RotatingFile::open(&path, 100, 3).unwrap();
        for i in 0..30 {
            file.emit(&format!("line {i:02} {}", "x".repeat(30)));
        }
        for n in 1..=3 {
            assert!(
                dir.path().join(format!("x.log.{n}")).is_file(),
                "missing .{n}"
            );
        }
        assert!(!dir.path().join("x.log.4").exists());
        let newest = fs::read_to_string(dir.path().join("x.log.1")).unwrap();
        let oldest = fs::read_to_string(dir.path().join("x.log.3")).unwrap();
        let current = fs::read_to_string(&path).unwrap();
        // newest backup is .1: the lines of .1 come after those of .3 and before the active file
        assert!(oldest < newest && newest < current);
        assert!(current.contains("line 29"));
        for text in [&newest, &oldest, &current] {
            assert!(text.len() < 100 + 40);
        }
    }

    #[test]
    fn a_failed_rollover_does_not_stop_logging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.log");
        // a non-empty folder where the backup file should go: removing it fails
        fs::create_dir_all(dir.path().join("x.log.1/inner")).unwrap();
        let mut file = RotatingFile::open(&path, 50, 1).unwrap();
        for i in 0..5 {
            file.emit(&format!("line {i} {}", "x".repeat(30)));
        }
        assert!(fs::read_to_string(&path).unwrap().contains("line 4"));
    }

    #[test]
    fn the_layer_writes_events_as_records() {
        let dir = tempfile::tempdir().unwrap();
        let writer =
            Arc::new(LogWriter::open(&dir.path().join(STDIO_LOG_FILE_NAME), "stdio:").unwrap());
        let subscriber = tracing_subscriber::registry().with(FileLayer::new(writer));
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: "kanban.http", "request {} failed", 7);
            tracing::warn!(user = 3, name = "bo", "careful");
            tracing::trace!("deep");
        });
        let out = all(dir.path(), "DEBUG");
        assert_eq!(out.len(), 3, "{out:?}");
        assert!(out[0].contains(" ERROR stdio:kanban.http request 7 failed\n"));
        assert!(
            out[1].contains(" WARNING stdio:kb_log::app_logging::tests careful user=3 name=bo\n")
        );
        assert!(out[2].contains(" DEBUG ") && out[2].ends_with(" deep\n"));
        assert!(!dir.path().join(LOG_FILE_NAME).exists());
    }
}
