//! Persistent application log (port of `server/app_logging.py`): a size-rotating file written from `tracing`
//! events, and export of the records in a time range.

pub mod app_logging;
mod layer;

pub use app_logging::*;
pub use layer::{FileLayer, LogWriter};
