//! The `tracing` side of the log: a `Layer` that writes every event as a log line (the equivalent of the root
//! logger's handler in Python).

use std::fmt::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, FixedOffset, Local};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

use crate::app_logging::{BACKUP_COUNT, Level, MAX_BYTES, RotatingFile, format_record};

/// The open log file plus the logger-name prefix of its process (`stdio:` for the stdio MCP process).
pub struct LogWriter {
    file: Mutex<RotatingFile>,
    prefix: &'static str,
}

impl LogWriter {
    /// Open `path` (rotating at 5 MiB, 5 backups) for a process whose logger names get `prefix`.
    pub fn open(path: &Path, prefix: &'static str) -> std::io::Result<Self> {
        Self::with_rotation(path, prefix, MAX_BYTES, BACKUP_COUNT)
    }

    /// Like [`LogWriter::open`] with explicit rotation limits (tests use small ones).
    pub fn with_rotation(
        path: &Path,
        prefix: &'static str,
        max_bytes: u64,
        backup_count: u32,
    ) -> std::io::Result<Self> {
        Ok(Self { file: Mutex::new(RotatingFile::open(path, max_bytes, backup_count)?), prefix })
    }

    /// Write one record stamped with the current local time.
    pub fn log(&self, level: Level, target: &str, message: &str) {
        self.log_at(Local::now().fixed_offset(), level, target, message);
    }

    /// Write one record with an explicit time.
    pub fn log_at(&self, time: DateTime<FixedOffset>, level: Level, target: &str, message: &str) {
        let line = format_record(time, level, &format!("{}{target}", self.prefix), message);
        let mut file = self.file.lock().unwrap_or_else(|e| e.into_inner());
        file.emit(&line);
    }
}

/// A `tracing_subscriber::Layer` that writes each event to a [`LogWriter`]. It does not filter: put a level filter
/// on it (the root level is INFO).
pub struct FileLayer {
    writer: Arc<LogWriter>,
}

impl FileLayer {
    /// Wrap a writer.
    pub fn new(writer: Arc<LogWriter>) -> Self {
        Self { writer }
    }
}

/// Collects the `message` field and the other fields as ` key=value`.
#[derive(Default)]
struct Visitor {
    message: String,
    fields: String,
}

impl Visit for Visitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            let _ = write!(self.fields, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.fields, " {}={value}", field.name());
        }
    }
}

impl<S: Subscriber> Layer<S> for FileLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut visitor = Visitor::default();
        event.record(&mut visitor);
        let message = if visitor.message.is_empty() {
            visitor.fields.trim_start().to_string()
        } else {
            visitor.message + &visitor.fields
        };
        self.writer.log(Level::from_tracing(meta.level()), meta.target(), &message);
    }
}
